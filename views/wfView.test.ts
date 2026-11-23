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
import { after, afterEach, describe, test } from "node:test";

import type { App, TFile } from "obsidian";

import {
  NODE_STATUSES,
  STATUS_LABELS,
  TIMER_INVALID_START_MESSAGE,
  analyzeMarkdown,
  formatLocalDate,
  recentDateKeys,
  startTimerEntry,
  t,
  walkWorkflow,
  writeBackDocument,
  type ArchiveFileMeta,
  type LinkedFile,
  type NodeAffiliationRef,
  type WfJsonDocument,
  type WfNode,
  type WfWorkflow,
} from "../src/engine/index.ts";
import {
  ARCHIVE_FILE,
  ARCHIVE_ROOT_ID,
  ARCHIVE_WF_ID,
  ARCHIVED_WF_TITLE,
  CHILD_ID,
  DOING_ID,
  ROOT_ID,
  TIME_ARCHIVED_AT,
  WF1_ID,
  clone,
  leaf,
  validDocument11,
  validDocument13,
  validMarkdown,
  validMarkdown11,
  validMarkdown13,
  VALID_BODY_11,
  VALID_FRONTMATTER_11,
  wfjsonBlockOnly,
} from "../src/engine/testFixtures.ts";
import {
  asHtmlElement,
  clearScrollHeightPresets,
  installDomStub,
  presetScrollHeight,
  StubElement,
  type StubMouseEvent,
} from "./testDomStub.ts";
import {
  boardTitleOf,
  closeWidgetPopup,
  forgetViewScroll,
  isViewApi,
  rememberViewScroll,
  renderWorkflowView,
  resolveDrop,
  stopTimerTicker,
  type WfPanelTab,
  type WfViewHost,
} from "./wfView.ts";

/**
 * Phase 25（M4）：面板入口替身。
 *
 * `WfViewHost.openNodePanel` 是**泛型方法**（`tab` → 结果类型），而替身要按 tab 分派到
 * 不同的具体结果 —— 收口成这一个断言 helper，视图 / 插件代码里零断言。
 */
function panelStub(
  impl: (
    file: TFile,
    node: WfNode | undefined,
    tab: WfPanelTab,
    workflow?: WfWorkflow,
  ) => Promise<{ cancelled: boolean; result?: unknown }>,
): WfViewHost["openNodePanel"] {
  return impl as unknown as WfViewHost["openNodePanel"];
}

const body = installDomStub();

const file = { path: "test.md", basename: "test", extension: "md" } as unknown as TFile;

/** D 案：模块级的滚动状态 / 会话按 `file.path` 分桶，用例之间必须清干净（别让上一例的位置漏进来） */
afterEach(() => forgetViewScroll(file.path));

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
  /** Phase 24：归档跳转 → `host.openArchiveBoard(path)` 的调用记录 */
  archiveBoardCalls: string[];
  /** Phase 39：按 workflow id 开归档看板（`host.openArchiveBoardByWorkflowId`）的调用记录 */
  archiveBoardByIdCalls: string[];
  /** Phase 22：整条工作流归档入口的调用记录 */
  workflowArchiveCalls: { workflowId: string; title: string }[];
  /** Phase 39：编辑归档文件元数据入口的调用记录（传的是归档文件路径） */
  archiveMetaCalls: { path: string }[];
  /** Phase 5：编辑节点信息 / 修改工作流入口的调用记录 */
  infoCalls: { nodeId: string }[];
  /** Phase 20：设置 note 节点入口的调用记录 */
  noteCalls: { nodeId: string }[];
  /** Phase 20 修订：note 方框点击（待办 ↔ 已办）的调用记录 */
  noteToggleCalls: { nodeId: string; index: number }[];
  workflowEditCalls: { filePath: string }[];
  /** Phase 15：拖拽改节点顺序的调用记录 */
  moveCalls: { movingId: string; targetId: string; position: string; keepSubtree: boolean }[];
  /** Phase 21 ⑤：折叠三角点击（写 JSON 的 `collapsed`）的调用记录 */
  collapseCalls: { nodeId: string; collapsed: boolean }[];
  /** Phase 21 ⑤：`analyzeFile` 被调了几次（开关「原位切换」不许引来重渲染） */
  analyzeCalls: { count: number };
  /** Phase 6/9：主题切换入口的调用记录（点一次按钮记「文件路径 + key」） */
  themeCalls: { path: string; theme: string }[];
  /** Phase 16：侧边栏 ⚙️ → `host.openSettings()` 的调用记录 */
  settingsCalls: number[];
  /** Phase 26：`host.exportData(file)` 的调用记录（记 `file.path`） */
  exportCalls: string[];
  /** Phase 26：`host.importData(file, jsonPath)` 的调用记录（记 json 路径） */
  importCalls: string[];
  /** Phase 37：`host.importJsonPaths(file, paths, mode)` 的调用记录 */
  importPathCalls: { paths: string[]; mode: string }[];
  /** Phase 37：`host.copyText(text)` 的调用记录 */
  copyCalls: string[];
  /** Phase 37：`host.pickImportJsonPaths()` 被调了几次 */
  pickCalls: number[];
  /** Phase 37：`host.archiveBoardFiles()` 的返回值（用例改这里造「磁盘上有 N 份归档」） */
  archiveFixture: { files: string[] };
  /** Phase 39：`host.archiveTags()` 的返回值（= 启动缓存快照；用例改这里造「缓存里有 N 个标签」） */
  archiveTagFixture: { tags: string[] };
  /** Phase 41：`host.refreshArchiveTags()` 的返回值（= 现读结果；和缓存放不同值才能证明「现读」） */
  archiveTagRefreshResult: { tags: string[] };
  /** Phase 41：`host.refreshArchiveTags()` 被调了几次（打开「已归档」弹窗 / 切进该页各一次） */
  archiveTagRefreshes: number[];
  /** Phase 39：`host.readArchiveMeta(path)` 的返回值（键 = 归档文件 vault 路径） */
  archiveMetaFixture: { metas: Record<string, ArchiveFileMeta | undefined> };
  /** Phase 37：`host.boardJsonPaths()` 的返回值（导出清单） */
  boardJsonFixture: { paths: string[] };
  /** Phase 37：`host.pickImportJsonPaths()` 的返回值（用例改这里模拟「选了 N 个文件」） */
  pickResult: { paths: string[] };
  /** Phase 27 M2：未分类列「＋ 新建节点」/ 列头落点的调用记录（`theme` = 跟着面板走的主题） */
  unclassifiedChildCalls: { filePath: string; theme?: string }[];
  attachUnclassifiedCalls: { nodeId: string }[];
  /** Phase 27 M3：资料查询（反向索引）与打开资料的调用记录 */
  linkedCalls: NodeAffiliationRef[];
  openLinkedCalls: string[];
  /** Phase 34：面板 tab 6「编辑节点链接文档」的调用记录 */
  linkDocsCalls: { nodeId: string }[];
  /** Phase 27 M3：`host.linkedFiles` 的返回值（用例改这里就能造「有 N 份资料」） */
  linkFixture: { files: LinkedFile[] };
  /** 假文件内容：测试里可以改（模拟插件写回落盘 → 验证局部刷新） */
  state: { markdown: string };
}

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
  /** Phase 24：归档跳转（点归档链接 / 菜单里的「打开归档文件」）→ 宿主开归档看板 */
  const archiveBoardCalls: string[] = [];
  /** Phase 39：按 workflow id 开归档看板 */
  const archiveBoardByIdCalls: string[] = [];
  /** Phase 22：整条工作流归档入口的调用记录 */
  const workflowArchiveCalls: { workflowId: string; title: string }[] = [];
  const archiveMetaCalls: { path: string }[] = [];
  const infoCalls: { nodeId: string }[] = [];
  /** Phase 20：note 卡片入口的调用记录 */
  const noteCalls: { nodeId: string }[] = [];
  /** Phase 20 修订：note 方框点击的调用记录 */
  const noteToggleCalls: { nodeId: string; index: number }[] = [];
  const workflowEditCalls: { filePath: string }[] = [];
  const moveCalls: { movingId: string; targetId: string; position: string; keepSubtree: boolean }[] = [];
  /** Phase 21 ⑤：折叠三角 → 写 JSON 的调用记录（默认 success + changed） */
  const collapseCalls: { nodeId: string; collapsed: boolean }[] = [];
  /** Phase 21 ⑤：`analyzeFile` 次数（渲染会调；开关原位切换不应增加） */
  const analyzeCalls = { count: 0 };
  /** Phase 6：主题清单与当前主题（`setTheme` 只改桩状态，真实插件会写 data.json + `<html>` 属性） */
  const themeCalls: { path: string; theme: string }[] = [];
  /** Phase 16：⚙️ 按钮直接开插件设置页（不弹窗） */
  const settingsCalls: number[] = [];
  /** Phase 26：导出入口的调用记录（`host.exportData(file)` 的 `file.path`） */
  const exportCalls: string[] = [];
  /** Phase 26：导入入口的调用记录（视图把输入的 json 路径原样交给插件） */
  const importCalls: string[] = [];
  /** Phase 37：批量导入 / 剪贴板 / 文件选择 的调用记录与假数据 */
  const importPathCalls: { paths: string[]; mode: string }[] = [];
  const copyCalls: string[] = [];
  const pickCalls: number[] = [];
  const archiveFixture: { files: string[] } = { files: [] };
  // Phase 41：`archiveTags()` 的返回（缓存快照）与 `refreshArchiveTags()` 的返回（现读结果）
  // 故意分成两份：两者不同值才能断言「视图用的是现读那一份」。
  const archiveTagFixture: { tags: string[] } = { tags: [] };
  const archiveTagRefreshResult: { tags: string[] } = { tags: [] };
  const archiveTagRefreshes: number[] = [];
  const archiveMetaFixture: { metas: Record<string, ArchiveFileMeta | undefined> } = { metas: {} };
  const boardJsonFixture: { paths: string[] } = { paths: ["/vault/_workflowwatcher/main~0a1b2c3d4e.wf.json"] };
  const pickResult: { paths: string[] } = { paths: [] };
  /** Phase 27 M2：未分类列两个入口的调用记录（默认「取消」，需要断言的用例自己换实现） */
  const unclassifiedChildCalls: { filePath: string; theme?: string }[] = [];
  const attachUnclassifiedCalls: { nodeId: string }[] = [];
  /** Phase 27 M3：资料查询 / 打开资料的调用记录（`linkFixture.files` 决定卡片上的 🔗 计数） */
  const linkedCalls: NodeAffiliationRef[] = [];
  const openLinkedCalls: string[] = [];
  /** Phase 34：面板 tab 6「编辑节点链接文档」的调用记录 */
  const linkDocsCalls: { nodeId: string }[] = [];
  const linkFixture: { files: LinkedFile[] } = { files: [] };
  const state = { markdown };
  /** Phase 18 / 19：视图读的设置项（标题 / plot 目录 / note 条数）—— 测试里可改 */
  const settings = {
    resumePrompt: "",
    plotFolder: "plots",
    /** Phase 20：note 卡片最多显示几条（视图 `renderNoteCard` 按它 slice） */
    noteLines: 3,
  };

  const host: WfViewHost = {
    app: {
      vault: { getAbstractFileByPath: () => file, getFiles: () => [] },
      workspace: { getActiveFile: () => file, openLinkText: async () => undefined },
    } as unknown as App,
    analyzeFile: async () => {
      analyzeCalls.count += 1;
      return analyzeMarkdown(state.markdown, { file: file.path });
    },
    setNodeStatus: async (_file, nodeId, status) => {
      statusCalls.push({ nodeId, status });
      return { success: true, changed: true, issues: [], nodeId, status };
    },
    /**
     * Phase 25（M4）：节点操作统一入口（右侧面板）。
     * 替身按 tab 分派到原各入口的记录数组 / 返回值 —— 老用例的 `childCalls` / `deleteCalls` /
     * `archiveCalls` / `workflowArchiveCalls` / `infoCalls` / `workflowEditCalls` 断言全部照旧。
     */
    openNodePanel: panelStub(async (_file, node, tab, workflow) => {
      const nodeId = node?.id ?? "";
      switch (tab) {
        case "info":
          infoCalls.push({ nodeId });
          return { cancelled: true };
        case "note":
          // Phase 36：note 节点并入面板 tab（原独立弹窗）
          noteCalls.push({ nodeId });
          return { cancelled: true };
        case "child":
          childCalls.push({ nodeId });
          return {
            cancelled: false,
            result: {
              success: true,
              changed: true,
              issues: [],
              nodeId,
              changedNodeIds: [nodeId],
              childId: "nd-stub-child",
            },
          };
        case "delete":
          deleteCalls.push({ nodeId });
          return {
            cancelled: false,
            result: {
              success: true,
              changed: true,
              issues: [],
              nodeId,
              changedNodeIds: [nodeId],
              parentId: "nd-uuid-001",
            },
          };
        case "archive":
          if (workflow !== undefined) {
            workflowArchiveCalls.push({ workflowId: workflow.id, title: workflow.title });
            return { cancelled: true };
          }
          archiveCalls.push({ nodeId });
          return { cancelled: true };
        case "workflow":
          workflowEditCalls.push({ filePath: _file.path });
          return { cancelled: true };
        case "links":
          // Phase 34：tab 6 默认「取消」（只看不改）
          linkDocsCalls.push({ nodeId });
          return { cancelled: true };
      }
    }),
    // Phase 39：编辑归档文件元数据入口（默认取消；参数是归档文件路径）
    openArchiveMetaEditor: async (path) => {
      archiveMetaCalls.push({ path });
      return { cancelled: true };
    },
    // Phase 39：读归档文件元数据（懒加载；用例改 `archiveMetaFixture.metas` 造内容）
    readArchiveMeta: async (path) => archiveMetaFixture.metas[path],
    // Phase 24：归档跳转改走宿主（插件把它开成归档看板，不再 openLinkText）
    openArchiveBoard: (path) => {
      archiveBoardCalls.push(path);
    },
    // Phase 39：按 workflow id 开归档看板（节点侧 archive 只剩 workflowId）
    openArchiveBoardByWorkflowId: (workflowId) => {
      archiveBoardByIdCalls.push(workflowId);
    },
    // Phase 27 M2：未分类列（新建复用「加子节点」面板；列头落点 = 整棵子树搬过去）
    // 面板入口要带 `theme`：这条弹窗与「节点右键 → 面板」是同一张 `.wf-side-panel`
    openUnclassifiedChildPanel: async (target, theme) => {
      unclassifiedChildCalls.push({ filePath: target.path, theme });
      return { cancelled: true };
    },
    attachNodeToUnclassified: async (_target, nodeId) => {
      attachUnclassifiedCalls.push({ nodeId });
      return { ok: true, changedNodeIds: [nodeId] };
    },
    // Phase 27 M3：资料归属（默认「没有资料」；用例改 `linkFixture.files` 造命中）
    // 语义与引擎 `resolveLinkedFiles` 一致：id 精确命中优先，再按「工作流标题::节点标题」兜底。
    linkedFiles: (ref) => {
      linkedCalls.push(ref);
      const byId = linkFixture.files.filter((item) => ref.nodeId !== undefined && item.nodeId === ref.nodeId);
      if (byId.length > 0) return byId;
      return linkFixture.files.filter(
        (item) => item.workflowTitle === ref.workflowTitle && item.nodeTitle === ref.nodeTitle,
      );
    },
    openLinkedFile: (path) => {
      openLinkedCalls.push(path);
    },
    // Phase 20 修订：方框点击（默认按「取消 / 没变」返回，需要断言结果的测试自己换实现）
    toggleNodeNote: async (_file, nodeId, index) => {
      noteToggleCalls.push({ nodeId, index });
      return { success: true, changed: false, issues: [], nodeId, changedNodeIds: [] };
    },
    noteLines: () => settings.noteLines,
    moveNode: async (_file, movingId, targetId, position, options) => {
      moveCalls.push({ movingId, targetId, position, keepSubtree: options?.keepSubtree === true });
      return { success: true, changed: true, issues: [], changedNodeIds: [movingId, targetId] };
    },
    // Phase 21 ⑤：折叠三角 → 写 JSON 的 `collapsed`（默认成功；失败路径由用例自己换实现）
    setNodeCollapsed: async (_file, nodeId, collapsed) => {
      collapseCalls.push({ nodeId, collapsed });
      return { success: true, changed: true, issues: [], nodeId, collapsed, changedNodeIds: [nodeId] };
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
      { key: "default", label: "默认" },
      { key: "tech", label: "科技风" },
      { key: "nature", label: "自然风" },
      { key: "magazine", label: "杂志风" },
      { key: "retro", label: "复古风" },
      { key: "polka", label: "波点风" },
    ],
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
    // Phase 19 M3：plot JSON / CSV 的目录
    plotFolder: () => settings.plotFolder,
    // Phase 26：导入 / 导出入口（视图只发起调用；真实读写 / 弹窗在插件侧）
    exportData: (target) => {
      exportCalls.push(target.path);
    },
    importData: async (_target, jsonPath) => {
      importCalls.push(jsonPath);
    },
    // Phase 37：批量导入 / 导出清单 / 文件选择 / 剪贴板 / 归档全局视角
    importJsonPaths: async (_target, paths, mode) => {
      importPathCalls.push({ paths: [...paths], mode });
    },
    boardJsonPaths: () => [...boardJsonFixture.paths, ...archiveFixture.files.map((path) => `/vault/${path}`)],
    pickImportJsonPaths: async () => {
      pickCalls.push(1);
      return [...pickResult.paths];
    },
    copyText: (text) => {
      copyCalls.push(text);
    },
    archiveBoardFiles: () => [...archiveFixture.files],
    // Phase 39 / 41：标签枚举。`archiveTags` = 启动缓存；`refreshArchiveTags` = 现读
    // （视图在打开「已归档」弹窗时调它，所以这里要能被记录 + 返回最新清单）
    archiveTags: () => [...archiveTagFixture.tags],
    refreshArchiveTags: async () => {
      archiveTagRefreshes.push(1);
      // 真宿主 `refreshArchiveTags` 会顺手刷新缓存（`archiveTags()` 随后返回新值），
      // 所以这里也把缓存换掉 —— 否则重画出来的还是旧枚举，测不到「现读」。
      archiveTagFixture.tags = [...archiveTagRefreshResult.tags];
      return [...archiveTagRefreshResult.tags];
    },
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
    archiveBoardCalls,
    archiveBoardByIdCalls,
    workflowArchiveCalls,
    archiveMetaCalls,
    infoCalls,
    noteCalls,
    noteToggleCalls,
    workflowEditCalls,
    moveCalls,
    collapseCalls,
    analyzeCalls,
    themeCalls,
    settingsCalls,
    exportCalls,
    importCalls,
    importPathCalls,
    copyCalls,
    pickCalls,
    archiveFixture,
    archiveTagFixture,
    archiveTagRefreshResult,
    archiveTagRefreshes,
    archiveMetaFixture,
    boardJsonFixture,
    pickResult,
    unclassifiedChildCalls,
    attachUnclassifiedCalls,
    linkedCalls,
    openLinkedCalls,
    linkDocsCalls,
    linkFixture,
    state,
  };
}

/** 渲染一次，返回容器与记录器 */
function render(markdown: string): Promise<{ container: StubElement; recorder: Recorder }> {
  return renderWith(markdown, () => undefined);
}

/**
 * 渲染前先改桩状态的变体（Phase 27：资料归属由 `host.linkedFiles()` 给，
 * 要断言「有资料 / 几条」就得在渲染前塞 `linkFixture.files`）。
 */
async function renderWith(
  markdown: string,
  setup: (recorder: Recorder) => void,
): Promise<{ container: StubElement; recorder: Recorder }> {
  const container = new StubElement("div");
  const recorder = makeHost(markdown);
  setup(recorder);
  await renderWorkflowView(recorder.host, {
    app: recorder.host.app,
    container: asHtmlElement(container),
    currentFilePath: file.path,
  });
  return { container, recorder };
}

/** 等一轮微任务（changeStatus 里的 await 之后再断言） */
const flush = (): Promise<void> => new Promise((resolve) => window.setTimeout(resolve, 0));

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
 * Phase 16 / Phase 29：导航面板 / 弹窗的辅助
 * 弹窗挂在 `document.body` 上（不在视图容器里），所以断言要在 `body` 里查。
 * ------------------------------------------------------------------ */

/**
 * 小工具按钮的文案（Phase 29：图标侧边栏 `.wf-sidebar` 已拆掉，按钮只剩文字）。
 *
 * 用例仍然按老图标取按钮 —— 图标 → 文案在这里一次性对齐，30 多处调用点不用动。
 * 「已归档」的文案带计数（`已归档（n）`），只按**前缀**匹配。
 */
const WIDGET_LABEL: Record<string, string> = {
  "📊": t("view.widget.gantt21"),
  "🎯": t("view.widget.quadrant"),
  "📈": t("view.widget.plot365"),
  "📦": t("view.block.archived", { count: 0 }).replace(/[（(].*$/, "").trim(),
  "📥": t("view.widget.data"),
  "🗒": t("view.widget.records"),
  "🩺": t("view.widget.schemaWarn"),
};

/** 按图标找导航面板「统计」列的小工具按钮（Phase 29：文字按钮，不再有图标位） */
function widgetButton(container: StubElement, icon: string): StubElement {
  const label = WIDGET_LABEL[icon];
  assert.ok(label !== undefined, `夹具里没有「${icon}」这个图标`);
  return panelButton(container, label);
}

/** 点面板按钮 → 返回弹窗体（`.wf-widget-popup > .wf-widget-popup-body`） */
function openWidget(container: StubElement, icon: string): StubElement {
  widgetButton(container, icon).onclick?.(mouseEvent());
  const popup = currentPopup();
  assert.ok(popup, "点导航面板按钮应弹出弹窗");
  return popup.query(".wf-widget-popup-body")[0];
}

/**
 * 按**文案前缀**找导航面板里的 `.wf-panel-btn`（统计 / 修改两列共用一套样式）。
 *
 * 开关类按钮的文案带状态（`修改节点顺序：开` / `总览：关`），所以按前缀取；
 * emoji → 文案映射见 `WIDGET_LABEL`。
 */
function panelButton(container: StubElement, prefix: string): StubElement {
  const button = container.query(".wf-panel-btn").find((item) => item.text.startsWith(prefix));
  assert.ok(button, `导航面板应有「${prefix}…」按钮`);
  return button;
}

/** 当前弹窗（没开就是 undefined） */
const currentPopup = (): StubElement | undefined => body.query(".wf-widget-popup")[0];

/** Phase 30：当前高亮的 tab 按钮（`.wf-widget-tab.is-active`） */
const activeWidgetTab = (): StubElement | undefined =>
  body.query(".wf-widget-tab").find((tab) => tab.hasClass("is-active"));

/** 点「×」关掉弹窗（弹窗是单例，测试之间不能互相影响） */
function closeWidget(): void {
  const close = body.query(".wf-widget-popup-close")[0];
  assert.ok(close, "弹窗上应有「×」");
  close.onclick?.(mouseEvent());
  assert.equal(currentPopup(), undefined, "「×」应关掉弹窗");
}

/**
 * 点一次「修改节点顺序」开关（Phase 29：开关在导航面板「修改」列，
 * **原位切换、不重渲染** —— 面板不会重建，句柄一路有效）。
 */
async function toggleReorder(container: StubElement): Promise<void> {
  const toggle = panelButton(container, t("view.block.reorderNodes"));
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
  test("左键标题无动作，tooltip 只说明右键能做什么（Phase 27：纪要锚点已弃用）", async () => {
    const { container } = await render(validMarkdown11());
    const titleEl = container.query(".wf-card-title")[0];

    assert.equal(titleEl.title, t("view.card.titleTooltip"));
    assert.equal(titleEl.title.includes("^"), false, "不再给「^nd-xxx」锚点提示");
    assert.equal(titleEl.onclick, null, "左键不再跳纪要");
  });
});

describe("wfView · 卡片外观开关（collapsed / importance=4 加粗 / links）", () => {
  test("collapsed 收起子树、重要度 4 加粗（v1.6）、有资料实线，点箭头改 DOM 并写回 JSON", async () => {
    const document = validDocument11();
    document.workflows[0].root.collapsed = true;
    document.workflows[0].root.importance = 4;
    delete document.workflows[1].root.importance; // 归档根节点自带 4，排除干扰

    const { container, recorder } = await renderWith(writeBackDocument(validMarkdown11(), document).markdown, (rec) => {
      // Phase 27 M3：实线 / 虚线的判据从 JSON `links` 换成反向 YAML 归属（`host.linkedFiles`）
      rec.linkFixture.files = [
        { path: "notes/竞品清单.md", title: "竞品清单", workflowTitle: "立项调查", nodeTitle: "调研竞品", nodeId: ROOT_ID },
      ];
    });

    assert.equal(container.query(".wf-collapsed").length, 1);
    assert.equal(container.query(".wf-card--bold").length, 1);
    assert.equal(container.query(".wf-card--solid").length, 1);

    const caret = container.query(".wf-caret")[0];
    assert.equal(caret.text, "▸");

    caret.onclick?.(mouseEvent());
    assert.equal(caret.text, "▾");
    assert.equal(container.query(".wf-collapsed").length, 0);
    await flush();
    // Phase 21 ⑤：折叠态直接落盘（不再只留会话内存）
    assert.deepEqual(recorder.collapseCalls, [{ nodeId: ROOT_ID, collapsed: false }]);
  });
});

describe("wfView · Phase 6 主题切换入口", () => {
  test("render options.theme 优先于 frontmatter；都没有 / 非法值 → 默认主题 default", async () => {
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

    // Phase 46：`default` 重新是合法 key —— 老看板 / 模板新建的看板（`wf-theme: default`）
    // 现在**挂属性**（Phase 44 期间它落到「不挂属性」的素净基线，用户按属性写的自定义样式全失效）。
    const legacyHost = makeHost(applyThemeToMarkdown(validMarkdown11(), "default"));
    const legacy = new StubElement("div");
    await renderWorkflowView(legacyHost.host, {
      app: legacyHost.host.app,
      container: asHtmlElement(legacy),
      currentFilePath: file.path,
    });
    assert.equal(legacy.getAttribute("data-wf-theme"), "default", "wf-theme: default = 默认主题");

    // 没写 `wf-theme` 与写了非法值同一条路：都回落到默认主题
    for (const markdown of [validMarkdown11(), applyThemeToMarkdown(validMarkdown11(), "nope")]) {
      const host = makeHost(markdown);
      const bare = new StubElement("div");
      await renderWorkflowView(host.host, {
        app: host.host.app,
        container: asHtmlElement(bare),
        currentFilePath: file.path,
      });
      assert.equal(bare.getAttribute("data-wf-theme"), "default", "没写 / 非法 → 默认主题");
    }
  });

  test("点「科技风」→ host.setFileTheme（只写本文件）→ 重渲染，容器主题切换", async () => {
    const { container, recorder } = await render(validMarkdown11());
    const lanesBefore = container.query(".wf-lane").length;
    const cardsBefore = container.query(".wf-card").length;
    assert.equal(container.getAttribute("data-wf-theme"), "default", "没写 wf-theme = 默认主题");

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
    // Phase 46：没写 `wf-theme` = 默认主题（选中态落在「默认」按钮上）；这里显式写一套主题再点它
    const { container, recorder } = await render(applyThemeToMarkdown(validMarkdown11(), "tech"));
    const current = container.query(".wf-theme-btn--active")[0];
    assert.ok(current !== undefined, "写了 wf-theme 才有选中态（默认主题下选中的是「默认」）");
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

/**
 * Phase 22：泳道正文（`.wf-lane-body`）是**每条泳道自己的**纵向滚动区。
 *
 * 口径：「滚到底」只发生在**打开笔记**那一帧（最新进度在最下面）；
 * 之后的重渲染（改 note / 改节点顺序 / 切主题 / Dataview 重跑）要保持用户看到的位置。
 * 之前的实现是 `renderLane` 无条件 `scrollTop = scrollHeight`，于是每次写回都跳回底部。
 */
describe("wfView · Phase 22 泳道滚动位置（打开到底 / 重渲染保持）", () => {
  /** 泳道正文的「内容高度」：桩里没有布局，`scrollHeight` 恒为 0，得用 preset 造出「比可视区高」 */
  const LANE_CONTENT_HEIGHT = 480;

  /** 用例期间给 `.wf-lane-body` 预设内容高度，结束后立刻清掉（别影响其它用例） */
  const withLaneHeight = async (run: () => Promise<void>): Promise<void> => {
    presetScrollHeight("wf-lane-body", LANE_CONTENT_HEIGHT);
    try {
      await run();
    } finally {
      clearScrollHeightPresets();
    }
  };

  test("打开笔记那一帧把每条泳道正文滚到底", async () => {
    await withLaneHeight(async () => {
      const { container } = await render(validMarkdown11());
      const bodies = container.query(".wf-lane-body");
      assert.equal(bodies.length, 2, "进行中 1 条 + 已完成流 1 条");
      for (const body of bodies) {
        assert.equal(body.scrollHeight, LANE_CONTENT_HEIGHT, "桩里正文比可视区高");
        assert.equal(body.scrollTop, LANE_CONTENT_HEIGHT, "首帧滚到底（最新进度在最下面）");
      }
    });
  });

  test("改 note 后的整块重渲染保持用户滚到的位置（不再跳回底部）", async () => {
    await withLaneHeight(async () => {
      const recorder = makeHost(validMarkdown11());
      const container = new StubElement("div");
      const dv = { app: recorder.host.app, container: asHtmlElement(container), currentFilePath: file.path };
      await renderWorkflowView(recorder.host, dv);

      const opened = container.query(".wf-lane-body");
      const scrolled = opened[0];
      const workflowId = scrolled.getAttribute("data-workflow-id");
      assert.ok(typeof workflowId === "string" && workflowId.length > 0, "泳道正文挂 data-workflow-id（滚动位置按它认领）");
      scrolled.scrollTop = 120; // 用户往上滚了一截

      // 「改 note 信息」→ 插件写回 JSON → 插件 refresh + Dataview 重跑（都是整块重渲染）
      const document = validDocument11();
      document.workflows[0].root.note = [{ text: "刚补的一条纪要" }];
      recorder.state.markdown = writeBackDocument(recorder.state.markdown, document).markdown;
      await renderWorkflowView(recorder.host, dv);

      const rebuilt = container.query(".wf-lane-body");
      assert.equal(rebuilt.length, 2, "泳道没有被叠成两份");
      const restored = rebuilt.find((body) => body.getAttribute("data-workflow-id") === workflowId);
      assert.ok(restored !== undefined, "重建后仍能按 data-workflow-id 找回同一条泳道");
      assert.equal(restored, scrolled, "C 案：正文元素被原地复用（滚动宿主不换，没有「夹成 0 再拨回」）");
      assert.equal(restored.scrollTop, 120, "重渲染后回到用户滚到的位置（不再跳到底）");
      assert.equal(
        opened.filter((body) => rebuilt.includes(body)).length,
        opened.length,
        "每条泳道正文都被复用（不是重建出来的新元素）",
      );
      const untouched = rebuilt.find((body) => body.getAttribute("data-workflow-id") !== workflowId);
      assert.equal(untouched?.scrollTop, LANE_CONTENT_HEIGHT, "没动过的泳道保持原位置（仍到底）");
    });
  });

  /**
   * D 案（`phase23_bound.md` §4）：真正的跳位发生在 A 案 / C 案够不着的地方 ——
   * 写回后 Dataview 自己 `dv.container.innerHTML = ""`，把 DOM 先抹了；
   * 紧接着的 `paint` 再抓就是 0（跳到顶部 + 泳道吸底）。所以插件在写盘前
   * （`rememberViewScroll`）抢一份，容器已被清空时用它兜底。
   */
  test("Dataview 写回把容器清空 → 整块重渲染仍恢复外层滚动位置（D 案）", async () => {
    const recorder = makeHost(validMarkdown11());
    const container = new StubElement("div");
    const dv = { app: recorder.host.app, container: asHtmlElement(container), currentFilePath: file.path };
    await renderWorkflowView(recorder.host, dv);
    container.scrollTop = 321; // 用户滚到的位置

    // 写盘前插件抢一份（真实链路：mutateFile / setFileTheme 里调用）
    rememberViewScroll(file);
    // Dataview 检测到文件变化 → 自己把容器抹掉（这一步先于我们的 paint，位置当场变 0）
    container.empty();
    container.scrollTop = 0;

    await renderWorkflowView(recorder.host, dv);
    assert.equal(container.scrollTop, 321, "写回把 DOM 抹掉后仍回到用户看到的位置（跳顶根因）");
    assert.ok(container.query(".wf-lane").length > 0, "视图照常重建");
  });

  test("Dataview 写回把容器清空 → 整块重渲染仍恢复每条泳道的位置（D 案）", async () => {
    await withLaneHeight(async () => {
      const recorder = makeHost(validMarkdown11());
      const container = new StubElement("div");
      const dv = { app: recorder.host.app, container: asHtmlElement(container), currentFilePath: file.path };
      await renderWorkflowView(recorder.host, dv);

      const bodies = container.query(".wf-lane-body");
      const scrolled = bodies[0];
      const workflowId = scrolled.getAttribute("data-workflow-id");
      assert.ok(typeof workflowId === "string" && workflowId.length > 0, "泳道正文挂 data-workflow-id");
      scrolled.scrollTop = 120; // 用户往上滚了一截

      rememberViewScroll(file);
      container.empty(); // Dataview 的 `innerHTML = ""`：泳道正文一起被摘掉，scrollTop 当场归 0

      await renderWorkflowView(recorder.host, dv);
      const rebuilt = container.query(".wf-lane-body");
      const restored = rebuilt.find((body) => body.getAttribute("data-workflow-id") === workflowId);
      assert.ok(restored !== undefined, "重建后仍能按 data-workflow-id 找回同一条泳道");
      assert.equal(restored.scrollTop, 120, "容器被抹掉后泳道仍回到用户滚到的位置（吸底根因）");
      const untouched = rebuilt.find((body) => body.getAttribute("data-workflow-id") !== workflowId);
      assert.equal(untouched?.scrollTop, LANE_CONTENT_HEIGHT, "没动过的泳道仍到底");
    });
  });
});

/**
 * A 案：写回后**不再重读盘 + 重校验**。
 *
 * 引擎的 `MutationResult.analysis` 已经是「写回后整篇笔记的分析」（`mutateFile` 本来就要
 * 算它做幂等校验），插件现在把它随写回结果一起交回视图，局部刷新直接复用它重建列。
 * 旧链路是「写回 → 再 `analyzeFile`（read + 全量校验）→ 才重画」，那一次往返正是
 * 「点完等半拍才蹦出来」的主间隔。没带 `analysis` 时（Dataview 重跑 / 其它替身）照旧回落。
 */
describe("wfView · Phase 23 写回后复用引擎分析（不重读盘重校验）", () => {
  test("改状态：局部刷新吃返回的 analysis，analyzeFile 不再被调用", async () => {
    const { container, recorder } = await render(validMarkdown11());
    const analysesBefore = recorder.analyzeCalls.count;

    // 真实插件的形状：先落盘（改 state.markdown），再把「写回后的分析」一起交回视图
    recorder.host.setNodeStatus = async (_file, nodeId, status) => {
      const before = analyzeMarkdown(recorder.state.markdown, { file: file.path });
      const document = before.latestDocument ?? before.document;
      assert.ok(document !== undefined, "测试数据要能解析出文档");
      document.workflows[0].root.status = status;
      recorder.state.markdown = writeBackDocument(recorder.state.markdown, document).markdown;
      return {
        success: true,
        changed: true,
        issues: [],
        nodeId,
        status,
        analysis: analyzeMarkdown(recorder.state.markdown, { file: file.path }),
      };
    };

    const card = container.query(".wf-card")[0];
    card.oncontextmenu?.(mouseEvent());
    const entry = body.query(".wf-menu-item").find((item) => item.text === "🔵 标记为进行中");
    assert.ok(entry !== undefined, "菜单里应有「🔵 标记为进行中」");
    entry.onclick?.(mouseEvent());
    await flush();
    await flush();

    assert.equal(
      recorder.analyzeCalls.count,
      analysesBefore,
      "写回后的局部刷新不读盘（复用写回结果里的 analysis）",
    );
    const rootCard = container.query(".wf-card")[0];
    assert.ok(rootCard.classList.contains("wf-card--doing"), "局部刷新用的是新分析（根节点已成为 doing）");
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
  test("菜单列出资料 / 其余状态；点「标记为进行中」调用 setNodeStatus 并重渲染", async () => {
    const { container, recorder } = await render(validMarkdown11());
    const card = container.query(".wf-card")[0];

    card.oncontextmenu?.(mouseEvent());
    const menu = body.query(".wf-menu")[0];
    assert.ok(menu, "右键应弹出菜单");

    const items = texts(menu.query(".wf-menu-item"));
    // Phase 27 M3：资料那段读反向 YAML 归属 —— 没有资料就给一行占位（「跳到本文件纪要」已删）
    assert.ok(items.includes(t("view.menu.noLinks")), `菜单应有占位项，实际：${items.join(" / ")}`);
    assert.equal(
      items.some((item) => item.includes("跳到本文件纪要")),
      false,
      "纪要锚点入口已随纪要段范式一起删除",
    );
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
    assert.match(container.query(".wf-issue-title")[0].text, /已暂停显示/);
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

describe("wfView · Phase 2/36 结构菜单（只剩「编辑节点信息」）", () => {
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

  test("根 / 子节点的「结构」组只剩「编辑节点信息…」（加子节点 / 删除 / note 已移入面板 tab）", async () => {
    const { container } = await render(validMarkdown11());

    const rootItems = texts(openCardMenu(container.query(".wf-card")[0]));
    // Phase 27：资料段改读反向 YAML 归属，没有命中就给占位项（纪要 / 超链接 Modal 都已删除）
    assert.ok(rootItems.includes(t("view.menu.noLinks")), `根节点菜单应有占位项，实际：${rootItems.join(" / ")}`);
    assert.equal(
      rootItems.some((item) => item.includes("跳到本文件纪要") || item.includes("编辑纪要超链接")),
      false,
      "纪要段范式已弃用，两个入口都不该出现",
    );
    assert.ok(rootItems.includes("✏️ 编辑节点信息…"));
    for (const removed of ["➕ 添加子节点…", "🗑 删除本节点…", "🔖 设置 note 节点…"]) {
      assert.equal(rootItems.includes(removed), false, `根节点菜单里不该再有「${removed}」`);
    }

    const childItems = texts(openCardMenu(container.query(".wf-card")[1]));
    assert.ok(childItems.includes("✏️ 编辑节点信息…"));
    for (const removed of ["➕ 添加子节点…", "🗑 删除本节点…", "🔖 设置 note 节点…"]) {
      assert.equal(childItems.includes(removed), false, `子节点菜单里不该再有「${removed}」`);
    }
  });

  test("取消面板：调了 host 但不提示、不动 DOM", async () => {
    const { container, recorder } = await render(validMarkdown11());
    recorder.host.openNodePanel = panelStub(async (_file, node, tab) => {
      if (tab === "info") recorder.infoCalls.push({ nodeId: node?.id ?? "" });
      return { cancelled: true };
    });

    const card = container.query(".wf-card")[1];
    const before = container.query(".wf-card").length;
    clickMenuItem(openCardMenu(card), "✏️ 编辑节点信息…");
    await flush();

    assert.deepEqual(recorder.infoCalls, [{ nodeId: "nd-uuid-002" }]);
    assert.deepEqual(recorder.notices, [], "取消不该有提示");
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

  test("Phase 21：12 色一循环 —— workflows[6…11] 取 w6…w11，第 13 / 14 个回到 w0 / w1", async () => {
    const today = recentDateKeys(new Date(), 1)[0];
    /** 每个工作流一条「今天」的计时：起始时刻各不相同 → 甘特段在 DOM 里的顺序 = `workflows[]` 顺序 */
    const entry = (hour: number) => [
      {
        startAt: `${today}T${String(hour).padStart(2, "0")}:00:00+08:00`,
        date: today,
        endAt: `${today}T${String(hour + 1).padStart(2, "0")}:00:00+08:00`,
        hours: 1,
      },
    ];

    const document = clone(validDocument13());
    for (const workflow of document.workflows) {
      for (const visit of walkWorkflow(workflow)) delete visit.node.timeEntries;
    }
    // 夹具只给了 2 个工作流，再补 12 个 = 14 个（> 12，才验证得到「循环」）
    for (let index = document.workflows.length; index < 14; index += 1) {
      const root = leaf(`nd-uuid-9${index}`, `根节点 ${index + 1}`);
      delete root.noteAnchor; // 正文里没有这些节点的纪要段 → 不挂锚点，免得「锚点缺失」错误挡住渲染
      document.workflows.push({ id: `wf-uuid-9${index}`, title: `配色工作流 ${index + 1}`, root });
    }
    document.workflows.forEach((workflow, index) => {
      workflow.root.timeEntries = entry(6 + index);
    });

    const { container } = await render(writeBackDocument(validMarkdown13(), document).markdown);
    const widget = openWidget(container, "📊");
    const bars = widget.query(".wf-gantt-span");

    assert.equal(bars.length, 14, "14 个工作流各一条高亮段");
    bars.forEach((bar, index) => {
      const expected = `wf-gantt-span--w${index % 12}`;
      assert.ok(bar.classList.contains(expected), `第 ${index + 1} 个工作流应取 ${expected}`);
    });
    // 前 12 个用满整套 12 色（w0…w11 不重复），第 13 / 14 个才开始循环
    const colorIndexes = bars.slice(0, 12).map((bar) => {
      const match = Array.from({ length: 12 }, (_, index) => index).find((index) =>
        bar.classList.contains(`wf-gantt-span--w${index}`),
      );
      return match;
    });
    assert.deepEqual(colorIndexes, [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11], "前 12 个工作流用满 12 个不同色号");
    assert.deepEqual(Object.keys(bars[6].style).sort(), ["left", "width"], "颜色只能来自 styles.css");
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

  test("§⑨-6 / Phase 25 折叠区改成上拉抽屉：复用「正在进行」的左右分栏（每个 workflow 一栏）", async () => {
    const { container } = await render(validMarkdown11());

    // 三角切换栏整体退场（按钮 / 名称 / 计数都跟着走）
    assert.equal(container.query(".wf-lane-switcher").length, 0, "抽屉里不该再有切换栏");
    assert.equal(container.query(".wf-lane-switch-btn").length, 0, "不该再有 ◀ / ▶ 按钮");
    assert.equal(container.query(".wf-lane-switch-name").length, 0);
    assert.equal(container.query(".wf-lane-switch-count").length, 0);

    // 结构 = .wf-drawer-body > .wf-drawer-columns > .wf-column > .wf-lane（与 .wf-active-columns 同构）
    const drawer = container.query(".wf-drawer-archived")[0];
    assert.ok(drawer !== undefined, "已完成流应有一个上拉抽屉");
    const drawerBody = drawer.query(".wf-drawer-body")[0];
    assert.ok(drawerBody !== undefined, "抽屉应有 body");
    const drawerColumnsEl = drawerBody.query(".wf-drawer-columns")[0];
    assert.ok(drawerColumnsEl !== undefined, "抽屉应有分栏外层（复用左右泳道设计）");
    const drawerColumns = drawerColumnsEl.query(".wf-column");
    assert.equal(drawerColumns.length, 1, "一个已完成流 = 一栏");
    assert.equal(drawerColumns[0].query(".wf-lane").length, 1, "栏目里是一条正常的泳道");

    // Phase 16：折叠分组不显示颜色方块（颜色方块只属于「正在进行」的分栏栏头）
    const drawerLane = drawerBody.query(".wf-lane")[0];
    assert.equal(drawerLane.query(".wf-lane-color").length, 0);
  });

  test("Phase 25 多条已完成流并排成多栏（不再一个一个切换）", async () => {
    const document = validDocument11();
    document.workflows.push({
      id: "wf-uuid-902",
      title: "第二份归档",
      state: "archived",
      root: leaf("nd-uuid-902", "📦 第二份归档", {
        status: "done",
        progress: 1,
        progress_max: 1,
        completedAt: "2026-10-09T18:00:00+08:00",
      }),
    });
    const { container } = await render(writeBackDocument(validMarkdown11(), document).markdown);

    const columns = container.query(".wf-drawer-columns")[0].query(".wf-column");
    assert.equal(columns.length, 2, "两条已完成流 = 两栏（并排，不需要切换）");
    assert.deepEqual(
      texts(columns.map((column) => column.query(".wf-lane-title")[0])),
      [ARCHIVED_WF_TITLE, "第二份归档"],
      "按文档顺序铺开两条泳道",
    );
    assert.equal(container.query(".wf-lane-switch-btn").length, 0);
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

  test("§⑨-2 已归档块（Phase 39：扁平文件列表 + 懒加载）", async () => {
    const { container, recorder } = await render(validMarkdown13());
    recorder.archiveFixture.files.push(ARCHIVE_FILE);
    recorder.archiveMetaFixture.metas[ARCHIVE_FILE] = {
      path: ARCHIVE_FILE,
      workflowId: ARCHIVE_WF_ID,
      title: ARCHIVED_WF_TITLE,
      archivedAt: TIME_ARCHIVED_AT,
      fromWorkflow: "立项调查",
      fromNode: "调研竞品",
      summary: "三条结论已收敛",
      tag: ["归档"],
    };

    const widget = openWidget(container, "📦");
    // 首帧是「读取归档信息…」占位（懒加载），微任务落定后才是行
    await flush();
    const rows = widget.query(".wf-archive-row");
    assert.equal(rows.length, 1, "一行 = 磁盘上一份归档文件");
    assert.equal(rows[0].query(".wf-archive-row-title")[0].text, "调研竞品", "行首是来源节点");
    assert.ok(
      rows[0].query(".wf-archive-row-meta")[0].text.includes(t("view.archive.fromWorkflow", { title: "立项调查" })),
      "行上显示来源工作流",
    );
    assert.deepEqual(texts(widget.query(".wf-archive-row-btn")), [
      t("view.archive.edit"),
      t("view.archive.open"),
    ]);
    // 三段文字折在 <details> 里
    assert.equal(rows[0].query(".wf-archive-row-notes").length, 1);
    assert.deepEqual(texts(rows[0].query(".wf-archive-row-note")), [
      t("view.archive.summary", { text: "三条结论已收敛" }),
      t("view.archive.tag", { text: "归档" }),
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
   * 而根节点改走「📦 归档整个工作流」（Phase 22：整棵树全 done 才可归档），
   * 归档节点（根带 `archive` 的 workflow 2）则给「该工作流已归档」。
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

  test("行里的「打开归档看板」交给宿主（标题不可点）", async () => {
    const { container, recorder } = await render(validMarkdown13());
    const calls: { linktext: string; sourcePath: string }[] = [];
    recorder.host.app.workspace.openLinkText = (linktext: string, sourcePath: string): Promise<void> => {
      calls.push({ linktext, sourcePath });
      return Promise.resolve();
    };
    recorder.archiveFixture.files.push(ARCHIVE_FILE);
    recorder.archiveMetaFixture.metas[ARCHIVE_FILE] = {
      path: ARCHIVE_FILE,
      workflowId: ARCHIVE_WF_ID,
      title: ARCHIVED_WF_TITLE,
    };

    const widget = openWidget(container, "📦");
    await flush();
    const row = widget.query(".wf-archive-row")[0];
    assert.equal(row.query(".wf-archive-row-title")[0].onclick ?? null, null, "标题不可点");
    const open = row.query(".wf-archive-row-btn").find((b) => b.text === t("view.archive.open"));
    open?.onclick?.(mouseEvent());

    // Phase 24：归档链接改走 `host.openArchiveBoard`（插件开归档看板），不走 `openLinkText`
    assert.deepEqual(calls, [], "不再是「标题 → 纪要锚点」那条链路");
    assert.deepEqual(recorder.archiveBoardCalls, [ARCHIVE_FILE], "归档链接交给宿主开归档看板");
    // Phase 41：开归档看板 = 换到那份看板 → 弹窗已在 onclick 里收掉，这里不再手动关
    assert.equal(currentPopup(), undefined, "打开归档看板后弹窗自动收掉");
  });

  test("菜单写明不能归档的原因（节点级 / 工作流级）：点它只提示，不调插件", async () => {
    // 夹具那份归档文件 属于「归档 workflow 的根节点」→ Phase 22 起归「整条工作流」口径；
    // 这里再造两种「不能归档」：
    //  1. 给**非根、无子树**的节点挂 `archive` → 节点级只给「已归档，没有新子树可追加」
    //     （Phase 36：已归档但有新子树是**可以**再归档的，所以这里要先把子树清空）；
    //  2. 给 workflow 1 的根再挂一个 todo 子节点 → 整条流归档只给「子树里…还没做完」。
    const document = documentReadyToArchive();
    document.workflows[0].root.children[0].archive = { workflowId: "wf-uuid-101" };
    document.workflows[0].root.children[0].children = [];
    document.workflows[0].root.children.push(leaf("nd-uuid-006", "补一份对比表"));
    const { container, recorder } = await render(writeBackDocument(validMarkdown13(), document).markdown);

    clickMenuItem(openCardMenu(cardTitled(container, "调研竞品")), "📦 归档整个工作流（子树里「补一份对比表」还没做完）");
    await flush();
    assert.match(recorder.notices[0], /不能归档「立项调查」：子树里「补一份对比表」还没做完/);

    const archivedItems = openCardMenu(cardTitled(container, "整理结论"));
    assert.ok(
      archivedItems.some((item) => item.text === "📦 为此及之后归档（已归档，没有新子树可追加）"),
      `菜单应写明「已归档，没有新子树可追加」，实际：${archivedItems.map((item) => item.text).join(" / ")}`,
    );
    clickMenuItem(archivedItems, t("view.menu.openArchive"));
    await flush();

    // Phase 39：菜单里只剩 workflowId，宿主按它在 archive/ 里扫那份归档
    assert.deepEqual(recorder.archiveBoardByIdCalls, ["wf-uuid-101"], "已归档节点的归档文件从菜单开成归档看板");
    assert.deepEqual(recorder.archiveCalls, [], "不满足资格时不该调插件");
    assert.deepEqual(recorder.workflowArchiveCalls, [], "整条流不满足资格时也不该调插件");
    // Phase 39：弹窗列表只认磁盘上的归档文件 —— 这里没造文件，所以是空态
    const widget = openWidget(container, "📦");
    assert.equal(widget.query(".wf-archive-row").length, 0, "没有磁盘归档文件 → 空列表");
    assert.equal(widget.query(".wf-widget-placeholder").length, 1);
    closeWidget();
  });

  /* ---- Phase 36：已归档节点又长出新的全 done 子树 → 可以再归档（追加到旧归档文件） ---- */

  test("Phase 36：已归档 + 新完成子树 → 菜单给「📦 为此及之后归档…」并调插件", async () => {
    const document = documentReadyToArchive();
    // `整理结论` 已归档（旧 archive）且带着本次新完成的子节点「写结论」→ 允许再归档
    document.workflows[0].root.children[0].archive = { workflowId: "wf-uuid-101" };
    const { container, recorder } = await render(writeBackDocument(validMarkdown13(), document).markdown);

    const items = openCardMenu(cardTitled(container, "整理结论"));
    assert.ok(
      items.some((item) => item.text === "📦 为此及之后归档…"),
      `已归档 + 新子树应给可点的归档入口，实际：${items.map((entry) => entry.text).join(" / ")}`,
    );
    clickMenuItem(items, "📦 为此及之后归档…");
    await flush();
    assert.deepEqual(recorder.archiveCalls, [{ nodeId: CHILD_ID }], "重复归档走同一个插件入口");
    assert.deepEqual(recorder.notices, [], "面板默认取消 → 不提示");
  });

  /* ---- Phase 22：归档整个工作流（根节点入口 + [完整工作流] 角标） ---- */

  test("Phase 22：根节点菜单给「📦 归档整个工作流…」，点它调插件；归档过的流只给原因", async () => {
    const document = documentReadyToArchive();
    const { container, recorder } = await render(writeBackDocument(validMarkdown13(), document).markdown);

    clickMenuItem(openCardMenu(cardTitled(container, "调研竞品")), "📦 归档整个工作流…");
    await flush();
    assert.deepEqual(recorder.workflowArchiveCalls, [{ workflowId: WF1_ID, title: "立项调查" }]);
    assert.deepEqual(recorder.archiveCalls, [], "根节点不再走节点级「为此及之后归档」");

    // workflow 2 的根带 `archive` 且没有子树（浓缩后的空根）→ 整条流口径给原因
    const archivedRoot = openCardMenu(cardTitled(container, "📦 实现方案"));
    assert.ok(
      archivedRoot.some((item) => item.text === "📦 归档整个工作流（已归档，没有新子树可追加）"),
      "已归档且无新子树的根节点应给「已归档，没有新子树可追加」",
    );
  });

  test("Phase 39：扁平列表（不按工作流分组）—— 两份归档两行，行首是各自来源节点", async () => {
    const { container, recorder } = await render(validMarkdown13());
    const fileA = "_workflowwatcher/archive/wf-a-nd-b-20261012-143000-abcdef0123456789.wf.json";
    const fileB = "_workflowwatcher/archive/wf-c-nd-d-20261012-150000-abcdef0123456789.wf.json";
    recorder.archiveFixture.files.push(fileA, fileB);
    recorder.archiveMetaFixture.metas[fileA] = {
      path: fileA,
      workflowId: "wf-archive-1",
      title: "实现方案（已归档）",
      fromWorkflow: "立项调查",
      fromNode: "📦 实现方案",
      archivedAt: TIME_ARCHIVED_AT,
    };
    recorder.archiveMetaFixture.metas[fileB] = {
      path: fileB,
      workflowId: "wf-archive-2",
      title: "交叉验证（已归档）",
      fromWorkflow: "立项调查",
      fromNode: "交叉验证",
    };

    const widget = openWidget(container, "📦");
    await flush();
    const rows = widget.query(".wf-archive-row");
    assert.equal(rows.length, 2, "两份归档 = 两行（不按工作流分组）");
    assert.deepEqual(texts(widget.query(".wf-archive-row-title")), ["📦 实现方案", "交叉验证"]);
    assert.equal(widget.query(".wf-archive-group").length, 0, "不再按工作流分组");
    assert.equal(widget.query(".wf-archive-row-badge").length, 0, "不再有 [完整工作流] 角标");
    closeWidget();
  });

  test("Phase 39：每行归档文件都有「编辑 + 打开」按钮；编辑交给 host.openArchiveMetaEditor", async () => {
    const { container, recorder } = await render(validMarkdown13());
    recorder.archiveFixture.files.push(ARCHIVE_FILE);
    recorder.archiveMetaFixture.metas[ARCHIVE_FILE] = {
      path: ARCHIVE_FILE,
      workflowId: ARCHIVE_WF_ID,
      title: ARCHIVED_WF_TITLE,
      summary: "旧概括",
    };

    const widget = openWidget(container, "📦");
    await flush();
    assert.deepEqual(texts(widget.query(".wf-archive-row-btn")), [
      t("view.archive.edit"),
      t("view.archive.open"),
    ]);
    const edit = widget.query(".wf-archive-row-btn").find((b) => b.text === t("view.archive.edit"));
    edit?.onclick?.(mouseEvent());
    await flush();
    assert.deepEqual(recorder.archiveMetaCalls, [{ path: ARCHIVE_FILE }]);
    closeWidget();
  });

});

/* ------------------------------------------------------------------ *
 * Phase 41：「已归档」弹窗现读 archive_tag.yaml + 打开归档看板后真的跳过去
 * ------------------------------------------------------------------ */

describe("wfView · Phase 41 归档标签现读 + 打开归档看板", () => {
  /** 当前弹窗的内容块（重画会换 body，所以每次断言前都现查） */
  const popupBody = (): StubElement | undefined => currentPopup()?.query(".wf-widget-popup-body")[0];

  test("打开「已归档」弹窗现读 archive_tag.yaml：标签列表 = 现读结果（不吃启动缓存）", async () => {
    const { container, recorder } = await render(validMarkdown13());
    // 缓存里是旧的（甚至空），磁盘上现在有两个词 → 弹窗必须显示现读的这两个
    recorder.archiveTagFixture.tags.push("旧词");
    recorder.archiveTagRefreshResult.tags.push("竞品", "归档");

    openWidget(container, "📦");
    await flush();
    assert.equal(recorder.archiveTagRefreshes.length, 1, "打开弹窗就现读一次");
    const widget = popupBody();
    assert.ok(widget, "弹窗还在");
    assert.deepEqual(texts(widget.query(".wf-archive-filter-chip")), ["竞品", "归档"], "标签列表按现读枚举重画");
    closeWidget();
  });

  test("切 tab 进「已归档」也现读一次（不是只有「点面板按钮」那一条路）", async () => {
    const { container, recorder } = await render(validMarkdown13());
    openWidget(container, "🗒");
    await flush();

    const tab = body.query(".wf-widget-tab").find((item) => item.text.startsWith(WIDGET_LABEL["📦"]));
    assert.ok(tab, "顶部应有「已归档」tab");
    tab.onclick?.(mouseEvent());
    await flush();
    assert.equal(recorder.archiveTagRefreshes.length, 1, "切进「已归档」= 又一次打开 → 现读一次");
    closeWidget();
  });

  test("点「打开归档看板」：宿主开看板 + 弹窗收掉（页面停在那份归档看板）", async () => {
    const { container, recorder } = await render(validMarkdown13());
    recorder.archiveFixture.files.push(ARCHIVE_FILE);
    recorder.archiveMetaFixture.metas[ARCHIVE_FILE] = {
      path: ARCHIVE_FILE,
      workflowId: ARCHIVE_WF_ID,
      title: ARCHIVED_WF_TITLE,
    };

    openWidget(container, "📦");
    await flush();
    const widget = popupBody();
    assert.ok(widget, "弹窗还在");
    const open = widget.query(".wf-archive-row-btn").find((b) => b.text === t("view.archive.open"));
    assert.ok(open, "每行都有「打开归档看板」");
    open.onclick?.(mouseEvent());

    assert.deepEqual(recorder.archiveBoardCalls, [ARCHIVE_FILE], "归档看板交给宿主开");
    // 弹窗挂在 document.body 上（fixed 全屏遮罩）：不收掉就一直盖着新页面 = 看起来没跳转
    assert.equal(currentPopup(), undefined, "打开归档看板后弹窗必须收掉");
  });
});

describe("wfView · Phase 15 拖拽改节点顺序", () => {
  test("Phase 29 面板「修改」列：设置 / 修改工作流 / 修改节点顺序 / 总览 / 未分类（顺序固定，节点顺序默认关）", async () => {
    const { container } = await render(validMarkdown11());

    // 块尾按钮行已撤掉（Phase 29：入口统统搬进导航面板）；拖拽说明块仍留在块里
    assert.equal(container.query(".wf-block-actions").length, 0, "块尾不再有按钮行");
    assert.equal(container.query(".wf-block-btn").length, 0);
    assert.equal(container.query(".wf-reorder-help").length, 1, "拖拽说明块留在块里（开关遥控显隐）");

    const editCol = container.query(".wf-panel-column")[1];
    assert.deepEqual(
      texts(editCol.query(".wf-panel-btn")),
      [
        t("view.widget.settings"),
        t("view.block.editWorkflows"),
        `${t("view.block.reorderNodes")}：${t("view.reorder.off")}`,
        `${t("view.nav.overview")}：${t("view.reorder.on")}`,
        // Phase 33：第 5 个 = 未分类框的显隐开关（默认显示）
        `${t("view.unclassified.title")}：${t("view.nav.unclassifiedShow")}`,
      ],
      "「修改」列 5 个文字按钮，顺序固定；总览默认展开（开），未分类默认显示",
    );

    const toggle = panelButton(container, t("view.block.reorderNodes"));
    assert.equal(toggle.getAttribute("aria-pressed"), "false");
    assert.equal(toggle.title, t("view.reorder.hint"));
    assert.equal(toggle.classList.contains("wf-panel-btn--on"), false);

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

    const toggle = panelButton(container, t("view.block.reorderNodes"));
    assert.equal(toggle.text, `${t("view.block.reorderNodes")}：${t("view.reorder.on")}`);
    assert.equal(toggle.getAttribute("aria-pressed"), "true");
    assert.ok(toggle.classList.contains("wf-panel-btn--on"), "开态加主题色类");

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
    assert.equal(
      panelButton(container, t("view.block.reorderNodes")).text,
      `${t("view.block.reorderNodes")}：${t("view.reorder.off")}`,
    );
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

    assert.deepEqual(recorder.moveCalls, [
      { movingId: CHILD_ID, targetId: DOING_ID, position: "before", keepSubtree: false },
    ]);
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

    assert.deepEqual(recorder.moveCalls, [
      { movingId: CHILD_ID, targetId: DOING_ID, position: "after", keepSubtree: false },
    ]);
    assert.deepEqual(recorder.notices, []);
    await toggleReorder(container); // 收尾：关掉
  });

  test("引擎拒绝（success=false）→ Notice 带原因", async () => {
    const { container, recorder } = await render(validMarkdown11());
    recorder.host.moveNode = async (_file, movingId, targetId, position, options) => {
      recorder.moveCalls.push({ movingId, targetId, position, keepSubtree: options?.keepSubtree === true });
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
 * Phase 21：拖拽规则补充契约（doc/datacontact/data_ixd_discuss_interact_v0.21.md）
 *  ⑤ 开关「修改节点顺序」原位切换（不重渲染 → 折叠态与画面都不动）
 *  ⑥ 开关上方多一段拖拽规则说明（`.wf-reorder-help`，只切类名显隐）
 *  新 折叠节点拖动 = 整棵子树跟着走（`keepSubtree` 由 dragstart 时的折叠态决定）
 *  新 折叠三角直接改 JSON（`host.setNodeCollapsed`），失败提示 + 重渲染回到 JSON 事实
 * ------------------------------------------------------------------ */

describe("wfView · Phase 21 拖拽规则（原位开关 / 折叠态 / 规则说明）", () => {
  /** 折叠的 CHILD_ID（还带一个子节点）→ 用于「折叠节点拖拽」与「折叠态不丢」 */
  function markdownWithCollapsedChild(): string {
    const document = validDocument11();
    const child = document.workflows[0].root.children[0];
    child.children = [leaf("nd-extra", "补充任务")];
    child.collapsed = true;
    return writeBackDocument(validMarkdown11(), document).markdown;
  }

  test("开关原位切换：不重渲染、折叠的子树仍收起、说明块随之显隐", async () => {
    const { container, recorder } = await render(markdownWithCollapsedChild());
    const analysesBefore = recorder.analyzeCalls.count;
    const columnsBefore = container.query(".wf-active-columns")[0];
    const cardsBefore = container.query(".wf-card");

    const help = container.query(".wf-reorder-help")[0];
    assert.ok(help, "块尾上方应有拖拽规则说明");
    assert.ok(help.classList.contains("wf-reorder-help--hidden"), "开关「关」→ 说明隐藏");
    assert.match(help.text, /特别注意：父节点与子节点不能互换位置；根节点不能被拖动/);
    assert.equal(help.text.split("\n").length, 5, "5 行：4 个示意图 + 特别注意");

    await toggleReorder(container);

    assert.equal(recorder.analyzeCalls.count, analysesBefore, "开关不重渲染（没有重新 analyzeFile）");
    assert.equal(container.query(".wf-active-columns")[0], columnsBefore, "DOM 元素原样保留 → 画面不移动");
    assert.deepEqual(container.query(".wf-card"), cardsBefore, "卡片没有被重建");
    assert.equal(help.classList.contains("wf-reorder-help--hidden"), false, "开关「开」→ 说明显示");
    assert.equal(container.query(".wf-collapsed").length, 1, "折叠的子树仍然收起");
    assert.equal(container.query(".wf-caret")[1].text, "▸", "折叠三角方向不变");

    await toggleReorder(container); // 收尾：关掉
    assert.ok(help.classList.contains("wf-reorder-help--hidden"), "关回去 → 说明再隐藏");
    assert.equal(container.query(".wf-collapsed").length, 1, "关回去也不展开子树");
  });

  test("拖折叠节点 → keepSubtree=true；拖普通节点 → false", async () => {
    const { container, recorder } = await render(markdownWithCollapsedChild());
    await toggleReorder(container);

    const folded = cardOf(container, CHILD_ID);
    const target = cardOf(container, DOING_ID);
    target.rect.top = 200;
    target.rect.height = 40;
    folded.ondragstart?.(dragEvent(110));
    target.ondrop?.(dragEvent(235));
    await flush();
    await flush();
    assert.deepEqual(recorder.moveCalls[0], {
      movingId: CHILD_ID,
      targetId: DOING_ID,
      position: "after",
      keepSubtree: true,
    });

    // drop 后整块重渲染（拓扑变了）→ 卡片重新查一次；DOING_ID 没有子节点 → keepSubtree=false
    const plainSource = cardOf(container, DOING_ID);
    const plainTarget = cardOf(container, CHILD_ID);
    plainTarget.rect.top = 300;
    plainTarget.rect.height = 40;
    plainSource.ondragstart?.(dragEvent(310));
    plainTarget.ondrop?.(dragEvent(335));
    await flush();
    await flush();
    assert.deepEqual(recorder.moveCalls[1], {
      movingId: DOING_ID,
      targetId: CHILD_ID,
      position: "after",
      keepSubtree: false,
    });

    await toggleReorder(container); // 收尾：关掉
  });

  test("折叠写回失败 → 提示原因 + 重渲染回到 JSON 事实", async () => {
    const { container, recorder } = await render(validMarkdown11());
    recorder.host.setNodeCollapsed = async (_file, nodeId, collapsed) => {
      recorder.collapseCalls.push({ nodeId, collapsed });
      return {
        success: false,
        changed: false,
        issues: [],
        nodeId,
        collapsed,
        changedNodeIds: [],
        reason: "文件被占用",
      };
    };
    const analysesBefore = recorder.analyzeCalls.count;

    container.query(".wf-caret")[0].onclick?.(mouseEvent());
    assert.equal(container.query(".wf-collapsed").length, 1, "先按用户意图切 DOM（不等写回）");
    await flush();
    await flush();

    assert.deepEqual(recorder.notices, ["折叠状态未写入：文件被占用"]);
    assert.equal(recorder.analyzeCalls.count, analysesBefore + 1, "失败后整块重渲染");
    assert.equal(container.query(".wf-collapsed").length, 0, "以 JSON 为准：仍然是展开的");
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
  test("① 页面宽度：渲染区随容器自适应（Phase 25：1400px 上限已删除），且不碰 Obsidian 自己的类", () => {
    // 两次真机返工的回归点都盯在这一个测试里：
    //   v0.16.0 负 margin 外扩 → 超出页面列被祖先裁掉（两侧看不见）；
    //   v0.16.1 改 `.cm-content` / `.cm-sizer` 的 max-width + margin → 正文列压塌成「一行一个字」。
    // Phase 25：1100/1400 那种「渲染区封顶」作废 —— 宽度完全交给页面列 / leaf。
    const raw = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    // 只检查活规则：注释里会提到上面那些类名（教训文档），不能算违规
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    const sliceAt = (needle: string): string => {
      const index = css.indexOf(needle);
      assert.notEqual(index, -1, `styles.css 缺少「${needle}」`);
      return css.slice(index, index + 300);
    };

    // ①-1 页面列跟随窗口：只改写 Obsidian 官方的行宽变量（`100%` = 不封顶），阅读视图 + 实时预览都要
    for (const view of [".markdown-preview-view:has(.wf-view)", ".markdown-source-view:has(.wf-view)"]) {
      const block = sliceAt(view);
      assert.match(block, /--file-line-width:\s*100%/, `${view} 没放开 --file-line-width`);
    }
    // 上限 token 已经删干净：留一条残留就是回归（它会让渲染区又封顶）
    assert.equal(css.includes("--wf-view-max-width"), false, "`--wf-view-max-width` 必须彻底删除");

    // ①-2 渲染区自己：铺满容器，**没有** max-width / auto margin；不测宽度、不越界
    const view = sliceAt(".wf-view {");
    assert.match(view, /width:\s*100%/, "渲染区要铺满容器（= 跟随页面 / leaf）");
    assert.doesNotMatch(view, /max-width:/, "Phase 25：渲染区不再有宽度上限");
    assert.doesNotMatch(view, /margin-(left|right):\s*auto/, "不再靠 auto margin 居中夹宽");
    assert.doesNotMatch(view, /margin-(left|right):\s*calc\(/, "不许再用负 margin 外扩（会被祖先裁掉）");
    // 抽屉的覆盖式上拉需要定位上下文
    assert.match(view, /position:\s*relative/, "`.wf-view` 要是定位上下文（抽屉覆盖式上拉）");

    // ①-3 绝不改 Obsidian 自己的布局类（v0.16.1 的事故源）：出现任何一个就是回归
    for (const own of [".markdown-preview-sizer", ".cm-sizer", ".cm-contentContainer", ".cm-content"]) {
      assert.equal(css.includes(own), false, `不许改写 Obsidian 自己的 ${own}`);
    }
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
        if (child.classList.contains("wf-widget-tabs")) return "tabs";
        if (child.classList.contains("wf-widget-popup-body")) return "body";
        return `?${child.allText}`;
      }),
      ["head", "tabs", "body"],
      "弹窗 = 标题行 + tab 行 + 内容区",
    );
    assert.equal(popup.query(".wf-widget-popup-close")[0].text, "×");
    // 点遮罩不关闭：压根没挂关闭回调（Phase 16 的关闭语义不变）
    assert.equal(overlay.onclick, null, "遮罩上不挂点击关闭");
    assert.ok(currentPopup() !== undefined, "弹窗还在");
    assert.equal(widget.query(".wf-archive-row").length, 0, "没有造归档文件 → 空列表");
    assert.equal(widget.query(".wf-widget-placeholder").length, 1, "📦 里是空态占位");
    closeWidget();
    assert.equal(body.query(".wf-widget-overlay").length, 0, "关掉弹窗时遮罩一起清掉");
  });
  test("Phase 37/39：📦 列出 archive/ 下全部归档文件（懒加载元数据，可点开）", async () => {
    const { container, recorder } = await render(validMarkdown13());
    const fileA = "_workflowwatcher/archive/wf-other-nd-root.wf.json";
    const fileB = "_workflowwatcher/archive/wf-third-nd-x.wf.json";
    recorder.archiveFixture.files.push(fileA, fileB);
    recorder.archiveMetaFixture.metas[fileA] = {
      path: fileA,
      workflowId: "wf-other",
      title: "别的看板（已归档）",
      fromWorkflow: "另一个看板",
      fromNode: "别的节点",
    };
    recorder.archiveMetaFixture.metas[fileB] = {
      path: fileB,
      workflowId: "wf-third",
      title: "第三份（已归档）",
      fromWorkflow: "另一个看板",
      fromNode: "第三份",
    };
    const widget = openWidget(container, "📦");
    await flush();

    const section = widget.query(".wf-archive-files")[0];
    assert.ok(section !== undefined, "应有一个「归档文件」区块");
    assert.equal(
      section.query(".wf-archive-group-title")[0]?.text,
      t("view.archive.filesTitle", { count: "2" }),
    );
    const rows = section.query(".wf-archive-row--file");
    assert.equal(rows.length, 2, "磁盘上几份就列几行（含别的看板留下的）");

    const open = rows[0].query(".wf-archive-row-btn").find((b) => b.text === t("view.archive.open"));
    open?.onclick?.(mouseEvent());
    assert.deepEqual(recorder.archiveBoardCalls, [fileA]);
    // Phase 41：开归档看板后弹窗自动收掉（不再需要手动「×」）
    assert.equal(currentPopup(), undefined);
  });



  test("③ 📊 打开 tabbed 弹窗并停在「方块阵 + 甘特图」页", async () => {
    const { container } = await render(validMarkdown13());
    const widget = openWidget(container, "📊");
    assert.ok(currentPopup()?.classList.contains("wf-widget-popup--tabs"), "统一固定尺寸弹窗");
    assert.equal(activeWidgetTab()?.text, t("view.widget.gantt21"), "默认停在点开的那一页");
    assert.equal(currentPopup()?.query(".wf-widget-popup-title")[0].text, t("view.widget.gantt21"));
    assert.equal(widget.query(".wf-heatmap").length, 1);
    assert.equal(widget.query(".wf-gantt").length, 1);
    closeWidget();
  });

  test("Phase 19 M2：🎯 停在 quadrant 页，内容 = 16 分区 + 右侧预览", async () => {
    const { container } = await render(validMarkdown13());
    const widget = openWidget(container, "🎯");
    assert.ok(currentPopup()?.classList.contains("wf-widget-popup--tabs"), "统一固定尺寸弹窗");
    assert.equal(activeWidgetTab()?.text, t("view.widget.quadrant"), "默认停在点开的那一页");
    assert.equal(currentPopup()?.query(".wf-widget-popup-title")[0].text, t("view.widget.quadrant"));
    assert.equal(widget.query(".wf-quad-partition").length, 16, "4×4 = 16 分区");
    assert.equal(widget.query(".wf-quad-preview").length, 1);
    assert.equal(widget.query(".wf-quad-node").length, 0, "刚打开时预览是空的（只有提示行）");
    assert.equal(widget.query(".wf-quad-empty").length, 1);
    closeWidget();
  });

  test("Phase 19 M3：📈 停在 plot 页，内容 = plot 列表 + 折线区（空目录时给提示）", async () => {
    const { container } = await render(validMarkdown13());
    const widget = openWidget(container, "📈");
    assert.ok(currentPopup()?.classList.contains("wf-widget-popup--tabs"), "统一固定尺寸弹窗");
    assert.equal(activeWidgetTab()?.text, t("view.widget.plot365"), "默认停在点开的那一页");
    assert.equal(currentPopup()?.query(".wf-widget-popup-title")[0].text, t("view.widget.plot365"));
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

  test("顺序 = 标题 → 元信息 → 时间 → 进度条；链接数固定显示（Phase 45 去掉概要段）", async () => {
    // Phase 27 M3：🔗 的条数改由反向 YAML 归属给（`host.linkedFiles`），不再数正文里的超链接
    const { container } = await renderWith(validMarkdown(), (rec) => {
      rec.linkFixture.files = [
        { path: "notes/竞品分析报告.md", title: "竞品分析报告", workflowTitle: "立项调查", nodeTitle: "调研竞品", nodeId: ROOT_ID },
      ];
    });
    const card = container.query(".wf-card")[0];
    const shape = card.children.map((child) => {
      for (const name of ["wf-card-top", "wf-card-meta", "wf-card-line", "wf-card-progress"]) {
        if (child.classList.contains(name)) return name;
      }
      return `?${child.allText}`;
    });
    // 夹具根节点：done + 有 summary + 没有计时 → Phase 18 ⑧ 起多一行「x天完成 · x天前结束」，进度条收在最后
    // Phase 45：节点 summary 已废弃，卡片不再渲染概要段
    assert.deepEqual(shape, ["wf-card-top", "wf-card-meta", "wf-card-line", "wf-card-progress"]);

    // 资料文件数量固定给出（根节点名下 1 份；别的节点 0 份也照显示）
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

    // Phase 27 M2 起分栏里多一列钉死的「未分类」，它也用 `.wf-lane` 当外壳（Phase 33 又给它套了框）
    // → 这里只数**横滚区里的泳道**（= 进行中 workflow 各一条），未分类那一列按口径排除。
    const lanes = container.query(".wf-lane").filter((lane) => lane.closest(".wf-unclassified") === null);
    assert.equal(lanes.length, 2, "两条进行中泳道（未分类列不算泳道）");
    assert.equal(container.query(".wf-lane-body").length, 2, "每条泳道一个滚动容器（两条泳道两条滚动条）");
    for (const lane of lanes) {
      const body = lane.query(".wf-lane-body")[0];
      assert.ok(body !== undefined, "泳道必须有正文区");
      assert.equal(body.query(".wf-lane-head").length, 0, "栏头不在滚动区里（栏头固定）");
    }
  });

  test("styles.css：正文区自滚 + 非首栏左边框当分隔线（不加 DOM）", () => {
    const raw = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    // Phase 26：看板里另有一条 `.workspace-leaf-content[…] .wf-lane-body`（把上限改成 none），
    // 所以这里必须按「行首的 .wf-lane-body」找**基线**那条（前导 `\n` 区分）。
    const start = css.indexOf("\n.wf-lane-body {");
    assert.notEqual(start, -1, "styles.css 缺少基线 .wf-lane-body");
    const laneBody = css.slice(start, start + 320);
    assert.match(
      laneBody,
      /max-height:\s*var\(--wf-lane-max-height,\s*800px\)/,
      "笔记嵌入里仍读 --wf-lane-max-height 变量（看板由 ItemView 全高接管）",
    );
    assert.match(laneBody, /overflow-y:\s*auto/, "只有正文纵向滚动");
    assert.match(css, /\.wf-column \+ \.wf-column \.wf-lane \{[^}]*border-left/, "非首栏用左边框当分隔线");
  });
});

/* ------------------------------------------------------------------ *
 * Phase 18：大标题、卡片第二段三态、间隙滚轮横滚、甘特 tooltip 三段
 * ------------------------------------------------------------------ */

describe("wfView · Phase 18 ③ 引导性大标题", () => {
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
  });
});

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

  test("⑦ 卡片宽度：没有字面值残留，`.wf-card` 回落 250px", () => {
    const css = cssOf();
    assert.doesNotMatch(css, /--wf-card-width:\s*\d+px/, "body / magazine 的字面值都删掉了（设置是唯一权威）");
    assert.match(blockOf(css, ".wf-card"), /width:\s*var\(--wf-card-width,\s*250px\)/);
  });

  test("Phase 19 M2：4 象限 = perspective + rotateX/rotateY、内侧描边、空分区虚线、4 色 × 5 档", () => {
    const css = cssOf();
    assert.match(blockOf(css, ".wf-widget-popup--tabs"), /width:\s*min\(1180px/, "Phase 30：统一 tabbed 弹窗足够宽");
    assert.match(blockOf(css, ".wf-quad-stage"), /perspective:\s*1200px/, "透视给父级（斜俯视）");
    const plane = blockOf(css, ".wf-quad-plane");
    assert.match(plane, /grid-template-columns:\s*repeat\(4/, "16 分区（4 列）");
    assert.match(plane, /grid-template-rows:\s*repeat\(4/, "16 分区（4 行）");
    assert.match(plane, /rotateX\(/, "平面转 x（俯视）");
    assert.match(plane, /rotateY\(/, "平面转 y（侧视）");
    assert.match(plane, /transform-style:\s*preserve-3d/, "选中态靠 translateZ 浮起来");
    const cell = blockOf(css, ".wf-quad-partition");
    assert.match(cell, /border-radius:/);
    // 内侧描边：offset 必须是负值（具体的 -2 / -4 是视觉调参，契约只要求「画在格子里面」）
    assert.match(cell, /outline-offset:\s*-\d+px/, "描边画在格子内侧");
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
    // Phase 30：plot 不再有自己的宽度变体，统一进 tabbed 弹窗（见 Phase 30 块）
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
    // 契约演化（Phase 21+）：plot 的图表框 / 文字跟随 `fresh` 主题换了底色 —— 主题化只允许出现在 fresh 下，
    // 其余主题仍然读 Obsidian token。
    for (const themed of css.match(/\[data-wf-theme="[a-z]+"\][^{]*\.wf-plot/g) ?? []) {
      assert.match(themed, /data-wf-theme="fresh"/, `plot 只跟随 fresh 主题，实际出现：${themed}`);
    }
  });

  test("Phase 19 补充契约⑤：象限留白 + 平面内交叉轴 + 旋转让右上最近", () => {
    const css = cssOf();
    const stage = blockOf(css, ".wf-quad-stage");
    // 留白的四个具体值属于视觉调参，契约只要求「四周都留了白」
    assert.match(stage, /padding:\s*\d+px \d+px \d+px \d+px/, "四周留白");
    assert.match(stage, /overflow:\s*visible/, "转过的平面不被裁");
    const plane = blockOf(css, ".wf-quad-plane");
    assert.match(plane, /position:\s*relative/, "轴线要绝对定位在平面里");
    assert.match(plane, /gap:\s*10px/, "分区之间留空隙");
    assert.match(plane, /transform:\s*rotateX\(-56deg\) rotateY\(-22deg\)/, "上沿 + 右沿朝镜头");
    // ⑤b 的轴线（`.wf-quad-axis-line`）时开时关（视觉调参）：关着就什么都不校验，开着按契约校验；
    // 线宽 / 箭头尺寸是调参值，契约只要求「单箭头、画在平面内、不吃事件」。
    const axis = blockOf(css, ".wf-quad-axis-line");
    if (axis === "") return;
    assert.match(axis, /position:\s*absolute/);
    assert.match(axis, /pointer-events:\s*none/, "轴线不吃事件");
    assert.match(blockOf(css, ".wf-quad-axis-line--x"), /border-top:\s*\d+px solid/, "x 轴是长直线");
    assert.match(blockOf(css, ".wf-quad-axis-line--y"), /border-left:\s*\d+px solid/, "y 轴是长直线");
    assert.match(blockOf(css, ".wf-quad-axis-line--x::after"), /border-left:\s*\d+px solid/, "x 轴单箭头朝右");
    assert.match(blockOf(css, ".wf-quad-axis-line--y::after"), /border-bottom:\s*\d+px solid/, "y 轴单箭头朝上");
  });
});

/* ------------------------------------------------------------------ *
 * Phase 20：note 卡片（节点卡片下方的附注）
 *
 * 契约「Phase 20 定稿契约」§5 / §9：DOM 顺序固定为 [.wf-card, .wf-note, .wf-row]，
 * note 卡**不参与拖拽**，右键只有一项「🔖 设置 note 节点…」（与节点菜单进同一 Modal）；
 * 表现层全部交给 CSS 变量（静态断言在下面第二个 describe）。
 * ------------------------------------------------------------------ */

describe("wfView · Phase 20 note 卡片（视图）", () => {
  /** 往 v1.1 样例的节点上补 note / noteVisible，再写回成 markdown（走真实引擎） */
  const markdownWithNote = (patch: (document: WfJsonDocument) => void): string => {
    const document = validDocument11();
    patch(document);
    return writeBackDocument(validMarkdown11(), document).markdown;
  };

  /** 样例里的第一个工作流根节点（所有 note 断言都挂在它 / 它的子节点上） */
  const rootOf = (document: WfJsonDocument) => document.workflows[0].root;

  /** 右键某张卡片 → 返回菜单项（找不到菜单就让测试失败） */
  const menuItemsAfter = (card: StubElement): StubElement[] => {
    card.oncontextmenu?.(mouseEvent());
    const menu = body.query(".wf-menu")[0];
    assert.ok(menu, "右键应弹出菜单");
    return menu.query(".wf-menu-item");
  };

  /**
   * 按标题找卡片。根节点卡片**永远不挂** `data-node-id`（Phase 15：只有非根卡片能拖），
   * 所以不能用 `cardOf(container, ROOT_ID)`；这里改用标题匹配。
   */
  const cardByTitle = (container: StubElement, title: string): StubElement => {
    const card = container.query(".wf-card").find((element) => element.textContent.includes(title));
    assert.ok(card !== undefined, `应渲染出标题为「${title}」的节点卡`);
    return card;
  };

  test("① ON + 有条目 → 1 张 note 卡：文字无标志、待办空心方框、已办对号", async () => {
    const { container } = await render(
      markdownWithNote((document) => {
        rootOf(document).note = [
          { text: "先截 3 家的定价页" },
          { text: "补一份对比表", done: false },
          { text: "把结论发给组长", done: true },
        ];
        rootOf(document).noteVisible = true;
      }),
    );

    const notes = container.query(".wf-note");
    assert.equal(notes.length, 1, "开着开关且有条目 → 渲染一张 note 卡");
    assert.equal(notes[0].query(".wf-note-tag")[0].text, "note", "标签文案来自 i18n（大写是 CSS 干的）");

    const rows = notes[0].query(".wf-note-item");
    assert.equal(rows.length, 3, "一条一行");

    assert.equal(rows[0].classList.contains("wf-note-item--text"), true, "done 缺省 = 文字");
    assert.equal(rows[0].query(".wf-note-check").length, 0, "文字条目不画方框");
    assert.equal(rows[0].query(".wf-note-text")[0].text, "先截 3 家的定价页");

    assert.equal(rows[1].classList.contains("wf-note-item--todo"), true, "done=false = 待办");
    assert.equal(rows[1].query(".wf-note-check").length, 1, "待办有一枚方框");
    assert.equal(
      rows[1].query(".wf-note-check")[0].classList.contains("wf-note-check--done"),
      false,
      "待办是空心",
    );

    assert.equal(rows[2].classList.contains("wf-note-item--done"), true, "done=true = 已办");
    assert.equal(
      rows[2].query(".wf-note-check")[0].classList.contains("wf-note-check--done"),
      true,
      "已办带 --done 修饰（样式里画对号，不再是实心方块）",
    );
    assert.equal(rows[2].query(".wf-note-text")[0].text, "把结论发给组长");
  });

  test("①b 一条只显示第一行（换行符之后的部分截掉）", async () => {
    const { container } = await render(
      markdownWithNote((document) => {
        rootOf(document).note = [{ text: "第一行\n第二行" }];
        rootOf(document).noteVisible = true;
      }),
    );
    assert.equal(container.query(".wf-note-text")[0].text, "第一行");
  });

  test("①c 超过 noteLines() 的条目静默截断（数据仍在 JSON 里）", async () => {
    const { container, recorder } = await render(
      markdownWithNote((document) => {
        rootOf(document).note = [{ text: "一" }, { text: "二" }, { text: "三" }, { text: "四" }, { text: "五" }];
        rootOf(document).noteVisible = true;
      }),
    );
    // 默认设置 noteLines = 3
    assert.equal(container.query(".wf-note-item").length, 3, "只渲染前 3 条");
    assert.equal(recorder.state.markdown.includes('"text": "五"'), true, "第 5 条仍在文档里，只是没画");
  });

  test("② ③ 有条目但开关缺省 / 开关 ON 但条目全是空白 → 都不渲染", async () => {
    const hidden = await render(
      markdownWithNote((document) => {
        rootOf(document).note = [{ text: "等第 4 位受访者确认时间" }];
      }),
    );
    assert.equal(hidden.container.query(".wf-note").length, 0, "开关缺省 = OFF，条目只留在 JSON 里");

    const blank = await render(
      markdownWithNote((document) => {
        rootOf(document).note = [{ text: "   " }];
        rootOf(document).noteVisible = true;
      }),
    );
    assert.equal(blank.container.query(".wf-note").length, 0, "没有有效条目 → 不渲染（脏数据兜底）");
  });

  test("④ ⑤ 两个节点各一条 → 2 张；列内顺序固定 [wf-card, wf-note, wf-row]", async () => {
    const { container } = await render(
      markdownWithNote((document) => {
        const root = rootOf(document);
        root.note = [{ text: "根节点的附注" }];
        root.noteVisible = true;
        const child = root.children?.[0];
        assert.ok(child !== undefined, "样例根节点应有子节点");
        child.note = [{ text: "子节点的附注" }];
        child.noteVisible = true;
      }),
    );

    assert.equal(container.query(".wf-note").length, 2, "每个带 note 的节点一张卡");

    const column = cardByTitle(container, "调研竞品").parent;
    assert.ok(column !== null, "卡片应挂在列里");
    const shape = column.children.map((element) => {
      for (const name of ["wf-card", "wf-note", "wf-row"]) {
        if (element.classList.contains(name)) return name;
      }
      return element.tagName;
    });
    assert.deepEqual(shape, ["wf-card", "wf-note", "wf-row"], "note 夹在卡片与子节点行之间");
  });

  test("⑥ note 卡右键只有「🔖 设置 note 节点…」一项（节点菜单那一项已移入面板 tab）", async () => {
    const { container, recorder } = await render(
      markdownWithNote((document) => {
        rootOf(document).note = [{ text: "附注一" }];
        rootOf(document).noteVisible = true;
      }),
    );
    const note = container.query(".wf-note")[0];
    assert.equal(note.draggable, false, "不参与「修改节点顺序」");
    assert.equal(note.closest(".wf-card"), null, "拖拽落点解析不到卡片 → 走取消分支");

    note.oncontextmenu?.(mouseEvent());
    const menu = body.query(".wf-menu")[0];
    assert.ok(menu !== undefined, "右键 note 卡应弹出菜单");
    const items = menu.query(".wf-menu-item");
    assert.deepEqual(texts(items), ["🔖 设置 note 节点…"], "只有一项，且就是面板 note tab 的同名入口");

    items[0].onclick?.(mouseEvent());
    await flush();
    assert.deepEqual(recorder.noteCalls, [{ nodeId: ROOT_ID }], "打开面板的 note tab");
  });

  test("⑥b 方框点击 → host.toggleNodeNote(节点 id, 原始下标)；文字条目没有方框", async () => {
    const { container, recorder } = await render(
      markdownWithNote((document) => {
        // 故意塞一条空白条目：视图要按**原始下标**回调（引擎按 note[index] 定位）
        rootOf(document).note = [{ text: "  " }, { text: "文字一" }, { text: "待办一", done: false }];
        rootOf(document).noteVisible = true;
      }),
    );

    const rows = container.query(".wf-note-item");
    assert.equal(rows.length, 2, "空白条目被视图丢掉，不渲染");
    assert.equal(rows[0].classList.contains("wf-note-item--text"), true);
    assert.equal(rows[0].query(".wf-note-check").length, 0, "文字条目没有方框可点");

    rows[1].query(".wf-note-check")[0].onclick?.(mouseEvent());
    await flush();
    assert.deepEqual(recorder.noteToggleCalls, [{ nodeId: ROOT_ID, index: 2 }], "下标对得上 note 数组");
  });

  test("⑦ 节点右键「结构」组只剩「编辑节点信息…」（note / 加子节点 / 删除本节点 已移入面板 tab）", async () => {
    const { container } = await render(validMarkdown11());
    const labels = texts(menuItemsAfter(cardByTitle(container, "调研竞品")));
    assert.ok(
      labels.includes("✏️ 编辑节点信息…"),
      `菜单里应有「✏️ 编辑节点信息…」，实际：${labels.join(" / ")}`,
    );
    for (const removed of ["🔖 设置 note 节点…", "➕ 添加子节点…", "🗑 删除本节点…"]) {
      assert.ok(
        !labels.includes(removed),
        `「${removed}」已并入面板 tab，不该再出现在节点菜单：${labels.join(" / ")}`,
      );
    }
  });
});

describe("wfView · Phase 20 样式契约（styles.css 静态断言）", () => {
  /** 去掉注释后的 CSS（避免注释里的示例把人骗过去） */
  const cssOf = (): string =>
    readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
  /** 取某条规则的声明块（选择器必须顶格写在行首，否则会命中带前缀的长选择器） */
  const blockOf = (css: string, selector: string): string => {
    const match = new RegExp(`(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`).exec(css);
    return match?.[1] ?? "";
  };
  /** 8 套装饰主题（素净基线不写主题块：`.wf-note` 的回落值 + 左侧 accent 就是 base 那一段） */
  const THEMES = ["tech", "nature", "magazine", "retro", "polka", "web", "fresh", "shoujo"];

  /** 收集某套主题块里声明的全部 `--wf-note-*`（亮 / 暗各一份，都在同一主题选择器上） */
  const noteVarsOf = (css: string, theme: string): string[] => {
    const found: string[] = [];
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = ruleRe.exec(css)) !== null) {
      if (!match[1].includes(`[data-wf-theme="${theme}"]`)) continue;
      for (const declaration of match[2].match(/--wf-note-[\w-]+:\s*[^;]+/g) ?? []) found.push(declaration.trim());
    }
    return found;
  };

  test("base 段：与节点卡同宽、只走 --wf-note-* 变量、连线用 --wf-elbow-height", () => {
    const css = cssOf();
    const note = blockOf(css, ".wf-note");
    assert.ok(note.length > 0, ".wf-note base 段应存在");
    assert.match(note, /width:\s*var\(--wf-card-width,\s*250px\)/, "与节点卡同宽");
    assert.match(note, /margin-top:\s*var\(--wf-elbow-height(?:,\s*19px)?\)/, "让出与父卡之间的连线");
    assert.match(note, /font-size:\s*var\(--wf-note-font-size/, "字号只由变量控制（主题只写变量）");
    assert.match(
      blockOf(css, ".wf-note::before"),
      /height:\s*var\(--wf-elbow-height(?:,\s*19px)?\)/,
      "::before 是连线（与 .wf-elbow 同高），主题装饰不许抢",
    );
    assert.match(blockOf(css, ".wf-note-tag"), /text-transform:\s*uppercase/, "小标签统一大写");
  });

  test("条目行：一条一行、单行省略（条数截断交给视图，不再用 -webkit-line-clamp）", () => {
    const css = cssOf();
    const body = blockOf(css, ".wf-note-body");
    assert.doesNotMatch(body, /-webkit-line-clamp/, "条数截断改由视图 slice，note 正文不再按行裁");
    assert.match(body, /flex-direction:\s*column/, "一条一行");
    assert.match(blockOf(css, ".wf-note-text"), /text-overflow:\s*ellipsis/, "超宽省略");
    assert.match(blockOf(css, ".wf-note-text"), /white-space:\s*nowrap/, "卡片上一行一条，不折行");
    assert.match(
      blockOf(css, ".wf-note-item--done .wf-note-text"),
      /text-decoration:\s*line-through/,
      "已办划掉",
    );

    // 待办的空心方框 vs 已办的对号：共用同一个 14px 槽位，所以三种条目的正文左对齐
    const check = blockOf(css, ".wf-note-check");
    assert.match(check, /color:\s*inherit/, "方框要吃到主题的 note 文字色");
    assert.match(check, /width:\s*14px/, "待办 / 已办共用 14px 槽位");
    assert.match(check, /height:\s*14px/, "槽位是正方形");
    assert.match(
      blockOf(css, ".wf-note-item--text"),
      /padding-left:\s*calc\(14px \+ 4px\)/,
      "文字条目按同宽让位（没有标志也不跑偏）",
    );
    assert.match(blockOf(css, ".wf-note-check--done"), /background:\s*transparent/, "已办不填色");
    assert.match(
      blockOf(css, ".wf-note-check--done::before"),
      /content:\s*"✓"/,
      "已办画对号（与待办的空心方框一眼分得开）",
    );
  });

  test("8 套主题的 --wf-note-* 覆盖齐备且互不相同；素净基线只加 accent", () => {
    const css = cssOf();
    const signatures = new Set<string>();
    for (const theme of THEMES) {
      const declarations = noteVarsOf(css, theme);
      assert.ok(declarations.length >= 4, `${theme} 至少有 4 条 --wf-note-*（亮 + 暗各一份）`);
      const signature = [...declarations].sort().join("|");
      assert.equal(signatures.has(signature), false, `${theme} 的 note 变量不能与别的主题雷同`);
      signatures.add(signature);
    }
    assert.equal(signatures.size, THEMES.length, "8 套主题各不相同");
    assert.match(
      blockOf(css, ".wf-note"),
      /border-left-width:\s*var\(--wf-note-accent-width,\s*2px\)/,
      "素净基线 = 裸装 + 左侧状态色 accent（Phase 44：原 default 主题的差值并入 base）",
    );
    assert.doesNotMatch(css, /data-wf-theme="default"/, "default 主题已删除，样式表里不许再有它的桶");
    // shoujo 的星芒层（`.wf-note::after`）目前在 styles.css 里整段注释掉（视觉调试中）：
    // 重新打开后这条断言自动恢复校验（见 `cssOf()` 剥注释，取不到就当「还没开」）。
    if (css.includes('.wf-theme[data-wf-theme="shoujo"] .wf-note::after')) {
      assert.match(
        css,
        /\.wf-theme\[data-wf-theme="shoujo"\] \.wf-note::after\s*\{/,
        "shoujo 的星芒走 ::after",
      );
    }
  });

  test("对话框表格：正文列约 80 个半角字符、宽屏 Modal、药丸开关与置顶按钮都有样式", () => {
    const css = cssOf();
    assert.match(
      blockOf(css, ".wf-note-cell-text"),
      /min-width:\s*var\(--wf-note-edit-width,\s*80ch\)/,
      "正文列按 80 个半角字符兜底",
    );
    assert.match(blockOf(css, ".modal.wfjson-modal--wide"), /width:\s*min\(94vw,\s*940px\)/);
    assert.match(blockOf(css, ".wf-note-table"), /border-collapse:\s*collapse/);
    assert.match(blockOf(css, ".wf-note-pin"), /white-space:\s*nowrap/, "置顶按钮不换行");

    // 显示开关仍是药丸（不是按钮）：胶囊轨道 + 开态强调色 + 滑块右移 + 键盘焦点环
    assert.match(blockOf(css, ".wfjson-pill"), /display:\s*inline-flex/, "药丸外壳");
    assert.match(blockOf(css, ".wfjson-pill-track"), /border-radius:\s*999px/, "胶囊形轨道");
    assert.match(
      blockOf(css, ".wfjson-pill-input:checked + .wfjson-pill-track"),
      /background:\s*var\(--interactive-accent\)/,
      "开态用主题强调色",
    );
    assert.match(
      blockOf(css, ".wfjson-pill-input:checked + .wfjson-pill-track .wfjson-pill-thumb"),
      /transform:\s*translateX\(18px\)/,
      "滑块右移",
    );
    assert.match(
      blockOf(css, ".wfjson-pill-input:focus-visible + .wfjson-pill-track"),
      /outline:\s*2px solid var\(--interactive-accent\)/,
      "视觉隐藏的 checkbox 仍需焦点环（键盘也能切）",
    );
    assert.match(blockOf(css, ".wfjson-pill-state"), /min-width:\s*2\.2em/, "OFF ⇄ ON 切换时后面不跳");
  });
});

describe("wfView · Phase 21 甘特 12 色主题配色（styles.css 静态断言）", () => {
  /** 去掉注释后的 CSS（注释里还留着早期 6 色示例块，不能被骗） */
  const cssOf = (): string =>
    readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  /**
   * 取「选择器列表里含指定选择器」的那条规则的声明块。
   * `mustDeclare` 用来跳过同名的短块（例如 `body.theme-dark .wf-theme[...]` 还出现在只改
   * `--interactive-accent` 的一行块里，那不是配色块）。
   */
  const ruleOf = (css: string, selector: string, mustDeclare = ""): string => {
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = ruleRe.exec(css)) !== null) {
      if (!match[2].includes(mustDeclare)) continue;
      if (!match[1].split(",").some((part) => part.trim() === selector)) continue;
      return match[2];
    }
    return "";
  };

  /** 8 套装饰主题（素净基线的色值挂在 `body` / `body.theme-dark` 上） */
  const THEMES = ["tech", "nature", "magazine", "retro", "polka", "web", "fresh", "shoujo"];

  /** 从声明块里取出 c0…c11 的 12 个色值（缺的留空串，交给断言报错） */
  const colorsOf = (declarations: string): string[] =>
    Array.from({ length: 12 }, (_, index) => {
      const found = new RegExp(`--wf-gantt-c${index}:\\s*(#[0-9a-fA-F]{6})`).exec(declarations);
      return found?.[1] ?? "";
    });

  const assertPalette = (declarations: string, label: string): string[] => {
    const colors = colorsOf(declarations);
    colors.forEach((color, index) => {
      assert.match(color, /^#[0-9a-f]{6}$/i, `${label} 缺 --wf-gantt-c${index}`);
    });
    assert.equal(
      new Set(colors.map((color) => color.toLowerCase())).size,
      12,
      `${label} 的 12 个色值必须互不相同（否则两个工作流会撞色）`,
    );
    return colors.map((color) => color.toLowerCase());
  };

  test("12 条取色规则：.wf-gantt-span--w0 … --w11 各自指向 --wf-gantt-cN", () => {
    const css = cssOf();
    for (let index = 0; index < 12; index += 1) {
      assert.match(
        ruleOf(css, `.wf-gantt-span--w${index}`),
        new RegExp(`background:\\s*var\\(--wf-gantt-c${index},`),
        `.wf-gantt-span--w${index} 必须取 c${index}`,
      );
    }
  });

  test("8 套主题的浅 / 暗两块都给齐 c0…c11，且每套配色互不相同", () => {
    const css = cssOf();
    const palettes = new Set<string>();
    for (const theme of THEMES) {
      const blocks = [
        { tone: "浅色", selector: `.wf-theme[data-wf-theme="${theme}"]` },
        { tone: "暗色", selector: `body.theme-dark .wf-theme[data-wf-theme="${theme}"]` },
      ];
      for (const block of blocks) {
        const colors = assertPalette(ruleOf(css, block.selector, "--wf-gantt-c0:"), `${theme} ${block.tone}`);
        const signature = colors.join("|");
        assert.equal(palettes.has(signature), false, `${theme} ${block.tone} 的 12 色不能与别的主题雷同`);
        palettes.add(signature);
      }
    }
    assert.equal(palettes.size, THEMES.length * 2, "8 套主题 × 浅 / 暗 = 16 组不同配色");
  });

  test("素净基线：浅色（body）与暗色（body.theme-dark）也各有 12 色，且深浅两套值不同", () => {
    const css = cssOf();
    const light = assertPalette(ruleOf(css, "body", "--wf-gantt-c0:"), "素净基线 浅色");
    const dark = assertPalette(ruleOf(css, "body.theme-dark", "--wf-gantt-c0:"), "素净基线 暗色");
    assert.notDeepEqual(light, dark, "浅色 / 暗色是两套值（暗色必须在深底上可读）");
  });

  test("全文件共 18 个块声明 c0…c11（8 套主题 + 素净基线，各 × 浅 / 暗）—— 少一个块就会回落到 c0 撞色", () => {
    const css = cssOf();
    for (let index = 0; index < 12; index += 1) {
      const count = (css.match(new RegExp(`--wf-gantt-c${index}:`, "g")) ?? []).length;
      assert.equal(count, 18, `--wf-gantt-c${index} 应出现在 18 个主题块里（当前 ${count} 个）`);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Phase 21：解除泳道宽度上限 + 连线锚点改到卡片中线
 * ------------------------------------------------------------------ */

describe("wfView · Phase 21 泳道宽度上限 / 连线锚点（styles.css 静态断言）", () => {
  /** 剥掉注释后的 CSS（注释里会复述这些规则） */
  const cssOf = (): string =>
    readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  /** 同一选择器可能有多条规则（例如 `.wf-active-columns` 一条管滚动条、一条管 flex） */
  const blocksOf = (css: string, selector: string): string[] => {
    const blocks: string[] = [];
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = ruleRe.exec(css)) !== null) {
      if (match[1].split(",").some((part) => part.trim() === selector)) blocks.push(match[2]);
    }
    return blocks;
  };

  /**
   * 取某条规则的声明块（**选择器精确匹配**：`.wf-lane` 不能被 `A + B .wf-lane` 这类组合
   * 选择器骗到，`.wf-cell--has-next::after` 也不能拿到与之并列的那条前半段规则）。
   * 命中多条时拼起来，断言只看「这条选择器名下声明了什么」。
   */
  const blockOf = (css: string, selector: string): string => {
    const blocks = blocksOf(css, selector);
    assert.ok(blocks.length > 0, `styles.css 缺少「${selector}」`);
    return blocks.join("\n");
  };

  test("多泳道不再互相遮盖：分栏 / 泳道都不许再 `max-width: 100%` 钳宽", () => {
    // 根因：`.wf-lane-body` 是 `min-width: max-content`，栏被 `max-width: 100%` 钳住后
    // 正文溢出到栏外 → 右边那一栏被上一栏的宽泳道盖住。
    const css = cssOf();
    for (const selector of [".wf-column", ".wf-lane"]) {
      assert.doesNotMatch(
        blockOf(css, selector),
        /max-width:\s*100%/,
        `${selector} 不许再钳到 100%（宽泳道会盖住右边一栏）`,
      );
    }
    assert.match(blockOf(css, ".wf-column"), /width:\s*max-content/, "分栏宽只由内容决定");
    assert.match(blockOf(css, ".wf-lane"), /width:\s*fit-content/, "泳道宽只由内容决定");
    // 装不下时由外层横向滚动（而不是切掉）
    for (const selector of [".wf-active-columns", ".wf-drawer-columns"]) {
      assert.ok(
        blocksOf(css, selector).some((block) => /overflow-x:\s*auto/.test(block)),
        `${selector} 要横向滚动（多栏合计超宽时）`,
      );
    }
  });

  test("连线锚点 = 卡片中线（--wf-cell-anchor），不再用「格子中线」的 50%", () => {
    const css = cssOf();
    const cell = blockOf(css, ".wf-cell");
    assert.match(cell, /--wf-cell-lead:\s*0px/, "首列不让位");
    assert.match(
      cell,
      /--wf-cell-anchor:\s*calc\(var\(--wf-cell-lead\) \+ var\(--wf-card-width, 250px\) \/ 2\)/,
      "锚点 = 侧列让位 + 卡宽一半（与设置里的卡片宽度联动）",
    );
    // Phase 42：回落值必须与 `.wf-card` 同值 —— 取不到 `--wf-card-width` 时（popout 窗口）
    // 锚点算不出来 → `margin-left` / `left` / `right` 全变 auto → 连线整体消失。
    const fallbackOf = (text: string): string =>
      /var\(--wf-card-width,\s*([^)]+?)\)/.exec(text)?.[1].trim() ?? "";
    assert.equal(
      fallbackOf(cell),
      fallbackOf(blockOf(css, ".wf-card")),
      "--wf-cell-anchor 的 `--wf-card-width` 回落值必须与 `.wf-card` 同值（否则取不到变量时连线消失 / 卡宽与锚点对不上）",
    );
    assert.match(blockOf(css, ".wf-cell--side"), /--wf-cell-lead:\s*24px/, "侧列让位进变量");

    assert.match(
      blockOf(css, ".wf-elbow"),
      /margin-left:\s*calc\(var\(--wf-cell-anchor\) - 1px - var\(--wf-cell-lead\)\)/,
      "竖线对齐卡片中线（-1px = 线宽一半；再减去侧列让位 —— margin 从 padding box 起算，不减就右偏 24px）",
    );
    assert.match(
      blockOf(css, ".wf-cell--side::before"),
      /right:\s*calc\(100% - var\(--wf-cell-anchor\)\)/,
      "左半截横线收到锚点为止",
    );
    assert.match(
      blockOf(css, ".wf-cell--has-next::after"),
      /left:\s*var\(--wf-cell-anchor\)/,
      "右半截横线从锚点出发",
    );
    // 回归点：`right: 50%` / `left: 50%` 就是多子节点时连线跑偏的写法
    assert.doesNotMatch(css, /\.wf-cell--(side|has-next)::(before|after)\s*\{[^}]*(left|right):\s*50%/, "不许再按格子宽度的一半定位");

    /*
     * Phase 43：连线几何 / 颜色**必须带回落值**。
     * `--wf-linkline-card` / `--wf-elbow-height` / `--wf-line-color` 只在 `body{}` 里定义 ——
     * 那段没生效时（旧缓存 / 非主窗口文档）`width` / `height` 退化成 `auto`：空 div 在
     * `display:flex` + `align-items:center` 的 `.wf-cell` 里量成 **0×0**，`background` 也变
     * 透明；伪元素的 `height: auto` 同理为 0。表现都是「连线一条都不显示」（DevTools 里
     * 看起来像伪元素没生成），而卡片本身完全正常。回落值与 `body{}` 同值。
     */
    const elbow = blockOf(css, ".wf-elbow");
    assert.match(elbow, /width:\s*var\(--wf-linkline-card,\s*1px\)/, "竖线线宽要有回落值");
    assert.match(elbow, /height:\s*var\(--wf-elbow-height,\s*19px\)/, "竖线高度要有回落值");
    assert.match(elbow, /background:\s*var\(--wf-line-color,/, "竖线颜色要有回落值");
    for (const selector of [".wf-cell--side::before", ".wf-cell--has-next::after"]) {
      const block = blockOf(css, selector);
      assert.match(block, /height:\s*var\(--wf-linkline-card,\s*1px\)/, `${selector} 线宽要有回落值`);
      assert.match(block, /top:\s*calc\(var\(--wf-elbow-height,\s*19px\)/, `${selector} 纵向位置要有回落值`);
      assert.match(block, /background:\s*var\(--wf-line-color,/, `${selector} 颜色要有回落值`);
    }
  });
});

/* ------------------------------------------------------------------ *
 * Phase 24：ItemView 看板（契约 doc/datacontact/phase24_bound.md §7）
 *
 * `WfBoardView` 本身（ItemView 子类）没有单测基建，靠 §8 的手动清单覆盖；
 * 这里测它依赖的**渲染器契约**：strictFile / 归档跳转 / 单例分桶 / 标签页标题。
 * ------------------------------------------------------------------ */
describe("wfView · Phase 24 看板（strictFile / 归档看板 / 单例分桶）", () => {
  /** 造一个「另一个文件」的假 TFile（`makeHost` 的 vault 永远返回 test.md） */
  const fakeFile = (path: string): TFile => ({ ...file, path, basename: path.replace(/\.md$/i, "") });

  /** 用指定文件渲染一次（双看板用例要两个不同的 `file.path` 才验证得了分桶） */
  async function renderFile(
    target: TFile,
    markdown: string,
  ): Promise<{ container: StubElement; recorder: Recorder }> {
    const container = new StubElement("div");
    const recorder = makeHost(markdown);
    recorder.host.app.vault.getAbstractFileByPath = () => target;
    recorder.host.app.workspace.getActiveFile = () => target;
    await renderWorkflowView(recorder.host, {
      app: recorder.host.app,
      container: asHtmlElement(container),
      currentFilePath: target.path,
    });
    return { container, recorder };
  }

  /** 一份「根节点正在计时」的笔记（`renderTimer` 会建 tick，用来验证分桶） */
  function runningTimerMarkdown(): string {
    const document = validDocument13();
    startTimerEntry(document, "nd-uuid-001", new Date());
    return writeBackDocument(validMarkdown13(), document).markdown;
  }

  /* ---- Phase 36：归档看板默认隐藏「总览」/「未分类」 ---- */

  test("Phase 36：归档看板默认收起总览、隐藏未分类；面板开关仍能放出来", async () => {
    const archiveFile = fakeFile(`_workflowwatcher/archive/wf-uuid-101-${ARCHIVE_ROOT_ID}.wf.json`);
    const { container } = await renderFile(archiveFile, validMarkdown13());

    const overview = container.query(".wf-overview")[0];
    assert.ok(overview !== undefined, "总览元素仍要在（只是默认收起）");
    assert.equal(overview.hasClass("is-open"), false, "归档看板默认收起总览");

    const unclassified = container.query(".wf-board-frame--unclassified")[0];
    assert.ok(unclassified !== undefined, "未分类框仍要在（只是默认隐藏）");
    assert.equal(unclassified.hasClass("is-hidden"), true, "归档看板默认隐藏未分类");

    // 面板开关按「实际可见性」显示状态，点一下能放出来
    const overviewToggle = panelButton(container, t("view.nav.overview"));
    assert.match(overviewToggle.text, /关$/, "归档看板上总览开关应显示「关」");
    assert.equal(overviewToggle.getAttribute("aria-pressed"), "false");
    overviewToggle.onclick?.(mouseEvent());
    assert.equal(overview.hasClass("is-open"), true, "点开关后总览展开");
    assert.match(overviewToggle.text, /开$/, "再点后按钮变「开」");

    const unclassifiedToggle = panelButton(container, t("view.unclassified.title"));
    assert.match(unclassifiedToggle.text, /关$/, "归档看板上未分类开关应显示「关」");
    assert.equal(unclassifiedToggle.getAttribute("aria-pressed"), "false");
    unclassifiedToggle.onclick?.(mouseEvent());
    assert.equal(unclassified.hasClass("is-hidden"), false, "点开关后未分类框放出来");
    assert.match(unclassifiedToggle.text, /开$/, "再点后按钮变「开」");
  });

  test("Phase 36：普通看板不受影响（总览默认展开、未分类默认显示）", async () => {
    const { container } = await renderFile(fakeFile("普通笔记.md"), validMarkdown13());

    assert.equal(container.query(".wf-overview")[0].hasClass("is-open"), true);
    assert.equal(container.query(".wf-board-frame--unclassified")[0].hasClass("is-hidden"), false);
  });

  test("strictFile：绑定路径解析不到时**不**回退活动文件（一次分析都不做）", async () => {
    const recorder = makeHost(validMarkdown13());
    // 绑定路径真的不存在（`makeHost` 的 vault 默认对任何路径都返回 test.md，这里换成按路径查）
    recorder.host.app.vault.getAbstractFileByPath = () => null;
    const container = new StubElement("div");
    await renderWorkflowView(
      recorder.host,
      { app: recorder.host.app, container: asHtmlElement(container), currentFilePath: "missing.md" },
      { strictFile: true },
    );

    assert.equal(recorder.analyzeCalls.count, 0, "不该去分析活动文件");
    assert.equal(container.query(".wf-lane").length, 0, "不渲染任何泳道");
    const hint = container.query(".wf-hint");
    assert.equal(hint.length, 1, "只留一行提示");
    assert.match(hint[0].text, /绑定的笔记已被删除或移走/);
  });

  test("strictFile 默认关：render(dv) 仍回退活动文件（老笔记行为不变）", async () => {
    const recorder = makeHost(validMarkdown13());
    // `currentFilePath` 解析不到，但活动文件在 → 老路径应当回退到活动文件并照旧渲染
    recorder.host.app.vault.getAbstractFileByPath = () => null;
    const container = new StubElement("div");
    await renderWorkflowView(recorder.host, {
      app: recorder.host.app,
      container: asHtmlElement(container),
      currentFilePath: "missing.md",
    });

    assert.equal(recorder.analyzeCalls.count, 1);
    assert.ok(container.query(".wf-lane").length > 0, "回退到活动文件后照旧渲染");
  });

  test("计时 tick 按文件分桶：停 A 不影响 B，不传 path 才全清", async () => {
    const fileA = fakeFile("timer-a.md");
    const fileB = fakeFile("timer-b.md");
    const original = { set: window.setInterval.bind(window), clear: window.clearInterval.bind(window) };
    const patched = window as unknown as {
      setInterval: (handler: () => void, timeout?: number) => number;
      clearInterval: (id: number) => void;
    };
    const ids: number[] = [];
    const cleared: number[] = [];
    try {
      patched.setInterval = (): number => {
        const id = ids.length + 1;
        ids.push(id);
        return id;
      };
      patched.clearInterval = (id: number): void => {
        cleared.push(id);
      };

      const a = await renderFile(fileA, runningTimerMarkdown());
      const b = await renderFile(fileB, runningTimerMarkdown());
      assert.equal(a.container.query(".wf-timer").length, 1, "A 有计时器");
      assert.equal(b.container.query(".wf-timer").length, 1, "B 有计时器");
      assert.equal(ids.length, 2, "两个看板各建一个 tick");

      stopTimerTicker(fileA.path);
      assert.deepEqual(cleared, [ids[0]], "只停 A");

      stopTimerTicker();
      assert.deepEqual(cleared, [ids[0], ids[1]], "不传 path = 全清");
    } finally {
      patched.setInterval = original.set;
      patched.clearInterval = original.clear;
      forgetViewScroll(fileA.path);
      forgetViewScroll(fileB.path);
    }
  });

  test("小工具弹窗按文件分桶：B 打开不关 A 的；closeWidgetPopup(A) 只关 A", async () => {
    const fileA = fakeFile("popup-a.md");
    const fileB = fakeFile("popup-b.md");
    const a = await renderFile(fileA, validMarkdown13());
    const b = await renderFile(fileB, validMarkdown13());
    try {
      widgetButton(a.container, "📦").onclick?.(mouseEvent());
      widgetButton(b.container, "📦").onclick?.(mouseEvent());
      assert.equal(body.query(".wf-widget-overlay").length, 2, "两个看板各有一个弹窗");

      closeWidgetPopup(fileA.path);
      assert.equal(body.query(".wf-widget-overlay").length, 1, "只关掉 A 的弹窗");

      closeWidgetPopup();
      assert.equal(body.query(".wf-widget-overlay").length, 0, "不传 path = 全清");
    } finally {
      closeWidgetPopup();
      forgetViewScroll(fileA.path);
      forgetViewScroll(fileB.path);
    }
  });

  test("boardTitleOf：取笔记名、大小写不敏感去掉 .md、空路径回落看板标题", () => {
    assert.equal(boardTitleOf("a/b/c.md"), "c");
    assert.equal(boardTitleOf("文件夹/笔记.MD"), "笔记");
    assert.equal(boardTitleOf(""), "工作流看板");
  });
});

/* ------------------------------------------------------------------ *
 * Phase 25：ItemView 看板结构（进行中当主视图 / 折叠总览 / 上拉抽屉 / 左侧导航）
 * 契约：doc/datacontact/phase25_bound.md §11（断言 1~8；断言 9 在 Phase 16 的宽度用例里，
 * 断言 10 需要右侧面板 → 随 M4 一起补）
 * ------------------------------------------------------------------ */

describe("wfView · Phase 25 看板结构（工具行 / 折叠总览 / 上拉抽屉 / 导航条）", () => {
  /**
   * 夹具：3 条进行中 + 1 条已完成 + 1 条已取消。
   * 导航条（条目数 = 分组数）与抽屉互斥都要「多条分组」才测得出。
   */
  function phase25Markdown(): string {
    const document = validDocument11();
    for (const index of [1, 2]) {
      const root = leaf(`nd-uuid-8${index}`, `进行中 ${index + 1}`);
      delete root.noteAnchor; // 正文里没有它的纪要段 → 不挂锚点，免得「锚点缺失」挡渲染
      document.workflows.push({ id: `wf-uuid-8${index}`, title: `进行中流 ${index + 1}`, root });
    }
    const cancelled = leaf("nd-uuid-830", "🚫 取消掉的那条", {
      status: "done",
      progress: 1,
      progress_max: 1,
      completedAt: "2026-10-09T18:00:00+08:00",
    });
    delete cancelled.noteAnchor;
    document.workflows.push({ id: "wf-uuid-830", title: "已取消流", state: "cancelled", root: cancelled });
    return writeBackDocument(validMarkdown11(), document).markdown;
  }

  /** 抽屉（按 state 取） */
  const drawerOf = (container: StubElement, state: string): StubElement | undefined =>
    container.query(`.wf-drawer-${state}`)[0];

  /** 点某条抽屉横条 */
  function clickHandle(container: StubElement, state: string): void {
    const handle = drawerOf(container, state)?.query(".wf-drawer-handle")[0];
    assert.ok(handle, `${state} 抽屉应有横条`);
    handle.onclick?.(mouseEvent());
  }

  test("① 入口在导航面板：`.wf-board-top` 已撤掉，主题与总览开关都进了面板三列", async () => {
    const { container } = await render(phase25Markdown());

    assert.equal(container.query(".wf-board-top").length, 0, "Phase 29：顶部工具行已撤掉");

    const panel = container.query(".wf-panel-overview")[0];
    assert.ok(panel !== undefined, "导航面板一直挂在导航条里（永远可见的入口）");
    assert.equal(panel.query(".wf-panel-column").length, 3, "统计 / 修改 / 主题 三列");
    assert.deepEqual(texts(panel.query(".wf-panel-title")), [
      t("view.nav.stats"),
      t("view.nav.modify"),
      t("view.theme.label"),
    ], "列顺序固定");

    // 主题切换搬进主题列（仍用 `.wf-theme-btn`），总览开关在修改列
    assert.equal(panel.query(".wf-theme-switch").length, 1, "主题列里要有主题切换");
    assert.ok(panelButton(container, t("view.nav.overview")).text.length > 0, "修改列里要有总览开关");

    const overview = container.query(".wf-overview")[0];
    assert.ok(overview !== undefined, "总览块仍要存在（开关只控制它显隐）");
    assert.equal(overview.query(".wf-theme-switch").length, 0, "主题切换不在总览里");
  });

  test("② 总览默认展开：点面板「总览」开关才收起，再点回来", async () => {
    const { container } = await render(phase25Markdown());

    const overview = container.query(".wf-overview")[0];
    const toggle = panelButton(container, t("view.nav.overview"));
    assert.ok(overview !== undefined && toggle !== undefined);

    // Phase 29：默认展开（与 Phase 28 的常开一致），开关只负责「藏起来」
    assert.equal(overview.hasClass("is-open"), true, "首帧总览应是展开的");
    assert.equal(toggle.getAttribute("aria-pressed"), "true");
    assert.ok(toggle.classList.contains("wf-panel-btn--on"), "开态加主题色类");
    // 没有进行中的计时 → 计时那一行是引导性大标题
    assert.equal(overview.query(".wf-app-title").length, 1, "展开后有计时 / 大标题那一行");

    toggle.onclick?.(mouseEvent());
    assert.equal(overview.hasClass("is-open"), false, "点一下要收起");
    assert.equal(toggle.getAttribute("aria-pressed"), "false");
    assert.equal(toggle.classList.contains("wf-panel-btn--on"), false);

    toggle.onclick?.(mouseEvent());
    assert.equal(overview.hasClass("is-open"), true, "再点一下放回来");
    assert.equal(toggle.getAttribute("aria-pressed"), "true");
  });

  test("③ 总览里只剩计时 / 大标题；7 个小工具全在面板「统计」列", async () => {
    const { container } = await render(phase25Markdown());

    const overview = container.query(".wf-overview")[0];
    assert.equal(overview.query(".wf-sidebar").length, 0, "Phase 29：`.wf-sidebar` 已拆掉");
    assert.equal(overview.query(".wf-sidebar-btn").length, 0);
    assert.equal(overview.query(".wf-app-title").length, 1, "计时 / 大标题那一行还在");
    assert.equal(overview.query(".wf-timer").length, 0, "夹具里没有进行中的计时");

    const statsCol = container.query(".wf-panel-column")[0];
    const labels = texts(statsCol.query(".wf-panel-btn"));
    assert.equal(labels.length, 7, "统计列 = 7 个文字按钮（设置不算）");
    assert.deepEqual(labels.slice(0, 2), [t("view.widget.gantt21"), t("view.widget.quadrant")]);
    assert.match(labels[2], /^已归档（\d+）$/, "「已归档」文案带计数");
    assert.deepEqual(labels.slice(3), [
      t("view.widget.data"),
      t("view.widget.records"),
      t("view.widget.plot365"),
      t("view.widget.schemaWarn"),
    ]);
    assert.equal(labels.includes(t("view.widget.settings")), false, "「插件设置」属于修改列");
  });

  test("④ DOM 顺序固定：overview → main → 页脚（Phase 29：`.wf-board-top` 已撤掉）", async () => {
    const { container } = await render(phase25Markdown());

    const order = container.children.map((child) => child.hasClass("wf-overview") ? "overview"
      : child.hasClass("wf-board-top") ? "board-top"
        : child.hasClass("wf-main") ? "main"
          : child.hasClass("wf-drawer-archived") ? "drawer-archived"
            : child.hasClass("wf-drawer-cancelled") ? "drawer-cancelled"
              : child.hasClass("wf-footer-hidden") ? "footer" : "other");

    // Phase 29：工具行（`.wf-board-top`）已撤掉 —— 入口全在导航面板里，抽屉则搬进了「进行中」块内部
    // （`.wf-block-body > .wf-pane-{archived,cancelled}`），所以视图直接子元素只剩总览 / 主体 / 页脚。
    assert.deepEqual(
      order.filter((name) => name !== "footer"),
      ["overview", "main"],
      "视图直接子元素的顺序决定「总览在主体上方」；再冒出来的 board-top / 抽屉都是回归",
    );
  });

  test("⑤ 抽屉互斥：开已完成后开已取消 → 前者关、后者开；再点自己 → 全关", async () => {
    const { container } = await render(phase25Markdown());
    const archived = drawerOf(container, "archived");
    const cancelled = drawerOf(container, "cancelled");
    assert.ok(archived !== undefined && cancelled !== undefined, "两个分组的抽屉都要在");

    // 首帧：两个都收起
    assert.equal(archived.hasClass("is-open"), false);
    assert.equal(cancelled.hasClass("is-open"), false);

    clickHandle(container, "archived");
    assert.equal(archived.hasClass("is-open"), true, "点已完成的横条 → 它开");
    assert.equal(archived.hasClass("is-closed"), false);
    assert.equal(cancelled.hasClass("is-open"), false, "另一个必须是关的（互斥）");

    clickHandle(container, "cancelled");
    assert.equal(archived.hasClass("is-open"), false, "开已取消 → 已完成自动关");
    assert.equal(archived.hasClass("is-closed"), true);
    assert.equal(cancelled.hasClass("is-open"), true);

    clickHandle(container, "cancelled");
    assert.equal(cancelled.hasClass("is-open"), false, "再点自己 → 收起");
    assert.equal(cancelled.hasClass("is-closed"), true);
    assert.equal(archived.hasClass("is-open"), false);
  });

  test("⑥ 导航条上下文：默认列进行中 3 条；打开已完成抽屉 → 换成那个分组", async () => {
    const { container } = await render(phase25Markdown());

    const rail = container.query(".wf-nav-rail")[0];
    assert.ok(rail !== undefined, "主体左侧应有导航条");
    assert.equal(rail.query(".wf-nav-item").length, 3, "3 条进行中 workflow = 3 条横杠");
    // 桩的 `query` 只认单个类名 → 高亮态用 hasClass 过滤
    assert.equal(rail.query(".wf-nav-item").filter((item) => item.hasClass("is-active")).length, 1, "当前可见栏高亮，且只有一个");

    clickHandle(container, "archived");
    assert.equal(rail.query(".wf-nav-item").length, 1, "抽屉里的上下文换成已完成流（1 条）");

    clickHandle(container, "archived");
    assert.equal(rail.query(".wf-nav-item").length, 3, "关掉抽屉 → 回到进行中");
  });

  test("⑦ 点导航横杠 → 分栏 `scrollTo` 收到目标 left（末尾窄栏滚到最右）", async () => {
    const { container } = await render(phase25Markdown());

    const columns = container.query(".wf-active-columns")[0];
    assert.ok(columns !== undefined, "进行中应有横向分栏");
    // Phase 33：真正的横滚容器是 `.wf-active-scroll`（未分类框已挪到框② 外面，与它平级）
    const scroller = columns.querySelector(".wf-active-scroll");
    assert.ok(scroller !== null, "分栏里要有横滚容器");
    // 桩里没有布局：手工给「3 栏 + 可视宽 300 / 内容宽 900」—— 最大可滚 600
    scroller.scrollWidth = 900;
    scroller.clientWidth = 300;
    const columnEls = scroller.query(".wf-column");
    assert.equal(columnEls.length, 3, "只数横滚区里的 3 栏");
    assert.equal(columns.query(".wf-column").length, 3, "分栏区里只剩横滚区（未分类列已挪到框② 外面）");
    columnEls[0].offsetLeft = 0;
    columnEls[0].offsetWidth = 300;
    columnEls[1].offsetLeft = 400;
    columnEls[1].offsetWidth = 300;
    columnEls[2].offsetLeft = 900; // 最后一条窄栏：靠左会超出可滚范围
    columnEls[2].offsetWidth = 120;

    const items = container.query(".wf-nav-item");
    items[1].onclick?.(mouseEvent());
    assert.deepEqual(scroller.scrollCalls.at(-1), { left: 400, behavior: "smooth" }, "第 2 栏靠左对齐");

    items[2].onclick?.(mouseEvent());
    assert.deepEqual(scroller.scrollCalls.at(-1), { left: 600, behavior: "smooth" }, "末尾窄栏滚到最右");
  });

  test("⑧ 抽屉横条文案 = 分组名 + 计数（已完成流 / 已取消流）", async () => {
    const { container } = await render(phase25Markdown());

    const archivedText = drawerOf(container, "archived")?.query(".wf-drawer-handle")[0]?.text ?? "";
    assert.match(archivedText, /已完成流/, "已完成流横条要有分组名");
    assert.match(archivedText, /（1）/, "已完成流横条要有计数");

    const cancelledText = drawerOf(container, "cancelled")?.query(".wf-drawer-handle")[0]?.text ?? "";
    assert.match(cancelledText, /已取消流/);
    assert.match(cancelledText, /（1）/);

    // 分组为空 → 该抽屉整块不渲染（没有空横条）
    const only = validDocument11(); // 只有 1 条已完成、没有已取消
    const { container: bare } = await render(writeBackDocument(validMarkdown11(), only).markdown);
    assert.equal(bare.query(".wf-drawer-cancelled").length, 0, "已取消分组为空 → 不渲染该抽屉");
  });

  /* ---- 断言 10（M4）：节点操作统一走右侧面板 ---- */

  /** 右键开菜单 → 返回菜单项（openMenu 会先关掉旧菜单，所以每次都现开） */
  const menuOf = (card: StubElement): StubElement[] => {
    card.oncontextmenu?.(mouseEvent());
    const menu = body.query(".wf-menu")[0];
    assert.ok(menu, "右键应弹出菜单");
    return menu.query(".wf-menu-item");
  };

  /** 按标题找卡片（根节点不挂 `data-node-id`，只能按文字找） */
  const cardNamed = (container: StubElement, title: string): StubElement => {
    const card = container.query(".wf-card").find((element) => element.textContent.includes(title));
    assert.ok(card !== undefined, `应渲染出标题为「${title}」的节点卡`);
    return card;
  };

  /** 点菜单里的某一项（找不到就带着实际项报错） */
  const pickMenu = (items: StubElement[], label: string): void => {
    const item = items.find((entry) => entry.text === label);
    assert.ok(item, `菜单里应有「${label}」，实际：${items.map((entry) => entry.text).join(" / ")}`);
    item.onclick?.(mouseEvent());
  };

  test("⑩ 右键「✏️ 编辑节点信息…」→ 宿主 openNodePanel(file, node, \"info\")", async () => {
    const { container, recorder } = await render(validMarkdown11());
    const card = cardNamed(container, "调研竞品");

    pickMenu(menuOf(card), "✏️ 编辑节点信息…");
    await flush();
    assert.deepEqual(recorder.infoCalls, [{ nodeId: ROOT_ID }], "面板 tab 1：结果按 info 记录，且带节点 id");
    assert.deepEqual(recorder.noteCalls, [], "编辑节点信息不该碰 note tab");
    assert.deepEqual(recorder.notices, [], "取消面板：不提示");
  });

  test("⑩ 节点菜单的 tab 入口只剩 info / archive（其余 tab 由面板内切换）", async () => {
    const { container, recorder } = await render(validMarkdown11());
    const calls: { tab: string; nodeId: string | null; workflowId: string | null }[] = [];
    recorder.host.openNodePanel = panelStub(async (_file, node, tab, workflow) => {
      calls.push({ tab, nodeId: node?.id ?? null, workflowId: workflow?.id ?? null });
      return { cancelled: true };
    });

    const root = cardNamed(container, "调研竞品");
    pickMenu(menuOf(root), "✏️ 编辑节点信息…");
    await flush();
    // 根节点的归档入口是「整条工作流」（Phase 22）：tab 4 同一个，target 换成 workflow
    pickMenu(menuOf(root), "📦 归档整个工作流…");
    await flush();

    assert.deepEqual(calls.map((call) => call.tab), ["info", "archive"]);
    assert.deepEqual(
      calls.map((call) => call.nodeId),
      [ROOT_ID, ROOT_ID],
      "tab 都带上了被右键的那个节点",
    );
    assert.equal(calls[1].workflowId, WF1_ID, "整条流归档：target 由第 4 个参数决定（面板不合并语义）");
  });

  test("⑩ 面板「修改工作流…」→ 面板 tab 3（节点可空）；块尾按钮已撤掉", async () => {
    const { container, recorder } = await render(validMarkdown11());
    const calls: { tab: string; nodeId: string | null }[] = [];
    recorder.host.openNodePanel = panelStub(async (_file, node, tab) => {
      calls.push({ tab, nodeId: node?.id ?? null });
      return { cancelled: true };
    });

    assert.equal(container.query(".wf-block-btn").length, 0, "Phase 29：块尾两按钮已删");
    const button = panelButton(container, t("view.block.editWorkflows"));
    assert.ok(button, "导航面板「修改」列应有「修改工作流…」按钮");
    button.onclick?.(mouseEvent());
    await flush();

    assert.deepEqual(calls, [{ tab: "workflow", nodeId: null }], "tab 3 不需要具体节点");
  });

  /* ---- 断言 11（M5b）：8 / 6 / 8 套主题差值 ---- */

  test("⑪ styles.css：开关 8 套 + 进行中块 6 套 + 导航条 8 套（fresh / shoujo 不加块背景）", () => {
    const raw = readFileSync(new URL("../styles.css", import.meta.url), "utf8");
    // 只查活规则：注释里也会提到这些类名（说明文字），不能算数
    const css = raw.replace(/\/\*[\s\S]*?\*\//g, "");
    const themes = ["tech", "nature", "magazine", "retro", "polka", "web", "fresh", "shoujo"];
    // §8.2 口径：这两套保持现状，不新增背景质感
    const quiet = ["fresh", "shoujo"];
    // §8.2 进行中块背景：6 套，机制不同（挂主题根的纹理 / 挂 `.wf-block` 的留白或内阴影），逐个点名
    const blockBg: Record<string, string> = {
      tech: "var(--wf-status-doing) 5%",
      nature: "radial-gradient(rgb(122 106 74 / 0.1) 0.5px, transparent 0.5px)",
      magazine: "--wf-block-margin: 18px 0 10px",
      retro: "rgb(93 66 40 / 0.08)",
      polka: "radial-gradient(circle, rgb(138 98 93",
      web: "#d4a017 10%",
    };


    themes.forEach((theme) => {
      // `(?![-\w])` 防止 `.wf-block` 的检查被 `.wf-block-title` 这类旧规则蒙混过关
      const scoped = (cls: string): string => `\\.wf-theme\\[data-wf-theme="${theme}"\\] \\${cls}(?![-\\w])`;
      // §8.1 下拉开关：差值挂在开关本体上（中间可以有 `.wf-nav-toggle-wrapper` 包裹）
      assert.ok(
        css.includes(`.wf-theme[data-wf-theme="${theme}"] .wf-nav-toggle-wrapper .wf-collapse-toggle`) ||
          css.includes(`.wf-theme[data-wf-theme="${theme}"] .wf-collapse-toggle`),
        `${theme} 缺少下拉开关的主题差值（§8.1）`,
      );
      assert.match(css, new RegExp(scoped(".wf-nav-item")), `${theme} 缺少导航横杠的主题差值（§8.3）`);
      if (quiet.includes(theme)) {
        assert.doesNotMatch(css, new RegExp(scoped(".wf-block")), `${theme} 的进行中块要维持现状（不新增背景）`);
      } else {
        assert.ok(css.includes(blockBg[theme]), `${theme} 缺少进行中块背景（§8.2）`);
      }
    });

    // Phase 44：default 主题（连同它的 4% 点阵微肌理）已删除 —— 素净基线不挂块背景
    assert.doesNotMatch(css, /data-wf-theme="default"/, "default 主题的桶必须清干净");
    // 8 套主题的纹理仍要「极淡透明度」，不许出现整块实色底（会盖住页面的主题渐变）
    assert.ok(css.includes("color-mix("), "主题纹理要用极淡的 color-mix 拼透明度");
  });
});

/* ------------------------------------------------------------------ *
 * Phase 28：「导入 / 导出数据」小工具（Phase 26 的折叠面板搬进弹窗）
 * 契约：doc/datacontact/phase28_bound.md §3 / §8
 * ------------------------------------------------------------------ */

describe("wfView · Phase 28 导入 / 导出数据小工具", () => {
  /** 看板模式渲染（`strictFile: true` = ItemView 那条路径） */
  async function renderBoard(markdown: string): Promise<{ container: StubElement; recorder: Recorder }> {
    const container = new StubElement("div");
    const recorder = makeHost(markdown);
    await renderWorkflowView(
      recorder.host,
      { app: recorder.host.app, container: asHtmlElement(container), currentFilePath: file.path },
      { strictFile: true },
    );
    return { container, recorder };
  }

  /** 弹窗里的两块（顺序：导入 → 导出） */
  const sections = (body: StubElement): StubElement[] => body.query(".wf-data-section");

  /** 两块的标题 */
  const sectionTitles = (body: StubElement): string[] =>
    sections(body).map((section) => section.query(".wf-data-section-title")[0]?.text ?? "");

  /** 导入清单（可编辑；两个导入按钮共用的就是它） */
  const importPaths = (body: StubElement): StubElement | undefined => body.query(".wf-data-import-paths")[0];

  /** 导出清单（只读） */
  const exportBox = (body: StubElement): StubElement | undefined => body.query(".wf-data-export-paths")[0];

  /** 全部按钮：选择/导入主看板/导入已归档 → 复制看板/复制全部 */
  const buttons = (body: StubElement): StubElement[] => body.query(".wf-data-btn");

  /** 在输入框里「打字」（桩没有真实输入，赋值 + 手动触发 oninput） */
  function type(input: StubElement | undefined, value: string): void {
    assert.ok(input !== undefined, "输入框应存在");
    input.value = value;
    input.oninput?.();
  }

  const BUTTON = {
    pick: 0,
    importBoard: 1,
    importArchive: 2,
    copyBoard: 3,
    copyAll: 4,
  } as const;

  /** 取 styles.css 某条规则块的声明部分（去掉注释后按选择器定位） */
  function cssRule(selector: string): string {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const start = css.indexOf(selector);
    assert.notEqual(start, -1, `styles.css 缺少 ${selector}`);
    const open = css.indexOf("{", start);
    const close = css.indexOf("}", open);
    return css.slice(open + 1, close);
  }

  test("① 弹窗两块：导入（一个清单 + 选择/导入主看板/导入已归档）/ 导出（只读清单 + 两个复制）", async () => {
    const { container } = await renderBoard(validMarkdown11());
    // Phase 29：小工具是面板里的**文字按钮**（图标侧边栏已拆掉），文案即入口
    const button = widgetButton(container, "📥");
    assert.equal(button.text, t("view.widget.data"));

    const popup = openWidget(container, "📥");
    assert.deepEqual(sectionTitles(popup), [t("view.data.sectionImport"), t("view.data.sectionExport")]);
    assert.equal(popup.query(".wf-data-list").length, 2, "两块各一个文件列表");
    assert.equal(popup.query(".wf-data-import-paths").length, 1, "导入只有**一个**清单");
    assert.equal(importPaths(popup)?.readOnly, false, "导入清单可编辑");
    assert.ok(exportBox(popup) !== undefined, "导出小节要有清单");
    assert.equal(exportBox(popup)?.readOnly, true, "导出清单只读：能选能复制，不能改");
    assert.deepEqual(buttons(popup).map((item) => item.text), [
      t("view.data.pick"),
      t("view.data.importBoard"),
      t("view.data.importArchive"),
      t("view.data.copyBoard"),
      t("view.data.copyAll"),
    ]);
    closeWidget();
  });

  test("② 导入清单：多行路径 trim 后按 mode=board 交给 host.importJsonPaths", async () => {
    const { container, recorder } = await renderBoard(validMarkdown11());
    const popup = openWidget(container, "📥");
    type(importPaths(popup), "  D:/out/a.wf.json  \n\n D:/out/b.wf.json ");

    buttons(popup)[BUTTON.importBoard].onclick?.(mouseEvent());
    await flush();

    assert.deepEqual(recorder.importPathCalls, [
      { paths: ["D:/out/a.wf.json", "D:/out/b.wf.json"], mode: "board" },
    ]);
    closeWidget();
  });

  test("③ 同一份清单换落点：点「导入已归档」就是 mode=archive（不动看板）", async () => {
    const { container, recorder } = await renderBoard(validMarkdown11());
    const popup = openWidget(container, "📥");
    type(importPaths(popup), "D:/out/old.wf.json");

    buttons(popup)[BUTTON.importArchive].onclick?.(mouseEvent());
    await flush();

    assert.deepEqual(recorder.importPathCalls, [{ paths: ["D:/out/old.wf.json"], mode: "archive" }]);
    closeWidget();
  });

  test("④ 清单为空 → 两个导入按钮都禁用；填上后一起解禁（共用一个清单）", async () => {
    const { container } = await renderBoard(validMarkdown11());
    const popup = openWidget(container, "📥");
    const importBoard = buttons(popup)[BUTTON.importBoard];
    const importArchive = buttons(popup)[BUTTON.importArchive];
    assert.equal(importBoard.disabled, true, "没有路径就不该能点");
    assert.equal(importArchive.disabled, true, "没有路径就不该能点");

    type(importPaths(popup), "D:/out/a.wf.json");
    assert.equal(importBoard.disabled, false);
    assert.equal(importArchive.disabled, false, "两个落点看的是同一份清单");
    closeWidget();
  });

  test("⑤ 导出清单来自 host.boardJsonPaths；两个复制按钮分别复制首条 / 全部", async () => {
    const { container, recorder } = await renderBoard(validMarkdown11());
    recorder.archiveFixture.files.push("_workflowwatcher/archive/wf-a-nd-b.wf.json");
    const popup = openWidget(container, "📥");

    const expected = [
      "/vault/_workflowwatcher/main~0a1b2c3d4e.wf.json",
      "/vault/_workflowwatcher/archive/wf-a-nd-b.wf.json",
    ];
    assert.equal(exportBox(popup)?.value, expected.join("\n"));

    buttons(popup)[BUTTON.copyBoard].onclick?.(mouseEvent());
    buttons(popup)[BUTTON.copyAll].onclick?.(mouseEvent());
    assert.deepEqual(recorder.copyCalls, [expected[0], expected.join("\n")]);
    closeWidget();
  });

  test("⑥ 「选择…」把宿主返回的路径追加进导入清单（去重、不覆盖手填的那几行）", async () => {
    const { container, recorder } = await renderBoard(validMarkdown11());
    recorder.pickResult.paths = ["D:/out/a.wf.json", "D:/out/b.wf.json"];
    const popup = openWidget(container, "📥");
    type(importPaths(popup), "D:/out/a.wf.json");

    buttons(popup)[BUTTON.pick].onclick?.(mouseEvent());
    await flush();

    assert.deepEqual(recorder.pickCalls, [1]);
    assert.equal(importPaths(popup)?.value, "D:/out/a.wf.json\nD:/out/b.wf.json");
    closeWidget();
  });

  test("⑦ 导入清单的值跨整块重渲染保留（按 file.path 记忆）", async () => {
    const { container } = await renderBoard(validMarkdown11());
    const popup = openWidget(container, "📥");
    type(importPaths(popup), "D:/out/a.wf.json");
    closeWidget();

    const again = await renderBoard(validMarkdown11());
    const reopened = openWidget(again.container, "📥");
    assert.equal(importPaths(reopened)?.value, "D:/out/a.wf.json");
    closeWidget();
  });

  test("⑧ 两个文件列表：占满宽度、高度固定且相等、不换行、可横向滚动、拖不动", async () => {
    const block = cssRule(".wf-data-list");
    assert.match(block, /width:\s*100%/, "宽度占满弹窗");
    assert.match(block, /height:\s*\d+px/, "高度固定 → 两个列表自然等高");
    assert.doesNotMatch(block, /height:\s*(auto|100%)/, "高度不许跟内容伸缩");
    assert.match(block, /resize:\s*none/, "宽度 / 高度都不可拖");
    assert.match(block, /white-space:\s*pre/, "每行不换行");
    assert.match(block, /overflow-x:\s*auto/, "超长路径在列表内横向滚动");
  });
});
/* ------------------------------------------------------------------ *
 * Phase 28：「开始 / 完成记录」小工具（双列倒序时间线）
 * 契约：doc/datacontact/phase28_bound.md §5 / §8
 * ------------------------------------------------------------------ */

describe("wfView · Phase 28 开始 / 完成记录小工具", () => {
  /** 用指定 wfjson 文档渲染一次看板 */
  async function renderWith(document: WfJsonDocument): Promise<{ container: StubElement }> {
    const container = new StubElement("div");
    const recorder = makeHost(wfjsonBlockOnly(document));
    await renderWorkflowView(
      recorder.host,
      { app: recorder.host.app, container: asHtmlElement(container), currentFilePath: file.path },
      { strictFile: true },
    );
    return { container };
  }

  function recordsDoc(): WfJsonDocument {
    return {
      schemaVersion: "1.9",
      id: "file-rec",
      updatedAt: "2026-10-12T18:00:00+08:00",
      workflows: [
        {
          id: "wf-1",
          title: "记录",
          root: leaf("nd-root", "根", {
            children: [
              leaf("nd-done", "已完成任务", {
                status: "done",
                startAt: "2026-10-12T08:00:00+08:00",
                completedAt: "2026-10-12T10:30:00+08:00",
              }),
              leaf("nd-doing", "进行中任务", {
                status: "doing",
                startAt: "2026-10-12T09:00:00+08:00",
              }),
            ],
          }),
        },
      ],
    };
  }

  test("两列标题各一个；完成 1 + 开始 2；时间文案精确到小时", async () => {
    const { container } = await renderWith(recordsDoc());
    const popup = openWidget(container, "🗒");
    assert.ok(currentPopup()?.classList.contains("wf-widget-popup--tabs"), "统一固定尺寸弹窗");
    assert.equal(activeWidgetTab()?.text, t("view.widget.records"), "默认停在点开的那一页");
    assert.equal(popup.query(".wf-records-col").length, 2, "左完成 / 右开始");
    assert.equal(popup.query(".wf-records-col-title").length, 2);
    assert.equal(popup.query(".wf-records-item").length, 3, "完成 1 + 开始 2");

    const meta = popup
      .query(".wf-records-meta")
      .map((item) => item.allText)
      .join(" | ");
    assert.match(meta, /\d{4}-\d{2}-\d{2} \d{2}:00/, "时间文案精确到小时（分钟恒 00）");
    closeWidget();
  });

  test("没有可记录节点 → 占位文案", async () => {
    const document: WfJsonDocument = {
      schemaVersion: "1.9",
      id: "file-empty",
      updatedAt: "2026-10-12T18:00:00+08:00",
      workflows: [{ id: "wf-1", title: "空", root: leaf("nd-only", "只有 todo") }],
    };
    const { container } = await renderWith(document);
    const popup = openWidget(container, "🗒");
    assert.equal(popup.query(".wf-widget-placeholder").length, 1);
    closeWidget();
  });
});





/* ------------------------------------------------------------------ *
 * Phase 26：看板全高 + 面板外观（styles.css 静态断言，契约 §9③）
 * 仓库里没有浏览器 / jsdom，布局本身进不了单测 —— 这里只守三条不变式。
 * ------------------------------------------------------------------ */

describe("wfView · Phase 26 看板全高（styles.css 静态断言）", () => {
  const cssOf = (): string =>
    readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  const BOARD = '.workspace-leaf-content[data-type="workflow-watcher-board"]';

  /** 取某条规则块的声明部分（从选择器往后找第一对 `{}`；允许它在逗号分组里） */
  function blockOf(css: string, selector: string): string {
    const start = css.indexOf(selector);
    assert.notEqual(start, -1, `styles.css 缺少 ${selector}`);
    const open = css.indexOf("{", start);
    const between = css.slice(start + selector.length, open);
    assert.doesNotMatch(between, /}/, `${selector} 不是一条规则块的开头`);
    const close = css.indexOf("}", open);
    return css.slice(open + 1, close);
  }

  test("⑨ 全高链的每一条都限定在看板 leaf 里（笔记嵌入不受影响）", () => {
    const css = cssOf();
    const chained = [".wf-view", ".wf-main", ".wf-main-body", ".wf-block", ".wf-lane", ".wf-active-columns", ".wf-column", ".wf-lane-body"];
    for (const selector of chained) {
      const body = blockOf(css, `${BOARD} ${selector}`);
      assert.match(body, /(display:\s*flex|flex:\s*1 1 auto)/, `${selector} 的看板规则要参与 flex 链`);
    }
    // 基线（不带前缀）那条不许沾上只属于 flex 链的声明
    assert.doesNotMatch(blockOf(css, "\n.wf-main"), /min-height:\s*0/, "基线 .wf-main 不能被全高改动波及");
    assert.match(blockOf(css, `${BOARD} .view-content`), /overflow:\s*hidden/, "纵向滚动只留泳道正文一条");
  });

  test("⑩ 看板里泳道正文不再吃 --wf-lane-max-height，笔记里照旧", () => {
    const css = cssOf();
    assert.match(blockOf(css, `${BOARD} .wf-lane-body`), /max-height:\s*none/, "看板里由 flex 决定高度");
    assert.match(
      blockOf(css, "\n.wf-lane-body"),
      /max-height:\s*var\(--wf-lane-max-height,\s*800px\)/,
      "笔记嵌入 / dataviewjs 仍用设置面板的高度上限",
    );
  });

  test("⑪ 记录小工具：双列各自滚动 + 窄屏纵向堆叠；数据面板常显（Phase 28）", () => {
    const css = cssOf();
    // 数据面板不再靠 display:none 折叠（它现在是小工具弹窗内容，常显）
    assert.doesNotMatch(blockOf(css, ".wf-data-panel"), /display:\s*none/);

    // Phase 30：records 不再有自己的宽度变体（统一 `.wf-widget-popup--tabs`）
    assert.match(blockOf(css, ".wf-records"), /display:\s*flex/);
    const col = blockOf(css, ".wf-records-col");
    assert.match(col, /overflow-y:\s*auto/, "每列各自上下滚");
    assert.match(col, /max-height:/, "列有高度上限");
    assert.match(css, /\.wf-records-col-title \{[^}]*position:\s*sticky/, "列标题吸顶");
    assert.match(css, /@media \(max-width: 640px\)[\s\S]*?\.wf-records \{[^}]*flex-direction:\s*column/, "窄屏纵向堆叠");
  });

  test("⑫ 未分类列标题水平书写（空列也不按字竖排）", () => {
    const css = cssOf();
    const block = blockOf(css, "\n.wf-unclassified .wf-lane-title");
    assert.match(block, /white-space:\s*nowrap/, "锁死不换行，回到水平书写");
    assert.match(block, /overflow-wrap:\s*normal/, "不再允许按字断行");
    assert.match(block, /word-break:\s*normal/);
  });
});


/* ------------------------------------------------------------------ *
 * Phase 29：导航面板外观（styles.css 静态断言，契约 §6 / §8.5）
 * 仓库里没有浏览器 / jsdom，布局本身进不了单测 —— 这里只守三条不变式：
 * 面板 3 列、「统计 / 修改」两列共用一套 `.wf-panel-btn`、旧的图标工具栏样式退场。
 * ------------------------------------------------------------------ */

describe("wfView · Phase 29 导航面板（styles.css 静态断言）", () => {
  const cssOf = (): string =>
    readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  /** 取某条规则块的声明部分（从选择器往后找第一对 `{}`，允许它在逗号分组里） */
  function blockOf(css: string, selector: string): string {
    const start = css.indexOf(selector);
    assert.notEqual(start, -1, `styles.css 缺少 ${selector}`);
    const open = css.indexOf("{", start);
    const between = css.slice(start + selector.length, open);
    assert.doesNotMatch(between, /}/, `${selector} 不是一条规则块的开头`);
    const close = css.indexOf("}", open);
    return css.slice(open + 1, close);
  }

  test("① 面板仍是 3 列（统计 / 修改 / 主题），`.wf-panel-btn` 有 hover 与开态", () => {
    const css = cssOf();
    assert.match(
      blockOf(css, ".wf-panel-overview"),
      /grid-template-columns:\s*repeat\(3,\s*1fr\)/,
      "Phase 29：4 列改 3 列（研究列删除）",
    );

    const button = blockOf(css, ".wf-panel-btn");
    assert.match(button, /width:\s*100%/, "按钮撑满列宽");
    assert.match(button, /text-align:\s*left/, "文字按钮左对齐");
    assert.match(button, /cursor:\s*pointer/);
    assert.match(blockOf(css, ".wf-panel-btn:hover"), /--background-modifier-hover/);
    assert.match(blockOf(css, ".wf-panel-btn--on"), /--interactive-accent/, "开态走主题色 token");
  });

  test("② 图标小工具栏的样式已退场（`.wf-sidebar` / 首子元素那条选择器）", () => {
    const css = cssOf();
    assert.doesNotMatch(css, /\.wf-sidebar\b/, "`.wf-sidebar` / `.wf-sidebar-btn` 段应删掉");
    assert.doesNotMatch(css, /\.wf-overview\s*>\s*\.wf-sidebar/, "`.wf-overview > .wf-sidebar:first-child` 也要删");
  });
});

/* ------------------------------------------------------------------ *
 * Phase 30：统计小工具合并成 tabbed 弹窗 / 右侧面板居中 / 两列虚线分隔
 * ------------------------------------------------------------------ */

describe("wfView · Phase 30 统计小工具 tabbed 弹窗与导航两列分隔线", () => {
  const cssOf = (): string =>
    readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  /** 取一条规则块的声明部分（选择器必须独占一行开头，避免 `.wf-widget-tab` 误吃到 `.wf-widget-tabs`） */
  function blockOf(css: string, selector: string): string {
    const pattern = new RegExp(
      `(?:^|\\n)${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`,
    );
    const match = pattern.exec(css);
    assert.ok(match !== null, `styles.css 缺少 ${selector} 规则块`);
    return match[1];
  }

  test("① 统计 / 修改两列各包一层 `.wf-panel-list`（主题列不包），统计列仍是 7 个按钮", async () => {
    const { container } = await render(validMarkdown13());
    const panel = container.query(".wf-panel-overview")[0];
    assert.ok(panel !== undefined, "导航面板应存在");
    const columns = panel.query(".wf-panel-column");
    assert.equal(columns.length, 3, "仍是 3 列");
    assert.equal(panel.query(".wf-panel-list").length, 2, "统计 / 修改各一个");
    assert.equal(columns[0].query(".wf-panel-list").length, 1, "统计列有虚线容器");
    assert.equal(columns[1].query(".wf-panel-list").length, 1, "修改列有虚线容器");
    assert.equal(columns[2].query(".wf-panel-list").length, 0, "主题列不包这层");
    assert.equal(columns[0].query(".wf-panel-btn").length, 7, "统计列 = 7 个按钮（设置不算）");
    assert.equal(columns[1].query(".wf-panel-btn").length, 5, "修改列 = 5 个按钮（Phase 33 加了「未分类」开关）");
    assert.equal(columns[0].query(".wf-panel-title").length, 1, "标题仍是直接子元素");
  });

  test("② 点不同统计按钮 = 同一个弹窗换 tab（不叠层、尺寸类固定）", async () => {
    const { container } = await render(validMarkdown13());
    openWidget(container, "📊");
    const popup = currentPopup();
    assert.ok(popup !== undefined, "弹窗应存在");
    assert.ok(popup.classList.contains("wf-widget-popup--tabs"), "统一固定尺寸弹窗");
    assert.equal(activeWidgetTab()?.text, t("view.widget.gantt21"), "默认停在点开的那一页");
    assert.equal(body.query(".wf-widget-tab").length, 7, "顶部 7 个 tab（= 统计列 7 个按钮）");

    widgetButton(container, "🎯").onclick?.(mouseEvent());

    assert.equal(body.query(".wf-widget-overlay").length, 1, "始终只有一个弹窗（不叠层）");
    assert.equal(currentPopup(), popup, "还是同一个弹窗（不关掉重开）");
    assert.equal(activeWidgetTab()?.text, t("view.widget.quadrant"), "高亮跟着换");
    assert.equal(currentPopup()?.query(".wf-widget-popup-title")[0].text, t("view.widget.quadrant"));

    const pageBody = currentPopup()?.query(".wf-widget-popup-body")[0];
    assert.equal(pageBody?.query(".wf-quad-partition").length, 16, "内容换成 quadrant");
    assert.equal(pageBody?.query(".wf-gantt").length, 0, "上一页内容已撤掉");

    closeWidget();
  });

  test("③ 数据刷新后切 tab 用的是新数据（「已归档」tab 文案跟着变）", async () => {
    const { container } = await render(validMarkdown13());
    openWidget(container, "📊");
    const archiveTab = body.query(".wf-widget-tab").find((tab) => tab.text.startsWith("已归档"));
    assert.ok(archiveTab !== undefined, "应有「已归档」tab");
    const before = archiveTab.text;
    // 切走再切回，文案与计数不应丢
    widgetButton(container, "📥").onclick?.(mouseEvent());
    widgetButton(container, "📊").onclick?.(mouseEvent());
    const after = body.query(".wf-widget-tab").find((tab) => tab.text.startsWith("已归档"))?.text;
    assert.equal(after, before, "tab 文案（含计数）保持");
    closeWidget();
  });

  test("④ 弹窗：固定宽高 + tab 行样式（切 tab 不跳尺寸）", () => {
    const css = cssOf();
    const popup = blockOf(css, ".wf-widget-popup--tabs");
    assert.match(popup, /width:\s*min\(1180px/, "固定宽度");
    assert.match(popup, /height:\s*min\(720px/, "固定高度");
    assert.match(blockOf(css, ".wf-widget-tabs"), /display:\s*flex/, "tab 行是横向 flex");
    assert.match(blockOf(css, ".wf-widget-tabs"), /overflow-x:\s*auto/, "窄屏横向滚动");
    assert.match(blockOf(css, ".wf-widget-tab"), /cursor:\s*pointer/);
    assert.match(blockOf(css, ".wf-widget-tab.is-active"), /--interactive-accent/, "高亮走主题色");
  });

  test("⑤ 旧的 4 个宽度变体段已删除", () => {
    const css = cssOf();
    for (const variant of ["gantt", "quadrant", "plot", "records"]) {
      assert.doesNotMatch(css, new RegExp(`\\.wf-widget-popup--${variant}\\b`), `旧变体 --${variant} 应删掉`);
    }
  });

  test("⑥ 两列虚线分隔：`.wf-panel-column > .wf-panel-list`", () => {
    const css = cssOf();
    const list = blockOf(css, ".wf-panel-column > .wf-panel-list");
    assert.match(list, /border-top:\s*1px dashed/, "标题与按钮之间一条虚线");
    assert.match(list, /display:\s*flex/, "按钮竖排");
  });

  test("⑦ 右侧面板：遮罩 flex 居中、面板居中固定尺寸（不再是 dock 右缘）", () => {
    const css = cssOf();
    const overlay = blockOf(css, ".wf-side-panel-overlay");
    assert.match(overlay, /display:\s*flex/, "遮罩是居中容器");
    assert.match(overlay, /align-items:\s*center/);
    assert.match(overlay, /justify-content:\s*center/);

    const panel = blockOf(css, ".wf-side-panel");
    assert.match(panel, /position:\s*relative/, "不再是 absolute dock");
    assert.doesNotMatch(panel, /position:\s*absolute/);
    assert.match(panel, /width:\s*min\(640px/, "固定宽度");
    assert.match(panel, /height:\s*min\(720px/, "固定高度（切 tab 不换尺寸）");
    assert.match(panel, /border:\s*1px solid var\(--wf-panel-border\)/, "与小工具弹窗同源边框");
  });
});

/* ------------------------------------------------------------------ *
 * Phase 40：「schema警告」tab（校验语义收窄的视图侧）
 *
 * 未定义字段从 error 降为 warning 之后：
 *  - 关键字段齐 + 多一个字段 → 卡牌照常渲染，**没有**整块 `.wf-issue-box`；
 *  - 字段名与 JSON Pointer 只出现在「统计 → schema警告」里（不再淹没在看板错误框）。
 * ------------------------------------------------------------------ */
describe("Phase 40 · schema警告（统计弹窗 tab）", () => {
  /** 合法 1.3 文档的根节点上多写一个设计外字段（`prority` = `priority` 的常见拼错） */
  function markdownWithUnknownField(): string {
    const document = validDocument13();
    (document.workflows[0].root as unknown as Record<string, unknown>).prority = 3;
    return `${VALID_FRONTMATTER_11}${VALID_BODY_11}\n\`\`\`wfjson\n${JSON.stringify(document, null, 2)}\n\`\`\`\n`;
  }

  test("① 没有未定义字段 → 空态提示", async () => {
    const { container } = await render(validMarkdown13());
    const page = openWidget(container, "🩺");

    assert.equal(activeWidgetTab()?.text, t("view.widget.schemaWarn"), "停在 schema警告 tab");
    assert.equal(page.query(".wf-schema-warn-item").length, 0);
    const placeholder = page.query(".wf-widget-placeholder")[0];
    assert.ok(placeholder, "空态要有占位文案");
    assert.equal(placeholder.text, t("view.schemaWarn.empty"));

    closeWidget();
  });

  test("② 未定义字段不再阻断看板，只在 tab 里列字段名与位置", async () => {
    const { container } = await render(markdownWithUnknownField());

    assert.equal(container.query(".wf-issue-box").length, 0, "不该换成错误框（未定义字段只是 warning）");
    assert.ok(container.query(".wf-card").length > 0, "卡片照常渲染");

    const page = openWidget(container, "🩺");
    assert.deepEqual(texts(page.query(".wf-schema-warn-field")), ["prority"]);
    assert.equal(
      page.query(".wf-schema-warn-summary")[0].text,
      t("view.schemaWarn.summary", { count: 1 }),
      "顶部有计数 + 说明",
    );
    const path = page.query(".wf-schema-warn-path")[0];
    assert.ok(path, "每一行都带位置");
    assert.equal(path.text, t("view.schemaWarn.path", { path: "/workflows/0/root/prority" }));

    closeWidget();
  });
});



/* ------------------------------------------------------------------ *
 * Phase 31：开始任务自动展开「状态总览」（结束不收起）
 * ------------------------------------------------------------------ */

describe("wfView · Phase 31 开始任务自动展开总览", () => {
  /** 本组会挂真实的 setInterval（正计时 tick）→ 收尾统一清掉，否则测试进程不会退出 */
  after(() => stopTimerTicker());

  /** 右键某张卡片 → 返回菜单项（与 Phase 2 / Phase 3 那两组同样的辅助） */
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

  /** 总览块当前是否展开（每次都重查 —— 局部刷新后元素可能是新的） */
  const overviewOpen = (container: StubElement): boolean => {
    const overview = container.query(".wf-overview")[0];
    assert.ok(overview !== undefined, "总览块应一直存在（开关只切类名）");
    return overview.hasClass("is-open");
  };

  /**
   * 「▶️ 开始这个任务」真引擎桩：写回 `timeEntries`（写法同 Phase 3 那组）。
   *
   * `changedNodeIds` 故意给**空数组**：`refreshNodes` 于是直接走 `fallback()`，而测试里传给
   * `renderWorkflowView` 的 `refresh` 是空实现 —— 局部刷新会进
   * `refreshChrome → syncNavRail → bindNavScrollHighlight`，那条路要 `querySelector`，
   * DOM 桩还没补（见 `doc/ai_rules/lint.md` §7.1 的历史红灯），一进去就抛。
   * 本组要断的是「`setOverviewCollapsed` 把**现有** `.wf-overview` 的类切了」，
   * 面板按钮那一路用「再画一帧」验（新一帧读的是同一个 `overviewCollapsed`）。
   */
  function stubStartTimer(recorder: Recorder): void {
    recorder.host.startTimer = async (_file, nodeId) => {
      recorder.timerStartCalls.push({ nodeId });
      const now = new Date();
      const document = validDocument13();
      const edit = startTimerEntry(document, nodeId, now);
      if (!edit.ok) throw new Error(`夹具不该失败：${edit.reason ?? ""}`);
      recorder.state.markdown = writeBackDocument(recorder.state.markdown, document, { now }).markdown;
      return { success: true, changed: true, issues: [], nodeId, changedNodeIds: [] };
    };
  }

  test("① 手动收起后右键「▶️ 开始这个任务」→ 总览自动展开（重渲染后按钮也是开态）", async () => {
    const { container, recorder } = await render(validMarkdown13());
    stubStartTimer(recorder);

    // 先按 Phase 29 的面板开关把总览收起来（用户「藏过就忘了」的那个状态）
    panelButton(container, t("view.nav.overview")).onclick?.(mouseEvent());
    assert.equal(overviewOpen(container), false, "先手动收起");

    clickMenuItem(openCardMenu(container.query(".wf-card")[0]), "▶️ 开始这个任务");
    await flush();
    await flush();

    assert.deepEqual(recorder.timerStartCalls, [{ nodeId: ROOT_ID }]);
    assert.equal(overviewOpen(container), true, "开始计时后总览要自动展开（现有元素被切了 is-open）");

    // 再画一帧：总览 / 面板「总览」按钮 / 计时器都读同一份会话状态与写回后的数据
    const again = await render(recorder.state.markdown);
    assert.equal(overviewOpen(again.container), true, "重渲染后总览仍是展开");
    assert.equal(again.container.query(".wf-timer").length, 1, "数据里已经有进行中的计时");
    const toggle = panelButton(again.container, t("view.nav.overview"));
    assert.equal(toggle.getAttribute("aria-pressed"), "true", "按钮状态跟同一份状态走");
    assert.ok(toggle.classList.contains("wf-panel-btn--on"));
  });

  test("② 开始之后「⏹ 结束并记录」→ 总览仍然展开（结束不收起）", async () => {
    const { container, recorder } = await render(validMarkdown13());
    stubStartTimer(recorder);

    clickMenuItem(openCardMenu(container.query(".wf-card")[0]), "▶️ 开始这个任务");
    await flush();
    await flush();
    assert.equal(overviewOpen(container), true);

    // 同一条写回口径（`changedNodeIds: []` → `fallback()`，见上面的说明）
    recorder.host.stopTimer = async (_file, nodeId, mode) => {
      recorder.timerStopCalls.push({ nodeId, mode });
      return { success: true, changed: true, issues: [], nodeId, changedNodeIds: [], mode };
    };
    clickMenuItem(openCardMenu(container.query(".wf-card")[0]), "⏹ 结束并记录");
    await flush();
    await flush();

    assert.deepEqual(recorder.timerStopCalls, [{ nodeId: ROOT_ID, mode: "record" }]);
    assert.equal(overviewOpen(container), true, "结束**不**收起总览（马上要开下一个）");

    const again = await render(recorder.state.markdown);
    assert.equal(overviewOpen(again.container), true, "重渲染后也不收起");
    assert.equal(panelButton(again.container, t("view.nav.overview")).getAttribute("aria-pressed"), "true");
  });
});


/* ------------------------------------------------------------------ *
 * Phase 32：面板按钮 × 8 主题（styles.css 静态断言）
 * ------------------------------------------------------------------ */

describe("wfView · Phase 32 面板按钮主题样式（styles.css 静态断言）", () => {
  const cssOf = (): string =>
    readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  /**
   * 取某条规则块的声明部分（**Phase 29 那版**：起点往后找第一对 `{}`，允许选择器在逗号分组里）。
   * 不能用 Phase 30 那版 —— 它要求「选择器独占行首且紧跟 `{`」，而这里的规则都是两条选择器一组。
   */
  function blockOf(css: string, selector: string): string {
    const start = css.indexOf(selector);
    assert.notEqual(start, -1, `styles.css 缺少 ${selector}`);
    const open = css.indexOf("{", start);
    const between = css.slice(start + selector.length, open);
    assert.doesNotMatch(between, /}/, `${selector} 不是一条规则块的开头`);
    const close = css.indexOf("}", open);
    return css.slice(open + 1, close);
  }

  /** 八套主题键（顺序 = main.ts 的 WF_THEME_KEYS；default 已随 Phase 44 删除） */
  const THEMES = ["tech", "nature", "magazine", "retro", "polka", "web", "fresh", "shoujo"];

  test("① 8 套主题各有一组 `.wf-panel-btn` / `.wf-theme-btn` 规则，且互不相同", () => {
    const css = cssOf();
    const blocks: string[] = [];
    for (const theme of THEMES) {
      const button = blockOf(css, `.wf-theme[data-wf-theme="${theme}"] .wf-panel-btn`);
      const themeButton = blockOf(css, `.wf-theme[data-wf-theme="${theme}"] .wf-theme-btn`);
      assert.ok(button.trim().length > 0, `${theme}：面板按钮规则不能是空块`);
      assert.ok(themeButton.trim().length > 0, `${theme}：主题按钮规则不能是空块`);
      blocks.push(button);
    }
    assert.equal(new Set(blocks).size, THEMES.length, "8 套主题的常态样式必须各不相同");
  });

  test("② 每套都有 hover 与开态（`--on` / `--active`）", () => {
    const css = cssOf();
    for (const theme of THEMES) {
      assert.ok(
        blockOf(css, `.wf-theme[data-wf-theme="${theme}"] .wf-panel-btn:hover`).trim().length > 0,
        `${theme}：缺 hover 块（主题常态块权重高于基线 hover，不写就没有反馈）`,
      );
      assert.ok(
        blockOf(css, `.wf-theme[data-wf-theme="${theme}"] .wf-panel-btn--on`).trim().length > 0,
        `${theme}：缺开态块`,
      );
      assert.ok(
        blockOf(css, `.wf-theme[data-wf-theme="${theme}"] .wf-theme-btn--active`).trim().length > 0,
        `${theme}：主题列缺开态块`,
      );
    }
  });

  test("③ 签名抽样：直角 / 衬线 / 链接蓝 / 双向柔影 / 毛玻璃 / 胶囊圆角", () => {
    const css = cssOf();

    const tech = blockOf(css, '.wf-theme[data-wf-theme="tech"] .wf-panel-btn');
    assert.match(tech, /border-radius:\s*0/, "科技风是直角");
    assert.match(tech, /font-family:[^;]*monospace/, "科技风等宽字");
    assert.match(
      blockOf(css, '.wf-theme[data-wf-theme="tech"] .wf-panel-btn:hover'),
      /box-shadow/,
      "科技风 hover 带霓虹外发光",
    );

    const magazine = blockOf(css, '.wf-theme[data-wf-theme="magazine"] .wf-panel-btn');
    assert.match(magazine, /font-family:[^;]*Georgia/, "杂志风全衬线");
    assert.match(magazine, /border-bottom/, "杂志风用底部发丝线代替外框");

    assert.match(blockOf(css, '.wf-theme[data-wf-theme="web"] .wf-panel-btn'), /#0000ff/, "网页风纯蓝链接色");

    const polka = blockOf(css, '.wf-theme[data-wf-theme="polka"] .wf-panel-btn');
    assert.match(polka, /radial-gradient/, "波点风圆点纹理");
    assert.match(polka, /rgb\(138 98 93/, "波点风浅色圆点色");
    assert.match(polka, /box-shadow:\s*none/, "波点风去掉立体阴影（扁平）");

    assert.match(blockOf(css, '.wf-theme[data-wf-theme="fresh"] .wf-panel-btn'), /backdrop-filter/, "清新风毛玻璃");

    const shoujo = blockOf(css, '.wf-theme[data-wf-theme="shoujo"] .wf-panel-btn');
    assert.match(shoujo, /border-radius:\s*999px/, "少女风胶囊圆角");
    assert.match(shoujo, /radial-gradient/, "少女风网点纹理");
  });

  test("④ 只动视觉：S17 那一段不写 width / height / margin / padding / font-size", () => {
    const css = cssOf();
    const start = css.indexOf('.wf-theme[data-wf-theme="tech"] .wf-panel-btn');
    assert.notEqual(start, -1, "S17 分节应从 tech 那组规则开始（default 已随 Phase 44 删除）");
    const section = css.slice(start);
    assert.doesNotMatch(
      section,
      /^\s*(width|height|margin|padding|font-size)\s*:/m,
      "面板列宽 / 行高 / 虚线间距不能被主题样式改掉",
    );
  });

  test("⑤ 基线未破：S5 `.wf-panel-btn` 仍是撑满列宽的文字按钮，开态仍走 accent", () => {
    const css = cssOf();
    // 新块在文件末尾 → `blockOf` 的首个命中仍是 S5 的基线规则
    const base = blockOf(css, ".wf-panel-btn");
    assert.match(base, /width:\s*100%/);
    assert.match(base, /text-align:\s*left/);
    assert.match(blockOf(css, ".wf-panel-btn--on"), /--interactive-accent/);
  });
});

/* ------------------------------------------------------------------ *
 * Phase 33：「正在进行」块三分区（未分类 / 进行中工作流 / 导航栏）+ 两框 + 未分类开关
 * 契约：doc/datacontact/phase33_bound.md §3 / §4 / §5 / §6 / §7
 * ------------------------------------------------------------------ */

describe("wfView · Phase 33 两框骨架与未分类开关", () => {
  /**
   * 夹具：3 条进行中 + 1 条已完成 + 1 条已取消（多分组才测得出「框② 在非 active 上下文不套框」）。
   *
   * 新增节点的 `noteAnchor` 留在 JSON 里不删：Phase 27 起 `checkNoteAnchors` /
   * `checkOrphanAnchors` 已**不再被 `checkConsistency` 调用**（正文里没有对应段落也不算问题），
   * 所以不需要再 `delete node.noteAnchor`（那个旧写法还会多报 `no-deprecated`）。
   */
  function phase33Markdown(): string {
    const document = validDocument11();
    for (const index of [1, 2]) {
      const root = leaf(`nd-uuid-9${index}`, `进行中 ${index + 1}`);
      document.workflows.push({ id: `wf-uuid-9${index}`, title: `进行中流 ${index + 1}`, root });
    }
    const cancelled = leaf("nd-uuid-930", "🚫 取消掉的那条", {
      status: "done",
      progress: 1,
      progress_max: 1,
      completedAt: "2026-10-09T18:00:00+08:00",
    });
    document.workflows.push({ id: "wf-uuid-930", title: "已取消流", state: "cancelled", root: cancelled });
    return writeBackDocument(validMarkdown11(), document).markdown;
  }

  const cssOf = (): string =>
    readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  /** 取某条规则块的声明部分（从选择器往后找第一对 `{}`，允许它在逗号分组里） */
  function blockOf(css: string, selector: string): string {
    const start = css.indexOf(selector);
    assert.notEqual(start, -1, `styles.css 缺少 ${selector}`);
    const open = css.indexOf("{", start);
    const between = css.slice(start + selector.length, open);
    assert.doesNotMatch(between, /}/, `${selector} 不是一条规则块的开头`);
    const close = css.indexOf("}", open);
    return css.slice(open + 1, close);
  }

  test("① 结构：未分类一框、进行中工作流 + 导航栏共一框（两框平级）", async () => {
    const { container } = await render(phase33Markdown());

    const body = container.query(".wf-block-body")[0];
    const frameUnclassified = container.query(".wf-board-frame--unclassified")[0];
    const frameActive = container.query(".wf-board-frame--active")[0];
    assert.ok(
      body !== undefined && frameUnclassified !== undefined && frameActive !== undefined,
      "块和两个框都要渲染出来",
    );

    assert.equal(frameUnclassified.parent, body, "框① 直接挂在块里（与框② 平级，不再嵌在分栏区里）");
    assert.equal(body.children[0], frameUnclassified, "框① 是块的第一个子元素（最左）");
    assert.equal(frameUnclassified.query(".wf-column").length, 1, "框① 里只有未分类那一列");
    assert.ok(frameUnclassified.query(".wf-column")[0].hasClass("wf-unclassified"));
    assert.equal(
      frameUnclassified.query(".wf-active-scroll").length,
      0,
      "横滚区不在框① 里（未分类不参与横滚）",
    );
    assert.equal(
      frameUnclassified.query(".wf-board-frame").length,
      1,
      "框① 里不许再套框（`query` 含自身，所以数到 1 = 它自己）",
    );
    assert.equal(frameUnclassified.closest(".wf-board-frame--active"), null, "框① 不在框② 里面");
    assert.equal(
      frameUnclassified.closest(".wf-pane"),
      null,
      "框① 不在任何 pane 里 → 切到已完成 / 已取消不会跟着 pane 一起 display:none",
    );

    assert.equal(frameActive.parent, body, "框② 也直接挂在块里（两框平级）");
    assert.equal(body.children[1], frameActive, "框② 排在框① 之后（视觉顺序再由 order 钉）");
    assert.equal(
      frameActive.query(".wf-board-frame").length,
      1,
      "框② 里不再含框①（`query` 含自身，所以数到 1 = 它自己）",
    );
    assert.equal(frameActive.query(".wf-pane-active").length, 1, "框② 里是进行中那个 pane");
    const columns = frameActive.query(".wf-active-columns")[0];
    assert.ok(columns !== undefined, "框② 里有分栏区");
    assert.equal(columns.children.length, 1, "分栏区里只剩横滚区（未分类列已挪到框② 外面）");
    assert.equal(columns.query(".wf-column").length, 3, "横滚区里 3 栏 = 3 条进行中工作流");
    assert.equal(frameActive.query(".wf-active-scroll").length, 1, "横滚区在框② 里");

    const rail = container.query(".wf-nav-rail")[0];
    assert.ok(rail !== undefined, "导航条还要在");
    assert.equal(rail.parent, frameActive, "Phase 33：导航条搬进框②");
    assert.equal(
      frameActive.children[frameActive.children.length - 1],
      rail,
      "导航条是框② 的最后一个子元素（最右）",
    );
    assert.equal(
      container.query(".wf-main")[0].children.includes(rail),
      false,
      "导航条不再是 `.wf-main` 的直子（Phase 25~32 的位置已作废）",
    );
  });

  test("①b 未分类「＋ 新建」把本帧主题带进面板（与节点右键弹窗同一套皮肤）", async () => {
    const recorder = makeHost(phase33Markdown());
    const container = new StubElement("div");
    await renderWorkflowView(
      recorder.host,
      { app: recorder.host.app, container: asHtmlElement(container), currentFilePath: file.path },
      { theme: "polka" },
    );

    const newButton = container.query(".wf-unclassified-new")[0];
    assert.ok(newButton !== undefined, "未分类列头要有「＋ 新建」按钮");
    newButton.onclick?.(mouseEvent());
    await flush();

    // 漏传 theme 的话面板外壳没有 `.wf-theme[data-wf-theme]` → 退回素净基线，
    // 与「节点右键 → 面板」的深色波点外壳长得不一样（本次修复的口径）
    assert.deepEqual(recorder.unclassifiedChildCalls, [{ filePath: file.path, theme: "polka" }]);
  });

  test("② 已完成 / 已取消两个 pane 不套框，且整块只有两个框", async () => {
    const { container } = await render(phase33Markdown());

    const body = container.query(".wf-block-body")[0];
    const frameUnclassified = container.query(".wf-board-frame--unclassified")[0];
    const frameActive = container.query(".wf-board-frame--active")[0];
    assert.equal(body.children[0], frameUnclassified, "框① 是块里第一个子元素（最左）");
    assert.equal(body.children[1], frameActive, "框② 排在框① 之后（order 再把它钉到最右）");
    assert.equal(body.query(".wf-board-frame").length, 2, "整块里只有两个框（两个 pane 里一个都没有）");

    for (const state of ["archived", "cancelled"]) {
      const pane = container.query(`.wf-pane-${state}`)[0];
      assert.ok(pane !== undefined, `${state} pane 应在`);
      assert.equal(pane.parent, body, `${state} pane 是块的直子（不在框里）`);
      assert.equal(pane.query(".wf-board-frame").length, 0, `${state} pane 里不许有框`);
      assert.ok(body.children.includes(pane), `${state} pane 仍在块里（只是不套框）`);
    }
  });

  test("③ 面板「修改」列第 5 个开关：未分类 显示 ⇄ 隐藏（原位切换，不重渲染）", async () => {
    const { container } = await render(phase33Markdown());

    const frame = container.query(".wf-board-frame--unclassified")[0];
    const toggle = panelButton(container, t("view.unclassified.title"));
    assert.equal(toggle.text, `${t("view.unclassified.title")}：${t("view.nav.unclassifiedShow")}`);
    assert.equal(toggle.title, t("view.nav.unclassifiedHint"));
    assert.equal(toggle.getAttribute("aria-pressed"), "true", "默认显示");
    assert.ok(toggle.classList.contains("wf-panel-btn--on"), "显示态加主题色类");
    assert.equal(frame.hasClass("is-hidden"), false, "首帧框① 是显示的");

    toggle.onclick?.(mouseEvent());
    assert.equal(frame.hasClass("is-hidden"), true, "点一下把框① 藏起来（只切类名）");
    assert.equal(toggle.text, `${t("view.unclassified.title")}：${t("view.nav.unclassifiedHide")}`);
    assert.equal(toggle.getAttribute("aria-pressed"), "false");
    assert.equal(toggle.classList.contains("wf-panel-btn--on"), false);
    assert.equal(container.query(".wf-board-frame--unclassified")[0], frame, "同一帧不重建元素");
    assert.equal(
      container.query(".wf-column").some((column) => column.hasClass("wf-unclassified")),
      true,
      "藏起来只是 display:none，未分类列仍在 DOM 里（下次放出来不用重画）",
    );

    toggle.onclick?.(mouseEvent());
    assert.equal(frame.hasClass("is-hidden"), false, "再点一下放回来");
    assert.equal(toggle.getAttribute("aria-pressed"), "true");
  });

  test("④ 藏起未分类不动跳转目标（横滚容器与栏 offsetLeft 都没变）", async () => {
    const { container } = await render(phase33Markdown());

    const columns = container.query(".wf-active-columns")[0];
    const scroller = columns.querySelector(".wf-active-scroll");
    assert.ok(scroller !== null, "分栏里要有横滚容器");
    scroller.scrollWidth = 900;
    scroller.clientWidth = 300;
    const columnEls = scroller.query(".wf-column");
    assert.equal(columnEls.length, 3);
    columnEls.forEach((column, index) => {
      column.offsetLeft = index * 300;
      column.offsetWidth = 290;
    });

    // 先按「显示」测一次
    container.query(".wf-nav-item")[1].onclick?.(mouseEvent());
    assert.deepEqual(scroller.scrollCalls.at(-1), { left: 300, behavior: "smooth" }, "第 2 栏按 offsetLeft 对齐");

    // 藏起框①：未分类列不在横滚区里，所以目标 left 一字不变
    panelButton(container, t("view.unclassified.title")).onclick?.(mouseEvent());
    assert.equal(container.query(".wf-board-frame--unclassified")[0].hasClass("is-hidden"), true);
    container.query(".wf-nav-item")[1].onclick?.(mouseEvent());
    assert.deepEqual(
      scroller.scrollCalls.at(-1),
      { left: 300, behavior: "smooth" },
      "藏了未分类框，跳转目标仍是同一个 offsetLeft",
    );
  });

  test("⑤ 藏起来之后重渲染仍记得（会话状态，关看板才忘）", async () => {
    const first = await render(phase33Markdown());
    panelButton(first.container, t("view.unclassified.title")).onclick?.(mouseEvent());
    assert.equal(
      first.container.query(".wf-board-frame--unclassified")[0].hasClass("is-hidden"),
      true,
      "先手动藏起来",
    );

    // 整块重渲染（同一 file.path）：状态在 `unclassifiedHidden` 里 → 首帧就带 is-hidden
    const second = await render(phase33Markdown());
    assert.equal(
      second.container.query(".wf-board-frame--unclassified")[0].hasClass("is-hidden"),
      true,
      "重渲染后仍藏着（纯视图状态按 file.path 记）",
    );
    const toggle = panelButton(second.container, t("view.unclassified.title"));
    assert.equal(toggle.text, `${t("view.unclassified.title")}：${t("view.nav.unclassifiedHide")}`);

    toggle.onclick?.(mouseEvent());
    const third = await render(phase33Markdown());
    assert.equal(
      third.container.query(".wf-board-frame--unclassified")[0].hasClass("is-hidden"),
      false,
      "放回来之后重渲染就是显示的",
    );
  });

  test("⑥ CSS 骨架：两框布局齐（display / box-sizing / align-self / padding / order / is-hidden）", () => {
    const css = cssOf();
    const base = blockOf(css, ".wf-board-frame");
    assert.match(base, /display:\s*flex/);
    assert.match(base, /box-sizing:\s*border-box/);
    assert.match(base, /align-self:\s*stretch/, "两框与分栏区等高");
    assert.match(base, /padding:\s*6px/, "框内留白（皮肤主题块不再重复写 padding）");

    const unclassified = blockOf(css, ".wf-board-frame--unclassified");
    assert.match(unclassified, /flex:\s*0 0 auto/);
    assert.match(unclassified, /order:\s*0/, "框① 永远在块的最左");
    assert.match(blockOf(css, ".wf-board-frame--unclassified.is-hidden"), /display:\s*none/);

    // 框① 跨上下文常显：不许用 data-context 把它藏起来（只有面板开关的 is-hidden 能藏它）
    assert.doesNotMatch(
      css,
      /[^{}]*data-context[^{}]*wf-board-frame--unclassified[^{}]*\{/,
      "框① 不许被任何 [data-context] 规则藏起来",
    );

    const active = blockOf(css, ".wf-board-frame--active");
    assert.match(active, /order:\s*2/, "框② 永远在块的最右");
    assert.match(active, /flex-direction:\s*row/);
    assert.match(active, /gap:\s*8px/, "横滚区与导航栏之间留 8px");
    assert.match(
      blockOf(css, '.wf-block-body[data-context="active"] > .wf-board-frame--active'),
      /flex:\s*1 1 0/,
      "只有 active 上下文才吃满宽度",
    );
    assert.match(
      blockOf(css, ".wf-block-body > .wf-pane-archived"),
      /order:\s*1/,
      "归档 / 已取消 pane 排在框② 左边",
    );
  });

  test("⑦ CSS S18：两框 × 8 主题齐、互不相同、只写视觉", () => {
    const css = cssOf();
    const themes = ["tech", "nature", "magazine", "retro", "polka", "web", "fresh", "shoujo"];
    const skinOf = (theme: string): string =>
      blockOf(css, `.wf-theme[data-wf-theme="${theme}"] .wf-block-body[data-context="active"] .wf-board-frame`);

    const skins: string[] = [];
    for (const theme of themes) {
      const body = skinOf(theme);
      assert.ok(body.trim().length > 0, `${theme} 的框皮肤不能是空的`);
      assert.match(body, /border/, `${theme} 要有描边`);
      assert.match(body, /border-radius/, `${theme} 要有圆角口径（直角也要显式写 0）`);
      skins.push(body.replace(/\s+/g, " ").trim());
    }
    assert.equal(new Set(skins).size, themes.length, "8 套主题的框皮肤必须互不相同");

    // 只写视觉：从 S18 第一组规则到文件末尾都不许出现几何声明
    const start = css.indexOf(
      '.wf-theme[data-wf-theme="tech"] .wf-block-body[data-context="active"] .wf-board-frame',
    );
    assert.notEqual(start, -1, "S18 分节应从 tech 那组规则开始（default 已随 Phase 44 删除）");
    assert.doesNotMatch(
      css.slice(start),
      /^\s*(width|height|margin|padding|font-size)\s*:/m,
      "S18 只写视觉：栏宽 / 行高 / 未分类列宽不能被主题样式改掉",
    );

    // 抽样签名（每套一个可辨识的特征值）
    assert.doesNotMatch(css, /data-wf-theme="default"/, "default 主题的框皮肤已随主题删除（Phase 44）");
    assert.match(skinOf("tech"), /border-radius:\s*0/, "科技风直角");
    assert.match(skinOf("tech"), /--wf-status-doing/, "科技风复用霓虹青 token");
    assert.match(skinOf("nature"), /radial-gradient/, "自然风纸纹点阵");
    assert.match(skinOf("magazine"), /border-top:\s*3px solid var\(--text-normal\)/, "杂志风上沿实黑");
    assert.match(skinOf("retro"), /repeating-linear-gradient/, "复古风竖格纹");
    const polka = skinOf("polka");
    assert.match(polka, /radial-gradient/, "波点风圆点纹理");
    assert.match(polka, /rgb\(138 98 93/, "波点风浅色圆点色");
    assert.match(skinOf("web"), /outset/, "网页风 90 年代按钮边");
    assert.match(skinOf("fresh"), /backdrop-filter/, "清新风毛玻璃");
    assert.match(skinOf("shoujo"), /border-radius:\s*22px/, "少女风大圆角");
  });

  test("⑧ 导航条在最右 → 下拉面板与悬停名字都向左开", () => {
    const css = cssOf();
    const panel = blockOf(css, ".wf-panel-overview");
    assert.match(panel, /right:\s*calc\(100%\s*\+\s*10px\)/, "面板挂在按钮左侧");
    assert.doesNotMatch(panel, /left:\s*calc\(100%/, "旧的「向右开」定位必须撤掉");
    assert.match(panel, /translateX\(-10px\)/, "从左侧滑出");
    assert.match(blockOf(css, ".wf-panel-overview.is-open"), /translateX\(0\)/);

    const tooltip = blockOf(css, ".wf-nav-tooltip");
    assert.match(tooltip, /right:\s*-6px/, "名字向左吐");
    assert.doesNotMatch(tooltip, /left:\s*-6px/, "旧的「向右吐」外扩必须撤掉");
    assert.match(tooltip, /padding:\s*0\s+calc\([^;]*\)\s+0\s+12px/, "留白改到右侧（给横杠腾位置）");
    assert.match(tooltip, /text-align:\s*right/);
  });
});

describe("wfView · Phase 34 链接文档（菜单上限 / 面板 tab 6）", () => {
  /** 6 份资料：验证菜单只列 5 条 + 「另有 1 份」（卡片匹配口径 = id 命中） */
  const files: LinkedFile[] = Array.from({ length: 6 }, (_, index) => ({
    path: `资料/文档-${index + 1}.md`,
    title: `文档-${index + 1}`,
    workflowTitle: "立项调查",
    nodeTitle: "调研竞品",
    workflowId: "wf-uuid-001",
    nodeId: ROOT_ID,
  }));

  test("菜单资料项最多 5 条 + 「另有 N 份」；「编辑节点链接文档」落到 tab 6", async () => {
    const { container, recorder } = await renderWith(validMarkdown11(), (rec) => {
      rec.linkFixture.files = files;
    });
    const card = container.query(".wf-card")[0];
    card.oncontextmenu?.(mouseEvent());
    const menu = body.query(".wf-menu")[0];
    assert.ok(menu, "右键应弹出菜单");
    const items = menu.query(".wf-menu-item");
    const textsOfItems = texts(items);

    const docItems = textsOfItems.filter((text) => text.startsWith(`📄 文档-`));
    assert.equal(docItems.length, 5, `资料项最多 5 条，实际：${docItems.join(" / ")}`);
    assert.ok(
      textsOfItems.includes(t("view.menu.moreLinks", { count: 1 })),
      `多出来的 1 份给一行提示，实际：${textsOfItems.join(" / ")}`,
    );

    const entry = items.find((item) => item.text === t("view.menu.editLinkDocs"));
    assert.ok(entry, "菜单应有「编辑节点链接文档」");
    entry.onclick?.(mouseEvent());
    await flush();

    assert.deepEqual(recorder.linkDocsCalls, [{ nodeId: ROOT_ID }], "tab 6 带节点 id（入口在卡片上）");
  });

  test("面板里新建了文档 → 提示「已新建 N 份」（结果从面板一次性带回）", async () => {
    const { container, recorder } = await render(validMarkdown11());
    recorder.host.openNodePanel = panelStub(async (_file, _node, tab) => {
      if (tab !== "links") return { cancelled: true };
      return {
        cancelled: false,
        result: {
          success: true,
          nodeId: ROOT_ID,
          changed: true,
          issues: [],
          changedNodeIds: [ROOT_ID],
          createdPaths: ["资料/调研竞品.md", "资料/调研竞品-2.md"],
          linkDirChanged: true,
        },
      };
    });

    const card = container.query(".wf-card")[0];
    card.oncontextmenu?.(mouseEvent());
    const entry = body
      .query(".wf-menu")[0]
      .query(".wf-menu-item")
      .find((item) => item.text === t("view.menu.editLinkDocs"));
    assert.ok(entry);
    entry.onclick?.(mouseEvent());
    await flush();

    const expected = t("view.notify.linkDocsCreated", { title: "调研竞品", count: 2 });
    assert.ok(
      recorder.notices.some((notice) => notice.includes(expected)),
      `应提示新建 2 份，实际：${recorder.notices.join(" / ")}`,
    );
  });
});

describe("wfView · Phase 34 分栏横向滚动位置（重渲染不跳回最左）", () => {
  test("整块重渲染保持 .wf-active-scroll 的 scrollLeft", async () => {
    const recorder = makeHost(validMarkdown11());
    const container = new StubElement("div");
    const dv = { app: recorder.host.app, container: asHtmlElement(container), currentFilePath: file.path };
    await renderWorkflowView(recorder.host, dv);

    const scroller = container.querySelector(".wf-active-scroll");
    assert.ok(scroller !== null, "进行中块里应有横滚容器 .wf-active-scroll");
    scroller.scrollLeft = 240; // 用户横滚到第 2 栏附近

    await renderWorkflowView(recorder.host, dv);

    const rebuilt = container.querySelector(".wf-active-scroll");
    assert.ok(rebuilt !== null, "重渲染后横滚容器仍在");
    assert.notEqual(rebuilt, scroller, "整块重渲染会重建横滚容器（这正是 scrollLeft 会被夹成 0 的场景）");
    assert.equal(rebuilt.scrollLeft, 240, "横向滚动位置被保留（不再跳回最左）");
  });

  test("Dataview 把容器清空 → 仍按 rememberViewScroll 恢复横向位置（D 案）", async () => {
    const recorder = makeHost(validMarkdown11());
    const container = new StubElement("div");
    const dv = { app: recorder.host.app, container: asHtmlElement(container), currentFilePath: file.path };
    await renderWorkflowView(recorder.host, dv);

    const scroller = container.querySelector(".wf-active-scroll");
    assert.ok(scroller !== null);
    scroller.scrollLeft = 180;

    rememberViewScroll(file);
    container.empty(); // 模拟 Dataview 在插件 paint 之前先把 DOM 抹掉

    await renderWorkflowView(recorder.host, dv);
    const rebuilt = container.querySelector(".wf-active-scroll");
    assert.ok(rebuilt !== null);
    assert.equal(rebuilt.scrollLeft, 180, "容器被抹掉后横向位置仍从快照恢复");
  });
});

/* ------------------------------------------------------------------ *
 * Phase 36：样式契约（styles.css 静态断言）
 * ------------------------------------------------------------------ */

describe("wfView · Phase 36 样式契约（归档弹窗纵向 / 链接文档分段）", () => {
  /** 剥掉注释后的 CSS（注释里会复述这些规则） */
  const cssOf = (): string =>
    readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  /** 同一选择器的所有声明块拼起来（选择器精确匹配，逗号分组里的单条也算） */
  const blockOf = (css: string, selector: string): string => {
    const blocks: string[] = [];
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = ruleRe.exec(css)) !== null) {
      if (match[1].split(",").some((part) => part.trim() === selector)) blocks.push(match[2]);
    }
    assert.ok(blocks.length > 0, `styles.css 缺少「${selector}」`);
    return blocks.join("\n");
  };

  test("归档弹窗：wrapper 纵向排列，工作流分组之间画分割线", () => {
    const css = cssOf();
    const wrapper = blockOf(css, ".wf-widget-archive-wrapper");
    assert.match(wrapper, /flex-direction:\s*column/, "已归档弹窗里工作流要上下排列（不再左右并排）");
    assert.match(wrapper, /align-items:\s*stretch/, "分组要撑满宽度，分割线才通栏");
    const divider = blockOf(css, ".wf-archive-group + .wf-archive-group");
    assert.match(divider, /border-top:\s*1px\s+solid\s+var\(--wf-panel-border\)/);
  });

  test("链接文档面板：三段功能之间画分割线", () => {
    const css = cssOf();
    const divider = blockOf(css, ".wf-link-docs-section + .wf-link-docs-section");
    assert.match(divider, /border-top:\s*1px\s+solid\s+var\(--wf-panel-border\)/);
    assert.match(divider, /margin-top:\s*14px/);
  });
});
/* ------------------------------------------------------------------ *
 * 未分类列固定宽度 / 面板 tab 换行（styles.css 静态断言）
 * ------------------------------------------------------------------ */

describe("wfView · 未分类列宽度与面板 tab 换行（styles.css 静态断言）", () => {
  const cssOf = (): string =>
    readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  /** 同一选择器的所有声明块拼起来（选择器精确匹配） */
  const blockOf = (css: string, selector: string): string => {
    const blocks: string[] = [];
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = ruleRe.exec(css)) !== null) {
      if (match[1].split(",").some((part) => part.trim() === selector)) blocks.push(match[2]);
    }
    assert.ok(blocks.length > 0, `styles.css 缺少「${selector}」`);
    return blocks.join("\n");
  };

  test("未分类列：还一个节点都没有时也保持 200px", () => {
    const column = blockOf(cssOf(), ".wf-column.wf-unclassified");
    assert.match(column, /min-width:\s*200px/, "空列表时不能塌成一条窄栏");
  });

  test("面板 tab 行：按钮多时换行（不再横向溢出滚动）", () => {
    const tabs = blockOf(cssOf(), ".wf-side-panel-tabs");
    assert.match(tabs, /flex-wrap:\s*wrap/, "7 个 tab 要能换行");
    assert.doesNotMatch(tabs, /overflow-x:\s*auto/, "换行后不需要横向滚动");
  });
});
/* ------------------------------------------------------------------ *
 * 节点右键弹窗：标题 / 子标题 / 字段 / 字段说明 / 输入框 / 三种按钮
 * 只能有一套（styles.css 静态断言）
 * ------------------------------------------------------------------ */

describe("wfView · 节点弹窗统一表单皮肤（styles.css 静态断言）", () => {
  const cssOf = (): string =>
    readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

  /** 同一选择器的所有声明块拼起来（选择器精确匹配） */
  const blockOf = (css: string, selector: string): string => {
    const blocks: string[] = [];
    const ruleRe = /([^{}]+)\{([^{}]*)\}/g;
    let match: RegExpExecArray | null;
    while ((match = ruleRe.exec(css)) !== null) {
      if (match[1].split(",").some((part) => part.trim() === selector)) blocks.push(match[2]);
    }
    assert.ok(blocks.length > 0, `styles.css 缺少「${selector}」`);
    return blocks.join("\n");
  };

  test("① 标题：一套字号 / 间距；危险弹窗的标题仍是警示色", () => {
    const title = blockOf(cssOf(), ".wfjson-modal > h3");
    assert.match(title, /font-size:\s*1\.05em/, "7 个 tab 的标题同一字号");
    assert.match(title, /margin:\s*0 0 6px/, "标题下边距只写一次");
    assert.match(
      blockOf(cssOf(), ".wfjson-modal.wfjson-modal-danger > h3"),
      /color:\s*var\(--text-error\)/,
      "删除 / 归档的标题用警示色",
    );
    assert.match(
      blockOf(cssOf(), ".wf-theme .wfjson-modal.wfjson-modal-danger > h3"),
      /color:\s*var\(--text-error\)/,
      "8 套主题的标题签名不能把警示色盖掉",
    );
  });

  test("② 子标题 / ④ 字段说明：同一个小字号，颜色分两级", () => {
    assert.match(blockOf(cssOf(), ".wfjson-modal-subtitle"), /color:\s*var\(--text-muted\)/);
    assert.match(
      blockOf(cssOf(), ".wfjson-modal-subtitle"),
      /font-size:\s*var\(--wfjson-text-size\)/,
      "子标题与字段名同一字号",
    );
    assert.match(blockOf(cssOf(), ".wfjson-field-hint"), /color:\s*var\(--text-faint\)/);
  });

  test("③ 字段：标签在上、控件在下（竖排，不写死 padding）", () => {
    const field = blockOf(cssOf(), ".wfjson-field");
    assert.match(field, /flex-direction:\s*column/);
    assert.doesNotMatch(blockOf(cssOf(), ".wfjson-field-label"), /padding-top/, "竖排后不再需要对齐内边距");
  });

  test("⑤ 输入框：单行 / 多行共用一条规则，归档不再单开一套", () => {
    const css = cssOf();
    assert.match(blockOf(css, ".wfjson-modal .wfjson-input"), /height:\s*var\(--wfjson-input-height\)/);
    assert.match(blockOf(css, ".wfjson-modal .wfjson-textarea"), /min-height:\s*54px/);
    assert.match(
      blockOf(css, ".wfjson-modal .wfjson-input"),
      /border-radius:\s*6px/,
      "单行 / 多行同一条规则（同一个声明块）",
    );
    assert.doesNotMatch(css, /\.wfjson-archive-input/, "归档多行框已并入 .wfjson-textarea");
    assert.doesNotMatch(css, /\.wfjson-modal-hint/, "子标题 / 字段说明拆成两个类，旧的混用类下线");
  });

  test("⑥⑦⑧ 普通 / 警告 / 强调按钮：一套尺寸 + 三种配色", () => {
    const css = cssOf();
    const base = blockOf(css, ".wfjson-modal .wfjson-btn");
    assert.match(base, /min-height:\s*var\(--wfjson-btn-height\)/);
    assert.match(base, /background:\s*var\(--interactive-normal\)/);
    assert.match(blockOf(css, ".wfjson-modal .wfjson-btn.mod-cta"), /background:\s*var\(--interactive-accent\)/);
    assert.match(blockOf(css, ".wfjson-modal .wfjson-btn.mod-warning"), /background:\s*var\(--background-modifier-error\)/);
    assert.match(
      blockOf(css, ".wf-theme .wfjson-modal .wfjson-btn"),
      /border-radius:\s*var\(--wf-radius-btn\)/,
      "8 套主题只换圆角，不改三角色的配色",
    );
    assert.doesNotMatch(css, /\.wf-link-docs-(pick|attach|refresh)/, "链接文档的自绘按钮皮肤已并入 .wfjson-btn");
  });
});
