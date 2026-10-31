/**
 * dataviewjs 视图 v1（Phase 1：只读两块 + 右键写回挂载点；Phase 3：正计时器 + 近 21 天方块阵；
 * Phase 4：右键归档入口 + ③ 已归档块；Phase 5：① 近 21 天甘特图 / ② 右键「编辑节点信息」/
 * ③ 「正在进行」块尾的「修改工作流」按钮）。
 *
 * 结构（从上到下，Phase 16 定稿，Phase 17 微调，Phase 18 加标题行）：
 *   ⓪ 引导性大标题：`div.wf-app-title`（用户文案来自插件设置 `resumePrompt`，空则用 i18n
 *      「下一步是？」；Phase 18 ③）—— 渲染区最顶部，在「状态总览」之上；
 *   ① 状态总览：第 1 行 = 主题切换按钮组（9 套主题，点了只写本文件 `wf-theme`）/
 *      第 2 行 = 正计时器（有进行中的计时条目时才有：`正在：<节点标题>` / 黑底白字 `HH:MM:SS` /
 *        「结束并记录 · 结束并丢弃」快捷按钮；Phase 3 视图微调 v0.7）；
 *        **不计时时**换成「上次：<节点标题> ▶️ 继续计时」（Phase 17，两者互斥）；
 *        Phase 18 起收成**一个**按钮：`上一个任务：<title> · 继续这个任务`；
 *      第 3 行 = 统计文本 `进行：a/B 受阻：n`（只统计 state 缺省＝进行中的 workflow 的节点）
 *   ② 主体（Phase 16）：左侧小工具侧边栏（🙂 365 天 emo / 📊 21 天甘特图 / 🎯 四象限 /
 *      📦 已归档 / 📈 365 天 plot / ⚙️ 插件设置）+ 右侧工作区：
 *      「正在进行」块按 workflow **横向分栏**（一栏一条泳道，栏内横向滚动；
 *      Phase 17 起泳道正文区各自纵向滚动＝每条泳道一条滚动条、栏头固定，非首栏用左边框当分隔线）；
 *      `state` 为 archived / cancelled 的 workflow 进入「已完成流 / 已取消流」折叠区（仍用切换栏）；
 *      块尾按钮行（Phase 15 起同一行两个按钮）：「修改节点顺序」开关 + 「⚙️ 修改工作流…」按钮
 *   ③ 页脚：schema 版本与校验摘要
 *
 * 弹窗（Phase 16 ③）：侧边栏前 5 个按钮各开一个自绘浮层（`document.body.createDiv` +
 * `themeOverlay()`，不是 Obsidian 的 `Modal`）—— 同一时刻只开一个，只有「×」能关
 * （点空白 / Esc 都不关；边界与取舍见 doc/datacontact/data_ixd_discuss_interact_v0.16.md §③）。
 * Phase 18 ①：浮层外面多一层全屏半透明遮罩 `.wf-widget-overlay`（吃掉下层点击，但**点它不关闭**）；
 * 整块重渲染与局部刷新都会把开着的弹窗跟着重画（`refreshOpenWidget`），换文件则不动它。
 * Phase 18 ④：🙂 365 天 emo 的画布 / 拍立得 / 输入弹窗在 `views/emoWidget.ts`（独立模块 + 独立配色），
 * 这里只把它挂进 `WIDGETS`，并在关弹窗 / 卸载时一并清掉它的浮层（`closeEmoFloats`）。
 *
 * 边界（与 doc/datacontact/data_ixd_discuss_interact.md 的路线一致）：
 *  - 读：只走 `host.analyzeFile(file)`（引擎在内存中把 1.0 / 1.1 / 1.3 / 1.6 升格为 1.9，**不落盘**）；
 *  - 写：唯一入口是 `host.setNodeStatus()` / `host.promptAddChild()` /
 *    `host.confirmDeleteNode()` / `host.startTimer()` / `host.stopTimer()` / `host.promptArchiveNode()` /
 *    `host.editNodeInfo()` / `host.editWorkflows()` / `host.moveNode()`；其中「开始 / 结束计时」两处入口 ——
 *    节点右键菜单、总览正计时器上的快捷结束按钮 —— 共用同一段 `stopTimer` 回调（写回 → 提示 → 局部刷新）；
 *    成功后按返回的 `changedNodeIds` **局部刷新**（只重建受影响的列），定位不到就退回整块重渲染；
 *    ③ 修改工作流带了**结构变化**（增删 workflow）时直接整块重渲染（`refresh`），只改字段才局部刷新。
 *  - 稳定视图（v0.7 §⑦ / §⑨-9）：整块重渲染按 `file.path` **串行 + last-wins** —— 写 `wf-theme`
 *    会同时引出「插件 `refresh()`」与「Dataview 自动重跑 dataviewjs 块」两条重渲染，交错就会跳位；
 *    单轮里的顺序是「先 `analyzeFile` → 再抓滚动 → 清空 → 重建 → 恢复」，空容器不进 await。
 *  - 布局：根节点第 0 列；第 1 个子节点同列下一行；第 2..n 个子节点各自右开一列（行号对齐）；连线用 CSS；
 *  - 单文件视图：不扫 ./archive/，归档 workflow 来自本文件 `workflows[]`；③ 已归档块同样**不扫目录**，
 *    行里的归档 md 链接直接读浓缩节点的 `archive.file`（磁盘上那份由插件侧归档时写出来）；
 *  - DOM：`document` **不是容器**！Obsidian 的 `createEl` / `createDiv` 是「创建 + append 到接收者」，
 *    写 `document.createDiv()` 会往 document 根节点 append → `HierarchyRequestError: Only one element
 *    on document allowed`。游离（还没挂父级）的元素一律走 `detachedDiv()`。
 */

import type { App, TFile  } from "obsidian";
import { setIcon } from "obsidian";   // 文件顶部，已有 obsidian import 就合并进去
import {
  FRONTMATTER_FIELDS,
  IMPORTANCE_LABELS,
  URGENCY_LABELS,
  GANTT_SLOTS_PER_DAY,
  GANTT_SLOT_MINUTES,
  NODE_STATUSES,
  aggregateTimeEntries,
  statusLabel,
  stateLabel,
  t,
  weekdayName,
  timerInvalidStartMessage,
  progressPercent,
  archiveEligibility,
  extractArchiveReference,
  buildGantt,
  buildHeatmap,
  formatClock,
  formatIssues,
  formatLocalDate,
  formatMinuteOfDay,
  formatWorkDuration,
  formatStatusOverview,
  ganttTickHours,
  groupWorkflows,
  parseIso,
  summarizeDocument,
  walkNodes,
  walkWorkflow,
  wholeDaysFromTo,
  completedHours,
  type ActiveTimer,
  type AnalyzeResult,
  type DocumentSummary,
  type GanttSpan,
  type HeatmapCell,
  type LinkType,
  type NodeStatus,
  type ParsedNoteLink,
  type ReorderPosition,
  type StopTimerMode,
  type TimeAggregate,
  type WfArchive,
  type WfIssue,
  type WfJsonDocument,
  type WfNode,
  type WfTimeEntry,
  type WfWorkflow,
  type WorkflowState,
} from "../src/engine/index.ts";
import { closeEmoFloats, renderEmo365 } from "./emoWidget.ts";
import { renderPlot } from "./plotWidget.ts";
import { renderQuadrant } from "./quadrantWidget.ts";

/* ------------------------------------------------------------------ *
 * 对外契约（main.ts 的 WfJsonWorkflowPlugin 实现 WfViewHost）
 * ------------------------------------------------------------------ */

/** 改状态的附加信息（缺省只用 nodeId + status） */
export interface NodeStatusChangeOptions {
  note?: string;
  by?: string;
}

/** 改状态的结构化返回（视图按 success / changed / issues 决定提示与重渲染） */
export interface NodeStatusChangeResult {
  success: boolean;
  /** 文件路径（便于日志） */
  file?: string;
  nodeId: string;
  /** 请求的目标状态 */
  status: NodeStatus;
  /** 文档是否真的被改动（false = 状态本来就一样 或 被拒绝未写） */
  changed: boolean;
  /** 失败原因（success = false 时） */
  reason?: string;
  /** 写回后的校验问题（成功时是写回后的结果；失败时是当前文本的结果） */
  issues: WfIssue[];
}

/**
 * 编辑节点信息（Phase 5 ②）的返回：`changedNodeIds` 便于局部刷新。
 */
export interface NodeInfoChangeResult {
  success: boolean;
  file?: string;
  nodeId: string;
  changed: boolean;
  reason?: string;
  issues: WfIssue[];
  /** 受影响节点（写回到哪些节点就让视图刷新哪些列） */
  changedNodeIds: string[];
}

/**
 * 修改工作流（Phase 5 ③）的返回：
 * `structureChanged = true` 表示**增删了 workflow**（泳道要搬家）→ 视图必须整块重渲染。
 */
export interface WorkflowChangeResult {
  success: boolean;
  file?: string;
  changed: boolean;
  reason?: string;
  issues: WfIssue[];
  /** 受影响节点（只改字段时生效） */
  changedNodeIds: string[];
  /** 有增删 → 整块重渲染；只改字段 → 局部刷新 */
  structureChanged: boolean;
}

/**
 * 调整节点顺序（Phase 15）的返回：与 `NodeInfoChangeResult` 同形。
 * `changed = false` 表示拓扑没变（引擎判 `unchanged`）→ 没写盘，视图也不用重画。
 */
export interface ReorderResult {
  success: boolean;
  file?: string;
  changed: boolean;
  reason?: string;
  issues: WfIssue[];
  /** 受影响节点（拓扑变化一律整块重渲染，这里只给日志 / 调试用） */
  changedNodeIds: string[];
}

/** 加子节点的返回：除上面的字段外还带回新节点 id（视图据此定位新列） */
export interface AddChildNodeResult {
  success: boolean;
  file?: string;
  /** 父节点 id */
  nodeId: string;
  changed: boolean;
  reason?: string;
  issues: WfIssue[];
  changedNodeIds: string[];
  /** 新建节点的 id（success = true 时才有） */
  childId?: string;
  /** 标题被清洗（换行 / 首尾空白）时的提示，供视图提醒用户 */
  warnings?: string[];
}

/** 删节点的返回：带回父节点 id（视图清理注册表要用） */
export interface DeleteNodeResult {
  success: boolean;
  file?: string;
  nodeId: string;
  changed: boolean;
  reason?: string;
  issues: WfIssue[];
  changedNodeIds: string[];
  /** 被删节点的父节点 id（根节点没有父节点，删不掉） */
  parentId?: string;
  /** Phase 9：本次删除是否把被删节点的纪要超链接合并进父节点 */
  mergeLinks?: boolean;
}

/** 归档节点的返回（Phase 4）：另带归档 md 路径 / 复用标记与浓缩的节点数 */
export interface ArchiveNodeResult {
  success: boolean;
  file?: string;
  /** 被浓缩的节点 id（子树根） */
  nodeId: string;
  changed: boolean;
  reason?: string;
  issues: WfIssue[];
  changedNodeIds: string[];
  /** 归档 md 的 vault 路径（`archive/<workflowId>-<nodeId>.md`） */
  archiveFile?: string;
  /** 归档 md 里那个新工作流的 id */
  workflowId?: string;
  /** 浓缩进归档 md 的节点数（含子树根） */
  nodeCount?: number;
  /** true = 扫到上次的归档 md 就复用它（幂等重试），没有新建 */
  reusedArchiveFile?: boolean;
}

/**
 * 计时动作（开始 / 结束并记录 / 结束并丢弃）的返回（Phase 3 契约 §5.1 / §5.2）：
 * 与 `NodeInfoChangeResult` 同形，另带本次涉及的条目下标与动作模式。
 */
export interface TimerChangeResult {
  success: boolean;
  file?: string;
  nodeId: string;
  changed: boolean;
  reason?: string;
  issues: WfIssue[];
  /** 受影响节点（写回到哪些节点就让视图刷新哪些列） */
  changedNodeIds: string[];
  /** 本次动作涉及的条目下标（success = true 时给出） */
  entryIndex?: number;
  /** 结束动作的模式（`startTimer` 不带该字段） */
  mode?: StopTimerMode;
}

/**
 * Modal 的产出：`cancelled = true` 表示用户点了取消 / 直接关掉，
 * 此时 `result` 缺省，视图不提示、不重渲染（「取消」不是失败）。
 */
export interface ModalEditOutcome<T> {
  cancelled: boolean;
  result?: T;
}

/** dataviewjs 侧的 `dv`（只用得到这三样） */
export interface WfViewApi {
  app: App;
  container: HTMLElement;
  /** 当前笔记路径（Dataview 提供；缺失时回退到活动文件） */
  currentFilePath?: string;
}

/** 主题选项（Phase 6）：`key` 与 styles.css 的 `[data-wf-theme="…"]` 一一对应，`label` 是中文文案 */
export interface WfThemeOption {
  key: string;
  label: string;
}

/**
 * 渲染输入参数（Phase 9 v0.7 ①）：`render(dv, options?)`。
 * 后续新增参数都往这里加；不传时全部取默认值（旧笔记的 `render(dv)` 照常工作）。
 */
export interface WfViewOptions {
  /** 主题 key；优先于文件 frontmatter `wf-theme` 与全局默认主题 */
  theme?: string;
}

/** 视图需要的插件能力（由 main.ts 实现；测试里可用最小替身 + DOM 桩） */
export interface WfViewHost {
  app: App;
  analyzeFile(file: TFile): Promise<AnalyzeResult>;
  setNodeStatus(
    file: TFile,
    nodeId: string,
    status: NodeStatus,
    options?: NodeStatusChangeOptions,
  ): Promise<NodeStatusChangeResult>;
  /**
   * Modal 入口：加子节点 → 内部走 `addChildNode`；取消时 `cancelled = true`
   */
  promptAddChild(file: TFile, node: WfNode): Promise<ModalEditOutcome<AddChildNodeResult>>;
  /** Modal 入口：二次确认删节点 → 内部走 `deleteNode`；取消时 `cancelled = true` */
  confirmDeleteNode(file: TFile, node: WfNode): Promise<ModalEditOutcome<DeleteNodeResult>>;
  /**
   * Modal 入口：「📦 为此及之后归档」→ 收集 `summary` / `idea` / `review` 后
   * 内部走「`planArchive` → vault 建 `archive/<workflowId>-<nodeId>.md` → 本文件写回浓缩节点」；
   * 取消时 `cancelled = true`（视图不提示、不刷新）。
   */
  promptArchiveNode(file: TFile, node: WfNode): Promise<ModalEditOutcome<ArchiveNodeResult>>;
  /**
   * Modal 入口：「✏️ 编辑节点信息…」（Phase 5 ②）→ 分字段表单收集
   * `summary / type / importance / progress / owner / dueAt` 后内部走 `setNodeInfo`；
   * 取消时 `cancelled = true`（视图不提示、不刷新）。
   */
  editNodeInfo(file: TFile, node: WfNode): Promise<ModalEditOutcome<NodeInfoChangeResult>>;
  /**
   * Modal 入口：「⚙️ 修改工作流…」（Phase 5 ③）→ 分字段 + 增删的表单，
   * 保存时内部走「引擎 `applyWorkflowEdits` → `mutateFile`」**一次写回**；
   * 取消时 `cancelled = true`。
   */
  editWorkflows(file: TFile): Promise<ModalEditOutcome<WorkflowChangeResult>>;
  /**
   * Phase 15：拖拽改节点顺序（`position` = 落在目标卡片上半 `before` / 下半 `after`）。
   * 内部走引擎 `moveNode`（只改 `children` 的归属与顺序，schema 不变）；
   * 拓扑没变（拖回原位）时返回 `changed = false`，视图据此不重渲染。
   */
  moveNode(file: TFile, movingId: string, targetId: string, position: ReorderPosition): Promise<ReorderResult>;
  /** 「▶️ 开始这个任务」→ 内部走引擎 `startTimerEntry`（并发闸门：全文件只允许一个） */
  startTimer(file: TFile, nodeId: string): Promise<TimerChangeResult>;
  /** 「结束并记录」/「结束并丢弃」→ 内部走引擎 `stopTimerEntry`（节点右键菜单与总览计时器按钮共用） */
  stopTimer(file: TFile, nodeId: string, mode: StopTimerMode): Promise<TimerChangeResult>;
  /* ---- Phase 6/9 主题（主题跟随文件） ---- */
  /** 可选主题清单（插件提供；为空时视图不渲染切换入口） */
  themes: readonly WfThemeOption[];
  /** 全局默认主题（文件没写 `wf-theme`、render 没传 options.theme 时回落） */
  defaultTheme: string;
  /** 只写本文件 frontmatter `wf-theme`（不碰全局设置；视图随后自行重渲染） */
  setFileTheme(file: TFile, theme: string): Promise<void>;
  /** 提示信息（插件侧实现为 Notice；视图不直接依赖 Obsidian 运行时） */
  notify(message: string): void;
  /**
   * Phase 16：打开本插件的设置页（侧边栏第 6 个按钮 ⚙️）。
   * 走 Obsidian 的 `app.setting.openTabById(manifest.id)`，插件侧实现；视图只管调用。
   */
  openSettings(): void;
  /**
   * Phase 18 ③：渲染区顶部大标题的文案（插件设置 `resumePrompt`）。
   * 空串 = 视图回落到 `t("view.appTitle.default")`（「下一步是？」/「What's next?」）——
   * 存空串而不是存中文，语言切换时标题才会跟着变。
   */
  resumePrompt(): string;
  /**
   * Phase 18 ④-E：365 天见闻 md 的目录（插件设置 `dailyFolder`，默认 `daily`）。
   * 视图拼 `${dailyFolder()}/YYYY-MM-DD.md`；目录由 `views/emoWidget.ts` 在第一次写入时创建。
   */
  dailyFolder(): string;
  /**
   * Phase 19 M1 ①：365 天 emo 的**独立主题**（`default / weave / candy`）。
   * 与插件主题无关：emo 根元素挂 `.wf-emo--<theme>`，不进 `[data-wf-theme]`。
   */
  emoTheme(): string;
  /** Phase 19 M1 ①：画布上「灵动岛」切换主题 → 落盘（视图只换 class，不重渲染） */
  setEmoTheme(theme: string): Promise<void>;
  /**
   * Phase 19 M3：365 天 plot 的目录（插件设置 `plotFolder`，默认 `plots`）。
   * 视图拼 `${plotFolder()}/plot-<uuid>.json`（导出的 CSV 也在同一目录）。
   */
  plotFolder(): string;
}

/** 判断 dataviewjs 传进来的 dv 是否可用（避免在错误的上下文里炸掉整个代码块） */
export function isViewApi(value: unknown): value is WfViewApi {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as { app?: unknown; container?: unknown };
  return typeof candidate.app === "object" && candidate.app !== null && candidate.container instanceof HTMLElement;
}

/* ------------------------------------------------------------------ *
 * 展示用常量（样式细节统一放 styles.css，这里只挂 class）
 * ------------------------------------------------------------------ */

const STATUS_ICON: Readonly<Record<NodeStatus, string>> = {
  todo: "⚪",
  doing: "🔵",
  done: "✅",
  blocked: "🚧",
  cancelled: "🚫",
};

const LINK_ICON: Readonly<Record<LinkType, string>> = {
  md: "📄",
  web: "🌐",
  image: "🖼",
  file: "📎",
};

/* ------------------------------------------------------------------ *
 * 节点注册表 + DOM 折叠状态（Phase 2：写回后只重建受影响的列）
 * ------------------------------------------------------------------ */

/** 一个节点的 DOM 句柄：列元素（可整列替换）+ 列内的卡片（用于不整列重排的小修） */
interface NodeHandles {
  column: HTMLElement;
  card: HTMLElement;
  /** 是否是 workflow 根节点（根不能删、也只能在泳道里） */
  isRoot: boolean;
}

/** 按文件路径分桶：同一视图先后渲染不同笔记时不会互相踩 */
const nodeRegistry = new Map<string, Map<string, NodeHandles>>();

/**
 * DOM 级折叠状态（用户点过三角的结果）。
 * 只在「一次渲染会话」内有效：整块重渲染会清空（回到 JSON 里的 `collapsed` 事实）。
 */
const collapseState = new Map<string, Set<string>>();

/* ------------------------------------------------------------------ *
 * Phase 15：拖拽改节点顺序的视图状态（全部是会话内存，不落盘）
 * ------------------------------------------------------------------ */

/**
 * 开了「修改节点顺序」的文件（键 = `file.path`）。
 * 与 `laneSelections` 同一惯例：只存视图会话内存，Obsidian 重启 / 重开文件回到「关」。
 * 注意它**不**在 `beginRender()` 里清空 —— 开关本身就是要跨整块重渲染保留（切主题 / Dataview 重跑）。
 */
const reorderEnabled = new Set<string>();

/** 正在拖的源节点 id（一次只可能有一个；`drop` / `dragend` / 整块重渲染都会清空） */
let draggingNodeId: string | null = null;

/**
 * 落点判定（纯函数，便于 `node --test` 直接断言）：
 * 指针在卡片上半 → `before`（插到它之前，同级）；下半（含正中线）→ `after`（成为它的子节点）。
 */
export function resolveDrop(rect: { top: number; height: number }, clientY: number): ReorderPosition {
  return clientY < rect.top + rect.height / 2 ? "before" : "after";
}

/** 建会话时收集的泳道信息：id → 泳道头元素 / id → 分组（"" = 进行中） */
interface LaneIndex {
  heads: Map<string, HTMLElement>;
  layout: Map<string, string>;
  /** Phase 16：只有「正在进行」的分栏栏头带颜色方块（折叠区不带）→ 记下画色用的下标 */
  colors: Map<string, number>;
}

/**
 * 一次整块渲染留下的「外壳」句柄：总览 / 页脚 / 泳道头 / 侧边栏按钮 / 弹窗上下文。
 * 局部刷新时只原位改这几处文字 + 重建受影响的列，树上的展开状态因此不会丢。
 */
interface RenderSession {
  overview: HTMLElement;
  footer: HTMLElement;
  lanes: LaneIndex;
  /** 本次渲染解析出的主题 key（局部刷新重画总览时保持按钮选中态） */
  theme: string;
  /** Phase 16：侧边栏按钮（「已归档（n）」这类标题要跟着局部刷新） */
  widgetButtons: WidgetButton[];
  /** Phase 16：侧边栏 / 弹窗共用的绘图上下文（局部刷新时就地更新字段，闭包不用重挂） */
  ctx: WidgetContext;
}

const renderSessions = new Map<string, RenderSession>();

/**
 * 计时聚合缓存（每个文件一份）：右键菜单据此决定显示「开始」还是「结束」，
 * 与 `renderSessions` 一样按 `file.path` 分桶，整块重渲染 / 局部刷新后都会被刷新。
 */
const timeAggregates = new Map<string, TimeAggregate>();

/**
 * Phase 9：每个文件的「节点 id → 正文超链接」（`analyzeFile` 的 `noteLinks`）。
 * 视图不再读 `node.links`（已弃用 / 写回时迁进正文），卡片实线边框与右键资料菜单都从这里取。
 */
const noteLinksByPath = new Map<string, Map<string, ParsedNoteLink[]>>();

/**
 * Phase 9 v0.7 ④：工作流切换栏的选中下标（按 file.path + 分区 active / archived / cancelled）。
 * 只存视图会话内存：整块重渲染保留；workflow 不在列表时回落到 0。
 */
const laneSelections = new Map<string, Map<string, number>>();

function selectedWorkflowIndex(file: TFile, section: string, length: number): number {
  if (length <= 0) return 0;
  const stored = laneSelections.get(file.path)?.get(section) ?? 0;
  return stored >= 0 && stored < length ? stored : 0;
}

function setSelectedWorkflowIndex(file: TFile, section: string, index: number, length: number): number {
  if (length <= 0) return 0;
  const normalized = ((index % length) + length) % length;
  let bucket = laneSelections.get(file.path);
  if (bucket === undefined) {
    bucket = new Map<string, number>();
    laneSelections.set(file.path, bucket);
  }
  bucket.set(section, normalized);
  return normalized;
}

/** 最近一次渲染的主题（挂到 body 的菜单 / tooltip 用它上色，避免弹层丢主题） */
let activeViewTheme = "default";

/** 给挂到 `document.body` 的浮层套上当前主题（变量作用域在 `.wf-theme[data-wf-theme]`） */
function themeOverlay(element: HTMLElement): void {
  element.classList.add("wf-theme");
  element.setAttribute("data-wf-theme", activeViewTheme);
}

/** 某节点在正文纪要段里的超链接（没有段落 / 没有链接时是空数组） */
function noteLinksOf(file: TFile, nodeId: string): ParsedNoteLink[] {
  return noteLinksByPath.get(file.path)?.get(nodeId) ?? [];
}

/** 每次整块重渲染开始：清注册表 / 会话 / 折叠状态 / 计时聚合，并停掉旧的正计时 tick */
function beginRender(path: string): void {
  nodeRegistry.delete(path);
  renderSessions.delete(path);
  collapseState.delete(path);
  timeAggregates.delete(path);
  noteLinksByPath.delete(path);
  // Phase 15：整块重渲染会让拖拽句柄作废 → 清掉「正在拖」的残留状态（开关本身保留，见 reorderEnabled）
  draggingNodeId = null;
  stopTimerTicker();
  closeHeatTip();
}

/* ------------------------------------------------------------------ *
 * 正计时器（Phase 3 契约 §7.1）：tick 单例
 * ------------------------------------------------------------------ */

/**
 * tick 句柄（模块级**单例**）。
 * 类型故意留 `unknown`：DOM 与 @types/node 各有一套 `setInterval` 签名，
 * 这里只做「存下 / 清掉」，不关心它是 number 还是 Timeout（清句柄时统一断言）。
 */
let timerHandle: unknown = null;

/** 停掉正计时 tick（重渲染 / 插件卸载 / 单测收尾都要调，否则 interval 会叠加） */
export function stopTimerTicker(): void {
  if (timerHandle !== null) {
    clearInterval(timerHandle as Parameters<typeof clearInterval>[0]);
    timerHandle = null;
  }
}

/** 计时文本：`HH:MM:SS`；开始时间晚于现在（含无法解析）→ 失效文案（与写回拒绝理由同一句） */
function updateClock(clock: HTMLElement, startAt: string): void {
  const ms = Date.now() - Date.parse(startAt);
  const invalid = Number.isNaN(ms) || ms < 0;
  clock.setText(invalid ? timerInvalidStartMessage() : formatClock(ms));
  // 失效文案比 36px 的 HH:MM:SS 长得多 → 加类降字号（挂/摘切换，避免每秒重复写类）
  if (clock.classList.contains("wf-timer-clock--invalid") !== invalid) {
    clock.classList.toggle("wf-timer-clock--invalid");
  }
}

/* ------------------------------------------------------------------ *
 * 方块阵悬浮详情（Phase 3 契约 §7.2）
 * ------------------------------------------------------------------ */

let heatTipEl: HTMLElement | null = null;

/** 关掉方块阵悬浮详情（整块重渲染前也会调） */
function closeHeatTip(): void {
  if (heatTipEl) {
    heatTipEl.remove();
    heatTipEl = null;
  }
}

/**
 * 取元素的屏幕位置。单测的 DOM 桩没有 `getBoundingClientRect`，
 * 因此这里做存在性判断并回落成全 0（tooltip 在真实环境才需要真实坐标）。
 */
function rectOf(element: HTMLElement): { left: number; top: number; bottom: number } {
  const probe = element as unknown as { getBoundingClientRect?: () => { left: number; top: number; bottom: number } };
  return probe.getBoundingClientRect?.() ?? { left: 0, top: 0, bottom: 0 };
}

function registerNode(path: string, nodeId: string, handles: NodeHandles): void {
  let bucket = nodeRegistry.get(path);
  if (bucket === undefined) {
    bucket = new Map<string, NodeHandles>();
    nodeRegistry.set(path, bucket);
  }
  bucket.set(nodeId, handles);
}

/** 折叠 = JSON 里写了 `collapsed: true` 或 用户刚点过三角收起 */
function isCollapsed(path: string, node: WfNode): boolean {
  if (node.collapsed === true) return true;
  return collapseState.get(path)?.has(node.id) === true;
}

/** 记下用户点三角的结果（true = 现在收起了） */
function setCollapsed(path: string, nodeId: string, collapsed: boolean): void {
  let set = collapseState.get(path);
  if (set === undefined) {
    set = new Set<string>();
    collapseState.set(path, set);
  }
  if (collapsed) set.add(nodeId);
  else set.delete(nodeId);
}

/** 元素是否还挂在渲染树上（局部刷新时用来淘汰旧句柄） */
function isAttached(element: HTMLElement): boolean {
  return element.parentElement !== null;
}

/* ------------------------------------------------------------------ *
 * 整块重渲染的串行化（同一文件同一时刻只跑一轮）
 * ------------------------------------------------------------------ */

interface RenderQueue {
  /** 是否有一轮正在跑（之后来的请求一律排队） */
  running: boolean;
  /** 排队中最新的那一份（last-wins：后来的覆盖先来的） */
  task: (() => Promise<void>) | null;
  /** 等「下一轮跑完」的调用方（被覆盖的请求也挂在这里，跑完一起放行） */
  waiters: Array<(error: unknown) => void>;
}

/** file.path → 队列（跑完即删，不长期占内存） */
const renderQueues = new Map<string, RenderQueue>();

/**
 * 排队并等待「最终落地的那一次」整块重渲染。
 *
 * 为什么需要（v0.7 §⑨-9）：主题按钮写 `wf-theme` 会同时引出**两条**整块重渲染 ——
 * ① 视图自己的 `refresh()`；② Obsidian 检测到 frontmatter 变化后，Dataview 自动重跑
 * dataviewjs 块（又调一次 `render(dv)`）。两条都做「抓滚动 → 清空 → 重建 → 恢复滚动」，
 * 交错执行时后者的快照可能取自已经被清空的容器（滚动宿主塌缩 → 读到 0），
 * 恢复后视图就跳到别处；且纯粹是时序竞态，所以时好时坏。
 *
 * 这里按文件路径**串行 + last-wins**：运行中来的新请求覆盖掉还没跑的旧请求；
 * 被覆盖的调用方与真正跑的那次一起放行（两边都是「最新状态已落地」）。
 */
function enqueueRender(path: string, task: () => Promise<void>): Promise<void> {
  const queue: RenderQueue = renderQueues.get(path) ?? { running: false, task: null, waiters: [] };
  renderQueues.set(path, queue);
  queue.task = task;
  const settled = new Promise<void>((resolve, reject) => {
    queue.waiters.push((error) => {
      if (error === null) resolve();
      else reject(error);
    });
  });
  // 首次请求同步开跑（`drainRenderQueue` 在第一个 await 之前就把 running 置真）
  if (!queue.running) void drainRenderQueue(path, queue);
  return settled;
}

/** 串行执行队列：跑完当前任务后只补跑「最新的一份」 */
async function drainRenderQueue(path: string, queue: RenderQueue): Promise<void> {
  queue.running = true;
  try {
    while (queue.task !== null) {
      const task = queue.task;
      const waiters = queue.waiters;
      queue.task = null;
      queue.waiters = [];
      let failure: unknown = null;
      try {
        await task();
      } catch (error) {
        failure = error ?? new Error(t("view.renderFailed"));
      }
      waiters.forEach((settle) => settle(failure));
      if (failure !== null) {
        // 失败：排队的请求一起失败（不把坏状态留在队列里，下一次点击算新的一轮）
        const leftovers = queue.waiters;
        queue.task = null;
        queue.waiters = [];
        leftovers.forEach((settle) => settle(failure));
      }
    }
  } finally {
    queue.running = false;
    if (renderQueues.get(path) === queue) renderQueues.delete(path);
  }
}

/* ------------------------------------------------------------------ *
 * 渲染入口
 * ------------------------------------------------------------------ */

/**
 * 渲染入口（Phase 9）：笔记里写
 * `await app.plugins.plugins["wfjson-workflow"].render(dv)`，
 * 也可传 `render(dv, { theme: "tech" })`（优先级：options.theme → frontmatter → 全局默认）。
 */
export async function renderWorkflowView(
  host: WfViewHost,
  dv: WfViewApi,
  options: WfViewOptions = {},
): Promise<void> {
  const container = dv.container;
  container.classList.add("wf-view", "wf-theme");
  const file = resolveSelfFile(host, dv);

  /**
   * 画一次。顺序是「**先分析（异步）→ 再抓滚动 → 清空 → 重建 → 恢复**」：
   * 旧实现先 `container.empty()` 再 `await analyzeFile`，容器在 await 期间是空的，
   * 滚动条会被浏览器夹到 0；此时任何并发的一轮（Dataview 自动重跑）抓到的就是 0 → 跳位。
   * 换成现在的顺序后，「清空 → 重建」之间没有 await，浏览器根本没机会重排。
   */
  const paint = async (): Promise<void> => {
    if (!file) {
      const scroll = captureScroll(container);
      container.empty();
      activeViewTheme = host.defaultTheme;
      container.setAttribute("data-wf-theme", host.defaultTheme);
      container.createDiv({
        cls: "wf-hint",
        text: t("view.hint.noFile"),
      });
      // 没有文件就没有数据源：开着的弹窗留着也没意义（它的数据属于上一个文件）
      closeWidgetPopup();
      restoreScroll(scroll);
      return;
    }
    const result = await host.analyzeFile(file);
    // Phase 9 v0.7 ①：主题跟随文件（容器级），不再改全局设置 / `<html>`
    const theme = resolveViewTheme(host, options, result);
    const scroll = captureScroll(container);
    beginRender(file.path);
    container.empty();
    activeViewTheme = theme;
    container.setAttribute("data-wf-theme", theme);
    renderResult(host, container, file, result, () => void render(), theme);
    restoreScroll(scroll);
  };

  /** 同一文件先入队（串行），再等它落地 —— 插件 refresh 与 Dataview 重跑不会互相踩 */
  const render = (): Promise<void> => (file === null ? paint() : enqueueRender(file.path, paint));

  await render();
}

/** 主题 key 是否在宿主清单里（非法值一律忽略，继续往下回落） */
function isKnownTheme(host: WfViewHost, key: string | undefined): key is string {
  return typeof key === "string" && key.length > 0 && host.themes.some((theme) => theme.key === key);
}

/** 解析本视图主题：render options → 文件 frontmatter `wf-theme` → 全局默认 */
function resolveViewTheme(host: WfViewHost, options: WfViewOptions, result: AnalyzeResult): string {
  if (isKnownTheme(host, options.theme)) return options.theme;
  const stored = result.frontmatter.getString(FRONTMATTER_FIELDS.theme);
  if (isKnownTheme(host, stored)) return stored;
  return isKnownTheme(host, host.defaultTheme) ? host.defaultTheme : "default";
}

/* ------------------------------------------------------------------ *
 * 滚动位置保存 / 恢复（Phase 9 v0.7 ⑦：整块重渲染不跳回顶部）
 * ------------------------------------------------------------------ */

interface ScrollSnapshot {
  host: HTMLElement;
  top: number;
  windowY: number;
}

/**
 * 每个视图容器上次解析出的滚动宿主。
 *
 * 为什么缓存：容器被清空的那一瞬间 `scrollHeight <= clientHeight`，
 * 遍历祖先找不到「可滚动」的宿主就会回落成容器本身（读到 0）。
 * 缓存按**容器元素**（WeakMap，不跨笔记、不泄漏）记住上一次真正的宿主，
 * 空容器期间沿用它 —— 抓与恢复才是同一个元素。
 */
const scrollHostCache = new WeakMap<HTMLElement, HTMLElement>();

/** 是否是可滚动的宿主（DOM 桩 / 未布局时都是 0，判 false） */
function isScrollableHost(element: HTMLElement): boolean {
  const probe = element as unknown as { scrollHeight?: number; clientHeight?: number };
  return typeof probe.scrollHeight === "number" && typeof probe.clientHeight === "number" && probe.scrollHeight > probe.clientHeight;
}

/** 最近的可滚动祖先；空容器 / 未布局时沿用上次的宿主，再不行才回落到容器本身 */
function scrollHostOf(container: HTMLElement): HTMLElement {
  const cached = scrollHostCache.get(container);
  if (cached !== undefined && isScrollableHost(cached)) return cached;
  let current: HTMLElement | null = container.parentElement;
  while (current !== null) {
    if (isScrollableHost(current)) {
      scrollHostCache.set(container, current);
      return current;
    }
    current = current.parentElement;
  }
  return cached ?? container;
}

function captureScroll(container: HTMLElement): ScrollSnapshot {
  const host = scrollHostOf(container);
  const windowY = typeof window !== "undefined" && typeof window.scrollY === "number" ? window.scrollY : 0;
  return { host, top: typeof host.scrollTop === "number" ? host.scrollTop : 0, windowY };
}

/**
 * 同步恢复一次 + 之后连续两帧各补一次。
 *
 * 只补一帧时，若字体 / 图片在重建后才把内容撑高，浏览器可能把设置过的
 * `scrollTop` 又调回去；第二帧（布局稳定后）再钉一次最稳。
 * DOM 桩没有 `requestAnimationFrame` → 只做同步那次（单测因此是确定的）。
 */
function restoreScroll(snapshot: ScrollSnapshot): void {
  const apply = (): void => {
    if (snapshot.top > 0) snapshot.host.scrollTop = snapshot.top;
    if (snapshot.windowY > 0 && typeof window !== "undefined" && typeof window.scrollTo === "function") {
      window.scrollTo(0, snapshot.windowY);
    }
  };
  apply();
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") return;
  const raf = window.requestAnimationFrame.bind(window);
  raf(apply);
  raf(() => raf(apply));
}

/** 当前笔记：Dataview 的 currentFilePath 优先，回退到活动文件 */
function resolveSelfFile(host: WfViewHost, dv: WfViewApi): TFile | null {
  const path = dv.currentFilePath;
  if (path !== undefined && path.length > 0) {
    const found = host.app.vault.getAbstractFileByPath(path);
    // 鸭子判断而不是 instanceof：视图不引入 obsidian 的运行时依赖（便于 node --test）
    if (isMarkdownFile(found)) return found;
  }
  const active = host.app.workspace.getActiveFile();
  return active !== null && active.extension === "md" ? active : null;
}

/** 是否 md 文件（只用到 extension，避免依赖 Obsidian 的类实例） */
function isMarkdownFile(file: unknown): file is TFile {
  if (typeof file !== "object" || file === null) return false;
  return (file as { extension?: unknown }).extension === "md";
}

/* ------------------------------------------------------------------ *
 * Phase 16 ① 渲染区宽度：**纯 CSS**（`styles.css` 的 `.wf-view` + `--file-line-width`）
 *
 * 这里刻意什么都不做：
 *   - 不写 `--wf-view-w` 之类的内联变量（`width: 100%` + `max-width: 1400px` 已经跟窗口同步）；
 *   - 不挂 `resize` 监听（没有需要重算的量）；
 *   - 不改 Obsidian 的 sizer / content 类（v0.16.1 踩过：会把正文列压成「一行一个字」）。
 * ------------------------------------------------------------------ */


/* ------------------------------------------------------------------ *
 * Phase 16 ③④ 小工具侧边栏 + 通用弹窗
 *
 * 为什么不用 Obsidian 的 `Modal`：视图模块只依赖 DOM（`node --test` 里没有 Obsidian 运行时），
 * 弹窗因此与右键菜单 / 悬浮详情同一套做法 —— `document.body.createDiv` + `themeOverlay()`。
 * 取舍：不做全屏遮罩、点空白 / Esc 都不关，只有「×」能关（不抢走笔记里的其它交互）。
 * ------------------------------------------------------------------ */

/** 画弹窗内容用的上下文（局部刷新时就地换字段，闭包不用重挂） */
interface WidgetContext {
  host: WfViewHost;
  file: TFile;
  wfDoc: WfJsonDocument;
  time: TimeAggregate;
  result: AnalyzeResult;
  now: Date;
  refresh: () => void;
}

/** 侧边栏的一个按钮（局部刷新时要改标题里的计数） */
interface WidgetButton {
  widget: WidgetEntry;
  button: HTMLElement;
}

interface WidgetEntry {
  /** 稳定的内部标识（调试 / 断言用） */
  id: string;
  /** 侧边栏显示的图标 */
  icon: string;
  /** 名称的 i18n key */
  labelKey: string;
  /**
   * 弹窗宽度变体：`gantt` = 方块阵 + 甘特图那一栏更宽；`emo` = 365 天画布（独立配色）；
   * `quadrant` = 4 象限图（16 分区 + 右侧预览，需要更宽）；
   * `plot` = 365 天 plot（左侧列表 + 右侧折线，需要更宽）
   */
  variant?: "gantt" | "emo" | "quadrant" | "plot";
  /** 名称（缺省 = `labelKey` 的文案；「已归档」要带计数） */
  title?(ctx: WidgetContext): string;
  /** 画弹窗内容；缺省 = 占位文案（还没实现的小工具） */
  render?(body: HTMLElement, ctx: WidgetContext): void;
  /** 不走弹窗、直接调宿主 */
  action?: "openSettings";
}

/**
 * 侧边栏按钮（顺序固定：每天的情绪 → 21 天甘特图 → 四象限 → 已归档 → 365 天曲线 → 插件设置）。
 * 前 5 个开弹窗；第 6 个直接打开插件设置页。
 */
const WIDGETS: readonly WidgetEntry[] = [
  /*{
    id: "emo365",
    icon: "smile",
    labelKey: "view.widget.emo365",
    variant: "emo",
    // Phase 18 ④：画布 / 拍立得 / 输入弹窗都在 views/emoWidget.ts（独立配色，不随插件主题）
    render: (body, ctx) => renderEmo365(body, ctx.host, ctx.refresh),
  },*/
  {
    id: "gantt21",
    icon: "bar-chart-2",
    labelKey: "view.widget.gantt21",
    variant: "gantt",
    render: (body, ctx) => {
      renderHeatmap(body, ctx.time, ctx.now);
      // Phase 17：甘特图常开（不再需要 file —— 折叠态会话内存已撤掉）
      renderGantt(body, ctx.time, ctx.now);
    },
  },
  {
    id: "quadrant",
    icon: "target",
    labelKey: "view.widget.quadrant",
    variant: "quadrant",
    // Phase 19 M2：只读 wfjson（16 分区 + 右侧预览），不改任何数据
    render: (body, ctx) => renderQuadrant(body, ctx.wfDoc, ctx.now),
  },
  {
    id: "archive",
    icon: "package",
    labelKey: "view.block.archived",
    title: (ctx) => t("view.block.archived", { count: archiveTotal(ctx.wfDoc) }),
    render: (body, ctx) => renderArchiveWidget(body, ctx.host, ctx.file, ctx.wfDoc),
  },
  {
    id: "plot365",
    icon: "line-chart",
    labelKey: "view.widget.plot365",
    variant: "plot",
    // Phase 19 M3：plot 是独立 JSON（`plotFolder/plot-<uuid>.json`），与 wfjson 无关
    render: (body, ctx) => renderPlot(body, ctx.host, ctx.refresh),
  },
  { id: "settings", icon: "settings", labelKey: "view.widget.settings", action: "openSettings" },
];

/** 按钮名称 / 弹窗标题共用（「已归档（n）」这类要带数据的走 `widget.title`） */
function widgetLabel(widget: WidgetEntry, ctx: WidgetContext): string {
  return widget.title?.(ctx) ?? t(widget.labelKey);
}

/** 侧边栏：竖排方形图标按钮（挂在 `.wf-main` 的第一个子元素） */
function renderWidgetSidebar(parent: HTMLElement, ctx: WidgetContext): WidgetButton[] {
  const bar = parent.createDiv({ cls: "wf-sidebar" });
  //bar.setAttribute("aria-label", t("view.widget.sidebar"));
  const buttons: WidgetButton[] = [];
  for (const widget of WIDGETS) {
    const label = widgetLabel(widget, ctx);
    // 先建空 button，再单独放 icon 元素
    const button = bar.createEl("button", { cls: "wf-sidebar-btn" });
    const iconEl = button.createSpan({ cls: "wf-widget-icon" });
    setIcon(iconEl, widget.icon);
    //button.title = label;
    button.setAttribute("aria-label", label);
    button.onclick = () => {
      if (widget.action === "openSettings") {
        ctx.host.openSettings();
        return;
      }
      openWidgetPopup(widget, ctx);
    };
    buttons.push({ widget, button });
  }
  return buttons;
}

/** 当前打开的弹窗（单例：同一时刻只允许一个） */
interface WidgetPopupState {
  /** Phase 18 ①：全屏遮罩（弹窗的父元素；`closeWidgetPopup()` 删它就整块清掉） */
  overlay: HTMLElement;
  element: HTMLElement;
  title: HTMLElement;
  body: HTMLElement;
  widget: WidgetEntry;
  /** 弹窗属于哪个文件（别的文件重渲染时不跟着变） */
  filePath: string;
}

let widgetPopup: WidgetPopupState | null = null;

/**
 * 开一个弹窗（已开着就先关掉 —— 点谁显示谁，不叠层）。
 *
 * Phase 18 ①：根元素从 `.wf-widget-popup` 换成 `.wf-widget-overlay`（全屏半透明遮罩），
 * 弹窗作它的子元素。遮罩是 `position: fixed; inset: 0`，下层点击本来就被它挡住；
 * **点遮罩不关闭**（Phase 16 的关闭语义不变：只有「×」能关）。
 */
function openWidgetPopup(widget: WidgetEntry, ctx: WidgetContext): void {
  closeWidgetPopup();
  const overlay = document.body.createDiv({ cls: "wf-widget-overlay" });
  const element = overlay.createDiv({ cls: "wf-widget-popup" });
  // 宽度变体类（`--gantt` / `--emo` / `--quadrant`）：尺寸与配色都写在 styles.css 里
  if (widget.variant !== undefined) element.addClass(`wf-widget-popup--${widget.variant}`);
  const head = element.createDiv({ cls: "wf-widget-popup-head" });
  const title = head.createDiv({ cls: "wf-widget-popup-title" });
  const close = head.createEl("button", { cls: "wf-widget-popup-close", text: "×" });
  close.title = t("view.widget.close");
  close.setAttribute("aria-label", t("view.widget.close"));
  close.onclick = () => closeWidgetPopup();
  const body = element.createDiv({ cls: "wf-widget-popup-body" });
  widgetPopup = { overlay, element, title, body, widget, filePath: ctx.file.path };
  fillWidgetPopup(widgetPopup, ctx);
}

/**
 * 关弹窗。只有「×」会调（整块重渲染不关它）；
 * `main.ts` 的 `onunload` 也调一次 —— 弹窗挂在 `document.body` 上，不清掉会留在别的视图上。
 * Phase 18 ④：emo 的拍立得 / 输入弹窗也挂在 body 上，一并清掉（它们只从 emo 弹窗里打开）。
 */
export function closeWidgetPopup(): void {
  if (widgetPopup !== null) {
    widgetPopup.overlay.remove();
    widgetPopup = null;
  }
  // 拍立得 / 输入弹窗只从 emo 弹窗里打开，但卸载时也要兜住（onunload 走的就是这一条）
  closeEmoFloats();
}

/** 重画弹窗内容（首帧 / 数据变了都走这里）：标题 → 主题 → 内容 */
function fillWidgetPopup(state: WidgetPopupState, ctx: WidgetContext): void {
  state.title.setText(widgetLabel(state.widget, ctx));
  // 主题可能刚被切过（切主题 = 整块重渲染）→ 浮层也跟着换配色
  themeOverlay(state.overlay);
  // Phase 18 ④：emo 不随插件主题 → 遮罩上也钉成 default（配色在 .wf-widget-popup--emo 里自成一套）
  if (state.widget.variant === "emo") state.overlay.setAttribute("data-wf-theme", "default");
  state.body.empty();
  if (state.widget.render === undefined) {
    state.body.createDiv({ cls: "wf-widget-placeholder", text: t("view.widget.placeholder") });
    return;
  }
  state.widget.render(state.body, ctx);
}

/**
 * 数据变了：开着的弹窗跟着重画（整块重渲染末尾 / 局部刷新末尾都会调）。
 * 弹窗属于别的文件时不动它 —— 免得 A 笔记里点开的东西被 B 笔记的刷新改掉。
 */
function refreshOpenWidget(ctx: WidgetContext): void {
  if (widgetPopup === null || widgetPopup.filePath !== ctx.file.path) return;
  fillWidgetPopup(widgetPopup, ctx);
}

/** 侧边栏按钮标题（「已归档（n）」里的 n 变了要跟着更新） */
function refreshSidebarLabels(session: RenderSession): void {
  for (const { widget, button } of session.widgetButtons) {
    const label = widgetLabel(widget, session.ctx);
    button.title = label;
    button.setAttribute("aria-label", label);
  }
}

/** 一次渲染（容器由调用方清空）：坏数据只摊问题、不渲染树 */
function renderResult(
  host: WfViewHost,
  container: HTMLElement,
  file: TFile,
  result: AnalyzeResult,
  refresh: () => void,
  theme: string,
): void {
  if (!result.found) {
    container.createDiv({ cls: "wf-hint", text: t("view.hint.noBlock") });
    return;
  }
  if (result.hasError || !result.document) {
    renderIssueBox(container, result);
    return;
  }

  // 变量名不用 document：它会遮蔽全局 document，让 renderSubtree / renderCard 里的误用变隐蔽
  const wfDoc = result.latestDocument ?? result.document;
  const summary = summarizeDocument(wfDoc);
  const now = new Date();
  const time = aggregateTimeEntries(wfDoc);
  // Phase 9：视图读正文纪要段解析出的超链接（不再读 node.links）
  noteLinksByPath.set(file.path, result.noteLinks);
  // v0.7 §⑨-2：归档地址也在正文纪要段里（「归档：[[...]]」行），一次扫描供点击时用
  rememberArchiveRefs(file, result);

  // 会话：概览 / 页脚 / 泳道头的句柄留给局部刷新用（写回后不必整块重渲染）
  const lanes: LaneIndex = { heads: new Map(), layout: new Map(), colors: new Map() };
  const overview = renderOverview(container, host, file, refresh, summary, time, theme, wfDoc);
  // Phase 16：侧边栏 + 弹窗共用这一份上下文；局部刷新时就地换字段（闭包因此不用重挂）
  const ctx: WidgetContext = { host, file, wfDoc, time, result, now, refresh };
  const main = container.createDiv({ cls: "wf-main" });
  const widgetButtons = renderWidgetSidebar(main, ctx);
  const body = main.createDiv({ cls: "wf-main-body" });
  renderActiveBlock(host, body, summary, file, wfDoc, refresh, lanes,ctx);
  renderFold(host, body, file, wfDoc, "archived", refresh, lanes);
  renderFold(host, body, file, wfDoc, "cancelled", refresh, lanes);
  //const footer = renderFooter(container, result);
  const footer = container.createDiv({ cls: "wf-footer-hidden" });
  footer.style.display = "none"; 
  // 分栏是「全部进行中的 workflow 各一栏」，但分组快照必须覆盖全部 workflow：否则写回后 sameLayout 误判 → 无谓整块重渲染
  lanes.layout = layoutOf(wfDoc);
  renderSessions.set(file.path, { overview, footer, lanes, theme, widgetButtons, ctx });
  timeAggregates.set(file.path, time);
  // 弹窗开着就跟新数据一起重画（首帧渲染时它可能还开着另一个文件的 —— 那时候不动）
  refreshOpenWidget(ctx);
}

/** 数据有 error 时不渲染树，直接把问题摊开（避免在坏数据上误导） */
function renderIssueBox(container: HTMLElement, result: AnalyzeResult): void {
  const { error, warning, info } = result.counts;
  const box = container.createDiv({ cls: "wf-issue-box" });
  box.createDiv({
    cls: "wf-issue-title",
    text: t("view.hint.blocked", { error, warning, info }),
  });
  box.createEl("pre", { cls: "wf-issue-pre", text: formatIssues(result.issues, { maxIssues: 20 }) });
}

/* ------------------------------------------------------------------ *
 * Phase 18 ③：引导性大标题（`div.wf-app-title`）
 * ------------------------------------------------------------------ */

/**
 * 大标题文案：设置项优先，空串回落到 i18n（「下一步是？」/「What's next?」）。
 * 纯函数（便于单测直接断言回落口径）：`host.resumePrompt()` 可能返回带空白的串。
 */
export function appTitleText(host: WfViewHost): string {
  const custom = host.resumePrompt().trim();
  return custom.length > 0 ? custom : t("view.appTitle.default");
}

/**
 * 渲染区最顶部那一行大标题（真实 DOM 元素：承载用户文案，不能用伪元素顶替）。
 * 9 套主题的字体 / 字距 / 装饰全部在 styles.css 的 `[data-wf-theme="…"] .wf-app-title` 里，
 * 这里只挂 class。
 */
function renderAppTitle(container: HTMLElement, host: WfViewHost): HTMLElement {
  return container.createDiv({ cls: "wf-app-title", text: appTitleText(host) });
}

/**
 * ① 状态总览（Phase 16：三行固定顺序）：
 *   第 1 行 = 主题切换按钮组（9 套主题 / 只写本文件 `wf-theme`）—— 没有主题清单时整行不渲染；
 *   第 2 行 = 正计时器（标题行 + 时钟 + 快捷结束按钮，仅计时中才渲染）；
 *   第 3 行 = 统计文本 `进行：a/B 受阻：n`。
 *
 * 需要 `host` / `file` / `refresh`：计时器块里的「结束并记录 / 丢弃」按钮与主题按钮都要发起写回并刷新
 * （与节点右键菜单同一条链路）。
 */
function renderOverview(
  container: HTMLElement,
  host: WfViewHost,
  file: TFile,
  refresh: () => void,
  summary: DocumentSummary,
  time: TimeAggregate,
  theme: string,
  wfDoc: WfJsonDocument,
): HTMLElement {
  const box = container.createDiv({ cls: "wf-overview" });
  fillOverview(box, host, file, refresh, summary, time, theme, wfDoc);
  return box;
}

/**
 * 总览内容（先 empty 再填：局部刷新不动 DOM 归属，只换内容 + 重挂 tick）。
 * Phase 16：顺序改为「主题 → 计时 → 统计」（原先主题在末尾、方块阵 / 甘特图在这里，现已在 📊 弹窗里）。
 * Phase 17：第 2 行在**没有**进行中的计时时换成「上次：<节点标题> ▶️ 继续计时」（需要 `wfDoc` 找最后一条计时）。
 */
function fillOverview(
  box: HTMLElement,
  host: WfViewHost,
  file: TFile,
  refresh: () => void,
  summary: DocumentSummary,
  time: TimeAggregate,
  theme: string,
  wfDoc: WfJsonDocument,
): void {
  box.empty();
  // Phase 16 第 1 行：主题切换（`host.themes` 为空时整行不渲染）
  renderThemeSwitch(box, host, file, refresh, theme);
  // Phase 18 ③：引导性大标题**常驻**渲染区最顶部（没有 wfjson 块 / 坏数据时也显示 ——
  // 它是这块渲染区的标题，不是数据的一部分）
  //renderAppTitle(box, host);
  // Phase 16 第 2 行：正计时（计时中）/ Phase 17：继续上次（没有计时中）
  renderTimer(box, host, file, refresh, time.activeEntry, wfDoc);
}

/* ------------------------------------------------------------------ *
 * 主题切换入口（Phase 6 + Phase 9 主题跟随文件）
 * ------------------------------------------------------------------ */

/**
 * 「状态总览」块末尾的主题按钮组（Phase 9 v0.7 ①）：
 * 点一下 → `host.setFileTheme(file, key)`（只写本文件 frontmatter `wf-theme`）→ 整块重渲染。
 * 选中态用当前视图解析出的主题（`theme` 参数），不再读全局设置。
 *
 * `host.themes` 为空时不渲染（测试替身 / 旧宿主都不会出现空壳）。
 */
function renderThemeSwitch(
  box: HTMLElement,
  host: WfViewHost,
  file: TFile,
  refresh: () => void,
  theme: string,
): void {
  if (host.themes.length === 0) return;

  const row = box.createDiv({ cls: "wf-theme-switch" });
  row.createEl("span", { cls: "wf-theme-switch-label", text: t("view.theme.label") });
  const group = row.createDiv({ cls: "wf-theme-switch-group" });
  for (const option of host.themes) {
    const active = option.key === theme;
    const btn = group.createEl("button", {
      cls: active ? "wf-theme-btn wf-theme-btn--active" : "wf-theme-btn",
      text: option.label,
    });
    btn.onclick = async (): Promise<void> => {
      if (option.key === theme) return;
      btn.disabled = true;
      // v0.7 §⑨-7：catch 只包「写 frontmatter」，refresh() 放在 try 外面 ——
      // 否则渲染阶段的异常会被误报成「主题未写入」；错误信息原样透传，不做二次包装。
      let failure: string | undefined;
      try {
        await host.setFileTheme(file, option.key);
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
      } finally {
        btn.disabled = false;
      }
      if (failure !== undefined) {
        host.notify(t("view.theme.writeFailed", { reason: failure }));
        return;
      }
      refresh();
    };
  }
}

/* ------------------------------------------------------------------ *
 * 正计时器（契约 §7.1；Phase 3 视图微调 v0.7：独立成块 + 快捷结束按钮）
 * ------------------------------------------------------------------ */

/**
 * 渲染正计时器（独立成块、整块居中）：
 *  - 有进行中的条目 → 三行：`正在：<节点标题>`（小字）/ 黑底白字 `HH:MM:SS`（字号走 `--wf-timer-font-size`）/
 *    「结束并记录 · 结束并丢弃」两个按钮；首帧就写正确值（避免闪 00:00:00），随后每秒 tick；
 *  - tick 只改 `clock` 的 textContent（现算 `Date.now()-startAt`，不累计 → 不漂移）；
 *  - 按钮与节点右键菜单走**同一段** `stopTimer`（引擎 `stopTimerEntry`：并发闸门 / 负值 / 幂等照旧）。
 *
 * Phase 17：没有进行中的计时时，改为渲染一行「上次：<节点标题> ▶️ 继续计时」
 * （目标 = 全文件 `endAt` 最大的那条计时，见 `lastCompletedEntry()`）；两者互斥，永远不会同时出现。
 */
function renderTimer(
  box: HTMLElement,
  host: WfViewHost,
  file: TFile,
  refresh: () => void,
  active: ActiveTimer | undefined,
  wfDoc: WfJsonDocument,
): void {
  stopTimerTicker();
  if (active === undefined) {
    box.createDiv({ cls: "wf-app-title", text: appTitleText(host) });
    renderTimerResume(box, host, file, refresh, lastCompletedEntry(wfDoc));
    return;
  }

  const timer = box.createDiv({ cls: "wf-timer" });
  timer.createDiv({ cls: "wf-timer-label", text: t("view.timer.running", { title: active.nodeTitle }) });
  const clock = timer.createEl("span", { cls: "wf-timer-clock" });
  updateClock(clock, active.startAt);
  timerHandle = setInterval(() => updateClock(clock, active.startAt), 1000);

  // Phase 16：按钮挂在 `.wf-timer` 里（总览第 2 行因此是**一整块**，三行结构不被拆散）
  const actions = timer.createDiv({ cls: "wf-timer-actions" });

  const record = actions.createEl("button", {
    cls: "wf-timer-btn wf-timer-btn--record",
    text: t("view.timer.stopRecord"),
  });
  record.onclick = () => void stopTimer(host, file, active.nodeId, active.nodeTitle, "record", refresh);
  const discard = actions.createEl("button", {
    cls: "wf-timer-btn wf-timer-btn--discard",
    text: t("view.timer.stopDiscard"),
  });
  discard.onclick = () => void stopTimer(host, file, active.nodeId, active.nodeTitle, "discard", refresh);
}

/** 「继续上次」的目标节点（Phase 17） */
interface ResumeTarget {
  nodeId: string;
  nodeTitle: string;
  endAt: string;
}

/**
 * 全文件「最后一条已完成计时」：遍历所有节点的 `timeEntries`，取 `endAt` 最大的那条
 * （**不看节点状态** —— 已完成 / 进行中 / 受阻的节点都可能挂着最近的计时）。
 * `endAt` 无法解析的条目跳过；一条都没有返回 undefined（此时不渲染「继续上次」那一行）。
 */
function lastCompletedEntry(wfDoc: WfJsonDocument): ResumeTarget | undefined {
  let best: ResumeTarget | undefined;
  let bestMs = Number.NEGATIVE_INFINITY;
  for (const visit of walkNodes(wfDoc)) {
    for (const entry of visit.node.timeEntries ?? []) {
      if (typeof entry.endAt !== "string") continue;
      const ms = parseIso(entry.endAt);
      if (ms === undefined || ms <= bestMs) continue;
      bestMs = ms;
      best = { nodeId: visit.node.id, nodeTitle: visit.node.title, endAt: entry.endAt };
    }
  }
  return best;
}

/**
 * 「继续上次」一行（Phase 17；Phase 18 ③ 收成**一个**按钮，只在没有进行中的计时时出现）：
 * 按钮文案 = `上一个任务：<节点标题>` + ` · ` + `继续这个任务`（两段在同一个按钮里，
 * 不再有单独的标签元素）；点下去与右键菜单的「▶️ 开始这个任务」同一条链路
 * （`host.startTimer(file, nodeId)` → 引擎并发闸门 → 局部刷新），成功后这一行会被正计时器替换掉。
 */
function renderTimerResume(
  box: HTMLElement,
  host: WfViewHost,
  file: TFile,
  refresh: () => void,
  target: ResumeTarget | undefined,
): void {
  if (target === undefined) return;
  const row = box.createDiv({ cls: "wf-timer-resume" });
  const label = `${t("view.timer.resumeTask", { title: target.nodeTitle })} · ${t("view.timer.resumeAction")}`;
  const button = row.createEl("button", { cls: "wf-timer-resume-btn", text: label });
  // 悬浮给全名 + 那条会话的结束时刻（按钮文案本身过长会省略号）
  button.title = `${target.nodeTitle} · ${target.endAt}`;
  button.onclick = () => void startTimer(host, file, target.nodeId, target.nodeTitle, refresh);
}

/* ------------------------------------------------------------------ *
 * 近 21 天方块阵（契约 §7.2；视图微调见 data_ixd_discuss_interact_v0.2.md《Phase 3 视图调整定稿》v0.6）
 * ------------------------------------------------------------------ */

/** 方块阵窗口天数（Phase 3 视图微调 v0.6：30 → 21 = 3 个整周一横条） */
const HEATMAP_DAYS = 21;

/**
 * 方块阵（Phase 3 视图微调 v0.6）：**单行横条**，窗口 = 本地 21 天（含今天，**最新在最右**）。
 * 每 7 格包进一个 `.wf-heat-week` 容器（周与周之间的竖分割线挂在 styles.css）。
 * 放弃「周一在顶」的日历竖排 → 不按日历周对齐，**不补空**（旧 `.wf-heat--empty` 已弃用），
 * 也不再渲染左侧星期标签列（`.wf-heat-weekdays` / `.wf-heat-weekday` 已弃用）。
 * Phase 8：删掉「少 → 多」图例（`.wf-heat-legend*` 已弃用）—— 档位一眼可比，不需要重复解释。
 * 只挂 class（档位 → `.wf-heat--l0` … `.wf-heat--l4`），颜色 / 尺寸全部在 styles.css。
 */
function renderHeatmap(box: HTMLElement, time: TimeAggregate, now: Date): void {
  const section = box.createDiv({ cls: "wf-heatmap" });
  section.createDiv({ cls: "wf-heatmap-title", text: t("view.heatmap.title", { days: HEATMAP_DAYS }) });

  const body = section.createDiv({ cls: "wf-heatmap-body" });
  const cells = buildHeatmap(time, now, HEATMAP_DAYS);
  for (let start = 0; start < cells.length; start += 7) {
    const week = body.createDiv({ cls: "wf-heat-week" });
    for (const cell of cells.slice(start, start + 7)) {
      const square = week.createDiv({ cls: `wf-heat wf-heat--l${cell.level}` });
      square.onmouseenter = () => openHeatTip(square, cell);
      square.onmouseleave = () => closeHeatTip();
    }
  }
}

/**
 * 方块阵悬浮详情：日期 + 当天「各工作流耗时」（无数据 → 「无记录」）。
 * 定位用 `getBoundingClientRect` + `left/top`（与右键菜单同类：这两个坐标是**唯一**允许的内联样式，
 * 其余外观一律 styles.css）；挂到 `document.body`（body 是合法容器，不是 `document`）。
 */
function openHeatTip(square: HTMLElement, cell: HeatmapCell): void {
  closeHeatTip();
  const tip = document.body.createDiv({ cls: "wf-heat-tip" });
  themeOverlay(tip);
  tip.createDiv({ cls: "wf-heat-tip-date", text: t("view.heatmap.tipDate", { date: cell.date, weekday: weekdayName(cell.weekday) }) });
  if (cell.byWorkflow.length === 0) {
    tip.createDiv({ cls: "wf-heat-tip-row", text: t("view.heatmap.empty") });
  } else {
    tip.createDiv({ cls: "wf-heat-tip-total", text: t("view.heatmap.total", { hours: cell.totalHours }) });
    for (const item of cell.byWorkflow) {
      tip.createDiv({ cls: "wf-heat-tip-row", text: `${item.title} ${item.hours}h` });
    }
  }
  const rect = rectOf(square);
  tip.style.left = `${Math.min(rect.left, Math.max(0, window.innerWidth - 260))}px`;
  tip.style.top = `${rect.bottom + 6}px`;
  heatTipEl = tip;
}

/* ------------------------------------------------------------------ *
 * 近 21 天甘特图（Phase 5 ①；契约见 data_ixd_discuss_interact_v0.4.md《Phase 5 定稿契约》）
 *
 *  一行 = 一天（`buildGantt` 已按「最旧在前」给出）+ 一条时间线（整块暗底 + 每 2 小时一条分割线），
 *  高亮当天「已计入工作时长」的时段 —— 一眼看出几点开工、几点收工、中间断了几段。
 *  Phase 8：去掉 10 分钟刻度格；每个工作流一种颜色（6 色一循环，按 `workflows[]` 顺序）。
 *  只挂 class；底色 / 分割线 / 高亮色 / 尺寸全部在 styles.css（`.wf-gantt*`）。
 *
 *  ⚠️ 唯一的内联样式：高亮段的 `left` / `width`、刻度的 `left` —— 它们是**按数据算出来的占位**
 *     （同右键菜单的 left/top，没法写进 CSS），其余外观一律走 styles.css。
 * ------------------------------------------------------------------ */

/** 甘特图窗口（与方块阵同窗口：21 天 = 3 周，最新在最下） */
const GANTT_DAYS = HEATMAP_DAYS;

/** Phase 8：甘特图每个工作流一种颜色（主题给 6 种，超过 6 个按 `workflows[]` 顺序循环） */
const GANTT_WORKFLOW_COLORS = 6;

/** 一整天的分钟数（144 格 × 10 分钟）= 时间线 100% 的宽度 */
const GANTT_MINUTES_PER_DAY = GANTT_SLOTS_PER_DAY * GANTT_SLOT_MINUTES;

/** 分钟 → 时间线上的百分比位置 */
function ganttPercent(minute: number): string {
  const clamped = Math.min(Math.max(minute, 0), GANTT_MINUTES_PER_DAY);
  return ((clamped / GANTT_MINUTES_PER_DAY) * 100).toFixed(4);
}

/** 一段的宽度百分比（跨零点时引擎已把结束裁到 24:00，这里只做越界保护） */
function ganttWidth(span: GanttSpan): string {
  const slots = Math.min(Math.max(span.slots, 1), GANTT_SLOTS_PER_DAY - span.start);
  return ((slots / GANTT_SLOTS_PER_DAY) * 100).toFixed(4);
}

/**
 * 甘特图（Phase 5 ① / Phase 8 / Phase 17）：标题行 + 图例 + 刻度行 + 21 行「日期 + 时间线」。
 * Phase 13：纵坐标日期只显示「月-日」（`MM-DD`），不再显示年份。
 * 没有记录的日期**也出一行**（时间线空白）—— 「哪几天没干活」本身就是信息。
 * 时间线不再画 10 分钟格线，只留整块暗底 + 每 2 小时一条分割线；高亮段按工作流取色。
 *
 * Phase 17：**常开**（Phase 11 的 `<details>` 折叠 + `ganttExpanded` 会话内存一并撤掉）——
 * 甘特图在 📊 弹窗里，弹窗本身就是按需打开的，再套一层折叠只是多点一次。
 * 标题仍是一行小字（`div.wf-gantt-title`），图例、刻度、21 行时间线照旧。
 */
function renderGantt(box: HTMLElement, time: TimeAggregate, now: Date): void {
  const section = box.createDiv({ cls: "wf-gantt" });
  section.createDiv({ cls: "wf-gantt-title", text: t("view.gantt.title", { days: GANTT_DAYS }) });

  // 图例 + 刻度行 + 21 行时间线（`--wf-gantt-tick` 等主题变量在 `.wf-theme` 上，继承不受影响）
  const body = section.createDiv({ cls: "wf-gantt-body" });
  body.createDiv({ cls: "wf-gantt-legend", text: t("view.gantt.legend") });

  // 刻度行：左侧留出与日期列等宽的空位，右侧是与时间线对齐的 `00 / 02 / … / 22`
  const axis = body.createDiv({ cls: "wf-gantt-row wf-gantt-row--axis" });
  axis.createDiv({ cls: "wf-gantt-date" });
  const axisTrack = axis.createDiv({ cls: "wf-gantt-track wf-gantt-track--axis" });
  for (const hour of ganttTickHours()) {
    const tick = axisTrack.createEl("span", { cls: "wf-gantt-tick", text: `${hour < 10 ? "0" : ""}${hour}` });
    tick.style.left = `${ganttPercent(hour * 60)}%`;
  }

  const rows = buildGantt(time, now, GANTT_DAYS);
  rows.forEach((row, index) => {
    // Phase 9 v0.7 ③：每 7 行一组（与方块阵 .wf-heat-week 同口径），组首加一道横分割线
    const weekStart = index > 0 && index % 7 === 0;
    const line = body.createDiv({ cls: weekStart ? "wf-gantt-row wf-gantt-row--week-start" : "wf-gantt-row" });
    const date = line.createDiv({ cls: "wf-gantt-date" });
    // Phase 13：纵坐标日期只显示「月-日」（引擎侧 row.date 仍是 YYYY-MM-DD，悬浮提示照旧给完整日期）
    date.createEl("span", { cls: "wf-gantt-date-label", text: row.date.slice(5) });
    if (row.totalHours > 0) date.createEl("span", { cls: "wf-gantt-date-hours", text: `${row.totalHours}h` });

    const lane = line.createDiv({ cls: "wf-gantt-track" });
    for (const span of row.spans) {
      const colorIndex = span.workflowIndex % GANTT_WORKFLOW_COLORS;
      const bar = lane.createDiv({ cls: `wf-gantt-span wf-gantt-span--w${colorIndex}` });
      bar.style.left = `${ganttPercent(span.startMinute)}%`;
      bar.style.width = `${ganttWidth(span)}%`;
      bar.onmouseenter = () => openGanttTip(bar, row.date, row.weekday, span);
      bar.onmouseleave = () => closeHeatTip();
    }
  });
}

/**
 * 甘特图一段的悬浮详情（Phase 18 ⑤：三段 + 置顶）：
 *  1. `🗂 工作流 - 节点`（过长省略号，`title` 给全名）；
 *  2. `HH:MM - HH:MM · ⏱ XdYh`（区间与时长并在一行，`formatWorkDuration` 给 `XdYh`）；
 *  3. 仅跨零点：沿用原说明（完整区间 + 这一行只画到 24:00）。
 * 复用方块阵那份 tooltip（同一套 `.wf-heat-tip*` 样式 + 同一个 `heatTipEl` 单例）。
 * 层级由 styles.css 抬到 10000（高于弹窗 9998）—— 否则弹窗一开 tooltip 就被压在下面。
 */
function openGanttTip(bar: HTMLElement, date: string, weekday: number, span: GanttSpan): void {
  closeHeatTip();
  const tip = document.body.createDiv({ cls: "wf-heat-tip wf-gantt-tip" });
  themeOverlay(tip);
  tip.createDiv({ cls: "wf-heat-tip-date", text: t("view.heatmap.tipDate", { date, weekday: weekdayName(weekday) }) });
  const who = tip.createDiv({ cls: "wf-heat-tip-row", text: `${span.workflowTitle} - ${span.nodeTitle}` });
  who.title = `${span.workflowTitle} - ${span.nodeTitle}`;
  tip.createDiv({
    cls: "wf-heat-tip-total",
    text: `${formatMinuteOfDay(span.startMinute)} - ${formatMinuteOfDay(span.endMinute)} · ${t("view.gantt.tipDuration", {
      duration: formatWorkDuration(span.hours),
    })}`,
  });
  if (span.crossesMidnight) {
    tip.createDiv({
      cls: "wf-gantt-tip-note",
      text: t("view.gantt.crossMidnight", { start: span.startAt, end: span.endAt }),
    });
  }

  const rect = rectOf(bar);
  tip.style.left = `${Math.min(rect.left, Math.max(0, window.innerWidth - 260))}px`;
  tip.style.top = `${rect.bottom + 6}px`;
  heatTipEl = tip;
}

/**
 * 折叠区的工作流切换栏 + 单泳道容器（Phase 16 起只剩「已完成流 / 已取消流」在用；
 * 进行中改成横向分栏，不再有切换栏）。
 *  - 第一行 `◀ 名称 1/2 ▶`（不做颜色方块：折叠区不参与甘特配色）；
 *  - 一次只渲染一个泳道，点击箭头循环切换；
 *  - 切换只重建 body（保留折叠区展开态 / 滚动位置），选中态存 `laneSelections`。
 */
function renderWorkflowSwitcher(
  host: WfViewHost,
  parent: HTMLElement,
  file: TFile,
  list: readonly WfWorkflow[],
  section: string,
  refresh: () => void,
  lanes: LaneIndex,
): void {
  const bar = parent.createDiv({ cls: "wf-lane-switcher" });
  const body = parent.createDiv({ cls: "wf-lane-switcher-body" });

  const paint = (): void => {
    const index = selectedWorkflowIndex(file, section, list.length);
    const workflow = list[index];
    if (workflow === undefined) return;

    bar.empty();
    const prev = bar.createEl("button", { cls: "wf-lane-switch-btn", text: "◀" });
    prev.title = t("view.gantt.prev");
    prev.disabled = list.length <= 1;
    prev.onclick = () => {
      setSelectedWorkflowIndex(file, section, index - 1, list.length);
      paint();
    };

    const name = bar.createDiv({ cls: "wf-lane-switch-name" });
    name.createEl("span", { cls: "wf-lane-switch-title", text: workflow.title });

    // v0.7 §⑨-6：DOM 顺序 [◀][当前名称][1/2][▶] —— ▶ 靠右、名称居中（样式在 styles.css）
    bar.createDiv({ cls: "wf-lane-switch-count", text: `${index + 1}/${list.length}` });

    const next = bar.createEl("button", { cls: "wf-lane-switch-btn", text: "▶" });
    next.title = t("view.gantt.next");
    next.disabled = list.length <= 1;
    next.onclick = () => {
      setSelectedWorkflowIndex(file, section, index + 1, list.length);
      paint();
    };

    body.empty();
    renderLane(host, body, file, workflow, refresh, lanes);
  };

  paint();
}

/** workflow 在 `workflows[]` 里的文档顺序（颜色 / 切换栏排序共用） */
function workflowColorIndex(wfDoc: WfJsonDocument, workflowId: string): number {
  const index = (wfDoc.workflows ?? []).findIndex((workflow) => workflow.id === workflowId);
  return index < 0 ? 0 : index;
}

/**
 * 滚轮落在「卡片间隙」时横滚分栏（Phase 18 ②）。
 *
 * 判定的是**落点是不是卡片 / 控件**：命中这些选择器就放行（不 `preventDefault`，
 * 泳道内纵向滚动、按钮点击区、折叠头保持原行为），其余（分栏外框、泳道之间的空白、
 * 卡片之间的缝）→ 吃掉纵向滚轮改成横向 `scrollLeft`。
 *
 * 两条硬边界（§⑬）：
 *  - 只有「真的有横向溢出」（`scrollWidth > clientWidth`）才拦 —— 否则光标停在空白处
 *    会把整页的滚动锁死；
 *  - 不做 shift / 触控板双指 / 惯性动画的兼容分支：`deltaY` 累加即可。
 */
const WHEEL_PASS_SELECTORS: readonly string[] = [".wf-card", ".wf-caret", "button", ".wf-lane-head", ".wf-fold-title"];

/** 事件目标是否落在「不放行」的区域（`closest` 做鸭子判断：DOM 桩里也有这个方法） */
function isWheelPassTarget(target: unknown): boolean {
  const probe = target as { closest?: (selector: string) => unknown } | null;
  if (probe === null || probe === undefined || typeof probe.closest !== "function") return false;
  for (const selector of WHEEL_PASS_SELECTORS) {
    if (probe.closest(selector) !== null) return true;
  }
  return false;
}

/**
 * 给分栏挂 `wheel`（`{ passive: false }` —— 要 `preventDefault` 就必须显式声明）。
 * `scrollLeft` 直接赋值：原生滚动，不做缓动（§⑬）。
 */
export function enableGapWheelScroll(columns: HTMLElement): void {
  columns.addEventListener(
    "wheel",
    (event: WheelEvent) => {
      const probe = columns as unknown as { scrollWidth?: number; clientWidth?: number };
      const scrollWidth = probe.scrollWidth ?? 0;
      const clientWidth = probe.clientWidth ?? 0;
      // 没有横向溢出 → 放行给文档滚动（否则光标停在空白处会把页面滚动锁死）
      if (!(scrollWidth > clientWidth)) return;
      if (isWheelPassTarget(event.target)) return;
      event.preventDefault();
      const delta = event.deltaY !== 0 ? event.deltaY : event.deltaX;
      columns.scrollLeft += delta;
    },
    { passive: false },
  );
}

/**
 * ② 正在进行（Phase 16：**多工作流横向分栏**）：
 * 每个进行中的 workflow 一栏（`.wf-column` 内一条泳道），只有一条时与旧版观感一致；
 * 一栏都装不下时由栏内 `.wf-lane` 横向滚动（页面本身不横向滚动）。
 * Phase 18 ②：分栏外框上再挂一层「间隙滚轮 → 横滚」（见 `enableGapWheelScroll`）。
 */
function renderActiveBlock(
  host: WfViewHost,
  container: HTMLElement,
  summary: DocumentSummary,
  file: TFile,
  wfDoc: WfJsonDocument,
  refresh: () => void,
  lanes: LaneIndex,
  ctx: WidgetContext
): void{ 
  const groups = groupWorkflows(wfDoc);
  const block = container.createDiv({ cls: "wf-block" });
  block.createDiv({cls:"wf-block-title-row"});
  block.createDiv({ cls: "wf-block-title", text: t("view.block.active", { count: groups.active.length , active :summary.active.doing,total:summary.active.total,blocked:summary.active.blocked}) });

  if (groups.active.length === 0) {
    block.createDiv({ cls: "wf-hint", text: t("view.block.activeEmpty") });
  } else {
    const columns = block.createDiv({ cls: "wf-active-columns" });
    //enableGapWheelScroll(columns);
    for (const workflow of groups.active) {
      const column = columns.createDiv({ cls: "wf-column" });
      // 栏头挂一个颜色方块：与甘特图里该 workflow 的时段同色（`--wf-gantt-cN`）
      renderLane(host, column, file, workflow, refresh, lanes, workflowColorIndex(wfDoc, workflow.id));
    }
  }
  // Phase 5 ③ / Phase 15：块尾的入口按钮 —— 一个 workflow 都没有时也留着（第一次建流就靠它）
  renderBlockActions(host, block, file, refresh);
}

/**
 * 块尾按钮行（只有一个 `.wf-block-actions`，两个按钮同一行）：
 * 「修改节点顺序」开关（Phase 15）在前，「⚙️ 修改工作流…」（Phase 5 ③）在后。
 */
function renderBlockActions(host: WfViewHost, block: HTMLElement, file: TFile, refresh: () => void): void {
  const actions = block.createDiv({ cls: "wf-block-actions" });
  renderReorderToggle(actions, file, refresh);
  renderWorkflowEditorButton(host, actions, file, refresh);
}

/**
 * 「修改节点顺序」开关（Phase 15）：开 → 卡片可拖；关 → 原交互（右键菜单 / 点击）一律不变。
 * 状态只存会话内存（`reorderEnabled`），切换后整块重渲染 —— 卡片上的 `draggable` 与监听全靠重建生效。
 */
function renderReorderToggle(actions: HTMLElement, file: TFile, refresh: () => void): void {
  const on = reorderEnabled.has(file.path);
  const button = actions.createEl("button", { cls: "wf-block-btn wf-reorder-toggle" });
  if (on) button.addClass("wf-reorder-toggle--on");
  button.setText(`${t("view.block.reorderNodes")}：${t(on ? "view.reorder.on" : "view.reorder.off")}`);
  button.title = t("view.reorder.hint");
  button.setAttribute("aria-pressed", on ? "true" : "false");
  button.onclick = () => {
    if (reorderEnabled.has(file.path)) reorderEnabled.delete(file.path);
    else reorderEnabled.add(file.path);
    draggingNodeId = null;
    refresh();
  };
}

/** 「⚙️ 修改工作流…」按钮（Phase 5 ③）：弹窗收集增删 / 改字段 → 一次写回 → 刷新 */
function renderWorkflowEditorButton(host: WfViewHost, actions: HTMLElement, file: TFile, refresh: () => void): void {
  const button = actions.createEl("button", { cls: "wf-block-btn", text: t("view.block.editWorkflows") });
  button.onclick = () => void openWorkflowEditor(host, file, refresh);
}

/**
 * 「⚙️ 修改工作流…」（Phase 5 ③）：Modal 与写回都在插件侧（分字段 + 增删，引擎先整批预检）。
 *  - 有增删（`structureChanged`）→ 泳道与计数都变了 → **整块重渲染**（`refresh`）；
 *  - 只改字段 → 局部刷新根节点那一列（`refreshChrome` 顺带重画泳道头徽标）。
 */
async function openWorkflowEditor(host: WfViewHost, file: TFile, refresh: () => void): Promise<void> {
  const outcome = await host.editWorkflows(file);
  if (outcome.cancelled || outcome.result === undefined) return; // 取消不是失败：不提示、不重渲染
  const result = outcome.result;
  if (!result.success) {
    host.notify(t("view.notify.writeFailed", { reason: result.reason ?? t("view.notify.unknownReason") }));
    return;
  }
  if (!result.changed) {
    host.notify(t("view.notify.workflowUnchanged"));
    return;
  }
  host.notify(t("view.notify.workflowUpdated", { suffix: warningSuffix(result.issues) }));
  if (result.structureChanged) {
    refresh();
    return;
  }
  await refreshNodes(host, file, result.changedNodeIds, refresh);
}

/** ③ 折叠区：archived → 已完成流；cancelled → 已取消流（默认收起；Phase 9 同样用切换栏，不显示色块） */
function renderFold(
  host: WfViewHost,
  container: HTMLElement,
  file: TFile,
  wfDoc: WfJsonDocument,
  state: WorkflowState,
  refresh: () => void,
  lanes: LaneIndex,
): void {
  const groups = groupWorkflows(wfDoc);
  const list = state === "archived" ? groups.archived : groups.cancelled;
  if (list.length === 0) return;

  const details = container.createEl("details", { cls: `wf-fold wf-fold-${state}` });
  const label = state === "archived" ? t("view.block.doneFlow") : t("view.block.cancelledFlow");
  details.createEl("summary", { cls: "wf-fold-title", text: `${label}（${list.length}）` });
  const body = details.createDiv({ cls: "wf-fold-body" });
  renderWorkflowSwitcher(host, body, file, list, state, refresh, lanes);
}

/* ------------------------------------------------------------------ *
 * ③ 已归档块（Phase 4）：按工作流分组列出「浓缩节点」（带 `archive` 的节点）
 * 每行 = 细节数据（状态 / 重要度 / 标签 / 用时 / 起止）+ 跳转 archive/ 归档 md 的链接；
 * 数据源只有本文件的 JSON —— 不扫 ./archive/ 目录。
 * v0.7 §⑨-2：归档地址读正文纪要段的「归档：[[...]]」行（旧数据的 `archive.file` 作回落）。
 * ------------------------------------------------------------------ */

/**
 * 归档地址缓存：文件路径 →（节点 id → 归档 md 路径）。
 *
 * 为什么要有它：`archive.file` 已弃用，地址在人写的纪要段里；解析 `noteSections`
 * 需要整篇笔记（渲染时 `analyzeFile` 已经给了），所以每次渲染顺手扫一遍存起来，
 * 右键菜单 / 已归档块按 `file.path` 取，避免每次点击都读盘。
 */
const archiveRefs = new Map<string, Map<string, string>>();

/** 扫一遍 `result.noteSections`，记下每个节点的「归档：」行（重渲染时覆盖） */
function rememberArchiveRefs(file: TFile, result: AnalyzeResult): void {
  const map = new Map<string, string>();
  for (const section of result.noteSections ?? []) {
    const target = extractArchiveReference(section.content);
    if (target !== undefined) map.set(section.nodeId, target);
  }
  archiveRefs.set(file.path, map);
}

/** 归档 md 路径：正文「归档：」行 → 旧数据 `archive.file` → undefined（都不写就不显示跳转） */
function resolveArchiveFile(file: TFile, node: WfNode): string | undefined {
  const fromNote = archiveRefs.get(file.path)?.get(node.id);
  if (fromNote !== undefined && fromNote.length > 0) return fromNote;
  const legacy = node.archive?.file;
  return legacy !== undefined && legacy.length > 0 ? legacy : undefined;
}

/** 一个工作流里的归档节点分组（workflow 用于分组标题） */
interface ArchiveGroup {
  workflow: WfWorkflow;
  nodes: WfNode[];
}

/** 收集全部带 `archive` 的节点，按所属工作流分组（保持文档顺序；没有归档节点的工作流不出现） */
function archiveGroups(wfDoc: WfJsonDocument): ArchiveGroup[] {
  const groups: ArchiveGroup[] = [];
  for (const workflow of wfDoc.workflows ?? []) {
    const nodes: WfNode[] = [];
    for (const visit of walkWorkflow(workflow)) {
      if (visit.node.archive !== undefined) nodes.push(visit.node);
    }
    if (nodes.length > 0) groups.push({ workflow, nodes });
  }
  return groups;
}

/**
 * ③ 已归档（Phase 16：整块搬进 📦 弹窗，页面上不再有 `<details>`）。
 * 侧边栏按钮标题与弹窗标题都要计数 → 单独抽一个 `archiveTotal`。
 */
function archiveTotal(wfDoc: WfJsonDocument): number {
  return archiveGroups(wfDoc).reduce((sum, group) => sum + group.nodes.length, 0);
}

/**
 * 画 📦 弹窗的内容：按工作流分组列出带 `archive` 的浓缩节点。
 * 可重复调用（局部刷新 / 整块重渲染都会重画整个弹窗体）；
 * 一个归档节点都没有时给一行占位文案 —— 弹窗已经开着了，不能像旧版那样「连块都不建」。
 */
function renderArchiveWidget(box: HTMLElement, host: WfViewHost, file: TFile, wfDoc: WfJsonDocument): void {
  const groups = archiveGroups(wfDoc);
  if (groups.length === 0) {
    box.createDiv({ cls: "wf-widget-placeholder", text: t("view.widget.emptyArchive") });
    return;
  }
  for (const group of groups) {
    const section = box.createDiv({ cls: "wf-archive-group" });
    section.createDiv({ cls: "wf-archive-group-title", text: `${group.workflow.title}` });
    for (const node of group.nodes) section.appendChild(archiveRow(host, file, node));
  }
}

/** 一行归档节点：标题（有锚点则可点跳纪要）+ 细节 + 归档 md 链接 + 折叠的归档信息 */
function archiveRow(host: WfViewHost, file: TFile, node: WfNode): HTMLElement {
  const row = detachedDiv("wf-archive-row");
  const title = row.createDiv({ cls: "wf-archive-row-title", text: node.title });
  if (node.noteAnchor !== undefined) {
    title.title = t("view.card.jumpNoteTitle", { anchor: node.noteAnchor });
    title.onclick = (event) => {
      event.preventDefault();
      jumpToNote(host, file, node);
    };
  }

  const bits: string[] = [statusLabel(node.status)];
  if (node.importance !== undefined) bits.push(t("view.card.importance", { value: IMPORTANCE_LABELS[node.importance] ?? node.importance }));
  if (node.urgency !== undefined) bits.push(t("view.card.urgency", { value: URGENCY_LABELS[node.urgency] ?? node.urgency }));
  if (node.tags !== undefined && node.tags.length > 0) bits.push(node.tags.map((tag) => `#${tag}`).join(" "));
  const hours = totalHours(node.timeEntries);
  if (hours !== undefined) bits.push(t("view.card.hours", { hours }));
  if (node.startAt !== undefined) bits.push(t("view.card.start", { date: dayOf(node.startAt) }));
  if (node.completedAt !== undefined) bits.push(t("view.card.completed", { date: dayOf(node.completedAt) }));
  row.createDiv({ cls: "wf-archive-row-meta", text: bits.join(" · ") });

  const archive = node.archive;
  if (archive !== undefined) {
    const archivePath = resolveArchiveFile(file, node);
    if (archivePath !== undefined) {
      const link = row.createEl("a", {
        cls: "wf-archive-row-link",
        text: t("view.archive.file", { path: archivePath, time: archive.archivedAt }),
      });
      link.onclick = (event) => {
        event.preventDefault();
        openArchiveFile(host, file, archivePath);
      };
    }

    const notes = archiveNoteLines(archive);
    if (notes.length > 0) {
      const details = row.createEl("details", { cls: "wf-archive-row-notes" });
      details.createEl("summary", { cls: "wf-archive-row-notes-title", text: t("view.archive.infoTitle") });
      for (const line of notes) details.createDiv({ cls: "wf-archive-row-note", text: line });
    }
  }
  return row;
}

/** `archive` 里的三段文字（空的段不占位） */
function archiveNoteLines(archive: WfArchive): string[] {
  const lines: string[] = [];
  if (archive.summary !== undefined) lines.push(t("view.archive.summary", { text: archive.summary }));
  if (archive.idea !== undefined) lines.push(t("view.archive.idea", { text: archive.idea }));
  if (archive.review !== undefined) lines.push(t("view.archive.review", { text: archive.review }));
  return lines;
}

/** 节点自身的用时合计（`timeEntries[].hours`；一条都没有 → undefined） */
function totalHours(entries: readonly WfTimeEntry[] | undefined): number | undefined {
  if (entries === undefined || entries.length === 0) return undefined;
  let sum = 0;
  for (const entry of entries) {
    if (typeof entry.hours === "number" && Number.isFinite(entry.hours)) sum += entry.hours;
  }
  return Math.round(sum * 10) / 10;
}

/** `2026-10-08T18:00:00+08:00` → `2026-10-08`（已是 `YYYY-MM-DD HH:MM` 形态就原样取前 10 位） */
function dayOf(value: string): string {
  return value.slice(0, 10);
}

/**
 * 卡片第 3 段（Phase 17 起；Phase 18 ⑧ 按状态分两套三句）：
 *
 * | 状态 | 三句（` · ` 拼接，缺数据的那半句不渲染） |
 * | --- | --- |
 * | 未完成（todo / doing / blocked / cancelled） | `已经过：x天` · `已完成时间 XdYh` · `距结束：x天` |
 * | 已完成（done） | `x天完成` · `⏱ 已完成时间 XdYh`（高亮）· `x天前结束` |
 *
 * - 「已完成时间」只累计**有 `endAt`** 的会话（`completedHours()`）——
 *   进行中那条（省略 `endAt` / `hours`）不再被算进来；
 * - 高亮只给 `done` 的那句（`.wf-card-time`，颜色来自主题的完成色）；未完成那句是中性小字；
 * - `done` 那行是**分段**拼的（`span.wf-card-part` + `span.wf-card-sep`）：
 *   只有中间那句带 `.wf-card-time`，三句仍在同一行、顺序与 ` · ` 分隔不变；
 * - x 一律 = 日历日差 − 1（明天开始 / 明天到期都算 0 天），负数按 0 ——
 *   「今天就该动」与「今天到期」都显示 0 天，比显示负数更好懂。
 */
function renderCardLine(card: HTMLElement, node: WfNode, today: string): void {
  const worked = completedHours(node.timeEntries);
  const workedText = worked !== undefined && worked > 0 ? t("view.card.worked", { duration: formatWorkDuration(worked) }) : undefined;

  if (node.status === "done") {
    // 顺序固定：x天完成 · x天前结束 · 已完成时间（高亮）；缺哪句就不占那一段
    const segments: { text: string; highlighted?: boolean }[] = [];
    if (node.startAt !== undefined && node.completedAt !== undefined) {
      const days = dayCountBetween(node.startAt, node.completedAt);
      if (days !== undefined) segments.push({ text: t("view.card.doneIn", { days }) });
    }
    if (node.completedAt !== undefined) {
      const days = dayCountBetween(node.completedAt, today);
      if (days !== undefined) segments.push({ text: t("view.card.doneAgo", { days }) });
    }
    if (workedText !== undefined) segments.push({ text: workedText, highlighted: true });
    if (segments.length === 0) return;
    const line = card.createDiv({ cls: "wf-card-line" });
    segments.forEach((segment, index) => {
      if (index > 0) line.createEl("span", { cls: "wf-card-sep", text: " · " });
      line.createEl("span", {
        cls: segment.highlighted === true ? "wf-card-time" : "wf-card-part",
        text: segment.text,
      });
    });
    return;
  }

  const bits: string[] = [];
  if (node.startAt !== undefined) {
    const days = dayCountBetween(node.startAt, today);
    if (days !== undefined) bits.push(t("view.card.elapsed", { days }));
  }
  // 未完成的那句**不挂** .wf-card-time（同一份 CSS 变量，不挂 class 就是中性小字）
  if (workedText !== undefined) bits.push(workedText);
  if (node.dueAt !== undefined) {
    const days = dayCountBetween(today, node.dueAt);
    if (days !== undefined) bits.push(t("view.card.remain", { days }));
  }
  if (bits.length > 0) card.createDiv({ cls: "wf-card-line", text: bits.join(" · ") });
}

/**
 * 卡片上那句「x天」：日历日差 − 1（今天算半截，不整算一天），负数按 0。
 * 时间串无法解析时返回 undefined（调用方据此不渲染那半句）。
 */
function dayCountBetween(fromIso: string, toIso: string): number | undefined {
  const diff = wholeDaysFromTo(fromIso, toIso);
  return diff === undefined ? undefined : Math.max(0, diff - 1);
}

/** 打开归档 md（`archive/<workflowId>-<nodeId>.md`；文件不存在时 Obsidian 自己提示） */
function openArchiveFile(host: WfViewHost, file: TFile, path: string): void {
  void host.app.workspace.openLinkText(path, file.path, true);
}

/**
 * 一条泳道：标题行 + 树（根节点在最上）。
 * `colorIndex` 给了就在栏头最前面挂一个颜色方块（Phase 16：只有「正在进行」的分栏传）。
 */
function renderLane(
  host: WfViewHost,
  parent: HTMLElement,
  file: TFile,
  workflow: WfWorkflow,
  refresh: () => void,
  lanes: LaneIndex,
  colorIndex?: number,
): void {
  const lane = parent.createDiv({ cls: "wf-lane" });
  const head = lane.createDiv({ cls: "wf-lane-head" });
  fillLaneHead(head, workflow, colorIndex);

  // 记进会话：局部刷新时原位改徽标文字；分组变了（进/出折叠区）则整块重渲染
  lanes.heads.set(workflow.id, head);
  if (colorIndex !== undefined) lanes.colors.set(workflow.id, colorIndex);
  lanes.layout.set(workflow.id, workflow.state ?? "");

  const body = lane.createDiv({ cls: "wf-lane-body" });
  body.appendChild(renderSubtree(host, file, workflow.root, refresh, true));
  body.scrollTop = body.scrollHeight;   // 滚到底
}

/** 泳道头内容（颜色方块 + 标题 + 徽标）；先 empty 再填，供局部刷新复用 */
function fillLaneHead(head: HTMLElement, workflow: WfWorkflow, colorIndex?: number): void {
  head.empty();
  if (colorIndex !== undefined) {
    // 颜色只来自主题（`--wf-gantt-cN` 与甘特图同时段同色）；内联样式只负责「哪一个色号」
    const chip = head.createEl("span", { cls: "wf-lane-color" });
    chip.style.background = `var(--wf-gantt-c${colorIndex % GANTT_WORKFLOW_COLORS})`;
    chip.title = t("view.gantt.sameColor");
  }
  head.createDiv({ cls: "wf-lane-title", text: `${workflow.title}` });

  /*
  const badges: string[] = [];
  if (workflow.state !== undefined) badges.push(stateLabel(workflow.state));
  if (workflow.originId !== undefined) badges.push(`originId ${workflow.originId}`);
  if (workflow.progress !== undefined) {
    badges.push(t("view.card.progress", { progress: workflow.progress, max: workflow.progress_max ?? 1 }));
  }
  if (badges.length > 0) head.createDiv({ cls: "wf-lane-meta", text: badges.join(" · ") });
  */
}

/* ------------------------------------------------------------------ *
 * 泳道布局（主干优先的向左树 → 向右分叉）
 * ------------------------------------------------------------------ */

/**
 * 造一个「游离」div（还没有挂到任何父级上，由调用方 appendChild 决定去处）。
 *
 * ⚠️ 不能写 `document.createDiv()`：Obsidian 给的 `createDiv` / `createEl` 是
 * 「创建 + 立刻 append 到接收者」，接收者是 `document` 时会往 document 根节点 append，
 * 直接抛 `HierarchyRequestError: Only one element on document allowed`（真实 vault 里必崩）。
 */
function detachedDiv(cls: string): HTMLElement {
  const el = document.createElement("div");
  // 类名可能带空格（卡片是多类名）→ 必须拆成单个 token，classList 不接受含空格的 token
  for (const name of cls.split(/\s+/)) {
    if (name.length > 0) el.classList.add(name);
  }
  return el;
}

/**
 * 递归渲染子树，返回一个「列」元素（未挂到父级，由调用方 append）：
 *  列 = [自己的卡片, 子节点行]；子节点行是横向 flex：
 *    第 1 个子节点仍在本列（= 同列下一行），第 2..n 个各自右开一列（行号与第 1 个对齐）。
 * 连线由 `.wf-cell` 的伪元素（竖线 + 横线）用 CSS 画，Phase 4 再考虑换成 SVG。
 *
 * 副作用：把「列 + 卡片」登记进 `nodeRegistry`（键 = `file.path` / `node.id`），
 * 写回成功后 `refreshNodes()` 就能只重建受影响的列；`isRoot` 一并记下，
 * 重建时才知道该不该给「删除本节点」这一项。
 */
function renderSubtree(
  host: WfViewHost,
  file: TFile,
  node: WfNode,
  refresh: () => void,
  isRoot = false,
): HTMLElement {
  const column = detachedDiv("wf-col");
  const kids = Array.isArray(node.children) ? node.children : [];
  const row = kids.length > 0 ? detachedDiv("wf-row") : null;
  const collapsed = row !== null && isCollapsed(file.path, node);
  if (row !== null && collapsed) row.addClass("wf-collapsed");

  const toggle =
    row === null
      ? undefined
      : (): boolean => {
          const nowCollapsed = row.classList.toggle("wf-collapsed");
          setCollapsed(file.path, node.id, nowCollapsed);
          return nowCollapsed;
        };
  const card = renderCard(host, file, node, refresh, toggle, collapsed, isRoot);
  column.appendChild(card);
  registerNode(file.path, node.id, { column, card, isRoot });

  if (row !== null) {
    kids.forEach((child, index) => {
      const cell = detachedDiv("wf-cell");
      if (index > 0) cell.addClass("wf-cell--side");
      if (index < kids.length - 1) cell.addClass("wf-cell--has-next");
      cell.createDiv({ cls: "wf-elbow" });
      cell.appendChild(renderSubtree(host, file, child, refresh));
      row.appendChild(cell);
    });
    column.appendChild(row);
  }
  return column;
}

/**
 * 一个节点卡片：
 *  - 底色：`done` → 白底，其余 → 黄底（内容一律黑字）；
 *  - 边框：有 links → 实线，无 → 虚线；重要度 4（Critical）→ 加粗（类名控制，见 styles.css）；
 *  - 左键标题 → 跳本文件纪要锚点；右键 → 资料 / 改状态 / 改链接 / 加子节点 / 删除；
 *  - Phase 15：开着「修改节点顺序」时非根卡片可拖（`enableCardDrag`），关时一个 `drag*` 监听都不挂。
 */
function renderCard(
  host: WfViewHost,
  file: TFile,
  node: WfNode,
  refresh: () => void,
  toggle?: () => boolean,
  collapsed = false,
  isRoot = false,
): HTMLElement {
  const card = detachedDiv(cardClasses(file, node));
  const top = card.createDiv({ cls: "wf-card-top" });
  const kids = Array.isArray(node.children) ? node.children : [];

  if (kids.length > 0) {
    const caret = top.createEl("span", { cls: "wf-caret", text: collapsed ? "▸" : "▾" });
    if (toggle) {
      caret.onclick = (event) => {
        event.stopPropagation();
        caret.setText(toggle() ? "▸" : "▾");
      };
    }
  }

  const dot = top.createEl("span", { cls: `wf-dot wf-dot-${node.status}` });
  dot.title = statusLabel(node.status);

  const titleEl = top.createEl("span", { cls: "wf-card-title", text: node.title });
  if (node.noteAnchor !== undefined) {
    titleEl.title = t("view.card.titleTooltip", { anchor: node.noteAnchor });
    titleEl.onclick = (event) => {
      event.preventDefault();
      jumpToNote(host, file, node);
    };
  }

  const meta = card.createDiv({ cls: "wf-card-meta" });
  const progress = node.progress ?? 0;
  const progressMax = node.progress_max ?? 1;
  const links = noteLinksOf(file, node.id);
  const bits = [statusLabel(node.status)];
  // v0.7 §⑨-5：卡片不再显示 type（节点类型只在表单 / JSON 里保留）
  if (node.importance !== undefined) bits.push(t("view.card.importance", { value: IMPORTANCE_LABELS[node.importance] ?? node.importance }));
  if (node.urgency !== undefined) bits.push(t("view.card.urgency", { value: URGENCY_LABELS[node.urgency] ?? node.urgency }));
  bits.push(t("view.card.progress", { progress, max: progressMax }));
  // Phase 18 ⑧：meta 不再给「子节点 n」（`kids` 变量留着 —— 上面的 caret 还要用它）
  // Phase 17：纪要超链接数量固定给出（0 也显示；实线 / 虚线的判据仍是「有没有」）
  bits.push(t("view.card.links", { count: links.length }));
  meta.setText(bits.join(" · "));

  // Phase 17 第 3 段：时间信息（done 只给已完成时间；其余给已经过 / 距结束），没有内容就不占位
  renderCardLine(card, node, formatLocalDate());

  // Phase 17：第 4 段 = 概要（有才占位）
  if (node.summary !== undefined) card.createDiv({ cls: "wf-card-summary", text: node.summary });

  // v1.6 进度条：宽度按 progress / progress_max（缺省 0 / 1）；颜色随状态由 CSS 决定
  // Phase 17：挪到概要之后 —— 四段（标题 / 元信息 / 时间 / 概要）之后才收尾成一条进度
  const percent = progressPercent(progress, progressMax);
  const bar = card.createDiv({ cls: "wf-card-progress" });
  bar.title = t("view.card.progressTitle", { progress, max: progressMax, percent });
  const fill = bar.createDiv({ cls: "wf-card-progress-fill" });
  fill.style.width = `${percent}%`;

  card.oncontextmenu = (event) => {
    event.preventDefault();
    event.stopPropagation();
    openCardMenu(host, file, node, event, refresh, isRoot);
  };

  // Phase 15：开着「修改节点顺序」时，**非根**卡片可拖（根节点没有父节点，引擎也会拒绝）
  if (!isRoot && reorderEnabled.has(file.path)) enableCardDrag(host, card, file, node, refresh);
  return card;
}

/* ------------------------------------------------------------------ *
 * Phase 15：卡片拖拽（原生 HTML5 drag & drop，不引第三方库）
 * ------------------------------------------------------------------ */

/** 卡片当前的屏幕矩形（DOM 桩 / 未布局时给 0 → `resolveDrop` 退化成 `after`） */
function cardRectOf(element: HTMLElement): { top: number; height: number } {
  const rect = element.getBoundingClientRect?.();
  return rect ?? { top: 0, height: 0 };
}

/** 落点高亮：两个类互斥，只挂当前那一个（不新增元素、不撑动布局） */
function markDropPosition(card: HTMLElement, position: ReorderPosition): void {
  card.classList.toggle("wf-card--drop-before", position === "before");
  card.classList.toggle("wf-card--drop-after", position === "after");
}

/** 清掉落点高亮（`dragleave` / `drop` / `dragend` 都要清） */
function clearDropMarks(card: HTMLElement): void {
  card.classList.toggle("wf-card--drop-before", false);
  card.classList.toggle("wf-card--drop-after", false);
}

/**
 * 把一张卡片同时变成「拖拽源」和「落点」（Phase 15）。
 *
 *  - 只有非根卡片会走到这里（调用点在 `renderCard`，判据是既有的 `isRoot`）；
 *  - 落点判定走纯函数 `resolveDrop`：上半 = 插到它之前（同级），下半 = 成为它的子节点；
 *  - 拖拽中的源节点记在模块级 `draggingNodeId`（一次只可能有一个），`drop` / `dragend` 清空。
 */
function enableCardDrag(host: WfViewHost, card: HTMLElement, file: TFile, node: WfNode, refresh: () => void): void {
  card.addClass("wf-card--draggable");
  card.setAttribute("data-node-id", node.id);
  card.draggable = true;

  card.ondragstart = (event) => {
    if (!reorderEnabled.has(file.path)) return;
    draggingNodeId = node.id;
    card.classList.toggle("wf-card--dragging", true);
    if (event.dataTransfer) {
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData("text/plain", node.id);
    }
  };

  card.ondragend = () => {
    draggingNodeId = null;
    card.classList.toggle("wf-card--dragging", false);
    clearDropMarks(card);
  };

  card.ondragover = (event) => {
    if (draggingNodeId === null || draggingNodeId === node.id) return;
    event.preventDefault(); // 不阻止默认行为浏览器不会派发 drop
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    markDropPosition(card, resolveDrop(cardRectOf(card), event.clientY));
  };

  card.ondragleave = () => {
    clearDropMarks(card);
  };

  card.ondrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const position = resolveDrop(cardRectOf(card), event.clientY);
    const movingId = draggingNodeId;
    draggingNodeId = null;
    clearDropMarks(card);
    if (movingId === null || movingId === node.id) return;
    void applyReorder(host, file, movingId, node.id, position, refresh);
  };
}

/**
 * drop 落地（Phase 15）：写回 → 成功**整块重渲染**（拓扑变了，局部刷新定位不到新位置；
 * Phase 9 §⑨-9 的串行 + last-wins 已保证不跳位）；引擎拒绝 / 写回失败走 `Notice`。
 * 与现状字节一致（拖回原位）时 `changed = false`：没写盘，也就不用重画、不提示。
 */
async function applyReorder(
  host: WfViewHost,
  file: TFile,
  movingId: string,
  targetId: string,
  position: ReorderPosition,
  refresh: () => void,
): Promise<void> {
  const result = await host.moveNode(file, movingId, targetId, position);
  if (!result.success) {
    host.notify(t("view.notify.reorderFailed", { reason: result.reason ?? t("view.notify.unknownReason") }));
    return;
  }
  if (!result.changed) return;
  refresh();
}

/** 卡片的类名：底色 / 边框 / 加粗 / 状态（全部交给 styles.css） */
function cardClasses(file: TFile, node: WfNode): string {
  const classes = ["wf-card", `wf-card--${node.status}`];
  classes.push(node.status === "done" ? "wf-card--done" : "wf-card--open");
  // Phase 9：实线边框看「正文纪要段里有没有超链接」，不再看 node.links
  classes.push(noteLinksOf(file, node.id).length > 0 ? "wf-card--solid" : "wf-card--dashed");
  if (node.importance !== undefined && node.importance >= 4) classes.push("wf-card--bold");
  return classes.join(" ");
}

/* ------------------------------------------------------------------ *
 * 跳转 / 打开资料
 * ------------------------------------------------------------------ */

/** 左键：跳到本文件的纪要锚点（链接写作 `笔记名#^nd-xxx`） */
function jumpToNote(host: WfViewHost, file: TFile, node: WfNode): void {
  const anchor = node.noteAnchor;
  if (anchor === undefined) return;
  void host.app.workspace.openLinkText(`${file.basename}#${anchor}`, file.path, true);
}

/** 打开一条资料链接：web 走新窗口，其余交给 Obsidian 解析 */
function openResource(host: WfViewHost, file: TFile, target: string, type: LinkType): void {
  if (type === "web" || /^https?:\/\//i.test(target)) {
    window.open(target, "_blank");
    return;
  }
  void host.app.workspace.openLinkText(target, file.path, true);
}

/* ------------------------------------------------------------------ *
 * 右键菜单（Phase 2/3 的「开始任务 / 归档」也挂这里）
 * ------------------------------------------------------------------ */

interface MenuEntry {
  text: string;
  run: () => void;
}

let menuEl: HTMLElement | null = null;
let menuBound = false;

function closeMenu(): void {
  if (menuEl) {
    menuEl.remove();
    menuEl = null;
  }
}

/** 全局只绑一次：点空白 / Esc / 在菜单外右键都关掉 */
function ensureMenuBinding(): void {
  if (menuBound) return;
  menuBound = true;
  document.addEventListener("click", closeMenu);
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeMenu();
  });
  document.addEventListener("contextmenu", (event) => {
    const target = event.target;
    if (!(target instanceof HTMLElement) || target.closest(".wf-menu") === null) closeMenu();
  });
}

function openMenu(position: { x: number; y: number }, entries: MenuEntry[]): void {
  closeMenu();
  ensureMenuBinding();
  const box = document.body.createDiv({ cls: "wf-menu" });
  themeOverlay(box);
  box.style.left = `${Math.min(position.x, Math.max(0, window.innerWidth - 260))}px`;
  box.style.top = `${position.y}px`;
  menuEl = box;
  for (const entry of entries) {
    const row = box.createDiv({ cls: "wf-menu-item", text: entry.text });
    row.onclick = () => {
      closeMenu();
      entry.run();
    };
  }
}

/** 节点卡片菜单：资料链接 → 跳纪要 → 状态 → 计时 → 结构（改链接 / 改信息 / 加子节点 / 删除） */
function openCardMenu(
  host: WfViewHost,
  file: TFile,
  node: WfNode,
  event: MouseEvent,
  refresh: () => void,
  isRoot = false,
): void {
  const entries: MenuEntry[] = [];
  const links = noteLinksOf(file, node.id);

  for (const link of links) {
    entries.push({
      text: `${LINK_ICON[link.type]} ${link.label}`,
      run: () => openResource(host, file, link.target, link.type),
    });
  }
  if (links.length === 0) entries.push({ text: t("view.menu.noLinks"), run: () => undefined });
  if (node.noteAnchor !== undefined) entries.push({ text: t("view.menu.jumpNote"), run: () => jumpToNote(host, file, node) });

  entries.push({ text: t("view.menu.statusGroup"), run: () => undefined });
  for (const status of NODE_STATUSES) {
    if (status === node.status) continue;
    entries.push({
      text: t("view.menu.markAs", { icon: STATUS_ICON[status], label: statusLabel(status) }),
      run: () => void changeStatus(host, file, node, status, refresh),
    });
  }

  // Phase 3 计时：没有进行中 → 「开始这个任务」；本节点正在计时 → 「结束并记录 / 结束并丢弃」；
  // 别的节点正在计时 → 提示先结束它（引擎侧还有一道并发闸门兜底）
  entries.push({ text: t("view.menu.timerGroup"), run: () => undefined });
  const running = timeAggregates.get(file.path)?.activeEntry;
  if (running === undefined) {
    entries.push({
      text: t("view.menu.startTimer"),
      run: () => void startTimer(host, file, node.id, node.title, refresh),
    });
  } else if (running.nodeId === node.id) {
    entries.push({
      text: t("view.menu.stopRecord"),
      run: () => void stopTimer(host, file, node.id, node.title, "record", refresh),
    });
    entries.push({
      text: t("view.menu.stopDiscard"),
      run: () => void stopTimer(host, file, node.id, node.title, "discard", refresh),
    });
  } else {
    entries.push({ text: t("view.menu.otherTimer", { title: running.nodeTitle }), run: () => undefined });
  }

  // Phase 2 的结构写回：加子节点一律可用；根节点不能删（引擎也会拒）
  entries.push({ text: t("view.menu.structureGroup"), run: () => undefined });
  // Phase 5 ②：分字段改 summary / type / importance / progress / owner / dueAt
  entries.push({
    text: t("view.menu.editNode"),
    run: () => void editInfo(host, file, node, refresh),
  });
  entries.push({
    text: t("view.menu.addChild"),
    run: () => void addChild(host, file, node, refresh),
  });
  if (!isRoot) {
    entries.push({
      text: t("view.menu.deleteNode"),
      run: () => void removeNode(host, file, node, refresh),
    });
  }

  // Phase 4 归档：整棵子树（含本节点）都已完成才能归档；根 / 叶子 / 已归档 / 有未完成后代 → 写明原因
  entries.push({ text: t("view.menu.archiveGroup"), run: () => undefined });
  const archive = node.archive;
  if (archive !== undefined) {
    const archivePath = resolveArchiveFile(file, node);
    if (archivePath !== undefined) {
      entries.push({
        text: t("view.menu.openArchive", { path: archivePath }),
        run: () => openArchiveFile(host, file, archivePath),
      });
    }
  }
  const eligibility = archiveEligibility(node, isRoot);
  if (eligibility.ok) {
    entries.push({
      text: t("view.menu.archiveFrom"),
      run: () => void archiveBranch(host, file, node, refresh),
    });
  } else {
    const reason = eligibility.reason ?? t("view.menu.cannotArchive");
    entries.push({
      text: t("view.menu.archiveFromBlocked", { reason }),
      run: () => host.notify(t("view.notify.cannotArchive", { title: node.title, reason })),
    });
  }

  openMenu({ x: event.clientX, y: event.clientY }, entries);
}

/**
 * 「标记为…」：走插件的 `setNodeStatus` → 引擎 `applyMutation`
 * （升格 1.0→1.1、三段写回、幂等校验），成功后局部刷新该节点那一列。
 */
async function changeStatus(
  host: WfViewHost,
  file: TFile,
  node: WfNode,
  status: NodeStatus,
  refresh: () => void,
): Promise<void> {
  const result = await host.setNodeStatus(file, node.id, status);
  if (!result.success) {
    host.notify(t("view.notify.writeFailed", { reason: result.reason ?? t("view.notify.unknownReason") }));
    return;
  }
  if (!result.changed) {
    host.notify(t("view.notify.statusSame", { title: node.title, status: statusLabel(status) }));
    return;
  }
  host.notify(
    t("view.notify.statusMarked", {
      title: node.title,
      status: statusLabel(status),
      suffix: warningSuffix(result.issues),
    }),
  );
  await refreshNodes(host, file, [node.id], refresh);
}

/**
 * 「▶️ 开始这个任务」：走插件的 `startTimer` → 引擎 `startTimerEntry`
 * （并发闸门：全文件已有进行中的计时会在这里被拒）。
 * 成功后局部刷新该节点那一列；总览里的正计时器由 `refreshChrome` 一起挂上。
 *
 * Phase 17：与 `stopTimer` 同形，只按 `nodeId` + `nodeTitle` 定位 —— 总览的「继续上次」只有
 * `lastCompletedEntry()` 给出的 id / 标题（没有完整 `WfNode`），两条入口才能复用同一段逻辑。
 */
async function startTimer(
  host: WfViewHost,
  file: TFile,
  nodeId: string,
  nodeTitle: string,
  refresh: () => void,
): Promise<void> {
  const result = await host.startTimer(file, nodeId);
  if (!result.success) {
    host.notify(t("view.notify.writeFailed", { reason: result.reason ?? t("view.notify.unknownReason") }));
    return;
  }
  if (!result.changed) {
    host.notify(t("view.notify.timerRunning", { title: nodeTitle }));
    return;
  }
  host.notify(t("view.notify.timerStarted", { title: nodeTitle, suffix: warningSuffix(result.issues) }));
  await refreshNodes(host, file, result.changedNodeIds, refresh);
}

/**
 * 「结束并记录」/「结束并丢弃」的**唯一实现**（节点右键菜单 + 总览计时器按钮共用）：
 * 走插件的 `stopTimer` → 引擎 `stopTimerEntry`。
 * `record` 补上 `endAt` + `hours`（方块阵随之重算）；`discard` 删掉这条（计时器消失）。
 *
 * 只按 `nodeId` + `nodeTitle` 定位：总览里的正计时器只有 `activeEntry`（没有完整 WfNode），
 * 这样两条入口才能复用同一段「写回 → 提示 → 局部刷新」逻辑。
 */
async function stopTimer(
  host: WfViewHost,
  file: TFile,
  nodeId: string,
  nodeTitle: string,
  mode: StopTimerMode,
  refresh: () => void,
): Promise<void> {
  const result = await host.stopTimer(file, nodeId, mode);
  if (!result.success) {
    host.notify(t("view.notify.writeFailed", { reason: result.reason ?? t("view.notify.unknownReason") }));
    return;
  }
  if (!result.changed) {
    host.notify(t("view.notify.noTimer", { title: nodeTitle }));
    return;
  }
  const verb = mode === "record" ? t("view.notify.stoppedRecord") : t("view.notify.stoppedDiscard");
  host.notify(`${verb}：「${nodeTitle}」${warningSuffix(result.issues)}`);
  await refreshNodes(host, file, result.changedNodeIds, refresh);
}

/* ------------------------------------------------------------------ *
 * 写回后的刷新（Phase 2：只重建受影响的列，外壳文字原位更新）
 * ------------------------------------------------------------------ */

/** 新文档的节点索引：id → { 节点, 父节点 id } */
interface NodeIndexEntry {
  node: WfNode;
  parentId?: string;
}

function indexNodes(wfDoc: WfJsonDocument): Map<string, NodeIndexEntry> {
  const index = new Map<string, NodeIndexEntry>();
  for (const visit of walkNodes(wfDoc)) {
    const entry: NodeIndexEntry = { node: visit.node };
    if (visit.parent !== undefined) entry.parentId = visit.parent.id;
    index.set(visit.node.id, entry);
  }
  return index;
}

/** 子树全部 id（含自身；用于「这一列重建过，后代不必再建」） */
function subtreeIds(node: WfNode): string[] {
  const ids = [node.id];
  for (const child of node.children ?? []) ids.push(...subtreeIds(child));
  return ids;
}

/** 分组快照：workflow id → state 串（"" = 进行中） */
function layoutOf(wfDoc: WfJsonDocument): Map<string, string> {
  const layout = new Map<string, string>();
  for (const workflow of wfDoc.workflows ?? []) layout.set(workflow.id, workflow.state ?? "");
  return layout;
}

/** 能否局部刷新：分组（进 / 出折叠区）没变就行，变了泳道得搬家 → 整块重渲染 */
function sameLayout(before: Map<string, string>, after: Map<string, string>): boolean {
  if (before.size !== after.size) return false;
  for (const [id, state] of before) {
    if (after.get(id) !== state) return false;
  }
  return true;
}

/**
 * 写回成功后的刷新：先试局部刷新，对不上再退回整块重渲染（`fallback`）。
 *
 *  1. 重读文件（插件已落盘）—— 读到 error / 分组变了 / 没注册表 → 整块重渲染；
 *  2. 只重建 `changedNodeIds` 命中的列：被重建的列整棵子树由新 DOM 覆盖，命中的后代直接跳过；
 *  3. 总览（含正计时器与方块阵）/ 页脚 / 泳道头只原位换内容 —— 树上的展开状态与滚动位置因此保住。
 */
async function refreshNodes(
  host: WfViewHost,
  file: TFile,
  changedNodeIds: readonly string[],
  fallback: () => void,
): Promise<void> {
  const registry = nodeRegistry.get(file.path);
  const session = renderSessions.get(file.path);
  const targets = [...new Set(changedNodeIds)];
  if (registry === undefined || session === undefined || targets.length === 0) {
    fallback();
    return;
  }

  const result = await host.analyzeFile(file);
  if (!result.found || result.hasError || result.document === undefined) {
    fallback();
    return;
  }
  const wfDoc = result.latestDocument ?? result.document;
  noteLinksByPath.set(file.path, result.noteLinks);
  if (!sameLayout(session.lanes.layout, layoutOf(wfDoc))) {
    fallback();
    return;
  }

  const index = indexNodes(wfDoc);
  const covered = new Set<string>();
  let rebuilt = 0;
  for (const id of targets) {
    if (covered.has(id)) continue;
    const handles = registry.get(id);
    if (handles === undefined) continue;
    if (!isAttached(handles.column)) {
      registry.delete(id); // 句柄已被整块重渲染作废
      continue;
    }
    const entry = index.get(id);
    if (entry === undefined) {
      handles.column.remove(); // 文档里已经没有这个节点
      registry.delete(id);
      rebuilt += 1;
      continue;
    }
    handles.column.replaceWith(renderSubtree(host, file, entry.node, fallback, handles.isRoot));
    for (const childId of subtreeIds(entry.node)) covered.add(childId);
    rebuilt += 1;
  }
  if (rebuilt === 0) {
    fallback();
    return;
  }
  // 顺手清掉随旧 DOM 一起作废的句柄（删节点时被摊平的那些子节点）
  for (const [id, handles] of registry) {
    if (!isAttached(handles.column)) registry.delete(id);
  }
  refreshChrome(host, file, fallback, session, wfDoc, result, new Date());
}

/**
 * 外壳文字：总览三行 / 页脚摘要 / 泳道头徽标 / 侧边栏按钮标题 / 开着的弹窗（树不动）。
 * 计时聚合在这里重算并写回缓存：写回后计时器出现/消失、弹窗里的方块阵按新的 `hours` 重排。
 *
 * 带 `host` / `file` / `refresh` 是为了重填总览时给计时器的快捷结束按钮重新挂上回调
 * （按钮触发写回 → `refreshNodes` → 再回到这里 → `fillOverview`）。
 */
function refreshChrome(
  host: WfViewHost,
  file: TFile,
  refresh: () => void,
  session: RenderSession,
  wfDoc: WfJsonDocument,
  result: AnalyzeResult,
  now: Date,
): void {
  const time = aggregateTimeEntries(wfDoc);
  timeAggregates.set(file.path, time);
  // Phase 16：侧边栏按钮 / 弹窗读的是这同一份上下文 → 就地换字段（挂在按钮上的闭包不必重挂）
  session.ctx.wfDoc = wfDoc;
  session.ctx.time = time;
  session.ctx.result = result;
  session.ctx.now = now;
  session.ctx.refresh = refresh;
  fillOverview(session.overview, host, file, refresh, summarizeDocument(wfDoc), time, session.theme, wfDoc);
  // Phase 18 ③：大标题在局部刷新时跟着设置项变（设置面板改了引导性话语 → 下一次刷新即生效）
  //if (isAttached(session.title)) session.title.setText(appTitleText(host));
  session.footer.setText(footerText(result));
  rememberArchiveRefs(file, result);
  for (const workflow of wfDoc.workflows ?? []) {
    const head = session.lanes.heads.get(workflow.id);
    if (head !== undefined && isAttached(head)) {
      fillLaneHead(head, workflow, session.lanes.colors.get(workflow.id));
    }
  }
  session.lanes.layout = layoutOf(wfDoc);
  refreshSidebarLabels(session);
  // 开着的弹窗跟着新数据重画（归档完 → 📦 里立刻多一行）
  refreshOpenWidget(session.ctx);
}

/* ------------------------------------------------------------------ *
 * 三个写回入口（Phase 2）：改资源链接 / 加子节点 / 删本节点
 * 统一流程：Modal 收集（插件侧）→ 写回 → 取消静默返回 → 成功局部刷新 → 失败提示原因
 * ------------------------------------------------------------------ */

/** 非 error 的提示条数 → 一句人话（与「标记为…」的提示口径一致） */
function warningSuffix(issues: readonly WfIssue[]): string {
  const count = issues.filter((item) => item.severity !== "error").length;
  return count > 0 ? t("view.notify.warningCount", { count }) : "";
}

/**
 * 「✏️ 编辑节点信息…」（Phase 5 ②）：Modal 分字段收集 `summary` / `type` / `importance` /
 * `progress` / `owner` / `dueAt` → 插件 `setNodeInfo`（引擎 `editNodeInfo`：patch 覆盖 /
 * clear 删除 / 其余不动）→ 局部刷新该节点那一列。
 */
async function editInfo(host: WfViewHost, file: TFile, node: WfNode, refresh: () => void): Promise<void> {
  const outcome = await host.editNodeInfo(file, node);
  if (outcome.cancelled || outcome.result === undefined) return; // 取消不是失败：不提示、不重渲染
  const result = outcome.result;
  if (!result.success) {
    host.notify(t("view.notify.writeFailed", { reason: result.reason ?? t("view.notify.unknownReason") }));
    return;
  }
  if (!result.changed) {
    host.notify(t("view.notify.nodeInfoUnchanged", { title: node.title }));
    return;
  }
  host.notify(t("view.notify.nodeInfoUpdated", { title: node.title, suffix: warningSuffix(result.issues) }));
  await refreshNodes(host, file, result.changedNodeIds, refresh);
}

/** 「➕ 添加子节点…」：Modal 收集标题等 → 插件追加 → 局部刷新父节点那一列 */
async function addChild(host: WfViewHost, file: TFile, node: WfNode, refresh: () => void): Promise<void> {
  const outcome = await host.promptAddChild(file, node);
  if (outcome.cancelled || outcome.result === undefined) return;
  const result = outcome.result;
  if (!result.success) {
    host.notify(t("view.notify.writeFailed", { reason: result.reason ?? t("view.notify.unknownReason") }));
    return;
  }
  if (!result.changed) {
    host.notify(t("view.notify.noNewChild", { title: node.title }));
    return;
  }
  const notes = [...(result.warnings ?? [])];
  host.notify(
    t("view.notify.childAdded", {
      title: node.title,
      notes:
        notes.length > 0
          ? t("view.notify.notesSuffix", { list: notes.join(t("view.notify.listSep")) })
          : "",
      suffix: warningSuffix(result.issues),
    }),
  );
  await refreshNodes(host, file, result.changedNodeIds, refresh);
}

/** 「🗑 删除本节点…」：二次确认后删节点（资料 / 子节点上移到父节点）→ 局部刷新父节点那一列 */
async function removeNode(host: WfViewHost, file: TFile, node: WfNode, refresh: () => void): Promise<void> {
  const outcome = await host.confirmDeleteNode(file, node);
  if (outcome.cancelled || outcome.result === undefined) return;
  const result = outcome.result;
  if (!result.success) {
    host.notify(t("view.notify.writeFailed", { reason: result.reason ?? t("view.notify.unknownReason") }));
    return;
  }
  if (!result.changed) {
    host.notify(t("view.notify.notDeleted", { title: node.title }));
    return;
  }
  const linkNote = result.mergeLinks === false ? t("view.notify.linksDropped") : t("view.notify.linksMerged");
  host.notify(
    t("view.notify.nodeDeleted", {
      title: node.title,
      linkNote,
      suffix: warningSuffix(result.issues),
    }),
  );
  await refreshNodes(host, file, result.changedNodeIds, refresh);
}

/**
 * 「📦 为此及之后归档…」（Phase 4）：Modal 收集三段文字 → 插件侧建归档 md + 本文件浓缩 →
 * 局部刷新浓缩节点那一列（`refreshNodes` 会顺带重画 ③ 已归档块，新归档立即出现在下面）。
 * 归档 md 可能是幂等重试复用的（`reusedArchiveFile`），提示里说清，免得用户以为没生效。
 */
async function archiveBranch(host: WfViewHost, file: TFile, node: WfNode, refresh: () => void): Promise<void> {
  const outcome = await host.promptArchiveNode(file, node);
  if (outcome.cancelled || outcome.result === undefined) return;
  const result = outcome.result;
  if (!result.success) {
    host.notify(t("view.notify.archiveFailed", { reason: result.reason ?? t("view.notify.unknownReason") }));
    return;
  }
  if (!result.changed) {
    host.notify(t("view.notify.unchanged", { title: node.title }));
    return;
  }
  const target = result.archiveFile ?? "archive/";
  const reused = result.reusedArchiveFile === true ? t("view.notify.archiveReused") : "";
  host.notify(
    t("view.notify.archived", {
      title: node.title,
      count: result.nodeCount ?? 0,
      target,
      reused,
      suffix: warningSuffix(result.issues),
    }),
  );
  await refreshNodes(host, file, result.changedNodeIds, refresh);
}

/* ------------------------------------------------------------------ *
 * 页脚
 * ------------------------------------------------------------------ */

/** 页脚：schema 版本 + 校验摘要（返回元素，局部刷新时只 setText） */
function renderFooter(container: HTMLElement, result: AnalyzeResult): HTMLElement {
  return container.createDiv({ cls: "wf-footer", text: footerText(result) });
}

/** 页脚文字（写回后一眼看出是否仍然全绿） */
function footerText(result: AnalyzeResult): string {
  const { error, warning, info } = result.counts;
  const version = result.document?.schemaVersion ?? "?";
  const upgraded =
    result.upgradedFrom !== undefined
      ? t("view.notify.upgraded", {
          from: result.upgradedFrom,
          to: result.latestDocument?.schemaVersion ?? "?",
        })
      : "";
  const tail = result.hasIssue ? t("view.notify.issuesHint") : t("view.notify.noIssues");
  return t("view.notify.schemaLine", { version, upgraded, error, warning, info, tail });
}
