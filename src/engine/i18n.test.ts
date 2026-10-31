/**
 * Phase 10（v0.8）：i18n 单测。
 *
 * 只覆盖「字典 + 切换 + 插值 + 回落」这层契约；
 * 视图 / 插件的文案是否都走了 `t()` 由各自的渲染测试间接保证。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { afterEach, describe, test } from "node:test";

import {
  getLang,
  idKindLabel,
  issueHint,
  issueMsg,
  nodeInfoLabel,
  normalizeLang,
  setLang,
  severityLabel,
  stateLabel,
  statusLabel,
  t,
  weekdayName,
  workflowEditLabel,
} from "./i18n.ts";
import { validateWfJsonValue } from "./analyze.ts";
import { WFJSON_SCHEMA } from "./wfjsonSchema.ts";
import { ISSUE_CODES, formatIssueLine, issue } from "./issues.ts";

const ORIGINAL = getLang();

afterEach(() => {
  setLang(ORIGINAL);
});

describe("i18n · 文案表与切换", () => {
  test("默认是 zh（引擎原文案）；setLang 立即影响后续取词", () => {
    setLang("zh");
    assert.equal(t("severity.error"), "错误");
    setLang("en");
    assert.equal(t("severity.error"), "Error");
    assert.equal(getLang(), "en");
  });

  test("normalizeLang：非法值回落 en，只认 zh", () => {
    assert.equal(normalizeLang("zh"), "zh");
    assert.equal(normalizeLang("en"), "en");
    assert.equal(normalizeLang("jp"), "en");
    assert.equal(normalizeLang(undefined), "en");
    assert.equal(normalizeLang(42), "en");
  });

  test("t()：{name} 插值；缺参数时保留占位符原样", () => {
    setLang("en");
    assert.equal(t("issues.line", { line: 12 }), "line 12");
    assert.equal(t("issues.summary", { errors: 1, warnings: 2, infos: 0 }), "Result: 1 error(s) · 2 warning(s) · 0 info");
    setLang("zh");
    assert.equal(t("issues.line", { line: 12 }), "第 12 行");
    assert.equal(t("issues.more", { count: 3, max: 50 }), "… 另有 3 条问题未显示（maxIssues=50）");
  });

  test("t()：未登记的 key 原样回显（便于发现漏配）", () => {
    setLang("en");
    assert.equal(t("no.such.key"), "no.such.key");
  });

  test("状态 / 严重级别：中英对照不串味", () => {
    setLang("zh");
    assert.equal(statusLabel("todo"), "未开始");
    assert.equal(statusLabel("blocked"), "受阻");
    assert.equal(stateLabel(undefined), "进行中");
    assert.equal(stateLabel("archived"), "已归档");
    assert.equal(severityLabel("warning"), "警告");

    setLang("en");
    assert.equal(statusLabel("todo"), "Not started");
    assert.equal(statusLabel("blocked"), "Blocked");
    assert.equal(stateLabel(undefined), "Active");
    assert.equal(stateLabel("archived"), "Archived");
    assert.equal(severityLabel("warning"), "Warning");
  });

  test("issueHint：zh 用登记表原文；en 用英文；漏配回落原文", () => {
    setLang("zh");
    assert.equal(issueHint("DUPLICATE_WORKFLOW_ID", ISSUE_CODES.DUPLICATE_WORKFLOW_ID.hint), ISSUE_CODES.DUPLICATE_WORKFLOW_ID.hint);

    setLang("en");
    const english = issueHint("DUPLICATE_WORKFLOW_ID", ISSUE_CODES.DUPLICATE_WORKFLOW_ID.hint);
    assert.ok(english !== undefined);
    assert.notEqual(english, ISSUE_CODES.DUPLICATE_WORKFLOW_ID.hint);

    // STATUS_PROGRESS_MISMATCH 刻意不在英文表里 → 回落中文 hint（留空更糟）
    const fallback = issueHint("STATUS_PROGRESS_MISMATCH", "中文兜底");
    assert.equal(fallback, "中文兜底");
  });

  test("issue()/formatIssueLine 跟随当前语言（含行号与严重级别）", () => {
    setLang("en");
    const item = issue("DUPLICATE_WORKFLOW_ID", "raw message", { line: 7, path: "/workflows" });
    assert.equal(item.severity, "error");
    assert.ok(item.hint !== undefined && /unique/.test(item.hint));
    assert.equal(formatIssueLine(item), "[Error] DUPLICATE_WORKFLOW_ID · /workflows · line 7 — raw message");

    setLang("zh");
    const zhItem = issue("DUPLICATE_WORKFLOW_ID", "原始文案", { line: 7, path: "/workflows" });
    assert.equal(zhItem.hint, ISSUE_CODES.DUPLICATE_WORKFLOW_ID.hint);
    assert.equal(formatIssueLine(zhItem), "[错误] DUPLICATE_WORKFLOW_ID · /workflows · 第 7 行 — 原始文案");
  });
});

/* ------------------------------------------------------------------ *
 * Phase 10 补充：视图 / 插件 / 校验消息的英文文案覆盖面
 * ------------------------------------------------------------------ */

/** 仓库根（本文件在 src/engine/ 下） */
const ROOT = new URL("../../", import.meta.url);

/** 会把中文写进界面的文件（漏配一条 key = 英文界面里冒出一句中文） */
const UI_SOURCES: readonly string[] = [
  "main.ts",
  "views/wfView.ts",
  "src/engine/analyze.ts",
  "src/engine/consistency.ts",
  "src/engine/issues.ts",
  "src/engine/noteSection.ts",
  "src/engine/schemaValidator.ts",
  "src/engine/stats.ts",
  "src/engine/timerEdits.ts",
  "src/engine/wfjsonParse.ts",
];

/** 从源码里抓静态 key：`t("a.b")` / `issueMsg("a.b", …)`（排除 setText( 之类的误命中） */
function staticKeys(pattern: RegExp): string[] {
  const keys = new Set<string>();
  for (const file of UI_SOURCES) {
    const text = readFileSync(new URL(file, ROOT), "utf8");
    for (const match of text.matchAll(pattern)) keys.add(match[1] ?? "");
  }
  keys.delete("");
  return [...keys].sort();
}

/** 递归收集 Schema 里的 x-hint（缺 x-hint-en 的记进 missing） */
function collectXHints(node: unknown, state: { total: number; missing: string[] }): void {
  if (Array.isArray(node)) {
    for (const item of node) collectXHints(item, state);
    return;
  }
  if (node === null || typeof node !== "object") return;
  const record = node as Record<string, unknown>;
  if (typeof record["x-hint"] === "string") {
    state.total += 1;
    if (typeof record["x-hint-en"] !== "string") state.missing.push(record["x-hint"]);
  }
  for (const value of Object.values(record)) collectXHints(value, state);
}

describe("i18n · 英文文案覆盖面", () => {
  test("源码里每个 t(\"…\") 的 key 都已登记（否则英文界面会回显 key）", () => {
    const keys = staticKeys(/(?<![\w.$])t\(\s*"([^"]+)"/g);
    assert.ok(keys.length > 100, `扫描到的 key 太少（${keys.length}），正则可能失效`);
    setLang("en");
    const missing = keys.filter((key) => t(key) === key);
    assert.deepEqual(missing, []);
  });

  test("源码里每个 issueMsg(\"…\") 的 key 都有英文模板", () => {
    const keys = staticKeys(/(?<![\w.$])issueMsg\(\s*"([^"]+)"/g);
    assert.ok(keys.length >= 40, `扫描到的校验消息 key 太少（${keys.length}）`);
    setLang("en");
    const missing = keys.filter((key) => issueMsg(key, "ZH-ONLY") === "ZH-ONLY");
    assert.deepEqual(missing, []);
  });

  test("issueMsg：中文原样返回调用点文案，英文才套模板并插值", () => {
    const zh = `id "${"nd-x"}" 出现了 ${2} 次（id 必须全局唯一）`;
    setLang("zh");
    assert.equal(issueMsg("duplicateId", zh, { id: "nd-x", count: 2 }), zh);

    setLang("en");
    assert.equal(
      issueMsg("duplicateId", zh, { id: "nd-x", count: 2 }),
      'id "nd-x" appears 2 times (ids must be unique across the file)',
    );
    // 漏配的 key 回落中文（宁可中文，也不显示 key）
    assert.equal(issueMsg("no.such.key", "中文兜底"), "中文兜底");
  });

  test("星期 / 字段名 / id 种类：中英对照", () => {
    setLang("zh");
    assert.equal(weekdayName(0), "一");
    assert.equal(weekdayName(6), "日");
    assert.equal(nodeInfoLabel("dueAt"), "截止时间");
    // Phase 14：修改工作流弹窗的字段名不再区分「工作流 / 根节点」
    assert.equal(workflowEditLabel("rootProgress"), "已完成");
    assert.equal(workflowEditLabel("rootProgressMax"), "总量");
    assert.equal(workflowEditLabel("title"), "标题");
    for (const key of ["title", "type", "summary", "importance", "urgency", "owner", "dueAt"]) {
      assert.ok(!workflowEditLabel(key).includes("根节点"), `${key} 的标签不该再带「根节点」`);
      assert.ok(!workflowEditLabel(key).includes("工作流"), `${key} 的标签不该再带「工作流」`);
    }
    assert.equal(idKindLabel("workflow"), "工作流");

    setLang("en");
    assert.equal(weekdayName(0), "Mon");
    assert.equal(weekdayName(6), "Sun");
    assert.equal(nodeInfoLabel("dueAt"), "Due");
    assert.equal(workflowEditLabel("rootProgress"), "Done");
    assert.equal(workflowEditLabel("rootProgressMax"), "Total");
    assert.equal(idKindLabel("workflow"), "workflow");
  });

  test("视图文案：中英都已登记且互不相同（样式符号保留）", () => {
    setLang("zh");
    const zhTitle = t("view.gantt.title", { days: 21 });
    // Phase 11：甘特图折叠标题只留「近 N 天甘特图」，说明下沉到图例行
    assert.equal(zhTitle, "近 21 天甘特图");
    assert.equal(t("view.gantt.legend"), "按工作流着色 · 每 2 小时一条分割线");
    // Phase 15：拖拽改节点顺序的开关 / 提示 / 结果文案
    assert.equal(t("view.block.reorderNodes"), "修改节点顺序");
    assert.equal(t("view.reorder.on"), "开");
    assert.equal(t("view.reorder.off"), "关");
    assert.equal(t("view.reorder.hint"), "开启后可拖动节点卡片，拖到另一节点上半 / 下半分别插入到其前 / 后");
    assert.equal(t("view.notify.nodeMoved"), "已调整节点顺序");
    assert.equal(t("view.notify.reorderFailed", { reason: "目标不合法" }), "调整节点顺序失败：目标不合法");
    // Phase 16：小工具侧边栏 / 弹窗
    assert.equal(t("view.widget.sidebar"), "小工具");
    assert.equal(t("view.widget.gantt21"), "21天甘特图");
    assert.equal(t("view.widget.settings"), "插件设置");
    assert.equal(t("view.widget.close"), "关闭");
    assert.equal(t("view.widget.emptyArchive"), "还没有归档节点");
    assert.match(t("view.widget.placeholder"), /还没实现/);
    assert.equal(t("notice.settingsOpenFailed"), "打开插件设置失败");
    // Phase 17：继续上次计时 / 泳道高度 / 卡片时间行
    assert.equal(t("view.timer.resume", { title: "调研竞品" }), "上次：调研竞品");
    // Phase 18：文案改成「继续这个任务」；新增「上一个任务：」那一段
    assert.equal(t("view.timer.resumeAction"), "继续这个任务");
    assert.equal(t("view.timer.resumeTask", { title: "调研竞品" }), "上一个任务：调研竞品");
    assert.equal(t("view.card.elapsed", { days: 3 }), "已经过：3天");
    assert.equal(t("view.card.remain", { days: 0 }), "距结束：0天");
    assert.equal(t("view.card.links", { count: 2 }), "🔗 2");
    assert.equal(t("settings.laneHeight.name"), "泳道高度（px）");
    setLang("en");
    const enTitle = t("view.gantt.title", { days: 21 });
    assert.equal(enTitle, "Gantt chart of the last 21 days");
    assert.equal(t("view.gantt.legend"), "Colored by workflow · a divider every 2 hours");
    assert.ok(zhTitle.includes("21"));
    assert.ok(enTitle.includes("21"));
    assert.notEqual(zhTitle, enTitle);
    assert.equal(t("view.notify.unknownReason"), "unknown reason");
    assert.equal(t("common.cancel"), "Cancel");
    // Phase 15（英文侧）
    assert.equal(t("view.block.reorderNodes"), "Reorder nodes");
    assert.equal(t("view.reorder.on"), "On");
    assert.equal(t("view.reorder.off"), "Off");
    assert.equal(
      t("view.reorder.hint"),
      "When on, drag a node card: drop on the upper half of another node to insert before it, on the lower half to insert after it",
    );
    assert.equal(t("view.notify.nodeMoved"), "Node order updated");
    assert.equal(t("view.notify.reorderFailed", { reason: "bad target" }), "Failed to reorder nodes: bad target");
    // Phase 16（英文侧）
    assert.equal(t("view.widget.sidebar"), "Widgets");
    assert.equal(t("view.widget.gantt21"), "21-day Gantt");
    assert.equal(t("view.widget.settings"), "Plugin settings");
    assert.equal(t("view.widget.close"), "Close");
    assert.equal(t("view.widget.emptyArchive"), "No archived nodes yet");
    assert.match(t("view.widget.placeholder"), /not implemented/);
    assert.equal(t("notice.settingsOpenFailed"), "Failed to open plugin settings");
    // Phase 17（英文侧）
    assert.equal(t("view.timer.resume", { title: "Research" }), "Last: Research");
    assert.equal(t("view.timer.resumeAction"), "Continue this task");
    assert.equal(t("view.timer.resumeTask", { title: "Research" }), "Last task: Research");
    assert.equal(t("view.card.elapsed", { days: 3 }), "Elapsed: 3d");
    assert.equal(t("view.card.remain", { days: 0 }), "Left: 0d");
    assert.equal(t("settings.laneHeight.name"), "Lane body height (px)");
  });

  test("Schema 的每个 x-hint 都有 x-hint-en（英文界面的修复提示不留中文）", () => {
    const state = { total: 0, missing: [] as string[] };
    collectXHints(WFJSON_SCHEMA, state);
    assert.ok(state.total >= 30, `x-hint 数量异常（${state.total}）`);
    assert.deepEqual(state.missing, []);
  });

  test("Schema 校验的 hint 跟随语言：en 无中文，zh 有", () => {
    const bad = {
      schemaVersion: "1.9",
      id: "file-x",
      updatedAt: "not-a-date",
      workflows: [{ id: "wf-x", title: "t", root: { id: "nd-x", title: "t", status: "todo", children: [] } }],
    };

    setLang("en");
    const english = validateWfJsonValue(bad).filter((item) => item.hint !== undefined);
    assert.ok(english.length > 0, "示例数据应至少产出一条带 hint 的问题");
    assert.deepEqual(
      english.filter((item) => /[\u4e00-\u9fff]/.test(item.hint ?? "")),
      [],
    );

    setLang("zh");
    const chinese = validateWfJsonValue(bad).filter((item) => /[\u4e00-\u9fff]/.test(item.hint ?? ""));
    assert.ok(chinese.length > 0);
  });
});

describe("i18n · Phase 18 新增 / 移除的 key", () => {
  const PHASE18_KEYS: readonly string[] = [
    "view.appTitle.default",
    "settings.resumePrompt.name",
    "settings.resumePrompt.desc",
    "settings.resumePrompt.placeholder",
    "settings.cardWidth.name",
    "settings.cardWidth.desc",
    "settings.dailyFolder.name",
    "settings.dailyFolder.desc",
    "view.timer.resumeTask",
    "view.timer.resumeAction",
    "view.card.doneIn",
    "view.card.doneAgo",
    "view.gantt.tipDuration",
    "widget.emo.today",
    "widget.emo.recorded",
    "widget.emo.empty",
    "widget.emo.open",
    "widget.emo.addTitle",
    "widget.emo.sentenceLabel",
    "widget.emo.sentencePlaceholder",
    "widget.emo.imageLabel",
    "widget.emo.imagePaste",
    "widget.emo.zoom",
  ];

  test("中英都齐全（两种语言都不是空串，且不是「没登记的 key 原样回显」）", () => {
    for (const key of PHASE18_KEYS) {
      setLang("zh");
      const zh = t(key);
      setLang("en");
      const en = t(key);
      assert.notEqual(zh, key, `${key} 缺中文`);
      assert.notEqual(en, key, `${key} 缺英文`);
      assert.ok(zh.length > 0 && en.length > 0, `${key} 文案为空`);
    }
  });

  test("resume 行两段文案与视图拼接一致：`上一个任务：…` + `继续这个任务`", () => {
    setLang("zh");
    assert.equal(t("view.timer.resumeAction"), "继续这个任务");
    assert.equal(t("view.timer.resumeTask", { title: "交叉验证" }), "上一个任务：交叉验证");
    // Phase 17 的 key 仍可取出（历史断言 / 其它调用点不崩）
    assert.equal(t("view.timer.resume", { title: "交叉验证" }), "上次：交叉验证");
    setLang("en");
    assert.equal(t("view.timer.resumeAction"), "Continue this task");
    assert.equal(t("view.timer.resumeTask", { title: "X" }), "Last task: X");
    setLang("zh");
  });

  test("`view.card.children` 已从字典移除（t 原样回显 key）", () => {
    setLang("zh");
    assert.equal(t("view.card.children", { count: 3 }), "view.card.children", "查不到该 key");
  });
});

describe("i18n · Phase 19 M2 新增的 key（4 象限节点）", () => {
  const PHASE19_M2_KEYS: readonly string[] = [
    "widget.quadrant.axisX",
    "widget.quadrant.axisY",
    "widget.quadrant.empty",
    "widget.quadrant.noNodes",
    "widget.quadrant.partition",
    "widget.quadrant.workflow",
    "widget.quadrant.time",
  ];

  test("中英都齐全（两种语言都不是空串，且不是「没登记的 key 原样回显」）", () => {
    for (const key of PHASE19_M2_KEYS) {
      setLang("zh");
      const zh = t(key, { importance: 4, urgency: 3, count: 2, title: "T", since: "1d", recorded: "2h" });
      setLang("en");
      const en = t(key, { importance: 4, urgency: 3, count: 2, title: "T", since: "1d", recorded: "2h" });
      assert.notEqual(zh, key, `${key} 缺中文`);
      assert.notEqual(en, key, `${key} 缺英文`);
      assert.ok(zh.length > 0 && en.length > 0, `${key} 文案为空`);
    }
    setLang("zh");
  });

  test("插值都生效（预览行三行文案不会漏占位符）", () => {
    setLang("zh");
    assert.equal(
      t("widget.quadrant.partition", { importance: 4, urgency: 3, count: 2 }),
      "重要 4 · 紧急 3 · 2 个任务",
    );
    assert.equal(t("widget.quadrant.workflow", { title: "立项调查" }), "所属工作流：立项调查");
    assert.equal(
      t("widget.quadrant.time", { since: "3d3h", recorded: "2.5h" }),
      "开始距今：3d3h 已记录：2.5h",
    );
  });
});

describe("i18n · Phase 19 M3 新增的 key（365 天 plot）", () => {
  const PHASE19_M3_KEYS: readonly string[] = [
    "widget.plot.list",
    "widget.plot.new",
    "widget.plot.newTitle",
    "widget.plot.name",
    "widget.plot.namePlaceholder",
    "widget.plot.kind",
    "widget.plot.kind.date",
    "widget.plot.kind.sequence",
    "widget.plot.kind.dateHint",
    "widget.plot.kind.sequenceHint",
    "widget.plot.unit",
    "widget.plot.unitPlaceholder",
    "widget.plot.delete",
    "widget.plot.empty",
    "widget.plot.loading",
    "widget.plot.unselected",
    "widget.plot.emptyPoints",
    "widget.plot.meta",
    "widget.plot.metaUnit",
    "widget.plot.points",
    "widget.plot.addPoint",
    "widget.plot.removePoint",
    "widget.plot.invalidX",
    "widget.plot.invalidY",
    "widget.plot.xyTaken",
    "widget.plot.import",
    "widget.plot.export",
    "widget.plot.exportPath",
    "widget.plot.exported",
    "widget.plot.imported",
    "widget.plot.importSkipped",
    "widget.plot.importEmpty",
    "widget.plot.needSelection",
    "widget.plot.readFailed",
    "widget.plot.created",
    "widget.plot.deleted",
    "settings.plotFolder.name",
    "settings.plotFolder.desc",
  ];

  test("中英都齐全（两种语言都不是空串，且不是「没登记的 key 原样回显」）", () => {
    for (const key of PHASE19_M3_KEYS) {
      const params = {
        kind: "日期",
        count: 2,
        unit: "kg",
        hint: "x = YYYY-MM-DD",
        path: "plots/plot-a.csv",
        name: "体重变化",
        lines: "3, 5",
        folder: "plots",
      };
      setLang("zh");
      const zh = t(key, params);
      setLang("en");
      const en = t(key, params);
      assert.notEqual(zh, key, `${key} 缺中文`);
      assert.notEqual(en, key, `${key} 缺英文`);
      assert.ok(zh.length > 0 && en.length > 0, `${key} 文案为空`);
    }
    setLang("zh");
  });

  test("插值都生效（列表副标题 / 导入导出提示不会漏占位符）", () => {
    setLang("zh");
    assert.equal(t("widget.plot.meta", { kind: "日期", count: 3 }), "日期 · 3 个点");
    assert.equal(t("widget.plot.metaUnit", { kind: "日期", unit: "kg", count: 3 }), "日期 · kg · 3 个点");
    assert.equal(t("widget.plot.points", { count: 3 }), "数据点（3）");
    assert.equal(t("widget.plot.exported", { path: "plots/plot-a.csv" }), "已导出：plots/plot-a.csv");
    assert.equal(t("widget.plot.imported", { count: 5 }), "已导入 5 个点");
    assert.equal(
      t("widget.plot.importSkipped", { count: 2, lines: "4, 5" }),
      "有 2 行没读进来（第 4, 5 行）",
    );

    setLang("en");
    assert.equal(t("widget.plot.kind.sequence"), "Sequence");
    assert.equal(t("settings.plotFolder.name"), "Plot folder");
    setLang("zh");
  });
});

describe("i18n · Phase 19 M1 新增的 key", () => {
  const PHASE19_KEYS: readonly string[] = [
    "theme.emo.default",
    "theme.emo.weave",
    "theme.emo.candy",
    "widget.emo.edit",
    "widget.emo.editImage",
    "widget.emo.editText",
    "settings.emoTheme.name",
    "settings.emoTheme.desc",
  ];

  test("中英都齐全（两种语言都不是空串，且不是「没登记的 key 原样回显」）", () => {
    for (const key of PHASE19_KEYS) {
      setLang("zh");
      const zh = t(key);
      setLang("en");
      const en = t(key);
      assert.notEqual(zh, key, `${key} 缺中文`);
      assert.notEqual(en, key, `${key} 缺英文`);
      assert.ok(zh.length > 0 && en.length > 0, `${key} 文案为空`);
    }
    setLang("zh");
  });
});

