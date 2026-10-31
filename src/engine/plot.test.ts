/**
 * `src/engine/plot.ts` 单测（Phase 19 M3）。
 *
 * 覆盖契约里的每一条口径：目录 / id / 路径（文件名 = id）、x 的类型约束
 * （date = 真实存在的 `YYYY-MM-DD`、sequence = 正整数）、`validatePlot` 的容错、
 * `sortPoints` 的稳定排序、`computeScale` + `projectValue` 的坐标域与退化情形、
 * `toCsv` / `fromCsv` 的往返与逐行报错。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  PLOT_FOLDER_DEFAULT,
  PLOT_KINDS,
  PLOT_KIND_DEFAULT,
  PLOT_POINTS_MAX,
  computeScale,
  fromCsv,
  isPlotId,
  isPlotKind,
  isValidPlotX,
  newPlotId,
  normalizePlotFolder,
  normalizePlotKind,
  parsePlotSearch,
  parsePlotX,
  parsePlotY,
  plotCsvPath,
  plotIdFromPath,
  plotPath,
  plotToJson,
  plotXInRange,
  plotXValue,
  projectValue,
  sortPoints,
  toCsv,
  validatePlot,
  type PlotDocument,
  type PlotPoint,
} from "./plot.ts";

/** 一个合法的 plot（多数用例在它上面改一处） */
function plotOf(overrides: Partial<PlotDocument> = {}): PlotDocument {
  return {
    id: "plot-00000000-0000-4000-8000-000000000000",
    name: "体重变化",
    kind: "date",
    unit: "kg",
    points: [
      { x: "2026-01-01", y: 70.5 },
      { x: "2026-01-03", y: 70 },
      { x: "2026-01-02", y: 70.2 },
    ],
    ...overrides,
  };
}

describe("plot · 目录 / 类型 / id / 路径", () => {
  test("目录校验与 normalizeDailyFolder 同口径：去空白、去结尾斜杠、空串回落 plots", () => {
    assert.equal(PLOT_FOLDER_DEFAULT, "plots");
    assert.equal(normalizePlotFolder("plots"), "plots");
    assert.equal(normalizePlotFolder("  metrics/  "), "metrics");
    assert.equal(normalizePlotFolder("metrics//"), "metrics");
    assert.equal(normalizePlotFolder(""), "plots");
    assert.equal(normalizePlotFolder("   "), "plots");
    assert.equal(normalizePlotFolder(undefined), "plots");
    assert.equal(normalizePlotFolder(42), "plots");
  });

  test("类型白名单：date / sequence，其它值回落 date", () => {
    assert.deepEqual([...PLOT_KINDS], ["date", "sequence"]);
    assert.equal(PLOT_KIND_DEFAULT, "date");
    assert.equal(normalizePlotKind("sequence"), "sequence");
    assert.equal(normalizePlotKind("week"), "date");
    assert.equal(normalizePlotKind(undefined), "date");
    assert.equal(isPlotKind("date"), true);
    assert.equal(isPlotKind("DATE"), false);
  });

  test("id：`plot-<uuid>` 形态，且每次都不同", () => {
    const ids = new Set<string>();
    for (let index = 0; index < 50; index += 1) {
      const id = newPlotId();
      assert.match(id, /^plot-[0-9a-z-]{8,}$/, "前缀 + uuid");
      assert.equal(isPlotId(id), true);
      ids.add(id);
    }
    assert.equal(ids.size, 50, "50 次不应撞 id");
    assert.equal(isPlotId("plot-"), false, "只有前缀不算");
    assert.equal(isPlotId("nd-uuid-001"), false, "别的 id 前缀不认");
    assert.equal(isPlotId(123), false);
  });

  test("路径：文件名 = id（改 name 不动文件），CSV 落在同一个目录", () => {
    assert.equal(plotPath("plots", "plot-a"), "plots/plot-a.json");
    assert.equal(plotCsvPath("metrics/", "plot-a"), "metrics/plot-a.csv");
    assert.equal(plotPath("", "plot-a"), "plots/plot-a.json", "空目录回落默认值");
    assert.equal(plotIdFromPath("plots/plot-a.json"), "plot-a");
    assert.equal(plotIdFromPath("A/B/plot-a.json"), "plot-a", "嵌套目录也认");
    assert.equal(plotIdFromPath("plots/plot-a.csv"), undefined, "CSV 不是 plot 文件");
    assert.equal(plotIdFromPath("plots/notes.json"), undefined, "没有 plot- 前缀");
    assert.equal(plotIdFromPath("plots/plot-a.md"), undefined);
  });
});


describe("plot · x 的校验 / 归一 / 解析", () => {
  test("date：必须是真实存在的 `YYYY-MM-DD`（2 月 30 日、13 月都不算）", () => {
    assert.equal(isValidPlotX("date", "2026-01-01"), true);
    assert.equal(isValidPlotX("date", "2024-02-29"), true, "闰年 2 月 29 日合法");
    assert.equal(isValidPlotX("date", "2026-02-29"), false, "2026 不是闰年");
    assert.equal(isValidPlotX("date", "2026-02-30"), false);
    assert.equal(isValidPlotX("date", "2026-13-01"), false);
    assert.equal(isValidPlotX("date", "2026-1-1"), false, "必须补零");
    assert.equal(isValidPlotX("date", "2026-01-01T08:00:00"), false, "date 只收纯日期");
    assert.equal(isValidPlotX("date", 1), false);
  });

  test("sequence：必须是正整数（0 / 负数 / 小数 / 字符串都不算）", () => {
    assert.equal(isValidPlotX("sequence", 1), true);
    assert.equal(isValidPlotX("sequence", 99), true);
    assert.equal(isValidPlotX("sequence", 0), false);
    assert.equal(isValidPlotX("sequence", -2), false);
    assert.equal(isValidPlotX("sequence", 1.5), false);
    assert.equal(isValidPlotX("sequence", "1"), false);
    assert.equal(isValidPlotX("sequence", Number.NaN), false);
  });

  test("plotXValue：date 按日历日算（相邻两天差 1），sequence 就是整数", () => {
    const first = plotXValue("date", "2026-01-01");
    const next = plotXValue("date", "2026-01-02");
    assert.ok(first !== undefined && next !== undefined);
    assert.equal(next - first, 1);
    // 跨月 / 跨年也连续
    assert.equal((plotXValue("date", "2026-03-01") ?? 0) - (plotXValue("date", "2026-02-28") ?? 0), 1);
    assert.equal((plotXValue("date", "2027-01-01") ?? 0) - (plotXValue("date", "2026-12-31") ?? 0), 1);
    assert.equal(plotXValue("sequence", 7), 7);
    assert.equal(plotXValue("date", "2026-02-30"), undefined);
    assert.equal(plotXValue("sequence", 0), undefined);
  });

  test("parsePlotX：输入框文本 → x（date 去空白、sequence 只收纯数字）", () => {
    assert.equal(parsePlotX("date", " 2026-01-01 "), "2026-01-01");
    assert.equal(parsePlotX("date", "2026-02-30"), undefined);
    assert.equal(parsePlotX("date", ""), undefined);

    assert.equal(parsePlotX("sequence", "12"), 12);
    assert.equal(parsePlotX("sequence", "0"), undefined);
    assert.equal(parsePlotX("sequence", "1.5"), undefined);
    assert.equal(parsePlotX("sequence", "abc"), undefined);
    assert.equal(parsePlotX("sequence", ""), undefined);
  });

  test("parsePlotY：接受小数 / 负数 / 科学计数，空串与非数字返回 undefined", () => {
    assert.equal(parsePlotY("70.5"), 70.5);
    assert.equal(parsePlotY(" -3 "), -3);
    assert.equal(parsePlotY("1e3"), 1000);
    assert.equal(parsePlotY("0"), 0);
    assert.equal(parsePlotY(""), undefined);
    assert.equal(parsePlotY("   "), undefined);
    assert.equal(parsePlotY("abc"), undefined);
    assert.equal(parsePlotY("Infinity"), undefined);
  });

describe("plot · validatePlot（读盘容错）", () => {
  test("合法文档：字段原样带出（name / unit 去空白，points 保持文件顺序）", () => {
    const result = validatePlot({
      id: "plot-abc",
      name: "  体重变化  ",
      kind: "date",
      unit: " kg ",
      points: [
        { x: "2026-01-03", y: 70 },
        { x: "2026-01-01", y: 70.5 },
      ],
    });
    assert.deepEqual(result.issues, []);
    assert.ok(result.plot);
    assert.equal(result.plot.id, "plot-abc");
    assert.equal(result.plot.name, "体重变化");
    assert.equal(result.plot.kind, "date");
    assert.equal(result.plot.unit, "kg");
    assert.deepEqual(
      result.plot.points.map((point) => point.x),
      ["2026-01-03", "2026-01-01"],
      "不排序（排序由 sortPoints 负责）",
    );
  });

  test("不是对象 / kind 不认 / points 不是数组 → 没有 plot，只给 issue", () => {
    assert.deepEqual(validatePlot(null).issues, [{ code: "notObject" }]);
    assert.deepEqual(validatePlot("plot").issues, [{ code: "notObject" }]);
    assert.deepEqual(validatePlot([]).issues, [{ code: "notObject" }]);

    const badKind = validatePlot({ id: "plot-abc", kind: "week", points: [] });
    assert.equal(badKind.plot, undefined);
    assert.deepEqual(badKind.issues, [{ code: "kind" }]);

    const badPoints = validatePlot({ id: "plot-abc", kind: "date", points: {} });
    assert.equal(badPoints.plot, undefined);
    assert.deepEqual(badPoints.issues, [{ code: "points" }]);
  });

  test("id 缺失 / 非法 → 用文件名（fallbackId）兜底；都没有才报 id", () => {
    const fromName = validatePlot({ kind: "sequence", points: [] }, "plot-from-name");
    assert.deepEqual(fromName.issues, []);
    assert.equal(fromName.plot?.id, "plot-from-name");

    const badId = validatePlot({ id: "notes-1", kind: "date", points: [] }, "plot-from-name");
    assert.deepEqual(badId.issues, [], "非法 id 被文件名替换，不算错");
    assert.equal(badId.plot?.id, "plot-from-name");

    const none = validatePlot({ kind: "date", points: [] });
    assert.equal(none.plot, undefined);
    assert.deepEqual(none.issues, [{ code: "id" }]);
  });

  test("单个点坏掉：记下标并跳过，其余点照常返回", () => {
    const result = validatePlot({
      id: "plot-abc",
      kind: "sequence",
      points: [
        { x: 1, y: 10 },
        { x: 0, y: 11 },
        { x: 2, y: "x" },
        { x: 3, y: 13 },
        null,
      ],
    });
    assert.deepEqual(result.issues, [
      { code: "point", index: 1 },
      { code: "point", index: 2 },
      { code: "point", index: 4 },
    ]);
    assert.deepEqual(result.plot?.points, [
      { x: 1, y: 10 },
      { x: 3, y: 13 },
    ]);
  });

  test("name / unit 缺失 → 空串；点数超上限只读进 PLOT_POINTS_MAX 个", () => {
    const bare = validatePlot({ id: "plot-abc", kind: "date", points: [] });
    assert.equal(bare.plot?.name, "");
    assert.equal(bare.plot?.unit, "");

    const many = Array.from({ length: PLOT_POINTS_MAX + 5 }, (_, index) => ({ x: index + 1, y: index }));
    const capped = validatePlot({ id: "plot-abc", kind: "sequence", points: many });
    assert.equal(capped.plot?.points.length, PLOT_POINTS_MAX);
  });

  test("plotToJson：字段顺序固定、2 空格缩进、结尾换行（可直接 parse 回来）", () => {
    const json = plotToJson(plotOf({ points: [{ x: "2026-01-01", y: 70.5 }] }));
    assert.match(json, /^\{\n {2}"id": "plot-00000000-0000-4000-8000-000000000000",\n {2}"name": "体重变化",/);
    assert.match(json, /\n$/);
    const parsed = validatePlot(JSON.parse(json));
    assert.deepEqual(parsed.issues, []);
    assert.deepEqual(parsed.plot?.points, [{ x: "2026-01-01", y: 70.5 }]);
  });
});


describe("plot · sortPoints / computeScale / projectValue", () => {
  test("sortPoints：date 按日历日正序、x 非法的排最后、同 x 保持原顺序", () => {
    const points: PlotPoint[] = [
      { x: "2026-01-03", y: 3 },
      { x: "2026-01-01", y: 1 },
      { x: "bad", y: 9 },
      { x: "2026-01-02", y: 2 },
      { x: "2026-01-01", y: 11 },
    ];
    assert.deepEqual(
      sortPoints("date", points).map((point) => `${point.x}:${point.y}`),
      ["2026-01-01:1", "2026-01-01:11", "2026-01-02:2", "2026-01-03:3", "bad:9"],
    );
    assert.deepEqual(
      points.map((point) => point.x),
      ["2026-01-03", "2026-01-01", "bad", "2026-01-02", "2026-01-01"],
      "不改原数组",
    );
  });

  test("sortPoints：sequence 按数值（10 排在 9 后面，不是字符串序）", () => {
    const points: PlotPoint[] = [
      { x: 10, y: 0 },
      { x: 9, y: 0 },
      { x: 2, y: 0 },
    ];
    assert.deepEqual(
      sortPoints("sequence", points).map((point) => point.x),
      [2, 9, 10],
    );
  });

  test("computeScale：x 用原始值域（时间跨度看得见），y 上下各留 5%", () => {
    const scale = computeScale("date", [
      { x: "2026-01-01", y: 70 },
      { x: "2026-01-11", y: 80 },
    ]);
    assert.equal(scale.entries.length, 2);
    const first = plotXValue("date", "2026-01-01") ?? 0;
    assert.equal(scale.x.min, first);
    assert.equal(scale.x.max, first + 10, "10 天的跨度 = 10");
    assert.equal(scale.y.min, 69.5, "70 − (80−70)×5%");
    assert.equal(scale.y.max, 80.5);
  });

  test("computeScale：单点 / 全等值时 y 上下撑开（值 0 时给 ±1）；没有点时是 0..1", () => {
    const single = computeScale("sequence", [{ x: 1, y: 70 }]);
    assert.equal(single.y.min, 63, "70 ∓ 70×10%");
    assert.equal(single.y.max, 77);
    assert.equal(single.x.min, 1);
    assert.equal(single.x.max, 1);

    const zero = computeScale("sequence", [{ x: 1, y: 0 }]);
    assert.deepEqual(zero.y, { min: -1, max: 1 });

    const empty = computeScale("date", []);
    assert.deepEqual(empty.entries, []);
    assert.deepEqual(empty.x, { min: 0, max: 1 });
    assert.deepEqual(empty.y, { min: 0, max: 1 });
  });

  test("computeScale：x 非法 / y 非有限的点被剔除（图上不会画出断点）", () => {
    const scale = computeScale("date", [
      { x: "2026-01-01", y: 1 },
      { x: "2026-02-30", y: 2 },
      { x: "2026-01-02", y: Number.NaN },
      { x: "2026-01-03", y: 3 },
    ]);
    assert.deepEqual(
      scale.entries.map((entry) => entry.point.x),
      ["2026-01-01", "2026-01-03"],
    );
  });

  test("projectValue：线性映射 + 域退化时落在中点", () => {
    assert.equal(projectValue(0, { min: 0, max: 10 }, 20, 220), 20);
    assert.equal(projectValue(10, { min: 0, max: 10 }, 20, 220), 220);
    assert.equal(projectValue(5, { min: 0, max: 10 }, 20, 220), 120);
    assert.equal(projectValue(5, { min: 5, max: 5 }, 20, 220), 120, "单点落在中间");
    assert.equal(projectValue(5, { min: 0, max: 0 }, 0, 100), 50);
  });
});


describe("plot · CSV 往返（只承载 points）", () => {
  test("toCsv：`x,y` 表头 + 按 x 正序 + 结尾换行；非法点被跳过", () => {
    const csv = toCsv("date", [
      { x: "2026-01-02", y: 70.2 },
      { x: "2026-01-01", y: 70.5 },
      { x: "bad", y: 1 },
    ]);
    assert.equal(csv, "x,y\n2026-01-01,70.5\n2026-01-02,70.2\n");
  });

  test("fromCsv → toCsv 往返：表头 / 空行 / CRLF 都不影响", () => {
    const text = "x,y\r\n2026-01-01,70.5\r\n\r\n2026-01-02,70.2\r\n";
    const result = fromCsv("date", text);
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.points, [
      { x: "2026-01-01", y: 70.5 },
      { x: "2026-01-02", y: 70.2 },
    ]);
    assert.equal(toCsv("date", result.points), "x,y\n2026-01-01,70.5\n2026-01-02,70.2\n");
  });

  test("fromCsv：没有表头也能读（首行就是数据）", () => {
    const result = fromCsv("sequence", "3,30\n1,10\n2,20\n");
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.points, [
      { x: 3, y: 30 },
      { x: 1, y: 10 },
      { x: 2, y: 20 },
    ]);
    assert.deepEqual(
      sortPoints("sequence", result.points).map((point) => point.x),
      [1, 2, 3],
    );
  });

  test("fromCsv：逐行报错（columns / x / y），坏行跳过、好行照收", () => {
    const result = fromCsv("date", ["x,y", "2026-01-01,70.5", "2026-01-02", "2026-02-30,70", "2026-01-03,abc", "2026-01-04,71"].join("\n"));
    assert.deepEqual(result.errors, [
      { line: 3, code: "columns" },
      { line: 4, code: "x" },
      { line: 5, code: "y" },
    ]);
    assert.deepEqual(result.points, [
      { x: "2026-01-01", y: 70.5 },
      { x: "2026-01-04", y: 71 },
    ]);
  });

  test("fromCsv：同一 x 后出现的覆盖前面的（一个日期只留一个值）", () => {
    const result = fromCsv("date", "2026-01-01,70\n2026-01-02,71\n2026-01-01,69.5\n");
    assert.deepEqual(result.errors, []);
    assert.deepEqual(result.points, [
      { x: "2026-01-01", y: 69.5 },
      { x: "2026-01-02", y: 71 },
    ]);
  });

  test("fromCsv：超过 PLOT_POINTS_MAX 记一条 limit 并停止", () => {
    const lines = Array.from({ length: PLOT_POINTS_MAX + 3 }, (_, index) => `${index + 1},${index}`);
    const result = fromCsv("sequence", lines.join("\n"));
    assert.equal(result.points.length, PLOT_POINTS_MAX);
    assert.deepEqual(result.errors, [{ line: PLOT_POINTS_MAX + 1, code: "limit" }]);
  });

  test("kind 决定 x 的写法：sequence 的 CSV 不认日期、date 的 CSV 不认整数", () => {
    assert.deepEqual(fromCsv("sequence", "2026-01-01,70").errors, [{ line: 1, code: "x" }]);
    assert.deepEqual(fromCsv("date", "1,70").errors, [{ line: 1, code: "x" }]);
  });
});

});

describe("plot · 点搜索（补充契约⑥c：空 / 精确 / 闭区间 / 颠倒 / 非法）", () => {
  test("parsePlotSearch：空串 = 两边都不限", () => {
    assert.deepEqual(parsePlotSearch("date", ""), {});
    assert.deepEqual(parsePlotSearch("sequence", "   "), {});
  });

  test("parsePlotSearch：`A` = 精确匹配（min = max = A）", () => {
    assert.deepEqual(parsePlotSearch("date", "2026-01-02"), { min: "2026-01-02", max: "2026-01-02" });
    assert.deepEqual(parsePlotSearch("sequence", " 3 "), { min: 3, max: 3 }, "首尾空白忽略");
  });

  test("parsePlotSearch：`A~B` = 闭区间；写反了自动交换", () => {
    assert.deepEqual(parsePlotSearch("date", "2026-01-01~2026-02-01"), {
      min: "2026-01-01",
      max: "2026-02-01",
    });
    assert.deepEqual(
      parsePlotSearch("date", "2026-02-01~2026-01-01"),
      { min: "2026-01-01", max: "2026-02-01" },
      "用户写反了也照收",
    );
    assert.deepEqual(parsePlotSearch("sequence", "5~2"), { min: 2, max: 5 });
  });

  test("parsePlotSearch：非法输入给 invalid（date 走真实日历、sequence 必须正整数、`~` 最多 1 个）", () => {
    assert.deepEqual(parsePlotSearch("date", "2026-02-30"), { invalid: true }, "不存在的日期");
    assert.deepEqual(parsePlotSearch("date", "2026-1-1"), { invalid: true }, "格式不对");
    assert.deepEqual(parsePlotSearch("date", "2026-01-01~"), { invalid: true }, "缺右端点");
    assert.deepEqual(parsePlotSearch("date", "~2026-01-01"), { invalid: true }, "缺左端点");
    assert.deepEqual(parsePlotSearch("date", "2026-01-01~2026-01-02~2026-01-03"), { invalid: true });
    assert.deepEqual(parsePlotSearch("sequence", "0"), { invalid: true }, "序号从 1 起");
    assert.deepEqual(parsePlotSearch("sequence", "1.5"), { invalid: true });
    assert.deepEqual(parsePlotSearch("date", "1"), { invalid: true }, "date 不认整数");
  });

  test("plotXInRange：闭区间两端都算命中，undefined 表示该侧不限", () => {
    assert.equal(plotXInRange("date", "2026-01-02", "2026-01-01", "2026-01-03"), true);
    assert.equal(plotXInRange("date", "2026-01-01", "2026-01-01", "2026-01-03"), true, "左端闭");
    assert.equal(plotXInRange("date", "2026-01-03", "2026-01-01", "2026-01-03"), true, "右端闭");
    assert.equal(plotXInRange("date", "2026-01-04", "2026-01-01", "2026-01-03"), false);
    assert.equal(plotXInRange("date", "2025-12-31", "2026-01-01", "2026-01-03"), false);
    assert.equal(plotXInRange("date", "2025-01-01", undefined, "2026-01-03"), true, "只给上界");
    assert.equal(plotXInRange("date", "2027-01-01", undefined, "2026-01-03"), false, "只给上界（超出）");
    assert.equal(plotXInRange("date", "2027-01-01", "2026-01-01", undefined), true, "只给下界");
    assert.equal(plotXInRange("date", "2026-02-30", "2026-01-01", "2026-12-31"), false, "脏 x 不进点表");
  });

  test("plotXInRange：sequence 按整数比较", () => {
    assert.equal(plotXInRange("sequence", 3, 2, 4), true);
    assert.equal(plotXInRange("sequence", 1, 2, 4), false);
    assert.equal(plotXInRange("sequence", 5, 2, 4), false);
    assert.equal(plotXInRange("sequence", 2.5, 2, 4), false, "非整数 x 非法");
  });

  test("同一条区间既能筛点表、也不影响 SVG 用的全量点", () => {
    const points: PlotPoint[] = [
      { x: "2026-01-01", y: 70 },
      { x: "2026-01-02", y: 70.2 },
      { x: "2026-01-03", y: 70 },
    ];
    const range = parsePlotSearch("date", "2026-01-01~2026-01-02");
    assert.deepEqual(
      points.filter((point) => plotXInRange("date", point.x, range.min, range.max)).map((point) => point.x),
      ["2026-01-01", "2026-01-02"],
    );
    assert.equal(points.length, 3, "原数组不被改写（SVG 仍画 3 个点）");
  });
});

