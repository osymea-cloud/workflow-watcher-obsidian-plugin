/**
 * `views/plotWidget.ts` 单测（Phase 19 M3）：空目录 / 列表与选中 / 新建表单 /
 * 增删点 / 导出与导入 CSV / 两段式删除 / 坏文件容错 / SVG 折线。
 *
 * 纯 Node：DOM 用 `views/testDomStub.ts` 桩，vault 用内存假件（`create / modify / delete`
 * 都落到一张 Map 上），引擎用真实实现 —— 因此这里断言的是「视图把引擎算好的东西摆对了 +
 * 写盘内容正确」，坐标系 / CSV 口径本身在 `src/engine/plot.test.ts`。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { App } from "obsidian";

import { formatLocalDate, setLang, toCsv, validatePlot, type PlotDocument } from "../src/engine/index.ts";
import {
  exportCsv,
  importCsvText,
  mergeCsv,
  plotLabel,
  plotMeta,
  renderPlot,
  withPoint,
  withoutPoint,
  type PlotHost,
} from "./plotWidget.ts";
import { asHtmlElement, installDomStub, StubElement, type StubMouseEvent } from "./testDomStub.ts";

const body = installDomStub();
setLang("zh");

/** 桩鼠标事件（视图只用 preventDefault / stopPropagation / clientX / clientY） */
function clickEvent(): StubMouseEvent {
  return { preventDefault: () => undefined, stopPropagation: () => undefined, clientX: 0, clientY: 0 };
}

interface FakeFile {
  path: string;
  text: string;
}

interface Recorder {
  host: PlotHost;
  notices: string[];
  /** 盘上的文件（`path → 文本`） */
  files: Map<string, FakeFile>;
  /** 建过的目录 */
  folders: Set<string>;
}

/** 内存 vault：`getFiles()` 只返回文件，`getAbstractFileByPath()` 文件 / 目录都能查到 */
function makeHost(initial: Record<string, string> = {}): Recorder {
  const files = new Map<string, FakeFile>();
  for (const [path, text] of Object.entries(initial)) files.set(path, { path, text });
  const folders = new Set<string>();
  const notices: string[] = [];

  const vault = {
    getAbstractFileByPath: (path: string): unknown => files.get(path) ?? (folders.has(path) ? { path } : null),
    getFiles: (): FakeFile[] => [...files.values()],
    read: async (file: FakeFile): Promise<string> => file.text,
    create: async (path: string, text: string): Promise<void> => {
      files.set(path, { path, text });
    },
    modify: async (file: FakeFile, text: string): Promise<void> => {
      files.set(file.path, { path: file.path, text });
    },
    delete: async (file: FakeFile): Promise<void> => {
      files.delete(file.path);
    },
    createFolder: async (path: string): Promise<void> => {
      folders.add(path);
    },
  };

  const host: PlotHost = {
    app: { vault, workspace: {} } as unknown as App,
    plotFolder: () => "plots",
    notify: (message) => notices.push(message),
  };
  return { host, notices, files, folders };
}

/** 一个存好的 plot（写进假 vault 的 JSON 文本） */
function plotJson(overrides: Partial<PlotDocument> = {}): string {
  const plot: PlotDocument = {
    id: "plot-00000000-0000-4000-8000-000000000001",
    name: "体重变化",
    kind: "date",
    unit: "kg",
    points: [
      { x: "2026-01-03", y: 70 },
      { x: "2026-01-01", y: 70.5 },
    ],
    ...overrides,
  };
  return JSON.stringify(plot);
}

const PLOT_ID = "plot-00000000-0000-4000-8000-000000000001";
const PLOT_PATH = `plots/${PLOT_ID}.json`;

/** 等几轮宏任务（`load()` 里并行读盘 + 后续 `paint()` 落地） */
async function settle(): Promise<void> {
  for (let index = 0; index < 4; index += 1) {
    await new Promise<void>((resolve) => window.setTimeout(resolve, 0));
  }
}

/** 渲染一次（每次清空 body，与 `wfView` 的 `body.empty()` 同语义） */
function render(recorder: Recorder): StubElement {
  body.empty();
  const root = body.createDiv();
  renderPlot(asHtmlElement(root), recorder.host, () => undefined);
  return root;
}

/** 按文字找按钮 */
function button(root: StubElement, label: string): StubElement {
  const found = root.query(".wf-plot-btn").find((item) => item.text === label);
  assert.ok(found, `应有按钮「${label}」`);
  return found;
}

/** 写进盘上的 plot（读出来校验，确保断言的是规范化后的数据） */
function readPlotFromDisk(recorder: Recorder, path = PLOT_PATH): PlotDocument {
  const text = recorder.files.get(path)?.text;
  assert.ok(text !== undefined, `盘上应有 ${path}`);
  const result = validatePlot(JSON.parse(text) as unknown);
  assert.ok(result.plot, `${path} 应是合法 plot`);
  return result.plot;
}

describe("plotWidget · 空目录 / 列表与选中", () => {
  test("空目录：列表给「还没有 plot」，右侧给「从左侧选一个」，只有「新建」可点", async () => {
    const recorder = makeHost();
    const root = render(recorder);
    await settle();

    assert.equal(root.query(".wf-plot").length, 1);
    const empty = root.query(".wf-plot-empty");
    assert.equal(empty.length, 1);
    assert.equal(empty[0].text, "还没有 plot，点「新建」开始");
    assert.equal(root.query(".wf-plot-placeholder")[0].text, "从左侧选一个 plot");

    assert.equal(button(root, "新建").disabled, false);
    assert.equal(button(root, "导入 CSV").disabled, true, "没选中 plot 时不能导入");
    assert.equal(button(root, "导出 CSV").disabled, true);
    assert.equal(button(root, "删除").disabled, true);
  });

  test("有 plot：打开即选中第一张（补充契约⑥a），列表 + 折线 + 三栏点表一起出来", async () => {
    const recorder = makeHost({ [PLOT_PATH]: plotJson() });
    const root = render(recorder);
    await settle();

    const item = root.query(".wf-plot-item")[0];
    assert.ok(item, "应有一行 plot");
    assert.equal(item.query(".wf-plot-item-name")[0].text, "体重变化");
    assert.equal(item.query(".wf-plot-item-meta")[0].text, "日期 · kg · 2 个点");
    assert.ok(item.classList.contains("wf-plot-item--active"), "首帧就选中第一张");
    assert.equal(root.query(".wf-plot-placeholder").length, 0, "不再显示「从左侧选一个 plot」");
    assert.equal(root.query(".wf-plot-title")[0].text, "体重变化");
    assert.equal(root.query(".wf-plot-meta")[0].text, "日期 · kg · 2 个点");

    // 三栏（补充契约⑥b）：`.wf-plot` 的直接子元素顺序 = sidebar | main | points
    const columnOf = (child: StubElement): string => {
      for (const name of ["wf-plot-sidebar", "wf-plot-main", "wf-plot-points"]) {
        if (child.classList.contains(name)) return name.replace("wf-plot-", "");
      }
      return "?";
    };
    assert.deepEqual(root.query(".wf-plot")[0].children.map(columnOf), ["sidebar", "main", "points"]);
    const mainColumn = root.query(".wf-plot-main")[0];
    const pointsColumn = root.query(".wf-plot-points")[0];
    assert.equal(
      mainColumn.children.some((child) => child.classList.contains("wf-plot-points")),
      false,
      "点表不再挂在中间栏里",
    );
    assert.equal(
      pointsColumn.children.some((child) => child.classList.contains("wf-plot-search")),
      true,
      "搜索框在第三栏顶部",
    );
    assert.equal(
      pointsColumn.children.some((child) => child.classList.contains("wf-plot-add")),
      true,
      "添加行也在第三栏",
    );

    // 再点同一行不会取消选中（选中态保持）
    root.query(".wf-plot-item")[0].onclick?.(clickEvent());
    assert.ok(root.query(".wf-plot-item")[0].classList.contains("wf-plot-item--active"));
    assert.equal(root.query(".wf-plot-title")[0].text, "体重变化");
    assert.equal(root.query(".wf-plot-meta")[0].text, "日期 · kg · 2 个点");

    // SVG：两条刻度线 + 两个轴 + 一条折线 + 两个圆点
    assert.equal(root.query(".wf-plot-svg").length, 1);
    assert.equal(root.query(".wf-plot-line").length, 1);
    assert.equal(root.query(".wf-plot-dot").length, 2);
    assert.equal(root.query(".wf-plot-grid").length, 3, "y 轴三档刻度");

    // 点表按 x 正序（文件里是 01-03 在前）
    assert.deepEqual(
      root.query(".wf-plot-point").map((row) => row.query(".wf-plot-point-x")[0].text),
      ["2026-01-01", "2026-01-03"],
    );
    assert.deepEqual(
      root.query(".wf-plot-point").map((row) => row.query(".wf-plot-point-y")[0].text),
      ["70.5 kg", "70 kg"],
      "有单位就带上",
    );
  });

  test("没填 name 的 plot 用「（未命名）」；重画（清空后重新 render）仍自动选中第一张", async () => {
    const recorder = makeHost({ [PLOT_PATH]: plotJson({ name: "" }) });
    const first = render(recorder);
    await settle();
    assert.equal(first.query(".wf-plot-item-name")[0].text, "（未命名）");
    assert.equal(first.query(".wf-plot-dot").length, 2, "打开就有图（不再等用户点一下）");

    const second = render(recorder);
    await settle();
    assert.equal(second.query(".wf-plot-item--active").length, 1, "重画后仍选中第一张");
    assert.equal(second.query(".wf-plot-placeholder").length, 0);
    assert.equal(second.query(".wf-plot-title")[0].text, "（未命名）");
  });

  test("坏文件只提示、不影响其它 plot", async () => {
    const recorder = makeHost({
      [PLOT_PATH]: plotJson(),
      "plots/plot-broken.json": "{ 这不是 JSON",
      "plots/plot-wrong-kind.json": JSON.stringify({ id: "plot-wrong-kind", kind: "week", points: [] }),
      "plots/notes.json": "{}",
    });
    const root = render(recorder);
    await settle();

    assert.deepEqual(
      root.query(".wf-plot-item-name").map((item) => item.text),
      ["体重变化"],
      "只有合法的那个进列表（notes.json 不是 plot 文件，直接不扫）",
    );
    assert.deepEqual(recorder.notices, [
      "读取失败：plots/plot-broken.json",
      "读取失败：plots/plot-wrong-kind.json",
    ]);
  });
});

describe("plotWidget · 新建 plot", () => {
  test("新建表单：名称 / 类型（日期 ↔ 序号）/ 单位 → 保存后落盘并选中它", async () => {
    const recorder = makeHost();
    const root = render(recorder);
    await settle();

    button(root, "新建").onclick?.(clickEvent());
    assert.equal(root.query(".wf-plot-form").length, 1);
    assert.equal(root.query(".wf-plot-form-hint")[0].text, "日期，如 2026-01-01");
    assert.equal(root.query(".wf-plot-placeholder").length, 0, "表单顶掉了空提示");

    const sequence = root.query(".wf-plot-kind").find((item) => item.text === "序号");
    assert.ok(sequence, "应有「序号」选项");
    sequence.onclick?.(clickEvent());
    assert.ok(root.query(".wf-plot-kind")[1].classList.contains("wf-plot-kind--active"), "切换后高亮跟着走");
    assert.equal(root.query(".wf-plot-form-hint")[0].text, "序号，如 1、2、3");

    const inputs = root.query(".wf-plot-input");
    assert.equal(inputs.length, 2, "名称 + 单位");
    (inputs[0] as unknown as HTMLInputElement).value = "  第几杯水  ";
    (inputs[1] as unknown as HTMLInputElement).value = " ml ";
    button(root, "保存").onclick?.(clickEvent());
    await settle();

    const paths = [...recorder.files.keys()].filter((path) => path.startsWith("plots/plot-"));
    assert.equal(paths.length, 1, "只写一个 plot 文件");
    assert.match(paths[0], /^plots\/plot-[0-9a-z-]+\.json$/);
    const saved = readPlotFromDisk(recorder, paths[0]);
    assert.equal(saved.name, "第几杯水", "名称去首尾空白");
    assert.equal(saved.kind, "sequence");
    assert.equal(saved.unit, "ml");
    assert.deepEqual(saved.points, [], "新 plot 从空点集开始");
    assert.equal(saved.id, paths[0].replace(/^plots\//, "").replace(/\.json$/, ""), "文件名 = id");

    assert.deepEqual(recorder.notices, ["已新建：第几杯水"]);
    assert.equal(root.query(".wf-plot-item--active").length, 1, "新建后自动选中");
    assert.equal(root.query(".wf-plot-title")[0].text, "第几杯水");
    assert.equal(root.query(".wf-plot-empty")[0].text, "还没有数据点");
    assert.ok(recorder.folders.has("plots"), "第一次写入时才建目录");
  });

  test("取消：表单关掉、盘上什么都没有", async () => {
    const recorder = makeHost();
    const root = render(recorder);
    await settle();

    button(root, "新建").onclick?.(clickEvent());
    button(root, "取消").onclick?.(clickEvent());
    assert.equal(root.query(".wf-plot-form").length, 0);
    assert.equal(root.query(".wf-plot-placeholder").length, 1, "回到未选中");
    assert.equal(recorder.files.size, 0);
  });
});


describe("plotWidget · 增删点", () => {
  /** 选中唯一那个 plot，返回根节点 */
  async function renderSelected(recorder: Recorder): Promise<StubElement> {
    const root = render(recorder);
    await settle();
    root.query(".wf-plot-item")[0].onclick?.(clickEvent());
    return root;
  }

  /** 填 x / y 后点「添加点」（每次都重新查句柄：点一下会重画） */
  async function addPoint(root: StubElement, x: string, y: string): Promise<void> {
    (root.query(".wf-plot-input--x")[0] as unknown as HTMLInputElement).value = x;
    (root.query(".wf-plot-input--y")[0] as unknown as HTMLInputElement).value = y;
    button(root, "添加点").onclick?.(clickEvent());
    await settle();
  }

  test("添加点：按 x 正序写回，点表 / 折线圆点跟着变", async () => {
    const recorder = makeHost({ [PLOT_PATH]: plotJson() });
    const root = await renderSelected(recorder);
    assert.equal(root.query(".wf-plot-dot").length, 2);

    await addPoint(root, "2026-01-02", "70.2");

    assert.deepEqual(recorder.notices, []);
    assert.deepEqual(
      readPlotFromDisk(recorder).points.map((point) => `${point.x}:${point.y}`),
      ["2026-01-01:70.5", "2026-01-02:70.2", "2026-01-03:70"],
      "落盘顺序 = x 正序",
    );
    assert.equal(root.query(".wf-plot-dot").length, 3);
    assert.deepEqual(
      root.query(".wf-plot-point-x").map((item) => item.text),
      ["2026-01-01", "2026-01-02", "2026-01-03"],
    );
    assert.equal(root.query(".wf-plot-points-title")[0].text, "数据点（3）");
  });

  test("同一 x 再添一次 = 覆盖（提示 + 只留一个点）", async () => {
    const recorder = makeHost({ [PLOT_PATH]: plotJson() });
    const root = await renderSelected(recorder);

    await addPoint(root, "2026-01-01", "71");

    assert.deepEqual(recorder.notices, ["该 x 已有点，已覆盖原值"]);
    const points = readPlotFromDisk(recorder).points;
    assert.equal(points.filter((point) => point.x === "2026-01-01").length, 1);
    assert.equal(points.find((point) => point.x === "2026-01-01")?.y, 71);
    assert.equal(points.length, 2);
  });

  test("x / y 不合法：只提示、不落盘", async () => {
    const recorder = makeHost({ [PLOT_PATH]: plotJson() });
    const root = await renderSelected(recorder);
    const before = recorder.files.get(PLOT_PATH)?.text;

    await addPoint(root, "2026-02-30", "70");
    assert.deepEqual(recorder.notices, ["x 不合法：日期，如 2026-01-01"]);
    assert.equal(recorder.files.get(PLOT_PATH)?.text, before, "坏 x 不写盘");

    await addPoint(root, "2026-01-05", "abc");
    assert.deepEqual(recorder.notices, ["x 不合法：日期，如 2026-01-01", "y 必须是数字"]);
    assert.equal(recorder.files.get(PLOT_PATH)?.text, before, "坏 y 不写盘");
  });

  test("删除点：点「×」后落盘少一个（按 x + y 精确匹配）", async () => {
    const recorder = makeHost({ [PLOT_PATH]: plotJson() });
    const root = await renderSelected(recorder);

    // 点表第 1 行是 2026-01-01 / 70.5
    root.query(".wf-plot-point-remove")[0].onclick?.(clickEvent());
    await settle();

    assert.deepEqual(
      readPlotFromDisk(recorder).points.map((point) => `${point.x}:${point.y}`),
      ["2026-01-03:70"],
    );
    assert.equal(root.query(".wf-plot-point").length, 1);
    assert.equal(root.query(".wf-plot-dot").length, 1);
  });
});


describe("plotWidget · CSV 导入 / 导出 / 删除 plot", () => {
  test("导出：写到 `<plotFolder>/plot-<id>.csv`（内容 = 引擎 toCsv，按 x 正序）并给提示", async () => {
    const recorder = makeHost({ [PLOT_PATH]: plotJson() });
    const root = render(recorder);
    await settle();
    root.query(".wf-plot-item")[0].onclick?.(clickEvent());

    button(root, "导出 CSV").onclick?.(clickEvent());
    await settle();

    const csvPath = `plots/${PLOT_ID}.csv`;
    assert.equal(recorder.files.get(csvPath)?.text, "x,y\n2026-01-01,70.5\n2026-01-03,70\n");
    assert.deepEqual(recorder.notices, [`已导出：${csvPath}`]);
    assert.equal(
      recorder.files.get(csvPath)?.text,
      toCsv("date", readPlotFromDisk(recorder).points),
      "导出内容与引擎 toCsv 完全一致",
    );
  });

  test("导出是幂等的：再点一次覆盖同一个文件（不产生新文件）", async () => {
    const recorder = makeHost({ [PLOT_PATH]: plotJson() });
    const root = render(recorder);
    await settle();
    root.query(".wf-plot-item")[0].onclick?.(clickEvent());

    button(root, "导出 CSV").onclick?.(clickEvent());
    await settle();
    button(root, "导出 CSV").onclick?.(clickEvent());
    await settle();

    const csvFiles = [...recorder.files.keys()].filter((path) => path.endsWith(".csv"));
    assert.equal(csvFiles.length, 1);
    assert.equal(recorder.notices.length, 2);
  });

  test("导入：mergeCsv 以 CSV 为准覆盖同 x 的点，坏行只提示行号", async () => {
    const recorder = makeHost({ [PLOT_PATH]: plotJson() });
    const plot = readPlotFromDisk(recorder);

    const merged = await importCsvText(
      recorder.host,
      plot,
      "x,y\n2026-01-02,70.2\n2026-01-01,71\nbad,1\n2026-01-04,abc\n",
    );
    assert.ok(merged, "至少有一个点读进来");
    assert.deepEqual(recorder.notices, ["已导入 2 个点 · 有 2 行没读进来（第 4, 5 行）"]);
    assert.deepEqual(
      readPlotFromDisk(recorder).points.map((point) => `${point.x}:${point.y}`),
      ["2026-01-01:71", "2026-01-02:70.2", "2026-01-03:70"],
      "01-01 被 CSV 的 71 覆盖，01-02 新增",
    );
  });

  test("导入：一个点都没有时只提示、不写盘", async () => {
    const recorder = makeHost({ [PLOT_PATH]: plotJson() });
    const before = recorder.files.get(PLOT_PATH)?.text;

    const merged = await importCsvText(recorder.host, readPlotFromDisk(recorder), "not-a-plot\n");
    assert.equal(merged, undefined);
    assert.deepEqual(recorder.notices, ["CSV 里没有可用的点"]);
    assert.equal(recorder.files.get(PLOT_PATH)?.text, before);
  });

  test("mergeCsv 是纯函数：不改入参，覆盖数单独给出", () => {
    const plot = {
      id: PLOT_ID,
      name: "体重变化",
      kind: "sequence" as const,
      unit: "",
      points: [
        { x: 1, y: 10 },
        { x: 2, y: 20 },
      ],
    };
    const merged = mergeCsv(plot, "1,11\n3,30\n");
    assert.equal(merged.imported, 2);
    assert.equal(merged.replaced, 1);
    assert.deepEqual(merged.plot.points, [
      { x: 1, y: 11 },
      { x: 2, y: 20 },
      { x: 3, y: 30 },
    ]);
    assert.deepEqual(plot.points, [
      { x: 1, y: 10 },
      { x: 2, y: 20 },
    ], "入参不被改写");
  });

  test("删除 plot：第一下只是「确认删除」，第二下才删文件并回到空列表", async () => {
    const recorder = makeHost({ [PLOT_PATH]: plotJson() });
    const root = render(recorder);
    await settle();
    root.query(".wf-plot-item")[0].onclick?.(clickEvent());

    button(root, "删除").onclick?.(clickEvent());
    assert.equal(root.query(".wf-plot-btn--armed").length, 1, "按钮进入确认态");
    assert.ok(recorder.files.has(PLOT_PATH), "第一下不删文件");

    button(root, "确认删除").onclick?.(clickEvent());
    await settle();

    assert.equal(recorder.files.has(PLOT_PATH), false);
    assert.deepEqual(recorder.notices, ["已删除：体重变化"]);
    assert.equal(root.query(".wf-plot-item").length, 0);
    assert.equal(root.query(".wf-plot-empty")[0].text, "还没有 plot，点「新建」开始");
    assert.equal(root.query(".wf-plot-placeholder")[0].text, "从左侧选一个 plot");
  });

  test("点另一个 plot 会取消「确认删除」态（不会误删）", async () => {
    const otherId = "plot-00000000-0000-4000-8000-000000000002";
    const recorder = makeHost({ [PLOT_PATH]: plotJson(), [`plots/${otherId}.json`]: plotJson({ id: otherId, name: "喝水" }) });
    const root = render(recorder);
    await settle();

    const rows = root.query(".wf-plot-item");
    assert.equal(rows.length, 2);
    const nameOf = (row: StubElement): string => row.query(".wf-plot-item-name")[0].text;
    rows[0].onclick?.(clickEvent());
    button(root, "删除").onclick?.(clickEvent());
    assert.equal(root.query(".wf-plot-btn--armed").length, 1);

    // 换选另一行 → 确认态取消、盘上两个 plot 都还在
    const otherName = nameOf(rows[0]) === "喝水" ? "体重变化" : "喝水";
    const other = root.query(".wf-plot-item").find((row) => nameOf(row) === otherName);
    assert.ok(other, `应有「${otherName}」这一行`);
    other.onclick?.(clickEvent());

    assert.equal(root.query(".wf-plot-btn--armed").length, 0);
    assert.equal(root.query(".wf-plot-title")[0].text, otherName);
    assert.equal(recorder.files.size, 2, "两个 plot 都还在");
  });

  test("plotLabel / plotMeta：没名字回落「（未命名）」，没单位就不显示单位段", () => {
    const plot = { id: PLOT_ID, name: "", kind: "sequence" as const, unit: "", points: [] };
    assert.equal(plotLabel(plot), "（未命名）");
    assert.equal(plotMeta(plot), "序号 · 0 个点");
    assert.equal(plotMeta({ ...plot, unit: "ml" }), "序号 · ml · 0 个点");
    assert.equal(withPoint(plot, { x: 1, y: 1 }).plot.points.length, 1);
    assert.equal(withoutPoint(plot, { x: 1, y: 1 }).points.length, 0, "没有这个点就原样返回");
  });
});



describe("plotWidget · 点搜索 / date 预填（补充契约⑥c ⑥d）", () => {
  /** 三点数据集（01-01 / 01-02 / 01-03），专门用来验区间过滤 */
  const THREE: PlotDocument = {
    id: PLOT_ID,
    name: "体重变化",
    kind: "date",
    unit: "kg",
    points: [
      { x: "2026-01-01", y: 70 },
      { x: "2026-01-02", y: 70.2 },
      { x: "2026-01-03", y: 70 },
    ],
  };

  /** 渲染 + 等读盘（默认已选中第一张） */
  async function renderThree(json: string = JSON.stringify(THREE)): Promise<{ recorder: Recorder; root: StubElement }> {
    const recorder = makeHost({ [PLOT_PATH]: json });
    const root = render(recorder);
    await settle();
    return { recorder, root };
  }

  /** 往搜索框写文本并点「搜索」（每次重新查句柄：重画后旧句柄作废） */
  function searchFor(root: StubElement, text: string): void {
    (root.query(".wf-plot-search-input")[0] as unknown as HTMLInputElement).value = text;
    button(root, "搜索").onclick?.(clickEvent());
  }

  const xs = (root: StubElement): string[] => root.query(".wf-plot-point-x").map((item) => item.text);

  test("闭区间：`A~B` 只筛点表（SVG 仍画全部点），并给出命中数", async () => {
    const { root } = await renderThree();
    assert.deepEqual(xs(root), ["2026-01-01", "2026-01-02", "2026-01-03"], "一开始全量");
    assert.equal(root.query(".wf-plot-search-info")[0].text, "", "没搜索时不显示命中数");

    searchFor(root, "2026-01-01~2026-01-02");

    assert.deepEqual(xs(root), ["2026-01-01", "2026-01-02"], "区间两端都算命中");
    assert.equal(root.query(".wf-plot-search-info")[0].text, "匹配 2 / 共 3 条");
    assert.equal(root.query(".wf-plot-points-title")[0].text, "数据点（3）", "标题仍是总数");
    assert.equal(root.query(".wf-plot-dot").length, 3, "SVG 不跟着过滤");
  });

  test("精确匹配：只写一个 x 就是「那一天」", async () => {
    const { root } = await renderThree();
    searchFor(root, " 2026-01-02 ");
    assert.deepEqual(xs(root), ["2026-01-02"]);
    assert.equal(root.query(".wf-plot-search-info")[0].text, "匹配 1 / 共 3 条");
  });

  test("写反区间自动交换（`2026-01-03~2026-01-02` 也能筛出两天）", async () => {
    const { root } = await renderThree();
    searchFor(root, "2026-01-03~2026-01-02");
    assert.deepEqual(xs(root), ["2026-01-02", "2026-01-03"]);
  });

  test("非法输入：提示 + 保持上一次的过滤结果", async () => {
    const { recorder, root } = await renderThree();
    searchFor(root, "2026-01-01~2026-01-02");
    assert.deepEqual(xs(root), ["2026-01-01", "2026-01-02"]);

    searchFor(root, "2026-02-30");
    assert.deepEqual(recorder.notices, ["搜索格式不对：日期，如 2026-01-01"]);
    assert.deepEqual(xs(root), ["2026-01-01", "2026-01-02"], "结果不变");
    assert.equal(root.query(".wf-plot-search-info")[0].text, "匹配 2 / 共 3 条");
  });

  test("清空：点「清空」回到全部点，命中数消失", async () => {
    const { root } = await renderThree();
    searchFor(root, "2026-01-02");
    assert.deepEqual(xs(root), ["2026-01-02"]);

    button(root, "清空").onclick?.(clickEvent());
    assert.deepEqual(xs(root), ["2026-01-01", "2026-01-02", "2026-01-03"]);
    assert.equal(root.query(".wf-plot-search-info")[0].text, "");
    assert.equal((root.query(".wf-plot-search-input")[0] as unknown as HTMLInputElement).value, "");
  });

  test("回车 = 点「搜索」（输入法组字期间的回车不算）", async () => {
    const { root } = await renderThree();
    const inputEl = root.query(".wf-plot-search-input")[0];
    (inputEl as unknown as HTMLInputElement).value = "2026-01-03";

    inputEl.dispatch("keydown", { key: "Enter", isComposing: true, preventDefault: () => undefined });
    assert.deepEqual(xs(root), ["2026-01-01", "2026-01-02", "2026-01-03"], "组字中不触发");

    inputEl.dispatch("keydown", { key: "Enter", preventDefault: () => undefined });
    assert.deepEqual(xs(root), ["2026-01-03"]);
  });

  test("date 类预填今天（sequence 留空）", async () => {
    const { root } = await renderThree();
    assert.equal((root.query(".wf-plot-input--x")[0] as unknown as HTMLInputElement).value, formatLocalDate());

    const sequence = JSON.stringify({ ...THREE, kind: "sequence", points: [{ x: 1, y: 10 }] });
    const second = await renderThree(sequence);
    assert.equal(
      (second.root.query(".wf-plot-input--x")[0] as unknown as HTMLInputElement).value,
      "",
      "序号类没有「今天」的概念",
    );
    assert.equal(
      second.root.query(".wf-plot-input--x")[0].getAttribute("placeholder"),
      "序号，如 1、2、3",
      "占位符仍是格式提示",
    );
  });

  test("搜索文本跨重画保留（加一个点后过滤还在）", async () => {
    const { root } = await renderThree();
    searchFor(root, "2026-01-01~2026-01-02");

    const xInput = root.query(".wf-plot-input--x")[0] as unknown as HTMLInputElement;
    const yInput = root.query(".wf-plot-input--y")[0] as unknown as HTMLInputElement;
    xInput.value = "2026-01-04";
    yInput.value = "69.8";
    button(root, "添加点").onclick?.(clickEvent());
    await settle();

    assert.deepEqual(xs(root), ["2026-01-01", "2026-01-02"], "新点不在区间里，点表不变");
    assert.equal(root.query(".wf-plot-search-info")[0].text, "匹配 2 / 共 4 条", "总数变成 4");
    assert.equal((root.query(".wf-plot-search-input")[0] as unknown as HTMLInputElement).value, "2026-01-01~2026-01-02");
    assert.equal(root.query(".wf-plot-dot").length, 4, "SVG 仍然画 4 个点");
  });
});

