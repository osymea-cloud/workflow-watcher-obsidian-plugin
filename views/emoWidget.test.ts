/**
 * `views/emoWidget.ts` 单测（Phase 18 ④）：画布结构、格子着色、缩放、保存链路。
 *
 * 纯 Node：DOM 用 `views/testDomStub.ts` 桩，vault 用一个「记下每次调用」的假实现
 * （保存顺序是契约 §E 的硬要求 —— 建目录 → 写图 → 写 md，任一步失败都不半途落盘）。
 */

import assert from "node:assert/strict";
import { afterEach, describe, test } from "node:test";

import type { App } from "obsidian";

import { SPIRAL_TOTAL, emoColorIndex, formatLocalDate, spiralDates, t } from "../src/engine/index.ts";
import { asHtmlElement, installDomStub, StubElement } from "./testDomStub.ts";
import {
  EMO_CELL_PX,
  EMO_GRID,
  EMO_ZOOM_MAX,
  EMO_ZOOM_MIN,
  EMO_ZOOM_START,
  buildDailyBody,
  clampPan,
  closeEmoFloats,
  dailyNotePath,
  mergeDailyBody,
  normalizeFolder,
  openPolaroid,
  parseDailyNote,
  readDailyRecord,
  recordedDates,
  renderEmo365,
  saveDailyRecord,
  zoomLabel,
  zoomStep,
  type EmoHost,
} from "./emoWidget.ts";

const body = installDomStub();

/** 假 vault：文件内容 + 目录都放内存里，每次调用按顺序记进 `calls` */
interface FakeVault {
  calls: string[];
  files: Map<string, { path: string; extension: string }>;
  content: Map<string, string>;
  folders: Set<string>;
  app: App;
}

function makeVault(initialFiles: readonly string[] = [], initialContent: Record<string, string> = {}): FakeVault {
  const calls: string[] = [];
  const files = new Map<string, { path: string; extension: string }>();
  const content = new Map<string, string>();
  const folders = new Set<string>();
  for (const path of initialFiles) {
    const extension = path.slice(path.lastIndexOf(".") + 1);
    files.set(path, { path, extension });
  }
  for (const [path, text] of Object.entries(initialContent)) content.set(path, text);

  const vault = {
    adapter: {
      exists: async (path: string): Promise<boolean> => {
        calls.push(`exists:${path}`);
        return folders.has(path);
      },
    },
    getFiles: () => [...files.values()],
    getAbstractFileByPath: (path: string): unknown => (folders.has(path) ? { path } : files.get(path) ?? null),
    createFolder: async (path: string): Promise<unknown> => {
      calls.push(`createFolder:${path}`);
      folders.add(path);
      return { path };
    },
    read: async (file: { path: string }): Promise<string> => content.get(file.path) ?? "",
    create: async (path: string, data: string): Promise<unknown> => {
      calls.push(`create:${path}`);
      files.set(path, { path, extension: "md" });
      content.set(path, data);
      return files.get(path);
    },
    modify: async (file: { path: string }, data: string): Promise<void> => {
      calls.push(`modify:${file.path}`);
      content.set(file.path, data);
    },
    createBinary: async (path: string): Promise<unknown> => {
      calls.push(`createBinary:${path}`);
      files.set(path, { path, extension: path.slice(path.lastIndexOf(".") + 1) });
      return files.get(path);
    },
    modifyBinary: async (file: { path: string }): Promise<void> => {
      calls.push(`modifyBinary:${file.path}`);
    },
    delete: async (file: { path: string }): Promise<void> => {
      calls.push(`delete:${file.path}`);
      files.delete(file.path);
    },
  };

  return { calls, files, content, folders, app: { vault } as unknown as App };
}

interface Recorder {
  host: EmoHost;
  calls: string[];
  notices: string[];
  vault: FakeVault;
  /** Phase 19 M1：灵动岛切换主题的落盘记录 */
  themeCalls: string[];
}

function makeHost(
  initialFiles: readonly string[] = [],
  initialContent: Record<string, string> = {},
  folder = "daily",
  emoTheme = "default",
): Recorder {
  const vault = makeVault(initialFiles, initialContent);
  const notices: string[] = [];
  const themeCalls: string[] = [];
  const host: EmoHost = {
    app: vault.app,
    dailyFolder: () => folder,
    notify: (message) => {
      notices.push(message);
    },
    // Phase 19 M1 ①：emo 独立主题（默认 default；测试里可传别的 key / 非法值）
    emoTheme: () => emoTheme,
    setEmoTheme: async (theme) => {
      themeCalls.push(theme);
    },
  };
  return { host, calls: vault.calls, notices, vault, themeCalls };
}

/** 渲染一次画布，返回容器 */
function renderWidget(host: EmoHost): StubElement {
  const container = new StubElement("div");
  renderEmo365(asHtmlElement(container), host, () => undefined);
  return container;
}

afterEach(() => {
  closeEmoFloats();
});

describe("emoWidget · 画布结构", () => {
  test("364 个日期格 + 1 个今日见闻；每个格子带 data-date 与网格位置", () => {
    const widget = renderWidget(makeHost().host);

    assert.equal(widget.query(".wf-emo-cell").length, SPIRAL_TOTAL, "364 格");
    assert.equal(widget.query(".wf-emo-today").length, 1, "中心一块「今日见闻」");
    assert.equal(widget.query(".wf-emo-zoom").length, 1, "右下角百分比");

    const dates = new Set(widget.query(".wf-emo-cell").map((cell) => cell.getAttribute("data-date")));
    assert.equal(dates.size, SPIRAL_TOTAL, "每格一天，不重不漏");
    assert.equal(dates.has(formatLocalDate()), false, "今天不占格（今天是中心块）");

    const first = widget.query(".wf-emo-cell")[0];
    assert.equal(first.style.gridRow, "8 / 9", "1 起算坐标 → 网格线 x ~ x+1");
    assert.equal(first.style.gridColumn, "14 / 15");
    assert.equal(widget.query(".wf-emo-today")[0].getAttribute("data-date"), formatLocalDate());
  });

  test("有记录的日期着色 + 「有记录」tooltip；没记录的是虚线灰格", () => {
    const yesterday = spiralDates()[0].date;
    const widget = renderWidget(makeHost([`daily/${yesterday}.md`]).host);

    const cells = widget.query(".wf-emo-cell");
    const recorded = cells.filter((cell) => cell.classList.contains("wf-emo-cell--recorded"));
    assert.equal(recorded.length, 1, "只有昨天有记录");
    assert.equal(recorded[0].getAttribute("data-date"), yesterday);
    assert.equal(
      recorded[0].classList.contains(`wf-emo-cell--c${emoColorIndex(yesterday) + 1}`),
      true,
      "配色 = emoColorIndex(date) + 1",
    );
    assert.match(recorded[0].title, /有记录/);
    assert.equal(cells.filter((cell) => cell.classList.contains("wf-emo-cell--empty")).length, SPIRAL_TOTAL - 1);
    assert.match(cells.filter((cell) => cell.classList.contains("wf-emo-cell--empty"))[0].title, /无记录/);
  });

  test("环 3~7 挂 --r3…--r7（环 1~2 不挂），条数与几何一致", () => {
    const widget = renderWidget(makeHost().host);
    const cells = widget.query(".wf-emo-cell");
    const count = (cls: string): number => cells.filter((cell) => cell.classList.contains(cls)).length;

    assert.equal(count("wf-emo-cell--r1"), 0, "环 1 不挂类");
    assert.equal(count("wf-emo-cell--r2"), 0, "环 2 不挂类");
    assert.equal(count("wf-emo-cell--r3"), 108 - 64, "环 3 = 44 格");
    assert.equal(count("wf-emo-cell--r4"), 160 - 108);
    assert.equal(count("wf-emo-cell--r5"), 220 - 160);
    assert.equal(count("wf-emo-cell--r6"), 288 - 220);
    assert.equal(count("wf-emo-cell--r7"), 364 - 288);
  });

  test("空目录时今日见闻是淡色大字占位", () => {
    const widget = renderWidget(makeHost().host);
    assert.equal(widget.query(".wf-emo-today-empty").length, 1);
  });
});

describe("emoWidget · 平移 / 缩放", () => {
  test("首帧固定 600%（补充契约①）；Ctrl + 滚轮放大到 660%；双击复位回 100%", () => {
    const widget = renderWidget(makeHost().host);
    const canvas = widget.query(".wf-emo-canvas")[0];
    assert.equal(widget.query(".wf-emo-zoom")[0].text, "600%", "打开时就是 600%（不再按视口自适应）");

    canvas.dispatch("wheel", { ctrlKey: true, deltaY: -100, preventDefault: () => undefined });
    assert.equal(widget.query(".wf-emo-zoom")[0].text, "660%", "放大一档");

    canvas.dispatch("dblclick", {});
    assert.equal(widget.query(".wf-emo-zoom")[0].text, "100%", "双击复位");
  });

  test("不带 Ctrl 的滚轮不缩放（保持页面滚动）", () => {
    const widget = renderWidget(makeHost().host);
    const canvas = widget.query(".wf-emo-canvas")[0];
    let prevented = false;
    canvas.dispatch("wheel", {
      ctrlKey: false,
      deltaY: -100,
      preventDefault: () => {
        prevented = true;
      },
    });
    assert.equal(prevented, false);
    assert.equal(widget.query(".wf-emo-zoom")[0].text, "600%");
  });

  test("平移夹取：内容比视口大就覆盖视口，内容更小就居中", () => {
    const viewport = { width: 400, height: 400 };
    const content = { width: 800, height: 800 };
    assert.deepEqual(clampPan(viewport, content, { x: 0, y: 0 }), { x: 0, y: 0 }, "对齐左上角是合法边界");
    assert.deepEqual(clampPan(viewport, content, { x: -1000, y: -1000 }), { x: -400, y: -400 }, "不能拉出空白");
    assert.deepEqual(clampPan(viewport, content, { x: 200, y: 200 }), { x: 0, y: 0 }, "也不能推离左上角");

    const small = { width: 200, height: 200 };
    assert.deepEqual(clampPan(viewport, small, { x: 0, y: 0 }), { x: 100, y: 100 }, "内容更小 → 居中");
    assert.deepEqual(clampPan({ width: 0, height: 0 }, content, { x: 5, y: 5 }), { x: 0, y: 0 }, "视口没量出来 → 归零");
  });

  test("zoomStep：夹在 0.1~8（10%~800%），百分比文案四舍五入", () => {
    assert.equal(zoomStep(1, 1), 1.1);
    assert.equal(zoomStep(1, -1), 0.91);
    assert.equal(zoomStep(10, 1), 8, "上限 8 = 800%（补充契约①）");
    assert.equal(zoomStep(0.2, -1), 0.18, "0.2 / 1.1 四舍五入");
    assert.equal(zoomStep(0.1, -1), 0.1, "下限 0.1 = 10%");
    assert.equal(EMO_ZOOM_MIN, 0.1);
    assert.equal(EMO_ZOOM_MAX, 8);
    assert.equal(EMO_ZOOM_START, 6, "首帧固定 600%");
    assert.equal(zoomStep(EMO_ZOOM_START, -1), 5.45, "从 600% 往下退一档");
    assert.equal(zoomLabel(0.1), "10%");
    assert.equal(zoomLabel(1), "100%");
    assert.equal(zoomLabel(1.1), "110%");
    assert.equal(zoomLabel(EMO_ZOOM_START), "600%");
    assert.equal(zoomLabel(8), "800%");
  });

  test("画布尺寸与 CSS 变量同口径（20 × 18px）", () => {
    assert.equal(EMO_GRID * EMO_CELL_PX, 360);
  });
});



describe("emoWidget · 存储（§E）", () => {
  test("保存链路顺序：建目录 → 写图 → 写 md（一次性，任一步失败不半途落盘）", async () => {
    const recorder = makeHost();
    await saveDailyRecord(recorder.host, "2026-10-29", {
      sentence: "今天下雨",
      image: { bytes: new ArrayBuffer(4), ext: "png" },
    });

    assert.deepEqual(recorder.calls, [
      "exists:daily",
      "createFolder:daily",
      "createBinary:daily/2026-10-29.png",
      "create:daily/2026-10-29.md",
    ]);
    assert.equal(recorder.vault.content.get("daily/2026-10-29.md"), "今天下雨\n\n![[2026-10-29.png]]\n");
  });

  test("图片扩展名取原文件、缺省 png；换扩展名时删旧图", async () => {
    const recorder = makeHost(["daily/2026-10-29.png"]);
    recorder.vault.folders.add("daily");
    await saveDailyRecord(recorder.host, "2026-10-29", { sentence: "换成 jpg", image: { bytes: new ArrayBuffer(2), ext: ".JPG" } });

    assert.deepEqual(recorder.calls.slice(1), [
      "createBinary:daily/2026-10-29.jpg",
      "delete:daily/2026-10-29.png",
      "create:daily/2026-10-29.md",
    ]);

    const again = makeHost();
    await saveDailyRecord(again.host, "2026-10-29", { sentence: "无扩展名", image: { bytes: new ArrayBuffer(1) } });
    assert.equal(again.vault.content.get("daily/2026-10-29.md"), "无扩展名\n\n![[2026-10-29.png]]\n");
  });

  test("目录已存在 → 不重复创建；无图 → md 只有一句话", async () => {
    const recorder = makeHost(["daily/2026-10-29.md"], { "daily/2026-10-29.md": "旧的一句\n" }, "daily/");
    // 目录包在 folders 里（adapter.exists 返回 true）
    recorder.vault.folders.add("daily");

    await saveDailyRecord(recorder.host, "2026-10-29", { sentence: "新的" });

    assert.deepEqual(recorder.calls, ["exists:daily", "modify:daily/2026-10-29.md"], "没有 createFolder / 没有二进制");
    assert.equal(recorder.vault.content.get("daily/2026-10-29.md"), "新的\n");
  });

  test("旧 md 的 frontmatter 保留（就地替换正文）", async () => {
    const recorder = makeHost(["daily/2026-10-29.md"], { "daily/2026-10-29.md": "---\ntags: [emo]\n---\n旧内容\n" });
    recorder.vault.folders.add("daily");
    await saveDailyRecord(recorder.host, "2026-10-29", { sentence: "新内容" });
    assert.equal(recorder.vault.content.get("daily/2026-10-29.md"), "---\ntags: [emo]\n---\n新内容\n");
  });

  test("一句话超长按 200 字截断，首尾空白去掉", async () => {
    const recorder = makeHost();
    await saveDailyRecord(recorder.host, "2026-10-29", { sentence: `  ${"字".repeat(260)}  ` });
    const text = recorder.vault.content.get("daily/2026-10-29.md") ?? "";
    assert.equal(text.trim().length, 200);
  });

  test("readDailyRecord：md 不存在 → undefined；有图有文 → 句子 + 图片名", async () => {
    const empty = makeHost();
    assert.equal(await readDailyRecord(empty.host, "2026-10-29"), undefined);

    const recorder = makeHost(["daily/2026-10-29.png", "daily/2026-10-29.md"], {
      "daily/2026-10-29.md": "---\nx: 1\n---\n今天很好\n\n![[2026-10-29.png]]\n",
    });
    const record = await readDailyRecord(recorder.host, "2026-10-29");
    assert.equal(record?.sentence, "今天很好");
    assert.equal(record?.image?.name, "2026-10-29.png");
    assert.equal(record?.image?.url, "", "桩里没有 getResourcePath → 给空串（视图据此不出 <img>）");
  });
});

describe("emoWidget · 纯函数", () => {
  test("parseDailyNote：跳过 frontmatter / 标题，第一段文字是一句话，`![[…]]` 是图片", () => {
    assert.deepEqual(parseDailyNote("---\na: 1\n---\n# 标题\n\n![[a.png]]\n\n第二段\n"), {
      sentence: "第二段",
      imageName: "a.png",
    });
    assert.deepEqual(parseDailyNote("只有一句话\n"), { sentence: "只有一句话" });
    assert.deepEqual(parseDailyNote(""), { sentence: "" });
    assert.deepEqual(parseDailyNote("![[a.png|200]]\n"), { sentence: "", imageName: "a.png" }, "支持带尺寸的 wikilink");
  });

  test("buildDailyBody / mergeDailyBody：一句话 + 空行 + 图片链接；保留旧 frontmatter", () => {
    assert.equal(buildDailyBody("一句话", "a.png"), "一句话\n\n![[a.png]]\n");
    assert.equal(buildDailyBody("一句话"), "一句话\n");
    assert.equal(buildDailyBody("", "a.png"), "![[a.png]]\n");
    assert.equal(buildDailyBody("  "), "");
    assert.equal(mergeDailyBody("---\na: 1\n---\n旧\n", "新\n"), "---\na: 1\n---\n新\n");
    assert.equal(mergeDailyBody("旧\n", "新\n"), "新\n");
  });

  test("normalizeFolder / dailyNotePath：去空白与结尾斜杠，空串回落 daily", () => {
    assert.equal(normalizeFolder(" daily/ "), "daily");
    assert.equal(normalizeFolder(""), "daily");
    assert.equal(normalizeFolder("journal/2026/"), "journal/2026");
    assert.equal(dailyNotePath("daily/", "2026-10-29"), "daily/2026-10-29.md");
  });

  test("recordedDates：只认目录下直接子级的 YYYY-MM-DD.md", () => {
    const recorder = makeHost(
      ["daily/2026-10-29.md", "daily/2026-10-28.md", "daily/2026-10-29.png", "daily/sub/2026-10-27.md", "other/2026-10-26.md"],
      {},
    );
    assert.deepEqual([...recordedDates(recorder.host)].sort(), ["2026-10-28", "2026-10-29"]);
  });
});


describe("emoWidget · 拍立得（§D）", () => {
  test("有记录 → 拍立得显示日期 + 一句话；「×」关掉、不写任何文件", async () => {
    const recorder = makeHost(["daily/2026-10-28.md"], { "daily/2026-10-28.md": "昨天的一句话\n" });
    await openPolaroid(recorder.host, "2026-10-28");

    const polaroid = body.query(".wf-emo-polaroid")[0];
    assert.ok(polaroid !== undefined, "应弹出拍立得");
    assert.equal(polaroid.query(".wf-emo-polaroid-date")[0].text, "2026-10-28");
    assert.equal(polaroid.query(".wf-emo-polaroid-text")[0].text, "昨天的一句话");
    assert.deepEqual(recorder.calls, [], "拍立得只读不写（getAbstractFileByPath + read 都不记进 calls）");

    polaroid.query(".wf-emo-close")[0].onclick?.({
      preventDefault: () => undefined,
      stopPropagation: () => undefined,
      clientX: 0,
      clientY: 0,
    });
    assert.equal(body.query(".wf-emo-polaroid").length, 0, "「×」关掉");
  });

  test("没有记录的日期也能打开（空拍立得 + 日期角标）", async () => {
    await openPolaroid(makeHost().host, "2026-01-01");
    const polaroid = body.query(".wf-emo-polaroid")[0];
    assert.equal(polaroid.query(".wf-emo-polaroid-date")[0].text, "2026-01-01");
    assert.equal(polaroid.query(".wf-emo-polaroid-photo")[0].classList.contains("wf-emo-polaroid-photo--empty"), true);
  });
});

/* ------------------------------------------------------------------ *
 * Phase 19 M1：主题 / 右键菜单 / 拍立得编辑 / 格内内容
 * ------------------------------------------------------------------ */

/** 右键 / 点击事件的最小桩 */
const evt = { preventDefault: () => undefined, stopPropagation: () => undefined, clientX: 10, clientY: 20 };

/** 等一轮宏任务（`openPolaroid` / `hydrateCellTexts` 都是异步的） */
const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

describe("emoWidget · 主题（Phase 19 M1 ①）", () => {
  test("根元素挂 wf-emo--<theme>；灵动岛按钮循环切换并落盘（不重渲染画布）", () => {
    const recorder = makeHost();
    const widget = renderWidget(recorder.host);
    const root = widget.query(".wf-emo")[0];
    assert.equal(root.classList.contains("wf-emo--default"), true, "默认主题");

    const chip = widget.query(".wf-emo-theme")[0];
    assert.equal(chip.text, t("theme.emo.default"));
    const cellsBefore = widget.query(".wf-emo-cell").length;

    chip.onclick?.(evt);
    assert.equal(root.classList.contains("wf-emo--weave"), true);
    assert.equal(root.classList.contains("wf-emo--default"), false, "旧主题类被摘掉");
    assert.equal(chip.text, t("theme.emo.weave"));
    assert.deepEqual(recorder.themeCalls, ["weave"], "切换即落盘");
    assert.equal(widget.query(".wf-emo-cell").length, cellsBefore, "格子没有重渲染");

    chip.onclick?.(evt);
    chip.onclick?.(evt);
    assert.equal(root.classList.contains("wf-emo--default"), true, "转一圈回到默认");
    assert.deepEqual(recorder.themeCalls, ["weave", "candy", "default"]);
  });

  test("host.emoTheme 决定初始主题；非法值回落 default", () => {
    const candy = renderWidget(makeHost([], {}, "daily", "candy").host);
    assert.equal(candy.query(".wf-emo")[0].classList.contains("wf-emo--candy"), true);

    const bad = renderWidget(makeHost([], {}, "daily", "not-a-theme").host);
    assert.equal(bad.query(".wf-emo")[0].classList.contains("wf-emo--default"), true);
  });

  test("每个格子都带糖果角度类 --a1…--a18（与颜色类并存）", () => {
    const widget = renderWidget(makeHost().host);
    const cells = widget.query(".wf-emo-cell");
    const angled = cells.filter((cell) =>
      Array.from({ length: 18 }, (_, index) => `wf-emo-cell--a${index + 1}`).some((cls) => cell.classList.contains(cls)),
    );
    assert.equal(angled.length, SPIRAL_TOTAL);
  });
});

describe("emoWidget · 右键菜单（Phase 19 M1 ⑤）", () => {
  test("有记录：MM-DD 日期标签 + 打开 + 编辑", () => {
    const yesterday = spiralDates()[0].date;
    const widget = renderWidget(makeHost([`daily/${yesterday}.md`]).host);
    const cell = widget.query(".wf-emo-cell").find((item) => item.getAttribute("data-date") === yesterday);
    assert.ok(cell !== undefined);

    cell.oncontextmenu?.(evt);
    const menu = body.query(".wf-emo-menu")[0];
    assert.ok(menu !== undefined, "菜单弹出");
    assert.equal(menu.query(".wf-emo-menu-date")[0].text, yesterday.slice(5), "第一项是 MM-DD");
    assert.deepEqual(
      menu.query(".wf-emo-menu-item").map((item) => item.text),
      [t("widget.emo.open"), t("widget.emo.edit")],
    );
  });

  test("往日无记录：只有日期 + 编辑（没有打开）", () => {
    const widget = renderWidget(makeHost().host);
    widget.query(".wf-emo-cell")[0].oncontextmenu?.(evt);
    const menu = body.query(".wf-emo-menu")[0];
    assert.equal(menu.query(".wf-emo-menu-date").length, 1);
    assert.deepEqual(
      menu.query(".wf-emo-menu-item").map((item) => item.text),
      [t("widget.emo.edit")],
      "无记录不给「打开」",
    );
  });

  test("「编辑」打开拍立得编辑模式：图片区 / 文字区各有一个编辑入口", async () => {
    const yesterday = spiralDates()[0].date;
    const widget = renderWidget(makeHost([`daily/${yesterday}.md`]).host);
    const cell = widget.query(".wf-emo-cell").find((item) => item.getAttribute("data-date") === yesterday);
    assert.ok(cell !== undefined);
    cell.oncontextmenu?.(evt);
    const edit = body.query(".wf-emo-menu-item").find((item) => item.text === t("widget.emo.edit"));
    assert.ok(edit !== undefined);
    edit.onclick?.(evt);
    await flush();

    const polaroid = body.query(".wf-emo-polaroid")[0];
    assert.ok(polaroid !== undefined);
    assert.equal(polaroid.query(".wf-emo-polaroid-edit--image").length, 1);
    assert.equal(polaroid.query(".wf-emo-polaroid-edit--text").length, 1);
  });
});

describe("emoWidget · 拍立得编辑（Phase 19 M1 ⑥⑦）", () => {
  test("编辑往日文字：文本框回填旧句子，保存写回并保留图片链接", async () => {
    const date = spiralDates()[0].date;
    const recorder = makeHost([`daily/${date}.md`, `daily/${date}.png`], {
      [`daily/${date}.md`]: `旧的一句话\n\n![[${date}.png]]\n`,
    });

    await openPolaroid(recorder.host, date, { edit: true });
    const polaroid = body.query(".wf-emo-polaroid")[0];
    polaroid.query(".wf-emo-polaroid-edit--text")[0].onclick?.(evt);

    const box = polaroid.query(".wf-emo-editor-text")[0] as unknown as { value: string };
    assert.equal(box.value, "旧的一句话", "回填已有文字");
    box.value = "改过的一句话";

    const buttons = polaroid.query(".wf-emo-btn");
    buttons[buttons.length - 1].onclick?.(evt);
    await flush();

    assert.equal(recorder.vault.content.get(`daily/${date}.md`), `改过的一句话\n\n![[${date}.png]]\n`);
  });

  test("往日无记录格子的「编辑」= 新建当天记录", async () => {
    const date = "2026-01-02";
    const recorder = makeHost();
    await openPolaroid(recorder.host, date, { edit: true });
    const polaroid = body.query(".wf-emo-polaroid")[0];
    assert.equal(polaroid.query(".wf-emo-polaroid-photo")[0].classList.contains("wf-emo-polaroid-photo--empty"), true);

    polaroid.query(".wf-emo-polaroid-edit--text")[0].onclick?.(evt);
    const box = polaroid.query(".wf-emo-editor-text")[0] as unknown as { value: string };
    assert.equal(box.value, "");
    box.value = "补上这一天";
    const buttons = polaroid.query(".wf-emo-btn");
    buttons[buttons.length - 1].onclick?.(evt);
    await flush();

    assert.equal(recorder.vault.content.get(`daily/${date}.md`), "补上这一天\n");
  });

  test("只读「打开」没有编辑入口", async () => {
    await openPolaroid(makeHost().host, "2026-01-03");
    const polaroid = body.query(".wf-emo-polaroid")[0];
    assert.equal(polaroid.query(".wf-emo-polaroid-edit--image").length, 0);
    assert.equal(polaroid.query(".wf-emo-polaroid-edit--text").length, 0);
  });
});

describe("emoWidget · 格内内容（Phase 19 M1 ①）", () => {
  test("默认主题：有图格子出缩略图；无图格子异步出文字", async () => {
    const date = spiralDates()[0].date;

    const withImage = makeHost([`daily/${date}.md`, `daily/${date}.png`]);
    (withImage.host.app.vault as unknown as { getResourcePath: (file: { path: string }) => string }).getResourcePath =
      (file) => `app://${file.path}`;
    const widget = renderWidget(withImage.host);
    const cell = widget.query(".wf-emo-cell").find((item) => item.getAttribute("data-date") === date);
    assert.ok(cell !== undefined);
    assert.equal(cell.query(".wf-emo-cell-img").length, 1);
    assert.equal(cell.query(".wf-emo-cell-img")[0].getAttribute("src"), `app://daily/${date}.png`);

    const withText = makeHost([`daily/${date}.md`], { [`daily/${date}.md`]: "一句话\n" });
    const widget2 = renderWidget(withText.host);
    await flush();
    assert.equal(widget2.query(".wf-emo-cell-text").length, 1);
    assert.equal(widget2.query(".wf-emo-cell-text")[0].text, "一句话");
  });
});

describe("emoWidget · keepImage（Phase 19 M1 ⑦）", () => {
  test("只改文字时保留已有图片链接（不写二进制 / 不删图）", async () => {
    const recorder = makeHost(["daily/2026-10-29.md", "daily/2026-10-29.png"], {
      "daily/2026-10-29.md": "旧\n\n![[2026-10-29.png]]\n",
    });
    recorder.vault.folders.add("daily");

    await saveDailyRecord(recorder.host, "2026-10-29", { sentence: "新", keepImage: "2026-10-29.png" });

    assert.equal(recorder.vault.content.get("daily/2026-10-29.md"), "新\n\n![[2026-10-29.png]]\n");
    assert.deepEqual(recorder.calls, ["exists:daily", "modify:daily/2026-10-29.md"]);
  });
});
