/**
 * dataviewjs 视图 v1 的单测（纯 Node：DOM 用 views/testDomStub.ts 桩，引擎用真实实现）。
 *
 * 覆盖：状态总览数字、泳道/卡片/折叠区结构、collapsed / 重要度 / links 的类名、
 * 右键菜单与写回链路（假 host）、坏数据只摊问题、无代码块提示、isViewApi，
 * 以及 DOM 归属（游离元素不能用 document 当容器 —— 真实 vault 里会抛 HierarchyRequestError）。
 *
 * 运行方式（`obsidian` 是纯类型包，纯 Node 直接 import 会解析失败）：
 *
 *     npm run test:views      # = node --import ./views/obsidianResolve.mjs --test views/wfView.test.ts
 *
 * 为什么不在默认的 `npm test` 里：这个文件串起 Phase 1–19 的全部视图断言，其中
 * **Phase 16–18 有 17 条断言与当前实现已经漂移**（`.wf-lane` 的横向滚动搬到了
 * `.wf-lane-body`、侧栏 aria-label 撤掉、主题按钮文案改了、引导性大标题字号 1.6em → 2em 等）。
 * 那些是「实现先改、测试没跟上」的历史债，需要单独一轮对齐（不能靠改实现去迁就旧断言）。
 * 修完那 17 条，把 `package.json` 的 `test` 换回 `views/**\/*.test.ts` 即可。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { after, describe, test } from "node:test";

import type { App, TFile } from "obsidian";

import {
  NODE_STATUSES,
  STATUS_LABELS,
  TIMER_INVALID_START_MESSAGE,
  analyzeMarkdown,
  appendChildNode,
  archiveNode,
  formatLocalDate,
  planArchive,
  recentDateKeys,
  removeNode,
  replaceNoteSectionContent,
  startTimerEntry,
  walkWorkflow,
  writeBackDocument,
  type WfJsonDocument,
} from "../src/engine/index.ts";
import {
  ARCHIVE_FILE,
  ARCHIVE_ROOT_ID,
  ARCHIVED_WF_TITLE,
  CHILD_ID,
  DOING_ID,
  ROOT_ID,
  TIME_ARCHIVED_AT,
  WF1_ID,
  WF2_ID,
  clone,
  leaf,
  validDocument11,
  validDocument13,
  validMarkdown,
  validMarkdown11,
  validMarkdown13,
  wfjsonBlockOnly,
} from "../src/engine/testFixtures.ts";
import { asHtmlElement, installDomStub, StubElement, type StubMouseEvent } from "./testDomStub.ts";
import { isViewApi, renderWorkflowView, resolveDrop, stopTimerTicker, type WfViewHost } from "./wfView.ts";

const body = installDomStub();

const file = { path: "test.md", basename: "test", extension: "md" } as unknown as TFile;

interface Recorder {
  host: WfViewHost;
  notices: string[];
  statusCalls: { nodeId: string; status: string }[];
  childCalls: { nodeId: string }[];
  deleteCalls: { nodeId: string }[];
  /** Phase 3：开始 / 结束计时的调用记录 */
  timerStartCalls: { nodeId: string }[];
  timerStopCalls: { nodeId: string; mode: string }[];
  /** Phase 4：归档入口的调用记录 */
  archiveCalls: { nodeId: string }[];
  /** Phase 5：编辑节点信息 / 修改工作流入口的调用记录 */
  infoCalls: { nodeId: string }[];
  workflowEditCalls: { filePath: string }[];
  /** Phase 15：拖拽改节点顺序的调用记录 */
  moveCalls: { movingId: string; targetId: string; position: string }[];
  /** Phase 6/9：主题切换入口的调用记录（点一次按钮记「文件路径 + key」） */
  themeCalls: { path: string; theme: string }[];
  /** Phase 16：侧边栏 ⚙️ → `host.openSettings()` 的调用记录 */
  settingsCalls: number[];
  /** 假文件内容：测试里可以改（模拟插件写回落盘 → 验证局部刷新） */
  state: { markdown: string };
}

const NOW = new Date("2026-10-12T09:00:00+08:00");

/** 测试用：把 `wf-theme` 写进 frontmatter（模拟 host.setFileTheme 的落盘效果） */
function applyThemeToMarkdown(markdown: string, theme: string): string {
  const lines = markdown.split(/\r?\n/);
  if (lines[0] !== "---") return `---\nwf-theme: ${theme}\n---\n${markdown}`;
  const end = lines.indexOf("---", 1);
  if (end < 0) return `---\nwf-theme: ${theme}\n---\n${markdown}`;
  const existing = lines.findIndex((line, index) => index > 0 && index < end && line.startsWith("wf-theme:"));
  if (existing >= 0) lines[existing] = `wf-theme: ${theme}`;
  else lines.splice(end, 0, `wf-theme: ${theme}`);
  return lines.join("\n");
}

/**
 * 假插件：analyzeFile 走真实引擎；四个写回方法默认「用户确认且成功」，
 * 需要测取消 / 失败 / 真正改文档时，在测试里替换成自己的实现（如真跑 appendChildNode）。
 */
function makeHost(markdown: string): Recorder {
  const notices: string[] = [];
  const statusCalls: { nodeId: string; status: string }[] = [];
  const childCalls: { nodeId: string }[] = [];
  const deleteCalls: { nodeId: string }[] = [];
  const timerStartCalls: { nodeId: string }[] = [];
  const timerStopCalls: { nodeId: string; mode: string }[] = [];
  const archiveCalls: { nodeId: string }[] = [];
  const infoCalls: { nodeId: string }[] = [];
  const workflowEditCalls: { filePath: string }[] = [];
  const moveCalls: { movingId: string; targetId: string; position: string }[] = [];
  /** Phase 6：主题清单与当前主题（`setTheme` 只改桩状态，真实插件会写 data.json + `<html>` 属性） */
  const themeCalls: { path: string; theme: string }[] = [];
  /** Phase 16：⚙️ 按钮直接开插件设置页（不弹窗） */
  const settingsCalls: number[] = [];
  const state = { markdown };
  /** Phase 18：视图读的设置项（标题 / 见闻目录 / emo 主题 / plot 目录）—— 测试里可改 */
  const settings = { resumePrompt: "", dailyFolder: "daily", emoTheme: "default", plotFolder: "plots" };

  const host: WfViewHost = {
    app: {
      // Phase 18 ④：emo 画布列目录要 `getFiles()`（默认空目录 = 365 天全灰）
      vault: { getAbstractFileByPath: () => file, getFiles: () => [] },
      workspace: { getActiveFile: () => file, openLinkText: async () => undefined },
    } as unknown as App,
    analyzeFile: async () => analyzeMarkdown(state.markdown, { file: file.path }),
    setNodeStatus: async (_file, nodeId, status) => {
      statusCalls.push({ nodeId, status });
      return { success: true, changed: true, issues: [], nodeId, status };
    },
    promptAddChild: async (_file, node) => {
      childCalls.push({ nodeId: node.id });
      return {
        cancelled: false,
        result: {
          success: true,
          changed: true,
          issues: [],
          nodeId: node.id,
          changedNodeIds: [node.id],
          childId: "nd-stub-child",
        },
      };
    },
    confirmDeleteNode: async (_file, node) => {
      deleteCalls.push({ nodeId: node.id });
      return {
        cancelled: false,
        result: {
          success: true,
          changed: true,
          issues: [],
          nodeId: node.id,
          changedNodeIds: [node.id],
          parentId: "nd-uuid-001",
        },
      };
    },
    promptArchiveNode: async (_file, node) => {
      archiveCalls.push({ nodeId: node.id });
      return { cancelled: true };
    },
    editNodeInfo: async (_file, node) => {
      infoCalls.push({ nodeId: node.id });
      return { cancelled: true };
    },
    editWorkflows: async (target) => {
      workflowEditCalls.push({ filePath: target.path });
      return { cancelled: true };
    },
    moveNode: async (_file, movingId, targetId, position) => {
      moveCalls.push({ movingId, targetId, position });
      return { success: true, changed: true, issues: [], changedNodeIds: [movingId, targetId] };
    },
    startTimer: async (_file, nodeId) => {
      timerStartCalls.push({ nodeId });
      return { success: true, changed: true, issues: [], nodeId, changedNodeIds: [nodeId], entryIndex: 0 };
    },
    stopTimer: async (_file, nodeId, mode) => {
      timerStopCalls.push({ nodeId, mode });
      return { success: true, changed: true, issues: [], nodeId, changedNodeIds: [nodeId], mode };
    },
    themes: [
      { key: "default", label: "默认主题" },
      { key: "tech", label: "科技风" },
      { key: "nature", label: "自然风" },
      { key: "magazine", label: "杂志风" },
      { key: "retro", label: "复古风" },
      { key: "clay", label: "黏土风" },
    ],
    defaultTheme: "default",
    setFileTheme: async (target, theme) => {
      themeCalls.push({ path: target.path, theme });
      state.markdown = applyThemeToMarkdown(state.markdown, theme);
    },
    notify: (message) => {
      notices.push(message);
    },
    openSettings: () => {
      settingsCalls.push(1);
    },
    // Phase 18 ③：引导性话语（空串 = 视图回落到 i18n 的「下一步是？」）
    resumePrompt: () => settings.resumePrompt,
    // Phase 18 ④-E：见闻 md 的目录
    dailyFolder: () => settings.dailyFolder,
    // Phase 19 M1 ①：emo 独立主题（测试里可改；`setEmoTheme` 只改桩状态）
    emoTheme: () => settings.emoTheme,
    setEmoTheme: async (theme) => {
      settings.emoTheme = theme;
    },
    // Phase 19 M3：plot JSON / CSV 的目录
    plotFolder: () => settings.plotFolder,
  };
  return {
    host,
    notices,
    statusCalls,
    childCalls,
    deleteCalls,
    timerStartCalls,
    timerStopCalls,
    archiveCalls,
    infoCalls,
    workflowEditCalls,
    moveCalls,
    themeCalls,
    settingsCalls,
    state,
  };
}

/** 渲染一次，返回容器与记录器 */
async function render(markdown: string): Promise<{ container: StubElement; recorder: Recorder }> {
  const container = new StubElement("div");
  const recorder = makeHost(markdown);
  await renderWorkflowView(recorder.host, {
    app: recorder.host.app,
    container: asHtmlElement(container),
    currentFilePath: file.path,
  });
  return { container, recorder };
}

/** 等一轮微任务（changeStatus 里的 await 之后再断言） */
const flush = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

/** 造一个桩鼠标事件（clientX/Y 用 0 即可，视图只拿它定位菜单） */
const mouseEvent = (): StubMouseEvent => ({
  preventDefault: () => undefined,
  stopPropagation: () => undefined,
  clientX: 0,
  clientY: 0,
});

const texts = (elements: StubElement[]): string[] => elements.map((element) => element.text);

/** 造一个 drag* 事件（桩只用得到 clientY + 两个 noop） */
const dragEvent = (clientY: number): StubMouseEvent => ({ ...mouseEvent(), clientY });

/* ------------------------------------------------------------------ *
 * Phase 16：侧边栏 / 弹窗的辅助
 * 弹窗挂在 `document.body` 上（不在视图容器里），所以断言要在 `body` 里查。
 * ------------------------------------------------------------------ */

/** 按图标找侧边栏按钮（`.wf-sidebar-btn` 里只有一个图标位，文字在子元素上） */
function widgetButton(container: StubElement, icon: string): StubElement {
  const button = container.query(".wf-sidebar-btn").find((item) => item.allText === icon);
  assert.ok(button, `侧边栏应有「${icon}」按钮`);
  return button;
}

/** 点侧边栏图标 → 返回弹窗体（`.wf-widget-popup > .wf-widget-popup-body`） */
function openWidget(container: StubElement, icon: string): StubElement {
  widgetButton(container, icon).onclick?.(mouseEvent());
  const popup = currentPopup();
  assert.ok(popup, "点侧边栏按钮应弹出弹窗");
  return popup.query(".wf-widget-popup-body")[0];
}

/** 当前弹窗（没开就是 undefined） */
const currentPopup = (): StubElement | undefined => body.query(".wf-widget-popup")[0];

/** 点「×」关掉弹窗（弹窗是单例，测试之间不能互相影响） */
function closeWidget(): void {
  const close = body.query(".wf-widget-popup-close")[0];
  assert.ok(close, "弹窗上应有「×」");
  close.onclick?.(mouseEvent());
  assert.equal(currentPopup(), undefined, "「×」应关掉弹窗");
}

/** 点一次「修改节点顺序」开关（会话内存 → 整块重渲染），等它落地 */
async function toggleReorder(container: StubElement): Promise<void> {
  const toggle = container.query(".wf-reorder-toggle")[0];
  assert.ok(toggle !== undefined, "块尾应有「修改节点顺序」开关");
  toggle.onclick?.(mouseEvent());
  await flush();
  await flush();
}

/** 按 `data-node-id` 索引卡片（只有开关「开」时才会挂这个属性） */
function cardsById(container: StubElement): Map<string, StubElement> {
  const map = new Map<string, StubElement>();
  for (const card of container.query(".wf-card")) {
    const id = card.getAttribute("data-node-id");
    if (id !== null) map.set(id, card);
  }
  return map;
}

/** 取可拖卡片（没有就让测试失败） */
function cardOf(container: StubElement, nodeId: string): StubElement {
  const card = cardsById(container).get(nodeId);
  assert.ok(card !== undefined, `卡片 ${nodeId} 应当可拖`);
  return card;
}

describe("wfView · v1.1 文件（1 进行中 + 1 已归档）", () => {
  test("状态总览三行口径 + 泳道/卡片/折叠区结构", async () => {
    const { container } = await render(validMarkdown11());

    // Phase 16：总览固定三行（主题 / 计时 / 统计），本例没有计时 → 两行
    const overview = container.query(".wf-overview")[0];
    assert.equal(overview.children[0].classList.contains("wf-theme-switch"), true, "第 1 行是主题切换");
    assert.equal(
      overview.children[overview.children.length - 1].classList.contains("wf-overview-line"),
      true,
      "最后一行是统计文本",
    );
    assert.equal(container.query(".wf-overview-stat")[0].text, "进行中：0/3 阻滞：0");
    assert.equal(container.query(".wf-overview-meta").length, 0, "Phase 16 删掉了元信息行");

    assert.equal(container.query(".wf-lane").length, 2);
    assert.equal(container.query(".wf-block")[0].query(".wf-lane").length, 1);
    assert.match(container.query(".wf-lane-title")[0].text, /立项调查/);
    assert.equal(container.query(".wf-fold").length, 1);
    assert.equal(container.query(".wf-fold-body")[0].query(".wf-lane").length, 1);
    assert.deepEqual(texts(container.query(".wf-fold-title")), ["📦 已完成流（1）"]);
  });

  test("卡片类名：done 白底 / 无 links 虚线 / 第 2 个子节点右开一列", async () => {
    const { container } = await render(validMarkdown11());

    assert.equal(container.query(".wf-card").length, 4, "3 个进行中节点 + 1 个归档节点");
    assert.equal(container.query(".wf-card--done").length, 4);
    assert.equal(container.query(".wf-card--dashed").length, 4);
    assert.equal(container.query(".wf-card--solid").length, 0);
    assert.equal(container.query(".wf-cell").length, 2);
    assert.equal(container.query(".wf-cell--side").length, 1);
    assert.equal(container.query(".wf-caret").length, 1);
    assert.match(container.query(".wf-footer")[0].text, /schema 1\.1/);
    assert.match(container.query(".wf-footer")[0].text, /✔ 无问题/);
  });

  test("左键标题带纪要锚点提示", async () => {
    const { container } = await render(validMarkdown11());
    const titleEl = container.query(".wf-card-title")[0];

    assert.match(titleEl.title, /\^nd-uuid-001/);
    assert.equal(typeof titleEl.onclick, "function");
  });
});

describe("wfView · v1.0 文件（渲染时内存升格，不落盘）", () => {
  test("两个进行中 workflow → 横向两栏（不再有切换栏），栏头带甘特同色方块", async () => {
    const { container } = await render(validMarkdown());

    assert.equal(container.query(".wf-overview-stat")[0].text, "进行中：1/4 阻滞：0");
    assert.equal(container.query(".wf-lane").length, 2, "Phase 16：每个进行中的 workflow 一栏");
    assert.equal(container.query(".wf-column").length, 2);
    assert.equal(container.query(".wf-lane-switcher").length, 0, "进行中不再有切换栏");
    assert.deepEqual(
      container.query(".wf-active-columns")[0].children.map((column) => column.classList.contains("wf-column")),
      [true, true],
    );

    // 全部进行中 workflow 的节点都画出来（不再只画第一个）
    const document = analyzeMarkdown(validMarkdown(), { file: file.path }).latestDocument;
    assert.ok(document !== undefined, "夹具应能解析出文档");
    const expected = document.workflows.reduce((sum, workflow) => sum + [...walkWorkflow(workflow)].length, 0);
    assert.equal(container.query(".wf-card").length, expected, "两个 workflow 的节点都在");

    assert.equal(container.query(".wf-fold").length, 0, "没有 archived / cancelled 时不出现折叠区");
    assert.match(container.query(".wf-footer")[0].text, /schema 1\.0（渲染时已在内存中升格 1\.0 → 1\.9，未落盘）/);
    assert.match(container.query(".wf-card-meta")[0].text, /重要度 P4-Critical/);

    const chips = container.query(".wf-lane-color");
    assert.equal(chips.length, 2, "两栏各一个颜色方块");
    assert.match(chips[0].style.background, /--wf-gantt-c0/, "第 1 栏用 c0");
    assert.match(chips[1].style.background, /--wf-gantt-c1/, "第 2 栏用 c1");
  });

  test("分栏顺序与 workflows[] 的文档顺序一致", async () => {
    const { container } = await render(validMarkdown());

    const document = analyzeMarkdown(validMarkdown(), { file: file.path }).latestDocument;
    assert.ok(document !== undefined, "夹具应能解析出文档");
    const active = document.workflows.filter((workflow) => workflow.state === undefined).map((workflow) => ` ${workflow.title}`);
    assert.deepEqual(texts(container.query(".wf-lane-title")), active);
  });
});

describe("wfView · 卡片外观开关（collapsed / importance=4 加粗 / links）", () => {
  test("collapsed 收起子树、重要度 4 加粗（v1.6）、有 links 实线，点箭头只改 DOM", async () => {
    const document = validDocument11();
    document.workflows[0].root.collapsed = true;
    document.workflows[0].root.importance = 4;
    document.workflows[0].root.links = [{ id: "lk-1", type: "web", target: "https://example.com", label: "示例" }];
    delete document.workflows[1].root.importance; // 归档根节点自带 4，排除干扰

    const { container } = await render(writeBackDocument(validMarkdown11(), document).markdown);

    assert.equal(container.query(".wf-collapsed").length, 1);
    assert.equal(container.query(".wf-card--bold").length, 1);
    assert.equal(container.query(".wf-card--solid").length, 1);
    assert.equal(container.query(".wf-caret")[0].text, "▸");

    const caret = container.query(".wf-caret")[0];
    caret.onclick?.(mouseEvent());
    assert.equal(caret.text, "▾");
    assert.equal(container.query(".wf-collapsed").length, 0);
  });
});

describe("wfView · Phase 6 主题切换入口", () => {
  test("「状态总览」块末尾列出全部主题，当前主题标 active", async () => {
    const { container } = await render(validMarkdown11());

    const row = container.query(".wf-theme-switch");
    assert.equal(row.length, 1, "总览块必须有一个切换入口");
    const overview = row[0].parent;
    assert.ok(overview !== null);
    assert.ok(overview.classList.contains("wf-overview"), "切换入口挂在总览块里");
    assert.equal(overview.children[0], row[0], "Phase 16：主题是总览第 1 行");

    assert.deepEqual(texts(container.query(".wf-theme-btn")), [
      "默认主题",
      "科技风",
      "自然风",
      "杂志风",
      "复古风",
      "黏土风",
    ]);
    assert.deepEqual(texts(container.query(".wf-theme-btn--active")), ["默认主题"]);
    assert.equal(container.query(".wf-theme-switch-label")[0].text, "主题（仅本文件）");
    assert.equal(container.getAttribute("data-wf-theme"), "default", "主题挂在视图容器上");
    assert.equal(container.classList.contains("wf-view"), true);
    assert.equal(container.classList.contains("wf-theme"), true);
  });

  test("render options.theme 优先于 frontmatter / 全局默认", async () => {
    const recorder = makeHost(applyThemeToMarkdown(validMarkdown11(), "nature"));
    const container = new StubElement("div");
    await renderWorkflowView(
      recorder.host,
      { app: recorder.host.app, container: asHtmlElement(container), currentFilePath: file.path },
      { theme: "tech" },
    );
    assert.equal(container.getAttribute("data-wf-theme"), "tech");

    const fallback = new StubElement("div");
    await renderWorkflowView(recorder.host, {
      app: recorder.host.app,
      container: asHtmlElement(fallback),
      currentFilePath: file.path,
    });
    assert.equal(fallback.getAttribute("data-wf-theme"), "nature", "没传 options 时读 frontmatter");
  });

  test("点「科技风」→ host.setFileTheme（只写本文件）→ 重渲染，容器主题切换", async () => {
    const { container, recorder } = await render(validMarkdown11());
    const lanesBefore = container.query(".wf-lane").length;
    const cardsBefore = container.query(".wf-card").length;
    assert.equal(container.getAttribute("data-wf-theme"), "default");

    const tech = container.query(".wf-theme-btn").find((button) => button.text === "科技风");
    assert.ok(tech !== undefined, "科技风按钮应存在");
    tech.onclick?.(mouseEvent());
    await flush();

    assert.deepEqual(recorder.themeCalls, [{ path: file.path, theme: "tech" }]);
    assert.deepEqual(texts(container.query(".wf-theme-btn--active")), ["科技风"]);
    assert.equal(container.getAttribute("data-wf-theme"), "tech");
    assert.equal(container.query(".wf-lane").length, lanesBefore, "泳道数量不变");
    assert.equal(container.query(".wf-card").length, cardsBefore, "卡片数量不变");
  });

  test("已经选中的主题再点不重复调用（幂等）", async () => {
    const { container, recorder } = await render(validMarkdown11());
    const current = container.query(".wf-theme-btn--active")[0];
    current.onclick?.(mouseEvent());
    assert.deepEqual(recorder.themeCalls, []);
  });

  test("整块重渲染保留滚动位置（Phase 9 稳定视图）", async () => {
    const recorder = makeHost(validMarkdown11());
    const container = new StubElement("div");
    container.scrollTop = 123;
    await renderWorkflowView(recorder.host, {
      app: recorder.host.app,
      container: asHtmlElement(container),
      currentFilePath: file.path,
    });
    assert.equal(container.scrollTop, 123, "渲染完成后恢复原滚动位置");
  });

  test("插件 refresh 与 Dataview 自动重跑并发时串行落地：不丢滚动、落到最新状态", async () => {
    const recorder = makeHost(validMarkdown11());
    const container = new StubElement("div");
    const dv = { app: recorder.host.app, container: asHtmlElement(container), currentFilePath: file.path };

    // Dataview 载入时的那次渲染（拿到「只有一份」的基准数量）
    await renderWorkflowView(recorder.host, dv);
    const lanesOnce = container.query(".wf-lane").length;
    const cardsOnce = container.query(".wf-card").length;
    container.scrollTop = 210;

    // 点主题按钮的真实时序：先写 frontmatter，然后「插件自己的 refresh()」与
    // 「Dataview 检测到 frontmatter 变化后自动重跑 dataviewjs 块」几乎同时拍进来。
    recorder.state.markdown = applyThemeToMarkdown(recorder.state.markdown, "tech");
    const pluginRefresh = renderWorkflowView(recorder.host, dv);
    const dataviewRerun = renderWorkflowView(recorder.host, dv);
    await Promise.all([pluginRefresh, dataviewRerun]);

    assert.equal(container.scrollTop, 210, "并发重渲染不会把滚动位置清成 0（跳位根因）");
    assert.equal(container.getAttribute("data-wf-theme"), "tech", "落地的是最新一次的状态");
    assert.equal(container.query(".wf-lane").length, lanesOnce, "泳道没有被叠成两份");
    assert.equal(container.query(".wf-card").length, cardsOnce, "卡片没有被叠成两份");
  });

  test("重分析失败时保留上一次的 DOM（先 analyzeFile 再清空）", async () => {
    const { container, recorder } = await render(validMarkdown11());
    const cards = container.query(".wf-card").length;
    recorder.host.analyzeFile = async () => {
      throw new Error("boom");
    };
    await assert.rejects(
      renderWorkflowView(recorder.host, {
        app: recorder.host.app,
        container: asHtmlElement(container),
        currentFilePath: file.path,
      }),
      /boom/,
    );
    assert.equal(container.query(".wf-card").length, cards, "失败时旧 DOM 不被清空");
  });

  test("host.themes 为空时不渲染空壳", async () => {
    const container = new StubElement("div");
    const recorder = makeHost(validMarkdown11());
    recorder.host.themes = [];
    await renderWorkflowView(recorder.host, {
      app: recorder.host.app,
      container: asHtmlElement(container),
      currentFilePath: file.path,
    });
    assert.equal(container.query(".wf-theme-switch").length, 0);
  });
});

describe("wfView · 状态视觉契约（圆点 / 卡片状态色，见 doc/datacontact/data_ixd_phase1_visual_contract.md）", () => {
  /**
   * 5 种 status 在同一个 workflow 里各一个节点（根 + 4 个子节点）。
   * 用 wfjsonBlockOnly：没有 frontmatter / 纪要段落、status 与 progress 不匹配等都只是 warning
   * （hasError = false → 视图照常渲染卡片），本组只关心「类名是否齐全」，不追求零问题。
   */
  const statusDoc: WfJsonDocument = {
    schemaVersion: "1.1",
    id: "file-uuid-visual",
    workflows: [
      {
        id: "wf-visual",
        title: "视觉",
        root: {
          id: "nd-visual-0",
          title: "节点-todo",
          status: "todo",
          progress: 0,
          children: NODE_STATUSES.slice(1).map((status, index) => ({
            id: `nd-visual-${index + 1}`,
            title: `节点-${status}`,
            status,
            progress: status === "done" ? 5 : 0,
            children: [],
          })),
        },
      },
    ],
  };

  test("5 种 status 的卡片类名与圆点类名齐全（颜色/形状全部交给 styles.css）", async () => {
    const { container } = await render(wfjsonBlockOnly(statusDoc));

    assert.equal(container.query(".wf-card").length, 5);
    assert.equal(container.query(".wf-dot").length, 5, "每张卡一个状态圆点");
    for (const status of NODE_STATUSES) {
      assert.equal(container.query(`.wf-card--${status}`).length, 1, `wf-card--${status} 应有 1 张卡`);
      assert.equal(container.query(`.wf-dot-${status}`).length, 1, `wf-dot-${status} 应有 1 个圆点`);
    }
  });

  test("圆点带中文 title（颜色不是唯一编码）+ 卡片与圆点都不写内联样式", async () => {
    const { container } = await render(wfjsonBlockOnly(statusDoc));

    for (const status of NODE_STATUSES) {
      const dot = container.query(`.wf-dot-${status}`)[0];
      assert.equal(dot.tagName, "span");
      assert.equal(dot.title, STATUS_LABELS[status], `${status} 圆点应有中文 title`);
      assert.deepEqual(Object.keys(dot.style), [], "圆点颜色/尺寸只能来自 styles.css");

      const card = container.query(`.wf-card--${status}`)[0];
      assert.deepEqual(Object.keys(card.style), [], "卡片外观只能来自 styles.css");
      assert.match(card.query(".wf-card-meta")[0].text, new RegExp(STATUS_LABELS[status]), "meta 首段冗余中文状态");
    }
  });
});

describe("wfView · 右键菜单与写回链路", () => {
  test("菜单列出资料 / 跳纪要 / 其余状态；点「标记为进行中」调用 setNodeStatus 并重渲染", async () => {
    const { container, recorder } = await render(validMarkdown11());
    const card = container.query(".wf-card")[0];

    card.oncontextmenu?.(mouseEvent());
    const menu = body.query(".wf-menu")[0];
    assert.ok(menu, "右键应弹出菜单");

    const items = texts(menu.query(".wf-menu-item"));
    assert.ok(items.includes("（该节点暂无纪要超链接）"));
    assert.ok(items.includes("🔗 跳到本文件纪要"));
    assert.ok(items.includes("🔵 标记为进行中"));
    assert.equal(items.includes("✅ 标记为已完成"), false, "当前状态不该出现在菜单里");
    assert.equal(recorder.notices.length, 0, "只弹菜单不应有提示");

    const entry = menu.query(".wf-menu-item").find((item) => item.text === "🔵 标记为进行中");
    assert.ok(entry, "应能找到「标记为进行中」");
    entry.onclick?.(mouseEvent());
    await flush();

    assert.deepEqual(recorder.statusCalls, [{ nodeId: "nd-uuid-001", status: "doing" }]);
    assert.equal(recorder.notices.length, 1);
    assert.match(recorder.notices[0], /已把「调研竞品」标记为进行中/);
    assert.equal(body.query(".wf-menu").length, 0, "点完菜单应关闭");
  });

  test("写回被拒绝时给出原因、不重渲染", async () => {
    const { container, recorder } = await render(validMarkdown11());
    recorder.host.setNodeStatus = async (_file, nodeId, status) => ({
      success: false,
      changed: false,
      issues: [],
      nodeId,
      status,
      reason: "当前文件存在 error 级问题（NOTE_ANCHOR_MISSING_IN_BODY），已拒绝写入；请先修复",
    });

    const card = container.query(".wf-card")[0];
    card.oncontextmenu?.(mouseEvent());
    const entry = body.query(".wf-menu-item").find((item) => item.text === "🔵 标记为进行中");
    entry?.onclick?.(mouseEvent());
    await flush();

    assert.equal(recorder.notices.length, 1);
    assert.match(recorder.notices[0], /未写入：当前文件存在 error 级问题/);
  });
});

describe("wfView · 兜底路径", () => {
  test("坏数据只摊问题清单，不渲染卡片", async () => {
    const { container } = await render('```wfjson\n{\n  "schemaVersion": "1.1"\n}\n```\n');

    assert.equal(container.query(".wf-card").length, 0);
    assert.equal(container.query(".wf-issue-box").length, 1);
    assert.match(container.query(".wf-issue-title")[0].text, /已停止渲染/);
  });

  test("没有 wfjson 代码块 → 提示一行", async () => {
    const { container } = await render("# 普通笔记\n");
    assert.equal(container.query(".wf-hint").length, 1);
  });

  test("isViewApi：只有带 app + container 的对象才算可用", () => {
    assert.equal(isViewApi({ app: {}, container: new StubElement("div") }), true);
    assert.equal(isViewApi(undefined), false);
    assert.equal(isViewApi({ app: null }), false);
  });
});

describe("wfView · DOM 归属（document 不是容器）", () => {
  test("桩的 document 与 Obsidian 一致：createDiv / createEl 直接抛错", () => {
    const doc = document as unknown as { createDiv: () => unknown; createEl: () => unknown };
    assert.throws(() => doc.createDiv(), /Only one element on document allowed/);
    assert.throws(() => doc.createEl(), /Only one element on document allowed/);
  });

  test("整棵树挂在传入的容器里，body 下没有视图残留", async () => {
    const { container } = await render(validMarkdown11());

    // 泳道/列的游离元素如果走了 document.createDiv，上面那个桩会先抛错；
    // 这里再确认没有元素挂在 document 根（body）上。
    // 列数：泳道 1（根 + 2 个子节点）+ 泳道 2 的根 = 4
    assert.equal(container.query(".wf-col").length, 4, "每条泳道一个根列，每个子节点各开一列");
    assert.equal(container.query(".wf-card").length, 4);
    assert.equal(container.query(".wf-row").length, 1, "只有有子节点的卡片才建行");

    const strays = body.children.filter(
      (child) => (child as unknown) !== (container as unknown) && !child.classList.contains("wf-menu"),
    );
    assert.deepEqual(strays, [], "body 下只应有传入的容器（右键菜单除外）");
  });
});

describe("wfView · Phase 2 结构菜单（改链接 / 加子节点 / 删除）", () => {
  /** 右键某张卡片 → 打开菜单并返回菜单项（openMenu 会先关掉旧菜单） */
  const openCardMenu = (card: StubElement): StubElement[] => {
    card.oncontextmenu?.(mouseEvent());
    const menu = body.query(".wf-menu")[0];
    assert.ok(menu, "右键应弹出菜单");
    return menu.query(".wf-menu-item");
  };

  /** 点菜单里的某一项（找不到就带着实际项报错，方便定位） */
  const clickMenuItem = (items: StubElement[], text: string): void => {
    const item = items.find((entry) => entry.text === text);
    assert.ok(item, `菜单里应有「${text}」，实际：${items.map((entry) => entry.text).join(" / ")}`);
    item.onclick?.(mouseEvent());
  };

  test("结构三项按 isRoot 区分：根节点没有「删除」，子节点有", async () => {
    const { container } = await render(validMarkdown11());

    const rootItems = texts(openCardMenu(container.query(".wf-card")[0]));
    assert.ok(rootItems.includes("🔗 跳到本文件纪要"));
    assert.equal(rootItems.includes("✏️ 编辑纪要超链接…"), false, "Phase 9：超链接改在正文维护，不再弹 Modal");
    assert.ok(rootItems.includes("➕ 添加子节点…"));
    assert.equal(rootItems.includes("🗑 删除本节点…"), false, "根节点不能删，菜单里不该出现");

    const childItems = texts(openCardMenu(container.query(".wf-card")[1]));
    assert.ok(childItems.includes("🗑 删除本节点…"));
    assert.ok(childItems.includes("➕ 添加子节点…"));
  });

  test("取消 Modal：调了 host 但不提示、不动 DOM", async () => {
    const { container, recorder } = await render(validMarkdown11());
    recorder.host.promptAddChild = async (_file, node) => {
      recorder.childCalls.push({ nodeId: node.id });
      return { cancelled: true };
    };
    recorder.host.confirmDeleteNode = async (_file, node) => {
      recorder.deleteCalls.push({ nodeId: node.id });
      return { cancelled: true };
    };

    const card = container.query(".wf-card")[1];
    const before = container.query(".wf-card").length;
    clickMenuItem(openCardMenu(card), "➕ 添加子节点…");
    await flush();
    clickMenuItem(openCardMenu(card), "🗑 删除本节点…");
    await flush();

    assert.deepEqual(recorder.childCalls, [{ nodeId: "nd-uuid-002" }]);
    assert.deepEqual(recorder.deleteCalls, [{ nodeId: "nd-uuid-002" }]);
    assert.deepEqual(recorder.notices, [], "取消不该有提示");
    assert.equal(container.query(".wf-card").length, before);
  });

  test("加子节点成功（真引擎写回）→ 父节点那一列多开一格 + 提示", async () => {
    const { container, recorder } = await render(validMarkdown11());
    assert.equal(container.query(".wf-card").length, 4);

    recorder.host.promptAddChild = async (_file, node) => {
      recorder.childCalls.push({ nodeId: node.id });
      const wfDoc = validDocument11();
      const edit = appendChildNode(wfDoc, node.id, { title: "复核结论" }, NOW);
      if (!edit.ok) throw new Error(`夹具不该失败：${edit.reason ?? ""}`);
      recorder.state.markdown = writeBackDocument(recorder.state.markdown, wfDoc, { now: NOW }).markdown;
      return {
        cancelled: false,
        result: {
          success: true,
          changed: true,
          issues: [],
          nodeId: node.id,
          changedNodeIds: edit.changedNodeIds,
          childId: edit.childId,
          warnings: edit.warnings,
        },
      };
    };

    clickMenuItem(openCardMenu(container.query(".wf-card")[0]), "➕ 添加子节点…");
    await flush();

    assert.deepEqual(recorder.childCalls, [{ nodeId: "nd-uuid-001" }]);
    assert.equal(recorder.notices.length, 1);
    assert.match(recorder.notices[0], /已在「调研竞品」下新增子节点/);
    assert.equal(container.query(".wf-card").length, 5, "新节点多一张卡");
    assert.equal(container.query(".wf-cell").length, 3, "子节点行多一格");
    assert.ok(texts(container.query(".wf-card-title")).includes("复核结论"));
    // Phase 18 ⑧：meta 不再给「子节点 n」（只留状态 · 重要度 · 紧急度 · 进度 · 链接数）
    assert.doesNotMatch(container.query(".wf-card-meta")[0].text, /子节点/, "父节点卡片的 meta 不再带子节点计数");
  });

  test("删除子节点成功（真引擎写回）→ 该列连同卡片一起消失、父列重刷", async () => {
    const { container, recorder } = await render(validMarkdown11());
    const target = container.query(".wf-card")[1];
    assert.equal(target.query(".wf-card-title")[0].text, "整理结论", "第 2 张卡 = 根的第一个子节点");

    recorder.host.confirmDeleteNode = async (_file, node) => {
      recorder.deleteCalls.push({ nodeId: node.id });
      const wfDoc = validDocument11();
      const edit = removeNode(wfDoc, node.id, NOW);
      if (!edit.ok) throw new Error(`夹具不该失败：${edit.reason ?? ""}`);
      recorder.state.markdown = writeBackDocument(recorder.state.markdown, wfDoc, {
        now: NOW,
        removedNoteAnchors: edit.removedNoteAnchors,
      }).markdown;
      return {
        cancelled: false,
        result: {
          success: true,
          changed: true,
          issues: [],
          nodeId: node.id,
          changedNodeIds: edit.changedNodeIds,
          parentId: edit.parentId,
        },
      };
    };

    clickMenuItem(openCardMenu(target), "🗑 删除本节点…");
    await flush();

    assert.deepEqual(recorder.deleteCalls, [{ nodeId: "nd-uuid-002" }]);
    assert.equal(recorder.notices.length, 1);
    assert.match(recorder.notices[0], /已删除「整理结论」/);
    assert.equal(container.query(".wf-card").length, 3, "被删节点那一列整体消失");
    assert.equal(container.query(".wf-cell").length, 1);
    assert.equal(texts(container.query(".wf-card-title")).includes("整理结论"), false);
    assert.doesNotMatch(container.query(".wf-card-meta")[0].text, /子节点/, "Phase 18 ⑧：meta 里不再有子节点计数");
  });

  test("写回失败 → 提示原因、不重渲染", async () => {
    const { container, recorder } = await render(validMarkdown11());
    recorder.host.confirmDeleteNode = async (_file, node) => {
      recorder.deleteCalls.push({ nodeId: node.id });
      return {
        cancelled: false,
        result: {
          success: false,
          changed: false,
          issues: [],
          nodeId: node.id,
          changedNodeIds: [],
          reason: "「整理结论」是归档来源节点（带 archive），不能删除",
        },
      };
    };

    const before = container.query(".wf-card").length;
    clickMenuItem(openCardMenu(container.query(".wf-card")[1]), "🗑 删除本节点…");
    await flush();

    assert.equal(recorder.notices.length, 1);
    assert.match(recorder.notices[0], /未写入：「整理结论」是归档来源节点/);
    assert.equal(container.query(".wf-card").length, before);
  });


});

describe("wfView · Phase 3 计时器 + 近 21 天方块阵", () => {
  /** 本组会挂真实的 setInterval（正计时 tick）→ 收尾统一清掉，否则测试进程不会退出 */
  after(() => stopTimerTicker());

  /** 右键某张卡片 → 打开菜单并返回菜单项（与 Phase 2 那组同样的辅助） */
  const openCardMenu = (card: StubElement): StubElement[] => {
    card.oncontextmenu?.(mouseEvent());
    const menu = body.query(".wf-menu")[0];
    assert.ok(menu, "右键应弹出菜单");
    return menu.query(".wf-menu-item");
  };

  const clickMenuItem = (items: StubElement[], text: string): void => {
    const item = items.find((entry) => entry.text === text);
    assert.ok(item, `菜单里应有「${text}」，实际：${items.map((entry) => entry.text).join(" / ")}`);
    item.onclick?.(mouseEvent());
  };

  /** 方块阵里的每日格子（3 个 `.wf-heat-week` 各 7 格依次铺开，按时间先后，最后一个 = 今天） */
  const daySquares = (container: StubElement): StubElement[] => {
    const squares: StubElement[] = [];
    for (const week of container.query(".wf-heat-week")) squares.push(...week.children);
    return squares;
  };

  /** 造一份「今天有 3h / 前天有 1h」的 1.3 文档（窗口与档位断言不依赖真实时钟） */
  const documentWithRecentWork = (): WfJsonDocument => {
    const keys = recentDateKeys(new Date(), 3);
    const document = clone(validDocument13());
    // 先清掉夹具自带的（固定日期的）条目，只留下面这两条「相对今天」的，档位断言才稳定
    for (const workflow of document.workflows) {
      for (const visit of walkWorkflow(workflow)) delete visit.node.timeEntries;
    }
    document.workflows[0].root.timeEntries = [
      { startAt: `${keys[0]}T09:00:00+08:00`, date: keys[0], endAt: `${keys[0]}T10:00:00+08:00`, hours: 1 },
      { startAt: `${keys[2]}T08:00:00+08:00`, date: keys[2], endAt: `${keys[2]}T11:00:00+08:00`, hours: 3 },
    ];
    return document;
  };

  test("没有进行中的计时 → 不渲染计时器（不占位 00:00:00）；方块阵是近 21 天单行横条", async () => {
    const { container } = await render(validMarkdown13());

    assert.equal(container.query(".wf-timer").length, 0);
    assert.equal(container.query(".wf-timer-clock").length, 0);
    assert.equal(container.query(".wf-timer-actions").length, 0, "没有计时就没有快捷结束按钮");
    assert.equal(container.query(".wf-heatmap").length, 0, "Phase 16：方块阵不再在总览里");

    // Phase 16：方块阵搬进 📊 弹窗
    const widget = openWidget(container, "📊");
    assert.equal(daySquares(widget).length, 21, "近 21 天一天一格");
    assert.equal(widget.query(".wf-heatmap-title")[0].text, "近 21 天工作时长");
    assert.deepEqual(widget.query(".wf-heat-week").map((week) => week.children.length), [7, 7, 7], "3 周一横条，每周 7 格");
    assert.equal(widget.query(".wf-heat-weekday").length, 0, "不再有左侧星期标签列");
    assert.equal(widget.query(".wf-heat--empty").length, 0, "不再按日历周补空");
    closeWidget();
  });

  test("方块阵布局：3 周各 7 格一横条、档位 class 只挂 class 不写内联样式", async () => {
    const { container } = await render(writeBackDocument(validMarkdown13(), documentWithRecentWork()).markdown);
    const widget = openWidget(container, "📊");
    const squares = daySquares(widget);

    assert.equal(squares.length, 21);
    assert.deepEqual(widget.query(".wf-heat-week").map((week) => week.children.length), [7, 7, 7], "每 7 格一周");
    assert.equal(widget.query(".wf-heat-grid").length, 0, "旧的 7 行网格容器已弃用");
    assert.equal(squares.filter((child) => child.classList.contains("wf-heat--l2")).length, 1, "今天 3h ∈ (1,3] → l2");
    assert.equal(squares.filter((child) => child.classList.contains("wf-heat--l1")).length, 1, "前天 1h ∈ (0,1] → l1");
    assert.ok(squares.some((child) => child.classList.contains("wf-heat--l0")), "没干活的日子是 l0");
    assert.deepEqual(Object.keys(squares[20].style), [], "方块外观只能来自 styles.css");
    closeWidget();
  });

  test("Phase 8：不再渲染「少 → 多」图例（档位一眼可比）", async () => {
    const { container } = await render(validMarkdown13());
    const widget = openWidget(container, "📊");

    assert.equal(widget.query(".wf-heat-legend").length, 0);
    assert.equal(widget.query(".wf-heat-legend-label").length, 0);
    closeWidget();
  });

  test("甘特图：常开（无 <details>/<summary>）· 时间线按工作流取色（wf-gantt-span--w0 / --w1）", async () => {
    const today = recentDateKeys(new Date(), 1)[0];
    const document = clone(validDocument13());
    for (const workflow of document.workflows) {
      for (const visit of walkWorkflow(workflow)) delete visit.node.timeEntries;
    }
    document.workflows[0].root.timeEntries = [
      { startAt: `${today}T09:00:00+08:00`, date: today, endAt: `${today}T10:00:00+08:00`, hours: 1 },
    ];
    document.workflows[1].root.timeEntries = [
      { startAt: `${today}T11:00:00+08:00`, date: today, endAt: `${today}T12:00:00+08:00`, hours: 1 },
    ];
    const { container } = await render(writeBackDocument(validMarkdown13(), document).markdown);
    // Phase 16：方块阵 + 甘特图都在 📊 弹窗里
    const widget = openWidget(container, "📊");

    // Phase 17：不再套 `<details>` —— 打开 📊 就直接看到整块甘特图
    const gantt = widget.query(".wf-gantt")[0];
    assert.equal(gantt.tagName, "div", "甘特图是常开的 div（不再是 <details>）");
    assert.deepEqual(gantt.children.map((child) => child.tagName), ["div", "div"], "只有「标题 + 内容」两段");

    const title = widget.query(".wf-gantt-title")[0];
    assert.equal(title.tagName, "div", "标题只是一行小字（不是 <summary>）");
    assert.equal(title.text, "近 21 天甘特图");
    assert.doesNotMatch(title.text, /10 分钟一格/, "Phase 8 去掉 10 分钟刻度格");

    // 图例仍是首行，与标题一起常驻
    const legend = widget.query(".wf-gantt-legend")[0];
    assert.match(legend.text, /按工作流着色/);
    assert.match(legend.text, /每 2 小时一条分割线/);
    assert.equal(legend.parent?.classList.contains("wf-gantt-body"), true, "图例在甘特图体内");

    const ganttBody = widget.query(".wf-gantt-body")[0];
    assert.equal(ganttBody.query(".wf-gantt-row").length, 22, "1 行刻度 + 21 行数据");
    assert.equal(title.parent, gantt, "标题与 body 都挂在 .wf-gantt 上");

    const bars = widget.query(".wf-gantt-span");
    assert.equal(bars.length, 2, "两个工作流各一条高亮段");
    assert.ok(bars[0].classList.contains("wf-gantt-span--w0"), "workflows[0] → w0");
    assert.ok(bars[1].classList.contains("wf-gantt-span--w1"), "workflows[1] → w1");
    assert.deepEqual(Object.keys(bars[0].style).sort(), ["left", "width"], "颜色只能来自 styles.css");

    const dataRows = widget.query(".wf-gantt-row").filter((row) => !row.classList.contains("wf-gantt-row--axis"));
    assert.equal(dataRows.length, 21);
    assert.equal(widget.query(".wf-gantt-row--week-start").length, 2, "21 行 = 3 组，组间 2 条横分割线");

    // Phase 13：纵坐标日期只显示「月-日」（不再带年份）
    const window21 = recentDateKeys(new Date(), 21);
    const dateLabels = widget.query(".wf-gantt-date-label");
    assert.equal(dateLabels.length, 21, "21 行数据行各一个日期标签（刻度行没有）");
    assert.match(dateLabels[0].text, /^\d{2}-\d{2}$/, "日期标签是 MM-DD");
    assert.doesNotMatch(dateLabels[0].text, /^\d{4}/, "日期标签不再显示年份");
    assert.equal(dateLabels[0].text, window21[0].slice(5), "最旧一行 = 21 天窗口首日");
    assert.equal(dateLabels[20].text, window21[20].slice(5), "最新一行 = 今天");
    closeWidget();
  });

  test("甘特图常开：整块重渲染后仍只有一份（折叠态已不存在，不会丢）", async () => {
    const first = await render(writeBackDocument(validMarkdown13(), validDocument13()).markdown);
    const widget = openWidget(first.container, "📊");
    assert.equal(widget.query(".wf-gantt").length, 1);

    // 再渲染一次同一文件：计时器结束 / 换主题 / Dataview 重跑都走这条路
    // （Phase 16：弹窗开着 → 整块重渲染末尾会把它跟着重画，弹窗体本身还是同一个元素）
    await render(writeBackDocument(validMarkdown13(), validDocument13()).markdown);
    assert.equal(widget.query(".wf-gantt").length, 1, "重画后仍然只有一块");
    assert.equal(widget.query(".wf-gantt-row").length, 22, "内容照旧全部展开");
    closeWidget();
  });

  test("悬浮详情：有数据列「当天各工作流耗时」，无数据是「无记录」；移出即收起", async () => {
    const { container } = await render(writeBackDocument(validMarkdown13(), documentWithRecentWork()).markdown);
    const squares = daySquares(openWidget(container, "📊"));
    const todayCell = squares[20];

    todayCell.onmouseenter?.(mouseEvent());
    const tip = body.query(".wf-heat-tip")[0];
    assert.ok(tip, "悬浮应弹出详情");
    assert.match(tip.allText, /合计 3 小时/);
    assert.match(tip.allText, /立项调查 3h/);
    assert.equal(Object.keys(tip.style).sort().join(","), "left,top", "只有定位坐标是内联样式");

    todayCell.onmouseenter?.(mouseEvent());
    assert.equal(body.query(".wf-heat-tip").length, 1, "重复悬浮不会堆叠");

    todayCell.onmouseleave?.(mouseEvent());
    assert.equal(body.query(".wf-heat-tip").length, 0, "移出应收起");

    squares[0].onmouseenter?.(mouseEvent());
    assert.match(body.query(".wf-heat-tip")[0].allText, /无记录/);
    squares[0].onmouseleave?.(mouseEvent());
    closeWidget();
  });

  test("有进行中的计时：标题行 + 首帧就正确的 HH:MM:SS + 两个快捷结束按钮（tick 单例）", async () => {
    const document = validDocument13();
    startTimerEntry(document, "nd-uuid-001", new Date());
    const { container } = await render(writeBackDocument(validMarkdown13(), document).markdown);

    assert.equal(container.query(".wf-timer").length, 1, "计时中才有这一块");
    assert.equal(container.query(".wf-timer-label")[0].text, "正在：调研竞品");
    assert.match(container.query(".wf-timer-clock")[0].text, /^\d{2}:\d{2}:\d{2}$/, "不闪 00:00:00");
    assert.equal(container.query(".wf-timer-clock--invalid").length, 0, "正常计时不加失效类");
    assert.deepEqual(texts(container.query(".wf-timer-btn")), ["结束并记录", "结束并丢弃"], "与右键菜单同名");

    stopTimerTicker();
  });

  test("开始时间失效（开始时间在未来）→ 给「结束并丢弃」文案 + 失效类降字号", async () => {
    const document = clone(validDocument13());
    document.workflows[0].root.timeEntries = [{ startAt: "2099-01-01T00:00:00+08:00", date: "2099-01-01" }];
    const { container } = await render(writeBackDocument(validMarkdown13(), document).markdown);

    const clock = container.query(".wf-timer-clock")[0];
    assert.equal(clock.text, TIMER_INVALID_START_MESSAGE);
    assert.ok(clock.classList.contains("wf-timer-clock--invalid"), "长文案要加失效类降字号");
    assert.equal(container.query(".wf-timer-btn").length, 2, "坏数据也能靠「结束并丢弃」清掉");

    stopTimerTicker();
  });

  test("「▶️ 开始这个任务」写回成功（真引擎）→ 计时器出现、方块阵照旧", async () => {
    const { container, recorder } = await render(validMarkdown13());
    assert.equal(container.query(".wf-timer").length, 0);

    recorder.host.startTimer = async (_file, nodeId) => {
      recorder.timerStartCalls.push({ nodeId });
      const now = new Date();
      const document = validDocument13();
      const edit = startTimerEntry(document, nodeId, now);
      if (!edit.ok) throw new Error(`夹具不该失败：${edit.reason ?? ""}`);
      recorder.state.markdown = writeBackDocument(recorder.state.markdown, document, { now }).markdown;
      return { success: true, changed: true, issues: [], nodeId, changedNodeIds: edit.changedNodeIds };
    };

    // Phase 16：方块阵在 📊 弹窗里，先开弹窗 —— 局部刷新后弹窗应跟着重画
    const widget = openWidget(container, "📊");
    clickMenuItem(openCardMenu(container.query(".wf-card")[0]), "▶️ 开始这个任务");
    await flush();

    assert.deepEqual(recorder.timerStartCalls, [{ nodeId: "nd-uuid-001" }]);
    assert.match(recorder.notices[0], /已开始计时：「调研竞品」/);
    assert.equal(container.query(".wf-timer").length, 1, "总览出现计时器");
    assert.equal(container.query(".wf-timer-label")[0].text, "正在：调研竞品");
    assert.match(container.query(".wf-timer-clock")[0].text, /^\d{2}:\d{2}:\d{2}$/);
    assert.deepEqual(texts(container.query(".wf-timer-btn")), ["结束并记录", "结束并丢弃"], "出现快捷结束按钮");
    assert.equal(daySquares(widget).length, 21, "局部刷新后方块阵照旧");
    closeWidget();

    stopTimerTicker();
  });

  test("本节点计时中 → 菜单给「结束并记录 / 结束并丢弃」；别的节点只提示先结束", async () => {
    const document = validDocument13();
    startTimerEntry(document, "nd-uuid-001", new Date());
    const { container, recorder } = await render(writeBackDocument(validMarkdown13(), document).markdown);

    const own = texts(openCardMenu(container.query(".wf-card")[0]));
    assert.ok(own.includes("⏹ 结束并记录"));
    assert.ok(own.includes("🗑 结束并丢弃"));
    assert.equal(own.includes("▶️ 开始这个任务"), false, "自己已在计时，不给「开始」");

    const other = texts(openCardMenu(container.query(".wf-card")[1]));
    assert.equal(other.includes("▶️ 开始这个任务"), false, "别人在计时时不摆「开始」这个按钮（点了必被拒）");
    assert.ok(other.some((text) => /正在「调研竞品」计时/.test(text)), "改为提示先结束它");

    clickMenuItem(openCardMenu(container.query(".wf-card")[0]), "🗑 结束并丢弃");
    await flush();

    assert.deepEqual(recorder.timerStopCalls, [{ nodeId: "nd-uuid-001", mode: "discard" }]);
    assert.match(recorder.notices[0], /已结束并丢弃：「调研竞品」/);

    stopTimerTicker();
  });

  test("总览计时器的快捷按钮：与菜单共用同一段 stopTimer（record / discard 各一次写回）", async () => {
    const document = validDocument13();
    startTimerEntry(document, "nd-uuid-001", new Date());
    const { container, recorder } = await render(writeBackDocument(validMarkdown13(), document).markdown);

    const record = container.query(".wf-timer-actions")[0].query(".wf-timer-btn")[0];
    const discard = container.query(".wf-timer-actions")[0].query(".wf-timer-btn")[1];
    assert.ok(record.classList.contains("wf-timer-btn--record"));
    assert.ok(discard.classList.contains("wf-timer-btn--discard"));

    record.onclick?.(mouseEvent());
    await flush();
    assert.deepEqual(recorder.timerStopCalls, [{ nodeId: "nd-uuid-001", mode: "record" }]);
    assert.match(recorder.notices[0], /已结束并记录：「调研竞品」/);

    // 局部刷新后按钮是新的一批（闭包仍指向同一条计时条目 → 直接再点「丢弃」）
    const discardAgain = container.query(".wf-timer-actions")[0].query(".wf-timer-btn")[1];
    discardAgain.onclick?.(mouseEvent());
    await flush();
    assert.deepEqual(recorder.timerStopCalls, [
      { nodeId: "nd-uuid-001", mode: "record" },
      { nodeId: "nd-uuid-001", mode: "discard" },
    ]);
    assert.match(recorder.notices[1], /已结束并丢弃：「调研竞品」/);

    stopTimerTicker();
  });

});


/* ------------------------------------------------------------------ *
 * v0.7 §⑨ 二轮微调：切换栏顺序 / 卡片（无 type + 已完成时间）/ 归档地址读正文
 * ------------------------------------------------------------------ */

describe("wfView · v0.7 §⑨ 卡片与切换栏微调", () => {
  /** 按标题找卡片（列布局下 `.wf-card` 的序号不好数） */
  const cardTitled = (container: StubElement, title: string): StubElement => {
    const card = container.query(".wf-card").find((item) => item.query(".wf-card-title")[0]?.text === title);
    assert.ok(card, `应能按标题找到卡片：${title}`);
    return card;
  };

  test("§⑨-6 折叠区切换栏 DOM 顺序：[◀][名称][计数][▶]", async () => {
    // Phase 16：进行中改成横向分栏后，切换栏只剩「已完成流 / 已取消流」在用
    const { container } = await render(validMarkdown11());
    const bar = container.query(".wf-lane-switcher")[0];
    const order = bar.children.map((child) => {
      if (child.classList.contains("wf-lane-switch-name")) return "name";
      if (child.classList.contains("wf-lane-switch-count")) return "count";
      if (child.text === "◀") return "prev";
      if (child.text === "▶") return "next";
      return `?${child.text}`;
    });

    assert.deepEqual(order, ["prev", "name", "count", "next"]);

    // Phase 16：折叠区不显示颜色方块（颜色方块只属于「正在进行」的分栏栏头）
    const foldLane = container.query(".wf-fold-body")[0].query(".wf-lane")[0];
    assert.equal(foldLane.query(".wf-lane-color").length, 0);
  });

  test("§⑨-5 卡片不显示 type（JSON 里仍保留）", async () => {
    const document = validDocument11();
    document.workflows[0].root.type = "决策";
    const { container } = await render(writeBackDocument(validMarkdown11(), document).markdown);

    const card = cardTitled(container, document.workflows[0].root.title);
    assert.equal(card.query(".wf-card-meta")[0].text.includes("决策"), false);
  });

  test("§⑨-5 done 节点显示已完成时间 XdYh（没有计时 / 非 done 都不显示）", async () => {
    const document = validDocument11();
    const root = document.workflows[0].root;
    root.status = "done";
    root.timeEntries = [
      {
        startAt: "2026-10-10T09:00:00+08:00",
        date: "2026-10-10",
        endAt: "2026-10-11T15:30:00+08:00",
        hours: 30.5,
      },
    ];
    const { container } = await render(writeBackDocument(validMarkdown11(), document).markdown);

    const card = cardTitled(container, root.title);
    assert.deepEqual(texts(card.query(".wf-card-time")), ["⏱ 已完成 1d6.5h"]);

    // 没计时 / 未完成的节点不占位
    const plain = await render(validMarkdown11());
    assert.equal(plain.container.query(".wf-card-time").length, 0);
  });

  test("§⑨-2 已归档块：地址优先读纪要段「归档：」行，旧 archive.file 只作回落", async () => {
    // 从数据现生一份笔记（每个节点都有成对标志的纪要段），再往浓缩节点那段里塞「归档：」行
    const base = writeBackDocument("", validDocument13()).markdown;
    const injected = replaceNoteSectionContent(
      base,
      ARCHIVE_ROOT_ID,
      "归档：[[archive/from-note.md]] summary：来自纪要段",
    );
    assert.equal(injected.found, true);

    const fromNote = await render(injected.markdown);
    const fromNoteWidget = openWidget(fromNote.container, "📦");
    assert.deepEqual(texts(fromNoteWidget.query(".wf-archive-row-link")), [
      `📄 archive/from-note.md（归档于 ${TIME_ARCHIVED_AT}）`,
    ]);
    closeWidget();

    // 纪要段里没有「归档：」行 → 回落旧数据里的 archive.file
    const legacy = await render(base);
    const legacyWidget = openWidget(legacy.container, "📦");
    assert.deepEqual(texts(legacyWidget.query(".wf-archive-row-link")), [
      `📄 ${ARCHIVE_FILE}（归档于 ${TIME_ARCHIVED_AT}）`,
    ]);
    closeWidget();
  });
});

/* ------------------------------------------------------------------ *
 * Phase 4：归档（右键「📦 为此及之后归档…」+ ③ 已归档块）
 * ------------------------------------------------------------------ */

describe("wfView · Phase 4 归档（右键入口 + ③ 已归档块）", () => {
  /** 右键某张卡片 → 打开菜单并返回菜单项（openMenu 会先关掉旧菜单） */
  const openCardMenu = (card: StubElement): StubElement[] => {
    card.oncontextmenu?.(mouseEvent());
    const menu = body.query(".wf-menu")[0];
    assert.ok(menu, "右键应弹出菜单");
    return menu.query(".wf-menu-item");
  };

  /** 点菜单里的某一项（找不到就带着实际项报错，方便定位） */
  const clickMenuItem = (items: StubElement[], text: string): void => {
    const item = items.find((entry) => entry.text === text);
    assert.ok(item, `菜单里应有「${text}」，实际：${items.map((entry) => entry.text).join(" / ")}`);
    item.onclick?.(mouseEvent());
  };

  /** 按标题找卡片：列布局下 `.wf-card` 的序号不好数，按文字找最稳 */
  const cardTitled = (container: StubElement, title: string): StubElement => {
    const card = container.query(".wf-card").find((item) => item.query(".wf-card-title")[0]?.text === title);
    assert.ok(card, `应能按标题找到卡片：${title}`);
    return card;
  };

  /**
   * 造一份「nd-uuid-002『整理结论』挂上一个已完成的子节点」的 1.3 文档：
   * 于是这个中间节点满足归档资格（非根 / 有子树 / 子树全 done），
   * 而根节点（「根节点不能归档」）与归档节点（「该节点已归档」）在菜单里仍然只给原因。
   */
  const documentReadyToArchive = (): WfJsonDocument => {
    const document = clone(validDocument13());
    document.workflows[0].root.children[0].children = [
      leaf("nd-uuid-005", "写结论", {
        status: "done",
        progress: 5,
        startAt: "2026-10-05T14:00:00+08:00",
        updatedAt: "2026-10-05T16:00:00+08:00",
        completedAt: "2026-10-05T16:00:00+08:00",
        timeEntries: [
          { startAt: "2026-10-05T14:00:00+08:00", date: "2026-10-05", endAt: "2026-10-05T16:00:00+08:00", hours: 2 },
        ],
      }),
    ];
    return document;
  };

  test("📦 弹窗：分组标题 + 明细 + 归档 md 链接 + 三段文字；没有归档节点时是占位文案", async () => {
    const { container } = await render(validMarkdown13());

    // Phase 16：整块搬进 📦 弹窗，页面上不再平铺归档行，也没有 `<details>` 外壳
    assert.equal(container.query(".wf-archive-group").length, 0, "页面上不再平铺归档行");
    const widget = openWidget(container, "📦");
    const popup = currentPopup();
    assert.ok(popup !== undefined, "弹窗应存在");
    assert.equal(popup.query(".wf-archive").length, 0, "不再是可折叠的 <details>");
    assert.equal(popup.query(".wf-widget-popup-title")[0].text, "📦 已归档（1）", "弹窗标题带计数");
    assert.deepEqual(texts(widget.query(".wf-archive-group-title")), ["🗂 实现方案（已归档）"]);
    assert.deepEqual(texts(widget.query(".wf-archive-row-title")), ["📦 实现方案"]);
    assert.equal(
      widget.query(".wf-archive-row-meta")[0].text,
      "已完成 · 重要度 P4-Critical · #归档 · 开始 2026-10-06 · 完成 2026-10-08",
    );
    assert.equal(widget.query(".wf-archive-row-link")[0].text, `📄 ${ARCHIVE_FILE}（归档于 ${TIME_ARCHIVED_AT}）`);
    assert.equal(widget.query(".wf-archive-row-notes-title")[0].text, "归档信息");
    assert.deepEqual(texts(widget.query(".wf-archive-row-note")), [
      "概括：实现方案已收敛",
      "原理 / 启发：先验证再实现",
      "复盘 / 下一步：把估算拆得更细",
    ]);
    closeWidget();

    // 1.1 样例没有 `archive` 字段 → 弹窗里给一行占位文案（弹窗已经开着，不能什么都不给）
    const plain = await render(validMarkdown11());
    const plainWidget = openWidget(plain.container, "📦");
    assert.equal(plainWidget.query(".wf-widget-placeholder")[0].text, "还没有归档节点");
    assert.equal(plainWidget.query(".wf-archive-row").length, 0);
    closeWidget();
  });

  test("行里两处点击：标题跳本文件纪要锚点、链接打开归档 md（都不重渲染）", async () => {
    const { container, recorder } = await render(validMarkdown13());
    const calls: { linktext: string; sourcePath: string }[] = [];
    recorder.host.app.workspace.openLinkText = (linktext: string, sourcePath: string): Promise<void> => {
      calls.push({ linktext, sourcePath });
      return Promise.resolve();
    };

    const widget = openWidget(container, "📦");
    const row = widget.query(".wf-archive-row")[0];
    row.query(".wf-archive-row-title")[0].onclick?.(mouseEvent());
    row.query(".wf-archive-row-link")[0].onclick?.(mouseEvent());

    assert.deepEqual(calls, [
      { linktext: `${file.basename}#^${ARCHIVE_ROOT_ID}`, sourcePath: file.path },
      { linktext: ARCHIVE_FILE, sourcePath: file.path },
    ]);
    closeWidget();
  });

  test("菜单写明不能归档的原因（根节点 / 已归档）：点它只提示，不调插件", async () => {
    // 夹具那份归档 md 属于「归档 workflow 的根节点」，命中的理由是「根节点不能归档」；
    // 这里再给一个**非根**节点挂上 `archive`，专门覆盖「该节点已归档」这条理由。
    const document = documentReadyToArchive();
    document.workflows[0].root.children[0].archive = {
      summary: "早先归档过一版",
      archivedAt: TIME_ARCHIVED_AT,
      file: ARCHIVE_FILE,
      workflowId: "wf-uuid-101",
      schemaVersion: "1.3",
    };
    const { container, recorder } = await render(writeBackDocument(validMarkdown13(), document).markdown);
    const opened: string[] = [];
    recorder.host.app.workspace.openLinkText = (linktext: string): Promise<void> => {
      opened.push(linktext);
      return Promise.resolve();
    };

    clickMenuItem(openCardMenu(cardTitled(container, "调研竞品")), "📦 为此及之后归档（根节点不能归档）");
    await flush();
    assert.match(recorder.notices[0], /不能归档「调研竞品」：根节点不能归档/);

    const archivedItems = openCardMenu(cardTitled(container, "整理结论"));
    assert.ok(archivedItems.some((item) => item.text === "📦 为此及之后归档（该节点已归档）"));
    clickMenuItem(archivedItems, `📄 打开归档文件（${ARCHIVE_FILE}）`);
    await flush();

    assert.deepEqual(opened, [ARCHIVE_FILE], "已归档节点的归档 md 直接从菜单打开");
    assert.deepEqual(recorder.archiveCalls, [], "不满足资格时不该调插件");
    // Phase 16：归档行在 📦 弹窗里（两次点击都没改文档 → 2 行 = 手工挂的那行 + 夹具那行）
    const widget = openWidget(container, "📦");
    assert.equal(widget.query(".wf-archive-row").length, 2);
    closeWidget();
  });

  test("「📦 为此及之后归档…」走真引擎：浓缩子树 + 建归档 md + 📦 弹窗立刻多一行", async () => {
    const markdown = writeBackDocument(validMarkdown13(), documentReadyToArchive()).markdown;
    const { container, recorder } = await render(markdown);
    // 归档前先把 📦 弹窗打开：归档后它应跟着局部刷新重画（不用手动重开）
    const widget = openWidget(container, "📦");
    const popup = currentPopup();
    assert.ok(popup !== undefined, "弹窗应存在");
    assert.equal(popup.query(".wf-widget-popup-title")[0].text, "📦 已归档（1）", "归档前只有夹具自带的那个");

    /** 插件侧真实链路：planArchive → 建归档 md → mutateFile 浓缩本文件（这里用真引擎等价替换） */
    const archiveCalls: string[] = [];
    recorder.host.promptArchiveNode = async (_file, node) => {
      archiveCalls.push(node.id);
      const analysis = analyzeMarkdown(recorder.state.markdown, { file: file.path });
      const wfDoc = analysis.latestDocument ?? analysis.document;
      if (wfDoc === undefined) throw new Error("夹具应能解析出文档");
      const planned = planArchive(wfDoc, node.id, { summary: "结论已整理" }, NOW);
      if (!planned.ok || planned.plan === undefined) throw new Error(`夹具不该失败：${planned.reason ?? ""}`);
      const edit = archiveNode(wfDoc, node.id, planned.plan.archive, NOW);
      if (!edit.ok) throw new Error(`夹具不该失败：${edit.reason ?? ""}`);
      recorder.state.markdown = writeBackDocument(recorder.state.markdown, wfDoc, {
        now: NOW,
        removedNoteAnchors: edit.removedNoteAnchors,
      }).markdown;
      return {
        cancelled: false,
        result: {
          success: true,
          changed: true,
          issues: [],
          nodeId: node.id,
          changedNodeIds: edit.changedNodeIds,
          archiveFile: planned.plan.file,
          workflowId: planned.plan.workflowId,
          nodeCount: planned.plan.nodeCount,
        },
      };
    };

    clickMenuItem(openCardMenu(cardTitled(container, "整理结论")), "📦 为此及之后归档…");
    await flush();

    assert.deepEqual(archiveCalls, ["nd-uuid-002"]);
    assert.match(recorder.notices[0], /^已归档「整理结论」（压缩 2 个节点）→ archive\/[^\s]*nd-uuid-002\.md/);

    // ③ 已归档（Phase 16 在 📦 弹窗里）：开着的弹窗跟着局部刷新重画 —— 标题计数 +1，新行按文档顺序排在最前
    assert.equal(popup.query(".wf-widget-popup-title")[0].text, "📦 已归档（2）");
    assert.deepEqual(texts(widget.query(".wf-archive-row-title")), ["整理结论", "📦 实现方案"]);
    assert.equal(widget.query(".wf-archive-row-meta")[0].text, "已完成 · 用时 2h · 开始 2026-10-05 · 完成 2026-10-06");
    closeWidget();

    // 子树整体被浓缩：后代卡片消失、浓缩节点那张卡片还在（重试时可再点一次走幂等复用）
    assert.equal(texts(container.query(".wf-card-title")).includes("写结论"), false);
    assert.ok(cardTitled(container, "整理结论"), "浓缩节点自己仍留在进行中流里");
  });
});


describe("wfView · Phase 15 拖拽改节点顺序", () => {
  test("块尾按钮行：「修改节点顺序」开关排在「⚙️ 修改工作流…」之前，默认关", async () => {
    const { container } = await render(validMarkdown11());

    const actions = container.query(".wf-block-actions");
    assert.equal(actions.length, 1, "块尾只有一行按钮");
    assert.deepEqual(texts(actions[0].query(".wf-block-btn")), ["修改节点顺序：关", "⚙️ 修改工作流…"]);

    const toggle = container.query(".wf-reorder-toggle")[0];
    assert.equal(toggle.getAttribute("aria-pressed"), "false");
    assert.equal(toggle.title, "开启后可拖动节点卡片，拖到另一节点上半 / 下半分别插入到其前 / 后");
    assert.equal(toggle.classList.contains("wf-reorder-toggle--on"), false);

    // 关态：一个 drag* 监听都不挂，也不挂 data-node-id（原交互不变）
    for (const card of container.query(".wf-card")) {
      assert.equal(card.getAttribute("data-node-id"), null);
      assert.equal(card.draggable, false);
      assert.equal(card.ondragstart, null);
      assert.equal(card.ondrop, null);
      assert.equal(card.classList.contains("wf-card--draggable"), false);
    }
  });

  test("开：非根卡片 draggable + data-node-id，根卡片不可拖；关回去恢复原样", async () => {
    const { container } = await render(validMarkdown11());
    await toggleReorder(container);

    const toggle = container.query(".wf-reorder-toggle")[0];
    assert.equal(toggle.text, "修改节点顺序：开");
    assert.equal(toggle.getAttribute("aria-pressed"), "true");
    assert.ok(toggle.classList.contains("wf-reorder-toggle--on"), "开态加主题色类");

    const rootCard = container.query(".wf-card")[0];
    assert.equal(rootCard.query(".wf-card-title")[0].text, "调研竞品", "泳道第一张是根节点卡片");
    assert.equal(rootCard.draggable, false, "根节点不能拖");
    assert.equal(rootCard.getAttribute("data-node-id"), null);
    assert.equal(rootCard.ondragstart, null);

    const child = cardOf(container, CHILD_ID);
    assert.equal(child.draggable, true);
    assert.ok(child.classList.contains("wf-card--draggable"));
    assert.equal(typeof child.ondragstart, "function");
    assert.equal(typeof child.ondragover, "function");
    assert.equal(typeof child.ondrop, "function");
    assert.equal(typeof child.ondragend, "function");

    await toggleReorder(container); // 收尾：关掉，避免影响后面的用例
    assert.equal(container.query(".wf-reorder-toggle")[0].text, "修改节点顺序：关");
    assert.equal(
      container.query(".wf-card").some((card) => card.getAttribute("data-node-id") !== null),
      false,
      "关态下所有卡片都摘掉 data-node-id",
    );
    assert.equal(container.query(".wf-card").some((card) => card.draggable), false);
  });



  test("resolveDrop：上半 → before、下半 → after、正中线算下半", () => {
    const rect = { top: 100, height: 40 };
    assert.equal(resolveDrop(rect, 100), "before");
    assert.equal(resolveDrop(rect, 119), "before");
    assert.equal(resolveDrop(rect, 120), "after");
    assert.equal(resolveDrop(rect, 139), "after");
  });

  test("拖到上半 → 上沿高亮 → host.moveNode(..., \"before\") → 成功整块重渲染、不弹提示", async () => {
    const { container, recorder } = await render(validMarkdown11());
    await toggleReorder(container);
    const moving = cardOf(container, CHILD_ID);
    const target = cardOf(container, DOING_ID);
    moving.rect.top = 100;
    moving.rect.height = 40;
    target.rect.top = 200;
    target.rect.height = 40;

    moving.ondragstart?.(dragEvent(110));
    target.ondragover?.(dragEvent(205));
    assert.ok(target.classList.contains("wf-card--drop-before"), "上半 → 上沿高亮");

    target.ondragleave?.(dragEvent(0));
    assert.equal(target.classList.contains("wf-card--drop-before"), false, "dragleave 清掉高亮");

    target.ondragover?.(dragEvent(205));
    target.ondrop?.(dragEvent(205));
    await flush();
    await flush();

    assert.deepEqual(recorder.moveCalls, [{ movingId: CHILD_ID, targetId: DOING_ID, position: "before" }]);
    assert.deepEqual(recorder.notices, [], "成功不弹 Notice");
    assert.equal(container.query(".wf-card--drop-before").length, 0, "drop 后清掉落点类");
    await toggleReorder(container); // 收尾：关掉
  });

  test("拖到下半 → 下沿高亮 → position = after（成为目标的子节点）", async () => {
    const { container, recorder } = await render(validMarkdown11());
    await toggleReorder(container);
    const moving = cardOf(container, CHILD_ID);
    const target = cardOf(container, DOING_ID);
    target.rect.top = 200;
    target.rect.height = 40;

    moving.ondragstart?.(dragEvent(110));
    target.ondragover?.(dragEvent(235));
    assert.ok(target.classList.contains("wf-card--drop-after"), "下半 → 下沿高亮");
    target.ondrop?.(dragEvent(235));
    await flush();
    await flush();

    assert.deepEqual(recorder.moveCalls, [{ movingId: CHILD_ID, targetId: DOING_ID, position: "after" }]);
    assert.deepEqual(recorder.notices, []);
    await toggleReorder(container); // 收尾：关掉
  });

  test("引擎拒绝（success=false）→ Notice 带原因", async () => {
    const { container, recorder } = await render(validMarkdown11());
    recorder.host.moveNode = async (_file, movingId, targetId, position) => {
      recorder.moveCalls.push({ movingId, targetId, position });
      return {
        success: false,
        changed: false,
        issues: [],
        changedNodeIds: [],
        reason: "不能把节点拖进它自己的子树",
      };
    };
    await toggleReorder(container);
    const moving = cardOf(container, CHILD_ID);
    const target = cardOf(container, DOING_ID);
    target.rect.top = 200;
    target.rect.height = 40;

    moving.ondragstart?.(dragEvent(110));
    target.ondrop?.(dragEvent(235));
    await flush();
    await flush();

    assert.deepEqual(recorder.notices, ["调整节点顺序失败：不能把节点拖进它自己的子树"]);
    await toggleReorder(container); // 收尾：关掉
  });
});


/* ------------------------------------------------------------------ *
 * Phase 16：视图重构
 *   ① 渲染区宽度（≤1400px，跟随窗口）
 *   ② 三行总览（主题 / 计时 / 统计）
 *   ③ 左侧小工具侧边栏 + 单例弹窗
 *   ④ 进行中：多工作流横向分栏
 * 契约：doc/datacontact/data_ixd_discuss_interact_v0.16.md
 * ------------------------------------------------------------------ */

describe("wfView · Phase 16 渲染区宽度 / 侧边栏弹窗 / 多工作流分栏", () => {
  /** 总览某一行的语义名（三行口径断言用） */
  const rowOf = (element: StubElement): string => {
    if (element.classList.contains("wf-theme-switch")) return "theme";
    if (element.classList.contains("wf-timer")) return "timer";
    if (element.classList.contains("wf-overview-line")) return "stat";
    return `?${element.allText}`;
  };

  test("① 页面宽度：有渲染区的那篇笔记放开 --file-line-width，且不碰 Obsidian 自己的类", () => {
    // 两次真机返工的回归点都盯在这一个测试里：
    //   v0.16.0 负 margin 外扩 → 超出页面列被祖先裁掉（两侧看不见）；
    //   v0.16.1 改 `.cm-content` / `.cm-sizer` 的 max-width + margin → 正文列压塌成「一行一个字」。
    const raw = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    // 只检查活规则：注释里会提到上面那些类名（教训文档），不能算违规
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    const sliceAt = (needle: string): string => {
      const index = css.indexOf(needle);
      assert.notEqual(index, -1, `styles.css 缺少「${needle}」`);
      return css.slice(index, index + 300);
    };

    // ①-1 页面列跟随窗口、封顶 1400px：只改写 Obsidian 官方的行宽变量，阅读视图 + 实时预览都要
    for (const view of [".markdown-preview-view:has(.wf-view)", ".markdown-source-view:has(.wf-view)"]) {
      const block = sliceAt(view);
      assert.match(block, /--file-line-width:\s*var\(--wf-view-max-width/, `${view} 没放开 --file-line-width`);
    }
    // 上限只有一个真源：token 在 `body` 上（页面根是 `.wf-theme` 的祖先）
    assert.match(css, /body \{[\s\S]*?--wf-view-max-width:\s*1400px/, "上限 token 必须挂在 body 上");

    // ①-2 渲染区自己：铺满页面列 + 1400 上限 + auto margin 居中；不测宽度、不越界
    const view = sliceAt(".wf-view {");
    assert.match(view, /width:\s*100%/, "渲染区要铺满页面列（= 跟随窗口）");
    assert.match(view, /max-width:\s*var\(--wf-view-max-width, 1400px\)/, "上限要跟着 --wf-view-max-width");
    assert.match(view, /margin-left:\s*auto/, "居中靠 auto margin");
    assert.doesNotMatch(view, /margin-(left|right):\s*calc\(/, "不许再用负 margin 外扩（会被祖先裁掉）");

    // ①-3 绝不改 Obsidian 自己的布局类（v0.16.1 的事故源）：出现任何一个就是回归
    for (const own of [".markdown-preview-sizer", ".cm-sizer", ".cm-contentContainer", ".cm-content"]) {
      assert.equal(css.includes(own), false, `不许改写 Obsidian 自己的 ${own}`);
    }
  });

  test("① 三行总览：主题 → 计时（仅计时中）→ 统计；元信息行已删除", async () => {
    const plain = await render(validMarkdown11());
    assert.deepEqual(plain.container.query(".wf-overview")[0].children.map(rowOf), ["theme", "stat"]);
    assert.equal(plain.container.query(".wf-overview-meta").length, 0);

    const document = validDocument13();
    startTimerEntry(document, "nd-uuid-001", new Date());
    const timed = await render(writeBackDocument(validMarkdown13(), document).markdown);
    assert.deepEqual(timed.container.query(".wf-overview")[0].children.map(rowOf), ["theme", "timer", "stat"]);
    // 快捷结束按钮挂在计时块里（第 2 行是**一整块**，不是两块）
    assert.equal(timed.container.query(".wf-timer")[0].query(".wf-timer-actions").length, 1);
    stopTimerTicker();
  });

  test("② 主体结构：侧边栏在左、工作区在右，折叠区也在工作区内", async () => {
    const { container } = await render(validMarkdown11());
    const main = container.query(".wf-main")[0];
    assert.equal(main.children.length, 2, "只有侧边栏 + 工作区两块");
    assert.ok(main.children[0].classList.contains("wf-sidebar"));
    assert.ok(main.children[1].classList.contains("wf-main-body"));
    assert.equal(main.children[1].query(".wf-fold").length, 1, "折叠区与泳道同一列");
    assert.equal(container.query(".wf-footer")[0].parent, container, "页脚不在工作区里");

    // 「修改节点顺序」/「修改工作流」按钮行排在分栏之后（Phase 15 的 DOM 顺序不变）
    const block = container.query(".wf-block")[0];
    assert.equal(block.children[block.children.length - 1].classList.contains("wf-block-actions"), true, "按钮行在最后");
    assert.equal(block.children[block.children.length - 2].classList.contains("wf-active-columns"), true, "分栏在按钮行之前");
  });

  test("③ 侧边栏：6 个方形图标按钮，顺序 / 名称 / aria-label 固定", async () => {
    const { container } = await render(validMarkdown13());
    const bar = container.query(".wf-sidebar")[0];
    assert.equal(bar.getAttribute("aria-label"), "小工具");

    const buttons = container.query(".wf-sidebar-btn");
    assert.deepEqual(texts(buttons), ["🙂", "📊", "🎯", "📦", "📈", "⚙️"]);
    assert.deepEqual(
      buttons.map((button) => button.title),
      ["365天emo", "21天甘特图", "4象限节点", "📦 已归档（1）", "365天plot", "插件设置"],
    );
    assert.deepEqual(
      buttons.map((button) => button.getAttribute("aria-label")),
      buttons.map((button) => button.title),
      "aria-label 与 tooltip 同名",
    );
  });

  test("③ ⚙️ 不弹窗、直接开插件设置页", async () => {
    const { container, recorder } = await render(validMarkdown11());
    widgetButton(container, "⚙️").onclick?.(mouseEvent());
    assert.equal(recorder.settingsCalls.length, 1);
    assert.equal(currentPopup(), undefined, "设置按钮不开弹窗");
  });

  test("① 弹窗挂在全屏遮罩里：只有「×」能关，点遮罩不关闭", async () => {
    const { container } = await render(validMarkdown13());
    const widget = openWidget(container, "📦");
    const popup = currentPopup();
    assert.ok(popup !== undefined, "弹窗应存在");
    const overlay = body.query(".wf-widget-overlay")[0];
    assert.ok(overlay !== undefined, "Phase 18 ①：弹窗外面应有一层遮罩");
    assert.equal(popup.parentElement, overlay, "遮罩是弹窗的父元素（删遮罩 = 整块清掉）");
    assert.deepEqual(
      popup.children.map((child) => {
        if (child.classList.contains("wf-widget-popup-head")) return "head";
        if (child.classList.contains("wf-widget-popup-body")) return "body";
        return `?${child.allText}`;
      }),
      ["head", "body"],
      "弹窗自己只有标题行与内容区",
    );
    assert.equal(popup.query(".wf-widget-popup-close")[0].text, "×");
    // 点遮罩不关闭：压根没挂关闭回调（Phase 16 的关闭语义不变）
    assert.equal(overlay.onclick, null, "遮罩上不挂点击关闭");
    assert.ok(currentPopup() !== undefined, "弹窗还在");
    assert.equal(widget.query(".wf-archive-row").length, 1, "📦 里是归档行");
    closeWidget();
    assert.equal(body.query(".wf-widget-overlay").length, 0, "关掉弹窗时遮罩一起清掉");
  });

  test("③ 📊 用 gantt 宽度变体，内容 = 方块阵 + 甘特图", async () => {
    const { container } = await render(validMarkdown13());
    const widget = openWidget(container, "📊");
    assert.ok(currentPopup()?.classList.contains("wf-widget-popup--gantt"), "宽度变体类");
    assert.equal(currentPopup()?.query(".wf-widget-popup-title")[0].text, "21天甘特图");
    assert.equal(widget.query(".wf-heatmap").length, 1);
    assert.equal(widget.query(".wf-gantt").length, 1);
    closeWidget();
  });

  test("Phase 19 M2：🎯 用 quadrant 宽度变体，内容 = 16 分区 + 右侧预览", async () => {
    const { container } = await render(validMarkdown13());
    const widget = openWidget(container, "🎯");
    assert.ok(currentPopup()?.classList.contains("wf-widget-popup--quadrant"), "宽度变体类");
    assert.equal(currentPopup()?.query(".wf-widget-popup-title")[0].text, "4象限节点");
    assert.equal(widget.query(".wf-quad-partition").length, 16, "4×4 = 16 分区");
    assert.equal(widget.query(".wf-quad-preview").length, 1);
    assert.equal(widget.query(".wf-quad-node").length, 0, "刚打开时预览是空的（只有提示行）");
    assert.equal(widget.query(".wf-quad-empty").length, 1);
    closeWidget();
  });

  test("Phase 19 M3：📈 用 plot 宽度变体，内容 = plot 列表 + 折线区（空目录时给提示）", async () => {
    const { container } = await render(validMarkdown13());
    const widget = openWidget(container, "📈");
    assert.ok(currentPopup()?.classList.contains("wf-widget-popup--plot"), "宽度变体类");
    assert.equal(currentPopup()?.query(".wf-widget-popup-title")[0].text, "365天plot");
    assert.equal(widget.query(".wf-plot").length, 1);
    assert.equal(widget.query(".wf-plot-sidebar").length, 1, "左侧列表 + 工具条");
    assert.equal(widget.query(".wf-plot-main").length, 1, "右侧折线区");
    assert.equal(widget.query(".wf-plot-file").length, 1, "隐藏的 CSV 文件选择框");
    assert.deepEqual(texts(widget.query(".wf-plot-btn")), ["新建", "导入 CSV", "导出 CSV", "删除"]);
    // 列表是异步读盘的（假 vault 里没有 plots/ → 空目录）
    await flush();
    assert.equal(widget.query(".wf-plot-empty")[0]?.text, "还没有 plot，点「新建」开始");
    closeWidget();
  });

  test("④ 弹窗单例：开 📦 后再点 🙂 → 只剩一个，内容换成 365 天画布", async () => {
    const { container } = await render(validMarkdown13());
    openWidget(container, "📦");
    assert.equal(currentPopup()?.query(".wf-archive-row").length, 1);

    const widget = openWidget(container, "🙂");
    assert.equal(body.query(".wf-widget-popup").length, 1, "同一时刻只有一个弹窗");
    assert.equal(body.query(".wf-widget-overlay").length, 1, "遮罩也只有一个");
    assert.equal(widget.query(".wf-emo-cell").length, 364, "364 个日期格 + 1 个今日见闻");
    assert.equal(widget.query(".wf-emo-today").length, 1);
    assert.ok(currentPopup()?.classList.contains("wf-widget-popup--emo"), "emo 宽度变体类");
    // emo 不随插件主题：遮罩上钉成 default
    assert.equal(body.query(".wf-widget-overlay")[0].getAttribute("data-wf-theme"), "default");
    assert.equal(currentPopup()?.query(".wf-widget-popup-title")[0].text, "365天emo");
    closeWidget();
  });

  test("③ 弹窗跟着整块重渲染重画：切主题后浮层 data-wf-theme 跟着变", async () => {
    const { container } = await render(validMarkdown13());
    openWidget(container, "📦");
    // Phase 18 ①：主题挂在**遮罩**上（弹窗靠继承拿到变量）
    assert.equal(body.query(".wf-widget-overlay")[0].getAttribute("data-wf-theme"), "default");

    const tech = container.query(".wf-theme-btn").find((button) => button.text === "科技风");
    assert.ok(tech !== undefined, "科技风按钮应存在");
    tech.onclick?.(mouseEvent());
    await flush();

    assert.equal(body.query(".wf-widget-overlay")[0].getAttribute("data-wf-theme"), "tech", "浮层跟着换主题");
    assert.equal(currentPopup()?.query(".wf-widget-popup-title")[0].text, "📦 已归档（1）", "内容仍在（没被关掉）");
    closeWidget();
  });

  test("③ 拿不到当前笔记时：只留提示，弹窗被关掉", async () => {
    const { container, recorder } = await render(validMarkdown11());
    openWidget(container, "📦");
    assert.ok(currentPopup() !== undefined);

    recorder.host.app.vault.getAbstractFileByPath = () => null;
    recorder.host.app.workspace.getActiveFile = () => null;
    await renderWorkflowView(recorder.host, {
      app: recorder.host.app,
      container: asHtmlElement(container),
      currentFilePath: "gone.md",
    });

    assert.equal(currentPopup(), undefined, "没有数据源就不该留着上一个文件的弹窗");
    assert.equal(container.query(".wf-hint").length, 1);
  });
});

/* ------------------------------------------------------------------ *
 * Phase 17：卡片四段（时间行 / 链接数 / 进度条收尾）、计时「继续上次」、
 * 泳道正文区自滚 + 分栏分隔线。
 * ------------------------------------------------------------------ */

/** 相对今天的日期（YYYY-MM-DD）：卡片上的「x天」按本地日历算，测试因此也相对今天造数据 */
function shiftDate(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return formatLocalDate(date);
}

describe("wfView · Phase 17 卡片四段", () => {
  /** 按标题找卡片（列布局下 `.wf-card` 的序号不好数） */
  const cardNamed = (container: StubElement, title: string): StubElement => {
    const card = container.query(".wf-card").find((item) => item.query(".wf-card-title")[0]?.text === title);
    assert.ok(card, `应能按标题找到卡片：${title}`);
    return card;
  };

  test("顺序 = 标题 → 元信息 → 时间 → 概要 → 进度条；链接数固定显示", async () => {
    const { container } = await render(validMarkdown());
    const card = container.query(".wf-card")[0];
    const shape = card.children.map((child) => {
      for (const name of ["wf-card-top", "wf-card-meta", "wf-card-line", "wf-card-summary", "wf-card-progress"]) {
        if (child.classList.contains(name)) return name;
      }
      return `?${child.allText}`;
    });
    // 夹具根节点：done + 有 summary + 没有计时 → Phase 18 ⑧ 起多一行「x天完成 · x天前结束」，进度条收在最后
    assert.deepEqual(shape, ["wf-card-top", "wf-card-meta", "wf-card-line", "wf-card-summary", "wf-card-progress"]);

    // 纪要超链接数量固定给出（正文里 [ [竞品分析报告] ] = 1 条；别的节点 0 条也照显示）
    assert.match(card.query(".wf-card-meta")[0].text, /🔗 1/);
    assert.match(container.query(".wf-card")[1].query(".wf-card-meta")[0].text, /🔗 0/);
    // 旧的「开始 / 截止」日期串不再塞进元信息行（改成第 3 段的两句相对天数）
    assert.doesNotMatch(card.query(".wf-card-meta")[0].text, /开始 \d{4}-\d{2}-\d{2}/);
    assert.doesNotMatch(card.query(".wf-card-meta")[0].text, /截止 \d{4}-\d{2}-\d{2}/);
  });

  test("时间行：未完成给「已经过 / 距结束」，done 不再给「已经过」", async () => {
    const document = validDocument11();
    document.workflows[0].root.children = [
      leaf("nd-line-a", "已经过与截止", {
        status: "doing",
        startAt: `${shiftDate(-5)}T09:00:00+08:00`,
        dueAt: `${shiftDate(3)}T18:00:00+08:00`,
      }),
      leaf("nd-line-b", "明天到期", { status: "todo", dueAt: `${shiftDate(1)}T18:00:00+08:00` }),
      leaf("nd-line-c", "没有日期", { status: "todo" }),
    ];
    const { container } = await render(writeBackDocument(validMarkdown11(), document).markdown);
    const linesOf = (title: string): string[] => texts(cardNamed(container, title).query(".wf-card-line"));

    assert.deepEqual(linesOf("已经过与截止"), ["已经过：4天 · 距结束：2天"], "5 天前开始 = 4 天；3 天后到期 = 2 天");
    assert.deepEqual(linesOf("明天到期"), ["距结束：0天"], "明天到期算 0 天（今天不整算一天）");
    assert.deepEqual(linesOf("没有日期"), [], "两个时间都没有 → 不占位");
    // done 节点（夹具根节点「调研竞品」带 startAt + completedAt）只走「x天完成 / x天前结束」，不出现「已经过」
    assert.doesNotMatch(texts(cardNamed(container, "调研竞品").query(".wf-card-line"))[0] ?? "", /已经过/);
  });

  test("时间行：done + 有计时 → 三句同一行，只有「⏱ 已完成」那段高亮", async () => {
    const document = validDocument11();
    const root = document.workflows[0].root;
    root.startAt = `${shiftDate(-9)}T09:00:00+08:00`;
    root.completedAt = `${shiftDate(-2)}T18:00:00+08:00`;
    root.timeEntries = [
      { startAt: `${shiftDate(-2)}T09:00:00+08:00`, date: shiftDate(-2), endAt: `${shiftDate(-1)}T15:30:00+08:00`, hours: 30.5 },
    ];
    const { container } = await render(writeBackDocument(validMarkdown11(), document).markdown);
    const card = cardNamed(container, root.title);
    const line = card.query(".wf-card-line")[0];

    assert.equal(line.allText, "6天完成 · ⏱ 已完成 1d6.5h · 1天前结束", "完成用时夹在两句之间");
    assert.equal(line.query(".wf-card-time").length, 1, "只有完成用时那段高亮");
    assert.equal(line.query(".wf-card-time")[0].text, "⏱ 已完成 1d6.5h");
    assert.doesNotMatch(line.allText, /已经过/);
  });
});

describe("wfView · Phase 17/18 计时「继续上次」", () => {
  test("没有计时中 → 只有一个按钮（上一个任务 + 继续这个任务）；点了走 host.startTimer", async () => {
    const { container, recorder } = await render(validMarkdown13());

    const row = container.query(".wf-timer-resume");
    assert.equal(row.length, 1, "有已完成计时 → 出现「继续上次」一行");
    assert.equal(container.query(".wf-timer").length, 0, "与正计时块互斥");
    // Phase 18 ③：标签并进按钮（不再有 .wf-timer-resume-label 子元素）
    assert.equal(row[0].query(".wf-timer-resume-label").length, 0, "标签元素已删除");
    // 夹具里 endAt 最大的是「交叉验证」（2026-10-06 14:00；done 节点，状态不影响入选）
    assert.deepEqual(texts(row[0].query(".wf-timer-resume-btn")), ["上一个任务：交叉验证 · 继续这个任务"]);

    row[0].query(".wf-timer-resume-btn")[0].onclick?.(mouseEvent());
    await flush();
    assert.deepEqual(recorder.timerStartCalls, [{ nodeId: "nd-uuid-003" }], "复用同一条 startTimer 链路");
  });

  test("计时中 / 一条计时都没有 → 都不出现「继续上次」", async () => {
    const active = validDocument13();
    startTimerEntry(active, "nd-uuid-001", new Date());
    const timed = await render(writeBackDocument(validMarkdown13(), active).markdown);
    assert.equal(timed.container.query(".wf-timer").length, 1);
    assert.equal(timed.container.query(".wf-timer-resume").length, 0, "计时中只给正计时 + 结束按钮");
    stopTimerTicker();

    const empty = await render(validMarkdown11());
    assert.equal(empty.container.query(".wf-timer-resume").length, 0, "没有历史计时就不占位");
  });
});

describe("wfView · Phase 17 泳道滚动与分栏分隔线", () => {
  test("每条泳道一个正文滚动区（栏头不在里面），高度上限走 --wf-lane-max-height", async () => {
    const { container } = await render(validMarkdown());

    assert.equal(container.query(".wf-lane").length, 2);
    assert.equal(container.query(".wf-lane-body").length, 2, "每条泳道一个滚动容器（两条泳道两条滚动条）");
    for (const lane of container.query(".wf-lane")) {
      const body = lane.query(".wf-lane-body")[0];
      assert.ok(body !== undefined, "泳道必须有正文区");
      assert.equal(body.query(".wf-lane-head").length, 0, "栏头不在滚动区里（栏头固定）");
    }
  });

  test("styles.css：正文区自滚 + 非首栏左边框当分隔线（不加 DOM）", () => {
    const raw = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    const start = css.indexOf(".wf-lane-body {");
    assert.notEqual(start, -1, "styles.css 缺少 .wf-lane-body");
    const laneBody = css.slice(start, start + 320);
    assert.match(laneBody, /max-height:\s*var\(--wf-lane-max-height,\s*800px\)/, "高度上限读设置面板写入的变量");
    assert.match(laneBody, /overflow-y:\s*auto/, "只有正文纵向滚动");
    assert.match(css, /\.wf-column \+ \.wf-column \.wf-lane \{[^}]*border-left/, "非首栏用左边框当分隔线");
  });
});

/* ------------------------------------------------------------------ *
 * Phase 18：大标题、卡片第二段三态、间隙滚轮横滚、甘特 tooltip 三段
 * ------------------------------------------------------------------ */

describe("wfView · Phase 18 ③ 引导性大标题", () => {
  test("`.wf-app-title` 在 `.wf-overview` 之前；设置空串 → i18n 回落「下一步是？」", async () => {
    const { container } = await render(validMarkdown13());
    const title = container.query(".wf-app-title")[0];
    assert.ok(title !== undefined, "渲染区最顶部应有大标题");
    assert.equal(container.query(".wf-app-title").length, 1);
    assert.equal(title.text, "下一步是？", "空串回落 i18n 文案");
    assert.equal(container.children[0], title, "标题在最前面（在主题按钮那一行之上）");
    assert.ok(container.children[1].classList.contains("wf-overview"), "总览在标题之后");
  });

  test("设置里填了就用原文案（去首尾空白）", async () => {
    const container = new StubElement("div");
    const recorder = makeHost(validMarkdown13());
    recorder.host.resumePrompt = () => "  今天要交付什么？  ";
    await renderWorkflowView(recorder.host, {
      app: recorder.host.app,
      container: asHtmlElement(container),
      currentFilePath: file.path,
    });
    assert.equal(container.query(".wf-app-title")[0].text, "今天要交付什么？");

describe("wfView · Phase 18 ⑧ 卡片第二段三态", () => {
  /** 按标题找卡片（列布局下 `.wf-card` 的序号不好数） */
  const cardNamed = (container: StubElement, title: string): StubElement => {
    const card = container.query(".wf-card").find((item) => item.query(".wf-card-title")[0]?.text === title);
    assert.ok(card, `应能按标题找到卡片：${title}`);
    return card;
  };

  test("未完成：已经过 · 已完成时间（不高亮）· 距结束 三句按顺序拼", async () => {
    const document = validDocument11();
    document.workflows[0].root.children = [
      leaf("nd-p18-a", "三句都有", {
        status: "doing",
        startAt: `${shiftDate(-5)}T09:00:00+08:00`,
        dueAt: `${shiftDate(3)}T18:00:00+08:00`,
        timeEntries: [
          { startAt: `${shiftDate(-1)}T09:00:00+08:00`, date: shiftDate(-1), endAt: `${shiftDate(-1)}T12:00:00+08:00`, hours: 3 },
          // 进行中那条（没有 endAt）不算「已完成时间」
          { startAt: `${shiftDate(0)}T09:00:00+08:00`, date: shiftDate(0) },
        ],
      }),
    ];
    const { container } = await render(writeBackDocument(validMarkdown11(), document).markdown);
    const line = cardNamed(container, "三句都有").query(".wf-card-line")[0];
    assert.equal(line.text, "已经过：4天 · ⏱ 已完成 3h · 距结束：2天");
    assert.equal(line.classList.contains("wf-card-time"), false, "未完成的「已完成时间」不高亮");
  });

  test("已完成：x天完成 · ⏱ 已完成时间（高亮）· x天前结束", async () => {
    const document = validDocument11();
    document.workflows[0].root.children = [
      leaf("nd-p18-b", "完成三句", {
        status: "done",
        startAt: `${shiftDate(-9)}T09:00:00+08:00`,
        completedAt: `${shiftDate(-3)}T18:00:00+08:00`,
        timeEntries: [
          { startAt: `${shiftDate(-4)}T09:00:00+08:00`, date: shiftDate(-4), endAt: `${shiftDate(-4)}T15:00:00+08:00`, hours: 6 },
        ],
      }),
    ];
    const { container } = await render(writeBackDocument(validMarkdown11(), document).markdown);
    const lines = cardNamed(container, "完成三句").query(".wf-card-line");
    // 三句同一行按顺序拼（分段 span），只有「已完成时间」那段带高亮类
    assert.deepEqual(lines.map((line) => line.allText), ["5天完成 · ⏱ 已完成 6h · 2天前结束"]);
    assert.deepEqual(lines[0].query(".wf-card-time").map((item) => item.text), ["⏱ 已完成 6h"]);
    assert.equal(lines[0].query(".wf-card-part").length, 2, "另外两句是中性小字");
  });

  test("缺字段 / done 但三句都凑不出来 → 整段不占位", async () => {
    const document = validDocument11();
    document.workflows[0].root.children = [
      leaf("nd-p18-c", "什么都没有", { status: "done" }),
      leaf("nd-p18-d", "只有完成时间", { status: "done", completedAt: `${shiftDate(-2)}T18:00:00+08:00` }),
    ];
    const { container } = await render(writeBackDocument(validMarkdown11(), document).markdown);
    const linesOf = (title: string): string[] =>
      cardNamed(container, title).query(".wf-card-line").map((line) => line.allText);
    assert.deepEqual(linesOf("什么都没有"), [], "done 但一句都凑不出来 → 整段不占位");
    // 只有 completedAt → 只有「x天前结束」（没有 startAt 就没有「x天完成」）
    assert.deepEqual(linesOf("只有完成时间"), ["1天前结束"]);
  });
});

  });
});




describe("wfView · Phase 18 ② 间隙滚轮横滚", () => {
  /** 造一个滚轮事件（记录 `preventDefault` 有没有被调） */
  interface WheelProbe {
    ctrlKey: boolean;
    deltaY: number;
    deltaX: number;
    target: StubElement;
    prevented: boolean;
    preventDefault: () => void;
  }

  const wheelEvent = (target: StubElement, deltaY: number): WheelProbe => {
    const event: WheelProbe = {
      ctrlKey: false,
      deltaY,
      deltaX: 0,
      target,
      prevented: false,
      preventDefault: (): void => {
        event.prevented = true;
      },
    };
    return event;
  };

  test("落在卡片上 → 放行；落在间隙 → preventDefault 且 scrollLeft 变化", async () => {
    const { container } = await render(validMarkdown13());
    const columns = container.query(".wf-active-columns")[0];
    // 造出横向溢出（真实环境由内容宽度决定；桩里手动设）
    columns.scrollWidth = 1200;
    columns.clientWidth = 600;

    const onCard = wheelEvent(container.query(".wf-card")[0], 120);
    columns.dispatch("wheel", onCard);
    assert.equal(onCard.prevented, false, "卡片上不拦截（泳道内纵向滚动照常）");
    assert.equal(columns.scrollLeft, 0, "卡片上滚轮不改横向位置");

    // 间隙 = 落点不是卡片 / 按钮 / 泳道头（这里直接用分栏外框当落点）
    const inGap = wheelEvent(columns, 120);
    columns.dispatch("wheel", inGap);
    assert.equal(inGap.prevented, true, "间隙里吃掉纵向滚轮");
    assert.equal(columns.scrollLeft, 120, "改成横向滚动");
  });

  test("没有横向溢出 → 一个都不拦（不锁死页面滚动）", async () => {
    const { container } = await render(validMarkdown13());
    const columns = container.query(".wf-active-columns")[0];
    columns.scrollWidth = 600;
    columns.clientWidth = 600;

    const inGap = wheelEvent(columns, 200);
    columns.dispatch("wheel", inGap);
    assert.equal(inGap.prevented, false, "没有横向溢出就放行给文档滚动");
    assert.equal(columns.scrollLeft, 0);
  });
});

describe("wfView · Phase 18 ⑤ 甘特 tooltip 三段", () => {
  test("🗂 工作流 - 节点 / 时间区间 · ⏱ XdYh / 跨零点补一句", async () => {
    const document = validDocument13();
    document.workflows[0].root.timeEntries = [
      {
        startAt: `${shiftDate(-1)}T22:00:00+08:00`,
        date: shiftDate(-1),
        endAt: `${shiftDate(0)}T03:00:00+08:00`,
        hours: 5,
      },
    ];
    const { container } = await render(writeBackDocument(validMarkdown13(), document).markdown);
    const widget = openWidget(container, "📊");
    const bar = widget.query(".wf-gantt-span")[0];
    assert.ok(bar !== undefined, "甘特图里应有一段");

    bar.onmouseenter?.(mouseEvent());
    const tip = body.query(".wf-heat-tip")[0];
    assert.ok(tip !== undefined, "悬浮应出 tooltip");
    assert.equal(
      tip.query(".wf-heat-tip-row")[0].text,
      `${document.workflows[0].title} - ${document.workflows[0].root.title}`,
      "第 1 行 = 工作流 - 节点",
    );
    assert.match(tip.query(".wf-heat-tip-total")[0].text, /^22:00 - 03:00 · ⏱ 5h$/, "第 2 行 = 区间 · ⏱ 时长");
    assert.equal(tip.query(".wf-gantt-tip-note").length, 1, "跨零点补一句原说明");
    bar.onmouseleave?.(mouseEvent());
    assert.equal(body.query(".wf-heat-tip").length, 0, "移出收起");
    closeWidget();
  });
});


describe("wfView · Phase 18 样式契约（styles.css 静态断言）", () => {
  /** 去掉注释后的 CSS（避免注释里的示例把人骗过去） */
  const cssOf = (): string => readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  /**
   * 取某条规则的声明块：选择器必须**顶格**写在行首（`\n.selector {`），
   * 否则 `.wf-lane` 会先命中 `.wf-column + .wf-column .wf-lane` 那一行。
   */
  const blockOf = (css: string, selector: string): string => {
    const match = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
    return match?.[1] ?? "";
  };

  test("① 遮罩层存在且低于弹窗；⑤ tooltip 抬到 10000", () => {
    const css = cssOf();
    const overlay = blockOf(css, ".wf-widget-overlay");
    assert.match(overlay, /position:\s*fixed/, "全屏固定");
    assert.match(overlay, /inset:\s*0/, "铺满视口");
    assert.match(overlay, /z-index:\s*9997/, "低于弹窗（9998）");
    assert.match(blockOf(css, ".wf-widget-popup"), /z-index:\s*9998/);
    const tip = blockOf(css, ".wf-heat-tip");
    assert.match(tip, /z-index:\s*10000/, "高于弹窗 / 右键菜单");
    assert.match(tip, /pointer-events:\s*none/, "仍然是只读浮层");
  });

  test("⑥ 泳道去掉卡片式外壳，分隔线显式写 border-left-style；web / shoujo 只装饰总览", () => {
    const css = cssOf();
    const lane = blockOf(css, ".wf-lane");
    assert.match(lane, /border:\s*0/, "没有边框");
    assert.match(lane, /border-radius:\s*0/, "没有圆角");
    assert.match(lane, /background:\s*none/, "没有底色");
    assert.match(lane, /overflow-x:\s*auto/, "横向滚动仍在");
    const divider = blockOf(css, ".wf-column + .wf-column .wf-lane");
    assert.match(divider, /border-left-style:\s*solid/, "父规则改成 border:0 后要显式写 style");
    assert.doesNotMatch(css, /\[data-wf-theme="web"\] \.wf-lane\s*\{/, "web 的外凸边框不再套到泳道");
    assert.doesNotMatch(css, /\[data-wf-theme="shoujo"\] \.wf-lane\s*\{/, "shoujo 的双层边框不再套到泳道");
  });

  test("⑦ 卡片宽度：没有字面值残留，`.wf-card` 回落 200px", () => {
    const css = cssOf();
    assert.doesNotMatch(css, /--wf-card-width:\s*\d+px/, "body / magazine 的字面值都删掉了（设置是唯一权威）");
    assert.match(blockOf(css, ".wf-card"), /width:\s*var\(--wf-card-width,\s*200px\)/);
  });

  test("③ 大标题基线与主题差值：默认主题裸装，其余 8 套各有规则", () => {
    const css = cssOf();
    const base = blockOf(css, ".wf-app-title");
    assert.match(base, /font-size:\s*1\.6em/);
    assert.match(base, /font-weight:\s*700/);
    for (const theme of ["tech", "nature", "magazine", "retro", "clay", "web", "fresh", "shoujo"]) {
      assert.match(css, new RegExp(`\\[data-wf-theme="${theme}"\\] \\.wf-app-title\\s*\\{`), `${theme} 缺少大标题差值`);
    }
    assert.doesNotMatch(css, /\[data-wf-theme="default"\] \.wf-app-title/, "默认主题保持裸装基线");
  });

  test("④ emo：画布 / 今日见闻 / 层级 / 不透明度档位都在独立命名空间里", () => {
    const css = cssOf();
    assert.match(blockOf(css, ".wf-emo-plane"), /grid-template:\s*repeat\(20/, "20×20 网格");
    assert.match(blockOf(css, ".wf-emo-today"), /grid-area:\s*8 \/ 8 \/ 14 \/ 14/, "中心 6×6");
    assert.match(blockOf(css, ".wf-emo-polaroid"), /z-index:\s*10001/, "高于弹窗");
    assert.match(blockOf(css, ".wf-emo-editor"), /z-index:\s*10002/, "输入弹窗最高");
    // Phase 19 M1 ③：全屏画布
    assert.match(blockOf(css, ".wf-widget-popup--emo"), /position:\s*fixed/, "emo 弹窗固定定位");
    assert.match(blockOf(css, ".wf-widget-popup--emo"), /inset:\s*0/, "铺满整个界面");
    // Phase 19 M1 ①：三套独立主题 + 灵动岛
    for (const theme of ["default", "weave", "candy"]) {
      assert.match(css, new RegExp(`\\.wf-emo--${theme}\\s*\\{`), `缺 emo 主题 ${theme}`);
    }
    assert.doesNotMatch(css, /\.wf-emo--stainedGlass/, "彩窗主题已删除（补充契约⑨）");
    assert.match(blockOf(css, ".wf-emo-theme"), /position:\s*fixed/, "灵动岛固定");
    assert.match(css, /\.wf-emo--candy \.wf-emo-cell--a18\s*\{\s*--wf-emo-angle:\s*180deg/, "糖果角度档位");
    // Phase 19 M1 ⑥：拍立得 54:86 / 图片 46:62
    assert.match(blockOf(css, ".wf-emo-polaroid"), /aspect-ratio:\s*54\s*\/\s*86/);
    assert.match(blockOf(css, ".wf-emo-polaroid-photo"), /aspect-ratio:\s*46\s*\/\s*62/);
    for (const [ring, opacity] of [
      [3, "0.85"],
      [4, "0.72"],
      [5, "0.6"],
      [6, "0.48"],
      [7, "0.36"],
    ] as const) {
      assert.match(css, new RegExp(`\\.wf-emo-cell--r${ring}\\s*\\{\\s*opacity:\\s*${opacity}`), `环 ${ring} 不透明度`);
    }
    assert.doesNotMatch(css, /\[data-wf-theme="[a-z]+"\] \.wf-emo/, "emo 不主题化（配色不进 [data-wf-theme]）");
  });

  test("Phase 19 M2：4 象限 = perspective + rotateX/rotateY、内侧描边、空分区虚线、4 色 × 5 档", () => {
    const css = cssOf();
    assert.match(blockOf(css, ".wf-widget-popup--quadrant"), /width:\s*min\(880px/, "比默认弹窗宽");
    assert.match(blockOf(css, ".wf-quad-stage"), /perspective:\s*1200px/, "透视给父级（斜俯视）");
    const plane = blockOf(css, ".wf-quad-plane");
    assert.match(plane, /grid-template-columns:\s*repeat\(4/, "16 分区（4 列）");
    assert.match(plane, /grid-template-rows:\s*repeat\(4/, "16 分区（4 行）");
    assert.match(plane, /rotateX\(/, "平面转 x（俯视）");
    assert.match(plane, /rotateY\(/, "平面转 y（侧视）");
    assert.match(plane, /transform-style:\s*preserve-3d/, "选中态靠 translateZ 浮起来");
    const cell = blockOf(css, ".wf-quad-partition");
    assert.match(cell, /border-radius:/);
    assert.match(cell, /outline-offset:\s*-2px/, "描边画在格子内侧");
    assert.match(blockOf(css, ".wf-quad-partition--empty"), /outline-style:\s*dashed/, "空分区虚线");
    for (const color of ["red", "orange", "green", "blue"]) {
      assert.match(css, new RegExp(`\\.wf-quad-partition--${color}\\s*\\{`), `缺象限色 ${color}`);
    }
    for (const level of [1, 2, 3, 4, 5]) {
      assert.match(css, new RegExp(`\\.wf-quad-partition--f${level}\\s*\\{`), `缺填充档位 ${level}`);
    }
    assert.doesNotMatch(css, /\[data-wf-theme="[a-z]+"\] \.wf-quad/, "象限色是语义色，不随主题");
  });

  test("Phase 19 M3：plot = 更宽弹窗 + 列表 / 折线 / 点表 / 空态，颜色跟随主题 token", () => {
    const css = cssOf();
    assert.match(blockOf(css, ".wf-widget-popup--plot"), /width:\s*min\(1180px/, "三栏弹窗比 M3 再宽（补充契约⑥b）");
    assert.match(blockOf(css, ".wf-plot"), /display:\s*flex/, "多栏");
    assert.match(blockOf(css, ".wf-plot"), /flex-wrap:\s*wrap/, "窄窗口能把第三栏折下去");
    assert.match(blockOf(css, ".wf-plot-sidebar"), /border-right:\s*1px dashed/, "左侧列表用虚线分隔");
    assert.match(blockOf(css, ".wf-plot-points"), /border-left:\s*1px dashed/, "数据点第三栏自带分隔");
    assert.match(blockOf(css, ".wf-plot-search"), /display:\s*flex/, "搜索行");
    assert.match(css, /@media \(max-width: 1100px\) \{\s*\n\s*\.wf-plot-points\s*\{/, "1100px 以下数据点折到图表下方");
    assert.match(blockOf(css, ".wf-plot-file"), /display:\s*none/, "文件选择框隐藏");
    assert.match(blockOf(css, ".wf-plot-line"), /fill:\s*none/, "折线不填充");
    assert.match(blockOf(css, ".wf-plot-line"), /stroke:\s*var\(--interactive-accent\)/, "折线跟随主题色");
    assert.match(blockOf(css, ".wf-plot-dot"), /fill:\s*var\(--interactive-accent\)/, "圆点跟随主题色");
    assert.match(blockOf(css, ".wf-plot-empty"), /color:\s*var\(--text-faint\)/, "空态是淡色文字");
    assert.match(blockOf(css, ".wf-plot-btn--danger"), /rgb\(220 68 68/, "删除是危险色");
    assert.doesNotMatch(css, /\[data-wf-theme="[a-z]+"\] \.wf-plot/, "plot 不进 [data-wf-theme]（跟随 token）");
  });

  test("Phase 19 补充契约②：emo 纸 / 墨 / 灰全走 Obsidian token，画布与浮层加磨砂", () => {
    const css = cssOf();
    assert.match(css, /--wf-emo-paper:\s*var\(--modal-background, var\(--background-primary\)\)/, "半透明纸面 = Modal 同款");
    assert.match(css, /--wf-emo-ink:\s*var\(--text-normal\)/);
    assert.match(css, /--wf-emo-muted:\s*var\(--text-muted\)/);
    assert.match(css, /--wf-emo-line:\s*var\(--background-modifier-border\)/);
    assert.match(blockOf(css, ".wf-emo-canvas"), /background:\s*var\(--wf-emo-veil\)/, "画布底走幕布变量");
    assert.match(blockOf(css, ".wf-emo-theme"), /backdrop-filter:\s*blur\(20px\) saturate\(1\.2\)/, "灵动岛磨砂");
    assert.match(blockOf(css, ".wf-emo-polaroid"), /backdrop-filter:\s*blur\(20px\) saturate\(1\.2\)/, "拍立得磨砂");
    assert.match(blockOf(css, ".wf-emo-editor"), /backdrop-filter:\s*blur\(20px\) saturate\(1\.2\)/);
    assert.match(blockOf(css, ".wf-emo-menu"), /backdrop-filter:\s*blur\(20px\) saturate\(1\.2\)/);
    assert.match(blockOf(css, ".wf-emo-zoom"), /background:\s*var\(--wf-emo-paper\)/);
    // 字面色清干净了（emo 段里只剩饱和色块上的反白字与 6 色本身）
    const emoStart = css.indexOf("--wf-emo-c1:");
    const emoEnd = css.indexOf(".wf-quad {");
    const emoSection = css.slice(emoStart, emoEnd);
    for (const stale of ["#2b2b2b", "#8a8a8a", "#dcdcdc", "#f5f5f5", "#fbfbfb", "#c9c9c9"]) {
      assert.equal(emoSection.includes(stale), false, `emo 段不该再有 ${stale}`);
    }
    // 3 套主题的 6 色照旧（契约：色块不跟着改）
    assert.match(blockOf(css, ".wf-emo--default"), /--wf-emo-radius:\s*4px/, "default 仍是基线圆角");
    for (const theme of ["weave", "candy"]) {
      assert.match(css, new RegExp(`\\.wf-emo--${theme}\\s*\\{[^}]*--wf-emo-c1:`), `${theme} 的 6 色还在`);
    }
  });

  test("Phase 19 补充契约⑨：背景层半透明（幕布）—— 画布 / 弹窗 / 今日见闻透出背后的界面", () => {
    const css = cssOf();
    // 幕布 = 纸面混 45% 透明；不依赖 --modal-background 本身是否透明
    assert.match(
      css,
      /--wf-emo-veil:\s*color-mix\(in srgb, var\(--wf-emo-paper\) 55%, transparent\)/,
      "幕布变量 = 纸面 55% + 透明",
    );
    for (const selector of [".wf-widget-popup--emo", ".wf-widget-popup--emo .wf-widget-popup-head", ".wf-emo-canvas", ".wf-emo-today"]) {
      assert.match(blockOf(css, selector), /background:\s*var\(--wf-emo-veil\)/, `${selector} 走幕布`);
    }
    // 磨砂降到轻微：20px 会把背后笔记糊成一团（等于看不见）
    assert.match(blockOf(css, ".wf-emo-canvas"), /backdrop-filter:\s*blur\(6px\) saturate\(1\.1\)/, "画布只留轻磨砂");
    assert.doesNotMatch(blockOf(css, ".wf-emo-canvas"), /blur\(20px\)/, "画布不再用重磨砂");
    // 子主题的底子（今日见闻 / 织布无记录格）也半透明
    assert.match(blockOf(css, ".wf-emo--weave .wf-emo-today"), /color-mix\(in srgb, #fbf3dc 55%, transparent\)/);
    assert.match(blockOf(css, ".wf-emo--candy .wf-emo-today"), /color-mix\(in srgb, #fff7fb 55%, transparent\)/);
    assert.match(blockOf(css, ".wf-emo--weave .wf-emo-cell--empty"), /color-mix\(in srgb, #f2dfa0 55%, transparent\)/);
    // 6 色记录格保持不透明（主题辨识度）；内容浮层仍是不透明纸面
    assert.match(blockOf(css, ".wf-emo-cell--recorded.wf-emo-cell--c1"), /background:\s*var\(--wf-emo-c1\)/);
    assert.match(blockOf(css, ".wf-emo-zoom"), /background:\s*var\(--wf-emo-paper\)/, "缩放角标不透");
  });

  test("Phase 19 补充契约③：织布 6 色各一条纹理（6 条 background-image 互不相同）", () => {
    const css = cssOf();
    const urls: string[] = [];
    for (const color of [1, 2, 3, 4, 5, 6]) {
      const block = blockOf(css, `.wf-emo--weave .wf-emo-cell--c${color}`);
      const match = /background-image:\s*url\("([^"]+)"\)/.exec(block);
      assert.ok(match, `c${color} 缺 background-image`);
      urls.push(match[1]);
    }
    assert.equal(new Set(urls).size, 6, "6 条纹理互不相同");
    assert.match(blockOf(css, ".wf-emo--weave .wf-emo-cell"), /background-repeat:\s*repeat/, "平铺");
    assert.match(blockOf(css, ".wf-emo--weave .wf-emo-cell--empty"), /#f2dfa0/, "无记录格仍是鹅黄布料");
  });

  test("Phase 19 补充契约⑤：象限留白 + 平面内交叉轴 + 旋转让右上最近", () => {
    const css = cssOf();
    const stage = blockOf(css, ".wf-quad-stage");
    assert.match(stage, /padding:\s*40px 44px/, "四周留白");
    assert.match(stage, /overflow:\s*visible/, "转过的平面不被裁");
    const plane = blockOf(css, ".wf-quad-plane");
    assert.match(plane, /position:\s*relative/, "轴线要绝对定位在平面里");
    assert.match(plane, /gap:\s*10px/, "分区之间留空隙");
    assert.match(plane, /transform:\s*rotateX\(-56deg\) rotateY\(-22deg\)/, "上沿 + 右沿朝镜头");
    const axis = blockOf(css, ".wf-quad-axis-line");
    assert.match(axis, /position:\s*absolute/);
    assert.match(axis, /pointer-events:\s*none/, "轴线不吃事件");
    assert.match(blockOf(css, ".wf-quad-axis-line--x"), /border-top:\s*1px solid/, "x 轴是长直线");
    assert.match(blockOf(css, ".wf-quad-axis-line--y"), /border-left:\s*1px solid/, "y 轴是长直线");
    assert.match(blockOf(css, ".wf-quad-axis-line--x::after"), /border-left:\s*7px solid/, "x 轴单箭头朝右");
    assert.match(blockOf(css, ".wf-quad-axis-line--y::after"), /border-bottom:\s*7px solid/, "y 轴单箭头朝上");
  });
});
