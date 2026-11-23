

/**
 * 插件入口（Obsidian 侧）。
 *
 * 职责边界：
 *  - 本文件只做「Obsidian ↔ 引擎」的编排（读文件、命令、Notice/弹窗、vault.process）；
 *  - 业务逻辑全部在 src/engine（纯 TypeScript、零 Obsidian 依赖、可 node --test 直接跑）；
 *  - 上层只依赖 src/engine/index.ts，不直接引用引擎内部文件。
 *
 * Phase 1（schema 1.1）提供的能力：
 *  1. 命令「校验当前文件的 wfjson」→ 读当前 md → analyzeMarkdown → Notice + 问题弹窗
 *     （Phase 25 起该命令已下线，入口只剩主看板；这里保留的是历史沿革）；
 *  2. `mutateFile()`：通用写回编排（`vault.process` 事务 → 引擎 `applyMutation`：安全闸门 →
 *     1.0→1.1 升格 → 三段写回 → 幂等校验），保证「读 → 改 → 写」原子且不覆盖他人改动；
 *  3. `setNodeStatus()`：改状态（视图右键菜单调用）；
 *  4. `render(dv)`：dataviewjs 视图入口（视图代码在 views/wfView.ts，编译进 main.js）。
 *
 * Phase 2（正在进行块节点右键菜单）在同一套写回链路上加了两层（契约
 * doc/datacontact/data_ixd_phase2_contract.md）：
 *  1. 低层变更方法（契约 §4）：`addChildNode` / `deleteNode` —— 真正写盘，
 *     内存改动全在引擎的 nodeEdits.ts，这里只做「结果 → 结构化返回」的包装；
 *  2. Modal 入口（契约 §7）：Phase 25 之前是 `promptAddChild` / `confirmDeleteNode`，
 *     现在统一收进右侧面板的 `openNodePanel(file, node, "child" | "delete")` ——
 *     视图只传「哪个节点 / 哪个 tab」，弹窗（面板）与就地校验（JSON / Schema / 标题清洗）
 *     以及「取消 vs 失败」的区分仍在本文件。
 *
 * Phase 3（schema 1.3：正计时器 + 近 21 天方块阵）继续复用同一条写回链路（契约
 * doc/datacontact/data_ixd_phase3_contract.md §5）：
 *  1. `startTimer()`：追加一条进行中的计时条目（并发闸门：全文件只允许一个）；
 *  2. `stopTimer(file, nodeId, "record" | "discard")`：结束并记录 / 结束并丢弃；
 *     两个方法的内存改动在引擎的 timerEdits.ts，返回形如 `TimerChangeResult`。
 *
 * Phase 3 视图微调（v0.6，讨论结论见 doc/datacontact/data_ixd_discuss_interact_v0.2.md
 * 《Phase 3 视图调整定稿》）：
 *  1. `WfJsonSettingTab`：插件设置面板，只放「计时器字号」一项，`loadData` / `saveData`
 *     持久化到 Obsidian 的 `data.json`；
 *  2. 启动与设置变更时把字号写进根元素 CSS 变量 `--wf-timer-font-size`
 *     （styles.css 里 `.wf-timer` 读它；用户仍可用 CSS snippet 覆盖同一个变量）。
 *
 * Phase 4（归档：子树浓缩进 `archive/<workflowId>-<nodeId>.wf.json`，Phase 28 起只产 JSON）继续复用同一条写回链路
 * （契约 doc/datacontact/data_ixd_phase4_contract.md）：
 *  1. `archiveNode(file, node, form)`：`planArchive`（内存里算归档文档 + `archive` 字段）
 *     → vault 里 `archive/` 建那份 `.wf.json`（已存在就复用：幂等重试）→ `mutateFile` 把原文件里的子树
 *     浓缩成一个带 `archive` 的 done 节点（内存改动在引擎的 archive.ts，**绝不半途改一半**）；
 *  2. Modal 入口（契约 §7）：`promptArchiveNode` —— 收集 概括 / 原理 / 复盘 三段文字后交给上面那个方法。
 *     Phase 25 起落点改成右侧面板 tab 4（`openNodePanel(file, node, "archive")`），表单仍是同一个类。
 *
 * Phase 22「归档整个工作流」（契约 doc/datacontact/data_ixd_discuss_interact_v0.21md）：
 *  `archiveWorkflow(file, workflow, form)` —— 同一条链路，只是资格换成
 *  「整棵树全 done」（根节点也能归档）、归档文件的 workflow 不带 `originId`、写回时引擎额外记一条
 *  文件级 `workflow_archive` 台账；面板里复用 `ArchiveNodeModal` 的 `kind: "workflow"`
 *  （`openNodePanel(file, workflow.root, "archive", workflow)`）。
 *
 * v0.7 §⑧ 外置 JSON（契约见 doc/datacontact/data_ixd_discuss_interact_v0.7.md）：
 *  1. 路径**扁平**（Phase 24 M1.6）：`A/B/笔记.md` → `_workflowwatcher/笔记~<key>.wf.json`，
 *     全部控制文件都在 `_workflowwatcher` 第一层；`<key>` 是笔记路径算出的 10 位十六进制
 *     （`src/engine/sidecar.ts` 的 `noteKeyFor`），同时写进 JSON 的 `noteKey` 与 frontmatter 的 `wf-key`；
 *  2. 读：侧车存在就以外置 JSON 为准（笔记内残留代码块只报 info），否则退回代码块（旧文件兼容）；
 *     扁平名找不到时退回 M1.6 之前的镜像路径（老侧车照样读得到）；
 *  3. 写：`mutateFile()` 先 `vault.process` 侧车（`applySidecarMutation`）再 `vault.process` 笔记
 *     （`writeBackNote`：frontmatter + 纪要段）。两步都幂等，中断后重试即可收敛；
 *  4. Phase 25 起插件**只有主看板**一个入口，迁移 / 整理类命令全部下线：手写的旧笔记仍按第 2 条
 *     「有侧车读侧车、没侧车读代码块」正常工作，插件不再主动改写用户的笔记；
 *     归档看板是纯 `.wf.json`（Phase 28；M1.5 的「md + 侧车」成对形态已不再生成，老文件仍可读）；
 *  5. `vault.on("rename" / "delete")` 同步侧车：改名 / 移动会改变 key，所以逐篇搬；
 *     文件夹删除后按「键对不上任何现存笔记」清理孤儿（`trashOrphanSidecars`）。
 *
 * Phase 15（拖拽改节点顺序）继续复用同一条写回链路：
 *  `moveNode(file, movingId, targetId, position)` —— 内存改动在引擎的 nodeReorder.ts
 *  （before = 插到目标之前、after = 成为目标的子节点并接手它的 children），这里只做结果包装。
 *
 * Phase 24（看板 ItemView；契约 doc/datacontact/phase24_bound.md）：
 *  1. `WfBoardView`：一个 leaf = 一个看板 = 以前 md 渲染区里的那个面板 —— 渲染仍然全走
 *     `renderWorkflowView`，这里只提供宿主（`contentEl` / 绑定哪篇笔记 / 生命周期）；
 *  2. 绑定关系 = `getState()` 的 `{ file }`（**vault 相对路径**）→ 由 `workspace.json` 落盘、
 *     重启 / 换布局后还原；笔记改名时看板跟随，删除后清空绑定（`strictFile` 下不回落活动文件）；
 *  3. 入口：命令「打开 workflow watcher 主看板」/ 左侧 ribbon / 归档链接（`openArchiveBoard` 开**归档看板**，
 *     归档 `.wf.json` 不存在时只提示，不回落 `openLinkText`）；
 *  4. 多 leaf 并存：`wfView.ts` 的计时 tick / 小工具弹窗 / 浮层主题全部按 `file.path` 分桶
 *     （主看板 + 归档看板同时开时互不抢）。
 *
 * Phase 25（单看板模型；本节即最新口径）：
 *  1. 插件**自有目录改名** `_wfjson` → `_workflowwatcher`（`types.ts` 的 `WFJSON_FOLDER`），
 *     md 与 json 都放这一个文件夹；`onload` 会把老的 `_wfjson/` 整目录改名过来（两个都在时只提示）；
 *  2. 主看板固定 `_workflowwatcher/main~<key>.md` + 它的侧车 `_workflowwatcher/main~<key>.wf.json`
 *     （**同名同键、只差扩展名**，命名规则见 `src/engine/mainBoard.ts`）：**一个命令**
 *     `open-main-board`（命令面板）与**一个 ribbon 图标**都走 `openMainBoard()` ——
 *     文件夹没有就建、md / json 缺哪个补哪个、都在就一个字都不写，然后开看板 leaf；
 *     老命名 `main.md` 打开时自动改名成带键的那份（键是常量，侧车原地不动）；
 *     有多份「像主看板」的 md 时只开排第一的那份并提示一次（不删不合并）；
 *  3. 其余命令（校验 / 迁移 / 整理 / 插入模板 / 按笔记开看板）**全部下线**：产品只留主看板，
 *     笔记里的 dataviewjs 渲染入口（`render()`）保持不变（老笔记照样能在 md 里看）。
 *
 */

import { ItemView, Modal, Notice, Platform, Plugin, PluginSettingTab, Setting, TFile, TFolder, type App, type Command, type TAbstractFile, type ViewStateResult, type WorkspaceLeaf } from "obsidian";
// Phase 26：导入 / 导出要读写「库外任意绝对路径」——库内一律走 vault API，只有库外才用 Node fs。
// 构建侧已把 `node:*` 全部标成 external（esbuild.config.mjs），产物里保留成 require("node:fs")。
import { readFileSync } from "node:fs";

// Phase C 拆分第 1 步：弹窗表单控件已搬到 `ui/form.ts`（纯 DOM、零行为变化）。
import { dueDateField, fieldRow, localDateAfter, readDueDate, wfButton, type DueDateInputs } from "./ui/form.ts";

import {
  analyzeDocument,
  analyzeMarkdown,
  appendAffiliation,
  appendChildNode as appendChildNodeInDocument,
  applyMutation,
  applySidecarMutation,
  applyStatusChange,
  applyWorkflowEdits,
  archiveNode as archiveNodeInDocument,
  archiveFilePathFor,
  ARCHIVE_TAG_FILE,
  buildWorkflowArchive,
  formatArchivedAt,
  parseArchiveTagYaml,
  stringifyArchiveTagYaml,
  archiveFolderOf,
  archiveWorkflow as archiveWorkflowInDocument,
  ARCHIVE_TITLE_SUFFIX,
  attachNodeToUnclassified as attachNodeToUnclassifiedInDocument,
  backupPathFor,
  boardFolderOf,
  buildReverseIndex,
  buildTemplateDocument,
  buildWorkflowTemplate,
  checkIntegerInRange,
  collectAffiliatedFiles,
  collectDescendants,
  collectSubtreeFiles,
  collectWorkflowFiles,
  editWorkflowArchiveInfo as editWorkflowArchiveInfoInDocument,
  editNodeInfo as editNodeInfoInDocument,
  editNodeNote as editNodeNoteInDocument,
  emptyReverseIndex,
  ensureUnclassifiedWorkflow,
  findNode,
  findWorkflow,
  formatIssues,
  formatLocalIso,
  inspectImport,
  newFileId,
  planWorkflowImport,
  normalizeVaultPath,
  stringifyWfJson,
  isArchivePathForNode,
  isBackupPath,
  isMainBoardPath,
  isSidecarPath,
  IMPORTANCE_LABELS,
  UNCLASSIFIED_WORKFLOW_ID,
  URGENCY_LABELS,
  LANG_OPTIONS,
  moveNode as moveNodeInDocument,
  nodeInfoLabel,
  normalizeLang,
  readArchiveFileMeta,
  SCHEMA_VERSION,
  setLang,
  t,
  workflowEditLabel,
  FRONTMATTER_FIELDS,
  FRONTMATTER_LINK_FIELDS,
  LEGACY_WFJSON_FOLDER,
  legacyMainBoardPath,
  legacySidecarPathFor,
  linkedFileTitle,
  MAIN_BOARD_PATH,
  MAIN_BOARD_STEM,
  mainBoardPath,
  mainBoardSidecarPath,
  nodeRefFor,
  noteKeyFor,
  normalizeBoardFolder,
  normalizeNodeLinkDir,
  parentFolderOf,
  parseFrontmatter,
  parseSidecarName,
  planArchive,
  planArchiveAppend,
  planSidecarMigration,
  planSidecarPair,
  planWorkflowArchive,
  rankMainBoardPaths,
  readArchivedWorkflowIdentity,
  replaceAffiliationItem,
  resolveLinkedFiles,
  removeNode as removeNodeInDocument,
  sanitizeTitle,
  setBoardFolder,
  setFrontmatterField,
  setFrontmatterFieldList,
  setNodeCollapsed as setNodeCollapsedInDocument,
  setNodeLinkDir as setNodeLinkDirInDocument,
  sidecarPathFor,
  startTimerEntry,
  stopTimerEntry,
  toggleNodeNoteDone as toggleNodeNoteDoneInDocument,
  WFJSON_FOLDER,
  walkWorkflow,
  writeBackNote,
  type AddChildInput,
  type Affiliation,
  type AffiliationEntry,
  type AffiliationFieldValues,
  type AnalyzeResult,
  type ArchiveFileMeta,
  type ArchiveFormInput,
  type DocumentMutator,
  type ImportInspection,
  type ImportPlanResult,
  type ImportSkippedWorkflow,
  type Lang,
  type LinkedFile,
  type MoveNodeOptions,
  type MutationResult,
  type NodeAffiliationRef,
  type NodeInfoFieldKey,
  type NodeInfoPatch,
  type NodeNotePatch,
  type NodeStatus,
  type ReorderPosition,
  type ReverseIndex,
  type StatusChangeOptions,
  type StopTimerMode,
  type WfArchive,
  type WfJsonDocument,
  type WfNode,
  type WfNoteItem,
  type WfWorkflow,
  type WfWorkflowArchive,
  type WorkflowEditFieldKey,
  type WorkflowEditPlan,
  type WorkflowPatch,
  type WorkflowState,
} from "./src/engine/index.ts";
import {
  boardTitleOf,
  closeWidgetPopup,
  forgetViewScroll,
  isViewApi,
  rememberViewScroll,
  renderWorkflowView,
  stopTimerTicker,
  type AddChildNodeResult,
  type ArchiveInfoEditResult,
  type ArchiveNodeResult,
  type AttachToUnclassifiedOutcome,
  type DeleteNodeResult,
  type LinkDocsResult,
  type ModalEditOutcome,
  type NodeCollapseResult,
  type NodeInfoChangeResult,
  type NodeNoteChangeResult,
  type NodeStatusChangeOptions,
  type NodeStatusChangeResult,
  type ReorderResult,
  type TimerChangeResult,
  type WfThemeOption,
  type WfViewHost,
  type WfViewOptions,
  type WfPanelResultMap,
  type WfPanelTab,
  type WorkflowChangeResult,
} from "./views/wfView.ts";

/**
 * 插件设置（Phase 3 视图微调 v0.6；默认值 v0.7 起为 `36px`；Phase 6 增主题）。
 * 存 Obsidian 的 `data.json`（`loadData` / `saveData`）。
 */
interface WfJsonWorkflowSettings {
  /** 正计时器 `HH:MM:SS` 时钟的字号（CSS 长度，如 `36px` / `2.5em`）：写到根元素变量 `--wf-timer-font-size` */
  timerFontSize: string;
  /**
   * 卡片宽度（px，Phase 18 ⑦）：写到根元素变量 `--wf-card-width`。
   * 优先于所有主题 —— styles.css 里两处字面值（`body` 的 220 / magazine 的 240）已删，
   * 未设置时靠 `.wf-card` 上的 `var(--wf-card-width, 250px)` 回落。
   */
  cardWidth: number;
  /**
   * note 卡片最多显示**几条**（Phase 20：1-10，默认 3）。
   * 视图 `renderNoteCard` 按它 slice `note` 数组；超出的条目不画，但数据一条都不丢。
   */
  noteLines: number;
  /**
   * 引导性话语（Phase 18 ③）：渲染区最顶部的大标题。
   * 默认**空串** = 用 i18n 文案（中「下一步是？」/ 英「What's next?」）——
   * 存空串而不是存中文，语言一切换标题才会跟着变；用户填了就原样使用。
   */
  resumePrompt: string;
  /**
   * 看板文件目录（设置「全局」组，Phase 37）：侧车 JSON、主看板 md、归档、备份都放在这里。
   * 默认 `_workflowwatcher`。改动后由 `setBoardFolder()` 把引擎的路径函数切到新目录
   * （引擎里是模块级可变值，见 `types.ts` 的 `boardFolderOf()`）。
   */
  boardFolder: string;
  /**
   * 图表文件目录（**相对名**，Phase 19 M3；Phase 37 起不再含前缀）。
   * 实际落盘目录 = `plotRoot` 决定的前缀 + 本值，见 `effectivePlotFolder()`。
   * 第一次写入时才建目录（`onload` 不建）。
   */
  plotFolder: string;
  /** 图表文件根目录：`board` = 看板文件目录（默认），`vault` = 仓库根（Phase 37） */
  plotRoot: PlotRoot;
  /** 界面 / 校验提示语言（Phase 10 v0.8；缺省 `en`，见 i18n.ts） */
  lang: Lang;
}

/** 图表文件根目录：看板根（`<boardFolder>/<plotFolder>`）或仓库根（`<plotFolder>`） */
type PlotRoot = "board" | "vault";

/** 图表目录的默认相对名（Phase 37 起 `plotFolder` 只存这一段） */
const PLOT_FOLDER_NAME_DEFAULT = "plots";

/** 图表根目录校验：只有 `vault` 是另一个合法值，其余一律 `board` */
function normalizePlotRoot(value: unknown): PlotRoot {
  return value === "vault" ? "vault" : "board";
}

/** 图表目录相对名校验：去首尾空白 / 首尾 `/` / 重复斜杠；空串回落 `plots` */
function normalizeRelativeFolder(value: unknown): string {
  if (typeof value !== "string") return PLOT_FOLDER_NAME_DEFAULT;
  const trimmed = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
  return trimmed.length > 0 ? trimmed : PLOT_FOLDER_NAME_DEFAULT;
}

/**
 * 有效图表目录（真正落盘的 vault 相对路径）。
 *  - `plotRoot = "board"`（默认）→ `<boardFolder>/<plotFolder>`，即「看板文件目录/图表文件目录」；
 *  - `plotRoot = "vault"` → `<plotFolder>`，即「仓库根/图表文件目录」。
 *
 * 视图只认 `host.plotFolder()`，所以这段换算只发生在宿主层（`views/*` 一个字都不用改）。
 */
function effectivePlotFolder(settings: {
  boardFolder: string;
  plotFolder: string;
  plotRoot: PlotRoot;
}): string {
  const folder = normalizeRelativeFolder(settings.plotFolder);
  if (normalizePlotRoot(settings.plotRoot) === "vault") return folder;
  return `${normalizeBoardFolder(settings.boardFolder)}/${folder}`;
}

/**
 * 图表设置迁移（Phase 37）：老 `data.json` 只有 `plotFolder`（整条路径，默认 `_workflowwatcher/plots`），
 * 没有 `plotRoot`。这里把它拆成「相对名 + 根目录」：
 *  - 以 `<boardFolder>/` 开头 → 相对名 = 去掉前缀、根 = `board`（老默认值走这条）；
 *  - 含 `/` 且没有看板前缀 → 视为仓库根下的相对路径、根 = `vault`；
 *  - 不含 `/` → 相对名原样、根 = `board`（跟看板目录走）。
 *
 * 已经有 `plotRoot` 的新数据只做校验，不再拆（幂等）。
 */
function migratePlotSettings(
  stored: { boardFolder?: unknown; plotFolder?: unknown; plotRoot?: unknown } | null,
): { plotFolder: string; plotRoot: PlotRoot } {
  const raw = typeof stored?.plotFolder === "string" ? stored.plotFolder : "";
  if (stored?.plotRoot !== undefined) {
    return { plotFolder: normalizeRelativeFolder(raw), plotRoot: normalizePlotRoot(stored.plotRoot) };
  }
  const legacy = raw
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
  const prefix = `${normalizeBoardFolder(stored?.boardFolder)}/`;
  if (legacy.startsWith(prefix)) {
    return { plotFolder: normalizeRelativeFolder(legacy.slice(prefix.length)), plotRoot: "board" };
  }
  if (legacy.includes("/")) {
    return { plotFolder: normalizeRelativeFolder(legacy), plotRoot: "vault" };
  }
  return { plotFolder: normalizeRelativeFolder(legacy), plotRoot: "board" };
}

const DEFAULT_SETTINGS: WfJsonWorkflowSettings = {
  timerFontSize: "36px",
  // Phase 18 ⑦：默认 250px —— 与 `.wf-card` 的 var(--wf-card-width, 250px) 回落值一致
  cardWidth: 250,
  // Phase 20：note 卡片默认显示 3 条（1~10，设置面板可改）
  noteLines: 3,
  // Phase 18 ③：空串 = 走 i18n 文案（语言切换时标题跟着变）
  resumePrompt: "",
  // Phase 37：看板文件目录（侧车 / 主看板 / 归档 / 备份的根）
  boardFolder: WFJSON_FOLDER,
  // Phase 37：图表目录只存相对名，默认跟看板根走 → `_workflowwatcher/plots`（与 PLOT_FOLDER_DEFAULT 同源）
  plotFolder: PLOT_FOLDER_NAME_DEFAULT,
  plotRoot: "board",
  // Phase 10（v0.8）契约 §②：没配过语言的新用户先看到英文
  lang: "en",
};

/** 计时器字号变量名（styles.css 的 `.wf-timer-clock` 读它；CSS snippet 仍可覆盖） */
const TIMER_FONT_SIZE_VARIABLE = "--wf-timer-font-size";

/** Phase 18 ⑦：卡片宽度的变量名（styles.css 的 `.wf-card` 读它：`var(--wf-card-width, 250px)`） */
const CARD_WIDTH_VARIABLE = "--wf-card-width";

/** Phase 18 ⑦：卡片宽度的取值范围（px）；与 `normalizeCardWidth()` 同一对边界 */
const CARD_WIDTH_MIN = 150;
const CARD_WIDTH_MAX = 400;

/** 卡片宽度校验：非数字 / 越界 → 收进 150–400 并四舍五入 */
function normalizeCardWidth(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  // 空串 `Number("")` 是 0（会落进范围），必须单独挡掉 —— 输入框清空时回到默认值
  if (typeof value === "string" && value.trim().length === 0) return DEFAULT_SETTINGS.cardWidth;
  if (!Number.isFinite(parsed)) return DEFAULT_SETTINGS.cardWidth;
  return Math.min(CARD_WIDTH_MAX, Math.max(CARD_WIDTH_MIN, Math.round(parsed)));
}

/** Phase 20：note 卡片显示条数的取值范围；与 `normalizeNoteLines()` 同一对边界 */
const NOTE_LINES_MIN = 1;
const NOTE_LINES_MAX = 10;

/**
 * note 显示条数校验（与 `normalizeCardWidth` 同形）：空串 / 非数字 → 默认值；越界 → 收进 1-10 并四舍五入。
 *
 * 注意：设置项沿用存储键 `noteLines`（老 `data.json` 不用迁移），但**语义**已从
 * 「行数」改成「显示条数」——视图按它 slice `note` 数组，不再走 CSS 的 `line-clamp`。
 */
function normalizeNoteLines(value: unknown): number {
  // 空串 `Number("")` 是 0（会落进范围），必须单独挡掉 —— 输入框清空时回到默认值
  if (typeof value === "string" && value.trim().length === 0) return DEFAULT_SETTINGS.noteLines;
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SETTINGS.noteLines;
  return Math.min(NOTE_LINES_MAX, Math.max(NOTE_LINES_MIN, Math.round(parsed)));
}

/** 引导性话语最长字符数（防手改 `data.json` 塞进超长串把标题撑爆） */
const RESUME_PROMPT_MAX = 40;

/** 引导性话语校验：非字符串 / 空白 → 空串（= 用 i18n 文案）；超长截断 + 去首尾空白 */
function normalizeResumePrompt(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, RESUME_PROMPT_MAX);
}

/**
 * Phase 6 主题清单（契约见 doc/datacontact/data_ixd_discuss_interact_v0.5.md
 * 《Phase 6 定稿契约》）：`key` 与 styles.css 的 `[data-wf-theme="…"]` 一一对应。
 * 设置面板与视图里的切换入口共用这一份，避免两处清单漂移。
 *
 * Phase 44 曾删掉 `default`；**Phase 46 加回来了**（回滚原因）：
 *  - `template.ts` 建新看板时一直写 `wf-theme: default`（`DEFAULT_TEMPLATE_THEME`），
 *    清单里没有这个 key → 新看板全都成了「不挂属性」的素净基线，
 *    用户按 `[data-wf-theme="default"]` 写的自定义样式（例如 `--wf-polka-size`）一律命中不到；
 *  - 要让自定义 CSS 有稳定钩子，看板 / 浮层 / 弹窗就必须**始终**带 `data-wf-theme`。
 *
 * `default` 没有自己的样式桶（= body 的 token + 基础样式），见 styles.css S16 的分节注释。
 */
const WF_THEME_KEYS: readonly string[] = [
  "default",
  "tech",
  "nature",
  "magazine",
  "retro",
  "polka",
  // Phase 10（v0.8）：5 + 3
  "web",
  "fresh",
  "shoujo",
];

/**
 * 默认主题 key（Phase 46 恢复）：没写 `wf-theme` / 写了非法值时回落到它。
 * 视图侧 `wfView.ts` 的 `DEFAULT_THEME_KEY` 是同一个字面量（两处必须一致）。
 */
const DEFAULT_THEME_KEY = "default";

/**
 * 主题选项（`label` 走 i18n，切换语言后重新取即可）。
 * 模块加载时就调 `t()` 会把语言锁死在 import 时刻，所以这里做成函数而不是常量。
 */
function themeOptions(): WfThemeOption[] {
  return WF_THEME_KEYS.map((key) => ({ key, label: t(`theme.${key}`) }));
}

/**
 * 主题校验：不在清单里的 key → 空串（只给「不落盘」的护栏用，见 `setFileTheme`）。
 * 渲染侧别直接用它：空串要再回落到默认主题（`themeOrDefault`）。
 * 视图侧同一口径：`wfView.ts` 的 `resolveViewTheme()` 也回落 `default`。
 */
function normalizeTheme(theme: unknown): string {
  return typeof theme === "string" && WF_THEME_KEYS.includes(theme) ? theme : "";
}

/**
 * 弹窗 / 遮罩 / 右侧面板要挂的主题（Phase 46）：没传或非法 → 默认主题。
 * 这些外壳的皮肤全靠 `.wf-theme[data-wf-theme]` 命中，属性缺一帧就退回裸装基线。
 */
function themeOrDefault(theme: string | undefined): string {
  const next = normalizeTheme(theme);
  return next === "" ? DEFAULT_THEME_KEY : next;
}

/**
 * 命令的显示名（按当前语言现算）。
 *
 * 与 `themeOptions()` 同理：模块加载时就调 `t()` 会把语言锁死在 import 时刻，
 * 所以注册 / 切语言时都重新取一遍。
 *
 * Phase 25：主看板命令（打开主看板），ribbon 图标的 tooltip 复用同一个名字。
 * Phase 27（§5.7）：新增「给当前文件打标签」便捷命令（`cmd.tagFile`）。
 */
function commandNames(): { openMainBoard: string; tagFile: string } {
  return {
    openMainBoard: t("command.openMainBoard"),
    tagFile: t("cmd.tagFile"),
  };
}

/* ------------------------------------------------------------------ *
 * Phase 26：绝对路径解析（导入 / 导出）
 * ------------------------------------------------------------------ */

/** 库在磁盘上的根目录（桌面端有；移动端 `adapter.basePath` 不存在 → undefined） */
function vaultBasePath(app: App): string | undefined {
  const adapter = app.vault.adapter as unknown as { basePath?: unknown };
  const base = adapter.basePath;
  return typeof base === "string" && base.length > 0 ? base : undefined;
}

/** 去掉前缀（先精确、再忽略大小写；都不命中返回 undefined） */
function stripPrefix(target: string, prefix: string): string | undefined {
  if (target.startsWith(prefix)) return target.slice(prefix.length);
  if (target.toLowerCase().startsWith(prefix.toLowerCase())) return target.slice(prefix.length);
  return undefined;
}

/**
 * 库内相对路径 → 绝对路径。
 *
 * `basePath` 取不到（移动端）时**原样返回库内相对路径**：导出弹窗照样能复制，只是不是绝对路径
 * （弹窗里会多一行说明，见 §5.2 第 3 条）。
 */
function absoluteVaultPath(app: App, vaultPath: string): string {
  const relative = normalizeVaultPath(vaultPath);
  const base = vaultBasePath(app);
  if (base === undefined) return relative;
  const separator = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[\\/]+$/, "")}${separator}${relative.replace(/\//g, separator)}`;
}

/**
 * 绝对路径 → 库内相对路径（不在库里 / 取不到 `basePath` 时 undefined）。
 *
 * 只做前缀比较，不做 `realpath`：这个值只用来「先试试 vault 有没有这个文件」，
 * 试不到就退回 Node `fs`，两条路读出来的字节一样。
 */
function vaultRelativePath(app: App, absolutePath: string): string | undefined {
  const base = vaultBasePath(app);
  if (base === undefined) return undefined;
  const normalizedBase = base.replace(/[\\/]+$/, "").replace(/\\/g, "/");
  const normalizedTarget = absolutePath.replace(/\\/g, "/");
  const rest = stripPrefix(normalizedTarget, normalizedBase);
  if (rest === undefined || rest.length === 0) return undefined;
  return normalizeVaultPath(rest);
}

/** 异常 → 可展示的一句话（Notice / 弹窗里用） */
function errorMessageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/* ------------------------------------------------------------------ *
 * Phase 24：工作流看板（ItemView 宿主）
 * ------------------------------------------------------------------ */

/**
 * 看板视图类型（`registerView` 的 id；也用于 CSS 的
 * `.workspace-leaf-content[data-type="workflow-watcher-board"]`）。
 *
 * 一个 leaf = 一个看板 = 以前 md 渲染区里的那个面板：渲染器、写回链路、主题、计时、小工具栏
 * 全部复用 `renderWorkflowView`；这里只负责「宿主」（谁提供容器、绑定哪篇笔记、生命周期）。
 */
/**
 * 这个路径是不是纯 `wf.json` 数据文件（Phase 28：归档看板 = `archive/<wfId>-<nodeId>.wf.json`）。
 * 归档文件不再有 md 伴生，读写都按 JSON 走（`analyzeNoteText` / `mutateFile` 各有一条分支）。
 */
function isWfJsonPath(path: string): boolean {
  return path.toLowerCase().endsWith(".wf.json");
}

export const WF_BOARD_VIEW_TYPE = "workflow-watcher-board";

/**
 * 主看板的笔记名（Phase 25）：`main`。
 *
 * 为什么放在插件自己的文件夹里：md 与它的侧车 json 并排，用户**只看一个文件夹**就知道
 * 数据在哪；也避免和用户自己的笔记混在一起（自动创建的东西不该占用户的目录结构）。
 */
export const MAIN_BOARD_NAME = MAIN_BOARD_STEM;

/**
 * 主看板 md 的 vault 相对路径（唯一命令 / ribbon 图标都打开它）。
 *
 * 命名规则全在 `src/engine/mainBoard.ts`：`_workflowwatcher/main~<key>.md` —— 与它的侧车
 * `main~<key>.wf.json` **同名同键、只差扩展名**（一眼看出是一对；键也写进 JSON 的 `noteKey`
 * 与 frontmatter 的 `wf-key`）。这里只做转出，方便插件内部按老入口引用。
 */
export { MAIN_BOARD_PATH };

/**
 * 工作流看板（Phase 24；口径见 `doc/datacontact/phase24_bound.md`）。
 *
 * 为什么要有它（§0）：内嵌 dataviewjs 时外层滚动宿主是 Obsidian 自己的预览视图，
 * Dataview 每次重跑都先 `container.innerHTML = ""`，而「Obsidian 重渲染完成」没有可靠钩子 ——
 * 写回后外层跳位在当前架构下无解。ItemView 把 DOM 与调度都收回来：容器是我们自己的
 * `contentEl`，重渲染只有 `enqueueRender` 一路，两个失败模式同时消失。
 *
 * 口径：**一个 leaf 固定一个看板**（不跟随活动文件）。绑定关系放在 `getState()` 的 `{ file }` 里，
 * 由 `workspace.json` 落盘 → 重启 / 换布局后还原；路径是 **vault 相对路径**（换机器照样能用）。
 */
export class WfBoardView extends ItemView {
  private readonly plugin: WfJsonWorkflowPlugin;
  /** 本看板绑定的笔记（vault 相对路径；**绝不存绝对路径**） */
  private filePath: string;

  constructor(leaf: WorkspaceLeaf, plugin: WfJsonWorkflowPlugin, filePath: string) {
    super(leaf);
    this.plugin = plugin;
    this.filePath = filePath;
  }

  getViewType(): string {
    return WF_BOARD_VIEW_TYPE;
  }

  /**
   * 标签页标题 = 笔记名（`boardTitleOf` 只做字符串处理：这个方法会被频繁调用）。
   *
   * Phase 25：主看板显示成「工作流看板」而不是文件名 `main~<key>`（tab 上更好认）；
   * 老命名 `main.md` 也走同一分支（升级后标签页不会突然变成一串哈希）。
   */
  getDisplayText(): string {
    if (isMainBoardPath(this.filePath)) return t("view.board.title");
    return boardTitleOf(this.filePath);
  }

  getIcon(): string {
    return "layout-dashboard";
  }

  async onOpen(): Promise<void> {
    // ItemView 继承 Component：registerEvent 在 onClose 时自动反注册（换文件 / 关 leaf 都不会漏监听）
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        // 外部编辑（同步盘 / 终端）与插件自己的写回（笔记 + 侧车）都会触发；
        // 重入由 `renderWorkflowView` 内部的 enqueueRender（串行 + last-wins）兜住。
        if (this.isOwnPath(file.path)) void this.repaint();
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        if (oldPath !== this.filePath) return;
        // 本文件被改名 / 移动：看板跟着走（不重开 leaf；侧车由 main.ts 的既有钩子跟随）
        this.filePath = file.path;
        void this.repaint();
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        if (!this.isOwnPath(file.path)) return;
        // 绑定的笔记没了：清空绑定 → `strictFile` 下不回落活动文件，只显示提示
        this.filePath = "";
        void this.repaint();
      }),
    );
    await this.repaint();
  }

  /**
   * 工作区重启 / 换布局时还原「这个 leaf 在看哪篇笔记」。
   * state 只有 `{ file }`（与 `getState()` 对称）；还原后立刻重画。
   */
  async setState(state: unknown, result: ViewStateResult): Promise<void> {
    const next = (state as { file?: unknown } | null)?.file;
    if (typeof next === "string" && next.length > 0) this.filePath = next;
    await super.setState(state, result);
    await this.repaint();
  }

  getState(): Record<string, unknown> {
    return { file: this.filePath };
  }

  /**
   * 本看板绑定的笔记路径（vault 相对；空串 = 绑定被删）。
   *
   * Phase 27 §5.7：「给当前文件打标签」命令要先知道「用哪篇看板的工作流 / 节点」，
   * 于是从聚焦的看板 leaf 反查它的绑定文件 —— 插件自己不猜。
   */
  get boundPath(): string {
    return this.filePath;
  }

  /**
   * Phase 34：让**外部**（插件层）请求重画一次 —— 新建链接文档后 🔗 计数 / 实线边框
   * 要立刻跟上，但看板只监听「绑定笔记 / 它的侧车」的 modify，链接文档改了不会触发。
   */
  requestRepaint(): void {
    void this.repaint();
  }

  async onClose(): Promise<void> {
    // Phase 23 的滚动状态 / 渲染会话按路径常驻模块内存 → 关掉这个 leaf 就清掉自己那份
    forgetViewScroll(this.filePath);
    // Phase 24：只清**这个看板**的计时 tick 与弹窗（另一个看板的继续走）
    stopTimerTicker(this.filePath);
    closeWidgetPopup(this.filePath);
    this.contentEl.empty();
  }

  /** 本看板关心的文件：绑定的笔记，或它的侧车（扁平名 / 老镜像名都算） */
  private isOwnPath(path: string): boolean {
    if (this.filePath.length === 0) return false;
    return (
      path === this.filePath ||
      path === sidecarPathFor(this.filePath) ||
      path === legacySidecarPathFor(this.filePath)
    );
  }

  private async repaint(): Promise<void> {
    // `strictFile`：绑定路径解析不到 → 渲染「绑定笔记没了」提示，绝不显示别的笔记
    await renderWorkflowView(
      this.plugin,
      { app: this.app, container: this.contentEl, currentFilePath: this.filePath },
      { strictFile: true },
    );
  }
}

export default class WfJsonWorkflowPlugin extends Plugin implements WfViewHost {
  /** 插件设置（Phase 3 视图微调 v0.6）：`onload` 里从 `data.json` 读入 */
  settings: WfJsonWorkflowSettings = { ...DEFAULT_SETTINGS };

  /** 命令的注册句柄（Phase 20）：切换语言时就地改写 `name`，见 `refreshCommandNames()` */
  commands: Command[] = [];

  /** Phase 24：左侧 ribbon 的「打开主看板」图标（切语言时就地改写 `aria-label`） */
  private ribbonIcon: HTMLElement | null = null;

  /**
   * Phase 27 M3（契约 §5.6）：全库反向 YAML 资料归属索引（会话内存，不落盘）。
   *
   * 事件只**置脏**，查询（`linkedFiles`）时按需重建 —— 视图渲染是同步的，不能在这里发 Promise。
   */
  private reverseIndex: ReverseIndex = emptyReverseIndex();
  private reverseIndexDirty = true;

  /**
   * Phase 36：我们自己**刚写进去**的四键（`path` → frontmatter 记录）。
   *
   * `vault.process` 落盘后 `metadataCache` 要过一拍才刷新，而归档流程紧接着就要重画
   * **归档看板**（🔗 计数 / 实线边框都走 `linkedFiles` → 索引）——那一拍里重建索引读到的
   * 还是旧 frontmatter，卡片就会显示 0。这里把「写后的值」记下来，`rebuildReverseIndex()`
   * 优先用它；`metadataCache.changed` 为同一路径发一次通知（此时缓存已是新值）就删掉这条顶替。
   */
  private readonly writtenFrontmatter = new Map<string, Record<string, unknown>>();

  async onload(): Promise<void> {
    await this.loadSettings();
    // Phase 10（v0.8）：语言先落到引擎，后续命令 / 设置 / 视图文案都按它输出
    setLang(this.settings.lang);
    // Phase 37：看板文件目录也先落到引擎 —— 引擎的侧车 / 主看板 / 归档 / 备份路径都读它
    setBoardFolder(this.settings.boardFolder);
    this.applyTimerFontSize();
    // Phase 18 ⑦：卡片宽度也走根元素变量（设置优先于所有主题）
    this.applyCardWidth();
    this.addSettingTab(new WfJsonSettingTab(this.app, this));

    // Phase 25：老目录 `_wfjson/` 一次性改名成 `_workflowwatcher/`（只搬家，不解析内容）
    await this.migrateLegacyFolder();
    await this.reloadArchiveTags();

    this.registerCommands();

    // Phase 24：看板视图（一个 leaf = 一个看板）。
    // `registerView` 必须在**任何** `setViewState` 之前 —— 否则从 workspace.json 还原布局时找不到视图。
    // 初始路径给空串：真实路径由 `setState({ file })` 交给它（别拿活动文件占位，会先画错一篇再改）。
    this.registerView(WF_BOARD_VIEW_TYPE, (leaf) => new WfBoardView(leaf, this, ""));
    // Phase 25：左侧 ribbon 图标 = 与命令完全相同的入口（打开 / 就地创建主看板）
    this.ribbonIcon = this.addRibbonIcon("layout-dashboard", t("command.openMainBoard"), () => {
      void this.openMainBoard();
    });

    // v0.7 §⑧：笔记移动 / 改名 / 删除时，侧车（镜像路径）跟着走
    this.registerEvent(
      this.app.vault.on("rename", (abstract, oldPath) => {
        void this.syncSidecarOnRename(abstract, oldPath);
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (abstract) => {
        void this.syncSidecarOnDelete(abstract);
      }),
    );
    // Phase 25 备份：md + 侧车 json 每次创建 / 修改都镜像到 `_workflowwatcher/backup/`
    // （`isBackupPath` 在处理器里早退 —— 写副本自己也会发 create/modify，不拦住就死循环）；
    // 删除**不删副本**，所以上面那条 delete 钩子不用改。
    this.registerEvent(
      this.app.vault.on("create", (abstract) => {
        void this.syncBackupOnCreate(abstract);
      }),
    );
    this.registerEvent(
      this.app.vault.on("modify", (abstract) => {
        void this.syncBackupOnModify(abstract);
      }),
    );

    // Phase 27 M3（契约 §5.6）：反向索引的失效钩子 —— 一律只置脏，下次 `linkedFiles` 时重建。
    // frontmatter 改动只会触发 `metadataCache.changed`，已覆盖「手改 YAML」的主场景；
    // delete / rename 额外挂 vault 事件，文件消失时缓存条目不会残留。
    // Phase 36：同一批钩子顺带让 `writtenFrontmatter` 退场（那条记录只在「缓存还没跟上」时有用）。
    this.registerEvent(
      this.app.metadataCache.on("changed", (file) => {
        this.writtenFrontmatter.delete(file.path);
        this.markReverseIndexDirty();
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on("deleted", (file) => {
        this.writtenFrontmatter.delete(file.path);
        this.markReverseIndexDirty();
      }),
    );
    this.registerEvent(
      this.app.metadataCache.on("resolve", () => {
        this.markReverseIndexDirty();
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (file) => {
        this.writtenFrontmatter.delete(file.path);
        this.markReverseIndexDirty();
      }),
    );
    this.registerEvent(
      this.app.vault.on("rename", (file, oldPath) => {
        this.writtenFrontmatter.delete(oldPath);
        this.writtenFrontmatter.delete(file.path);
        this.markReverseIndexDirty();
      }),
    );
  }

  /**
   * 注册命令（Phase 25 单看板模型 + Phase 27 §5.7 打标签）。
   *
   * 命令名在 `addCommand` 那一刻定格（Obsidian 没有「改名」API），所以把注册句柄存下来：
   * 设置面板切语言时调 `refreshCommandNames()` 就地改写 `name`（ribbon 的 aria-label 一起改）。
   */
  private registerCommands(): void {
    const names = commandNames();

    this.commands = [
      // 文件夹没有就建、md / json 缺哪个补哪个、都在就直接开（见 `openMainBoard`）
      this.addCommand({
        id: "open-main-board",
        name: names.openMainBoard,
        callback: () => {
          void this.openMainBoard();
        },
      }),
      // Phase 27 §5.7：给「当前活动 md」写 `wf-workflow` / `wf-node`（+ 两个 id）四个键。
      // 不是迁移命令（口径 12）：只做正向打标签。
      this.addCommand({
        id: "tag-file-with-workflow-node",
        name: names.tagFile,
        callback: () => {
          void this.tagCurrentFile();
        },
      }),
    ];
  }

  /**
   * 按当前语言刷新命令名（以及 ribbon 图标的提示文字）。
   *
   * 命令面板与「快捷键」设置每次打开都现读 `command.name`，所以就地改字段即可，
   * 不需要重载插件；回调用的是 `this` 上的方法，改名不影响执行。
   */
  refreshCommandNames(): void {
    const names = commandNames();
    // ⚠️ 顺序必须与 `registerCommands()` 里 push 进 `this.commands` 的顺序**一一对应**
    const order = [names.openMainBoard, names.tagFile];
    this.commands.forEach((command, index) => {
      const name = order[index];
      if (name !== undefined) command.name = name;
    });
    // ribbon 也没有「改名」API：Obsidian 的 tooltip 读的是 aria-label，就地改写即可
    if (this.ribbonIcon !== null) this.ribbonIcon.setAttribute("aria-label", names.openMainBoard);
  }

  onunload(): void {
    // 清掉正计时器的 tick（Phase 3）：视图模块里的 interval 若不显式清掉会一直跑
    stopTimerTicker();
    // Phase 16：小工具弹窗挂在 document.body 上，禁用 / 卸载插件时一并清掉
    closeWidgetPopup();
    // Phase 25 M4：右侧面板也挂在 body 上（同一套理由）
    this.closeSidePanel();
  }

  /** 读设置（`data.json`）：缺项 / 类型不对一律回落默认值 */
  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as
      | (Partial<WfJsonWorkflowSettings> & { plotRoot?: unknown })
      | null;
    const timerFontSize = stored?.timerFontSize;
    const plot = migratePlotSettings(stored);
    this.settings = {
      timerFontSize:
        typeof timerFontSize === "string" && timerFontSize.trim().length > 0
          ? timerFontSize
          : DEFAULT_SETTINGS.timerFontSize,
      cardWidth: normalizeCardWidth(stored?.cardWidth),
      noteLines: normalizeNoteLines(stored?.noteLines),
      resumePrompt: normalizeResumePrompt(stored?.resumePrompt),
      boardFolder: normalizeBoardFolder(stored?.boardFolder),
      plotFolder: plot.plotFolder,
      plotRoot: plot.plotRoot,
      lang: normalizeLang(stored?.lang),
    };
  }

  /** 存设置（Obsidian 的 `saveData` 写 `data.json`） */
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * 把当前字号写进根元素 CSS 变量（`onload` 与设置面板变更时都调）。
   * 挂根元素而不是视图容器：dataviewjs 视图每次渲染都会重建 DOM，根元素上的变量对
   * 所有笔记 / 所有视图一次性生效；用户仍可用 CSS snippet 覆盖同一个变量。
   */
  applyTimerFontSize(): void {
    document.documentElement.style.setProperty(TIMER_FONT_SIZE_VARIABLE, this.settings.timerFontSize);
  }

  /**
   * 把卡片宽度写进根元素 CSS 变量（Phase 18 ⑦：`onload` 与设置面板变更时都调）。
   * 写根元素 = 所有视图一次性生效；styles.css 里已删掉两处字面值，
   * 因此这里的值（默认 250）是**唯一**权威，snippet 仍可覆盖同一变量。
   */
  applyCardWidth(): void {
    document.documentElement.style.setProperty(CARD_WIDTH_VARIABLE, `${this.settings.cardWidth}px`);
  }

  /**
   * Phase 20：note 卡片最多显示**几条**（视图 `renderNoteCard` 按它 slice `note` 数组）。
   *
   * 走宿主方法而不是 CSS 变量：截断单位从「行」变成「条」，`-webkit-line-clamp`
   * 只能按行裁，条目数只能由 JS 决定。设置面板改完存盘即可，视图下次渲染/局部刷新时读新值。
   */
  noteLines(): number {
    return this.settings.noteLines;
  }

  /**
   * Phase 18 ③：渲染区顶部的引导性话语（视图读这个，不 import 插件设置）。
   * 空串 = 让视图回落到 i18n 的「下一步是？」。
   */
  resumePrompt(): string {
    return this.settings.resumePrompt;
  }

  /** Phase 19 M3：365 天 plot 的目录（视图拼 `plotFolder/plot-<uuid>.json`，导出 CSV 同目录） */
  plotFolder(): string {
    // Phase 37：「图表文件根目录」决定前缀（看板根 / 仓库根）；视图只认这个最终路径
    return effectivePlotFolder(this.settings);
  }

  /* ---------------------------------------------------------------- *
   * Phase 6 主题 + Phase 9 主题跟随文件：
   *   - 主题**完全跟随文件**：容器自己挂 `data-wf-theme`（每文件独立），插件不改 `<html>`；
   *   - 没写 `wf-theme` / 没传 `options.theme` → **默认主题**（`default`，Phase 46 恢复）：
   *     它没有自己的样式桶，就是基础样式；挂属性只为让 `[data-wf-theme]` 这类自定义钩子能命中；
   *     （测试替身 / 旧宿主的 `themes` 里没有 `default` 时，视图才回落「不挂属性」的素净基线）
   *   - 「状态总览」末尾的切换按钮只写本文件 frontmatter `wf-theme`。
   * ---------------------------------------------------------------- */

  /**
   * 主题清单（视图切换入口用）。`label` 按当前语言实时取，
   * 所以切换语言后重渲染视图就能看到新文案。
   */
  get themes(): readonly WfThemeOption[] {
    return themeOptions();
  }

  /**
   * 视图切换入口：只写该文件 frontmatter 的 `wf-theme`（Phase 9：主题跟随文件）。
   * 只写本文件，因此不会污染其他笔记。
   *
   * v0.7 §⑨-7：走 `vault.process` + 引擎的**逐行** upsert，不用
   * `fileManager.processFrontMatter`（后者用严格 YAML 解析整块 frontmatter，
   * 遇到用户笔记里既有的非严格写法会抛错，把主题这种单键写入一起拖垮）。
   */
  async setFileTheme(file: TFile, theme: string): Promise<void> {
    // D 案：写盘前抢一份滚动位置（Dataview 收到文件变化后会先 `innerHTML = ""` 抹掉视图）
    rememberViewScroll(file);
    const next = normalizeTheme(theme);
    // 非法 / 空 key 不落盘 —— 写 `wf-theme: ""` 只会污染 frontmatter。
    // （切换按钮只来自 `themes` 清单，正常路径走不到这里；这条只是护栏。）
    // Phase 46：`default` 重新是合法 key → 用户点「默认」会写回 `wf-theme: default`。
    if (next === "") return;
    await this.app.vault.process(file, (text) =>
      setFrontmatterField(text, FRONTMATTER_FIELDS.theme, next),
    );
  }

  /**
   * 分析任意看板文件（只读；供视图与写回链路复用）：
   *  - `.md` 笔记：侧车优先，没有侧车就解析正文里的 wfjson 块；
   *  - `.wf.json`（Phase 28 归档看板）：文件本身就是数据。
   */
  async analyzeFile(file: TFile): Promise<AnalyzeResult> {
    const markdown = await this.app.vault.read(file);
    return this.analyzeNoteText(file, markdown);
  }

  /**
   * 分析「已经读到的笔记文本」（避免二次读盘；归档要复制正文时用）。
   * 侧车存在 → 外置 JSON 为准；否则退回笔记内代码块（旧文件完全兼容）。
   */
  private async analyzeNoteText(file: TFile, noteMarkdown: string): Promise<AnalyzeResult> {
    // Phase 28：`.wf.json`（归档看板）本身就是数据文件 —— 不找侧车、不当 md 解析
    if (isWfJsonPath(file.path)) {
      return analyzeDocument({
        noteMarkdown: "",
        jsonText: noteMarkdown,
        jsonSource: "sidecar",
        jsonFile: file.path,
        file: file.path,
        checkFrontmatter: false,
      });
    }
    const sidecar = this.findSidecarFile(file);
    if (sidecar === undefined) return analyzeMarkdown(noteMarkdown, { file: file.path });
    return analyzeDocument({
      noteMarkdown,
      jsonText: await this.app.vault.read(sidecar),
      jsonSource: "sidecar",
      jsonFile: sidecar.path,
      file: file.path,
    });
  }

  /**
   * 笔记对应的侧车文件（`_workflowwatcher/<笔记名>~<key>.wf.json`；不存在返回 undefined）。
   *
   * M1.6：先找扁平名，找不到再退回老的镜像路径（`_workflowwatcher/A/B/笔记.wf.json`）——
   * 升级插件后老侧车照样读得到。
   * Phase 25：主看板的 md **就躺在** `_workflowwatcher/` 里，所以这里不能再按「路径在侧车目录里」
   * 早退，只看扩展名（给非 md 找侧车没有意义）；同名目录 / 其它类型一律当作「没有侧车」。
   */
  private findSidecarFile(file: TFile): TFile | undefined {
    if (file.extension.toLowerCase() !== "md") return undefined;
    const flat = this.app.vault.getAbstractFileByPath(sidecarPathFor(file.path));
    if (flat instanceof TFile) return flat;
    const legacy = this.app.vault.getAbstractFileByPath(legacySidecarPathFor(file.path));
    return legacy instanceof TFile ? legacy : undefined;
  }

  /**
   * 通用变更编排（唯一写盘入口）。
   *
   * 笔记模式（没有侧车）：用 `vault.process(file, fn)` 把「读 → 改 → 写」放进同一事务，
   * 真正的判断逻辑（拒绝坏数据、版本升格、三段写回、写回后幂等校验）都在引擎的 `applyMutation`。
   *
   * 侧车模式（v0.7 §⑧）：先 `vault.process` 侧车（`applySidecarMutation`），再 `vault.process`
   * 笔记（`writeBackNote`：frontmatter + 纪要段）。两步都幂等，中断后重试即可收敛。
   *
   * `now` 可选：传入后引擎的 `document.updatedAt` 与节点 `updatedAt` 用同一个时间戳
   * （Phase 2 的编辑函数需要自己维护节点时间，见 nodeEdits.ts）。
   */
  async mutateFile(file: TFile, mutator: DocumentMutator, now?: Date): Promise<MutationResult> {
    // D 案：写盘前抢一份滚动位置（Dataview 收到文件变化后会先 `innerHTML = ""` 抹掉视图）
    rememberViewScroll(file);
    // Phase 28：`.wf.json` 数据文件（归档看板）直接改 JSON，没有笔记要同步
    if (isWfJsonPath(file.path)) return this.mutateJsonFile(file, mutator, now);
    const sidecar = this.findSidecarFile(file);
    if (sidecar === undefined) return this.mutateNoteFile(file, mutator, now);
    return this.mutateSidecarFile(file, sidecar, mutator, now);
  }

  /**
   * `.wf.json` 数据文件写回（Phase 28）：JSON 就是文件本身，没有笔记 / 侧车两步。
   *
   * 复用 `applySidecarMutation("", jsonText, …)` —— 空笔记 + JSON 的组合正好等价于「只有数据」，
   * 校验（写回后再 `analyzeDocument`）与拒绝语义完全一致；生成的 `markdown` 不落盘。
   */
  private async mutateJsonFile(
    file: TFile,
    mutator: DocumentMutator,
    now?: Date,
  ): Promise<MutationResult> {
    const base = now ?? new Date();
    const holder: { mutation?: MutationResult } = {};
    await this.app.vault.process(file, (jsonText) => {
      const mutation = applySidecarMutation("", jsonText, mutator, {
        file: file.path,
        jsonFile: file.path,
        now: base,
      });
      holder.mutation = mutation;
      return mutation.jsonText ?? jsonText;
    });

    const mutation = holder.mutation;
    if (mutation === undefined) throw new Error(t("reject.processSkipped"));
    return mutation;
  }

  /** 笔记模式写回（JSON 与正文在同一个 md 里） */
  private async mutateNoteFile(file: TFile, mutator: DocumentMutator, now?: Date): Promise<MutationResult> {
    const holder: { mutation?: MutationResult } = {};
    await this.app.vault.process(file, (text) => {
      const mutation = applyMutation(text, mutator, now !== undefined ? { file: file.path, now } : { file: file.path });
      holder.mutation = mutation;
      return mutation.markdown;
    });

    const mutation = holder.mutation;
    if (mutation === undefined) {
      // 防御：`vault.process` 没执行回调时宁可报错，也不假装写成功
      throw new Error(t("reject.processSkipped"));
    }
    return mutation;
  }

  /**
   * 侧车模式写回：外置 JSON 先落盘，再重写笔记里与 JSON 无关的部分。
   *
   * 失败语义：引擎拒绝 / 写回校验失败时 `mutation.success=false`，此时**两个文件都不写**
   * （`vault.process` 回写原文，内容逐字节不变）。
   */
  private async mutateSidecarFile(
    file: TFile,
    sidecar: TFile,
    mutator: DocumentMutator,
    now?: Date,
  ): Promise<MutationResult> {
    const base = now ?? new Date();
    const noteBefore = await this.app.vault.read(file);
    const holder: { mutation?: MutationResult } = {};
    await this.app.vault.process(sidecar, (jsonText) => {
      const mutation = applySidecarMutation(noteBefore, jsonText, mutator, {
        file: file.path,
        jsonFile: sidecar.path,
        now: base,
      });
      holder.mutation = mutation;
      return mutation.jsonText ?? jsonText;
    });

    const mutation = holder.mutation;
    if (mutation === undefined) {
      throw new Error(t("reject.processSkipped"));
    }
    if (!mutation.success || !mutation.changed || mutation.document === undefined) return mutation;

    // 用同一份（已改好的）文档重写笔记：JSON 在侧车里，笔记里只留 frontmatter + 纪要段。
    // 重新读一次最新正文（而不是直接写 planning 时的结果），避免覆盖期间的用户编辑。
    const document = mutation.document;
    const markdown = await this.app.vault.process(file, (text) => {
      // 常态：正文与侧车事务开始前一致 → 直接用引擎算好的结果（含「删除节点的纪要段」与超链接合并）
      if (text === noteBefore) return mutation.markdown;
      // 期间用户改过正文：在最新正文上重写，宁可少删一个段落也不覆盖用户新内容
      return writeBackNote(text, document, { now: base, removedNoteAnchors: mutation.removedAnchors }).markdown;
    });
    // Phase 23 A 案：视图会直接吃 `analysis`（不再重读盘），所以它必须对应**最终**正文。
    // 常态（text === noteBefore）下 engine 的分析就是最终正文的分析；只有上面那条
    // 「期间用户改过正文」的罕见分支才会偏，这时宁可多读一次盘也要把分析校正回来。
    if (markdown === mutation.markdown) return { ...mutation, markdown };
    return { ...mutation, markdown, analysis: await this.analyzeNoteText(file, markdown) };
  }

  /**
   * Phase 1 的改状态方法（视图右键「标记为…」调用）：
   *  - 节点不存在 → 结构化拒绝（不写盘）；
   *  - 状态本来就一样 → `changed=false`（不写盘）；
   *  - 其余情况走 `mutateFile`：落盘升格 1.0→1.1、写 status/history/progress/completedAt、
   *    刷新 frontmatter 摘要，并返回写回后的校验问题（供视图提示）。
   */
  async setNodeStatus(
    file: TFile,
    nodeId: string,
    status: NodeStatus,
    options: NodeStatusChangeOptions = {},
  ): Promise<NodeStatusChangeResult> {
    const mutation = await this.mutateFile(file, (document) => {
      const node = findNode(document, nodeId);
      if (!node) return { reject: t("reject.nodeMissing", { id: nodeId }) };
      if (node.status === status) return { changed: false };
      const change: StatusChangeOptions = {};
      if (options.note !== undefined) change.note = options.note;
      if (options.by !== undefined) change.by = options.by;
      applyStatusChange(node, status, change);
      return { changedNodeIds: [nodeId] };
    });

    const result: NodeStatusChangeResult = {
      success: mutation.success,
      file: file.path,
      nodeId,
      status,
      changed: mutation.changed,
      issues: mutation.analysis.issues,
    };
    // A 案：把引擎算好的「写回后分析」一并交回视图（视图不再二次读盘 + 二次校验）
    result.analysis = mutation.analysis;
    if (mutation.reason !== undefined) result.reason = mutation.reason;
    return result;
  }

  /* ---------------------------------------------------------------- *
   * Phase 2 低层变更方法（契约 §4；视图的 Modal 入口最终都落到这三个）
   * 三者都走 mutateFile → applyMutation：安全闸门 → 1.0→1.1 升格 →
   * 三段写回 → 幂等校验；`now` 显式传入，保证 document.updatedAt 与节点 updatedAt 一致。
   * ---------------------------------------------------------------- */

  /**
   * 契约 §4.2：在 `parentId` 的 children 末尾追加新节点。
   * 默认值由引擎的 `appendChildNode` 负责（status=todo、progress=0、progress_max=1、startAt=now、id/noteAnchor 自动生成）；
   * 写回时 `writeBackDocument` 会自动补出 `### {title} ^{childId}` 纪要段落。
   * 标题被清洗（含 # / | / [ / ] 等）时通过 `warnings` 回传，由视图转成 Notice。
   */
  async addChildNode(file: TFile, parentId: string, input: AddChildInput): Promise<AddChildNodeResult> {
    const now = new Date();
    const holder: { childId?: string; warnings: string[] } = { warnings: [] };
    const mutation = await this.mutateFile(
      file,
      (document) => {
        const edit = appendChildNodeInDocument(document, parentId, input, now);
        holder.warnings = edit.warnings;
        if (!edit.ok) return { reject: edit.reason ?? t("reject.addChildFailed", { id: parentId }) };
        if (edit.childId !== undefined) holder.childId = edit.childId;
        return { changedNodeIds: edit.changedNodeIds };
      },
      now,
    );

    const result: AddChildNodeResult = {
      success: mutation.success,
      file: file.path,
      nodeId: parentId,
      changed: mutation.changed,
      issues: mutation.analysis.issues,
      changedNodeIds: mutation.changedNodeIds,
    };
    // A 案：写回后的最新分析一并交回（视图局部刷新直接复用）
    result.analysis = mutation.analysis;
    if (mutation.reason !== undefined) result.reason = mutation.reason;
    if (holder.childId !== undefined) result.childId = holder.childId;
    if (holder.warnings.length > 0) result.warnings = holder.warnings;
    return result;
  }

  /**
   * 契约 §4.3：删除本节点（timeEntries/relations 摊平进父节点、children 原位上移、
   * 旧纪要段落按 `removedNoteAnchors` 整段清掉）。
   * 根节点与带 `archive`（1.3）的节点由引擎拒绝——视图侧已置灰，这里只是防御性兜底。
   *
   * Phase 27：删除弹窗不再二选一「合并 / 丢弃链接」（纪要段范式已弃用），
   * 所以这里也不再收 `mergeLinks`（引擎的 `mergeNoteSections` 恒为空）。
   */
  async deleteNode(file: TFile, nodeId: string): Promise<DeleteNodeResult> {
    const now = new Date();
    const holder: { parentId?: string } = {};
    const mutation = await this.mutateFile(
      file,
      (document) => {
        const edit = removeNodeInDocument(document, nodeId, now);
        if (!edit.ok) return { reject: edit.reason ?? t("reject.deleteFailed", { id: nodeId }) };
        if (edit.parentId !== undefined) holder.parentId = edit.parentId;
        return {
          changedNodeIds: edit.changedNodeIds,
          removedNoteAnchors: edit.removedNoteAnchors,
          mergeNoteSections: edit.mergeNoteSections,
        };
      },
      now,
    );

    const result: DeleteNodeResult = {
      success: mutation.success,
      file: file.path,
      nodeId,
      changed: mutation.changed,
      issues: mutation.analysis.issues,
      changedNodeIds: mutation.changedNodeIds,
    };
    result.analysis = mutation.analysis;
    if (mutation.reason !== undefined) result.reason = mutation.reason;
    if (holder.parentId !== undefined) result.parentId = holder.parentId;
    return result;
  }

  /* ---------------------------------------------------------------- *
   * Phase 27 M2：「未分类」钉死列的两个入口（契约 §5.4 / §5.5）
   *
   * 未分类不是新数据结构：它就是一条普通 `WfWorkflow`，`id` 取保留值
   * `UNCLASSIFIED_WORKFLOW_ID`，`root` 只当容器（视图不渲染它）。
   * 所以这里也**不造新表单** —— 新建复用「加子节点」面板，搬入复用 `moveNode` 的写回套路。
   * ---------------------------------------------------------------- */

  /**
   * 未分类列「＋ 新建节点」：先把容器懒建出来（幂等，已有就一个字不写），
   * 再对隐藏 `root` 打开现成的「添加子节点」面板（`appendChildNode` → `addChildNode`）。
   *
   * 读不到代码块 / 写盘被拒 → `{ cancelled: true }`（视图不提示、不刷新，提示已发过）。
   *
   * `theme` 必须跟着一起传给 `openNodePanel`：这条入口与「节点右键 → 面板」共用同一张
   * `WfSidePanel`，外壳皮肤全靠遮罩上的 `.wf-theme[data-wf-theme]` 命中；漏传就只剩
   * 默认主题（深色波点那套深酒红外壳 / 主题化 tab 都不会出现），两处弹窗观感不一致。
   */
  async openUnclassifiedChildPanel(
    file: TFile,
    theme?: string,
  ): Promise<ModalEditOutcome<AddChildNodeResult>> {
    const root = await this.ensureUnclassifiedRoot(file);
    if (root === undefined) return { cancelled: true };
    return this.openNodePanel(file, root, "child", undefined, theme);
  }

  /**
   * 列头落点：把节点**整棵子树**搬到未分类当顶层节点（契约 §5.5）。
   *
   * `unchanged = true` = 它本来就是未分类顶层节点 —— 引擎不写盘、`changed = false`，
   * 视图据此既不重渲染也不提示。
   */
  async attachNodeToUnclassified(file: TFile, nodeId: string): Promise<AttachToUnclassifiedOutcome> {
    const now = new Date();
    const holder: { unchanged: boolean } = { unchanged: false };
    const mutation = await this.mutateFile(
      file,
      (document) => {
        const edit = attachNodeToUnclassifiedInDocument(document, nodeId, now);
        if (!edit.ok) return { reject: edit.reason ?? t("view.notify.unknownReason") };
        if (edit.unchanged === true) {
          holder.unchanged = true;
          return { changed: false, changedNodeIds: [] };
        }
        return { changedNodeIds: edit.changedNodeIds };
      },
      now,
    );

    const result: AttachToUnclassifiedOutcome = {
      ok: mutation.success,
      changedNodeIds: mutation.changedNodeIds,
      analysis: mutation.analysis,
    };
    if (mutation.reason !== undefined) result.reason = mutation.reason;
    if (holder.unchanged) result.unchanged = true;
    return result;
  }

  /**
   * 拿到「未分类」伪工作流的容器根节点；没有就先写一次（懒创建）。
   *
   * 写盘走同一条 `mutateFile` 链路（安全闸门 → 三段写回 → 幂等校验）；
   * 读不到文档 / 被引擎拒绝 → `undefined`（这里已提示，调用方按「取消」处理）。
   */
  private async ensureUnclassifiedRoot(file: TFile): Promise<WfNode | undefined> {
    const analysis = await this.analyzeFile(file);
    const document = analysis.latestDocument ?? analysis.document;
    if (!analysis.found || document === undefined) {
      this.notify(t("reject.noBlock"));
      return undefined;
    }
    const existing = findWorkflow(document, UNCLASSIFIED_WORKFLOW_ID);
    if (existing !== undefined) return existing.root;

    const now = new Date();
    const holder: { root?: WfNode } = {};
    const mutation = await this.mutateFile(
      file,
      (doc) => {
        const workflow = ensureUnclassifiedWorkflow(doc, now);
        holder.root = workflow.root;
        return { changedNodeIds: [workflow.root.id] };
      },
      now,
    );
    if (!mutation.success) {
      if (mutation.reason !== undefined) this.notify(mutation.reason);
      return undefined;
    }
    return holder.root;
  }

  /* ---------------------------------------------------------------- *
   * Phase 27 M3：反向 YAML 资料归属（契约 §5.6）
   *
   * 视图渲染是同步的（`renderCard` 要立刻知道「有没有资料」「几条」），所以索引放插件内存：
   * 事件只置脏，查询时按需重建一次全库扫描。视图既不读 `metadataCache` 也不扫库。
   * ---------------------------------------------------------------- */

  /** 该节点的资料文件（id 精确优先，`workflowTitle::nodeTitle` 兜底；见引擎 `resolveLinkedFiles`） */
  linkedFiles(ref: NodeAffiliationRef): LinkedFile[] {
    return resolveLinkedFiles(this.reverseIndexOf(), ref);
  }

  /**
   * 打开一份资料文件（契约口径 10：本期只覆盖 md）。
   *
   * `.md` → **新建标签页**（Phase 34 需求「新建页面打开超链接」；`getLeaf("tab")`）；
   * 其它扩展名或文件已不在了 → 只提示，不抛错。
   */
  openLinkedFile(path: string): void {
    const target = this.app.vault.getAbstractFileByPath(path);
    if (!(target instanceof TFile) || target.extension.toLowerCase() !== "md") {
      this.notify(t("view.link.unsupported"));
      return;
    }
    void this.app.workspace.getLeaf("tab").openFile(target);
  }

  /**
   * Phase 34：找出节点所属的工作流（改名同步要知道 `wf-workflow` 该写什么）。
   * 节点不存在 / 不属于任何流 → `undefined`。
   */
  private workflowOfNode(document: WfJsonDocument, nodeId: string): WfWorkflow | undefined {
    for (const workflow of document.workflows ?? []) {
      if (walkWorkflow(workflow).some((visit) => visit.node.id === nodeId)) return workflow;
    }
    return undefined;
  }

  /**
   * Phase 34：让「绑定本笔记」的看板重画一次（新建链接文档后 🔗 计数 / 实线边框立刻跟上）。
   * 找不到看板（笔记只在源码页里用）就什么都不做。
   *
   * Phase 36：归档流程也用它 —— 归档看板绑定的是**归档文件**，而 `syncArchivedNodes()` /
   * `syncArchivedWorkflow()` 改的是**链接文档**的 frontmatter（看板不监听这些文件），
   * 不同步请它重画，卡片上的 🔗 计数就会停在归档那一刻的 0。
   */
  private refreshBoardsFor(path: string): void {
    for (const leaf of this.app.workspace.getLeavesOfType(WF_BOARD_VIEW_TYPE)) {
      const view = leaf.view;
      if (view instanceof WfBoardView && view.boundPath === path) view.requestRepaint();
    }
  }

  /* ---------------------------------------------------------------- *
   * Phase 34：链接文档的创建 + 改名 / 归档同步（契约 phase34_bound.md §3）
   *
   * 归属写在资料文件自己的 frontmatter 上，所以「改名」必须把旧值推成新值：
   *  - 匹配一律用「id ∪ 旧标题」的并集（`collectAffiliatedFiles` / `collectWorkflowFiles`），
   *    只写 id 或只写标题的文件都能被找出来；
   *  - 只改**人读标题**两列（`wf-workflow` / `wf-node`）；两个 id 列不动（决策 ④：旧 id 仍指原文件）；
   *  - 全部 best-effort：逐个文件 `vault.process`，失败只提示、不回滚（主数据已落盘）。
   * ---------------------------------------------------------------- */

  /** 把一批字段改动写进各资料文件的 frontmatter（逐文件 best-effort） */
  private async patchAffiliationFiles(targets: ReadonlyMap<string, AffiliationPatch>): Promise<void> {
    let synced = 0;
    for (const [path, patch] of targets) {
      const target = this.app.vault.getAbstractFileByPath(path);
      if (!(target instanceof TFile)) continue;
      try {
        await this.app.vault.process(target, (text) => {
          let next = text;
          next = applyAffiliationPatch(next, FRONTMATTER_FIELDS.linkWorkflow, FRONTMATTER_FIELDS.linkWorkflowId, patch.workflowTitle);
          next = applyAffiliationPatch(next, FRONTMATTER_FIELDS.linkNode, FRONTMATTER_FIELDS.linkNodeId, patch.nodeTitle);
          // Phase 36：写后的四键记一份 —— 紧接着的重画（归档看板 / 源看板）要立刻看到新值
          if (next !== text) this.rememberWrittenAffiliations(target.path, next);
          return next;
        });
        synced += 1;
      } catch (error) {
        this.notify(t("view.linkDocs.syncFailed", { path, reason: errorMessageOf(error) }));
      }
    }
    if (synced === 0) return;
    this.markReverseIndexDirty();
    this.notify(t("view.linkDocs.synced", { count: synced }));
  }

  /** 节点改名：把 `wf-node` 推到「按 id 命中 ∪ 按旧标题命中」的全部资料文件 */
  private async syncNodeRename(rename: NodeRenameSync): Promise<void> {
    const files = collectAffiliatedFiles(this.reverseIndexOf(), {
      workflowTitle: rename.workflowTitle,
      nodeTitle: rename.oldNodeTitle,
      workflowId: rename.workflowId,
      nodeId: rename.nodeId,
    });
    if (files.length === 0) return;
    const targets = new Map<string, AffiliationPatch>();
    for (const file of files) {
      targets.set(file.path, {
        nodeTitle: { value: rename.newNodeTitle, matchId: rename.nodeId, matchTitle: rename.oldNodeTitle },
      });
    }
    await this.patchAffiliationFiles(targets);
  }

  /**
   * 工作流改名：`wf-workflow` 推到「按 id ∪ 按旧标题」命中的文件；
   * 根节点标题跟着 `workflow.title` 走，所以根节点的 `wf-node` 也一起推（同一个文件只写一次）。
   */
  private async syncWorkflowRename(rename: WorkflowRenameSync): Promise<void> {
    const index = this.reverseIndexOf();
    const targets = new Map<string, AffiliationPatch>();

    for (const file of collectWorkflowFiles(index, { workflowTitle: rename.oldTitle, workflowId: rename.workflowId })) {
      targets.set(file.path, {
        workflowTitle: { value: rename.newTitle, matchId: rename.workflowId, matchTitle: rename.oldTitle },
      });
    }
    for (const file of collectAffiliatedFiles(index, {
      workflowTitle: rename.oldTitle,
      nodeTitle: rename.oldTitle,
      workflowId: rename.workflowId,
      nodeId: rename.rootNodeId,
    })) {
      targets.set(file.path, {
        ...(targets.get(file.path) ?? {}),
        nodeTitle: { value: rename.newTitle, matchId: rename.rootNodeId, matchTitle: rename.oldTitle },
      });
    }
    await this.patchAffiliationFiles(targets);
  }

  /**
   * 整条工作流归档：资料文件的 `wf-workflow` 改成归档文件 里的标题（`原标题（已归档）`）。
   * `wf-workflow-id` **不动**（决策 ④：旧 id 仍指向原文件里的浓缩节点）。
   */
  private async syncArchivedWorkflow(oldTitle: string, workflowId: string): Promise<void> {
    const files = collectWorkflowFiles(this.reverseIndexOf(), { workflowTitle: oldTitle, workflowId });
    if (files.length === 0) return;
    const archivedTitle = `${oldTitle}${ARCHIVE_TITLE_SUFFIX}`;
    const targets = new Map<string, AffiliationPatch>();
    for (const file of files) {
      targets.set(file.path, {
        workflowTitle: { value: archivedTitle, matchId: workflowId, matchTitle: oldTitle },
      });
    }
    await this.patchAffiliationFiles(targets);
  }

  /**
   * 节点级归档：被归档子树（浓缩节点 + 全部后代）的链接文档 `wf-workflow` 改成归档文件 里的
   * 标题（`浓缩节点标题（已归档）`）；`wf-workflow-id` / `wf-node` **不动**。
   *
   * 文件集合由 `collectSubtreeFiles` 给出（口径与改名同步一致：id 命中 ∪ `工作流标题::节点标题`
   * 兜底），只是「哪些节点算被归档」换成整棵子树 —— 整条流归档仍走 `syncArchivedWorkflow`。
   */
  private async syncArchivedNodes(workflow: WfWorkflow, root: WfNode, archivedTitle: string): Promise<void> {
    const files = collectSubtreeFiles(this.reverseIndexOf(), workflow, root);
    if (files.length === 0) return;
    const targets = new Map<string, AffiliationPatch>();
    for (const file of files) {
      targets.set(file.path, {
        workflowTitle: { value: archivedTitle, matchId: workflow.id, matchTitle: workflow.title },
      });
    }
    await this.patchAffiliationFiles(targets);
  }

  /**
   * Phase 34：新建一份链接文档（面板 tab 6 的「新建链接文档」）。
   *
   * 顺序：先写 `linkDir`（有变化时才写）→ 建目录 → 建文件（四键 frontmatter + 一级标题）。
   * 文件名清洗后用 `文件名-2.md` / `-3` 避让重名；四键与插件语言无关（`FRONTMATTER_FIELDS`）。
   */
  async createLinkDoc(
    file: TFile,
    node: WfNode,
    workflow: WfWorkflow | undefined,
    input: { name: string; linkDir: string },
  ): Promise<LinkDocsResult> {
    const nodeId = node.id;
    const failed = (reason: string): LinkDocsResult => ({
      success: false,
      nodeId,
      changed: false,
      reason,
      issues: [],
      changedNodeIds: [],
      createdPaths: [],
      linkDirChanged: false,
    });

    if (workflow === undefined) return failed(t("view.linkDocs.noWorkflow"));

    const sanitized = sanitizeTitle(input.name);
    if (!sanitized.ok) return failed(sanitized.reason ?? t("error.invalidTitle"));
    const name = safeLinkDocName(sanitized.title);
    if (name.length === 0) return failed(t("view.linkDocs.invalidName"));

    const linkDir = normalizeNodeLinkDir(input.linkDir);
    if (linkDir === undefined) return failed(t("view.linkDocs.invalidDir"));

    const now = new Date();
    let linkDirChanged = false;
    let changedNodeIds: string[] = [];
    let issues: LinkDocsResult["issues"] = [];
    let analysis: AnalyzeResult | undefined;

    // 1) 目录有变化 → 先写回节点（写失败就什么都不建，避免「文件建了、默认值没记住」）
    if ((node.linkDir ?? "") !== linkDir) {
      const mutation = await this.mutateFile(
        file,
        (document) => {
          const edit = setNodeLinkDirInDocument(document, nodeId, linkDir, now);
          if (!edit.ok) return { reject: edit.reason ?? t("reject.editFailed", { id: nodeId }) };
          if (edit.unchanged === true) return { changed: false };
          return { changedNodeIds: edit.changedNodeIds };
        },
        now,
      );
      if (!mutation.success) return failed(mutation.reason ?? t("reject.editFailed", { id: nodeId }));
      linkDirChanged = mutation.changed;
      changedNodeIds = mutation.changedNodeIds;
      issues = mutation.analysis.issues;
      analysis = mutation.analysis;
    }

    // 2) 建目录 + 建文件
    try {
      await this.ensureFolder(linkDir);
    } catch (error) {
      return failed(t("error.notWritten", { reason: errorMessageOf(error), detail: "" }));
    }
    const path = this.uniqueLinkDocPath(linkDir, name);
    let text = "";
    text = setFrontmatterField(text, FRONTMATTER_FIELDS.linkWorkflow, workflow.title);
    text = setFrontmatterField(text, FRONTMATTER_FIELDS.linkNode, node.title);
    text = setFrontmatterField(text, FRONTMATTER_FIELDS.linkWorkflowId, workflow.id);
    text = setFrontmatterField(text, FRONTMATTER_FIELDS.linkNodeId, nodeId);
    try {
      await this.app.vault.create(path, `${text}\n# ${sanitized.title}\n`);
    } catch (error) {
      return failed(t("error.notWritten", { reason: errorMessageOf(error), detail: "" }));
    }

    this.markReverseIndexDirty();
    this.refreshBoardsFor(file.path);

    const result: LinkDocsResult = {
      success: true,
      file: file.path,
      nodeId,
      changed: true,
      issues,
      changedNodeIds,
      createdPaths: [path],
      linkDirChanged,
    };
    if (analysis !== undefined) result.analysis = analysis;
    return result;
  }

  /**
   * Phase 35：把一份**已有** md 追加成当前节点的资料文件（面板 tab 6 的「添加」）。
   *
   * 与「新建」相反：不建文件，只往对方 frontmatter 的四个键里**追加一条**归属
   * （`appendAffiliation`：已有归属原样留着；同一个 nodeId 已在 → 不重复写）。
   * 绝对路径 / 库内相对路径都认；不在库内、不是 md、找不到 → 只返回原因，不抛错。
   */
  async attachLinkDoc(
    file: TFile,
    node: WfNode,
    workflow: WfWorkflow | undefined,
    rawPath: string,
  ): Promise<LinkDocAttachResult> {
    const nodeId = node.id;
    const failed = (reason: string): LinkDocAttachResult => ({ success: false, nodeId, reason });
    if (workflow === undefined) return failed(t("view.linkDocs.noWorkflow"));

    const input = rawPath.trim();
    if (input.length === 0) return failed(t("view.linkDocs.emptyPath"));
    const path = this.resolveLinkDocPath(input);
    if (path === undefined) return failed(t("view.linkDocs.outsideVault", { path: input }));

    const target = this.app.vault.getAbstractFileByPath(path);
    if (!(target instanceof TFile)) return failed(t("view.linkDocs.notFound", { path }));
    if (target.extension.toLowerCase() !== "md") return failed(t("view.link.unsupported"));

    const tuple: Affiliation = {
      workflowTitle: workflow.title,
      nodeTitle: node.title,
      workflowId: workflow.id,
      nodeId,
    };
    let added = false;
    try {
      rememberViewScroll(target);
      await this.app.vault.process(target, (text) => {
        // 四键交给 `appendAffiliation` 按 index 对齐（`metadataCache` 看不到「刚写完还没刷新」，
        // 所以这里读**文件当前文本**，而不是反向索引）。
        const info = parseFrontmatter(text);
        const record: Record<string, unknown> = {};
        for (const key of FRONTMATTER_LINK_FIELDS) record[key] = info.getArray(key);
        const appended = appendAffiliation(record, tuple);
        if (!appended.changed) return text;
        added = true;
        return writeAffiliationFields(text, appended.values);
      });
    } catch (error) {
      return failed(t("error.notWritten", { reason: errorMessageOf(error), detail: "" }));
    }

    if (added) {
      this.markReverseIndexDirty();
      this.refreshBoardsFor(file.path);
    }
    return { success: true, nodeId, path: target.path, added };
  }

  /**
   * 面板里填的路径 → vault 相对路径（`undefined` = 不在库里 / 认不出来）。
   *
   * 绝对路径（`C:\…` / `/…` / `\\server\…`）先按库根剥离；其余当库内相对路径归一。
   * 库根之外的文件 Obsidian 写不了 frontmatter，所以直接拒绝。
   */
  private resolveLinkDocPath(input: string): string | undefined {
    const text = input.trim();
    if (text.length === 0) return undefined;
    const looksAbsolute = /^[A-Za-z]:[\\/]/.test(text) || text.startsWith("/") || text.startsWith("\\\\");
    const candidate = looksAbsolute ? vaultRelativePath(this.app, text) : text;
    if (candidate === undefined) return undefined;
    const normalized = normalizeVaultPath(candidate.replace(/\\/g, "/"));
    return normalized.length === 0 ? undefined : normalized;
  }

  /**
   * Phase 35：打开系统资源管理器挑一份 md（面板 tab 6 的「选择」）。
   *
   *  - 移动端 / 取不到 Electron `dialog` → `unsupported`（面板提示改用人工输入）；
   *  - 用户取消 → `cancelled`（静默，不报错）；
   *  - 其余异常 → `failed` + 原因。
   */
  async pickLinkDocPath(startDir: string): Promise<LinkDocPickResult> {
    if (!Platform.isDesktop) return { status: "unsupported" };
    const dialog = this.electronDialog();
    if (dialog === undefined) return { status: "unsupported" };

    const options: ElectronOpenDialogOptions = {
      title: t("view.linkDocs.choose"),
      properties: ["openFile"],
      filters: [{ name: "Markdown", extensions: ["md"] }],
    };
    const dir = normalizeNodeLinkDir(startDir);
    const defaultPath =
      dir !== undefined && dir.length > 0 ? absoluteVaultPath(this.app, dir) : vaultBasePath(this.app);
    if (defaultPath !== undefined) options.defaultPath = defaultPath;

    try {
      const result = await dialog.showOpenDialog(options);
      const picked = result.filePaths?.[0];
      if (typeof picked !== "string" || picked.length === 0) return { status: "cancelled" };
      return { status: "picked", path: picked };
    } catch (error) {
      return { status: "failed", reason: errorMessageOf(error) };
    }
  }

  /**
   * 取 Electron 的 `dialog`（桌面端才有）。
   *
   * Obsidian 桌面端开着 `window.require`；新版 Electron 把 remote 拆到 `@electron/remote`，
   * 两个都试一遍。都拿不到 → `undefined`（面板降级成人工输入，不报错）。
   */
  private electronDialog(): ElectronDialog | undefined {
    const req = (window as unknown as { require?: (id: string) => unknown }).require;
    if (typeof req !== "function") return undefined;
    for (const id of ["electron", "@electron/remote"]) {
      try {
        const loaded = req(id) as ElectronModuleLike | undefined;
        const dialog = loaded?.dialog ?? loaded?.remote?.dialog;
        if (dialog !== undefined) return dialog;
      } catch {
        // 没装 / 没开 remote 的那一种：继续试下一个
      }
    }
    return undefined;
  }

  /** 新建链接文档的落点：`<dir>/<name>.md`，重名时依次试 `-2` / `-3`… */
  private uniqueLinkDocPath(linkDir: string, name: string): string {
    const at = (base: string): string => (linkDir.length === 0 ? `${base}.md` : `${linkDir}/${base}.md`);
    let path = at(name);
    let counter = 2;
    while (this.app.vault.getAbstractFileByPath(path) !== null) {
      path = at(`${name}-${counter}`);
      counter += 1;
    }
    return path;
  }

  /** 事件只置脏：把「一次全库扫描」推迟到下一次查询，避免每次小改动都重扫 */
  private markReverseIndexDirty(): void {
    this.reverseIndexDirty = true;
  }

  /**
   * 记下「刚写进去的四键」，供 `rebuildReverseIndex()` 顶替还没跟上的 `metadataCache`
   * （为什么需要见 `writtenFrontmatter` 的注释）。
   *
   * 读的是**写后文本**（与 `attachLinkDoc` 那一路同一套 `parseFrontmatter().getArray()`），
   * 所以四键的形态（标量 / 并列数组）与文件里完全一致。
   */
  private rememberWrittenAffiliations(path: string, markdown: string): void {
    const info = parseFrontmatter(markdown);
    const record: Record<string, unknown> = {};
    for (const key of FRONTMATTER_LINK_FIELDS) {
      const values = info.getArray(key);
      if (values !== undefined) record[key] = values;
    }
    this.writtenFrontmatter.set(path, record);
  }

  /** 从 `metadataCache` 摊平 frontmatter 重建索引（只认 md；四个键的解析交给引擎） */
  private rebuildReverseIndex(): void {
    const entries: AffiliationEntry[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const cache = this.app.metadataCache.getFileCache(file);
      // 自己刚写的值比「还没跟上的缓存」新（记录在 `changed` 事件到达时退场）
      const frontmatter = this.writtenFrontmatter.get(file.path) ?? cache?.frontmatter;
      entries.push({ path: file.path, frontmatter });
    }
    this.reverseIndex = buildReverseIndex(entries);
    this.reverseIndexDirty = false;
  }

  private reverseIndexOf(): ReverseIndex {
    if (this.reverseIndexDirty) this.rebuildReverseIndex();
    return this.reverseIndex;
  }

  /* ---------------------------------------------------------------- *
   * Phase 27 §5.7：「给当前文件打标签」命令 + Modal
   *
   * 口径 12：**不是**迁移命令（旧纪要段里的链接直接随写回清掉），
   * 这里只做正向打标签 —— 给任意 md 写 `wf-workflow` / `wf-node`（+ 两个 id）。
   * ---------------------------------------------------------------- */

  /**
   * 命令入口：取「聚焦的看板」的文档当候选（工作流 / 节点），
   * 再把用户选中的归属写进「当前活动 md」的 frontmatter。
   */
  private async tagCurrentFile(): Promise<void> {
    const board = this.activeBoardFile();
    if (board === undefined) {
      this.notify(t("view.tag.noBoard"));
      return;
    }
    const analysis = await this.analyzeFile(board);
    const document = analysis.latestDocument ?? analysis.document;
    if (!analysis.found || document === undefined) {
      this.notify(t("reject.noBlock"));
      return;
    }
    const target = this.app.workspace.getActiveFile();
    if (target === null || target.extension.toLowerCase() !== "md") {
      this.notify(t("view.tag.noFile"));
      return;
    }
    await new TagFileModal(this.app, document.workflows, (affiliation) =>
      this.writeAffiliation(target, affiliation),
    ).openAndWait();
  }

  /**
   * 聚焦的看板 leaf 绑定的笔记（没有聚焦的看板 → undefined）。
   *
   * 顺序：`getLeavesOfType` 里先找 `workspace.activeLeaf`，再按注册顺序退让 ——
   * 只有一个看板时行为与「取第一个」完全一致。
   */
  private activeBoardFile(): TFile | undefined {
    const leaves = this.app.workspace.getLeavesOfType(WF_BOARD_VIEW_TYPE);
    if (leaves.length === 0) return undefined;
    const active = this.app.workspace.activeLeaf;
    const ordered =
      active !== null && leaves.includes(active) ? [active, ...leaves.filter((leaf) => leaf !== active)] : leaves;
    for (const leaf of ordered) {
      const path = leaf.view instanceof WfBoardView ? leaf.view.boundPath : "";
      if (path.length === 0) continue;
      const file = this.app.vault.getAbstractFileByPath(path);
      if (file instanceof TFile) return file;
    }
    return undefined;
  }

  /**
   * 一次 `vault.process` 写四个键（逐行 upsert，不用 `processFrontMatter`：
   * 后者严格解析整块 YAML，用户笔记里的非严格写法会把打标签一起拖垮）。
   *
   * 返回 `undefined` = 写成功（已 `Notice` + 置脏索引）；否则是给 Modal 显示的失败原因。
   */
  private async writeAffiliation(target: TFile, affiliation: TagFileWrite): Promise<string | undefined> {
    try {
      rememberViewScroll(target);
      await this.app.vault.process(target, (text) => {
        let next = setFrontmatterField(text, FRONTMATTER_FIELDS.linkWorkflow, affiliation.workflowTitle);
        next = setFrontmatterField(next, FRONTMATTER_FIELDS.linkNode, affiliation.nodeTitle);
        next = setFrontmatterField(next, FRONTMATTER_FIELDS.linkWorkflowId, affiliation.workflowId);
        return setFrontmatterField(next, FRONTMATTER_FIELDS.linkNodeId, affiliation.nodeId);
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return t("error.notWritten", { reason, detail: "" });
    }
    // frontmatter 变了但索引可能还没收到 `metadataCache.changed`（异步）→ 主动置脏
    this.markReverseIndexDirty();
    this.notify(t("view.tag.done"));
    return undefined;
  }

  /**
   * Phase 15：拖拽改节点顺序（契约 §③，只改 `children` 的归属 / 顺序，schema 仍 1.9）。
   *
   * 与 `appendChildNode` / `removeNode` 同一套路：引擎在内存里改好 → `mutateFile` 一次写回。
   * 引擎判「拓扑没变」（拖回原位）时 mutator 返回 `changed: false` → 不写盘、不刷 `updatedAt`。
   *
   * Phase 21：`options.keepSubtree` = 被拖的是折叠节点 → 整棵子树跟着走（见引擎 `MoveNodeOptions`）。
   */
  async moveNode(
    file: TFile,
    movingId: string,
    targetId: string,
    position: ReorderPosition,
    options: MoveNodeOptions = {},
  ): Promise<ReorderResult> {
    const now = new Date();
    const mutation = await this.mutateFile(
      file,
      (document) => {
        const edit = moveNodeInDocument(document, movingId, targetId, position, now, options);
        if (!edit.ok) {
          const reason = edit.reason ?? t("view.notify.reorderFailed", { reason: t("view.notify.unknownReason") });
          return { reject: reason };
        }
        if (edit.unchanged === true) return { changed: false, changedNodeIds: [] };
        return { changedNodeIds: edit.changedNodeIds };
      },
      now,
    );

    const result: ReorderResult = {
      success: mutation.success,
      file: file.path,
      changed: mutation.changed,
      issues: mutation.analysis.issues,
      changedNodeIds: mutation.changedNodeIds,
    };
    result.analysis = mutation.analysis;
    if (mutation.reason !== undefined) result.reason = mutation.reason;
    return result;
  }

  /**
   * Phase 21 ⑤：折叠三角 → 把折叠态**直接写进 JSON**（`collapsed`）。
   *
   * 走与其它写回同一条 `mutateFile` 链路（安全闸门 → 内存升格 → 三段写回 → 幂等校验）；
   * 引擎判「本来就是这个状态」时 mutator 返回 `changed: false` → 不写盘、不刷 `updatedAt`。
   */
  async setNodeCollapsed(file: TFile, nodeId: string, collapsed: boolean): Promise<NodeCollapseResult> {
    const now = new Date();
    const mutation = await this.mutateFile(
      file,
      (document) => {
        const edit = setNodeCollapsedInDocument(document, nodeId, collapsed, now);
        if (!edit.ok) return { reject: edit.reason ?? t("reject.editFailed", { id: nodeId }) };
        if (edit.unchanged === true) return { changed: false, changedNodeIds: [] };
        return { changedNodeIds: edit.changedNodeIds };
      },
      now,
    );

    const result: NodeCollapseResult = {
      success: mutation.success,
      file: file.path,
      nodeId,
      collapsed,
      changed: mutation.changed,
      issues: mutation.analysis.issues,
      changedNodeIds: mutation.changedNodeIds,
    };
    result.analysis = mutation.analysis;
    if (mutation.reason !== undefined) result.reason = mutation.reason;
    return result;
  }

  /* ---------------------------------------------------------------- *
   * Phase 3 计时写回（契约 §5）：开始 / 结束并记录 / 结束并丢弃
   * 两个方法都走 mutateFile → applyMutation；节点级 updatedAt 由 timerEdits 维护。
   * ---------------------------------------------------------------- */

  /**
   * 契约 §5.1：「▶️ 开始这个任务」——追加一条进行中的条目。
   * 并发闸门在引擎侧（全文件已有进行中的计时 → 拒绝并指出是哪个节点）。
   */
  async startTimer(file: TFile, nodeId: string): Promise<TimerChangeResult> {
    const now = new Date();
    const holder: { entryIndex?: number } = {};
    const mutation = await this.mutateFile(
      file,
      (document) => {
        const edit = startTimerEntry(document, nodeId, now);
        if (!edit.ok) return { reject: edit.reason ?? t("reject.startTimerFailed", { id: nodeId }) };
        if (edit.entryIndex !== undefined) holder.entryIndex = edit.entryIndex;
        return { changedNodeIds: edit.changedNodeIds };
      },
      now,
    );
    return this.timerResult(mutation, file, nodeId, holder.entryIndex);
  }

  /**
   * 契约 §5.2：「⏹ 结束并记录」= `record`（补 endAt + hours）；「🗑 结束并丢弃」= `discard`（删掉这条）。
   * `record` 时若开始时间失效（endAt < startAt）由引擎拒绝并提示改用「结束并丢弃」。
   */
  async stopTimer(file: TFile, nodeId: string, mode: StopTimerMode): Promise<TimerChangeResult> {
    const now = new Date();
    const holder: { entryIndex?: number } = {};
    const mutation = await this.mutateFile(
      file,
      (document) => {
        const edit = stopTimerEntry(document, nodeId, mode, now);
        if (!edit.ok) {
          const fallback =
      mode === "record"
        ? t("reject.stopRecordFailed", { id: nodeId })
        : t("reject.stopDiscardFailed", { id: nodeId });
          return { reject: edit.reason ?? fallback };
        }
        if (edit.entryIndex !== undefined) holder.entryIndex = edit.entryIndex;
        return { changedNodeIds: edit.changedNodeIds };
      },
      now,
    );
    const result = this.timerResult(mutation, file, nodeId, holder.entryIndex);
    result.mode = mode;
    return result;
  }

  /** 计时动作 → 视图返回（与 setNodeStatus 同形，另带 changedNodeIds / entryIndex） */
  private timerResult(
    mutation: MutationResult,
    file: TFile,
    nodeId: string,
    entryIndex?: number,
  ): TimerChangeResult {
    const result: TimerChangeResult = {
      success: mutation.success,
      file: file.path,
      nodeId,
      changed: mutation.changed,
      issues: mutation.analysis.issues,
      changedNodeIds: mutation.changedNodeIds,
    };
    result.analysis = mutation.analysis;
    if (mutation.reason !== undefined) result.reason = mutation.reason;
    if (entryIndex !== undefined) result.entryIndex = entryIndex;
    return result;
  }

  /* ---------------------------------------------------------------- *
   * Phase 5 ② 编辑节点信息（契约「Phase 5 定稿契约」②）
   * 分字段 6 项：summary / type / importance / progress / owner / dueAt；
   * 内存改动在引擎 nodeEdits.editNodeInfo（patch 覆盖 / clear 删除 / 其余不动）。
   * ---------------------------------------------------------------- */

  /**
   * 低层：逐字段改节点信息（`clear` 里的字段被删除，`patch` 里的被覆盖，其余不动）。
   * 一个字都没改 → 引擎给 `unchanged` → 这里 `changed=false`（不写盘）。
   */
  async setNodeInfo(
    file: TFile,
    nodeId: string,
    patch: NodeInfoPatch,
    clear: readonly NodeInfoFieldKey[],
  ): Promise<NodeInfoChangeResult> {
    const now = new Date();
    // Phase 34：节点改名要同步资料文件的 `wf-node` —— 在 mutator 里取旧标题（同一份文档、同一时刻）
    const holder: { rename?: NodeRenameSync } = {};
    const mutation = await this.mutateFile(
      file,
      (document) => {
        const node = findNode(document, nodeId);
        const workflow = node === undefined ? undefined : this.workflowOfNode(document, node.id);
        const oldTitle = node?.title;
        const edit = editNodeInfoInDocument(document, nodeId, patch, clear, now);
        if (!edit.ok) return { reject: edit.reason ?? t("reject.editFailed", { id: nodeId }) };
        if (edit.unchanged === true) return { changed: false };
        if (node !== undefined && workflow !== undefined && oldTitle !== undefined && node.title !== oldTitle) {
          holder.rename = {
            workflowTitle: workflow.title,
            workflowId: workflow.id,
            nodeId: node.id,
            oldNodeTitle: oldTitle,
            newNodeTitle: node.title,
          };
        }
        return { changedNodeIds: edit.changedNodeIds };
      },
      now,
    );

    // Phase 34：主写回成功后才推 frontmatter（best-effort，失败不影响本次结果）
    if (mutation.success && mutation.changed && holder.rename !== undefined) {
      await this.syncNodeRename(holder.rename);
    }

    const result: NodeInfoChangeResult = {
      success: mutation.success,
      file: file.path,
      nodeId,
      changed: mutation.changed,
      issues: mutation.analysis.issues,
      changedNodeIds: mutation.changedNodeIds,
    };
    result.analysis = mutation.analysis;
    if (mutation.reason !== undefined) result.reason = mutation.reason;
    return result;
  }

  /*
   * Phase 25（M4）：原来的「✏️ 编辑节点信息…」Modal 入口（`editNodeInfo`）已并入
   * `openNodePanel(file, node, "info")` —— 表单换成右侧面板 tab 1，写回仍是 `setNodeInfo`。
   */

  /* ---------------------------------------------------------------- *
   * Phase 20：note 卡片（契约「Phase 20 定稿契约」）
   * 只有 2 个键：`note`（文字 / 待办 的条目集合，空数组 → 删键）与 `noteVisible`（开关，false → 删键）；
   * 内存改动在引擎 `editNodeNote`（逐条 trim、空数组两键全删、OFF 不写 `false`）。
   * ---------------------------------------------------------------- */

  /**
   * 低层：设置 note 的条目与显示开关（其余字段一律不动）。
   * 一个字都没改 → 引擎给 `unchanged` → 这里 `changed=false`（不写盘、不刷 `updatedAt`）。
   */
  async setNodeNote(file: TFile, nodeId: string, patch: NodeNotePatch): Promise<NodeNoteChangeResult> {
    const now = new Date();
    const mutation = await this.mutateFile(
      file,
      (document) => {
        const edit = editNodeNoteInDocument(document, nodeId, patch, now);
        if (!edit.ok) return { reject: edit.reason ?? t("reject.editFailed", { id: nodeId }) };
        if (edit.unchanged === true) return { changed: false };
        return { changedNodeIds: edit.changedNodeIds };
      },
      now,
    );

    const result: NodeNoteChangeResult = {
      success: mutation.success,
      file: file.path,
      nodeId,
      changed: mutation.changed,
      issues: mutation.analysis.issues,
      changedNodeIds: mutation.changedNodeIds,
    };
    result.analysis = mutation.analysis;
    if (mutation.reason !== undefined) result.reason = mutation.reason;
    return result;
  }

  /**
   * 低层：note 卡片上的方框点击（待办 ↔ 已办）。
   * 只翻 `done`、不动 `noteVisible`（引擎 `toggleNodeNoteDone` 保证）；
   * 文字条目点不到方框，引擎也会拒绝并给出原因。
   */
  async toggleNodeNote(file: TFile, nodeId: string, index: number): Promise<NodeNoteChangeResult> {
    const now = new Date();
    const mutation = await this.mutateFile(
      file,
      (document) => {
        const edit = toggleNodeNoteDoneInDocument(document, nodeId, index, now);
        if (!edit.ok) return { reject: edit.reason ?? t("reject.editFailed", { id: nodeId }) };
        return { changedNodeIds: edit.changedNodeIds };
      },
      now,
    );

    const result: NodeNoteChangeResult = {
      success: mutation.success,
      file: file.path,
      nodeId,
      changed: mutation.changed,
      issues: mutation.analysis.issues,
      changedNodeIds: mutation.changedNodeIds,
    };
    result.analysis = mutation.analysis;
    if (mutation.reason !== undefined) result.reason = mutation.reason;
    return result;
  }

  /* ---------------------------------------------------------------- *
   * Phase 5 ③ 修改工作流（契约「Phase 5 定稿契约」③）：增删 + 分字段编辑
   * 增删 = 「根节点的增减」（一个 workflow 必有且只有一个 root）；
   * 内存改动与整批预检都在引擎 workflowEdits.ts，这里只做编排。
   * ---------------------------------------------------------------- */

  /**
   * 低层：整批应用工作流改动（**一次写回**）。
   *
   * 引擎 `applyWorkflowEdits` 先整批预检（id 存在性 / 删除护栏 / 字段合法性），
   * 任一条不过 → `reject`，`applyMutation` 直接返回原文（一个字都不落盘）；
   * `structureChanged = true`（有增删）时视图要整块重渲染，否则按 `changedNodeIds` 局部刷新。
   */
  async applyWorkflowPlan(file: TFile, plan: WorkflowEditPlan): Promise<WorkflowChangeResult> {
    const now = new Date();
    // Phase 34：工作流改名要同步资料文件的 `wf-workflow`（+ 根节点的 `wf-node`）
    const holder: { structureChanged: boolean; renames: WorkflowRenameSync[] } = {
      structureChanged: false,
      renames: [],
    };
    const mutation = await this.mutateFile(
      file,
      (document) => {
        const before = new Map((document.workflows ?? []).map((workflow) => [workflow.id, workflow.title]));
        const edit = applyWorkflowEdits(document, plan, now);
        holder.structureChanged = edit.structureChanged;
        if (!edit.ok) return { reject: edit.reason ?? t("reject.workflowFailed") };
        if (edit.changedNodeIds.length === 0 && !edit.structureChanged) return { changed: false };

        holder.renames = [];
        for (const id of edit.editedWorkflowIds) {
          const workflow = findWorkflow(document, id);
          const prior = before.get(id);
          if (workflow === undefined || prior === undefined) continue;
          if (workflow.title === prior) continue; // 只改了别的字段
          holder.renames.push({
            workflowId: id,
            rootNodeId: workflow.root.id,
            oldTitle: prior,
            newTitle: workflow.title,
          });
        }
        return { changedNodeIds: edit.changedNodeIds, removedNoteAnchors: edit.removedNoteAnchors };
      },
      now,
    );

    // Phase 34：主写回成功后才推 frontmatter（best-effort，失败不影响本次结果）
    if (mutation.success && mutation.changed) {
      for (const rename of holder.renames) await this.syncWorkflowRename(rename);
    }

    const result: WorkflowChangeResult = {
      success: mutation.success,
      file: file.path,
      changed: mutation.changed,
      issues: mutation.analysis.issues,
      changedNodeIds: mutation.changedNodeIds,
      // 被拒绝 / 无改动时不能说「结构变了」——否则视图会白重渲染一次
      structureChanged: mutation.success && mutation.changed && holder.structureChanged,
    };
    result.analysis = mutation.analysis;
    if (mutation.reason !== undefined) result.reason = mutation.reason;
    return result;
  }

  /** 契约 §③ 低层：新增一个工作流（自带新 root，追加到 `workflows[]` 末尾） */
  async addWorkflow(file: TFile, patch: WorkflowPatch): Promise<WorkflowChangeResult> {
    return this.applyWorkflowPlan(file, { additions: [patch] });
  }

  /** 契约 §③ 低层：删除一个工作流（连根带全部节点，以及正文里的纪要段落） */
  async deleteWorkflow(file: TFile, workflowId: string): Promise<WorkflowChangeResult> {
    return this.applyWorkflowPlan(file, { removals: [workflowId] });
  }

  /** 契约 §③ 低层：逐字段改一个工作流（patch 覆盖 / clear 删除 / 其余不动） */
  async setWorkflowInfo(
    file: TFile,
    workflowId: string,
    patch: WorkflowPatch,
    clear: readonly WorkflowEditFieldKey[],
  ): Promise<WorkflowChangeResult> {
    return this.applyWorkflowPlan(file, { edits: [{ id: workflowId, patch, clear }] });
  }

  /*
   * Phase 25（M4）：原来的「⚙️ 修改工作流…」Modal 入口（`editWorkflows`）已并入
   * `openNodePanel(file, undefined, "workflow")` —— 表单换成右侧面板 tab 3，
   * 初值仍由 `analyzeFile` 现读，保存仍是一次 `applyWorkflowPlan`。
   */

  /* ---------------------------------------------------------------- *
   * Phase 4 归档写回（契约 §4）：planArchive → 建归档文件 → 浓缩本节点
   * 顺序很重要：归档文件 先落盘（在 vault 里），原文件写回在后 —— 反过来一旦
   * 写回失败就会出现「节点已浓缩但归档文件 不存在」的死引用。
   * ---------------------------------------------------------------- */

  /**
   * 契约 §4.1：把 `nodeId` 及其后代浓缩进 `archive/<workflowId>-<nodeId>.wf.json`。
   *
   *  - 先只读地算一遍计划（`planArchive` 内部会再跑一次资格检查：根 / 叶子 /
   *    子树里有非 done 的节点 → 直接拒绝，**一个字节都不写**）；
   *  - 归档文件 用 `vault.create`（不 `createIfAbsent` 覆盖）：路径已存在就**复用它**，
   *    并采用那份文件里记着的 `workflowId`（幂等重试：用户补写过正文也不会被冲掉）；
   *  - 最后 `mutateFile` 把原文件里的子树压成一个带 `archive` 的 done 节点
   *    （`writeBackDocument` 顺带删掉被浓缩后代的正文纪要段落）。
   *
   * Phase 36：节点**已经有 `archive` 且旧归档文件 还在** → 走 `appendArchive` 重复归档
   * （把本次新子树追加到旧归档文件 的根节点下，`workflowId` 沿用），不再新建第二份。
   */
  async archiveNode(file: TFile, node: WfNode, form: ArchiveFormInput = {}): Promise<ArchiveNodeResult> {
    const now = new Date();
    const noteMarkdown = await this.app.vault.read(file);
    const analysis = await this.analyzeNoteText(file, noteMarkdown);
    const wfDoc = analysis.latestDocument ?? analysis.document;
    if (!analysis.found || wfDoc === undefined) {
      return {
        success: false,
        file: file.path,
        nodeId: node.id,
        changed: false,
        reason: t("reject.noBlock"),
        issues: analysis.issues,
        changedNodeIds: [],
      };
    }

    // Phase 9：归档文件 要复制正文纪要
    //   - 笔记模式：本笔记正文（上面已读，避免二次读盘）
    const sourceMarkdown = noteMarkdown;

    // Phase 36：已归档过 + 旧归档文件 还在 → 重复归档 = 把本次新子树**追加**到旧归档文件 的根节点下
    const existing = await this.findArchiveFileForNode(node.id);
    if (node.archive !== undefined && existing !== undefined) {
      return await this.appendArchive(
        file,
        "node",
        node,
        undefined,
        existing,
        wfDoc,
        form,
        now,
        analysis,
      );
    }

    const planned = planArchive(wfDoc, node.id, form, now, sourceMarkdown);
    if (!planned.ok || planned.plan === undefined) {
      return {
        success: false,
        file: file.path,
        nodeId: node.id,
        changed: false,
        reason: planned.reason ?? t("reject.cannotArchive", { id: node.id }),
        issues: analysis.issues,
        changedNodeIds: [],
      };
    }
    const plan = planned.plan;

    const archive: WfArchive = { ...plan.archive };
    let archiveFile = plan.file;
    let reusedArchiveFile = false;
    if (existing !== undefined) {
      // 幂等重试：上次已经在磁盘上建好了那份归档文件（可能写回原文件时失败了），照用
      reusedArchiveFile = true;
      archiveFile = existing.path;
      if (existing.workflowId !== undefined) archive.workflowId = existing.workflowId;
    } else {
      await this.createArchiveFile(plan.file, plan.document);
    }

    const mutation = await this.mutateFile(
      file,
      (document) => {
        const edit = archiveNodeInDocument(document, node.id, archive, now);
        if (!edit.ok) return { reject: edit.reason ?? t("reject.archiveFailed", { id: node.id }) };
        return {
          changedNodeIds: edit.changedNodeIds,
          removedNoteAnchors: edit.removedNoteAnchors,
          // Phase 27：归档地址不再写正文纪要段 —— 视图按 `archive.file` 现算
          // （`archive.file` 也不再写入，只作旧数据的回落值）
        };
      },
      now,
    );

    // Phase 34（节点级补全）：归档成功 → 被归档子树（浓缩节点 + 后代）的链接文档 `wf-workflow`
    // 改成归档文件 的 workflow 标题（`浓缩节点标题（已归档）`）；id 不动。
    if (mutation.success && mutation.changed) {
      const owner = this.workflowOfNode(wfDoc, node.id);
      const archivedRoot = findNode(wfDoc, node.id) ?? node;
      if (owner !== undefined) {
        const archivedTitle =
          (plan.document.workflows ?? [])[0]?.title ?? `${archivedRoot.title}${ARCHIVE_TITLE_SUFFIX}`;
        await this.syncArchivedNodes(owner, archivedRoot, archivedTitle);
      }
      // Phase 36：归档看板绑的是归档文件 —— 上面的同步改的是链接文档，它不会自己重画
      this.refreshBoardsFor(archiveFile);
      try {
        await this.addArchiveTags(form.tag ?? []);
      } catch {
        // tag enum write-back failure does not affect archive
      }
    }

    const result: ArchiveNodeResult = {
      success: mutation.success,
      file: file.path,
      nodeId: node.id,
      changed: mutation.changed,
      issues: mutation.analysis.issues,
      changedNodeIds: mutation.changedNodeIds,
      archiveFile,
      workflowId: archive.workflowId,
      nodeCount: plan.nodeCount,
      reusedArchiveFile,
    };
    result.analysis = mutation.analysis;
    if (mutation.reason !== undefined) result.reason = mutation.reason;
    return result;
  }

  /**
   * Phase 22 契约 §①：把**整条工作流**浓缩进 `archive/<新workflowId>-<根节点id>.md`。
   *
   * 与 `archiveNode` 同一条链路（plan → 建归档文件 → 改原文件），三处不同：
   *  - 资格看整棵树全 done（根节点 / 叶子流都能归档），理由文案由引擎给；
   *  - 归档文件 的 workflow **不带 `originId`** → 幂等认领的判据变成「这份 md 没有 originId」；
   *  - 写回时引擎顺带在文件级写一条 `workflow_archive` 台账（`archive` / `noteAnchor` / `workflowId` / `title`）。
   *
   * Phase 36：整条流**已经归档过**且旧归档文件 还在 → 走 `appendArchive`（新子树追加到旧归档文件 的
   * 根节点下，台账条目按 `workflowId` 原位刷新），不再新建第二份。
   */
  async archiveWorkflow(file: TFile, workflow: WfWorkflow, form: ArchiveFormInput = {}): Promise<ArchiveNodeResult> {
    const now = new Date();
    const noteMarkdown = await this.app.vault.read(file);
    const analysis = await this.analyzeNoteText(file, noteMarkdown);
    const wfDoc = analysis.latestDocument ?? analysis.document;
    if (!analysis.found || wfDoc === undefined) {
      return {
        success: false,
        file: file.path,
        nodeId: workflow.root.id,
        changed: false,
        reason: t("reject.noBlock"),
        issues: analysis.issues,
        changedNodeIds: [],
      };
    }

    // Phase 9：归档文件 要复制正文纪要（笔记模式 = 本笔记正文，上面已读）
    const sourceMarkdown = noteMarkdown;

    // Phase 36：整条流已经归档过 + 旧归档文件 还在 → 重复归档 = 把新子树追加到旧归档文件 的根节点下
    const existing = await this.findArchiveFileForWorkflow(workflow.root.id);
    if (workflow.root.archive !== undefined && existing !== undefined) {
      return await this.appendArchive(
        file,
        "workflow",
        workflow.root,
        workflow,
        existing,
        wfDoc,
        form,
        now,
        analysis,
      );
    }

    const planned = planWorkflowArchive(wfDoc, workflow.id, form, now, sourceMarkdown);
    if (!planned.ok || planned.plan === undefined) {
      return {
        success: false,
        file: file.path,
        nodeId: workflow.root.id,
        changed: false,
        reason: planned.reason ?? t("reject.cannotArchiveWorkflow", { id: workflow.id }),
        issues: analysis.issues,
        changedNodeIds: [],
      };
    }
    const plan = planned.plan;

    const archive: WfArchive = { ...plan.archive };
    let archiveFile = plan.file;
    let reusedArchiveFile = false;
    if (existing !== undefined) {
      // 幂等重试：上次已经建好了那份归档文件（可能写回原文件时失败了），照用那份的身份
      reusedArchiveFile = true;
      archiveFile = existing.path;
      if (existing.workflowId !== undefined) archive.workflowId = existing.workflowId;
    } else {
      await this.createArchiveFile(plan.file, plan.document);
    }

    const mutation = await this.mutateFile(
      file,
      (document) => {
        const edit = archiveWorkflowInDocument(document, workflow.id, archive, now);
        if (!edit.ok) {
          return { reject: edit.reason ?? t("reject.archiveWorkflowFailed", { id: workflow.id }) };
        }
        return {
          changedNodeIds: edit.changedNodeIds,
          removedNoteAnchors: edit.removedNoteAnchors,
          // Phase 27：归档地址不再写正文纪要段（视图按节点上的 `archive` 现算路径）
        };
      },
      now,
    );

    // Phase 34：归档成功 → 链接文档的 `wf-workflow` 跟着改成「原标题（已归档）」（id 不动）
    if (mutation.success && mutation.changed) {
      await this.syncArchivedWorkflow(workflow.title, workflow.id);
      // Phase 36：归档看板绑的是归档文件 —— 上面的同步改的是链接文档，它不会自己重画
      this.refreshBoardsFor(archiveFile);
      try {
        await this.addArchiveTags(form.tag ?? []);
      } catch {
        // tag enum write-back failure does not affect archive
      }
    }

    const result: ArchiveNodeResult = {
      success: mutation.success,
      file: file.path,
      nodeId: plan.rootNodeId,
      changed: mutation.changed,
      issues: mutation.analysis.issues,
      changedNodeIds: mutation.changedNodeIds,
      archiveFile,
      workflowId: archive.workflowId,
      nodeCount: plan.nodeCount,
      reusedArchiveFile,
    };
    result.analysis = mutation.analysis;
    if (mutation.reason !== undefined) result.reason = mutation.reason;
    return result;
  }

  /**
   * Phase 36：重复归档 —— 把 `node` 当前的**新子树**追加到 `existing` 那份归档文件 的根节点下，
   * 再用同一套浓缩逻辑改原文件。
   *
   * 与首次归档共享一切口径，只有「归档文件 怎么变」不同：
   *  - 首次 = `createArchiveFile(…plan.markdown…)` 新建一份（新 workflowId、新文件）；
   *  - 重复 = 读回旧 md → `planArchiveAppend` 只给本次子树重映射 id → **追加**到旧根 `children`
   *    末尾（旧内容一个字节都不动，`archive.workflowId` 沿用）。
   *
   * 顺序：先写归档文件，再浓缩原文件（与首次归档同序 —— 先保证归档里有这次的内容）。
   * 两步都不原子：若归档文件 写成功、原文件写失败，重试会**再追加一份**（id 重映射让去重失效），
   * 这是 Phase 36 明确接受的最坏情况（用户可手工删掉重复的那截）。
   */
  private async appendArchive(
    file: TFile,
    mode: "node" | "workflow",
    node: WfNode,
    workflow: WfWorkflow | undefined,
    existing: { path: string; workflowId?: string },
    source: WfJsonDocument,
    form: ArchiveFormInput,
    now: Date,
    analysis: AnalyzeResult,
  ): Promise<ArchiveNodeResult> {
    const rejected = (reason: string, issues = analysis.issues): ArchiveNodeResult => ({
      success: false,
      file: file.path,
      nodeId: node.id,
      changed: false,
      reason,
      issues,
      changedNodeIds: [],
    });

    const archiveTFile = this.app.vault.getAbstractFileByPath(existing.path);
    if (!(archiveTFile instanceof TFile)) {
      return rejected(t("reject.archiveFailed", { id: node.id }));
    }

    // ① 读回归档文件（成对 / 内联都认：analyzeNoteText 按路径自动选侧车链路）
    const archivedMarkdown = await this.app.vault.read(archiveTFile);
    const archivedAnalysis = await this.analyzeNoteText(archiveTFile, archivedMarkdown);
    const archivedDoc = archivedAnalysis.latestDocument ?? archivedAnalysis.document;
    if (!archivedAnalysis.found || archivedDoc === undefined) {
      return rejected("归档文件里读不到 wfjson（可能已损坏）");
    }

    const appended = planArchiveAppend(archivedDoc, source.id, node, form, now);
    if (!appended.ok || appended.plan === undefined) {
      return rejected(appended.reason ?? t("reject.archiveFailed", { id: node.id }));
    }
    const plan = appended.plan;

    // ② 先写归档文件：本次子树追加到根节点末尾
    const appendMutation = await this.mutateFile(
      archiveTFile,
      (document) => {
        const archivedWorkflow = (document.workflows ?? [])[0];
        if (archivedWorkflow === undefined) {
          return { reject: "归档文件里没有工作流（可能已损坏）" };
        }
        archivedWorkflow.root.children = [
          ...(archivedWorkflow.root.children ?? []),
          ...plan.appendedChildren,
        ];
        // Phase 39：归档文件自己的元数据也刷新（archivedAt = 本次；from_* 与旧说明不动）
        archivedWorkflow.archive = plan.archiveMeta;
        // Phase 28：重复归档也刷新快照的归档时间（归档看板的窗口默认以它结束）
        document.archivedAt = formatLocalIso(now);
        return { changedNodeIds: [archivedWorkflow.root.id] };
      },
      now,
    );
    if (!appendMutation.success) {
      return rejected(
        appendMutation.reason ?? t("reject.archiveFailed", { id: node.id }),
        appendMutation.analysis.issues,
      );
    }

    // ③ 再改原文件：节点级 / 整条流级共用这两个浓缩入口（`archive` 换成沿用旧 workflowId 的新值）
    const mutation = await this.mutateFile(
      file,
      (document) => {
        const edit =
          mode === "workflow" && workflow !== undefined
            ? archiveWorkflowInDocument(document, workflow.id, plan.archive, now)
            : archiveNodeInDocument(document, node.id, plan.archive, now);
        if (!edit.ok) return { reject: edit.reason ?? t("reject.archiveFailed", { id: node.id }) };
        return {
          changedNodeIds: edit.changedNodeIds,
          removedNoteAnchors: edit.removedNoteAnchors,
        };
      },
      now,
    );

    // Phase 34/35：归档成功 → 链接文档的 `wf-workflow` 跟着改成归档文件 的 workflow 标题（id 不动）
    //  - 整条流：`syncArchivedWorkflow`（工作流口径：id ∪ 原标题）
    //  - 节点级：`syncArchivedNodes`（被追加子树的节点口径：id ∪ 「工作流标题::节点标题」）
    if (mutation.success && mutation.changed) {
      if (mode === "workflow" && workflow !== undefined) {
        await this.syncArchivedWorkflow(workflow.title, workflow.id);
      } else if (mode === "node") {
        const owner = this.workflowOfNode(source, node.id);
        if (owner !== undefined) {
          // 子树用计划实际用的 `node`（与 `planArchiveAppend` 同一份），标题同理
          const archivedTitle =
            (archivedDoc.workflows ?? [])[0]?.title ?? `${node.title}${ARCHIVE_TITLE_SUFFIX}`;
          await this.syncArchivedNodes(owner, node, archivedTitle);
        }
      }
      // Phase 36：归档看板绑的是归档文件 —— 上面的同步改的是链接文档，它不会自己重画
      this.refreshBoardsFor(existing.path);
    }

    const result: ArchiveNodeResult = {
      success: mutation.success,
      file: file.path,
      nodeId: node.id,
      changed: mutation.changed,
      issues: mutation.analysis.issues,
      changedNodeIds: mutation.changedNodeIds,
      archiveFile: existing.path,
      workflowId: plan.archive.workflowId,
      nodeCount: plan.appendedNodeCount,
      reusedArchiveFile: true,
      appended: true,
    };
    result.analysis = mutation.analysis;
    if (mutation.reason !== undefined) result.reason = mutation.reason;
    return result;
  }

  /** 归档目录（没有就建）：幂等重试要扫它，新建归档文件 也落在里面 */
  private async ensureArchiveFolder(): Promise<void> {
    const folder = archiveFolderOf();
    if (this.app.vault.getAbstractFileByPath(folder) !== null) return;
    await this.app.vault.createFolder(folder);
  }

  /**
   * 幂等重试的锚：`archive/` 里有没有这个节点上次建的归档文件（`.wf.json`）。
   * 先按路径特征找（`archive/<任意 workflowId>-<nodeId>.wf.json`，见 `isArchivePathForNode`），
   * 再读回文件里的 `originId` 核对 —— 只有 `originId === nodeId` 才认（同名旧文件不算）。
   */
  private async findArchiveFileForNode(nodeId: string): Promise<{ path: string; workflowId?: string } | undefined> {
    await this.ensureArchiveFolder();
    const folder = this.app.vault.getAbstractFileByPath(archiveFolderOf()) as { children?: unknown[] } | null;
    const children = folder?.children;
    if (!Array.isArray(children)) return undefined;

    for (const child of children) {
      const path = (child as { path?: unknown }).path;
      if (typeof path !== "string" || !isArchivePathForNode(path, nodeId)) continue;
      const jsonText = await this.app.vault.read(child as TFile);
      // Phase 28：归档文件就是纯 JSON，身份直接从它读
      const identity = readArchivedWorkflowIdentity("", jsonText);
      if (identity.originId !== nodeId) continue;
      const found: { path: string; workflowId?: string } = { path };
      if (identity.workflowId !== undefined) found.workflowId = identity.workflowId;
      return found;
    }
    return undefined;
  }

  /**
   * 建归档产物：`archive/<wfId>-<nodeId>.wf.json`（Phase 28 起**只有这一个文件**，不再产 md / 侧车）。
   *
   * 安全线：路径已存在 → 直接沿用，**绝不覆盖**（幂等重试 / 用户手工放进来的同路径文件）。
   */
  private async createArchiveFile(path: string, document: WfJsonDocument): Promise<void> {
    await this.ensureArchiveFolder();
    if (this.app.vault.getAbstractFileByPath(path) !== null) return;
    await this.app.vault.create(path, stringifyWfJson(document));
  }

  /**
   * Phase 22 幂等重试的锚：`archive/` 里有没有**整条工作流**归档留下的那份 `.wf.json`。
   *
   * 与 `findArchiveFileForNode` 同一套扫描（`isArchivePathForNode` 认 `-<根节点id>.wf.json`），
   * 但判据相反：整条流归档的文件 **不带 `originId`**（`planWorkflowArchive` 有意不写），
   * 带 `originId` 的是节点级归档 —— 两者不会互相认领。
   */
  private async findArchiveFileForWorkflow(rootNodeId: string): Promise<{ path: string; workflowId?: string } | undefined> {
    await this.ensureArchiveFolder();
    const folder = this.app.vault.getAbstractFileByPath(archiveFolderOf()) as { children?: unknown[] } | null;
    const children = folder?.children;
    if (!Array.isArray(children)) return undefined;

    for (const child of children) {
      const path = (child as { path?: unknown }).path;
      if (typeof path !== "string" || !isArchivePathForNode(path, rootNodeId)) continue;
      const jsonText = await this.app.vault.read(child as TFile);
      // Phase 28：归档文件就是纯 JSON，身份直接从它读
      const identity = readArchivedWorkflowIdentity("", jsonText);
      if (identity.originId !== undefined || identity.workflowId === undefined) continue;
      return { path, workflowId: identity.workflowId };
    }
    return undefined;
  }

  /* ---------------------------------------------------------------- *
   * Phase 25（M4）右侧面板（契约 §6）：视图只传「哪个节点 / 哪个 tab」，
   * 表单（5 个 Modal 类）与写回闭包都在这里配对；宿主容器见 `WfSidePanel`。
   * ---------------------------------------------------------------- */

  /** 当前打开的右侧面板（同时只开一个 —— 它 dock 在窗口右缘，不是按 leaf 分布的弹窗） */
  private sidePanel: WfSidePanel | null = null;
  /** Phase 39：归档标签枚举缓存（启动读一次，视图同步拿） */
  private archiveTagCache: string[] = [];

  /**
   * 视图 → 面板的唯一入口（契约 §6.2）：打开面板并切到 `tab`，等表单落定后返回该 tab 的写回结果。
   *
   * 返回值语义与 Phase 25 之前的 Modal 入口完全一致：保存 → `cancelled: false` + `result`；
   * 取消 / 换 tab / 点「×」/ 读不到文档 → `cancelled: true`（视图不提示、不刷新）。
   * `tab` 决定结果类型（`WfPanelResultMap`），调用方不需要任何断言。
   */
  async openNodePanel<T extends WfPanelTab>(
    file: TFile,
    node: WfNode | undefined,
    tab: T,
    workflow?: WfWorkflow,
    theme?: string,
  ): Promise<ModalEditOutcome<WfPanelResultMap[T]>> {
    const outcome = await this.runPanelForm<WfPanelResultMap[T]>(file, node, tab, workflow, theme);
    return outcome === undefined ? { cancelled: true } : { cancelled: false, result: outcome };
  }

  /**
   * 面板 tab → 现成的 Modal 实例（表单与写回闭包在这里配对；`mountInto` 只换容器，不换链路）。
   * `undefined` = 这个 tab 现在没条件开：`"workflow"` 读不到可用文档（没有代码块 / 文件没了）。
   */
  private async panelModalFor(
    file: TFile,
    node: WfNode | undefined,
    tab: WfPanelTab,
    workflow: WfWorkflow | undefined,
  ): Promise<PanelModal | undefined> {
    switch (tab) {
      case "info":
        return node === undefined
          ? undefined
          : new NodeInfoModal(this.app, node, (patch, clear) => this.setNodeInfo(file, node.id, patch, clear));
      case "note":
        // Phase 36：note 节点并入面板 —— 与原「设置 note 节点」弹窗同一张表单，只是换成 tab
        return node === undefined
          ? undefined
          : new NodeNoteModal(this.app, node, (patch) => this.setNodeNote(file, node.id, patch));
      case "child":
        return node === undefined
          ? undefined
          : new NewChildModal(this.app, node, (input) => this.addChildNode(file, node.id, input));
      case "delete":
        return node === undefined
          ? undefined
          : new ConfirmDeleteModal(this.app, node, () => this.deleteNode(file, node.id));
      case "archive": {
        // 选项卡 4 覆盖两种归档：传了 `workflow` = 整条流归档，否则是「为此及之后」（节点级）
        // Phase 41：标签候选**现读** `archive_tag.yaml`（启动缓存会漏掉用户刚加的词）
        const tags = await this.refreshArchiveTags();
        if (workflow !== undefined) {
          return new ArchiveNodeModal(
            this.app,
            workflow.root,
            (form) => this.archiveWorkflow(file, workflow, form),
            { kind: "workflow", title: workflow.title },
            tags,
          );
        }
        return node === undefined
          ? undefined
          : new ArchiveNodeModal(this.app, node, (form) => this.archiveNode(file, node, form), undefined, tags);
      }
      case "links":
        // Phase 34：链接文档选项卡 —— 列表 / 刷新 / 新建链接文档 / 新建相对路径（Phase 36 后排在最后）
        return node === undefined
          ? undefined
          : new LinkDocsModal(this.app, node, {
              list: () => {
                // 打开 / 点刷新都要重新扫一遍（索引只置脏，这里才真正重建）
                this.markReverseIndexDirty();
                return collectAffiliatedFiles(this.reverseIndexOf(), nodeRefFor(workflow, node));
              },
              create: (input) => this.createLinkDoc(file, node, workflow, input),
              open: (path) => this.openLinkedFile(path),
              // Phase 35：选择（桌面端资源管理器）/ 添加已有 md（四键「增补」，不覆盖）
              pick: (startDir) => this.pickLinkDocPath(startDir),
              attach: (path) => this.attachLinkDoc(file, node, workflow, path),
            });
      case "workflow": {
        // 表单初值必须现读（不弹一个没有初值的空表单）；读不到就什么都不开，只提示
        const analysis = await this.analyzeFile(file);
        const wfDoc = analysis.latestDocument ?? analysis.document;
        if (!analysis.found || wfDoc === undefined) return undefined;
        // Phase 45：标签候选现读（与归档表单同口径）；保存成功后把新标签并入 archive_tag.yaml
        const tags = await this.refreshArchiveTags();
        return new WorkflowEditorModal(
          this.app,
          wfDoc.workflows,
          (plan) => this.applyWorkflowPlan(file, plan),
          tags,
          (newTags) => this.addArchiveTags(newTags),
        );
      }
    }
  }

  /** 开面板 → 挂 tab → 等落定 → 收面板（Modal 的「关窗」换成这里的 `close`） */
  private async runPanelForm<T>(
    file: TFile,
    node: WfNode | undefined,
    tab: WfPanelTab,
    workflow: WfWorkflow | undefined,
    theme: string | undefined,
  ): Promise<T | undefined> {
    const modal = await this.panelModalFor(file, node, tab, workflow);
    if (modal === undefined) {
      // 只有「读不到代码块」会走到这里；缺节点是调用方的 bug（视图不会这么调）
      if (tab === "workflow") this.notify(t("reject.noBlock"));
      return undefined;
    }
    const panel = this.openSidePanel(file, node, workflow, theme);
    const mounted = panel.mount(tab, modal);
    if (mounted === null) return undefined;
    const outcome = (await mounted.done) as T | undefined;
    // 用户切了 tab（表单被面板按「取消」收掉）→ 面板留给新 tab，别把它一起关了
    if (panel.isOpen && panel.activeTab !== tab) return undefined;
    panel.close();
    return outcome;
  }

  /**
   * 面板内切 tab：上一个 tab 的表单没提交就被换掉 → 按「取消」收尾（`dispose`），
   * 再按新 tab 建一张。异步的那一步（`"workflow"` 要现读文档）回来时先确认
   * 「面板还开着、tab 还是我要的那个」，否则什么都不做。
   */
  private async mountPanelTab(
    panel: WfSidePanel,
    file: TFile,
    node: WfNode | undefined,
    workflow: WfWorkflow | undefined,
    tab: WfPanelTab,
  ): Promise<void> {
    const modal = await this.panelModalFor(file, node, tab, workflow);
    if (!panel.isOpen || panel.activeTab !== tab) return;
    if (modal === undefined) {
      panel.showHint(t("reject.noBlock"));
      return;
    }
    const mounted = panel.attach(modal);
    await mounted.done;
    // 同 `runPanelForm`：这条表单只因「又换了一次 tab」而收尾时，面板继续留着
    if (panel.isOpen && panel.activeTab !== tab) return;
    panel.close();
  }

  /** 建（并顶掉上一个）右侧面板；`tab` 的回调自己会去建对应表单 */
  private openSidePanel(
    file: TFile,
    node: WfNode | undefined,
    workflow: WfWorkflow | undefined,
    theme: string | undefined,
  ): WfSidePanel {
    this.closeSidePanel();
    const panel = new WfSidePanel({
      onTab: (tab) => {
        void this.mountPanelTab(panel, file, node, workflow, tab);
      },
      onClose: () => {
        if (this.sidePanel === panel) this.sidePanel = null;
      },
      theme,
    });
    this.sidePanel = panel;
    panel.open();
    return panel;
  }

  /** 关掉当前面板（`onunload` / 开新面板 / 文件被删时都走它） */
  closeSidePanel(): void {
    const panel = this.sidePanel;
    this.sidePanel = null;
    panel?.close();
  }

  /* ---------------------------------------------------------------- *
   * Phase 24：看板（ItemView）入口
   * ---------------------------------------------------------------- */

  /**
   * 用**指定笔记**打开一个看板 leaf（命令 / ribbon / 归档跳转都走它）。
   *
   * `state.file` 是 **vault 相对路径**：与 `WfBoardView.getState()` 对称，`workspace.json`
   * 落盘的也是它。已存在同文件的看板时**不**去重（口径 1：一个 leaf 一个看板，用户自己关）。
   *
   * Phase 41：开完显式 `setActiveLeaf` —— `getLeaf("tab")` 只保证「新开一个页签」，
   * 不保证它抢到前台；从「已归档」弹窗 / 卡片菜单点进来时会出现「开了但页面没动」。
   */
  async openBoardAt(path: string, source: "tab" | "split" = "tab"): Promise<void> {
    const leaf = this.app.workspace.getLeaf(source);
    await leaf.setViewState({ type: WF_BOARD_VIEW_TYPE, state: { file: path } });
    this.app.workspace.setActiveLeaf(leaf, { focus: true });
  }

  /**
   * 打开归档看板：归档文件是 `archive/<wfId>-<nodeId>.wf.json`（Phase 28 起不再有 md），
   * 直接开成看板（不是 JSON 源码页）。
   *
   * 文件被删 / 被移走时只提示，**不**回落 `openLinkText` —— 否则同一个链接会
   * 「有时开看板、有时开别的」，用户没法预期。
   */
  openArchiveBoard(path: string): void {
    if (this.app.vault.getAbstractFileByPath(path) === null) {
      new Notice(t("notice.archiveMissing", { path }));
      return;
    }
    void this.openBoardAt(path);
  }

  /* ---------------------------------------------------------------- *
   * Phase 39：编辑归档文件元数据（`workflow.archive` 的三段文字 + 标签）
   * ---------------------------------------------------------------- */

  /**
   * 低层：改**归档文件自己的**元数据（`workflow.archive` 的三段文字 + 标签）。
   *
   * 归档时间 / 来源（from_*）/ 归档文件身份都不动 —— 改说明不改事实。
   * 写回走 `mutateFile` 的 `.wf.json` 分支（没有笔记要同步），写成功后顺手刷新归档看板。
   */
  async setWorkflowArchiveInfo(
    path: string,
    workflowId: string,
    form: ArchiveFormInput,
  ): Promise<ArchiveInfoEditResult> {
    const now = new Date();
    const archiveTFile = this.app.vault.getAbstractFileByPath(path);
    if (!(archiveTFile instanceof TFile)) {
      const reason = t("notice.archiveMissing", { path });
      new Notice(reason);
      return { success: false, file: path, workflowId, changed: false, reason, issues: [] };
    }

    const mutation = await this.mutateFile(
      archiveTFile,
      (document) => {
        const edit = editWorkflowArchiveInfoInDocument(document, workflowId, form, now);
        if (!edit.ok) return { reject: edit.reason ?? t("reject.editFailed", { id: workflowId }) };
        if (edit.changed !== true) return { changed: false };
        return { changedNodeIds: [workflowId] };
      },
      now,
    );

    const result: ArchiveInfoEditResult = {
      success: mutation.success,
      file: archiveTFile.path,
      workflowId,
      changed: mutation.changed,
      issues: mutation.analysis.issues,
    };
    result.analysis = mutation.analysis;
    if (mutation.reason !== undefined) result.reason = mutation.reason;
    if (mutation.success) {
      try {
        await this.addArchiveTags(form.tag ?? []);
      } catch {
        // tag enum write-back failure does not affect edit
      }
      this.refreshBoardsFor(path);
    }
    return result;
  }

  /** 读一份归档文件的元数据（「已归档」弹窗懒加载用；文件不在 / 解析失败 → undefined） */
  async readArchiveMeta(path: string): Promise<ArchiveFileMeta | undefined> {
    const file = this.app.vault.getAbstractFileByPath(path);
    if (!(file instanceof TFile)) return undefined;
    try {
      return readArchiveFileMeta(path, await this.app.vault.read(file));
    } catch {
      return undefined;
    }
  }

  /**
   * 打开「编辑归档信息」弹窗。
   *
   * 编辑对象是**归档文件自己的 `workflow.archive`**（不是原看板上的节点）；
   * 初值从文件现读（`readArchiveMeta`），确认后走 `setWorkflowArchiveInfo`。
   */
  async openArchiveMetaEditor(path: string): Promise<ModalEditOutcome<ArchiveInfoEditResult>> {
    // Phase 41：元数据与标签枚举一起现读（标签候选不许吃启动缓存）
    const [meta, tags] = await Promise.all([this.readArchiveMeta(path), this.refreshArchiveTags()]);
    if (meta === undefined) {
      new Notice(t("notice.archiveMissing", { path }));
      return { cancelled: true };
    }
    const model: ArchiveInfoModel = {
      title: meta.fromNode ?? meta.title,
      summary: meta.summary,
      idea: meta.idea,
      review: meta.review,
      tag: meta.tag,
    };
    const modal = new ArchiveInfoModal(
      this.app,
      model,
      (form) => this.setWorkflowArchiveInfo(path, meta.workflowId, form),
      tags,
    );
    const outcome = await modal.openAndWait();
    return outcome === undefined ? { cancelled: true } : { cancelled: false, result: outcome };
  }

  /**
   * 按 workflow id 在 `archive/` 里找到那份归档并开成看板。
   *
   * `node.archive` 只剩 `{ workflowId }`（没有路径），所以定位只能扫一遍归档目录。
   * 找不到时提示里**带上 workflowId**，用户能据此在 `archive/` 里手查。
   */
  openArchiveBoardByWorkflowId(workflowId: string): void {
    void (async () => {
      for (const path of this.archiveBoardFiles()) {
        const meta = await this.readArchiveMeta(path);
        if (meta?.workflowId !== workflowId) continue;
        void this.openBoardAt(path);
        return;
      }
      new Notice(t("notice.archiveMissingById", { id: workflowId }));
    })();
  }

  /* ---------------------------------------------------------------- *
   * Phase 39：归档标签（archive_tag.yaml，看板根目录）
   * ---------------------------------------------------------------- */

  /** archive_tag.yaml 的 vault 相对路径 */
  private archiveTagPath(): string {
    return `${boardFolderOf()}/${ARCHIVE_TAG_FILE}`;
  }

  /** 启动时读一次归档标签枚举进缓存（文件不存在 / 解析失败 → 空） */
  private async reloadArchiveTags(): Promise<void> {
    const file = this.app.vault.getAbstractFileByPath(this.archiveTagPath());
    if (!(file instanceof TFile)) {
      this.archiveTagCache = [];
      return;
    }
    try {
      this.archiveTagCache = parseArchiveTagYaml(await this.app.vault.read(file));
    } catch {
      this.archiveTagCache = [];
    }
  }

  /** 当前归档标签枚举（同步：视图渲染时直接拿缓存） */
  archiveTags(): string[] {
    return [...this.archiveTagCache];
  }

  /**
   * Phase 41：重扫 `archive_tag.yaml` 再返回标签枚举（打开「已归档」弹窗 / 归档表单时调）。
   *
   * `archiveTags()` 是启动时读的那一份缓存，用户刚在 yaml 里加的词它不知道 ——
   * 三个入口（已归档弹窗 / 编辑归档信息 / 为此及之后归档）都要现读，所以多一个异步入口。
   * 文件不在 / 解析失败 → 空数组（与 `reloadArchiveTags` 同口径，不抛错）。
   */
  async refreshArchiveTags(): Promise<string[]> {
    await this.reloadArchiveTags();
    return this.archiveTags();
  }

  /** 把新出现的标签并入 archive_tag.yaml（去重排序后整文件写回） */
  async addArchiveTags(newTags: readonly string[]): Promise<void> {
    const incoming = newTags.map((tag) => tag.trim()).filter((tag) => tag.length > 0);
    this.archiveTagCache = [...new Set([...this.archiveTagCache, ...incoming])].sort();
    const text = stringifyArchiveTagYaml(this.archiveTagCache);
    const folder = boardFolderOf();
    if (this.app.vault.getAbstractFileByPath(folder) === null) {
      await this.app.vault.createFolder(folder);
    }
    const path = this.archiveTagPath();
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing instanceof TFile) await this.app.vault.modify(existing, text);
    else await this.app.vault.create(path, text);
  }
  /* ---------------------------------------------------------------- *
   * Phase 25：主看板（命令面板 / ribbon 图标的唯一入口）
   * ---------------------------------------------------------------- */

  /**
   * 打开 workflow watcher 主看板（命令面板与左侧 ribbon 图标都走这里）。
   *
   * 落点是一对**同名同键**的文件（命名规则见 `src/engine/mainBoard.ts`）：
   * `_workflowwatcher/main~<key>.md` + `_workflowwatcher/main~<key>.wf.json`。
   *  - 文件夹没有 → 建 `_workflowwatcher/`（逐级建，见 `ensureFolder`）；
   *  - 老命名 `main.md` 在 → 改名成带键的规范名（键是常量，侧车原地不动）；
   *  - md / json 缺哪个补哪个，**已有的那份绝不覆盖**；
   *  - 两件都在 → 一个字都不写，直接开看板（幂等）；
   *  - 有多份「像主看板」的 md（`main_2.md` …）→ 打开排第一的那份 + 提示一次。
   *
   * 开的是**看板** leaf（不是 md 源码页）：看板自己就是渲染宿主，md 只是数据的伴生文本。
   */
  async openMainBoard(): Promise<void> {
    try {
      const path = await this.ensureMainBoard();
      await this.openBoardAt(path);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`wfjson：打开主看板失败（${mainBoardPath()}）`, error);
      new Notice(t("notice.mainBoardFailed", { message }));
    }
  }

  /**
   * 确保主看板的两件文件都在，返回 md 的 vault 相对路径（可能是用户手工复制的那份，见下）。
   *
   * 幂等是先决条件（每次点图标都会调到）：两件都在时**不读不写**，
   * 不会碰用户在看板里 / 在 md 里写下的内容。
   *
   * 顺序：先把老命名改成规范名 → 再找「像主看板」的 md（规范名优先，多份只取第一份 + 提示）
   * → 缺侧车就补 → 一份都没有才按模板现造。
   */
  private async ensureMainBoard(): Promise<string> {
    await this.ensureFolder(boardFolderOf());
    await this.renameLegacyMainBoard();

    const candidates = this.mainBoardCandidates();
    if (candidates.length > 1) {
      // 多份：只认第一份（规范名优先），**不删不合并** —— 手工复制的那几份可能真有没同步过来的内容
      new Notice(t("notice.mainBoardDuplicate", { count: String(candidates.length), path: candidates[0] }));
    }

    if (candidates.length > 0) {
      const path = candidates[0];
      const note = this.app.vault.getAbstractFileByPath(path);
      if (!(note instanceof TFile)) throw new Error(t("reject.pathOccupied", { path }));
      // 侧车缺失前先试着认领「老目录改名留下的那份」（键漂移 → 看板读不到 json）
      await this.adoptLegacyMainSidecar();
      if (!(this.app.vault.getAbstractFileByPath(sidecarPathFor(path)) instanceof TFile)) {
        await this.createMainSidecar(note);
      }
      return path;
    }
/*
    const occupied = this.app.vault.getAbstractFileByPath(MAIN_BOARD_PATH);
    if (occupied !== null) {
      // 同名目录占了 md 的位置：宁可报错也不去动用户的东西
      throw new Error(t("reject.pathOccupied", { path: MAIN_BOARD_PATH }));
    }*/

    // md 不在：按模板造一份（json 先落盘、md 后落盘 —— 与归档同序，中断也不会留下「有数据没伴生文本」）
    const now = new Date();
    const document = buildTemplateDocument({ now }); // ← 唯一一次构造
    const boardPath = mainBoardPath();
    const pair = planSidecarPair(
      boardPath,
      buildWorkflowTemplate({ includeRenderBlock: false, now, document }),
      document, // ← 侧车 JSON 用同一个 document
    );
/*    const pair = planSidecarPair(
      MAIN_BOARD_PATH,
      buildWorkflowTemplate({ includeRenderBlock: false, now }),
      buildTemplateDocument({ now }),
    );
*/
    // 侧车已存在（用户手删了 md）时保留它：它才是数据本体，md 只是伴生文本
    const sidecar = this.app.vault.getAbstractFileByPath(pair.sidecarPath);
    if (!(sidecar instanceof TFile)) await this.app.vault.create(pair.sidecarPath, pair.jsonText);
    await this.app.vault.create(boardPath, pair.noteMarkdown);
    new Notice(t("notice.mainBoardCreated", { path: boardPath }));
    return boardPath;
  }

  /**
   * 老命名 `main.md` → 带键的规范名 `main~<key>.md`。
   *
   * 键是**常量**（由基准路径 `_workflowwatcher/main.md` 算出），所以改名前后是同一个键 ——
   * 侧车 `main~<key>.wf.json` **原地不动**（rename 钩子算出的新旧侧车路径相同，`from === to` 早退）。
   */
  private async renameLegacyMainBoard(): Promise<void> {
    const canonical = mainBoardPath();
    const legacyPath = legacyMainBoardPath();
    const legacy = this.app.vault.getAbstractFileByPath(legacyPath);
    if (!(legacy instanceof TFile)) return;
    // 规范名已经在 → 两份都留着，交给「多份主看板」的提示，绝不覆盖
    if (this.app.vault.getAbstractFileByPath(canonical) !== null) return;
    try {
      await this.app.fileManager.renameFile(legacy, canonical);
      new Notice(t("notice.mainBoardRenamed", { from: legacyPath, to: canonical }));
    } catch (error) {
      // 改不了名不影响使用：老名字算出来的键完全相同，读盘照样找得到侧车
      console.error(`wfjson：主看板改名失败（${legacyPath} → ${canonical}）`, error);
    }
  }

  /**
   * `_workflowwatcher/` 第一层里「像主看板」的 md，**规范名排第一**（`rankMainBoardPaths`）。
   *
   * 只看第一层的 md：`backup/` 里是 `.bak`、子目录是老镜像侧车，都不参与。
   */
  private mainBoardCandidates(): string[] {
    const folder = this.app.vault.getAbstractFileByPath(boardFolderOf());
    if (!(folder instanceof TFolder)) return [];
    const paths: string[] = [];
    for (const child of folder.children) {
      if (child instanceof TFile && child.extension.toLowerCase() === "md") paths.push(child.path);
    }
    return rankMainBoardPaths(paths);
  }

  /**
   * 早期目录改名（`_wfjson/` → `_workflowwatcher/`）留下的**键漂移**修一次。
   *
   * 侧车文件名里的键是按**当时的完整路径**算出来的，目录改名后与 md 现在算出来的键对不上 →
   * 看板「有 md 却读不到 json」。这里只认**一个确定的老键**（`_wfjson/main.md` 算出的那个）：
   * 正好存在就把它改名成规范名，数据原样读回来。
   *
   * 故意**不**扫「所有 `main~*.wf.json`」—— 用户自己的 `main.md` 笔记，侧车也叫这个名字，
   * 扫了就会把别人的数据抢过来。
   */
  private async adoptLegacyMainSidecar(): Promise<void> {
    const target = mainBoardSidecarPath();
    if (this.app.vault.getAbstractFileByPath(target) !== null) return;
    const legacy = sidecarPathFor(`${LEGACY_WFJSON_FOLDER}/${MAIN_BOARD_STEM}.md`);
    if (legacy === target) return;
    const file = this.app.vault.getAbstractFileByPath(legacy);
    if (!(file instanceof TFile)) return;
    try {
      await this.app.fileManager.renameFile(file, target);
    } catch (error) {
      console.error(`wfjson：主看板侧车改名失败（${legacy} → ${target}）`, error);
    }
  }

  /**
   * 主看板 md 在、侧车 json 不在：补一份侧车（**不覆盖**任何东西）。
   *
   * 两条路：
   *  - md 里还有 `wfjson` 代码块 → 走迁移口径搬进侧车（顺带摘掉代码块、frontmatter 补 `wf-key`）；
   *  - 已经没有代码块（用户手删过 json）→ 按模板补一份空工作流的侧车，让看板先能起来，
   *    之后的写回会把 md 的 frontmatter / 纪要段对齐过去。
   */
  private async createMainSidecar(note: TFile): Promise<void> {
    const markdown = await this.app.vault.read(note);
    const plan = planSidecarMigration(markdown, note.path, { now: new Date() });
    if (plan.success && plan.document !== undefined) {
      await this.app.vault.create(plan.sidecarPath, plan.jsonText);
      await this.app.vault.process(note, () => plan.noteMarkdown);
      return;
    }
    const pair = planSidecarPair(note.path, markdown, buildTemplateDocument({ now: new Date() }));
    await this.app.vault.create(pair.sidecarPath, pair.jsonText);
  }

  /**
   * dataviewjs 视图入口：笔记里只写一行
   *
   * ```dataviewjs
   * await app.plugins.plugins["workflow-watcher"].render(dv);
   * // 也可显式指定本视图主题（优先于 frontmatter wf-theme / 全局默认）：
   * await app.plugins.plugins["workflow-watcher"].render(dv, { theme: "tech" });
   * ```
   */
  async render(dv: unknown, options: WfViewOptions = {}): Promise<void> {
    if (!isViewApi(dv)) {
      new Notice(t("notice.noDv"));
      return;
    }
    await renderWorkflowView(this, dv, options);
  }

  /** 视图要的提示通道（视图不直接依赖 Obsidian 运行时，便于单测） */
  notify(message: string): void {
    new Notice(message);
  }

  /**
   * Phase 16：视图侧边栏的「⚙️ 插件设置」。
   *
   * Obsidian 没有公开 API，这里走内部对象 `app.setting`（`open()` + `openTabById(id)`，
   * 社区插件的通用写法）。版本差异 / 对象被禁用时**只提示、不抛错** —— 设置页打不开不该影响视图。
   */
  openSettings(): void {
    const setting = (this.app as unknown as {
      setting?: { open?: () => void; openTabById?: (id: string) => void };
    }).setting;
    if (setting?.open === undefined || setting.openTabById === undefined) {
      new Notice(t("notice.settingsOpenFailed"));
      return;
    }
    setting.open();
    setting.openTabById(this.manifest.id);
  }

  /* ---
   * Phase 26：导入 / 导出数据（契约 doc/datacontact/phase26_bound.md §5）
   *
   * 视图层只发起调用（`importData` / `exportData`），路径解析、读写、体检、弹窗、确认、写盘
   * 全在这里 —— 视图不碰 Node fs，也不该知道库在磁盘上的位置。
   * --- */

  /**
   * 读「用户填的那个路径」的文本（口径 7：任意绝对路径都行）。
   *
   * 依次试三条：
   *  1. 库内**相对**路径（用户可能直接粘 `_workflowwatcher/main~x.wf.json`）；
   *  2. 库内**绝对**路径（去掉 `basePath` 前缀后再找一次）；
   *  3. 以上都不是 → 库外，走 Node `fs`（桌面端才有）。
   */
  private async readSourceText(rawPath: string): Promise<string> {
    const path = rawPath.trim();
    if (path.length === 0) throw new Error(t("view.data.jsonPath"));

    const direct = this.app.vault.getAbstractFileByPath(normalizeVaultPath(path));
    if (direct instanceof TFile) return this.app.vault.read(direct);

    const relative = vaultRelativePath(this.app, path);
    if (relative !== undefined) {
      const file = this.app.vault.getAbstractFileByPath(relative);
      if (file instanceof TFile) return this.app.vault.read(file);
    }

    // 库外：`fs` 只在 Obsidian 桌面版（Electron）可用；移动端会抛，由调用方转成提示
    return readFileSync(path, "utf8");
  }

  /**
   * 导出数据（口径 7 / §5.2）：把当前看板的 JSON 路径 + 备份副本路径摊给用户复制。
   *
   * 只**显示**路径，不复制文件 —— 复制由用户在文件管理器里做（插件不该替他决定目标目录）。
   * 数据只走侧车 JSON，笔记正文不再出现在导出清单里。
   */
  exportData(file: TFile): void {
    const sidecar = this.findSidecarFile(file);
    const jsonPath = sidecar?.path ?? sidecarPathFor(file.path);
    const mobile = vaultBasePath(this.app) === undefined;
    const entries: ExportPathEntry[] = [
      { label: t("dialog.export.json"), path: absoluteVaultPath(this.app, jsonPath), copyable: true },
      {
        label: t("dialog.export.backupJson"),
        path: absoluteVaultPath(this.app, backupPathFor(jsonPath)),
        copyable: false,
      },
    ];
    new ExportDataModal(this.app, entries, mobile, (message) => this.notify(message)).open();
  }

  /**
   * 从任意绝对路径导入（§5.3）。
   *
   * 顺序不能反：**先读源 → 体检 → 计划 → 用户确认 → 总闸门 → 写侧车 JSON**。
   * 每一步都「要么全做、要么一个字节都不写」：任何一个环节不过就只弹报告，不动盘上的东西。
   *
   * Phase 27：导入**只并 JSON**（纪要段范式弃用，§5.2）→ 完全不需要读笔记正文，
   * 目标 md 也不会被写；本方法只碰侧车。
   */
  async importData(file: TFile, jsonPath: string): Promise<void> {
    const sidecar = this.findSidecarFile(file);
    if (sidecar === undefined) {
      this.notify(t("notice.import.invalid"));
      return;
    }

    /* 1. 读源 */
    let jsonText: string;
    try {
      jsonText = await this.readSourceText(jsonPath);
    } catch (error) {
      const failed = errorMessageOf(error);
      this.notify(t("notice.import.readFailed", { path: jsonPath, reason: failed }));
      return;
    }

    /* 2. 体检 */
    const inspection = inspectImport({ jsonText, jsonPath });
    if (!inspection.ok || inspection.document === undefined) {
      this.notify(t("notice.import.invalid"));
      await new ImportReportModal(this.app, { inspection, confirmable: false, result: false }).openAndWait();
      return;
    }

    /* 3. 读目标 + 算计划（只看侧车 JSON，笔记正文不参与） */
    const targetJsonText = await this.app.vault.read(sidecar);
    const current = analyzeDocument({
      noteMarkdown: "",
      jsonText: targetJsonText,
      jsonSource: "sidecar",
      jsonFile: sidecar.path,
      file: file.path,
    });
    const target = current.latestDocument ?? current.document;
    if (target === undefined) {
      this.notify(t("notice.import.invalid"));
      return;
    }
    const plan = planWorkflowImport({
      target,
      incoming: inspection.document,
    });

    if (!plan.changed) {
      this.notify(t("notice.import.nothing"));
      await new ImportReportModal(this.app, { inspection, plan, confirmable: false, result: true }).openAndWait();
      return;
    }

    /* 4. 用户确认 */
    const confirmed = await new ImportReportModal(this.app, {
      inspection,
      plan,
      confirmable: true,
      result: false,
    }).openAndWait();
    if (confirmed !== true) return;

    /* 5. 总闸门（I5）：合并结果必须仍然无 error，否则一个字节都不写 */
    const jsonAfter = stringifyWfJson(plan.document);
    const verify = analyzeDocument({
      noteMarkdown: "",
      jsonText: jsonAfter,
      jsonSource: "sidecar",
      jsonFile: sidecar.path,
      file: file.path,
    });
    if (verify.hasError) {
      await new ImportReportModal(this.app, {
        inspection,
        plan,
        confirmable: false,
        result: false,
        failure: formatIssues(verify.issues, { maxIssues: 10 }),
      }).openAndWait();
      this.notify(t("notice.import.invalid"));
      return;
    }

    /* 6. 写盘：只写侧车 JSON（笔记正文不参与导入，也不被写） */
    try {
      await this.app.vault.process(sidecar, () => jsonAfter);
    } catch (error) {
      this.notify(t("notice.import.writeFailed", { reason: errorMessageOf(error) }));
      return;
    }

    /* 7. 结果 */
    this.notify(t("notice.import.added", { count: plan.addedWorkflowIds.length }));
    await new ImportReportModal(this.app, { inspection, plan, confirmable: false, result: true }).openAndWait();
  }

  /* ---
   * Phase 37：批量导入 / 导出（「导入 / 导出」小工具的三段式界面）
   *
   * 与 `importData` / `exportData` 同一个分工：视图只发起，读源 / 体检 / 合并 / 写盘 / 提示全在这里。
   * 两条新语义：
   *  - `mode = "board"`：多个源**累加**合并（一次确认 + 一次写盘）；
   *  - `mode = "archive"`：每个源里的每条 workflow 落成一份 `archive/*.wf.json`（全局视角，不动看板）。
   * --- */

  /** `<boardFolder>/archive/*.wf.json` 的 vault 相对路径（已归档弹窗的「全局视角」区块） */
  archiveBoardFiles(): string[] {
    const folder = this.app.vault.getAbstractFileByPath(archiveFolderOf());
    if (!(folder instanceof TFolder)) return [];
    const files: string[] = [];
    for (const child of folder.children) {
      if (child instanceof TFile && child.path.toLowerCase().endsWith(".wf.json")) files.push(child.path);
    }
    return files.sort((left, right) => left.localeCompare(right));
  }

  /** 导出清单：当前看板 JSON + 全部归档 JSON（绝对路径；当前看板排第一） */
  boardJsonPaths(file: TFile): string[] {
    const sidecar = this.findSidecarFile(file);
    const jsonPath = sidecar?.path ?? sidecarPathFor(file.path);
    return [jsonPath, ...this.archiveBoardFiles()].map((path) => absoluteVaultPath(this.app, path));
  }

  /** 桌面端多选 JSON（取消 / 移动端 / 拿不到文件对话框 → 空数组） */
  async pickImportJsonPaths(): Promise<string[]> {
    if (!Platform.isDesktop) return [];
    const dialog = this.electronDialog();
    if (dialog === undefined) return [];
    const options: ElectronOpenDialogOptions = {
      title: t("view.data.pickTitle"),
      properties: ["openFile", "multiSelections"],
      filters: [{ name: "JSON", extensions: ["json"] }],
    };
    const base = vaultBasePath(this.app);
    if (base !== undefined) options.defaultPath = base;
    try {
      const result = await dialog.showOpenDialog(options);
      const picked = result.filePaths;
      if (!Array.isArray(picked)) return [];
      return picked.filter((path): path is string => typeof path === "string" && path.length > 0);
    } catch (error) {
      this.notify(t("view.data.pickFailed", { reason: errorMessageOf(error) }));
      return [];
    }
  }

  /** 复制到剪贴板（失败 / 不可用时只提示，不抛错） */
  copyText(text: string): void {
    const clipboard = window.navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) {
      this.notify(t("dialog.export.copyFailed"));
      return;
    }
    void clipboard
      .writeText(text)
      .then(() => this.notify(t("dialog.export.copied")))
      .catch(() => this.notify(t("dialog.export.copyFailed")));
  }

  /** 批量导入入口：交给下面两条私有链路（`"archive"` 完全不动当前看板） */
  async importJsonPaths(file: TFile, paths: readonly string[], mode: "board" | "archive"): Promise<void> {
    if (paths.length === 0) return;
    if (mode === "archive") {
      await this.importAsArchiveFiles(paths);
      return;
    }
    await this.importIntoBoard(file, paths);
  }
  /**
   * 多个源并进**当前看板**：读全部源 → 逐个累加 `planWorkflowImport` → 一个确认弹窗 → 写一次。
   * 任何一个源读不到 / 体检不通过都不会拖累其它源（它只是不参与合并，错误照样进报告）。
   */
  private async importIntoBoard(file: TFile, paths: readonly string[]): Promise<void> {
    const sidecar = this.findSidecarFile(file);
    if (sidecar === undefined) {
      this.notify(t("notice.import.invalid"));
      return;
    }

    /* 1. 读 + 体检全部源 */
    const inspections: ImportInspection[] = [];
    const errors: string[] = [];
    const warnings: string[] = [];
    let workflowCount = 0;
    let nodeCount = 0;
    for (const path of paths) {
      let jsonText: string;
      try {
        jsonText = await this.readSourceText(path);
      } catch (error) {
        errors.push(`${path}：${errorMessageOf(error)}`);
        continue;
      }
      const inspection = inspectImport({ jsonText, jsonPath: path });
      errors.push(...inspection.errors);
      warnings.push(...inspection.warnings);
      workflowCount += inspection.workflowCount;
      nodeCount += inspection.nodeCount;
      if (inspection.document !== undefined) inspections.push(inspection);
    }
    const inspection: ImportInspection = {
      ok: errors.length === 0,
      errors,
      warnings,
      workflowCount,
      nodeCount,
      jsonPath: paths.join("、"),
    };

    /* 2. 读目标 + 逐个源累加合并计划（`planWorkflowImport` 是纯函数，链式调用即可） */
    const targetJsonText = await this.app.vault.read(sidecar);
    const current = analyzeDocument({
      noteMarkdown: "",
      jsonText: targetJsonText,
      jsonSource: "sidecar",
      jsonFile: sidecar.path,
      file: file.path,
    });
    let target = current.latestDocument ?? current.document;
    if (target === undefined) {
      this.notify(t("notice.import.invalid"));
      return;
    }
    const addedWorkflowIds: string[] = [];
    const skippedWorkflows: ImportSkippedWorkflow[] = [];
    for (const item of inspections) {
      const source = item.document;
      if (source === undefined) continue;
      const step = planWorkflowImport({ target, incoming: source });
      target = step.document;
      addedWorkflowIds.push(...step.addedWorkflowIds);
      skippedWorkflows.push(...step.skippedWorkflows);
    }
    const plan: ImportPlanResult = {
      document: target,
      addedWorkflowIds,
      skippedWorkflows,
      changed: addedWorkflowIds.length > 0,
    };

    if (!plan.changed) {
      this.notify(t(inspection.ok ? "notice.import.batchNothing" : "notice.import.invalid"));
      await new ImportReportModal(this.app, {
        inspection,
        plan,
        confirmable: false,
        result: inspection.ok,
      }).openAndWait();
      return;
    }

    /* 3. 用户确认 */
    const confirmed = await new ImportReportModal(this.app, {
      inspection,
      plan,
      confirmable: true,
      result: false,
    }).openAndWait();
    if (confirmed !== true) return;

    /* 4. 总闸门（I5）：合并结果必须仍然无 error，否则一个字节都不写 */
    const jsonAfter = stringifyWfJson(plan.document);
    const verify = analyzeDocument({
      noteMarkdown: "",
      jsonText: jsonAfter,
      jsonSource: "sidecar",
      jsonFile: sidecar.path,
      file: file.path,
    });
    if (verify.hasError) {
      await new ImportReportModal(this.app, {
        inspection,
        plan,
        confirmable: false,
        result: false,
        failure: formatIssues(verify.issues, { maxIssues: 10 }),
      }).openAndWait();
      this.notify(t("notice.import.invalid"));
      return;
    }

    /* 5. 写盘：只写侧车 JSON */
    try {
      await this.app.vault.process(sidecar, () => jsonAfter);
    } catch (error) {
      this.notify(t("notice.import.writeFailed", { reason: errorMessageOf(error) }));
      return;
    }

    this.notify(t("notice.import.added", { count: plan.addedWorkflowIds.length }));
    await new ImportReportModal(this.app, { inspection, plan, confirmable: false, result: true }).openAndWait();
  }



  /**
   * 多个源落成**归档文件**：每个源里的每条 workflow 写成一份
   * `archive/<workflowId>-<rootNodeId>.wf.json`（已存在的不覆盖 —— 与 `createArchiveFile` 同口径）。
   *
   * 归档日期**不写**（`archivedAt` 留空）：导入的东西没有「什么时候归档」这个事实，编一个更糟。
   * 本方法**不碰任何看板**（全局视角：主看板 JSON 一个字都不改）。
   */
  private async importAsArchiveFiles(paths: readonly string[]): Promise<void> {
    const now = new Date();
    let written = 0;
    let skipped = 0;
    for (const path of paths) {
      let jsonText: string;
      try {
        jsonText = await this.readSourceText(path);
      } catch {
        skipped += 1;
        continue;
      }
      const inspection = inspectImport({ jsonText, jsonPath: path });
      const source = inspection.document;
      if (!inspection.ok || source === undefined) {
        skipped += 1;
        continue;
      }
      const archivedAt = formatArchivedAt(now);
      for (const workflow of source.workflows) {
        const archivePath = archiveFilePathFor(workflow.title, workflow.root.title, workflow.root.id, now);
        if (this.app.vault.getAbstractFileByPath(archivePath) !== null) {
          skipped += 1;
          continue;
        }
        // Phase 39：导入成归档 = archivedAt 取导入时刻、来源 = 导入时那条工作流；
        // 说明文字（summary / idea / review / tag）留空，用户可以在「已归档」弹窗里再编辑
        const archiveMeta: WfWorkflowArchive = buildWorkflowArchive({}, archivedAt, workflow.title, workflow.root.title);
        const archivedWorkflow: WfWorkflow = { ...workflow, archive: archiveMeta };
        delete archivedWorkflow.state;
        const archiveDocument: WfJsonDocument = {
          schemaVersion: SCHEMA_VERSION,
          id: newFileId(),
          updatedAt: formatLocalIso(now),
          archivedAt: formatLocalIso(now),
          workflows: [archivedWorkflow],
        };
        await this.createArchiveFile(archivePath, archiveDocument);
        written += 1;
      }
    }
    if (written > 0) this.notify(t("notice.import.archiveAdded", { count: written }));
    if (skipped > 0) this.notify(t("notice.import.archiveSkipped", { count: skipped }));
    if (written === 0 && skipped === 0) this.notify(t("notice.import.batchNothing"));
  }


  /* ---------------------------------------------------------------- *
   * v0.7 §⑧ 外置 JSON：目录同步（rename / delete）与主看板文件维护
   * ---------------------------------------------------------------- */

  /** 逐级确保目录存在（`vault.createFolder` 不保证递归建父目录） */
  private async ensureFolder(path: string): Promise<void> {
    if (path.length === 0) return;
    let cursor = "";
    for (const segment of path.split("/")) {
      cursor = cursor.length === 0 ? segment : `${cursor}/${segment}`;
      if (this.app.vault.getAbstractFileByPath(cursor) !== null) continue;
      await this.app.vault.createFolder(cursor);
    }
  }

  /* ---------------------------------------------------------------- *
   * Phase 25 备份：md + 侧车 json 每次创建 / 修改都往 `backup/` 镜像一份
   * ---------------------------------------------------------------- */

  /**
   * 该不该备份（只覆盖插件自管的数据文件，**不碰**用户笔记里的内联 wfjson）：
   *  - `_workflowwatcher/` 下除 `backup/` 以外的 `.md` / `.wf.json`
   *    （主看板 + 全部侧车 + Phase 28 的归档 JSON）。
   */
  private isBackupSource(file: TFile): boolean {
    const path = file.path;
    if (isBackupPath(path)) return false;
    const lower = path.toLowerCase();
    if (!lower.endsWith(".md") && !lower.endsWith(".wf.json")) return false;
    return isSidecarPath(path);
  }

  /** 创建事件 → 写一份备份（`isBackupPath` 在 `isBackupSource` 里早退，防自触发死循环） */
  private async syncBackupOnCreate(abstract: TAbstractFile): Promise<void> {
    if (abstract instanceof TFile) await this.writeBackupCopy(abstract);
  }

  /** 修改事件 → 覆盖更新备份（镜像最新，不累计历史） */
  private async syncBackupOnModify(abstract: TAbstractFile): Promise<void> {
    if (abstract instanceof TFile) await this.writeBackupCopy(abstract);
  }

  /**
   * 把 `file` 的当前内容写到备份副本（不存在就建、存在就覆盖）。
   *
   * 只服务于「创建 / 修改」两个事件；删除事件**不碰备份** —— 源删了副本留着，这正是备份的意义。
   * md 副本名会补上身份键（`backupPathFor`），与它的侧车副本同名同键、只差后缀 → 一眼看出是一对。
   */
  private async writeBackupCopy(file: TFile): Promise<void> {
    if (!this.isBackupSource(file)) return;
    const target = backupPathFor(file.path);
    try {
      const folder = parentFolderOf(target);
      if (this.app.vault.getAbstractFileByPath(folder) === null) {
        try {
          await this.ensureFolder(folder);
        } catch (error) {
          // 两个写事件几乎同时到达时可能都被判成「目录不存在」：建完再确认一次，真没有才抛
          if (this.app.vault.getAbstractFileByPath(folder) === null) throw error;
        }
      }
      const content = await this.app.vault.read(file);
      const existing = this.app.vault.getAbstractFileByPath(target);
      if (existing instanceof TFile) {
        await this.app.vault.modify(existing, content);
      } else {
        await this.app.vault.create(target, content);
      }
    } catch (error) {
      console.error(`wfjson：写备份失败（${file.path} → ${target}）`, error);
    }
  }

  /**
   * 一次性搬家：老目录 `_wfjson/` → `_workflowwatcher/`（Phase 25 目录改名）。
   *
   * 只在「老的在、新的不在」时整目录改名：里面的老镜像路径一字不动，
   * `legacySidecarPathFor()` 兜底照样读得到，主看板等新文件随后落进新目录。
   * 两个目录都在 = 用户自己搬过一半 → **不猜不合并**，只提示一句（绝不覆盖任何文件）。
   */
  private async migrateLegacyFolder(): Promise<void> {
    const legacy = this.app.vault.getAbstractFileByPath(LEGACY_WFJSON_FOLDER);
    if (!(legacy instanceof TFolder)) return;
    const target = boardFolderOf();
    if (this.app.vault.getAbstractFileByPath(target) !== null) {
      new Notice(t("notice.folderConflict", { from: LEGACY_WFJSON_FOLDER, to: target }));
      return;
    }
    try {
      await this.app.fileManager.renameFile(legacy, target);
      new Notice(t("notice.folderMigrated", { from: LEGACY_WFJSON_FOLDER, to: target }));
    } catch (error) {
      console.error(`wfjson：老目录改名失败（${LEGACY_WFJSON_FOLDER} → ${target}）`, error);
    }
  }

  /**
   * 设置里改了「看板文件目录」（Phase 37）：整目录改名 + 立刻切换引擎路径 + 落盘。
   *
   * 安全线（与 `migrateLegacyFolder` 同口径）：
   *  - 目标目录已存在 → **不猜不合并**，提示一句、保持原值；
   *  - 主看板 md / 侧车的**文件名不变**（键是常量，见 `mainBoard.ts`），只有所在目录变；
   *  - 目录不存在（还没产生数据）→ 只切设置，下一次 `openMainBoard` 现建。
   *
   * 返回是否真的切换了（false = 冲突 / 失败，设置保持原样）。
   */
  async applyBoardFolderChange(raw: unknown): Promise<boolean> {
    const next = normalizeBoardFolder(raw);
    const prev = boardFolderOf();
    if (next === prev) {
      this.settings.boardFolder = next;
      await this.saveSettings();
      return true;
    }
    if (this.app.vault.getAbstractFileByPath(next) !== null) {
      new Notice(t("notice.boardFolderConflict", { path: next }));
      return false;
    }
    const source = this.app.vault.getAbstractFileByPath(prev);
    if (source instanceof TFolder) {
      try {
        await this.ensureFolder(parentFolderOf(next));
        await this.app.fileManager.renameFile(source, next);
      } catch (error) {
        new Notice(t("notice.boardFolderFailed", { reason: errorMessageOf(error) }));
        return false;
      }
      new Notice(t("notice.boardFolderMoved", { from: prev, to: next }));
    }
    this.settings.boardFolder = next;
    // 引擎的路径函数从这里开始全指向新目录（侧车 / 主看板 / 归档 / 备份）
    setBoardFolder(next);
    await this.saveSettings();
    return true;
  }

  /**
   * 笔记 / 文件夹改名或移动 → 侧车跟着走。
   *
   * M1.6：侧车在第一层，但**文件名里的身份键跟着完整路径变** —— 所以：
   *  - 笔记改名 / 移动：把它的侧车从旧名搬到新名（扁平名、老镜像名各试一次）；
   *  - 文件夹改名 / 移动：该文件夹下**每篇**笔记的侧车都要改名（老的镜像目录照旧整目录搬）。
   *
   * 目标已存在时**绝不覆盖**（提示用户手工处理），避免两次迁移互相踩。
   */
  private async syncSidecarOnRename(abstract: TAbstractFile, oldPath: string): Promise<void> {
    if (isSidecarPath(oldPath) || isSidecarPath(abstract.path)) return;
    try {
      if (abstract instanceof TFolder) {
        // 先把老的镜像目录整棵搬过去（M1.6 之前的侧车；不存在就跳过）
        await this.moveLegacySidecarFolder(oldPath, abstract.path);
        // 再逐篇搬扁平名（path 已经变成新路径，这里按访问顺序无关）
        const notes = this.app.vault
          .getMarkdownFiles()
          .filter((file) => file.path.startsWith(`${abstract.path}/`));
        for (const note of notes) {
          const renamedFrom = `${oldPath}${note.path.slice(abstract.path.length)}`;
          await this.moveSidecarFile(sidecarPathFor(renamedFrom), sidecarPathFor(note.path));
        }
        return;
      }

      if (!(abstract instanceof TFile) || abstract.extension !== "md") return;
      await this.moveSidecarFile(sidecarPathFor(oldPath), sidecarPathFor(abstract.path));
      // 老形态（镜像路径）也一起搬：搬完仍是老形态，读盘时由 `legacySidecarPathFor` 兜底
      await this.moveSidecarFile(legacySidecarPathFor(oldPath), legacySidecarPathFor(abstract.path));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`wfjson：同步外置 JSON 失败（rename ${oldPath} → ${abstract.path}）`, error);
      new Notice(t("notice.renameFailed", { message }));
    }
  }

  /** 老的镜像目录 `_workflowwatcher/<旧路径>` → `_workflowwatcher/<新路径>`（不是 TFolder 就跳过） */
  private async moveLegacySidecarFolder(oldPath: string, newPath: string): Promise<void> {
    const folderPath = boardFolderOf();
    const from = `${folderPath}/${oldPath}`;
    const folder = this.app.vault.getAbstractFileByPath(from);
    if (!(folder instanceof TFolder)) return;
    const to = `${folderPath}/${newPath}`;
    if (this.app.vault.getAbstractFileByPath(to) !== null) {
      new Notice(t("notice.sidecarExists", { path: to }));
      return;
    }
    await this.ensureFolder(parentFolderOf(to));
    await this.app.fileManager.renameFile(folder, to);
  }

  /** 把一份侧车从 `from` 搬到 `to`（不存在就跳过；目标已存在则提示且不覆盖） */
  private async moveSidecarFile(from: string, to: string): Promise<void> {
    if (from === to) return;
    const source = this.app.vault.getAbstractFileByPath(from);
    if (!(source instanceof TFile)) return;
    if (this.app.vault.getAbstractFileByPath(to) !== null) {
      new Notice(t("notice.sidecarExists", { path: to }));
      return;
    }
    await this.ensureFolder(parentFolderOf(to));
    await this.app.fileManager.renameFile(source, to);
  }

  /**
   * 删除笔记 / 文件夹 → 侧车一起进回收站（尊重 Obsidian「删除时移到回收站」设置）。
   *
   * M1.6：笔记删除时直接按路径删它的侧车；**文件夹删除时**事件已经拿不到子文件了，
   * 所以改成「扫第一层、删掉没有对应笔记的侧车」（`trashOrphanSidecars`）——
   * 刚被删掉的那批笔记的侧车正好全部落在这个集合里。
   */
  private async syncSidecarOnDelete(abstract: TAbstractFile): Promise<void> {
    if (isSidecarPath(abstract.path)) return;
    try {
      if (abstract instanceof TFolder) {
        const mirror = this.app.vault.getAbstractFileByPath(`${boardFolderOf()}/${abstract.path}`);
        if (mirror instanceof TFolder) await this.app.fileManager.trashFile(mirror);
        await this.trashOrphanSidecars();
        return;
      }
      if (!(abstract instanceof TFile) || abstract.extension !== "md") return;
      for (const path of [sidecarPathFor(abstract.path), legacySidecarPathFor(abstract.path)]) {
        const target = this.app.vault.getAbstractFileByPath(path);
        if (target instanceof TFile) await this.app.fileManager.trashFile(target);
      }
    } catch (error) {
      console.error(`wfjson：删除笔记时同步外置 JSON 失败（${abstract.path}）`, error);
    }
  }

  /** 现有笔记的「身份键 → 笔记」表（侧车搬迁 / 孤儿判定共用；只统计 md） */
  private noteIndexByKey(): Map<string, TFile> {
    const index = new Map<string, TFile>();
    for (const file of this.app.vault.getMarkdownFiles()) index.set(noteKeyFor(file.path), file);
    return index;
  }

  /**
   * 第一层里那些「找不到对应笔记」的侧车（笔记被删 / 被外部移走 / 文件夹整体删除留下的）。
   *
   * 判据只看文件名里的身份键：键能对上某篇现存笔记 → 不是孤儿。
   * 老镜像形态（`_workflowwatcher/A/B/…`）不在这里判定 —— 它们按目录镜像反查，插件不再主动搬迁。
   */
  private orphanSidecars(): TFile[] {
    const index = this.noteIndexByKey();
    const folder = this.app.vault.getAbstractFileByPath(boardFolderOf()) as { children?: unknown[] } | null;
    const children = folder?.children;
    if (!Array.isArray(children)) return [];
    const orphans: TFile[] = [];
    for (const child of children) {
      if (!(child instanceof TFile)) continue;
      const parsed = parseSidecarName(child.path);
      if (parsed === undefined || parsed.key === undefined) continue;
      if (!index.has(parsed.key)) orphans.push(child);
    }
    return orphans;
  }

  /** 文件夹删除后清理孤儿侧车（删除路径上的侧车不进这个逻辑，见 `isSidecarPath` 早退） */
  private async trashOrphanSidecars(): Promise<void> {
    for (const orphan of this.orphanSidecars()) {
      try {
        await this.app.fileManager.trashFile(orphan);
      } catch (error) {
        console.error(`wfjson：清理孤儿侧车失败（${orphan.path}）`, error);
      }
    }
  }

  /*
   * Phase 25：手动迁移 / 校验 / 整理命令已下线（主看板是唯一入口）：
   *  - 「迁移当前文件到外置 JSON」「校验当前文件」不再注册；`planSidecarMigration` 仍被主看板补侧车沿用；
   *  - 「整理外置 JSON」的扁平化在 M1.6 已落盘；身份键现在由 `applySidecarMutation`（JSON 的 `noteKey`）
   *    与 `writeBackNote`（frontmatter 的 `wf-key`）在每次写回时维护。
   */
}

/* ------------------------------------------------------------------ *
 * Phase 2 的三个 Modal（契约 §6）
 * ------------------------------------------------------------------ */

/**
 * Phase 25（M4）：**面板内嵌表单**的句柄。
 *
 * `done` 在表单落定（确认 / 取消 / 被换 tab / 关面板）时 resolve；
 * `dispose()` 强制按「取消」收尾（换 tab、关面板时调，绝不碰 DOM）。
 */
interface WfMountedForm<T> {
  readonly done: Promise<T | undefined>;
  dispose(): void;
}

/**
 * Modal 基类：把「打开 → 等用户选完 → 拿到结果」包成 Promise。
 *
 * Obsidian 的 `Modal` 只有 `onOpen` / `onClose` 回调，没有返回值，所以这里补一个
 * `openAndWait()`：确认时子类调 `finish(value)` → 关窗并 resolve(value)；
 * 取消 / Esc / 点遮罩关闭 → resolve(undefined)。调用方据此区分「取消」（静默）与「失败」（提示）。
 *
 * Phase 25（M4）：表单本体搬进 `build(parent)`，于是同一张表单有**两个容器** ——
 * `onOpen()` 用它自己的 `contentEl`（仍作独立弹窗），右侧面板用 `mountInto(body)`（不打开 Modal）。
 * 写回链路完全不变：`collect → save → finish(result)`。
 */
abstract class WfModal<T> extends Modal {
  private resolveOnce: ((value: T | undefined) => void) | null = null;
  private settled = false;
  /** true = 表单挂在右侧面板里（`finish` / `cancel` 都不碰 Modal 容器） */
  protected embedded = false;

  /**
   * 子类实现：把「标题 + 表单 + 底部按钮」建到 `parent` 里。
   * `onOpen()` 传 `this.contentEl`，右侧面板传 tab body —— 两条路走同一份代码。
   */
  abstract build(parent: HTMLElement): void;

  /** Obsidian Modal 入口：建到自己的 contentEl（右侧面板走 `mountInto`） */
  onOpen(): void {
    this.build(this.contentEl);
  }

  /** 打开弹窗并等待结果；用户取消时返回 undefined */
  async openAndWait(): Promise<T | undefined> {
    const promise = new Promise<T | undefined>((resolve) => {
      this.resolveOnce = resolve;
    });
    this.open();
    return promise;
  }

  /**
   * Phase 25（M4）：把表单挂到 `parent`（**不**打开 Modal），返回句柄。
   *
   * 右侧面板的 tab body 用它复用同一张表单；就地校验 / 错误提示 / 写回全都不变，
   * 只是「窗」变成了面板的 body。
   */
  mountInto(parent: HTMLElement): WfMountedForm<T> {
    this.embedded = true;
    const done = new Promise<T | undefined>((resolve) => {
      this.resolveOnce = resolve;
    });
    this.build(parent);
    return { done, dispose: () => this.settle(undefined) };
  }

  /** 子类在「确认」成功时调用（关窗时不会再被当成取消；内嵌模式下由面板自己收） */
  protected finish(value: T): void {
    this.settle(value);
    if (!this.embedded) this.close();
  }

  /** 底部「取消」按钮统一走这里：内嵌模式下只 settle，不碰 Modal 容器 */
  protected cancel(): void {
    if (this.embedded) {
      this.settle(undefined);
      return;
    }
    this.close();
  }

  onClose(): void {
    this.settle(undefined);
    this.contentEl.empty();
  }

  private settle(value: T | undefined): void {
    if (this.settled) return;
    this.settled = true;
    const resolve = this.resolveOnce;
    this.resolveOnce = null;
    resolve?.(value);
  }
}

/** 导出一行：标签 + 路径 + 是否给「复制」按钮 */
interface ExportPathEntry {
  label: string;
  path: string;
  copyable: boolean;
}

/**
 * Phase 26：导出数据弹窗（契约 §5.2 / §5.5）。
 *
 * 只**显示**路径、提供复制 —— 不替用户决定复制到哪（他要在文件管理器里自己粘）。
 * 备份副本那两行不给复制按钮：它们是 `_workflowwatcher/backup/` 下的镜像，
 * 列出来只是让用户知道「还有一份」。
 */
class ExportDataModal extends WfModal<void> {
  private readonly entries: readonly ExportPathEntry[];
  private readonly mobile: boolean;
  private readonly report: (message: string) => void;

  constructor(app: App, entries: readonly ExportPathEntry[], mobile: boolean, report: (message: string) => void) {
    super(app);
    this.entries = entries;
    this.mobile = mobile;
    this.report = report;
  }

  build(parent: HTMLElement): void {
    parent.empty();
    parent.addClass("wfjson-modal");
    parent.createEl("h3", { text: t("dialog.export.title") });
    parent.createEl("p", { cls: "wfjson-modal-subtitle", text: t("dialog.export.hint") });
    if (this.mobile) {
      parent.createEl("p", { cls: "wfjson-field-hint", text: t("dialog.export.relativeHint") });
    }

    for (const entry of this.entries) {
      const row = fieldRow(parent, entry.label);
      const input = row.createEl("input", { type: "text", cls: "wfjson-input", attr: { readonly: "true" } });
      input.value = entry.path;
      if (!entry.copyable) continue;
      const copy = wfButton(row, t("dialog.export.copy"));
      copy.onclick = (): void => this.copy(entry.path);
    }

    const footer = parent.createDiv({ cls: "wfjson-modal-footer" });
    const close = wfButton(footer, t("dialog.import.close"), "cta");
    close.onclick = (): void => this.finish(undefined);
  }

  /** 复制到剪贴板：失败 / 不可用时只提示（不抛错，弹窗不关） */
  private copy(text: string): void {
    const clipboard = window.navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) {
      this.report(t("dialog.export.copyFailed"));
      return;
    }
    void clipboard
      .writeText(text)
      .then(() => this.report(t("dialog.export.copied")))
      .catch(() => this.report(t("dialog.export.copyFailed")));
  }
}

/** 导入报告弹窗的输入 */
interface ImportReportOptions {
  /** 体检结果（工作流 / 节点数量 + 错误与提示） */
  inspection: ImportInspection;
  /** 合并计划（体检通过后才有） */
  plan?: ImportPlanResult;
  /** true = 底部「确认导入」/「取消」（弹窗返回 true / false） */
  confirmable: boolean;
  /** 标题用「导入结果」还是「导入数据」 */
  result: boolean;
  /** 写盘前总闸门失败时的错误清单（`formatIssues` 的产物） */
  failure?: string;
}

/**
 * Phase 26：导入报告弹窗（契约 §5.3 / §5.5）。
 *
 * 同一个类覆盖三种场合：体检不通过（只读，只有「关闭」）、导入前确认（可确认）、导入后结果（只读）。
 * 报告一律用 `.wf-issue-box` / `.wf-issue-pre`（Phase 1 就有的「问题摊开」样式）——
 * 列 20 条错误时只有它能读。
 */
class ImportReportModal extends WfModal<boolean> {
  private readonly options: ImportReportOptions;

  constructor(app: App, options: ImportReportOptions) {
    super(app);
    this.options = options;
  }

  build(parent: HTMLElement): void {
    const { inspection, plan, failure } = this.options;
    parent.empty();
    parent.addClass("wfjson-modal");
    parent.createEl("h3", {
      text: t(this.options.result ? "dialog.import.resultTitle" : "dialog.import.title"),
    });
    if (inspection.jsonPath !== undefined && inspection.jsonPath.length > 0) {
      parent.createEl("p", { cls: "wfjson-field-hint", text: inspection.jsonPath });
    }

    /* 第一屏：数量口径（全是事实，不含错误） */
    parent.createEl("p", {
      cls: "wfjson-modal-subtitle",
      text: t("dialog.import.summary", {
        workflows: inspection.workflowCount,
        nodes: inspection.nodeCount,
      }),
    });
    parent.createEl("p", { cls: "wfjson-field-hint", text: t("dialog.import.bodyUntouched") });

    /* 第二屏：合并计划（有才算） */
    if (plan !== undefined) this.renderPlan(parent, plan);

    /* 第三屏：总闸门失败 / 错误 / 警告 */
    if (failure !== undefined) {
      this.issueBox(parent, t("notice.import.invalid"), failure);
    }
    if (inspection.errors.length > 0) {
      this.issueBox(parent, t("severity.error"), inspection.errors.join("\n"));
    }
    if (inspection.warnings.length > 0) {
      this.issueBox(parent, t("severity.warning"), inspection.warnings.slice(0, 20).join("\n"));
    }

    /* 底部 */
    const footer = parent.createDiv({ cls: "wfjson-modal-footer" });
    if (this.options.confirmable) {
      const cancel = wfButton(footer, t("common.cancel"));
      cancel.onclick = (): void => this.finish(false);
      const confirm = wfButton(footer, t("dialog.import.confirm"), "cta");
      confirm.onclick = (): void => this.finish(true);
      return;
    }
    const close = wfButton(footer, t("dialog.import.close"), "cta");
    close.onclick = (): void => this.finish(false);
  }

  /** 一块「标题 + 等宽正文」（复用 Phase 1 的问题面板样式） */
  private issueBox(parent: HTMLElement, title: string, body: string): void {
    const box = parent.createDiv({ cls: "wf-issue-box" });
    box.createDiv({ cls: "wf-issue-title", text: title });
    box.createEl("pre", { cls: "wf-issue-pre", text: body });
  }

  /** 合并计划的两条事实（有哪条画哪条；Phase 27 起正文不再有动作 → 只剩「追加 / 跳过」） */
  private renderPlan(parent: HTMLElement, plan: ImportPlanResult): void {
    const box = parent.createDiv();
    box.createDiv({ cls: "wfjson-field-hint", text: t("dialog.import.added", { count: plan.addedWorkflowIds.length }) });
    if (plan.skippedWorkflows.length > 0) {
      this.issueBox(
        box,
        t("dialog.import.skipped", { count: plan.skippedWorkflows.length }),
        plan.skippedWorkflows.map((item) => `· ${item.title}（${item.id}）`).join("\n"),
      );
    }
  }
}

/**
 * 「➕ 添加子节点」Modal（Phase 9 表单口径）：
 * 标题必填（红 `*`）；进度 / 总量、重要度 / 紧急度、负责人 / 截止日各占一行两列；
 * 截止日 = 年 / 月 / 日 三文本框，新增时默认「今天 + 7 天」。
 * 其余默认值（status=todo、startAt=现在、id / 锚点自动生成）仍由 `appendChildNode` 决定。
 */
class NewChildModal extends WfModal<AddChildNodeResult> {
  private readonly parent: WfNode;
  private readonly save: (input: AddChildInput) => Promise<AddChildNodeResult>;
  private titleInput: HTMLInputElement | null = null;
  private progressInput: HTMLInputElement | null = null;
  private progressMaxInput: HTMLInputElement | null = null;
  private importanceSelect: HTMLSelectElement | null = null;
  private urgencySelect: HTMLSelectElement | null = null;
  private ownerInput: HTMLInputElement | null = null;
  private dueAtInputs: DueDateInputs | null = null;
  private errorEl: HTMLElement | null = null;
  private saveButton: HTMLButtonElement | null = null;

  constructor(app: App, parent: WfNode, save: (input: AddChildInput) => Promise<AddChildNodeResult>) {
    super(app);
    this.parent = parent;
    this.save = save;
  }

  build(parent: HTMLElement): void {
    const contentEl = parent;
    contentEl.empty();
    contentEl.addClass("wfjson-modal");
    contentEl.createEl("h3", { cls: "wf-panel-title", text: t("dialog.addChild.title", { title: this.parent.title }) });
    contentEl.createEl("p", {
      cls: "wfjson-modal-subtitle",
      text: t("dialog.addChild.desc"),
    });

    const titleRow = fieldRow(contentEl, t("field.title"), true);
    const titleInput = titleRow.createEl("input", { type: "text", cls: "wfjson-input" });
    titleInput.placeholder = t("dialog.addChild.titlePlaceholder");
    titleInput.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") void this.onConfirm();
    });
    this.titleInput = titleInput;

    const grid = contentEl.createDiv({ cls: "workflow-watcher-grid" });
    this.progressInput = this.numberField(grid, t("field.progress"), undefined, 0, 999);
    this.progressMaxInput = this.numberField(grid, t("field.progressMax"), undefined, 0, 999);
    this.importanceSelect = this.scaleField(grid, t("field.importance"), undefined, IMPORTANCE_LABELS);
    this.urgencySelect = this.scaleField(grid, t("field.urgency"), undefined, URGENCY_LABELS);
    this.ownerInput = this.textField(grid, t("field.ownerOptional"), "");
    this.dueAtInputs = dueDateField(grid, t("field.dueAtDefault"), undefined, localDateAfter(7));

    this.errorEl = contentEl.createDiv({ cls: "wfjson-modal-error" });

    const footer = contentEl.createDiv({ cls: "wfjson-modal-footer" });
    const cancel = wfButton(footer, t("common.cancel"));
    cancel.onclick = (): void => this.cancel();
    const confirm = wfButton(footer, t("common.add"), "cta");
    confirm.onclick = (): void => void this.onConfirm();
    this.saveButton = confirm;

    titleInput.focus();
  }

  private numberField(
    parent: HTMLElement,
    label: string,
    value: number | undefined,
    min: number,
    max: number,
  ): HTMLInputElement {
    const row = fieldRow(parent, label);
    const input = row.createEl("input", {
      type: "number",
      cls: "wfjson-input",
      attr: { min: `${min}`, max: `${max}`, step: "1" },
    });
    if (value !== undefined) input.value = `${value}`;
    return input;
  }

  private textField(parent: HTMLElement, label: string, value: string): HTMLInputElement {
    const row = fieldRow(parent, label);
    const input = row.createEl("input", { type: "text", cls: "wfjson-input" });
    input.value = value;
    return input;
  }

  private scaleField(
    parent: HTMLElement,
    label: string,
    value: number | undefined,
    labels: Readonly<Record<number, string>>,
  ): HTMLSelectElement {
    const row = fieldRow(parent, label);
    const select = row.createEl("select", { cls: "wfjson-input" });
    select.createEl("option", { value: "", text: t("common.unset") });
    for (const [key, text] of Object.entries(labels)) {
      select.createEl("option", { value: key, text: `${key} · ${text}` });
    }
    select.value = value === undefined ? "" : `${value}`;
    return select;
  }

  private async onConfirm(): Promise<void> {
    this.setError("");

    const rawTitle = this.titleInput?.value ?? "";
    // 与引擎同一套清洗：空 / 含换行 → 就地拒绝；含 # | [ ] → 放行（提示交给视图 Notice）
    const sanitized = sanitizeTitle(rawTitle);
    if (!sanitized.ok) {
      this.setError(sanitized.reason ?? t("error.invalidTitle"));
      return;
    }

    const input: AddChildInput = { title: rawTitle };
    const progress = readOptionalInt(this.progressInput, t("nodeinfo.progress"), 0, 999);
    if (progress.reason !== undefined) {
      this.setError(progress.reason);
      return;
    }
    if (progress.value !== undefined) input.progress = progress.value;
    const progressMax = readOptionalInt(this.progressMaxInput, t("nodeinfo.progress_max"), 0, 999);
    if (progressMax.reason !== undefined) {
      this.setError(progressMax.reason);
      return;
    }
    if (progressMax.value !== undefined) input.progress_max = progressMax.value;
    const importance = this.importanceSelect?.value ?? "";
    if (importance.length > 0) input.importance = Number(importance);
    const urgency = this.urgencySelect?.value ?? "";
    if (urgency.length > 0) input.urgency = Number(urgency);
    const owner = this.ownerInput?.value.trim() ?? "";
    if (owner.length > 0) input.owner = owner;
    const dueAt = readDueDate(this.dueAtInputs, t("field.dueDate"));
    if (dueAt.reason !== undefined) {
      this.setError(dueAt.reason);
      return;
    }
    if (dueAt.value !== undefined) input.dueAt = dueAt.value;

    const button = this.saveButton;
    if (button) button.disabled = true;
    try {
      const result = await this.save(input);
      if (!result.success) {
        const detail = formatIssues(result.issues, { maxIssues: 8 });
        this.setError(
          t("error.notWritten", {
            reason: result.reason ?? t("common.unknownReason"),
            detail: detail.length > 0 ? `\n${detail}` : "",
          }),
        );
        return;
      }
      this.finish(result);
    } finally {
      if (button) button.disabled = false;
    }
  }

  private setError(message: string): void {
    if (this.errorEl) this.errorEl.setText(message);
  }
}


/**
 * 「🗑 删除本节点」Modal（Phase 9）：不可撤销，所以把「会发生什么」逐条列出来，确认后才删除。
 * 计数取自视图传进来的节点；真正的拒绝逻辑仍在引擎里（根节点 / 带 archive 的节点）。
 *
 * Phase 27：纪要段范式已弃用 → 不再有「超链接合并进上级 / 删除超链接」的二选一
 * （引擎 `mergeNoteSections` 恒为空，那对单选框只会误导用户）。
 */
class ConfirmDeleteModal extends WfModal<DeleteNodeResult> {
  private readonly node: WfNode;
  private readonly save: () => Promise<DeleteNodeResult>;
  private errorEl: HTMLElement | null = null;
  private deleteButton: HTMLButtonElement | null = null;

  constructor(app: App, node: WfNode, save: () => Promise<DeleteNodeResult>) {
    super(app);
    this.node = node;
    this.save = save;
  }

  build(parent: HTMLElement): void {
    const contentEl = parent;
    contentEl.empty();
    contentEl.addClass("wfjson-modal");
    contentEl.addClass("wfjson-modal-danger");
    contentEl.createEl("h3", { cls: "wf-panel-title", text: t("dialog.delete.title", { title: this.node.title }) });
    contentEl.createEl("p", { cls: "wfjson-modal-subtitle", text: t("dialog.delete.desc", { title: this.node.title }) });

    const childCount = this.node.children?.length ?? 0;
    const relationCount = this.node.relations?.length ?? 0;
    const list = contentEl.createEl("ul", { cls: "wfjson-modal-danger-list" });
    //list.createEl("li", { text: t("dialog.delete.itemSelf", { id: this.node.id }) });
    if (childCount > 0) list.createEl("li", { text: t("dialog.delete.itemChildren", { count: childCount }) });
    if (relationCount > 0) {
      list.createEl("li", { text: t("dialog.delete.itemRelations", { count: relationCount }) });
    }

    this.errorEl = contentEl.createDiv({ cls: "wfjson-modal-error" });

    const footer = contentEl.createDiv({ cls: "wfjson-modal-footer" });
    const cancel = wfButton(footer, t("common.cancel"));
    cancel.onclick = (): void => this.cancel();
    const remove = wfButton(footer, t("common.delete"), "warning");
    remove.onclick = (): void => void this.onConfirm();
    this.deleteButton = remove;
  }

  private async onConfirm(): Promise<void> {
    this.setError("");

    const button = this.deleteButton;
    if (button) button.disabled = true;
    try {
      const result = await this.save();
      if (!result.success) {
        this.setError(t("error.notWritten", { reason: result.reason ?? t("common.unknownReason"), detail: "" }));
        return;
      }
      this.finish(result);
    } finally {
      if (button) button.disabled = false;
    }
  }

  private setError(message: string): void {
    if (this.errorEl) this.errorEl.setText(message);
  }
}


/**
 * Phase 34：一个资料文件要改的 frontmatter 字段（`undefined` = 不动）。
 * `patchAffiliationFiles` 只按这里给出的键逐行 upsert。
 *
 * Phase 35：文件可以有多条归属 → 每个字段带「定位」信息，只改命中的那一项
 * （`replaceAffiliationItem`：id 权威、旧标题兜底），别的归属原样留着。
 */
interface AffiliationFieldPatch {
  /** 新值 */
  value: string;
  /** 权威定位：同一 index 的 id 字段等于它 */
  matchId?: string;
  /** 兜底定位：字段当前值等于它（旧标题） */
  matchTitle?: string;
}

interface AffiliationPatch {
  /** 人读标题列（`wf-workflow`）：改名 / 归档同步都只改这两列 */
  workflowTitle?: AffiliationFieldPatch;
  nodeTitle?: AffiliationFieldPatch;
}

/**
 * 把一个字段补丁应用到 md 文本。
 *
 * 读的是**文件当前内容**（`parseFrontmatter`），按 index 对齐后只替换命中的项；
 * 没命中 / 值没变 → 原样返回，`vault.process` 不会产生无意义的写盘。
 */
function applyAffiliationPatch(
  markdown: string,
  valueKey: string,
  idKey: string,
  patch: AffiliationFieldPatch | undefined,
): string {
  if (patch === undefined) return markdown;
  const info = parseFrontmatter(markdown);
  const current = info.getArray(valueKey) ?? [];
  const ids = info.getArray(idKey) ?? [];
  const replaced = replaceAffiliationItem(current, ids, { id: patch.matchId, title: patch.matchTitle }, patch.value);
  if (!replaced.changed) return markdown;
  return setFrontmatterFieldList(markdown, valueKey, replaced.values);
}

/** 四键的最终并行数组 → 逐个写回（1 项 = 标量、多项 = 内联数组，见 `setFrontmatterFieldList`） */
function writeAffiliationFields(markdown: string, values: AffiliationFieldValues): string {
  let next = markdown;
  next = setFrontmatterFieldList(next, FRONTMATTER_FIELDS.linkWorkflow, values.workflowTitle);
  next = setFrontmatterFieldList(next, FRONTMATTER_FIELDS.linkNode, values.nodeTitle);
  next = setFrontmatterFieldList(next, FRONTMATTER_FIELDS.linkWorkflowId, values.workflowId);
  next = setFrontmatterFieldList(next, FRONTMATTER_FIELDS.linkNodeId, values.nodeId);
  return next;
}

/** 节点改名的同步入参（旧标题用来找「还写着旧名字」的文件） */
interface NodeRenameSync {
  workflowTitle: string;
  workflowId: string;
  nodeId: string;
  oldNodeTitle: string;
  newNodeTitle: string;
}

/** 工作流改名的同步入参（根节点标题 = 工作流标题，所以根节点的 `wf-node` 也要推） */
interface WorkflowRenameSync {
  workflowId: string;
  rootNodeId: string;
  oldTitle: string;
  newTitle: string;
}

/** 文件名清洗：去掉文件系统禁用字符（`#` `^` `[` `]` 也不进文件名，免得 Obsidian 链接解析歧义） */
function safeLinkDocName(raw: string): string {
  return raw
    .replace(/[\\/:*?"<>|#^[\]]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** `LinkDocsModal` 需要的宿主能力（列表 / 新建 / 打开 / 选择 / 添加都由插件实现） */
interface LinkDocsModalHooks {
  /** 当前匹配到的资料文件（同步；插件侧先置脏再重建索引） */
  list(): LinkedFile[];
  /** 新建一份（写四键 frontmatter；`linkDir` 有变化时顺带写回节点） */
  create(input: { name: string; linkDir: string }): Promise<LinkDocsResult>;
  /** 打开一份（新建标签页） */
  open(path: string): void;
  /**
   * Phase 35：打开系统资源管理器挑一份 md（`startDir` = 面板里的「新建相对路径」）。
   * 移动端 / 取不到 Electron `dialog` → `unsupported`。
   */
  pick(startDir: string): Promise<LinkDocPickResult>;
  /**
   * Phase 35：把一份**已有** md 追加成当前节点的资料文件
   * （`path` 可以是绝对路径，也可以是库内相对路径）。
   */
  attach(path: string): Promise<LinkDocAttachResult>;
}

/** 「选择」的结果：取消静默、移动端降级、失败带原因 */
interface LinkDocPickResult {
  status: "picked" | "cancelled" | "unsupported" | "failed";
  /** `status === "picked"` 时的绝对路径 */
  path?: string;
  reason?: string;
}

/** 「添加已有 md」的结果：`added === false` = 同一 nodeId 已在四键里（没写盘） */
interface LinkDocAttachResult {
  success: boolean;
  nodeId: string;
  /** 写不到 / 找不到时的一句话（视图直接展示） */
  reason?: string;
  /** 落到的文件（vault 相对路径） */
  path?: string;
  /** 是否真的追加了一条归属 */
  added?: boolean;
}

/* ------------------------------------------------------------------ *
 * Phase 35：Electron 原生文件对话框（只用到 `showOpenDialog` 这一小片 API）
 *
 * 不 `import "electron"`：插件产物要在移动端也能加载（没这个模块），
 * 所以运行期拿 `window.require` 现取；取不到就把「选择」降级成人工输入。
 * ------------------------------------------------------------------ */

interface ElectronOpenDialogOptions {
  title?: string;
  defaultPath?: string;
  properties?: string[];
  filters?: { name: string; extensions: string[] }[];
}

interface ElectronOpenDialogResult {
  canceled?: boolean;
  filePaths?: string[];
}

interface ElectronDialog {
  showOpenDialog(
    options: ElectronOpenDialogOptions,
  ): Promise<ElectronOpenDialogResult> | ElectronOpenDialogResult;
}

interface ElectronModuleLike {
  dialog?: ElectronDialog;
  remote?: { dialog?: ElectronDialog };
}

/**
 * Phase 34：「编辑节点链接文档」表单（面板 tab 6）。
 *
 * - 列表：每份匹配文档一行（文件名 + 路径 + 行尾 ↗），点文件名 / ↗ 都**新建标签页**打开；
 * - 刷新：重新问宿主要列表（插件侧会重建反向索引）；
 * - 新建：`文件名`（默认节点名）+ `新建相对路径`（默认 `node.linkDir` → 第一份文档所在目录 → 库根）；
 *   成功后**不关面板**（可以连续建多份），新文件立刻进列表（索引滞后也不丢行）；
 * - 添加（Phase 35）：`添加文档地址` + 「选择」/「添加」——往**已有 md** 的四键里**追加**一条归属
 *   （不覆盖别人的归属；同一个 nodeId 已在 → 不重复写）；回车 = 添加；
 * - 关闭：`finish(result)` —— 视图据此提示「新建了 N 份」并按需刷新。
 */
class LinkDocsModal extends WfModal<LinkDocsResult> {
  private readonly node: WfNode;
  private readonly hooks: LinkDocsModalHooks;
  private files: LinkedFile[] = [];
  private nameInput: HTMLInputElement | null = null;
  private dirInput: HTMLInputElement | null = null;
  private addressInput: HTMLInputElement | null = null;
  private listEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private errorEl: HTMLElement | null = null;
  private createButton: HTMLButtonElement | null = null;
  private attachButton: HTMLButtonElement | null = null;
  /** 本次新建但索引可能还没收到的文件（合并列表时按 path 去重） */
  private created: string[] = [];
  /** 本次「添加」成功关联进来的文件（同样可能还没进索引） */
  private attached: string[] = [];
  private linkDirChanged = false;
  private changedNodeIds: string[] = [];

  constructor(app: App, node: WfNode, hooks: LinkDocsModalHooks) {
    super(app);
    this.node = node;
    this.hooks = hooks;
  }

  build(parent: HTMLElement): void {
    parent.empty();
    parent.addClass("wfjson-modal");
    parent.createEl("h3", { cls: "wf-panel-title", text: t("view.linkDocs.title", { title: this.node.title }) });
    parent.createEl("p", { cls: "wfjson-modal-subtitle", text: t("view.linkDocs.desc", { title: this.node.title }) });

    // 列表：标题 + 刷新（打开表单 / 点刷新都重新检索一次）
    // Phase 36：三块功能（列表 / 添加已有文档 / 新建）各自包一层 `.wf-link-docs-section`，
    // 段与段之间由 CSS 画分割线，长表单一眼能看出层次。
    const listSection = parent.createDiv({ cls: "wf-link-docs-section" });
    this.files = this.hooks.list();
    const head = listSection.createDiv({ cls: "wf-link-docs-head" });
    head.createSpan({ cls: "wf-link-docs-head-title", text: t("view.linkDocs.list") });
    const refresh = wfButton(head, t("view.linkDocs.refresh"));
    refresh.addClass("wfjson-btn--inline");
    refresh.onclick = (): void => {
      this.files = this.hooks.list();
      this.renderList();
    };
    this.listEl = listSection.createDiv({ cls: "wf-link-docs-list" });

    // 添加已有文档（Phase 35）：一行地址 + 「选择」（桌面端资源管理器）+ 「添加」
    const addSection = parent.createDiv({ cls: "wf-link-docs-section" });
    const head_add = addSection.createDiv({ cls: "wf-link-docs-head" });
    head_add.createSpan({ cls: "wf-link-docs-head-title", text: t("view.linkDocs.addAddress") });
    const addressRow = fieldRow(addSection, "");
    const addressLine = addressRow.createDiv({ cls: "wf-link-docs-address" });
    const addressInput = addressLine.createEl("input", { type: "text", cls: "wfjson-input" });
    addressInput.placeholder = t("view.linkDocs.addAddressPlaceholder");
    addressInput.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") void this.onAttach();
    });
    this.addressInput = addressInput;
    const pick = wfButton(addressLine, t("view.linkDocs.choose"));
    pick.addClass("wfjson-btn--inline");
    pick.onclick = (): void => void this.onPick();
    const attach = wfButton(addressLine, t("view.linkDocs.attach"), "cta");
    attach.addClass("wfjson-btn--inline");
    attach.onclick = (): void => void this.onAttach();
    this.attachButton = attach;

    // 新建：文件名（默认节点名）+ 新建相对路径（默认 node.linkDir / 第一份文档所在目录）
    const createSection = parent.createDiv({ cls: "wf-link-docs-section" });
    const head_create = createSection.createDiv({ cls: "wf-link-docs-head" });
    head_create.createSpan({ cls: "wf-link-docs-head-title", text: t("view.linkDocs.createAddress") });

    const dirRow = fieldRow(createSection, t("view.linkDocs.dir"));
    const dirInput = dirRow.createEl("input", { type: "text", cls: "wfjson-input" });
    dirInput.value = this.node.linkDir ?? parentFolderOf(this.files[0]?.path ?? "");
    dirInput.placeholder = t("view.linkDocs.dirPlaceholder");
    this.dirInput = dirInput;

    const nameRow = fieldRow(createSection, t("view.linkDocs.name"), true);
    const CREATEaddressLine = nameRow.createDiv({ cls: "wf-link-docs-address" });
    const nameInput = CREATEaddressLine.createEl("input", { type: "text", cls: "wfjson-input" });
    nameInput.value = this.node.title;
    nameInput.placeholder = t("view.linkDocs.namePlaceholder");
    nameInput.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") void this.onCreate();
    });
    this.nameInput = nameInput;

    this.statusEl = parent.createDiv({ cls: "wf-link-docs-status" });
    this.errorEl = parent.createDiv({ cls: "wfjson-modal-error" });

    const close = wfButton(CREATEaddressLine, t("common.close"));
    close.addClass("wfjson-btn--inline");
    close.onclick = (): void => this.finish(this.result());
    const create = wfButton(CREATEaddressLine, t("view.linkDocs.create"), "cta");
    create.addClass("wfjson-btn--inline");
    create.onclick = (): void => void this.onCreate();
    this.createButton = create;

    this.renderList();
    nameInput.focus();
  }

  /** 列表 = 宿主给的 + 本次新建 / 添加的（按 path 去重 + 字典序） */
  private currentFiles(): LinkedFile[] {
    const byPath = new Map<string, LinkedFile>();
    for (const file of this.files) byPath.set(file.path, file);
    for (const path of [...this.created, ...this.attached]) {
      if (byPath.has(path)) continue;
      byPath.set(path, { path, title: linkedFileTitle(path), workflowTitle: "", nodeTitle: "" });
    }
    return [...byPath.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  }

  /** 重画列表（一行 = 文件名 + 路径 + 行尾「↗」） */
  private renderList(): void {
    const list = this.listEl;
    if (list === null) return;
    list.empty();
    const files = this.currentFiles();
    if (files.length === 0) {
      list.createDiv({ cls: "wf-link-docs-empty", text: t("view.linkDocs.empty") });
      return;
    }
    for (const file of files) {
      const row = list.createDiv({ cls: "wf-link-docs-item" });
      // 列表图标与卡片菜单一致（`LINKED_FILE_ICON` 在视图层，main 里只用这一个字符）
      const open = row.createEl("button", { cls: "wf-link-docs-open", text: `📄 ${file.title}` });
      open.title = file.path;
      open.onclick = (): void => this.hooks.open(file.path);
      row.createSpan({ cls: "wf-link-docs-path", text: file.path });
      /*
      const jump = row.createEl("button", { cls: "wf-link-docs-jump", text: "↗" });
      jump.title = t("view.linkDocs.open");
      jump.setAttribute("aria-label", t("view.linkDocs.open"));
      jump.onclick = (): void => this.hooks.open(file.path);*/
    }
  }

  /** 「新建链接文档」：失败留在表单里显示原因；成功不关面板（可以连续建多份） */
  private async onCreate(): Promise<void> {
    this.setError("");
    this.setStatus("");
    const button = this.createButton;
    if (button) button.disabled = true;
    try {
      const result = await this.hooks.create({
        name: this.nameInput?.value ?? "",
        linkDir: this.dirInput?.value ?? "",
      });
      if (!result.success) {
        this.setError(result.reason ?? t("view.notify.unknownReason"));
        return;
      }
      if (result.linkDirChanged) this.linkDirChanged = true;
      if (result.changedNodeIds.length > 0) {
        this.changedNodeIds = [...new Set([...this.changedNodeIds, ...result.changedNodeIds])];
      }
      for (const path of result.createdPaths) {
        if (!this.created.includes(path)) this.created.push(path);
      }
      this.renderList();
      if (result.createdPaths.length > 0) {
        this.setStatus(t("view.linkDocs.created", { path: result.createdPaths[0] }));
        // 名称回到节点名，连续建下一份时不用手动改
        if (this.nameInput) this.nameInput.value = this.node.title;
      }
    } catch (error) {
      this.setError(errorMessageOf(error));
    } finally {
      if (button) button.disabled = false;
    }
  }

  /**
   * Phase 35「选择」：桌面端打开系统资源管理器挑一份 md（起点 = 面板里的「新建相对路径」）。
   *
   * 挑中 → 填进地址栏并立刻添加；取消静默；移动端 / 取不到 dialog → 提示改用人工输入。
   */
  private async onPick(): Promise<void> {
    this.setError("");
    this.setStatus("");
    try {
      const result = await this.hooks.pick(this.dirInput?.value ?? "");
      switch (result.status) {
        case "picked":
          if (result.path !== undefined) {
            if (this.addressInput) this.addressInput.value = result.path;
            //await this.onAttach();
          }
          return;
        case "cancelled":
          return;
        case "unsupported":
          this.setError(t("view.linkDocs.pickUnsupported"));
          return;
        case "failed":
          this.setError(
            t("view.linkDocs.pickFailed", { reason: result.reason ?? t("view.notify.unknownReason") }),
          );
          return;
      }
    } catch (error) {
      this.setError(errorMessageOf(error));
    }
  }

  /**
   * Phase 35「添加」：把地址栏里的 md **追加**成当前节点的资料文件。
   *
   * 不关面板、不清空地址栏（可以接着加下一份）；`added === false` = 已在列表里。
   */
  private async onAttach(raw?: string): Promise<void> {
    this.setError("");
    this.setStatus("");
    const button = this.attachButton;
    if (button) button.disabled = true;
    try {
      const result = await this.hooks.attach(raw ?? this.addressInput?.value ?? "");
      if (!result.success) {
        this.setError(result.reason ?? t("view.notify.unknownReason"));
        return;
      }
      const path = result.path ?? "";
      if (path.length > 0 && !this.attached.includes(path)) this.attached.push(path);
      this.renderList();
      this.setStatus(
        result.added === true
          ? t("view.linkDocs.attached", { path })
          : t("view.linkDocs.alreadyLinked", { path }),
      );
    } catch (error) {
      this.setError(errorMessageOf(error));
    } finally {
      if (button) button.disabled = false;
    }
  }

  /** 关面板时交回去的结果（视图按 `changed` / `createdPaths` 决定提示与刷新） */
  private result(): LinkDocsResult {
    return {
      success: true,
      nodeId: this.node.id,
      changed: this.created.length > 0 || this.linkDirChanged,
      issues: [],
      changedNodeIds: this.changedNodeIds,
      createdPaths: [...this.created],
      linkDirChanged: this.linkDirChanged,
    };
  }

  private setStatus(message: string): void {
    if (this.statusEl) this.statusEl.setText(message);
  }

  private setError(message: string): void {
    if (this.errorEl) this.errorEl.setText(message);
  }
}

/**
 * Phase 27 §5.7：「给当前文件打标签」Modal 的写入入参（四个键，与引擎 `Affiliation` 同形）。
 *
 * 两个 id 一定要写：将来工作流 / 节点改名后 `wf-workflow` / `wf-node` 会失效，
 * id 才是长期权威（§5.1 的匹配口径：id 精确命中即权威）。
 */
interface TagFileWrite {
  workflowTitle: string;
  nodeTitle: string;
  workflowId: string;
  nodeId: string;
}

/**
 * Phase 27 §5.7：「给当前文件打标签」Modal —— 选工作流 + 节点，再写进**当前活动 md**。
 *
 * 只用既有 `.wfjson-modal` 样式（不新增样式区块）；两个下拉是原生 `<select>`：
 * 工作流来自聚焦看板的文档，节点 = 该流先序遍历（`walkWorkflow`，全角空格缩进表示层级）。
 */
class TagFileModal extends WfModal<void> {
  private readonly workflows: readonly WfWorkflow[];
  private readonly write: (affiliation: TagFileWrite) => Promise<string | undefined>;
  private workflowSelect: HTMLSelectElement | null = null;
  private nodeSelect: HTMLSelectElement | null = null;
  private errorEl: HTMLElement | null = null;
  private writeButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    workflows: readonly WfWorkflow[],
    write: (affiliation: TagFileWrite) => Promise<string | undefined>,
  ) {
    super(app);
    this.workflows = workflows;
    this.write = write;
  }

  build(parent: HTMLElement): void {
    const contentEl = parent;
    contentEl.empty();
    contentEl.addClass("wfjson-modal");
    contentEl.createEl("h3", { cls: "wf-panel-title", text: t("view.tag.title") });

    const workflowRow = fieldRow(contentEl, t("view.tag.workflow"), true);
    const workflowSelect = workflowRow.createEl("select", { cls: "wfjson-input" });
    this.workflows.forEach((workflow, index) => {
      workflowSelect.createEl("option", {
        text: `${workflow.title}（${workflow.id}）`,
        attr: { value: `${index}` },
      });
    });
    workflowSelect.onchange = (): void => this.renderNodeOptions();
    this.workflowSelect = workflowSelect;

    const nodeRow = fieldRow(contentEl, t("view.tag.node"), true);
    this.nodeSelect = nodeRow.createEl("select", { cls: "wfjson-input" });
    this.renderNodeOptions();

    this.errorEl = contentEl.createDiv({ cls: "wfjson-modal-error" });

    const footer = contentEl.createDiv({ cls: "wfjson-modal-footer" });
    const cancel = wfButton(footer, t("common.cancel"));
    cancel.onclick = (): void => this.cancel();
    const write = wfButton(footer, t("view.tag.write"), "cta");
    write.onclick = (): void => void this.onConfirm();
    this.writeButton = write;
  }

  /** 节点下拉跟着工作流走（换流就整列重填；没有可选项时留空，确认时提示 `view.tag.noNode`） */
  private renderNodeOptions(): void {
    const select = this.nodeSelect;
    if (select === null) return;
    select.empty();
    const workflow = this.currentWorkflow();
    if (workflow === undefined) return;
    for (const visit of walkWorkflow(workflow)) {
      select.createEl("option", {
        text: `${"　".repeat(visit.depth)}${visit.node.title}（${visit.node.id}）`,
        attr: { value: visit.node.id },
      });
    }
  }

  private currentWorkflow(): WfWorkflow | undefined {
    const index = Number(this.workflowSelect?.value ?? "0");
    return Number.isInteger(index) ? this.workflows[index] : undefined;
  }

  private async onConfirm(): Promise<void> {
    this.setError("");
    const workflow = this.currentWorkflow();
    const nodeId = this.nodeSelect?.value ?? "";
    const node = workflow === undefined ? undefined : walkWorkflow(workflow).find((v) => v.node.id === nodeId)?.node;
    if (workflow === undefined || node === undefined) {
      this.setError(t("view.tag.noNode"));
      return;
    }

    const button = this.writeButton;
    if (button) button.disabled = true;
    try {
      const reason = await this.write({
        workflowTitle: workflow.title,
        nodeTitle: node.title,
        workflowId: workflow.id,
        nodeId: node.id,
      });
      if (reason !== undefined) {
        this.setError(reason);
        return;
      }
      this.finish(undefined);
    } finally {
      if (button) button.disabled = false;
    }
  }

  private setError(message: string): void {
    if (this.errorEl) this.errorEl.setText(message);
  }
}


/**
 * 「📦 为此及之后归档」Modal：收集三段文字（概括 / 原理 / 复盘，都选填）再确认。
 *
 * 与「删除」同级的一次性动作，所以先把「会发生什么」摊开：子树会被压成一个带 `archive`
 * 的 done 节点、归档文件 建在 `archive/`（路径确定）、后代的原 id 不会保留（不做追溯）。
 * 计数取自视图传进来的节点；拒绝逻辑（根 / 叶子 / 已归档 / 有未完成后代）仍在引擎里兜底。
 *
 * Phase 22：同一个 Modal 兼作「📦 归档整个工作流」（`options.kind = "workflow"`）——
 * 文字与清单换成工作流口径（标题 / 我这条流整个搬走 / 不写 originId / 记 workflow_archive），
 * 三个输入框与保存逻辑完全复用（引擎侧都由 `ArchiveFormInput` 收）。
 */
export interface ArchiveModalOptions {
  /** `node` = 为此及之后归档（Phase 4）；`workflow` = 归档整条工作流（Phase 22） */
  kind: "node" | "workflow";
  /** 弹窗里显示的标题（节点标题 / 工作流标题） */
  title: string;
}

/** 解析标签输入框（逗号分隔）→ 去重去空的标签数组 */
function parseTagsInput(value: string): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value.split(",")) {
    const tag = raw.trim();
    if (tag.length === 0 || seen.has(tag)) continue;
    seen.add(tag);
    result.push(tag);
  }
  return result;
}

/** 一行「标签 + 单行输入框」，下方是 archive_tag.yaml 里的标签卡片（点击追加进输入框） */
function tagInputRow(parent: HTMLElement, tags: readonly string[], value: string): HTMLInputElement {
  const row = fieldRow(parent, t("dialog.archive.tag"));
  const input = row.createEl("input", { cls: "wfjson-input", type: "text" });
  input.placeholder = t("dialog.archive.tagHint");
  input.value = value;
  const picker = parent.createDiv({ cls: "wf-tag-picker" });
  for (const tag of tags) {
    const card = picker.createEl("button", { cls: "wf-tag-card", text: tag });
    card.onclick = () => {
      const current = parseTagsInput(input.value);
      if (!current.includes(tag)) current.push(tag);
      input.value = current.join(", ");
    };
  }
  return input;
}

class ArchiveNodeModal extends WfModal<ArchiveNodeResult> {
  private readonly node: WfNode;
  private readonly save: (form: ArchiveFormInput) => Promise<ArchiveNodeResult>;
  private readonly options: ArchiveModalOptions;
  private readonly tags: readonly string[];
  private summaryInput: HTMLTextAreaElement | null = null;
  private ideaInput: HTMLTextAreaElement | null = null;
  private reviewInput: HTMLTextAreaElement | null = null;
  private tagInput: HTMLInputElement | null = null;
  private errorEl: HTMLElement | null = null;
  private saveButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    node: WfNode,
    save: (form: ArchiveFormInput) => Promise<ArchiveNodeResult>,
    options: ArchiveModalOptions = { kind: "node", title: node.title },
    tags: readonly string[] = [],
  ) {
    super(app);
    this.node = node;
    this.save = save;
    this.options = options;
    this.tags = tags;
  }

  build(parent: HTMLElement): void {
    const contentEl = parent;
    const isWorkflow = this.options.kind === "workflow";
    contentEl.empty();
    contentEl.addClass("wfjson-modal");
    contentEl.addClass("wfjson-modal-danger");
    if (isWorkflow) {
      contentEl.createEl("h3", { cls: "wf-panel-title", text: t("dialog.archiveWorkflow.title") });
      contentEl.createEl("p", { cls: "wfjson-modal-subtitle", text: t("dialog.archiveWorkflow.desc", { title: this.options.title }) });
    } else {
      contentEl.createEl("h3", { cls: "wf-panel-title", text: t("dialog.archive.title", { title: this.options.title }) });
      contentEl.createEl("p", { cls: "wfjson-modal-subtitle", text: t("dialog.archive.desc", { title: this.options.title }) });
    }

    const descendants = collectDescendants(this.node);
    const unfinished = [this.node, ...collectDescendants(this.node)].filter((item) => item.status !== "done");
    const list = contentEl.createEl("ul", { cls: "wfjson-modal-danger-list" });
    list.createEl("li", {
      text: t("dialog.archive.itemFile", { total: descendants.length + 1, descendants: descendants.length }),
    });
    if (isWorkflow) {
      list.createEl("li", { text: t("dialog.archiveWorkflow.itemLocal") });
      list.createEl("li", { text: t("dialog.archiveWorkflow.itemOrigin") });
    } else {
      list.createEl("li", { text: t("dialog.archive.itemLocal") });
    }
    list.createEl("li", { text: t("dialog.archive.itemIds") });
    if (unfinished.length > 0) {
      list.createEl("li", { text: t("dialog.archive.itemUnfinished", { count: unfinished.length }) });
    }

    const hint = contentEl.createDiv({ cls: "wfjson-field-hint" });
    hint.setText(t("dialog.archive.hint"));

    this.summaryInput = this.textareaRow(contentEl, t("field.outline"), t("dialog.archive.summaryPlaceholder"));
    this.ideaInput = this.textareaRow(contentEl, t("field.idea"), t("dialog.archive.ideaPlaceholder"));
    this.reviewInput = this.textareaRow(contentEl, t("field.review"), t("dialog.archive.reviewPlaceholder"));
    this.tagInput = tagInputRow(contentEl, this.tags, "");

    this.errorEl = contentEl.createDiv({ cls: "wfjson-modal-error" });

    const footer = contentEl.createDiv({ cls: "wfjson-modal-footer" });
    const cancel = wfButton(footer, t("common.cancel"));
    cancel.onclick = (): void => this.cancel();
    const confirm = wfButton(footer, t("common.archive"), "warning");
    confirm.onclick = (): void => void this.onConfirm();
    this.saveButton = confirm;

    this.summaryInput.focus();
  }

  /** 一行「标签 + 多行文本框」（与「编辑节点信息」的概要框同一套 `.wfjson-textarea`） */
  private textareaRow(parent: HTMLElement, label: string, placeholder: string): HTMLTextAreaElement {
    const row = fieldRow(parent, label);
    const input = row.createEl("textarea", { cls: "wfjson-textarea", attr: { rows: "1" } });
    input.placeholder = placeholder;
    return input;
  }

  private async onConfirm(): Promise<void> {
    this.setError("");

    const form: ArchiveFormInput = {};
    const summary = this.summaryInput?.value.trim() ?? "";
    const idea = this.ideaInput?.value.trim() ?? "";
    const review = this.reviewInput?.value.trim() ?? "";
    if (summary.length > 0) form.summary = summary;
    if (idea.length > 0) form.idea = idea;
    if (review.length > 0) form.review = review;
    const tag = parseTagsInput(this.tagInput?.value ?? "");
    if (tag.length > 0) form.tag = tag;

    const button = this.saveButton;
    if (button) button.disabled = true;
    try {
      const result = await this.save(form);
      if (!result.success) {
        const detail = formatIssues(result.issues, { maxIssues: 8 });
        this.setError(
          t("error.notArchived", {
            reason: result.reason ?? t("common.unknownReason"),
            detail: detail.length > 0 ? `\n${detail}` : "",
          }),
        );
        return;
      }
      this.finish(result);
    } finally {
      if (button) button.disabled = false;
    }
  }

  private setError(message: string): void {
    if (this.errorEl) this.errorEl.setText(message);
  }
}


/**
 * 「编辑归档信息」弹窗的初值（来自归档文件自己的 `workflow.archive`；不绑任何节点）。
 */
export interface ArchiveInfoModel {
  /** 弹窗标题里的人名（来源节点标题，缺省回落归档文件里的 workflow 标题） */
  title: string;
  summary?: string;
  idea?: string;
  review?: string;
  tag?: string[];
}

/**
 * Phase 38：「✏️ 编辑归档信息」Modal —— 只改归档文件自己的 `workflow.archive`
 * 的 summary / idea / review 三段文字与标签。
 *
 * 与「归档」那张表共用 field.outline / field.idea / field.review 三个标签与占位文案；
 * 初值 = 归档文件里现在的那份元数据（编辑已有说明，不是重新归档）。
 */
class ArchiveInfoModal extends WfModal<ArchiveInfoEditResult> {
  private readonly model: ArchiveInfoModel;
  private readonly save: (form: ArchiveFormInput) => Promise<ArchiveInfoEditResult>;
  private readonly tags: readonly string[];
  private summaryInput: HTMLTextAreaElement | null = null;
  private ideaInput: HTMLTextAreaElement | null = null;
  private reviewInput: HTMLTextAreaElement | null = null;
  private tagInput: HTMLInputElement | null = null;
  private errorEl: HTMLElement | null = null;
  private saveButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    model: ArchiveInfoModel,
    save: (form: ArchiveFormInput) => Promise<ArchiveInfoEditResult>,
    tags: readonly string[] = [],
  ) {
    super(app);
    this.model = model;
    this.save = save;
    this.tags = tags;
  }

  build(parent: HTMLElement): void {
    const contentEl = parent;
    contentEl.empty();
    contentEl.addClass("wfjson-modal");
    contentEl.createEl("h3", { cls: "wf-panel-title", text: t("dialog.archiveInfo.title", { title: this.model.title }) });
    contentEl.createEl("p", { cls: "wfjson-modal-subtitle", text: t("dialog.archiveInfo.desc") });

    this.summaryInput = this.textareaRow(contentEl, t("field.outline"), t("dialog.archive.summaryPlaceholder"), this.model.summary ?? "");
    this.ideaInput = this.textareaRow(contentEl, t("field.idea"), t("dialog.archive.ideaPlaceholder"), this.model.idea ?? "");
    this.reviewInput = this.textareaRow(contentEl, t("field.review"), t("dialog.archive.reviewPlaceholder"), this.model.review ?? "");
    this.tagInput = tagInputRow(contentEl, this.tags, (this.model.tag ?? []).join(", "));

    this.errorEl = contentEl.createDiv({ cls: "wfjson-modal-error" });

    const footer = contentEl.createDiv({ cls: "wfjson-modal-footer" });
    const cancel = wfButton(footer, t("common.cancel"));
    cancel.onclick = (): void => this.cancel();
    const save = wfButton(footer, t("common.save"), "cta");
    save.onclick = (): void => void this.onConfirm();
    this.saveButton = save;

    this.summaryInput.focus();
  }

  /** 一行「标签 + 多行文本框」（与归档表单同一套 wfjson-textarea） */
  private textareaRow(parent: HTMLElement, label: string, placeholder: string, value: string): HTMLTextAreaElement {
    const row = fieldRow(parent, label);
    const input = row.createEl("textarea", { cls: "wfjson-textarea", attr: { rows: "1" } });
    input.placeholder = placeholder;
    input.value = value;
    return input;
  }

  private async onConfirm(): Promise<void> {
    this.setError("");
    const form: ArchiveFormInput = {};
    const summary = this.summaryInput?.value.trim() ?? "";
    const idea = this.ideaInput?.value.trim() ?? "";
    const review = this.reviewInput?.value.trim() ?? "";
    if (summary.length > 0) form.summary = summary;
    if (idea.length > 0) form.idea = idea;
    if (review.length > 0) form.review = review;
    const tag = parseTagsInput(this.tagInput?.value ?? "");
    if (tag.length > 0) form.tag = tag;

    const button = this.saveButton;
    if (button) button.disabled = true;
    try {
      const result = await this.save(form);
      if (!result.success) {
        this.setError(result.reason ?? t("common.unknownReason"));
        return;
      }
      this.finish(result);
    } finally {
      if (button) button.disabled = false;
    }
  }

  private setError(message: string): void {
    if (this.errorEl) this.errorEl.setText(message);
  }
}

/* ------------------------------------------------------------------ *
 * Phase 5 ② 编辑节点信息 Modal（契约「Phase 5 定稿契约」②）
 * ------------------------------------------------------------------ */

/**
 * 读一个「可空整数」输入框：空 → `value: undefined`（= 清空该字段）；
 * 非法（不是数字 / 不是整数 / 越界）→ `reason`（与引擎同一句中文，Modal 就地显示）。
 */
function readOptionalInt(
  input: HTMLInputElement | null,
  label: string,
  min: number,
  max: number,
): { value?: number; reason?: string } {
  const raw = input?.value.trim() ?? "";
  if (raw.length === 0) return {};
  const value = Number(raw);
  if (!Number.isFinite(value)) return { reason: t("error.numberInvalid", { label, raw }) };
  const reason = checkIntegerInRange(label, value, min, max);
  return reason !== undefined ? { reason } : { value };
}

/**
 * 读一个「可空 1-4 下拉框」：空 → `value: undefined`（= 清空该字段）；
 * 非法（不是数字 / 不是整数 / 越界）→ `reason`（与引擎同一句中文，Modal 就地显示）。
 */
function readOptionalScale(
  select: HTMLSelectElement | null,
  label: string,
  min: number,
  max: number,
): { value?: number; reason?: string } {
  const raw = select?.value.trim() ?? "";
  if (raw.length === 0) return {};
  const value = Number(raw);
  if (!Number.isFinite(value)) return { reason: t("error.numberInvalid", { label, raw }) };
  const reason = checkIntegerInRange(label, value, min, max);
  return reason !== undefined ? { reason } : { value };
}

/**
 * 「✏️ 编辑节点信息」（Phase 7）：**分字段表单**（不手写 JSON）。
 *
 * 保存规则（与引擎 `editNodeInfo` 同一套语义）：
 *  - 非空 → 进 `patch`（覆盖）；空 → 进 `clear`（删除该键；Schema 的 `TEXT` 是 minLength 1，不写空串）；
 *  - `title` 必填（红色 *）；`progress` / `progress_max` 允许 0-999；`importance` / `urgency` 1-4（下拉框显示可读文字）；
 *  - `dueAt` 用日期选择器，写回时自动补 `T00:00:00`；不合法就地报错、**保持打开**；
 *  - 写回被拒（引擎护栏 / 幂等校验 / 节点已被别处删掉）同样保持打开，把原因与 issues 摆出来。
 */
class NodeInfoModal extends WfModal<NodeInfoChangeResult> {
  private readonly node: WfNode;
  private readonly save: (patch: NodeInfoPatch, clear: readonly NodeInfoFieldKey[]) => Promise<NodeInfoChangeResult>;
  private titleInput: HTMLInputElement | null = null;
  private importanceInput: HTMLSelectElement | null = null;
  private urgencyInput: HTMLSelectElement | null = null;
  private progressInput: HTMLInputElement | null = null;
  private progressMaxInput: HTMLInputElement | null = null;
  private ownerInput: HTMLInputElement | null = null;
  private dueAtInputs: DueDateInputs | null = null;
  private errorEl: HTMLElement | null = null;
  private saveButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    node: WfNode,
    save: (patch: NodeInfoPatch, clear: readonly NodeInfoFieldKey[]) => Promise<NodeInfoChangeResult>,
  ) {
    super(app);
    this.node = node;
    this.save = save;
  }

  build(parent: HTMLElement): void {
    const contentEl = parent;
    contentEl.empty();
    contentEl.addClass("wfjson-modal");
    contentEl.createEl("h3", { cls: "wf-panel-title", text: t("dialog.editNode.title", { title: this.node.title }) });
    contentEl.createEl("p", {
      cls: "wfjson-modal-subtitle",
      text: t("dialog.editNode.desc"),
    });

    // 字段顺序（Phase 9）：title → progress / progress_max → importance / urgency → owner / dueAt。
    // 必填项用红色 * 标出。
    // （Phase 21：`type` 不再是可编辑 / 可显示的字段 —— 卡片与表单都不给它入口，JSON 里已有的值原样保留）
    // （Phase 45：`summary` 废弃 —— 说明改填工作流的 archive 四条说明，节点表单不再有这一栏）
    const titleRow = fieldRow(contentEl, nodeInfoLabel("title"), true);
    titleRow.addClass("wfjson-row-required");
    const titleInput = titleRow.createEl("input", { type: "text", cls: "wfjson-input" });
    titleInput.placeholder = t("dialog.editNode.titlePlaceholder");
    titleInput.value = this.node.title;
    this.titleInput = titleInput;

    const grid = contentEl.createDiv({ cls: "workflow-watcher-grid" });
    this.progressInput = this.numberField(
      grid,
      `${nodeInfoLabel("progress")}${t("suffix.range0to999")}`,
      this.node.progress,
      0,
      999,
    );
    this.progressMaxInput = this.numberField(
      grid,
      `${nodeInfoLabel("progress_max")}${t("suffix.range0to999")}`,
      this.node.progress_max,
      0,
      999,
    );
    this.importanceInput = this.scaleField(
      grid,
      `${nodeInfoLabel("importance")}${t("suffix.range1to4")}`,
      this.node.importance,
      IMPORTANCE_LABELS,
    );
    this.urgencyInput = this.scaleField(
      grid,
      `${nodeInfoLabel("urgency")}${t("suffix.range1to4")}`,
      this.node.urgency,
      URGENCY_LABELS,
    );
    this.ownerInput = this.textField(grid, `${nodeInfoLabel("owner")}${t("suffix.optional")}`, this.node.owner ?? "");
    this.dueAtInputs = dueDateField(grid, `${nodeInfoLabel("dueAt")}${t("suffix.optional")}`, this.node.dueAt);
    this.dueAtInputs.year.placeholder = t("field.yearDefault");

    this.errorEl = contentEl.createDiv({ cls: "wfjson-modal-error" });

    const footer = contentEl.createDiv({ cls: "wfjson-modal-footer" });
    const cancel = wfButton(footer, t("common.cancel"));
    cancel.onclick = (): void => this.cancel();
    const save = wfButton(footer, t("common.save"), "cta");
    save.onclick = (): void => void this.onConfirm();
    this.saveButton = save;

    titleInput.focus();
  }

  /** 两列网格里的一行数字输入（可空） */
  private numberField(
    parent: HTMLElement,
    label: string,
    value: number | undefined,
    min: number,
    max: number,
  ): HTMLInputElement {
    const row = fieldRow(parent, label);
    const input = row.createEl("input", {
      type: "number",
      cls: "wfjson-input",
      attr: { min: `${min}`, max: `${max}`, step: "1" },
    });
    if (value !== undefined) input.value = `${value}`;
    return input;
  }

  /** 两列网格里的一行文本输入 */
  private textField(parent: HTMLElement, label: string, value: string): HTMLInputElement {
    const row = fieldRow(parent, label);
    const input = row.createEl("input", { type: "text", cls: "wfjson-input" });
    input.value = value;
    return input;
  }

  /** 1-4 的可读下拉框（未设置 = 空值 → clear） */
  private scaleField(
    parent: HTMLElement,
    label: string,
    value: number | undefined,
    labels: Readonly<Record<number, string>>,
  ): HTMLSelectElement {
    const row = fieldRow(parent, label);
    const select = row.createEl("select", { cls: "wfjson-input" });
    select.createEl("option", { value: "", text: t("common.unset") });
    for (const [key, text] of Object.entries(labels)) {
      select.createEl("option", { value: key, text: `${key} · ${text}` });
    }
    select.value = value === undefined ? "" : `${value}`;
    return select;
  }

  private async onConfirm(): Promise<void> {
    this.setError("");

    const patch: NodeInfoPatch = {};
    const clear: NodeInfoFieldKey[] = [];

    const title = this.titleInput?.value.trim() ?? "";
    if (title.length === 0) {
      this.setError(t("error.titleEmpty"));
      return;
    }
    patch.title = title;

    // Phase 21：`type` 不再从表单读（既不 patch 也不 clear）→ JSON 里已有的值原样保留
    const owner = this.ownerInput?.value.trim() ?? "";
    if (owner.length > 0) patch.owner = owner;
    else clear.push("owner");

    const dueAt = readDueDate(this.dueAtInputs, nodeInfoLabel("dueAt"));
    if (dueAt.reason !== undefined) {
      this.setError(dueAt.reason);
      return;
    }
    if (dueAt.value !== undefined) patch.dueAt = dueAt.value;
    else clear.push("dueAt");

    const importance = readOptionalScale(this.importanceInput, nodeInfoLabel("importance"), 1, 4);
    if (importance.reason !== undefined) {
      this.setError(importance.reason);
      return;
    }
    if (importance.value !== undefined) patch.importance = importance.value;
    else clear.push("importance");

    const urgency = readOptionalScale(this.urgencyInput, nodeInfoLabel("urgency"), 1, 4);
    if (urgency.reason !== undefined) {
      this.setError(urgency.reason);
      return;
    }
    if (urgency.value !== undefined) patch.urgency = urgency.value;
    else clear.push("urgency");

    const progress = readOptionalInt(this.progressInput, nodeInfoLabel("progress"), 0, 999);
    if (progress.reason !== undefined) {
      this.setError(progress.reason);
      return;
    }
    if (progress.value !== undefined) patch.progress = progress.value;
    else clear.push("progress");

    const progressMax = readOptionalInt(this.progressMaxInput, nodeInfoLabel("progress_max"), 0, 999);
    if (progressMax.reason !== undefined) {
      this.setError(progressMax.reason);
      return;
    }
    if (progressMax.value !== undefined) patch.progress_max = progressMax.value;
    else clear.push("progress_max");

    const button = this.saveButton;
    if (button) button.disabled = true;
    try {
      const result = await this.save(patch, clear);
      if (!result.success) {
        const detail = formatIssues(result.issues, { maxIssues: 8 });
        this.setError(
          t("error.notWritten", {
            reason: result.reason ?? t("common.unknownReason"),
            detail: detail.length > 0 ? `\n${detail}` : "",
          }),
        );
        return;
      }
      this.finish(result);
    } finally {
      if (button) button.disabled = false;
    }
  }

  private setError(message: string): void {
    if (this.errorEl) this.errorEl.setText(message);
  }
}

/**
 * 「🔖 设置 note 节点」（Phase 20 修订）：条目表格 + 显示开关（不手写 JSON）。
 *
 * 结构（自上而下）：
 *  ① 工具行：`note 节点卡片展示` 药丸开关（OFF / ON）+ `➕ 添加` 按钮；
 *  ② 条目表格：正文（文本框）/ 文字 / 待办 / 已办（三选一）/ 置顶（挪到最前）；
 *  ③ 错误框 + 底部「取消 / 保存」。
 *
 * 保存规则（与引擎 `editNodeNote` 同一套语义）：
 *  - 正文留空的行 → 引擎整套丢掉（`normalizeNoteItems`）；表空了 → `note` / `noteVisible`
 *    **两键一并删掉**（不留「有开关没内容」）；
 *  - 开关 OFF → 不写 `noteVisible: false`，而是删键（缺省即默认，同 `collapsed`）；
 *  - 条目与开关都没变 → `changed = false`，弹窗照常关闭，视图只提示「没有变化」；
 *  - 写回被拒（节点已被别处删掉 / 幂等校验不过）→ **保持打开**，把原因与 issues 摆出来。
 *
 * 三态（文字 / 待办 / 已办）在 JSON 里只是一个 `done`：缺省 / `false` / `true`。
 * 卡片上的方框只在「待办 ↔ 已办」之间翻；要改类型只能回到这里点单选框。
 */
type NoteDraftKind = "text" | "todo" | "done";

/** 弹窗里的一行（受控状态：DOM 只是它的投影，添加 / 置顶后整表重画） */
interface NoteDraftRow {
  text: string;
  kind: NoteDraftKind;
}

/** 三态 → i18n 文案键（顺序 = 表格里的列顺序） */
const NOTE_KIND_LABEL_KEYS: Record<NoteDraftKind, string> = {
  text: "dialog.nodeNote.kindText",
  todo: "dialog.nodeNote.kindTodo",
  done: "dialog.nodeNote.kindDone",
};

/** 表格里三选一单选框的顺序（= 列顺序） */
const NOTE_KINDS: readonly NoteDraftKind[] = ["text", "todo", "done"];

/**
 * 从节点的 `note` 还原成弹窗状态：
 *  - 脏数据（非数组 / 非字符串 text / 空白行）一律跳过；
 *  - `done` 缺省 / `true` / `false` → 文字 / 已办 / 待办。
 */
function draftRowsOf(node: WfNode): NoteDraftRow[] {
  const raw = Array.isArray(node.note) ? node.note : [];
  const rows: NoteDraftRow[] = [];
  for (const item of raw) {
    if (typeof item?.text !== "string" || item.text.trim().length === 0) continue;
    const kind: NoteDraftKind = item.done === true ? "done" : item.done === false ? "todo" : "text";
    rows.push({ text: item.text, kind });
  }
  return rows;
}

class NodeNoteModal extends WfModal<NodeNoteChangeResult> {
  private readonly node: WfNode;
  private readonly save: (patch: NodeNotePatch) => Promise<NodeNoteChangeResult>;
  /** 本帧主题：独立弹窗时挂到 `.modal` 上（内嵌进面板时由面板外壳负责） */
  private readonly theme: string | undefined;
  private visible: boolean;
  private rows: NoteDraftRow[];
  private showToggle: HTMLInputElement | null = null;
  private showState: HTMLElement | null = null;
  private tbody: HTMLElement | null = null;
  private errorEl: HTMLElement | null = null;
  private saveButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    node: WfNode,
    save: (patch: NodeNotePatch) => Promise<NodeNoteChangeResult>,
    theme?: string,
  ) {
    super(app);
    this.node = node;
    this.save = save;
    this.theme = theme;
    // 初值取 node.noteVisible === true，缺省即 OFF
    this.visible = node.noteVisible === true;
    this.rows = draftRowsOf(node);
  }

  build(parent: HTMLElement): void {
    const contentEl = parent;
    contentEl.empty();
    contentEl.addClass("wfjson-modal");
    // 表格要放下「80 个半角字符的正文 + 4 列开关」→ 这个弹窗比其它 Modal 宽（面板里用不到）
    if (!this.embedded) this.modalEl.addClass("wfjson-modal--wide");
    // 主题跟随本帧看板：`.modal` 是 contentEl 的祖先，把 `.wf-theme[data-wf-theme]` 挂在它上面，
    // 主题化表单皮肤才会命中（内嵌进右侧面板时由面板外壳负责，这里不重复挂）；
    // 主题为空 = 没拿到本帧主题 → 回落默认主题（Phase 46），属性必须挂上
    if (!this.embedded && this.theme !== undefined) {
      this.modalEl.addClass("wf-theme");
      this.modalEl.addClass("wf-modal-host");
      this.modalEl.setAttribute("data-wf-theme", themeOrDefault(this.theme));
    }
    // 标题挂 `.wf-panel-title`：S16 里 8 套主题的标题签名（等宽 / 衬线 / 渐变 / 缎带）随之生效；
    // 没写签名的主题保留 Obsidian 的 `h3` 观感（`.modal h3` 的权重压得住单个类名，不会串色）
    contentEl.createEl("h3", {
      cls: "wf-panel-title",
      text: t("dialog.nodeNote.title", { title: this.node.title }),
    });
    contentEl.createEl("p", { cls: "wfjson-modal-subtitle", text: t("dialog.nodeNote.desc") });

    // ① 工具行：药丸开关（note 节点卡片展示）+ 添加
    const toolbar = contentEl.createDiv({ cls: "wf-note-toolbar" });
    // 原生 checkbox 套 `.wfjson-pill*` 外壳：键盘（Tab + 空格）照样能切
    const pill = toolbar.createEl("label", { cls: "wfjson-pill" });
    const toggle = pill.createEl("input", { cls: "wfjson-pill-input", attr: { type: "checkbox" } });
    toggle.checked = this.visible;
    const track = pill.createSpan({ cls: "wfjson-pill-track" });
    track.createSpan({ cls: "wfjson-pill-thumb" });
    this.showToggle = toggle;
    this.showState = pill.createSpan({ cls: "wfjson-pill-state", text: this.visible ? "ON" : "OFF" });
    toggle.onchange = (): void => {
      this.visible = toggle.checked;
      this.syncPillState();
    };

    const add = wfButton(toolbar, t("dialog.nodeNote.add"));
    add.onclick = (): void => {
      this.rows.push({ text: "", kind: "text" });
      this.renderRows();
      // 新行落在最后 → 光标直接进它的正文框（连着录几条不用再点）
      const inputs = this.tbody?.querySelectorAll<HTMLInputElement>(".wf-note-edit-text");
      inputs?.[inputs.length - 1]?.focus();
    };

    // ② 条目表格：列标题写死顺序，行由 renderRows() 投影
    const table = contentEl.createEl("table", { cls: "wf-note-table" });
    const head = table.createEl("thead").createEl("tr");
    for (const label of [
      t("dialog.nodeNote.colText"),
      t("dialog.nodeNote.kindText"),
      t("dialog.nodeNote.kindTodo"),
      t("dialog.nodeNote.kindDone"),
      t("dialog.nodeNote.colPin"),
    ]) {
      head.createEl("th", { text: label });
    }
    this.tbody = table.createEl("tbody");
    this.renderRows();

    this.errorEl = contentEl.createDiv({ cls: "wfjson-modal-error" });

    const footer = contentEl.createDiv({ cls: "wfjson-modal-footer" });
    const cancel = wfButton(footer, t("common.cancel"));
    cancel.onclick = (): void => this.cancel();
    const save = wfButton(footer, t("common.save"), "cta");
    save.onclick = (): void => void this.onConfirm();
    this.saveButton = save;
  }

  /** 药丸右侧的 ON / OFF —— OFF / ON 是语言中性词，不进词典 */
  private syncPillState(): void {
    if (this.showToggle) this.showToggle.checked = this.visible;
    if (this.showState) this.showState.setText(this.visible ? "ON" : "OFF");
  }

  /** 整表重画（行数不多，重画比逐行打补丁少一堆状态） */
  private renderRows(): void {
    const body = this.tbody;
    if (!body) return;
    body.empty();

    if (this.rows.length === 0) {
      const empty = body.createEl("tr", { cls: "wf-note-row-empty" });
      empty.createEl("td", { cls: "wf-note-empty", text: t("dialog.nodeNote.empty"), attr: { colspan: "5" } });
      return;
    }

    this.rows.forEach((row, index) => {
      const tr = body.createEl("tr", { cls: "wf-note-row" });

      // 正文：单行文本框（宽度由 CSS 的 --wf-note-edit-width 兜，约 80 个半角字符）
      const textCell = tr.createEl("td", { cls: "wf-note-cell-text" });
      const input = textCell.createEl("input", {
        type: "text",
        cls: "wf-note-edit-text",
        attr: { placeholder: t("dialog.nodeNote.textPlaceholder") },
      });
      input.value = row.text;
      input.oninput = (): void => {
        row.text = input.value;
      };

      // 三选一：文字 / 待办 / 已办（互斥；列标题已经写了文字，单选框只留 aria-label）
      for (const kind of NOTE_KINDS) {
        const cell = tr.createEl("td", { cls: "wf-note-cell-kind" });
        const label = cell.createEl("label", { cls: "wf-note-kind" });
        label.setAttribute("aria-label", t(NOTE_KIND_LABEL_KEYS[kind]));
        const radio = label.createEl("input", {
          type: "radio",
          cls: "wf-note-kind-input",
          attr: { name: `wf-note-kind-${index}`, value: kind },
        });
        radio.checked = row.kind === kind;
        radio.onchange = (): void => {
          if (radio.checked) row.kind = kind;
        };
      }

      // 置顶：挪到最前（第一条已经在顶上 → 禁用，不给假按钮）
      const pinCell = tr.createEl("td", { cls: "wf-note-cell-pin" });
      const pin = pinCell.createEl("button", {
        cls: "wf-note-pin",
        text: t("dialog.nodeNote.pin"),
        attr: { type: "button" },
      });
      pin.disabled = index === 0;
      pin.onclick = (): void => this.pinRow(index);
    });
  }

  /** 把第 `index` 行挪到最前（其余相对顺序不变），随后整表重画 */
  private pinRow(index: number): void {
    if (index <= 0 || index >= this.rows.length) return;
    const [row] = this.rows.splice(index, 1);
    if (row === undefined) return;
    this.rows.unshift(row);
    this.renderRows();
  }

  /** 状态 → 引擎 patch（空白行不在这里剔，交给引擎的 `normalizeNoteItems` 统一处理） */
  private patchOf(): NodeNotePatch {
    return {
      items: this.rows.map((row) => {
        const item: WfNoteItem = { text: row.text };
        if (row.kind === "todo") item.done = false;
        else if (row.kind === "done") item.done = true;
        return item;
      }),
      visible: this.visible,
    };
  }

  private async onConfirm(): Promise<void> {
    this.setError("");

    const button = this.saveButton;
    if (button) button.disabled = true;
    try {
      const result = await this.save(this.patchOf());
      if (!result.success) {
        const detail = formatIssues(result.issues, { maxIssues: 8 });
        this.setError(
          t("error.notWritten", {
            reason: result.reason ?? t("common.unknownReason"),
            detail: detail.length > 0 ? `\n${detail}` : "",
          }),
        );
        return;
      }
      this.finish(result);
    } finally {
      if (button) button.disabled = false;
    }
  }

  private setError(message: string): void {
    if (this.errorEl) this.errorEl.setText(message);
  }
}

/* ------------------------------------------------------------------ *
 * Phase 5 ③ 修改工作流 Modal（契约「Phase 5 定稿契约」③；Phase 45 改单条表单）
 * ------------------------------------------------------------------ */

/** 单条表单的控件（每次渲染重建；下拉切换时值先回写草稿） */
interface WorkflowFormControls {
  title: HTMLInputElement;
  /** v0.7 §⑨-8：进行中（空值）/ 完成 / 取消 */
  state: HTMLSelectElement;
  /** 四条复盘说明（`workflow.archive`） */
  summary: HTMLTextAreaElement;
  idea: HTMLTextAreaElement;
  review: HTMLTextAreaElement;
  tag: HTMLInputElement;
}

/**
 * 一条工作流的**草稿**（下拉切换时编辑不丢：控件值先回写到草稿，再重渲染下一条）。
 *
 * Phase 45：表单从「每个工作流一张折叠卡片」改成「下拉选一条 + 单条表单」；
 * 节点概要（`root.summary`）已废弃，不在表单上。
 */
interface WorkflowDraft {
  /** 已有工作流的 id；新增条目为 undefined（保存时进 `plan.additions`） */
  id: string | undefined;
  /** 原始标题（删除确认语 / 下拉回退文案用；用户改了输入框也不影响它） */
  originalTitle: string;
  title: string;
  /** v0.7 §⑨-8：进行中（undefined）/ 完成（archived）/ 取消（cancelled） */
  state: WorkflowState | undefined;
  summary: string;
  idea: string;
  review: string;
  /** 逗号分隔的标签输入（保存时 `parseTagsInput` 清洗） */
  tag: string;
  /** 用户已就地确认删除（保存时进 `plan.removals`；新增条目 = 直接丢弃） */
  removed: boolean;
}

/**
 * 「⚙️ 修改工作流…」（Phase 5 ③；Phase 45 改「下拉 + 单条表单」）：
 *
 *  - 顶部一个 `<select>` 选一条工作流（已有 + 已点过「新增」的草稿条目），旁边「新增工作流」按钮；
 *  - 下方是**这条工作流**的表单：① 标题（必填）② 状态 ③ 概括 ④ 原理 / 启发
 *    ⑤ 复盘 / 下一步 ⑥ 标签（点 `archive_tag.yaml` 的标签卡片快速加入）⑦ 删除（就地二次确认）；
 *  - 切换下拉时先把当前表单的值回写草稿，再重渲染选中的那条（编辑不丢）；
 *  - 删除是**就地二次确认**（不用 `window.confirm`：那会阻塞渲染，也不能带上下文）；
 *  - 保存时把「删除 + 编辑 + 新增」拼成一个 `WorkflowEditPlan` 交给引擎整批预检；
 *    任一条不合法 → 整批不写、Modal 保持打开并显示原因；
 *  - 保存成功后把本次用到的标签并入 `archive_tag.yaml`（best-effort，失败不影响写回结果）。
 */
class WorkflowEditorModal extends WfModal<WorkflowChangeResult> {
  private readonly drafts: WorkflowDraft[] = [];
  private readonly save: (plan: WorkflowEditPlan) => Promise<WorkflowChangeResult>;
  private readonly tags: readonly string[];
  private readonly addTags: (tags: readonly string[]) => Promise<void>;
  private selectEl: HTMLSelectElement | null = null;
  private formEl: HTMLElement | null = null;
  private errorEl: HTMLElement | null = null;
  private saveButton: HTMLButtonElement | null = null;
  /** 当前选中的草稿下标 */
  private current = 0;
  /** 当前表单的控件（还没渲染 / 无工作流时为 null） */
  private controls: WorkflowFormControls | null = null;

  constructor(
    app: App,
    workflows: readonly WfWorkflow[],
    save: (plan: WorkflowEditPlan) => Promise<WorkflowChangeResult>,
    tags: readonly string[] = [],
    addTags: (tags: readonly string[]) => Promise<void> = async () => undefined,
  ) {
    super(app);
    for (const workflow of workflows) {
      this.drafts.push({
        id: workflow.id,
        originalTitle: workflow.title,
        title: workflow.title,
        state: workflow.state,
        summary: workflow.archive?.summary ?? "",
        idea: workflow.archive?.idea ?? "",
        review: workflow.archive?.review ?? "",
        tag: (workflow.archive?.tag ?? []).join(", "),
        removed: false,
      });
    }
    this.save = save;
    this.tags = tags;
    this.addTags = addTags;
  }

  build(parent: HTMLElement): void {
    const contentEl = parent;
    contentEl.empty();
    contentEl.addClass("wfjson-modal");
    // Phase 28/37：底部「取消 / 保存」固定可见。
    // 独立弹窗靠 `.modal-content` 那条规则；内嵌到右侧面板时靠 `.wf-side-panel-body:has(...)`（见 styles.css）。
    contentEl.addClass("wfjson-modal--sticky-footer");
    contentEl.createEl("h3", { cls: "wf-panel-title", text: t("dialog.workflows.title") });
    contentEl.createEl("p", {
      cls: "wfjson-modal-subtitle",
      text: t("dialog.workflows.desc"),
    });

    // ① 下拉选一条 + 「新增工作流」
    const pickerRow = contentEl.createDiv({ cls: "workflow-watcher-picker" });
    const select = pickerRow.createEl("select", { cls: "wfjson-input" });
    select.setAttr("aria-label", t("dialog.workflows.pick"));
    this.selectEl = select;
    select.addEventListener("change", () => this.switchTo(Number(select.value)));
    const add = wfButton(pickerRow, t("dialog.workflows.add"));
    add.onclick = (): void => this.addDraft();

    // ② 单条表单（下拉切换 / 新增 / 删除标记后整体重渲染）
    this.formEl = contentEl.createDiv({ cls: "workflow-watcher-form" });

    this.errorEl = contentEl.createDiv({ cls: "wfjson-modal-error" });

    const footer = contentEl.createDiv({ cls: "wfjson-modal-footer" });
    const cancel = wfButton(footer, t("common.cancel"));
    cancel.onclick = (): void => this.cancel();
    const save = wfButton(footer, t("common.save"), "cta");
    save.onclick = (): void => void this.onConfirm();
    this.saveButton = save;

    this.renderSelect();
    this.renderForm();
  }

  /** 重建下拉选项（标题文字跟着草稿走） */
  private renderSelect(): void {
    const select = this.selectEl;
    if (select === null) return;
    select.empty();
    if (this.drafts.length === 0) {
      // 理论上一份 wfjson 至少有 1 条工作流；兜底给一个占位项，避免空 <select>
      select.createEl("option", { value: "0", text: t("common.untitled") });
      return;
    }
    this.drafts.forEach((draft, index) => {
      select.createEl("option", { value: `${index}`, text: this.draftName(draft) });
    });
    select.value = `${this.current}`;
  }

  /** 下拉里显示的名字：改过的标题优先；新增草稿带「（保存后新增）」；已标记删除带「（保存后删除）」 */
  private draftName(draft: WorkflowDraft): string {
    const typed = draft.title.trim();
    const fallback =
      draft.originalTitle.length > 0
        ? draft.originalTitle
        : draft.id === undefined
          ? t("dialog.workflows.newEntry")
          : t("common.untitled");
    const name = typed.length > 0 ? typed : fallback;
    if (draft.removed) return t("dialog.workflows.markedRemoved", { name });
    if (draft.id === undefined) return t("dialog.workflows.markedAdded", { name });
    return name;
  }

  /** 标题一改就同步当前下拉项的显示文字（不必重建整个下拉） */
  private refreshCurrentOption(): void {
    const select = this.selectEl;
    const draft = this.drafts[this.current];
    if (select === null || draft === undefined) return;
    const option = select.options[this.current];
    if (option !== undefined) option.text = this.draftName(draft);
  }

  /** 把当前表单的控件值回写到草稿（切换 / 新增 / 保存前都要先做一次） */
  private syncFromDom(): void {
    const draft = this.drafts[this.current];
    const controls = this.controls;
    if (draft === undefined || controls === null) return;
    draft.title = controls.title.value;
    const state = controls.state.value;
    draft.state = state === "archived" || state === "cancelled" ? state : undefined;
    draft.summary = controls.summary.value;
    draft.idea = controls.idea.value;
    draft.review = controls.review.value;
    draft.tag = controls.tag.value;
  }

  /** 切换下拉：先把当前表单回写草稿，再渲染选中的那条（编辑不丢） */
  private switchTo(index: number): void {
    this.syncFromDom();
    if (!Number.isInteger(index) || index < 0 || index >= this.drafts.length) return;
    this.current = index;
    this.setError("");
    this.renderSelect();
    this.renderForm();
  }

  /** 下拉里追加一个「新增工作流」草稿并选中它 */
  private addDraft(): void {
    this.syncFromDom();
    this.drafts.push({
      id: undefined,
      originalTitle: "",
      title: "",
      state: undefined,
      summary: "",
      idea: "",
      review: "",
      tag: "",
      removed: false,
    });
    this.current = this.drafts.length - 1;
    this.setError("");
    this.renderSelect();
    this.renderForm();
  }

  /** 丢弃一个新增草稿（还没落盘，直接从下拉里拿掉；已有工作流走 `removed` 标记） */
  private removeDraft(draft: WorkflowDraft): void {
    const index = this.drafts.indexOf(draft);
    if (index < 0) return;
    this.drafts.splice(index, 1);
    if (this.current >= this.drafts.length) this.current = Math.max(0, this.drafts.length - 1);
    this.renderSelect();
    this.renderForm();
  }

  /** 单条表单（下拉切换 / 新增 / 删除标记后整体重渲染） */
  private renderForm(): void {
    const formEl = this.formEl;
    if (formEl === null) return;
    formEl.empty();
    this.controls = null;
    const draft = this.drafts[this.current];
    if (draft === undefined) return;

    const grid = formEl.createDiv({ cls: "workflow-watcher-grid" });
    const title = this.textField(grid, workflowEditLabel("title"), draft.title, true, true);
    const state = this.stateField(grid, workflowEditLabel("state"), draft.state);

    const hint = formEl.createDiv({ cls: "wfjson-field-hint" });
    hint.setText(t("dialog.workflows.notesHint"));

    const summary = this.textareaRow(formEl, t("field.outline"), t("dialog.archive.summaryPlaceholder"), draft.summary);
    const idea = this.textareaRow(formEl, t("field.idea"), t("dialog.archive.ideaPlaceholder"), draft.idea);
    const review = this.textareaRow(formEl, t("field.review"), t("dialog.archive.reviewPlaceholder"), draft.review);
    const tag = tagInputRow(formEl, this.tags, draft.tag);

    this.controls = { title, state, summary, idea, review, tag };
    title.addEventListener("input", () => {
      draft.title = title.value;
      this.refreshCurrentOption();
    });

    // 已标记删除：字段置灰不可改（保存时这一条进 `plan.removals`）
    if (draft.removed) {
      for (const field of [title, state, summary, idea, review, tag]) field.disabled = true;
    }

    // 删除（就地二次确认；新增草稿 = 直接丢弃）
    const removeRow = formEl.createDiv({ cls: "workflow-watcher-remove" });
    if (draft.removed) {
      removeRow.addClass("workflow-watcher-remove--removed");
      removeRow.createSpan({ text: t("dialog.workflows.markedRemoved", { name: this.draftName(draft) }) });
      const undo = wfButton(removeRow, t("dialog.workflows.undoRemove"));
      undo.onclick = (): void => {
        draft.removed = false;
        this.renderForm();
        this.refreshCurrentOption();
      };
    } else {
      const removeButton = wfButton(removeRow, t("dialog.workflows.remove"), "warning");
      removeButton.onclick = (): void => this.askRemove(removeRow, draft);
    }

    title.focus();
  }

  /** 就地二次确认：确认后才标记 `removed`（保存时才真正删，取消还能反悔） */
  private askRemove(container: HTMLElement, draft: WorkflowDraft): void {
    container.empty();
    container.createSpan({
      text:
        draft.id !== undefined
          ? t("dialog.workflows.confirmDelete", { title: draft.originalTitle })
          : t("dialog.workflows.confirmDiscard"),
    });
    const ok = wfButton(container, t("common.confirmDelete"), "warning");
    ok.onclick = (): void => {
      this.setError("");
      if (draft.id === undefined) {
        this.removeDraft(draft);
        return;
      }
      draft.removed = true;
      this.renderForm();
      this.refreshCurrentOption();
    };
    const undo = wfButton(container, t("common.cancel"));
    undo.onclick = (): void => this.renderForm();
  }

  /** 单行文本框；`wide = true` 时整行跨两列（Phase 14：工作流标题独占第一行） */
  private textField(
    parent: HTMLElement,
    label: string,
    value: string,
    required = false,
    wide = false,
  ): HTMLInputElement {
    const row = fieldRow(parent, label, required);
    if (wide) row.addClass("workflow-watcher-wide");
    const input = row.createEl("input", { type: "text", cls: "wfjson-input" });
    input.value = value;
    return input;
  }

  /**
   * 工作流状态下拉（v0.7 §⑨-8）：`进行中` = 空值（保存时删键），
   * `完成` = `archived`，`取消` = `cancelled`。
   */
  private stateField(
    parent: HTMLElement,
    label: string,
    value: WorkflowState | undefined,
  ): HTMLSelectElement {
    const row = fieldRow(parent, label);
    const select = row.createEl("select", { cls: "wfjson-input" });
    select.createEl("option", { value: "", text: t("dialog.workflows.stateActive") });
    select.createEl("option", { value: "archived", text: t("dialog.workflows.stateDone") });
    select.createEl("option", { value: "cancelled", text: t("dialog.workflows.stateCancelled") });
    select.value = value ?? "";
    return select;
  }

  /** 一行「标签 + 多行文本框」（四条复盘说明共用；占满整行） */
  private textareaRow(parent: HTMLElement, label: string, placeholder: string, value: string): HTMLTextAreaElement {
    const row = fieldRow(parent, label);
    row.addClass("workflow-watcher-wide");
    const input = row.createEl("textarea", { cls: "wfjson-textarea", attr: { rows: "1" } });
    input.placeholder = placeholder;
    input.value = value;
    return input;
  }

  /**
   * 草稿 → 四条复盘说明表单。
   *
   * 空串**原样带上**（引擎按「空 = 删键」处理），这样才能把已有的说明清掉；
   * 标签输入逗号分隔 → `parseTagsInput` 清洗，一条不剩就不写 `tag` 键。
   */
  private archiveFormOf(draft: WorkflowDraft): ArchiveFormInput {
    const form: ArchiveFormInput = {
      summary: draft.summary,
      idea: draft.idea,
      review: draft.review,
    };
    const tag = parseTagsInput(draft.tag);
    if (tag.length > 0) form.tag = tag;
    return form;
  }

  private async onConfirm(): Promise<void> {
    this.setError("");
    this.syncFromDom();
    const plan: WorkflowEditPlan = { edits: [], additions: [], removals: [] };
    const newTags: string[] = [];

    let reason: string | undefined;
    let reasonName = "";
    for (const draft of this.drafts) {
      if (draft.removed) {
        // 已有工作流 → 删除；新增草稿被「删除」= 已经在下拉里拿掉了，这里再兜底跳过
        if (draft.id !== undefined) plan.removals?.push(draft.id);
        continue;
      }
      const title = draft.title.trim();
      if (title.length === 0) {
        reason = t("error.workflowTitleEmpty");
        reasonName = this.draftName(draft);
        break;
      }

      const patch: WorkflowPatch = { title };
      const clear: WorkflowEditFieldKey[] = [];
      // v0.7 §⑨-8：状态（空 = 进行中 → 删键；完成 / 取消 → archived / cancelled）
      if (draft.state !== undefined) patch.state = draft.state;
      else clear.push("state");
      // Phase 45：四条复盘说明（空串 = 删键），随同一次写回
      patch.archive = this.archiveFormOf(draft);

      if (draft.id === undefined) plan.additions?.push(patch);
      else plan.edits?.push({ id: draft.id, patch, clear });
      newTags.push(...parseTagsInput(draft.tag));
    }

    if (reason !== undefined) {
      this.setError(t("error.withName", { name: reasonName, reason }));
      return;
    }

    const button = this.saveButton;
    if (button) button.disabled = true;
    try {
      const result = await this.save(plan);
      if (!result.success) {
        const detail = formatIssues(result.issues, { maxIssues: 8 });
        this.setError(
          t("error.notWritten", {
            reason: result.reason ?? t("common.unknownReason"),
            detail: detail.length > 0 ? `\n${detail}` : "",
          }),
        );
        return;
      }
      // 保存成功：把本次用到的标签并入 archive_tag.yaml（best-effort，失败不影响写回结果）
      try {
        await this.addTags(newTags);
      } catch {
        // 标签枚举文件写不进去不算这次编辑失败
      }
      this.finish(result);
    } finally {
      if (button) button.disabled = false;
    }
  }

  private setError(message: string): void {
    if (this.errorEl) this.errorEl.setText(message);
  }
}

/**
 * 面板能挂的表单（结果类型各不相同，宿主只关心「什么时候落定」）。
 * 具体 tab 用哪一张由 `panelModalFor` 决定。
 */
type PanelModal =
  | WfModal<NodeInfoChangeResult>
  | WfModal<NodeNoteChangeResult>
  | WfModal<AddChildNodeResult>
  | WfModal<WorkflowChangeResult>
  | WfModal<ArchiveNodeResult>
  | WfModal<DeleteNodeResult>
  | WfModal<LinkDocsResult>;

/** 面板回调（由插件实现：切 tab 建表单 / 关面板清引用） */
interface WfSidePanelHooks {
  /** 用户点了某个 tab（上一个表单的「取消」收尾由面板自己做） */
  onTab(tab: WfPanelTab): void;
  /** 面板已经关掉（DOM 已移除；插件据此清掉自己的引用） */
  onClose(): void;
  /**
   * 本帧看板主题（视图 `overlayTheme(file)` 的结果）：挂到遮罩上（`.wf-theme[data-wf-theme]`），
   * 让各主题的 tab / 标题 / 表单皮肤命中；不传 = 默认主题（Phase 46，见 `themeOrDefault`）。
   */
  theme?: string;
}

/** tab 顺序 = 契约 §6.1 的表格顺序（Phase 34 追加 tab「编辑节点链接文档」；Phase 36 并入 note 节点） */
const PANEL_TABS: readonly WfPanelTab[] = ["info", "note", "child", "workflow", "archive", "delete", "links"];

/**
 * 节点操作面板（Phase 25 M4，契约 §6.2；Phase 30 改为**居中弹窗**）。
 *
 * 为什么不是 Obsidian 的 `Modal`：同屏只有一张表单、tab 内切换不叠层，且外壳由视图侧
 * 自绘复用（`.wf-side-panel*`）。做法与 Phase 16 的小工具浮层一致 ——
 * 自绘 DOM 挂到 `document.body`（`document.body.createDiv` + 自绘遮罩），
 * 内部再复用各 Modal 类建出来的**同一张表单**（`WfModal.mountInto`）。
 *
 * 关闭口径沿用 Phase 18 ①：**点外（遮罩）不关、Esc 不关，只有「×」能关**。
 * 表单本身「保存 / 取消」后由插件把面板收起来（与旧 Modal 关窗等价）。
 */
class WfSidePanel {
  private readonly hooks: WfSidePanelHooks;
  private readonly overlay: HTMLElement;
  private readonly element: HTMLElement;
  private readonly bodyEl: HTMLElement;
  private readonly tabButtons = new Map<WfPanelTab, HTMLButtonElement>();
  /** 当前挂着的那张表单（换 tab / 关面板时按「取消」收尾） */
  private current: WfMountedForm<unknown> | null = null;
  private tab: WfPanelTab = "info";
  private open_ = false;

  constructor(hooks: WfSidePanelHooks) {
    this.hooks = hooks;
    this.overlay = document.body.createDiv({ cls: "wf-side-panel-overlay" });
    // 把本帧主题挂到遮罩上（与右键菜单 / 小工具浮层同一口径）：
    // `.wf-theme[data-wf-theme="x"]` 的 tab / 标题 / 表单皮肤才会命中；
    // 没拿到本帧主题 → 回落默认主题（Phase 46），属性必须挂上
    if (hooks.theme !== undefined) {
      this.overlay.addClass("wf-theme");
      this.overlay.setAttribute("data-wf-theme", themeOrDefault(hooks.theme));
    }
    this.element = this.overlay.createDiv({ cls: "wf-side-panel" });
    this.element.setAttribute("role", "dialog");
    this.element.setAttribute("aria-modal", "true");

    const head = this.element.createDiv({ cls: "wf-side-panel-head" });
    // 标题 / tab 直接复用「统计」面板的 `.wf-panel-title` / `.wf-panel-btn`（Phase 32 的
    // S17 差量表按主题给这两个类写皮肤）→ 本节不需要再逐主题抄一遍颜色 / 字体 / 质感。
    // `.wf-side-panel-title` / `.wf-side-panel-tab` 仍保留：负责尺寸与无主题时的基线。
    head.createEl("h3", { cls: "wf-side-panel-title wf-panel-title", text: t("view.panel.title") });
    const close = head.createEl("button", { cls: "wf-side-panel-close", text: "×" });
    close.title = t("view.panel.close");
    close.setAttribute("aria-label", t("view.panel.close"));
    close.onclick = (): void => this.close();

    const tabs = this.element.createDiv({ cls: "wf-side-panel-tabs" });
    for (const tab of PANEL_TABS) {
      const button = tabs.createEl("button", { cls: "wf-side-panel-tab wf-panel-btn", text: tabLabel(tab) });
      button.onclick = (): void => this.selectTab(tab);
      this.tabButtons.set(tab, button);
    }

    this.bodyEl = this.element.createDiv({ cls: "wf-side-panel-body" });
  }

  /** 面板当前是不是开着（异步建表单回来时用它判断要不要继续） */
  get isOpen(): boolean {
    return this.open_;
  }

  /** 当前 tab（异步建表单回来时用它判断「tab 还是不是我要的那个」） */
  get activeTab(): WfPanelTab {
    return this.tab;
  }

  /** 挂到 body 上并播滑入动画 */
  open(): void {
    this.open_ = true;
    // 下一帧加 `is-open`：CSS 才有「从右滑入」的起点（同步加类会让过渡失效）
    window.requestAnimationFrame(() => {
      if (this.open_) this.overlay.addClass("is-open");
    });
  }

  /** 切 tab（用户点击）：先把上一个表单按「取消」收尾，再让插件建新表单 */
  selectTab(tab: WfPanelTab): void {
    if (!this.open_) return;
    // 点的是当前 tab → 什么也不做（别把已经填了一半的表单清掉）
    if (tab === this.tab && this.current !== null) return;
    this.markTab(tab);
    this.current?.dispose();
    this.current = null;
    this.clearBody();
    this.hooks.onTab(tab);
  }

  /**
   * 打开面板时挂第一张表单：切到 `tab` 并 `mountInto(body)`。
   * 返回句柄（插件用它等结果）；面板已关则返回 `null`。
   */
  mount(tab: WfPanelTab, modal: PanelModal): WfMountedForm<unknown> | null {
    if (!this.open_) return null;
    this.markTab(tab);
    this.current?.dispose();
    this.clearBody();
    return this.attach(modal);
  }

  /** 把表单挂到当前 tab 的 body 上（tab 已由 `selectTab` 切好） */
  attach(modal: PanelModal): WfMountedForm<unknown> {
    const mounted: WfMountedForm<unknown> = modal.mountInto(this.bodyEl);
    this.current = mounted;
    return mounted;
  }

  /**
   * 清空 tab body（换 tab / 显示提示时）。
   *
   * `empty()` 只删子节点、**不删类**；而 `.wfjson-modal` / `.wfjson-modal--sticky-footer` 是加在
   * body **自己身上**的（`mountInto` 把表单根当容器，见 `WorkflowEditorModal.build`）。
   * 不在这里摘掉的话，切到别的 tab 会继承「底部固定 + body 不出滚动条」的布局，表单会被裁掉。
   */
  private clearBody(): void {
    this.bodyEl.empty();
    this.bodyEl.removeClass("wfjson-modal");
    this.bodyEl.removeClass("wfjson-modal--sticky-footer");
  }

  /** 这个 tab 现在开不了（读不到文档）：body 里放一句说明，不留空表单 */
  showHint(message: string): void {
    this.current?.dispose();
    this.current = null;
    this.clearBody();
    this.bodyEl.createDiv({ cls: "wf-side-panel-hint", text: message });
  }

  /** 关面板：当前表单按「取消」收尾 → 移除 DOM → 通知插件（重复调用无副作用） */
  close(): void {
    if (!this.open_) return;
    this.open_ = false;
    this.current?.dispose();
    this.current = null;
    this.overlay.remove();
    this.hooks.onClose();
  }

  /** 切 tab 的高亮（`aria-selected` 让键盘 / 读屏也跟得上） */
  private markTab(tab: WfPanelTab): void {
    this.tab = tab;
    for (const [key, button] of this.tabButtons) {
      // `is-active` 管无主题时的基线高亮；`wf-panel-btn--on` 让 8 套主题的「开态」
      //（S17 的实底 / 反白字 / 霓虹发光…）原样生效 —— 与「统计」列按钮同一套皮肤。
      button.toggleClass("is-active", key === tab);
      button.toggleClass("wf-panel-btn--on", key === tab);
      button.setAttribute("aria-selected", key === tab ? "true" : "false");
    }
  }
}

/** tab 文案（§9 的 `view.panel.tab.*`，中英成对） */
function tabLabel(tab: WfPanelTab): string {
  switch (tab) {
    case "info":
      return t("view.panel.tab.info");
    case "note":
      return t("view.panel.tab.note");
    case "child":
      return t("view.panel.tab.child");
    case "workflow":
      return t("view.panel.tab.workflow");
    case "archive":
      return t("view.panel.tab.archive");
    case "delete":
      return t("view.panel.tab.delete");
    case "links":
      return t("view.panel.tab.links");
  }
}

/**
 * 插件设置面板（Phase 3 视图微调 v0.6 / v0.7）。
 *
 * 设置项：「计时器字号」写根元素 CSS 变量 `--wf-timer-font-size`（styles.css 的 `.wf-timer-clock` 读它）；
 * 主题不再有全局设置 —— 完全跟随文件（`wf-theme` frontmatter / `options.theme`），
 * 缺省回落 `default`（Phase 46 恢复：它重新是清单里的一个 key，不是「没有主题」）。
 * 值都存 `data.json`（`loadData` / `saveData`）；用户也可以在自己的 CSS snippet 里覆盖同一套变量。
 */
class WfJsonSettingTab extends PluginSettingTab {
  private readonly plugin: WfJsonWorkflowPlugin;

  constructor(app: App, plugin: WfJsonWorkflowPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    // 分组标题用 Setting.setHeading()（@since 0.9.16）：手写 h3 与原生设置页的排版不一致
    // ① 全局：语言（改了会立刻改写命令名并重排本面板，所以放最前）
    new Setting(containerEl).setName(t("settings.group.global")).setHeading();

    new Setting(containerEl)
      .setName(t("settings.lang.name"))
      .setDesc(t("settings.lang.desc"))
      .addDropdown((dropdown) => {
        for (const option of LANG_OPTIONS) dropdown.addOption(option.key, option.label);
        dropdown.setValue(this.plugin.settings.lang).onChange(async (value) => {
          this.plugin.settings.lang = normalizeLang(value);
          await this.plugin.saveSettings();
          // 立刻生效：命令 / 设置面板 / 下一次视图渲染都按新语言输出（已渲染的块需重绘才切换）
          setLang(this.plugin.settings.lang);
          // 三条命令的名字在注册时定格，这里按新语言改写（不用重载插件）
          this.plugin.refreshCommandNames();
          this.display();
        });
      });

    // Phase 37：看板文件目录（侧车 / 主看板 / 归档 / 备份的根）。
    // 目录改名是 I/O，放在 blur 里（onChange 逐键触发，不能每敲一个字母就搬一次目录）。
    new Setting(containerEl)
      .setName(t("settings.boardFolder.name"))
      .setDesc(t("settings.boardFolder.desc"))
      .addText((text) => {
        text.setPlaceholder(DEFAULT_SETTINGS.boardFolder).setValue(this.plugin.settings.boardFolder);
        text.inputEl.addEventListener("blur", () => {
          void this.plugin.applyBoardFolderChange(text.inputEl.value).then((applied) => {
            // 冲突 / 失败：回填当前真实值，界面不撒谎（成功时输入框里已经是新值）
            if (!applied) text.setValue(this.plugin.settings.boardFolder);
          });
        });
      });

    // ② 总览：渲染区顶部的引导性话语 + 计时器字号
    new Setting(containerEl).setName(t("settings.group.overview")).setHeading();

    // Phase 18 ③：渲染区顶部的大标题（留空 = 用 i18n 的「下一步是？」）
    new Setting(containerEl)
      .setName(t("settings.resumePrompt.name"))
      .setDesc(t("settings.resumePrompt.desc"))
      .addText((text) =>
        text
          .setPlaceholder(t("settings.resumePrompt.placeholder"))
          .setValue(this.plugin.settings.resumePrompt)
          .onChange(async (value) => {
            // 标题在下次渲染 / 局部刷新时读新值 → 这里不必额外触发重画
            this.plugin.settings.resumePrompt = normalizeResumePrompt(value);
            await this.plugin.saveSettings();
          }),
      );

    new Setting(containerEl)
      .setName(t("settings.timerFontSize.name"))
      .setDesc(t("settings.timerFontSize.desc"))
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.timerFontSize)
          .setValue(this.plugin.settings.timerFontSize)
          .onChange(async (value) => {
            const next = value.trim();
            this.plugin.settings.timerFontSize = next.length > 0 ? next : DEFAULT_SETTINGS.timerFontSize;
            await this.plugin.saveSettings();
            this.plugin.applyTimerFontSize();
          }),
      );

    // ③ 工作流：卡片宽度 + note 卡片显示条数
    new Setting(containerEl).setName(t("settings.group.workflow")).setHeading();

    // Phase 18 ⑦：卡片宽度（写到根元素 `--wf-card-width`；未设置时 `.wf-card` 回落 250px）
    new Setting(containerEl)
      .setName(t("settings.cardWidth.name"))
      .setDesc(t("settings.cardWidth.desc"))
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.cardWidth))
          .setValue(String(this.plugin.settings.cardWidth))
          .onChange(async (value) => {
            this.plugin.settings.cardWidth = normalizeCardWidth(value);
            await this.plugin.saveSettings();
            this.plugin.applyCardWidth();
          }),
      );

    // Phase 20：note 卡片最多显示几条（1-10；超出由视图截断，数据一条不丢）
    new Setting(containerEl)
      .setName(t("settings.noteLines.name"))
      .setDesc(t("settings.noteLines.desc"))
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.noteLines))
          .setValue(String(this.plugin.settings.noteLines))
          .onChange(async (value) => {
            this.plugin.settings.noteLines = normalizeNoteLines(value);
            await this.plugin.saveSettings();
            // 视图在下次渲染 / 局部刷新时读 `host.noteLines()`，这里不必额外触发重画
          }),
      );

    // ④ 统计：图表文件根目录 + 图表文件目录
    new Setting(containerEl).setName(t("settings.group.stats")).setHeading();

    // Phase 37：「图表文件根目录」—— 决定 plot 目录的前缀（看板根 / 仓库根）
    new Setting(containerEl)
      .setName(t("settings.plotRoot.name"))
      .setDesc(t("settings.plotRoot.desc"))
      .addDropdown((dropdown) => {
        dropdown.addOption("board", t("settings.plotRoot.board"));
        dropdown.addOption("vault", t("settings.plotRoot.vault"));
        dropdown.setValue(normalizePlotRoot(this.plugin.settings.plotRoot)).onChange(async (value) => {
          this.plugin.settings.plotRoot = normalizePlotRoot(value);
          await this.plugin.saveSettings();
          // 有效目录是现算的（`host.plotFolder()`）→ 下次渲染 / 写入就落新位置
        });
      });

    // Phase 19 M3：365 天 plot 的目录（**相对名**；实际落点见上面的根目录选择）
    new Setting(containerEl)
      .setName(t("settings.plotFolder.name"))
      .setDesc(t("settings.plotFolder.desc"))
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.plotFolder)
          .setValue(this.plugin.settings.plotFolder)
          .onChange(async (value) => {
            this.plugin.settings.plotFolder = normalizeRelativeFolder(value);
            await this.plugin.saveSettings();
          }),
      );
  }
}

