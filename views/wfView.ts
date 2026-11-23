/**
 * dataviewjs 视图 v1（Phase 1：只读两块 + 右键写回挂载点；Phase 3：正计时器 + 近 21 天方块阵；
 * Phase 4：右键归档入口 + ③ 已归档块；Phase 5：① 近 21 天甘特图 / ② 右键「编辑节点信息」/
 * ③ 「正在进行」块尾的「修改工作流」按钮）。
 * Phase 22：根节点的右键归档入口改成「📦 归档整个工作流…」（资格看整棵树全 done），
 * 📦「已归档」里整条流归档的行多一枚 `[完整工作流]` 角标。
 * Phase 27（三块一起落地，契约见 doc/datacontact/phase27_bound.md）：
 *  - M1：根节点卡片在「修改节点顺序」开着时也挂**落点**（`draggable: false`）—— 只接 `after`；
 *  - M2：「正在进行」块里多一列**钉死**的「未分类」（`.wf-block-body` 包裹，列头 = 落点 + 「+ 新建」）；
 *  - M3：卡片的 🔗 计数 / 实虚线 / 右键资料菜单改由 `host.linkedFiles()`（全库反向 YAML 索引）驱动，
 *    不再读正文纪要段（`noteLinksOf` / `jumpToNote` / `openResource` 全部下线）。
 *
 * 结构（从上到下，Phase 16 定稿，Phase 17 微调，Phase 18 加标题行）：
 *   ⓪ 引导性大标题：`div.wf-app-title`（用户文案来自插件设置 `resumePrompt`，空则用 i18n
 *      「下一步是？」；Phase 18 ③）—— 渲染区最顶部，在「状态总览」之上；
 *   ① 状态总览：第 1 行 = 主题切换按钮组（8 套主题，点了只写本文件 `wf-theme`）/
 *      第 2 行 = 正计时器（有进行中的计时条目时才有：`正在：<节点标题>` / 黑底白字 `HH:MM:SS` /
 *        「结束并记录 · 结束并丢弃」快捷按钮；Phase 3 视图微调 v0.7）；
 *        **不计时时**换成「上次：<节点标题> ▶️ 继续计时」（Phase 17，两者互斥）；
 *        Phase 18 起收成**一个**按钮：`上一个任务：<title> · 继续这个任务`；
 *      第 3 行 = 统计文本 `进行：a/B 受阻：n`（只统计 state 缺省＝进行中的 workflow 的节点）
 *   ② 主体（Phase 16）：左侧小工具侧边栏（📊 21 天甘特图 / 🎯 四象限 /
 *      📦 已归档 / 📈 365 天 plot / ⚙️ 插件设置）+ 右侧工作区：
 *      「正在进行」块按 workflow **横向分栏**（一栏一条泳道，栏内横向滚动；
 *      Phase 17 起泳道正文区各自纵向滚动＝每条泳道一条滚动条、栏头固定，非首栏用左边框当分隔线）；
 *      `state` 为 archived / cancelled 的 workflow 进入「已完成流 / 已取消流」折叠区（仍用切换栏）；
 *      块尾按钮行（Phase 15 起同一行两个按钮）：「修改节点顺序」开关 + 「⚙️ 修改工作流…」按钮
 *   ③ 页脚：schema 版本与校验摘要
 *
 * 弹窗（Phase 16 ③）：侧边栏前 4 个按钮各开一个自绘浮层（`document.body.createDiv` +
 * `themeOverlay()`，不是 Obsidian 的 `Modal`）；Phase 24 起**每个文件一个**（`file.path` 分桶），
 * 同一文件同时只开一个，只有「×」能关
 * （点空白 / Esc 都不关；边界与取舍见 doc/datacontact/data_ixd_discuss_interact_v0.16.md §③）。
 * Phase 18 ①：浮层外面多一层全屏半透明遮罩 `.wf-widget-overlay`（吃掉下层点击，但**点它不关闭**）；
 * 整块重渲染与局部刷新都会把开着的弹窗跟着重画（`refreshOpenWidget`），换文件则不动它。
 *
 * 边界（与 doc/datacontact/data_ixd_discuss_interact.md 的路线一致）：
 *  - 读：`host.analyzeFile(file)`（引擎在内存中把 1.0 / 1.1 / 1.3 / 1.6 升格为 1.9，**不落盘**）；
 *    Phase 23 A 案：**写回后的那次重画不再走它** —— 写回结果自带引擎算好的 `analysis`
 *    （`MutationResult.analysis`），视图直接复用（局部刷新吃 `refreshNodes(..., fresh)`，
 *    整块重渲染吃 `pendingAnalysis`），省掉「再读一遍盘 + 再全量校验一遍」的往返；
 *  - 写：唯一入口是 `host.setNodeStatus()` / `host.openNodePanel()`（Phase 25：节点操作统一进
 *    右侧面板的 tab —— 编辑信息 / note / 加子节点 / 改工作流 / 归档 / 删除 / 链接文档；表单与写回
 *    都在插件侧，视图只传「哪个节点、哪个 tab」并拿回 `ModalEditOutcome`）/
 *    `host.startTimer()` / `host.stopTimer()` / `host.moveNode()` /
 *    `host.setNodeCollapsed()`（Phase 21 ⑤：折叠三角直接改 JSON 的 `collapsed`）；其中「开始 / 结束计时」两处入口 ——
 *    节点右键菜单、总览正计时器上的快捷结束按钮 —— 共用同一段 `stopTimer` 回调（写回 → 提示 → 局部刷新）；
 *    成功后按返回的 `changedNodeIds` **局部刷新**（只重建受影响的列），定位不到就退回整块重渲染；
 *    ③ 修改工作流带了**结构变化**（增删 workflow）时直接整块重渲染（`refresh`），只改字段才局部刷新。
 *  - 稳定视图（v0.7 §⑦ / §⑨-9）：整块重渲染按 `file.path` **串行 + last-wins** —— 写 `wf-theme`
 *    会同时引出「插件 `refresh()`」与「Dataview 自动重跑 dataviewjs 块」两条重渲染，交错就会跳位；
 *    单轮里的顺序是「先拿分析（写回自带 / 否则 `analyzeFile`）→ 再抓滚动 → 清空 → 重建 → 恢复」，
 *    空容器不进 await。
 *    Phase 22 起滚动分两层恢复：外层滚动宿主（`captureScroll`）+ **每条泳道正文自己的**
 *    纵向滚动位置。「泳道正文滚到底」只在**打开笔记**那一帧做；改 note / 改节点顺序 / 切主题等
 *    重渲染保持用户看到的位置不变。Phase 23 C 案把这一步做实：重渲染**复用上一帧的
 *    `.wf-lane-body` 元素本身**（`captureLaneBodies` → `renderLane` 的 `reuse` 参数），
 *    `scrollTop` 直接按抄下来的值复原 —— 没有「先跳到底 / 跳到顶再拨回来」的中间态。
 *    Phase 23 D 案补上 A/C 案够不到的一段：Dataview 每次重跑都会**先** `container.innerHTML = ""`，
 *    那一步发生时 `paint` 还没开始、活 DOM 已经没了。所以插件在**写盘前**（`main.ts` 的
 *    `mutateFile` / `setFileTheme`）用 `rememberViewScroll` 按 `file.path` 抢一份位置存到 DOM 之外，
 *    下次 `paint` 发现容器已被清空就用它兜底（首帧语义靠 `renderSessions.has` 区分）。
 *  - 布局：根节点第 0 列；第 1 个子节点同列下一行；第 2..n 个子节点各自右开一列（行号对齐）；连线用 CSS；
 *  - 单文件视图：不扫 ./archive/，归档 workflow 来自本文件 `workflows[]`；③ 已归档块同样**不扫目录**，
 *    行里的归档文件 链接直接读浓缩节点的 `archive.file`（磁盘上那份由插件侧归档时写出来）；
 *  - DOM：`document` **不是容器**！Obsidian 的 `createEl` / `createDiv` 是「创建 + append 到接收者」，
 *    写 `document.createDiv()` 会往 document 根节点 append → `HierarchyRequestError: Only one element
 *    on document allowed`。游离（还没挂父级）的元素一律走 `detachedDiv()`。
 */

import type { App, TFile  } from "obsidian";
import { setIcon } from "obsidian";   // 文件顶部，已有 obsidian import 就合并进去
import {
  archiveFolderOf,
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
  workflowArchiveEligibility,
  buildGantt,
  buildHeatmap,
  collectNodeRecords,
  formatClock,
  formatHourSpan,
  formatHourStamp,
  formatIssues,
  formatLocalDate,
  formatMinuteOfDay,
  formatWorkDuration,
  formatStatusOverview,
  ganttTickHours,
  groupWorkflows,
  issuesWithCode,
  nodeRefFor,
  parseIso,
  recordDurationMs,
  summarizeDocument,
  walkNodes,
  wholeDaysFromTo,
  completedHours,
  type ActiveTimer,
  type AnalyzeResult,
  type ArchiveFileMeta,
  type AttachToUnclassifiedResult,
  type DocumentSummary,
  type GanttSpan,
  type HeatmapCell,
  type LinkedFile,
  type MoveNodeOptions,
  type NodeAffiliationRef,
  type NodeRecord,
  type NodeStatus,
  type ReorderPosition,
  type StopTimerMode,
  type TimeAggregate,
  type WfIssue,
  type WfJsonDocument,
  type WfNode,
  type WfNoteItem,
  type WfWorkflow,
  type WorkflowGroups,
  type WorkflowState,
} from "../src/engine/index.ts";
import { renderPlot } from "./plotWidget.ts";
import { renderQuadrant } from "./quadrantWidget.ts";

/* ------------------------------------------------------------------ *
 * 对外契约（main.ts 的 WfJsonWorkflowPlugin 实现 WfViewHost）
 * ------------------------------------------------------------------ */

/**
 * A 案（写回后不重读重校验）：下面每个写回结果都可以带一份 `analysis`。
 *
 * 插件侧放的就是引擎 `MutationResult.analysis` —— 它已经是**写回后**整篇笔记的分析
 * （`latestDocument` / `noteLinks` / `noteSections` / `frontmatter` 全在里面），
 * 而 `mutateFile` 本来就要算它（用来做幂等校验）。视图拿它直接重画，
 * 于是写回后不必再 `host.analyzeFile(file)`（一次读盘 + 一次全量校验，那才是
 * 「点完等半天才蹦出来」的主间隔）。
 *
 * 缺省时（Dataview 自动重跑、插件没给、测试替身）视图照旧回落到 `host.analyzeFile(file)`。
 */
interface FreshAnalysisCarrier {
  /** 写回后的最新分析（视图直接复用，不重读盘重校验） */
  analysis?: AnalyzeResult;
}

/** 改状态的附加信息（缺省只用 nodeId + status） */
export interface NodeStatusChangeOptions {
  note?: string;
  by?: string;
}

/** 改状态的结构化返回（视图按 success / changed / issues 决定提示与重渲染） */
export interface NodeStatusChangeResult extends FreshAnalysisCarrier {
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
export interface NodeInfoChangeResult extends FreshAnalysisCarrier {
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
 * 编辑 note 卡片（Phase 20）的返回：与 `NodeInfoChangeResult` 同形。
 * `changed = false` 表示引擎判 `unchanged`（一个字都没改）→ 没写盘，视图也不用重画。
 */
export interface NodeNoteChangeResult extends FreshAnalysisCarrier {
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
export interface WorkflowChangeResult extends FreshAnalysisCarrier {
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
export interface ReorderResult extends FreshAnalysisCarrier {
  success: boolean;
  file?: string;
  changed: boolean;
  reason?: string;
  issues: WfIssue[];
  /** 受影响节点（拓扑变化一律整块重渲染，这里只给日志 / 调试用） */
  changedNodeIds: string[];
}

/**
 * 折叠三角点击（Phase 21 ⑤）的返回：`collapsed` = 目标状态。
 * `changed = false` 表示引擎判 `unchanged`（JSON 里本来就是这个状态）→ 没写盘。
 */
export interface NodeCollapseResult extends FreshAnalysisCarrier {
  success: boolean;
  file?: string;
  nodeId: string;
  /** 本次请求的目标折叠态 */
  collapsed: boolean;
  changed: boolean;
  reason?: string;
  issues: WfIssue[];
  /** 受影响节点（折叠态只影响自己，视图不需要局部刷新） */
  changedNodeIds: string[];
}

/**
 * 加子节点的返回：除上面的字段外还带回新节点 id（视图据此定位新列）
 */
export interface AddChildNodeResult extends FreshAnalysisCarrier {
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

/**
 * Phase 27 M2：列头落点（「搬到未分类」）的返回。
 *
 * 引擎 `attachNodeToUnclassified` 只给 `ok / unchanged / changedNodeIds`（纯函数不带分析），
 * 插件侧 `mutateFile` 另外把「写回后的分析」塞进来，视图据此整块重渲染而不重读盘。
 */
export interface AttachToUnclassifiedOutcome extends AttachToUnclassifiedResult, FreshAnalysisCarrier {}

/** 删节点的返回：带回父节点 id（视图清理注册表要用） */
export interface DeleteNodeResult extends FreshAnalysisCarrier {
  success: boolean;
  file?: string;
  nodeId: string;
  changed: boolean;
  reason?: string;
  issues: WfIssue[];
  changedNodeIds: string[];
  /** 被删节点的父节点 id（根节点没有父节点，删不掉） */
  parentId?: string;
}

/** 归档节点的返回（Phase 4）：另带归档文件 路径 / 复用标记与浓缩的节点数 */
export interface ArchiveNodeResult extends FreshAnalysisCarrier {
  success: boolean;
  file?: string;
  /** 被浓缩的节点 id（子树根） */
  nodeId: string;
  changed: boolean;
  reason?: string;
  issues: WfIssue[];
  changedNodeIds: string[];
  /** 归档文件 的 vault 路径（`archive/<workflowId>-<nodeId>.wf.json`） */
  archiveFile?: string;
  /** 归档文件 里那个新工作流的 id */
  workflowId?: string;
  /** 浓缩进归档文件 的节点数（含子树根） */
  nodeCount?: number;
  /** true = 扫到上次的归档文件 就复用它（幂等重试），没有新建 */
  reusedArchiveFile?: boolean;
  /**
   * Phase 36：true = 重复归档（把新子树**追加**到已有归档文件 的根节点下）。
   *
   * 此时 `nodeCount` 是「本次追加的节点数」（不是整份归档的节点数），提示文案也换成「已追加归档」。
   */
  appended?: boolean;
}

/**
 * Phase 39：编辑归档信息的返回。
 *
 * 编辑对象是**归档文件自己的 `workflow.archive`**（不再绑原看板节点），
 * 所以返回里给的是归档文件的 `workflowId`。
 * changed 为 false 表示与现状一致（引擎判 unchanged）→ 没写盘，视图也不用重画。
 */
export interface ArchiveInfoEditResult extends FreshAnalysisCarrier {
  success: boolean;
  /** 归档文件的 vault 路径 */
  file?: string;
  /** 被编辑的归档 workflow id（归档文件里的 `workflow.id`） */
  workflowId: string;
  changed: boolean;
  reason?: string;
  issues: WfIssue[];
}

/**
 * Phase 34：编辑节点链接文档（面板 tab 6）的返回。
 *
 * 面板里可以连续新建多份文档（不关窗），所以 `createdPaths` 是数组；
 * `changed = linkDirChanged || createdPaths.length > 0`（视图据此决定要不要刷新 🔗 计数）。
 */
export interface LinkDocsResult extends FreshAnalysisCarrier {
  success: boolean;
  file?: string;
  nodeId: string;
  /** 本次有没有真的写盘（新建了文档 / 改了 `linkDir`） */
  changed: boolean;
  reason?: string;
  issues: WfIssue[];
  changedNodeIds: string[];
  /** 本次新建的文件路径（vault 相对，按创建顺序） */
  createdPaths: string[];
  /** `node.linkDir` 是否被写回（只有目录变了才是 true） */
  linkDirChanged: boolean;
}

/**
 * 计时动作（开始 / 结束并记录 / 结束并丢弃）的返回（Phase 3 契约 §5.1 / §5.2）：
 * 与 `NodeInfoChangeResult` 同形，另带本次涉及的条目下标与动作模式。
 */
export interface TimerChangeResult extends FreshAnalysisCarrier {
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
  /**
   * Phase 24：绑定式宿主（ItemView 看板）用的**严格模式**。
   *
   * `false`（默认）= 老行为：`currentFilePath` 解析不到就回退到活动文件（Dataview 的嵌入场景
   * 确实拿不到路径，回退是必要的容错）。
   * `true` = 绝不回退：路径指向的笔记不在 / 路径为空 → 按「没有文件」渲染提示。
   * 否则「绑定某篇笔记的看板」在笔记被删后会悄悄显示**另一篇**笔记的工作流。
   */
  strictFile?: boolean;
}

/**
 * Phase 25（M4）：节点操作面板的选项卡（契约 §6.1）。
 * 顺序即面板里的 tab 顺序；`"workflow"` 是唯一不需要具体节点的 tab（块尾「⚙️ 修改工作流」）。
 *
 * Phase 34：追加第 6 个 `"links"`（编辑节点链接文档 —— 反向 YAML 归属的列表 + 新建）。
 * Phase 36：追加 `"note"`（设置 note 节点 —— 原独立弹窗并入面板，紧跟 `"info"`）。
 */
export type WfPanelTab = "info" | "note" | "child" | "workflow" | "archive" | "delete" | "links";

/**
 * tab → 写回结果类型。`openNodePanel` 靠它把返回的 `ModalEditOutcome` 收窄回各自的结果类型
 * （调用方写 `host.openNodePanel(file, node, "info")` 就得到 `ModalEditOutcome<NodeInfoChangeResult>`，
 * 不需要任何类型断言）。
 */
export interface WfPanelResultMap {
  info: NodeInfoChangeResult;
  note: NodeNoteChangeResult;
  child: AddChildNodeResult;
  workflow: WorkflowChangeResult;
  archive: ArchiveNodeResult;
  delete: DeleteNodeResult;
  links: LinkDocsResult;
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
   * Phase 25（M4）：节点操作的**右侧面板**入口（契约 §6.2）。
   *
   * 视图只负责「哪个节点、哪个 tab」，表单 / 写回 / 面板宿主都在插件侧；返回该 tab 的写回结果 ——
   * 保存成功 → `cancelled: false` + `result`；取消 / 换 tab / 关面板 / 宿主读不到文档 → `cancelled: true`
   * （视图据此决定「提示什么、局部刷哪一列」，语义与 Phase 25 之前的 Modal 入口完全一致）。
   *
   * - `node` 只在 `"workflow"` 下可空：块尾「⚙️ 修改工作流」不对应具体节点；
   * - `workflow` 只在 `"archive"` 用得上：整条工作流归档与节点归档共用同一张表单，
   *   由入口传 `workflow` 决定 target（契约 §6.1 选项卡 4，面板不合并二者语义）；
   * - Phase 34：`"links"` = 编辑节点链接文档（反向 YAML 归属的列表 + 新建），同样需要具体节点；
   * - `theme` = 本帧看板主题（`overlayTheme(file)`）：面板外壳据此挂 `data-wf-theme`，
   *   8 套主题的 tab / 标题 / 表单皮肤才会命中（不传 / 空串 = 素净基线，Phase 44）。
   */
  openNodePanel<T extends WfPanelTab>(
    file: TFile,
    node: WfNode | undefined,
    tab: T,
    workflow?: WfWorkflow,
    theme?: string,
  ): Promise<ModalEditOutcome<WfPanelResultMap[T]>>;
  /**
   * note 卡片上的方框点击（Phase 20 修订）：待办 ↔ 已办。内部走引擎 `toggleNodeNoteDone`
   * （只翻 `done`，不动 `noteVisible`）；`changed = false` 表示没变，视图不重渲染。
   */
  toggleNodeNote(file: TFile, nodeId: string, index: number): Promise<NodeNoteChangeResult>;
  /**
   * Phase 20：note 卡片最多显示**几条**（设置面板的「note 卡片显示条数」，1~10）。
   * 超出的条目**静默截断**（`note` 里的数据一条都不丢，改设置就能再看到）。
   */
  noteLines(): number;
  /**
   * Phase 15：拖拽改节点顺序（`position` = 落在目标卡片上半 `before` / 下半 `after`）。
   * 内部走引擎 `moveNode`（只改 `children` 的归属与顺序，schema 不变）；
   * 拓扑没变（拖回原位）时返回 `changed = false`，视图据此不重渲染。
   *
   * Phase 21：`options.keepSubtree` = 被拖的是**折叠节点**（`dragstart` 时拍的快照）——
   * 整棵子树跟着走，`after` 时目标原来的 children 追加在被拖节点原有 children 之后。
   */
  moveNode(
    file: TFile,
    movingId: string,
    targetId: string,
    position: ReorderPosition,
    options?: MoveNodeOptions,
  ): Promise<ReorderResult>;
  /**
   * Phase 21 ⑤：折叠三角点击 → **直接改 JSON** 的 `collapsed`（引擎 `setNodeCollapsed`）。
   * 视图先切 DOM（不等写回），失败再提示 + 整块重渲染回到 JSON 事实。
   */
  setNodeCollapsed(file: TFile, nodeId: string, collapsed: boolean): Promise<NodeCollapseResult>;
  /** 「▶️ 开始这个任务」→ 内部走引擎 `startTimerEntry`（并发闸门：全文件只允许一个） */
  startTimer(file: TFile, nodeId: string): Promise<TimerChangeResult>;
  /** 「结束并记录」/「结束并丢弃」→ 内部走引擎 `stopTimerEntry`（节点右键菜单与总览计时器按钮共用） */
  stopTimer(file: TFile, nodeId: string, mode: StopTimerMode): Promise<TimerChangeResult>;
  /**
   * Phase 24：打开归档文件（`archive/<workflowId>-<nodeId>.wf.json`）。
   *
   * 插件实现为「用归档文件打开一个**看板** leaf」；视图不再自己 `openLinkText`（否则「有时开 md、
   * 有时开看板」）。归档文件 不存在时由宿主提示，不回落。
   */
  openArchiveBoard(path: string): void;
  /* ---- Phase 27 M2：未分类列的两个入口 ---- */
  /**
   * 未分类列「＋ 新建节点」：插件先 `ensureUnclassifiedWorkflow` 写一次，
   * 再对隐藏 `root` 开现有的「加子节点」面板（复用 `appendChildNode`，不新造表单）。
   *
   * `theme` 与 `openNodePanel` 同口径（本帧看板主题 `overlayTheme(file)`）：面板外壳
   * 据此挂 `.wf-theme[data-wf-theme]` —— 这个入口与「节点右键 → 面板」是同一张弹窗，
   * 不传主题就会退回素净基线，和右键弹窗长得不一样（契约 §6.2）。
   */
  openUnclassifiedChildPanel(file: TFile, theme?: string): Promise<ModalEditOutcome<AddChildNodeResult>>;
  /**
   * 把节点整棵子树搬到未分类当顶层节点（列头落点）：
   * 内部 `mutateFile(document => attachNodeToUnclassified(document, nodeId))`，
   * `unchanged = true` 表示它本来就是未分类顶层节点（不写盘）。
   */
  attachNodeToUnclassified(file: TFile, nodeId: string): Promise<AttachToUnclassifiedOutcome>;
  /* ---- Phase 27 M3：反向 YAML 资料归属（全库索引由插件维护，视图只查） ---- */
  /**
   * 该节点的资料文件（**同步**：渲染时直接拿，不发 Promise）。
   *
   * 数据源是插件的全库反向索引（`metadataCache` → `buildReverseIndex`）：
   * 匹配顺序 id 精确 → `workflowTitle::nodeTitle` 兜底，见引擎 `resolveLinkedFiles`。
   */
  linkedFiles(ref: NodeAffiliationRef): LinkedFile[];
  /** 打开一份资料文件（本期只认 `.md`；不支持的扩展名由宿主 `Notice`，不抛错） */
  openLinkedFile(path: string): void;
  /* ---- Phase 6/9 主题（主题跟随文件） ---- */
  /** 可选主题清单（插件提供；为空时视图不渲染切换入口） */
  themes: readonly WfThemeOption[];
  /** 只写本文件 frontmatter `wf-theme`（不碰全局设置；视图随后自行重渲染） */
  setFileTheme(file: TFile, theme: string): Promise<void>;
  /** 提示信息（插件侧实现为 Notice；视图不直接依赖 Obsidian 运行时） */
  notify(message: string): void;
  /**
   * Phase 16：打开本插件的设置页（侧边栏第 5 个按钮 ⚙️）。
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
   * Phase 19 M3：365 天 plot 的目录（插件设置 `plotFolder`，默认 `plots`）。
   * 视图拼 `${plotFolder()}/plot-<uuid>.json`（导出的 CSV 也在同一目录）。
   */
  plotFolder(): string;
  /**
   * Phase 26：导出数据 —— 插件弹窗列出当前看板的 json **绝对路径**（可复制）+ 备份副本。
   *
   * 视图只负责调用：路径解析（`basePath`）、备份副本路径、复制按钮、移动端回落全在插件侧
   * （视图层不许 import Node `fs`，也不该知道库在磁盘上的位置）。
   */
  exportData(file: TFile): void;
  /**
   * Phase 26：从**任意绝对路径**导入（契约 §5.3）。
   *
   * 插件内部走完整条链：读源（库内 `vault` / 库外 `fs`）→ 体检 → 报告弹窗 → 用户确认 →
   * 写侧车 JSON → 结果弹窗。视图不拼路径、不读文件、不判断合法性；
   * 导入只认 JSON，笔记正文既不是输入也不被修改。
   */
  importData(file: TFile, jsonPath: string): Promise<void>;
  /**
   * Phase 37：批量导入（「导入 / 导出」小工具的两个区块都用它）。
   *
   *  - `mode = "board"`：把每个源 JSON 里的工作流**追加进当前看板**（撞 id 整条跳过，不覆盖）；
   *  - `mode = "archive"`：把每个源 JSON 里的每条工作流写成**独立的归档文件**
   *    （`<看板目录>/archive/<workflowId>-<rootNodeId>.wf.json`），**不动任何看板**（全局视角）。
   *
   * 视图只传路径清单；读源 / 体检 / 合并 / 写盘 / 提示全在插件侧。
   */
  importJsonPaths(file: TFile, paths: readonly string[], mode: "board" | "archive"): Promise<void>;
  /** Phase 37：导出清单（当前看板侧车 + 全部归档文件的**绝对路径**，主看板排第一） */
  boardJsonPaths(file: TFile): string[];
  /** Phase 37：桌面端多选 JSON 文件（取消 / 移动端 / 拿不到文件对话框 → 空数组） */
  pickImportJsonPaths(): Promise<string[]>;
  /** Phase 37：复制文本到剪贴板（失败时插件 `Notice`；视图不直接碰剪贴板 API） */
  copyText(text: string): void;
  /** Phase 37：`<看板目录>/archive/*.wf.json` 的 vault 相对路径（已归档弹窗的「全局视角」区块） */
  archiveBoardFiles(): string[];
  /** Phase 39：归档标签枚举（archive_tag.yaml；同步读缓存，视图渲染时直接拿） */
  archiveTags(): string[];
  /**
   * Phase 41：重扫 `archive_tag.yaml` 再返回最新枚举（打开「已归档」弹窗时调）。
   *
   * `archiveTags()` 是启动缓存 —— 用户刚在 yaml 里加的词它不知道；弹窗一打开就现读一次，
   * 标签筛选 / 表单候选才跟得上磁盘。读不到 / 解析失败 → 空数组（宿主不抛错）。
   */
  refreshArchiveTags(): Promise<string[]>;
  /**
   * Phase 39：读一份归档文件的元数据（「已归档」弹窗**打开时才读** —— 懒加载）。
   *
   * 一次读回 `workflow.archive`（归档时间 / 来源 / 三段文字 / 标签）与 workflow id / 节点数；
   * 文件不在 / 解析失败 → undefined（视图该行只显示文件名）。
   */
  readArchiveMeta(path: string): Promise<ArchiveFileMeta | undefined>;
  /**
   * Phase 39：编辑一条归档记录（**归档文件自己的 `workflow.archive`**：三段文字 + 标签）。
   *
   * 与 `readArchiveMeta` 同一份数据源：初值由插件现读文件，写回走 `mutateFile` 的 `.wf.json` 分支。
   * 视图只传归档文件路径，不读不写任何 JSON。
   */
  openArchiveMetaEditor(path: string): Promise<ModalEditOutcome<ArchiveInfoEditResult>>;
  /**
   * Phase 39：按 workflow id 开归档看板（`node.archive` 只有 workflowId，没有路径）。
   * 扫描 `archive/` 找到 workflow.id 匹配的那份；找不到 → `Notice`（带 workflowId）。
   */
  openArchiveBoardByWorkflowId(workflowId: string): void;
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
  todo: "⏺️",
  doing: "▶️",
  done: "⏹️",
  blocked: "⏸️",
  cancelled: "◀️",
};

/**
 * Phase 27 M3：资料菜单项的图标。
 *
 * 只剩 markdown 一种（口径 10：反向 YAML 关联本期只覆盖 `.md`）——
 * 原来的 `LINK_ICON`（md/web/image/file）随「正文超链接」范式一起下线。
 */
const LINKED_FILE_ICON = "📄";

/**
 * 右键菜单里最多列几份资料文件（Phase 34）。
 *
 * 菜单不是列表：超过 5 份就只列前 5 条 + 一行「… 另有 N 份」，全部文件在
 * 「🗂 编辑节点链接文档」面板里看（那里有滚动条）。
 */
const LINK_MENU_LIMIT = 5;

/* ------------------------------------------------------------------ *
 * 节点注册表 + DOM 折叠状态（Phase 2：写回后只重建受影响的列）
 * ------------------------------------------------------------------ */

/** 一个节点的 DOM 句柄：列元素（可整列替换）+ 列内的卡片（用于不整列重排的小修） */
interface NodeHandles {
  column: HTMLElement;
  card: HTMLElement;
  /** 是否是 workflow 根节点（根不能删、也只能在泳道里） */
  isRoot: boolean;
  /**
   * Phase 21 ⑤：节点快照本身 —— 开 / 关「修改节点顺序」时要**原位**给卡片挂 / 摘拖拽，
   * 只有卡片元素不够（`enableCardDrag` 还要 id 与折叠态）。
   */
  node: WfNode;
  /**
   * Phase 22：该节点所属的整条工作流（局部刷新重建列时原样传回 `renderSubtree`，
   * 否则根节点卡片重建后就丢了「📦 归档整个工作流」入口）。
   */
  workflow: WfWorkflow | undefined;
}

/** 按文件路径分桶：同一视图先后渲染不同笔记时不会互相踩 */
const nodeRegistry = new Map<string, Map<string, NodeHandles>>();

/**
 * DOM 级折叠状态（用户点过三角的结果）。
 *
 * Phase 21 ⑤ 起折叠态**直接落盘**（JSON 的 `collapsed`），这里只当「写回期间的乐观覆盖」：
 * 显式记 `true` / `false` 两个方向，`isCollapsed()` 优先读它、没有就回落 JSON 事实。
 * 整块重渲染（切主题 / Dataview 重跑 / 拖拽后）会清空 → 回到 JSON 事实（此时写回早已落地）。
 */
const collapseState = new Map<string, Map<string, boolean>>();

/* ------------------------------------------------------------------ *
 * Phase 15：拖拽改节点顺序的视图状态（全部是会话内存，不落盘）
 * ------------------------------------------------------------------ */

/**
 * 开了「修改节点顺序」的文件（键 = `file.path`）。
 * 与折叠区展开态同一惯例：只存视图会话内存，Obsidian 重启 / 重开文件回到「关」。
 * 注意它**不**在 `beginRender()` 里清空 —— 开关本身就是要跨整块重渲染保留（切主题 / Dataview 重跑）。
 */
const reorderEnabled = new Set<string>();

/** 正在拖的源节点 id（一次只可能有一个；`drop` / `dragend` / 整块重渲染都会清空） */
let draggingNodeId: string | null = null;

/**
 * 正在拖的源节点是否折叠（Phase 21：折叠节点的整棵子树跟着走）。
 * `dragstart` 时按当时的折叠态拍快照 —— 拖拽途中展开 / 收起不影响本次结果。
 */
let draggingKeepSubtree = false;

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
  /** Phase 16：侧边栏 / 弹窗共用的绘图上下文（局部刷新时就地更新字段，闭包不用重挂） */
  ctx: WidgetContext;
  /** Phase 25：顶部工具行（局部刷新时切 overview 开合态 / 重画主题按钮） */
  boardTop?: HTMLElement;
  /** Phase 25：左侧导航条（抽屉开合时整体换一套横杠，见 §5.1） */
  navRail?: HTMLElement;
  /** Phase 25：两个上拉抽屉（分组为空时该成员 undefined；互斥切换用，见 `setDrawer`） */
  drawers?: { archived?: HTMLElement; cancelled?: HTMLElement };
}

const renderSessions = new Map<string, RenderSession>();

/**
 * Phase 25 口径 2b：overview（小工具栏 + 计时 / 大标题）是否展开 —— 键 = `file.path`。
 *
 * 默认**收起**（不在集合里）：首屏第一行是工具行，其下直接是进行中泳道 ——
 * 进行中工作流才是主视图，总览是按需展开的辅助区。
 * 纯视图状态，不落盘（与 `reorderEnabled` / `collapseState` 同口径，关看板即丢）。
 */
const overviewOpen = new Set<string>();

/**
 * Phase 29：顶部 `.wf-overview`（计时 / 大标题那块）是否**收起** —— 键 = `file.path`。
 *
 * 默认**展开**（不在集合里）：Phase 25~28 一直是常开（`renderOverview` 硬编码 `is-open`），
 * 本轮只是把「常开」换成「可被面板里的总览开关藏起来」，默认行为不变。
 * 纯视图状态，不落盘（与 `overviewOpen` 同口径，关看板即丢）。
 */
const overviewCollapsed = new Set<string>();

/**
 * Phase 33：「未分类」框（`.wf-board-frame--unclassified`）是否被面板开关藏起来 —— 键 = `file.path`。
 *
 * 默认**显示**（不在集合里）：未分类是「第一次用」的落脚点，不能默认藏。
 * 纯视图状态，不落盘（与 `overviewCollapsed` 同口径，关看板即丢）。
 */
const unclassifiedHidden = new Set<string>();

/**
 * Phase 36：归档看板（`<boardFolder>/archive/` 下的文件）上，「总览」与「未分类」默认**隐藏**。
 *
 * 归档看板只看浓缩后的泳道：计时 / 大标题用不上，「未分类」这一列也不该出现。
 * 但用户仍可在导航面板里把它们放出来 —— 这两张表记住「用户对这块显隐做过明确选择」的看板；
 * 没做过选择的归档看板才吃「默认隐藏」，非归档看板完全不受影响（默认值与 Phase 29 / 33 一致）。
 * 纯视图状态，不落盘（与 `overviewCollapsed` / `unclassifiedHidden` 同口径，关看板即丢）。
 */
const overviewExplicit = new Set<string>();
const unclassifiedExplicit = new Set<string>();

/** 这个路径是不是归档看板（`<boardFolder>/archive/` 下的文件）？ */
function isArchiveBoardPath(path: string): boolean {
  const normalized = path.replace(/\\/g, "/").replace(/^\/+/, "");
  return normalized.startsWith(`${archiveFolderOf()}/`);
}

/**
 * 顶部总览当前是否可见：归档看板默认**隐藏**，其它看板默认**显示**；
 * 用户动过开关（进过 `overviewExplicit`）就以 `overviewCollapsed` 为准。
 */
function isOverviewVisible(path: string): boolean {
  if (overviewExplicit.has(path)) return !overviewCollapsed.has(path);
  return !isArchiveBoardPath(path);
}

/** 未分类框当前是否可见：口径与 `isOverviewVisible` 完全一致（归档看板默认隐藏）。 */
function isUnclassifiedVisible(path: string): boolean {
  if (unclassifiedExplicit.has(path)) return !unclassifiedHidden.has(path);
  return !isArchiveBoardPath(path);
}

/**
 * Phase 33：框①（未分类那一框）的句柄。
 *
 * 开关在导航面板里、框在 `wf-block-body` 里 —— 两者不在同一棵 DOM 上，
 * 靠这张表按 `file.path` 找（同 `reorderHelpEls` 的解法）。
 * `beginRender` 会清掉它（旧的块元素已作废，下一次渲染会重新登记）。
 */
const unclassifiedFrameEls = new Map<string, HTMLElement>();

/**
 * Phase 29：「修改节点顺序」开关搬进导航面板后，块里那段拖拽说明（`.wf-reorder-help`）的句柄。
 *
 * 开关在面板里，说明块在泳道块里 —— 两者不在同一棵 DOM 上，靠这张表按 `file.path` 找。
 * `beginRender` 会清掉它（旧的块元素已作废，下一次渲染会重新登记）。
 */
const reorderHelpEls = new Map<string, HTMLElement>();

/**
 * overview 按钮的外部点击处理器（键 = 按钮元素）。
 * 用 `WeakMap` 存而不是往元素上挂 `any` 字段 —— 关面板时凭它精确移除 `document` 上的监听，
 * 元素被回收时也不会拖住处理器（避免 `no-unsafe-member-access` 一类的裸 `any` 访问）。
 */
const overviewOutsideClickHandlers = new WeakMap<HTMLElement, (event: MouseEvent) => void>();

/**
 * Phase 26 / Phase 28 / Phase 37 / Phase 38：用户在「导入」清单里填的 JSON 路径（键 = `file.path`）。
 *
 * 为什么要留：整块重渲染（写回 / 切主题 / 导入完成后的 repaint）会把弹窗 DOM 重建，
 * 输入框里的路径不落在这里就每次都清空 —— 而用户往往是「先导出抄路径，再拿同一路径导入」。
 * Phase 38 起导入只有**一个**清单（两个导入按钮共用它，只是落点不同），所以只存一段原文。
 */
const dataPaths = new Map<string, string>();

/** Phase 39：已归档弹窗的标签筛选（键 = file.path，值 = 已选标签） */
const archiveTagFilter = new Map<string, string[]>();

/**
 * Phase 25 口径 9：当前打开的抽屉 —— 键 = `file.path`，值 = 那个抽屉的 state。
 *
 * **只存一个值**就实现了互斥：开另一个 = `set()` 覆盖（等价于先关前一个）；
 * `delete()` = 两个都关。互斥不靠「同时写两个开合标记」，因此不存在两个都开 / 都忘关的中间态。
 * 不落盘（会话内存）。
 */
const openDrawer = new Map<string, WorkflowState>();

/** `aria-controls` 用的 id 序号（每次渲染换一个也没关系，它只给读屏用） */
let overviewSeq = 0;

/**
 * D 案（`phase23_bound.md` §4）：**写盘前**抢下的滚动位置（键 = `file.path`）。
 *
 * A 案（`pendingAnalysis`）/ C 案（`LaneReuse`）都只在**一次** `paint` 内把位置从旧 DOM 搬到新 DOM，
 * 靠的是「`container.empty()` → 重建之间没有 await」。但写回后 Dataview 会自己
 * `dv.container.innerHTML = ""`，这一步**先于**我们的 `paint` 把 DOM 抹掉 ——
 * 那时候 `captureScroll` / `captureLaneScroll` 只能读到 0（跳顶 + 泳道吸底的根本原因）。
 * 所以在写盘之前（DOM 还在）用 `rememberViewScroll` 存一份，下次 `paint` 发现容器已被清空就用它兜底。
 */
interface ViewScrollState {
  hostTop: number;
  windowY: number;
  lanes: Map<string, number>;
  /** Phase 34 修补：分栏横向滚动位置（`NavContext → scrollLeft`；active 看板 + 两个抽屉） */
  columns: Map<NavContext, number>;
}

const viewScrollStates = new Map<string, ViewScrollState>();

/** 每个文件最近一次的渲染容器（`rememberViewScroll` 写盘前从这里抓位置） */
const lastContainers = new Map<string, HTMLElement>();

/**
 * 计时聚合缓存（每个文件一份）：右键菜单据此决定显示「开始」还是「结束」，
 * 与 `renderSessions` 一样按 `file.path` 分桶，整块重渲染 / 局部刷新后都会被刷新。
 */
const timeAggregates = new Map<string, TimeAggregate>();

/**
 * A 案：**整块重渲染**要用的「刚写回后的分析」（键 = `file.path`）。
 *
 * 局部刷新（`refreshNodes`）直接从写回结果的 `analysis` 里拿；但拖拽改顺序 / 改工作流结构
 * 必须整块重渲染（`refresh()`），而 `refresh` 是个无参闭包，没法顺手把分析带过去。
 * 于是写回方先把这份分析放这里，紧接着的 `paint` 取走（取走即删）——
 * 省掉「写回完再读一遍盘 + 再全量校验一遍」，写回后的体感延迟随之消失。
 * 表里没有（打开笔记 / Dataview 重跑 / 切主题）就照旧 `analyzeFile`。
 */
const pendingAnalysis = new Map<string, AnalyzeResult>();

/** 记住「刚写回后的分析」，供紧接着的整块重渲染复用（`analysis` 缺省时什么都不做） */
function rememberFreshAnalysis(file: TFile, analysis: AnalyzeResult | undefined): void {
  if (analysis === undefined) return;
  pendingAnalysis.set(file.path, analysis);
}

/**
 * Phase 27 M3：某节点的资料文件（**同步**查插件的全库反向索引）。
 *
 * 数据源换成「资料文件自己 frontmatter 上的四个 `wf-*` 键」（契约 §5.1）：
 * 视图不再缓存任何东西，也不再读正文纪要段 —— 索引由插件层按 `metadataCache` 事件置脏 / 重建。
 * `workflow === undefined`（防御：不该发生）时只用 `nodeId` 查。
 */
function linksForNode(host: WfViewHost, node: WfNode, workflow?: WfWorkflow): LinkedFile[] {
  return host.linkedFiles(nodeRefFor(workflow, node));
}

/**
 * 挂到 `document.body` 的浮层用哪套配色（Phase 24 起**按文件取**）。
 *
 * 取「这篇笔记的看板」这一帧的主题（`renderSessions` 里记的那份）：主看板 + 归档看板同时开着、
 * 主题又不同时，菜单 / tooltip 不会串成「最后画的那个」配色。会话还没建立（极端时序）按素净基线处理。
 */
function overlayTheme(file: TFile): string {
  return renderSessions.get(file.path)?.theme ?? "";
}

/**
 * 给挂到 `document.body` 的浮层套上指定主题（变量作用域在 `.wf-theme[data-wf-theme]`）。
 *
 * Phase 46：主题重新 **始终** 非空（解析不到就是 `default`，见 `resolveViewTheme`），
 * 所以这里正常只剩「挂属性」一条路。空串只在极端时序（会话还没建立）出现 ——
 * 属性为空串既命中不到任何主题块，又会让「只要带属性就生效」的规则误判，所以直接移除。
 */
function themeOverlay(element: HTMLElement, theme: string): void {
  element.classList.add("wf-theme");
  if (theme.length > 0) element.setAttribute("data-wf-theme", theme);
  else element.removeAttribute("data-wf-theme");
}

/** 每次整块重渲染开始：清注册表 / 会话 / 折叠状态 / 计时聚合，并停掉旧的正计时 tick */
function beginRender(path: string): void {
  nodeRegistry.delete(path);
  renderSessions.delete(path);
  collapseState.delete(path);
  timeAggregates.delete(path);
  // Phase 15：整块重渲染会让拖拽句柄作废 → 清掉「正在拖」的残留状态（开关本身保留，见 reorderEnabled）
  draggingNodeId = null;
  draggingKeepSubtree = false;
  // Phase 29：块元素即将作废 → 那段拖拽说明的句柄也一起清（下次渲染重新登记）
  reorderHelpEls.delete(path);
  // Phase 33：未分类框的句柄同理（旧块作废，下一次渲染重新登记）
  unclassifiedFrameEls.delete(path);
  // Phase 24：只停**这个文件**的 tick（另一个看板的计时继续走）
  stopTimerTicker(path);
  closeHeatTip();
}

/* ------------------------------------------------------------------ *
 * 正计时器（Phase 3 契约 §7.1）：tick 单例
 * ------------------------------------------------------------------ */

/**
 * tick 句柄（Phase 24 起按 `file.path` 分桶）。
 *
 * 为什么不再是一个单例：主看板 + 归档看板会**同时**开两个叶子，`renderTimer` 每帧都会
 * 「先停旧的、再建新的」—— 单例下后画的看板会把前一个的 interval 清掉，用户看到的是
 * 「另一个看板一打开，这个看板的时钟就停走」。
 *
 * 类型故意留 `unknown`：DOM 与 @types/node 各有一套 `setInterval` 签名，
 * 这里只做「存下 / 清掉」，不关心它是 number 还是 Timeout（清句柄时统一断言）。
 */
const timerHandles = new Map<string, unknown>();

/**
 * 停掉正计时 tick。
 *
 * - 传 `path`：只停**这篇笔记**的 tick（整块重渲染 / 关掉某个看板 leaf 时用）；
 * - 不传：全清（插件 `onUnload` 与单测收尾用）。
 *
 * 不传是「全清」而不是「什么都不做」：卸载插件时若漏掉某个文件的 interval，它会一直跑。
 */
export function stopTimerTicker(path?: string): void {
  if (path === undefined) {
    for (const handle of timerHandles.values()) {
      window.clearInterval(handle as Parameters<typeof clearInterval>[0]);
    }
    timerHandles.clear();
    return;
  }
  const handle = timerHandles.get(path);
  if (handle === undefined) return;
  window.clearInterval(handle as Parameters<typeof clearInterval>[0]);
  timerHandles.delete(path);
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

/**
 * 折叠 = 用户刚点过三角（乐观覆盖）> JSON 里写了 `collapsed: true`。
 * Phase 21 ⑤ 起折叠态落盘，覆盖表只负责「写回还没落地的这一小段时间」。
 */
function isCollapsed(path: string, node: WfNode): boolean {
  const overlay = collapseState.get(path)?.get(node.id);
  if (overlay !== undefined) return overlay;
  return node.collapsed === true;
}

/** 记下用户点三角的结果（true = 现在收起了；两个方向都记，覆盖 JSON 里的旧值） */
function setCollapsed(path: string, nodeId: string, collapsed: boolean): void {
  let map = collapseState.get(path);
  if (map === undefined) {
    map = new Map<string, boolean>();
    collapseState.set(path, map);
  }
  map.set(nodeId, collapsed);
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
  waiters: Array<(error: Error | null) => void>;
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

/**
 * 把抛出的任意值规范成 `Error`：任务里可能是 `throw "…"` 这类非 Error 值，
 * 而 `Promise` 只应该用 `Error` 拒绝（否则调用方拿不到栈，日志里也只剩一行文本）。
 * 非 Error 的其它值（数字 / 对象 / null）没有可读文案，统一用通用的「渲染失败」。
 */
function toRenderError(error: unknown): Error {
  if (error instanceof Error) return error;
  if (typeof error === "string" && error.length > 0) return new Error(error);
  return new Error(t("view.renderFailed"));
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
      let failure: Error | null = null;
      try {
        await task();
      } catch (error) {
        failure = toRenderError(error);
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
 * 每个视图容器上一次画的是哪篇笔记（Phase 24）。
 *
 * 用途只有一个：走「没有数据源」那一帧时，把**这个视图**上一帧的弹窗关掉。
 * 只按 `dv.currentFilePath` 关不够 —— 文件被删 / 改名后它已经变成新路径，旧弹窗就成了孤儿；
 * 按容器记一份最准，而且不会误关另一个看板的弹窗。
 */
const containerPaths = new WeakMap<HTMLElement, string>();

/**
 * 渲染入口（Phase 9）：笔记里写
 * `await app.plugins.plugins["workflow-watcher"].render(dv)`，
 * 也可传 `render(dv, { theme: "tech" })`（优先级：options.theme → frontmatter → 默认主题 `default`）。
 */
export async function renderWorkflowView(
  host: WfViewHost,
  dv: WfViewApi,
  options: WfViewOptions = {},
): Promise<void> {
  const container = dv.container;
  container.classList.add("wf-view", "wf-theme");
  // Phase 24：看板（ItemView）传 `strictFile` —— 绑定路径解析不到时**不**回退活动文件
  const file = resolveSelfFile(host, dv, options.strictFile === true);
  // D 案：记住容器，写盘前 `rememberViewScroll` 才有地方抓位置（Dataview 会先抹掉再重跑）
  if (file !== null) lastContainers.set(file.path, container);

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
      // 没有文件 = 没有数据源（渲染的是提示块）：把上一帧残留的主题属性摘掉，
      // 别让提示块继承到某个主题的底色 / 字体
      container.removeAttribute("data-wf-theme");
      container.createDiv({
        cls: "wf-hint",
        // Phase 24：看板的「绑定笔记没了」（strict）与 Dataview 的「没拿到路径」是两种处境
        text: t(options.strictFile === true ? "view.hint.noBoardFile" : "view.hint.noFile"),
      });
      // 没有文件就没有数据源：这个视图上一帧的弹窗留着也没意义（它的数据属于上一篇笔记）
      closeWidgetPopup(containerPaths.get(container) ?? dv.currentFilePath);
      containerPaths.delete(container);
      restoreScroll(container, scroll);
      return;
    }
    containerPaths.set(container, file.path);
    // A 案：写回后紧跟的那次整块重渲染带了「刚写回后的分析」→ 直接用它（取走即删）
    const pending = pendingAnalysis.get(file.path);
    if (pending !== undefined) pendingAnalysis.delete(file.path);
    const result = pending ?? (await host.analyzeFile(file));
    // Phase 9 v0.7 ①：主题跟随文件（容器级），不再改全局设置 / `<html>`
    const theme = resolveViewTheme(host, options, result);
    // D 案：这一帧是不是「打开笔记」那一帧？首帧才把泳道滚到底；
    // 之后的整块重渲染（写回 / 切主题 / Dataview 重跑）要保住用户看到的位置。
    const fresh = !renderSessions.has(file.path);
    if (fresh) viewScrollStates.delete(file.path);
    const remembered = fresh ? undefined : viewScrollStates.get(file.path);
    // Phase 22 / C 案：泳道正文是各自的纵向滚动区，和外层宿主分开抄 ——
    // 位置与元素一起留（复用的正文不必「先跳到底再拨回来」）。
    const liveBodies = captureLaneBodies(container);
    const liveLanes = captureLaneScroll(container);
    const liveOuter = captureScroll(container);
    const liveColumns = captureColumnsScroll(container);
    // 容器还活着（同一帧内重渲染）→ 直接抄活 DOM；
    // 已被别处清空（Dataview 写回 `innerHTML = ""`）→ 用写盘前 `rememberViewScroll` 抢下的快照
    const intact = liveBodies.size > 0;
    const laneTops = liveLanes.size > 0 ? liveLanes : remembered?.lanes ?? liveLanes;
    const outer: ScrollSnapshot =
      intact || remembered === undefined
        ? liveOuter
        : { top: remembered.hostTop, windowY: remembered.windowY };
    const laneReuse: LaneReuse = { bodies: liveBodies, tops: laneTops };
    const columnsLeft: Map<NavContext, number> =
      intact || remembered === undefined ? liveColumns : remembered.columns;
    beginRender(file.path);
    container.empty();
    // 主题跟随本帧看板（Phase 46：解析结果至少是 `default`，容器始终带属性）；
    // 空串只在宿主清单里没有 `default` 时出现 → 只挂 `.wf-theme` 类、不挂属性
    // （空串属性命中不到任何主题块，还会骗过 `.wf-theme[data-wf-theme]` 这种「带属性即生效」的规则）
    themeOverlay(container, theme);
    renderResult(host, container, file, result, () => void render(), theme, laneReuse, options.strictFile === true);
    restoreLaneScroll(container, laneTops);
    restoreColumnsScroll(container, columnsLeft);
    restoreScroll(container, outer);
    // 这一帧落定后的位置：下次写盘前若又抓不到（容器已空），用它兜底
    const settled = readViewScroll(container);
    if (settled !== undefined) viewScrollStates.set(file.path, settled);
  };

  /** 同一文件先入队（串行），再等它落地 —— 插件 refresh 与 Dataview 重跑不会互相踩 */
  const render = (): Promise<void> => (file === null ? paint() : enqueueRender(file.path, paint));

  await render();
}

/**
 * 主题 key 是否在宿主清单里（非法值一律忽略，继续往下回落）
 */
function isKnownTheme(host: WfViewHost, key: string | undefined): key is string {
  return typeof key === "string" && key.length > 0 && host.themes.some((theme) => theme.key === key);
}

/**
 * 默认主题 key（Phase 46 恢复，与 `main.ts` 的 `DEFAULT_THEME_KEY` 同一个字面量）。
 *
 * Phase 44 曾把「解析不到主题」当成素净基线（不挂 `data-wf-theme`）；Phase 46 回滚：
 * `template.ts` 建新看板写的还是 `wf-theme: default`，删掉这个 key 让新看板全都成了
 * 「不挂属性」的素净基线 —— 用户按 `[data-wf-theme="default"]` 写的自定义样式
 * （`--wf-polka-size` 之类）一律命中不到。恢复后看板**始终**带属性。
 */
const DEFAULT_THEME_KEY = "default";

/**
 * 解析本视图主题：render options → 文件 frontmatter `wf-theme` → 默认主题。
 *
 * 宿主清单里没有 `default`（测试替身 / 旧宿主）时仍回落空串 = 素净基线（不挂属性），
 * 免得给不认识这个 key 的宿主挂上一个谁都匹配不到的属性。
 */
function resolveViewTheme(host: WfViewHost, options: WfViewOptions, result: AnalyzeResult): string {
  if (isKnownTheme(host, options.theme)) return options.theme;
  const stored = result.frontmatter.getString(FRONTMATTER_FIELDS.theme);
  if (isKnownTheme(host, stored)) return stored;
  return isKnownTheme(host, DEFAULT_THEME_KEY) ? DEFAULT_THEME_KEY : "";
}

/* ------------------------------------------------------------------ *
 * 滚动位置保存 / 恢复（Phase 9 v0.7 ⑦：整块重渲染不跳回顶部）
 * ------------------------------------------------------------------ */

interface ScrollSnapshot {
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
  return { top: typeof host.scrollTop === "number" ? host.scrollTop : 0, windowY };
}

/**
 * 同步恢复一次 + 之后连续两帧各补一次。
 *
 * 只补一帧时，若字体 / 图片在重建后才把内容撑高，浏览器可能把设置过的
 * `scrollTop` 又调回去；第二帧（布局稳定后）再钉一次最稳。
 * DOM 桩没有 `requestAnimationFrame` → 只做同步那次（单测因此是确定的）。
 */
function restoreScroll(container: HTMLElement, snapshot: ScrollSnapshot): void {
  const apply = (): void => {
    // 宿主每次重新解析：容器被清空后 `scrollHeight` 会塌成 0，缓存里的宿主才是同一个元素
    const host = scrollHostOf(container);
    if (snapshot.top > 0) host.scrollTop = snapshot.top;
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

/**
 * 泳道正文的元素选择器 / 认领属性（Phase 22）。
 *
 * 每条泳道的正文（`.wf-lane-body`）是**自己的纵向滚动区**（Phase 17），
 * 与上面「外层滚动宿主」是两套位置，要分开抄；Phase 23 C 案起元素本身也会被复用
 * （见 `LaneReuse` / `captureLaneBodies`）。
 */
const LANE_BODY_SELECTOR = ".wf-lane-body";
const LANE_WORKFLOW_ATTR = "data-workflow-id";

/** 容器里的全部泳道正文（`querySelectorAll` 是标准 DOM 方法，桩里同构实现） */
function laneBodies(container: HTMLElement): HTMLElement[] {
  const found = container.querySelectorAll(LANE_BODY_SELECTOR) as unknown as ArrayLike<HTMLElement> | null;
  return found === null || found === undefined ? [] : Array.from(found);
}

/**
 * C 案：整块重渲染前的泳道快照 —— 除了滚动位置，把**元素本身**也留住。
 *
 * 为什么连元素一起复用（而不是「清空容器 → 重建 → 再按 `data-workflow-id` 找回来」）：
 * `container.empty()` 会把 `.wf-lane-body` 一起摘掉，它的 `scrollHeight` 当场塌成 0，
 * 浏览器随即把 `scrollTop` 夹成 0（真实宿主上就是「写回后先跳一下顶、再被 rAF 拨回来」）。
 * 元素本身还活着（只是游离），把它**原地挂回**新的泳道里复用，滚动宿主一路不换 →
 * 没有「夹成 0 再拨回」的中间态，也就不必再补第二帧。
 */
interface LaneReuse {
  /** 上一帧的泳道正文（键 = workflow.id；此时已 detach，但对象还活着） */
  bodies: Map<string, HTMLElement>;
  /** 上一帧各泳道的 `scrollTop`（用户看到的位置） */
  tops: Map<string, number>;
}

/**
 * 抄一遍上一帧的泳道正文元素（`workflow.id → 元素`）。
 *
 * 调用点同样在 `container.empty()` **之前**，且「清空 → 重建」之间没有 await：
 * 这些元素从 detach 到重新挂回是同一个同步片段，浏览器没机会插进来做布局。
 */
function captureLaneBodies(container: HTMLElement): Map<string, HTMLElement> {
  const snapshot = new Map<string, HTMLElement>();
  for (const body of laneBodies(container)) {
    const workflowId = body.getAttribute(LANE_WORKFLOW_ATTR);
    if (typeof workflowId !== "string" || workflowId.length === 0) continue;
    snapshot.set(workflowId, body);
  }
  return snapshot;
}

/**
 * 抄一遍泳道正文的滚动位置：`workflow.id → scrollTop`（Phase 22 修「重渲染跳到底」）。
 *
 * 为什么要抄（而不是像外层宿主那样靠缓存）：打开笔记时泳道正文要**滚到底**
 * （最新进度在最下面），但改 note / 改节点顺序 / 切主题 / Dataview 重跑引起的整块重渲染
 * 会把正文里的树整个换掉，`renderLane` 若按「新泳道」处理就会滚到底 —— 用户刚滚到的位置丢一次。
 * 调用点在 `container.empty()` **之前**：这时候 DOM 还是上一帧的，读到的就是用户看到的位置。
 * 抄不到（首帧打开、新出现的泳道）就留空，`renderLane` 的「滚到底」照旧生效。
 */
function captureLaneScroll(container: HTMLElement): Map<string, number> {
  const snapshot = new Map<string, number>();
  for (const body of laneBodies(container)) {
    const workflowId = body.getAttribute(LANE_WORKFLOW_ATTR);
    if (typeof workflowId !== "string" || workflowId.length === 0) continue;
    snapshot.set(workflowId, typeof body.scrollTop === "number" ? body.scrollTop : 0);
  }
  return snapshot;
}

/**
 * 把抄下来的泳道位置钉回去（同步一次 + 一帧后再钉一次）。
 *
 * 为什么还要补这一帧：正文是复用的（C 案），同步那次已经把位置放好了；
 * 但重建后字体 / 图片可能把内容撑高，浏览器仍有机会再去挪 `scrollTop` ——
 * 布局稳定后补一帧最稳（DOM 桩没有 `requestAnimationFrame` → 只做同步那次，单测因此是确定的）。
 *
 * 快照里**没有**的泳道一律不碰：它是新出现的流，已由 `renderLane` 滚到底。
 */
function restoreLaneScroll(container: HTMLElement, snapshot: Map<string, number>): void {
  if (snapshot.size === 0) return;
  const apply = (): void => {
    for (const body of laneBodies(container)) {
      const workflowId = body.getAttribute(LANE_WORKFLOW_ATTR);
      if (typeof workflowId !== "string") continue;
      const top = snapshot.get(workflowId);
      if (top !== undefined) body.scrollTop = top;
    }
  };
  apply();
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") return;
  window.requestAnimationFrame(apply);
}

/* ---- Phase 34 修补：分栏横向滚动位置（.wf-active-scroll / .wf-drawer-columns） ---- */

/** 三种分栏上下文（进行中看板 + 已完成 / 已取消两个抽屉） */
const COLUMNS_CONTEXTS: readonly NavContext[] = ["active", "archived", "cancelled"];

/** 某上下文的分栏横滚容器（active 看板是 `.wf-active-scroll`，抽屉是 `.wf-drawer-columns`） */
function columnsScrollerOf(container: HTMLElement, context: NavContext): HTMLElement | undefined {
  if (context === "active") {
    const outer = container.querySelectorAll<HTMLElement>(".wf-active-columns")[0];
    return outer?.querySelector<HTMLElement>(".wf-active-scroll") ?? outer;
  }
  const drawer = container.querySelectorAll<HTMLElement>(".wf-drawer-" + context)[0];
  return drawer?.querySelector<HTMLElement>(".wf-drawer-columns") ?? undefined;
}

/** 抄一遍「进行中 + 两个抽屉」的横向滚动位置（`NavContext → scrollLeft`） */
function captureColumnsScroll(container: HTMLElement): Map<NavContext, number> {
  const snapshot = new Map<NavContext, number>();
  for (const context of COLUMNS_CONTEXTS) {
    const scroller = columnsScrollerOf(container, context);
    if (scroller === undefined) continue;
    if (typeof scroller.scrollLeft === "number") snapshot.set(context, scroller.scrollLeft);
  }
  return snapshot;
}

/**
 * 把分栏横向位置钉回去（同步一次 + 一帧后再钉一次，与泳道纵向同一范式）。
 * 分栏宽度由内容决定，重建后布局稳定前浏览器仍可能把 `scrollLeft` 夹回去，所以补一帧。
 */
function restoreColumnsScroll(container: HTMLElement, snapshot: Map<NavContext, number>): void {
  if (snapshot.size === 0) return;
  const apply = (): void => {
    for (const [context, left] of snapshot) {
      const scroller = columnsScrollerOf(container, context);
      if (scroller !== undefined) scroller.scrollLeft = left;
    }
  };
  apply();
  if (typeof window === "undefined" || typeof window.requestAnimationFrame !== "function") return;
  window.requestAnimationFrame(apply);
}

/** 抓一次「容器还活着时」的完整滚动位置（外层 + 泳道）；容器已空则返回 undefined */
function readViewScroll(container: HTMLElement): ViewScrollState | undefined {
  if (container.children.length === 0) return undefined;
  const outer = captureScroll(container);
  return { hostTop: outer.top, windowY: outer.windowY, lanes: captureLaneScroll(container), columns: captureColumnsScroll(container) };
}

/**
 * D 案：写盘**之前**调用（容器还在、读到的就是用户看到的位置）。
 *
 * 插件在 `mutateFile` / `setFileTheme` 里先调它，紧接着的 `paint` 用这份快照兜底 ——
 * 这样无论 Dataview 是在我们清空前还是清空后重跑，位置都不会丢。
 */
export function rememberViewScroll(file: TFile): void {
  const container = lastContainers.get(file.path);
  if (container === undefined) return;
  const state = readViewScroll(container);
  if (state !== undefined) viewScrollStates.set(file.path, state);
}

/**
 * 测试 / 卸载收尾：忘掉某个文件的滚动状态与会话。
 * 清掉会话等于让它回到「打开笔记那一帧」的语义（泳道滚到底）。
 *
 * Phase 25：overview 开合 / 抽屉上下文也是**会话内存**，一并清掉
 * （单测的 `afterEach` 正是靠这一句做用例间隔离）。
 * Phase 26：导入 / 导出面板的展开态与用户填的两个路径同理（关掉看板就该忘掉）。
 */
export function forgetViewScroll(path: string): void {
  viewScrollStates.delete(path);
  lastContainers.delete(path);
  renderSessions.delete(path);
  overviewOpen.delete(path);
  // Phase 31：顶部总览的显隐也是会话内存（开始任务会自动展开它）→ 收尾一起忘掉
  overviewCollapsed.delete(path);
  // Phase 33：未分类框的显隐同理（默认显示，用户藏过的那一份不跨看板）
  unclassifiedHidden.delete(path);
  // Phase 36：归档看板的「默认隐藏」与用户明确选择也一起忘掉
  overviewExplicit.delete(path);
  unclassifiedExplicit.delete(path);
  openDrawer.delete(path);
  dataPaths.delete(path);
}

/**
 * 当前笔记：Dataview 的 `currentFilePath` 优先，回退到活动文件。
 *
 * `strict = true`（Phase 24 的看板）：**不**回退 —— 绑定路径解析不到就返回 `null`，
 * 由 `paint` 走「没有文件」提示。否则笔记被删 / 改名后，看板会悄悄换成活动文件的工作流。
 */
function resolveSelfFile(host: WfViewHost, dv: WfViewApi, strict = false): TFile | null {
  const path = dv.currentFilePath;
  if (path !== undefined && path.length > 0) {
    const found = host.app.vault.getAbstractFileByPath(path);
    // 鸭子判断而不是 instanceof：视图不引入 obsidian 的运行时依赖（便于 node --test）
    if (isBoardFile(found)) return found;
  }
  if (strict) return null;
  const active = host.app.workspace.getActiveFile();
  return active !== null && isBoardFile(active) ? active : null;
}

/**
 * 看板标签页的标题（Phase 24）：vault 路径 → 笔记名。
 *
 * `getDisplayText()` 会被标签页 / 状态栏 / 拖拽浮层反复调用，所以这里只做字符串处理、
 * 不碰 vault（也就不会因为文件被删而抛错）。空路径 / 只剩扩展名 → 兜底文案。
 * Phase 28：归档看板是 `.wf.json`，去掉扩展后只剩 `<workflowId>-<nodeId>`（机器名）。
 */
export function boardTitleOf(path: string): string {
  const name = path.split("/").pop() ?? "";
  return name.replace(/\.wf\.json$/i, "").replace(/\.md$/i, "") || t("view.board.title");
}

/**
 * 是否看板文件（只用到 extension / path，避免依赖 Obsidian 的类实例）：
 *  - 普通笔记：`.md`；
 *  - 归档看板：`*.wf.json`（Phase 28 起归档只产 JSON，不再有 md 伴生）。
 */
function isBoardFile(file: unknown): file is TFile {
  if (typeof file !== "object" || file === null) return false;
  const extension = (file as { extension?: unknown }).extension;
  if (extension === "md") return true;
  const path = (file as { path?: unknown }).path;
  return typeof path === "string" && path.toLowerCase().endsWith(".wf.json");
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
  /**
   * Phase 24：这一帧的主题。弹窗遮罩 / 热力图与甘特图的 tooltip 都挂在 `document.body` 上，
   * 主题必须由**这个看板**显式带过去（两个看板并存时不能读「最后画的那个」全局变量）。
   */
  theme: string;
}

interface WidgetEntry {
  /** 稳定的内部标识（调试 / 断言 / tab 定位用） */
  id: string;
  /** 名称的 i18n key */
  labelKey: string;
  /** 名称（缺省 = `labelKey` 的文案；「已归档」要带计数） */
  title?(ctx: WidgetContext): string;
  /** 画弹窗内容；缺省 = 占位文案（还没实现的小工具） */
  render?(body: HTMLElement, ctx: WidgetContext): void;
  /** 不走弹窗、直接调宿主 */
  action?: "openSettings";
}

/**
 * 小工具清单（顺序固定：21 天甘特图 → 四象限 → 已归档 → 导入/导出 → 开始/完成记录 → 365 天曲线 → schema警告 → 设置）。
 *
 * Phase 29：不再有图标侧边栏 —— 前 7 个渲染成导航面板「统计」列的文字按钮（点开弹窗），
 * 最后一个（`openSettings`）挪到「修改」列，直接打开插件设置页。
 */
const WIDGETS: readonly WidgetEntry[] = [
  {
    id: "gantt21",
    labelKey: "view.widget.gantt21",
    render: (body, ctx) => {
      const wrapper2 = body.createDiv({ cls: "wf-widget-gantt21-mid-wrapper" });
      const column = wrapper2.createDiv({ cls: "wf-widget-gantt21-column" });
      // Phase 28：21 天窗口的结束日可改 —— 默认今天；归档看板默认归档日（回看才看得到当时那 21 天）
      const controls = column.createDiv({ cls: "wf-gantt-anchor" });
      controls.createEl("label", { cls: "wf-gantt-anchor-label", text: t("view.gantt.anchorDate") });
      const anchorInput = controls.createEl("input", {
        cls: "wf-gantt-anchor-input",
        type: "date",
        title: t("view.gantt.anchorHint"),
      });
      const wrapper = column.createDiv({ cls: "wf-widget-gantt21-wrapper" });
      const draw = (): void => {
        wrapper.empty();
        const anchor = anchorDateOf(ganttAnchorKey(ctx)) ?? new Date();
        renderHeatmap(wrapper, ctx.time, anchor, ctx.theme);
        // Phase 17：甘特图常开（不再需要 file —— 折叠态会话内存已撤掉）
        renderGantt(wrapper, ctx.time, anchor, ctx.theme);
      };
      anchorInput.value = ganttAnchorKey(ctx);
      anchorInput.onchange = (): void => {
        const value = anchorInput.value.trim();
        // 清空 = 回到默认（今天 / 归档日）
        if (value.length === 0) ganttAnchors.delete(ctx.file.path);
        else ganttAnchors.set(ctx.file.path, value);
        anchorInput.value = ganttAnchorKey(ctx);
        draw();
      };
      draw();
    },
  },
  {
    id: "quadrant",
    labelKey: "view.widget.quadrant",
    // Phase 19 M2：只读 wfjson（16 分区 + 右侧预览），不改任何数据
    render: (body, ctx) => {
      const wrapper = body.createDiv({ cls: "wf-widget-quadrant-wrapper" });
      renderQuadrant(wrapper, ctx.wfDoc, ctx.now);
    },
  },
  {
    id: "archive",
    labelKey: "view.block.archived",
    title: (ctx) => t("view.block.archived", { count: ctx.host.archiveBoardFiles().length }),
    render: (body, ctx) => {
      const wrapper = body.createDiv({ cls: "wf-widget-archive-wrapper" });
      renderArchiveWidget(wrapper, ctx.host, ctx.file, ctx.wfDoc, ctx.refresh);}
  },
  {
    id: "data",
    labelKey: "view.widget.data",
    // Phase 28：导入 / 导出数据（原来在看板工具行的折叠面板，现在收进小工具弹窗）
    render: (body, ctx) => {
      const wrapper = body.createDiv({ cls: "wf-widget-importdata-wrapper" });
      renderDataWidget(wrapper, ctx.host, ctx.file, ctx.refresh);}
  },
  {
    id: "records",
    labelKey: "view.widget.records",
    // Phase 28：开始 / 完成记录（双列倒序时间线，只读 wfjson）
    render: (body, ctx) => {
      const wrapper = body.createDiv({ cls: "wf-widget-records-wrapper" });
      renderRecordsWidget(wrapper, ctx.host, ctx.wfDoc);}
  },
  {
    id: "plot365",
    labelKey: "view.widget.plot365",
    // Phase 19 M3：plot 是独立 JSON（`plotFolder/plot-<uuid>.json`），与 wfjson 无关
    render: (body, ctx) => {
      const wrapper = body.createDiv({ cls: "wf-widget-plot365-wrapper" });
      renderPlot(wrapper, ctx.host, ctx.refresh);}
  },
  {
    id: "schemaWarn",
    labelKey: "view.widget.schemaWarn",
    // Phase 40：只列「多出来、不在 wfjson 设计内」的字段 —— 它们已降为 warning，不阻断渲染
    render: (body, ctx) => {
      renderSchemaWarningsWidget(body, ctx.result);
    },
  },
  { id: "settings", labelKey: "view.widget.settings", action: "openSettings" },
];

/** Phase 30：弹窗里能当 tab 的小工具（`settings` 走宿主，不进弹窗） */
const POPUP_WIDGETS: readonly WidgetEntry[] = WIDGETS.filter(
  (widget) => widget.action !== "openSettings",
);

/** Phase 30：按 id 取小工具（未知 id 回落第一项，弹窗不空） */
function widgetById(id: string): WidgetEntry {
  return POPUP_WIDGETS.find((widget) => widget.id === id) ?? POPUP_WIDGETS[0];
}

/** 按钮名称 / 弹窗标题共用（「已归档（n）」这类要带数据的走 `widget.title`） */
function widgetLabel(widget: WidgetEntry, ctx: WidgetContext): string {
  return widget.title?.(ctx) ?? t(widget.labelKey);
}

/**
 * 一个打开的弹窗（Phase 24 起**每个文件一个**）。
 *
 * 为什么不再单例：主看板 + 归档看板会同时开着，单槽下「在归档看板里点开小工具」会把主看板
 * 已经开着的弹窗关掉。现在按 `file.path` 分桶：各开各关，`refreshOpenWidget` 只动自己那条。
 * 「同一文件同一时刻只有一个弹窗」的语义不变（点谁显示谁，不叠层）。
 */
interface WidgetPopupState {
  /** Phase 18 ①：全屏遮罩（弹窗的父元素；`closeWidgetPopup()` 删它就整块清掉） */
  overlay: HTMLElement;
  element: HTMLElement;
  title: HTMLElement;
  /** Phase 30：顶部 tab 行（`.wf-widget-tabs`） */
  tabs: HTMLElement;
  /** Phase 30：tab id → 按钮（切 tab 时改高亮 + 文案） */
  tabButtons: Map<string, HTMLButtonElement>;
  body: HTMLElement;
  /** Phase 30：当前 tab 的小工具 id（Phase 29 及以前是单个 `widget`） */
  activeId: string;
  /** 弹窗属于哪个文件（别的文件重渲染时不跟着变） */
  filePath: string;
  /** 这一帧的主题（遮罩上挂 `data-wf-theme`；两个看板主题不同时各显各的） */
  theme: string;
}

/** 打开的弹窗：`file.path → 弹窗`（Phase 24 分桶，见 `WidgetPopupState` 的注释） */
const widgetPopups = new Map<string, WidgetPopupState>();

/**
 * 开一个弹窗（**同一文件**已开着就切 tab —— 点谁显示谁，不叠层）。
 *
 * Phase 30：7 个统计小工具共用一个 tabbed 弹窗（`.wf-widget-popup--tabs`），
 * `initialId` 决定打开时停在哪一页；切 tab 走 `selectWidgetTab`，尺寸不变。
 *
 * Phase 18 ①：根元素从 `.wf-widget-popup` 换成 `.wf-widget-overlay`（全屏半透明遮罩），
 * 弹窗作它的子元素。遮罩是 `position: fixed; inset: 0`，下层点击本来就被它挡住；
 * **点遮罩不关闭**（Phase 16 的关闭语义不变：只有「×」能关）。
 */
function openWidgetsPopup(ctx: WidgetContext, initialId: string): void {
  const existing = widgetPopups.get(ctx.file.path);
  if (existing !== undefined) {
    // 同一文件已开着：切 tab 而不是关掉重开（弹窗大小 / 位置保持不变）
    selectWidgetTab(existing, ctx, initialId);
    return;
  }
  const overlay = document.body.createDiv({ cls: "wf-widget-overlay" });
  const element = overlay.createDiv({ cls: "wf-widget-popup wf-widget-popup--tabs" });
  const head = element.createDiv({ cls: "wf-widget-popup-head" });
  const title = head.createDiv({ cls: "wf-widget-popup-title" });
  const close = head.createEl("button", { cls: "wf-widget-popup-close", text: "×" });
  close.title = t("view.widget.close");
  close.setAttribute("aria-label", t("view.widget.close"));
  close.onclick = () => closeWidgetPopup(ctx.file.path);
  const tabs = element.createDiv({ cls: "wf-widget-tabs" });
  const body = element.createDiv({ cls: "wf-widget-popup-body" });
  const state: WidgetPopupState = {
    overlay,
    element,
    title,
    tabs,
    tabButtons: new Map(),
    body,
    activeId: widgetById(initialId).id,
    filePath: ctx.file.path,
    theme: ctx.theme,
  };
  for (const widget of POPUP_WIDGETS) {
    const button = tabs.createEl("button", { cls: "wf-widget-tab" });
    state.tabButtons.set(widget.id, button);
  }
  widgetPopups.set(ctx.file.path, state);
  fillWidgetTab(state, ctx);
  // Phase 41：「已归档」页一打开就重扫 archive_tag.yaml（标签筛选用最新枚举）
  if (state.activeId === "archive") rescanArchiveTags(state, ctx);
}

/** Phase 30：切 tab（记住新 id → 重画；遮罩与弹窗尺寸都不动） */
function selectWidgetTab(state: WidgetPopupState, ctx: WidgetContext, id: string): void {
  state.activeId = widgetById(id).id;
  fillWidgetTab(state, ctx);
  // Phase 41：切进「已归档」页 = 又一次「打开」，同样现读标签枚举
  if (state.activeId === "archive") rescanArchiveTags(state, ctx);
}

/**
 * Phase 41：重扫归档标签枚举（视图只发请求，读盘 / 解析全在宿主 `refreshArchiveTags`）。
 *
 * 回来时先确认「弹窗还是这一张、用户还停在这一页」，再整块重画当前 tab ——
 * 顶部标签筛选与列表里的标签都换成磁盘上最新的那一份。
 */
function rescanArchiveTags(state: WidgetPopupState, ctx: WidgetContext): void {
  void ctx.host.refreshArchiveTags().then(
    () => {
      if (widgetPopups.get(state.filePath) !== state) return;
      if (state.activeId !== "archive") return;
      fillWidgetTab(state, ctx);
    },
    () => undefined,
  );
}

/**
 * 关弹窗。不传 `path` = **全清**（插件 `onLoad` 的卸载路径 / 没有绑定文件时的兜底）；
 * 传 `path` = 只关这篇笔记的弹窗（「×」与关掉某个看板 leaf 时用）。
 *
 * `main.ts` 的 `onunload` 也调一次 —— 弹窗挂在 `document.body` 上，不清掉会留在别的视图上。
 */
export function closeWidgetPopup(path?: string): void {
  // Phase 39：归档元数据缓存只在「一次弹窗会话」内有效，关窗就丢（下次打开重新懒加载）
  archiveMetaCache.clear();
  archiveMetaSession += 1;
  if (path === undefined) {
    for (const state of widgetPopups.values()) state.overlay.remove();
    widgetPopups.clear();
  } else {
    const state = widgetPopups.get(path);
    if (state !== undefined) {
      state.overlay.remove();
      widgetPopups.delete(path);
    }
  }
}

/** 重画当前 tab（首帧 / 切 tab / 数据变了都走这里）：标题 + tab 高亮 → 主题 → 内容 */
function fillWidgetTab(state: WidgetPopupState, ctx: WidgetContext): void {
  const widget = widgetById(state.activeId);
  // 标题 + 各 tab 文案（「已归档（n）」计数跟数据走）
  state.title.setText(widgetLabel(widget, ctx));
  for (const [id, button] of state.tabButtons) {
    button.setText(widgetLabel(widgetById(id), ctx));
    button.classList.toggle("is-active", id === state.activeId);
    button.setAttribute("aria-selected", id === state.activeId ? "true" : "false");
    // 每次重画都重挂一次：切 tab 用**最近一帧**的 ctx（数据刷新后闭包不会变旧）
    button.onclick = () => selectWidgetTab(state, ctx, id);
  }
  // 主题可能刚被切过（切主题 = 整块重渲染）→ 浮层也跟着换配色
  state.theme = ctx.theme;
  themeOverlay(state.overlay, state.theme);
  // Phase 30：换一块新 body —— 上一块可能还有异步渲染（plot 读盘）没回来，
  // 写到游离节点上无害（复用同一块则会串到新 tab 上）
  state.body.remove();
  state.body = state.element.createDiv({ cls: "wf-widget-popup-body" });
  if (widget.render === undefined) {
    state.body.createDiv({ cls: "wf-widget-placeholder", text: t("view.widget.placeholder") });
    return;
  }
  widget.render(state.body, ctx);
}

/**
 * 数据变了：开着的弹窗跟着重画（整块重渲染末尾 / 局部刷新末尾都会调）。
 * 只动**本篇笔记**那条 —— 别的笔记（另一个看板）开着的弹窗不跟着变。
 */
function refreshOpenWidget(ctx: WidgetContext): void {
  const state = widgetPopups.get(ctx.file.path);
  if (state === undefined) return;
  fillWidgetTab(state, ctx);
}

/** 一次渲染（容器由调用方清空）：坏数据只摊问题、不渲染树 */
function renderResult(
  host: WfViewHost,
  container: HTMLElement,
  file: TFile,
  result: AnalyzeResult,
  refresh: () => void,
  theme: string,
  laneReuse?: LaneReuse,
  boardMode = false,
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

  // 会话：概览 / 页脚 / 泳道头的句柄留给局部刷新用（写回后不必整块重渲染）
  const lanes: LaneIndex = { heads: new Map(), layout: new Map(), colors: new Map() };
  // Phase 16：侧边栏 / 弹窗共用这一份上下文；局部刷新时就地换字段（闭包因此不用重挂）
  // Phase 25：ctx 提到 overview 之前 —— 小工具栏现在挂在 overview 里（口径 2c）
  const ctx: WidgetContext = { host, file, wfDoc, time, result, now, refresh, theme };
  // ① 可折叠总览（默认收起）：上侧小工具栏，下侧计时 / 大标题 / 继续上次
  const overview = renderOverview(container, ctx);
  // ② 顶部工具行（永远可见）：左下拉开关，右主题切换
  //     Phase 26：看板模式下工具行里多一个「导入/导出数据」开关，它的面板在工具行**之后**
  //const boardTop = renderBoardTop(container, host, file, refresh, theme,  file.path);
  // ③ 主体（主视图 = 进行中工作流）：块内左→右 = 未分类 / 进行中工作流 / 导航栏
  //    Phase 33：导航栏从 `.wf-main` 的直子搬进「进行中」块（框② 最右），由 renderActiveBlock 造并返回
  const main = container.createDiv({ cls: "wf-main" });
  const body = main.createDiv({ cls: "wf-main-body" });
  const navRail = renderActiveBlock(host, body, summary, file, wfDoc, refresh, lanes, ctx, laneReuse);
  // ④⑤ 两个上拉抽屉（已完成流 / 已取消流）：分组为空时该抽屉整块不渲染（返回 undefined）
  /*const drawers = {
    archived: renderDrawer(host, container, file, wfDoc, "archived", refresh, lanes, laneReuse),
    cancelled: renderDrawer(host, container, file, wfDoc, "cancelled", refresh, lanes, laneReuse),
  };*/
  //const footer = renderFooter(container, result);
  // 页脚暂时不显示：内容仍由 `session.footer.setText(...)` 维护，显示与否交给 styles.css 的 .wf-footer-hidden
  const footer = container.createDiv({ cls: "wf-footer-hidden" });
  // 分栏是「全部进行中的 workflow 各一栏」，但分组快照必须覆盖全部 workflow：否则写回后 sameLayout 误判 → 无谓整块重渲染
  lanes.layout = layoutOf(wfDoc);
  renderSessions.set(file.path, {
    overview,
    footer,
    lanes,
    theme,
    ctx,
    navRail,
  });
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
 * 8 套主题的字体 / 字距 / 装饰全部在 styles.css 的 `[data-wf-theme="…"] .wf-app-title` 里，
 * 这里只挂 class。
 */
function renderAppTitle(container: HTMLElement, host: WfViewHost): HTMLElement {
  return container.createDiv({ cls: "wf-app-title", text: appTitleText(host) });
}

/**
 * ① 顶部总览（Phase 29：只放计时 / 大标题 / 继续上次；图标小工具栏已搬进导航面板）。
 *
 * 显隐由「修改」列的总览开关控制（`overviewCollapsed`，**默认展开**）。
 * Phase 36：归档看板上默认**收起**（见 `isOverviewVisible`），面板开关仍可放出来。
 * 主题切换在导航面板的主题列里画，这里不再管。
 */
function renderOverview(container: HTMLElement, ctx: WidgetContext): HTMLElement {
  const overview = container.createDiv({
    cls: isOverviewVisible(ctx.file.path) ? "wf-overview is-open" : "wf-overview",
  });
  fillOverview(overview, ctx);
  return overview;
}

/**
 * 总览内容（先 empty 再填：局部刷新不动 DOM 归属，只换内容 + 重挂 tick）。
 *
 * Phase 29：只剩计时 / 大标题 / 继续上次（小工具栏搬进导航面板）。
 * 数据一律从 `ctx` 取：局部刷新时 `refreshChrome` 已就地换过 `ctx.time` / `ctx.wfDoc`，
 * 闭包因此不用重挂。
 */
function fillOverview(box: HTMLElement, ctx: WidgetContext): void {
  box.empty();
  // Phase 16 第 2 行：正计时（计时中）/ Phase 17：继续上次（没有计时中）
  // Phase 18 ③：引导性大标题由 `renderTimer` 在「不计时」分支里画
  renderTimer(box, ctx.host, ctx.file, ctx.refresh, ctx.time.activeEntry, ctx.wfDoc, ctx.theme);
}

/* ------------------------------------------------------------------ *
 * Phase 25 ②：顶部工具行（下拉开关 + 主题切换）—— 永远可见
 * ------------------------------------------------------------------ */

/**
 * 工具行（口径 1 / 2b）：左「下拉开关」，右「主题切换」。
 *
 * 为什么开关不放在 overview 里：overview 收起后开关必须还在（它唯一的入口），
 * 所以它属于**永远可见**的工具行；overview 只是它控制显隐的那块内容。
 */
function renderBoardTop(
  container: HTMLElement,
  host: WfViewHost,
  file: TFile,
  refresh: () => void,
  theme: string,
  path: string,
): HTMLElement {
  const row = container.createDiv({ cls: "wf-board-top" });

  // 主题切换：`host.themes` 为空时自己什么都不画（测试替身 / 旧宿主）
  renderThemeSwitch(row, host, file, refresh, theme);
  return row;
}

/**
 * 下拉开关（口径 2b）：`aria-expanded` 反映 overview 状态，点击**只切类名** ——
 * 不整块重渲染（重渲染会把泳道展开状态与滚动位置一起重建，表现为一开一合就跳位）。
 *
 * 同一图标 `chevron-down`，开合只靠 `aria-expanded` 让 CSS 转一下（§8.1）。
 */
function renderCollapseToggle(row: HTMLElement, overview: HTMLElement, path: string): HTMLElement {
  const open = overviewOpen.has(path);
  const button = row.createEl("button", { cls: "wf-collapse-toggle" });
  // 修改点击逻辑
  button.dataset.label = t("view.nav.panel"); 
  setIcon(button, "circle"); 
  button.setAttribute("aria-expanded", String(open));
  button.onclick = (e) => {
    e.stopPropagation(); // 阻止事件冒泡到 document
    setOverviewOpen(button, overview, path, !overviewOpen.has(path));
  };

  return button;
}

/** 展开 / 收起 工具栏：只换类名 + `aria-expanded`，状态记进会话集合（按 `file.path`） */
function setOverviewOpen(button: HTMLElement, overview: HTMLElement, path: string, next: boolean): void {
  overview.classList.toggle("is-open", next);


  if (next) {
    overviewOpen.add(path);
    
    // 定义外部点击处理函数
    const handleOutsideClick = (e: MouseEvent) => {
      const target = e.target as Node;
      // 如果点击的不是按钮，也不是面板内部，则关闭
      if (!button.contains(target) && !overview.contains(target)) {
        setOverviewOpen(button, overview, path, false);
      }
    };

    // 延迟注册，避免当前触发打开的点击事件立刻触发关闭
    window.setTimeout(() => {
      document.addEventListener("click", handleOutsideClick);
    }, 0);

    // 记下处理器，关闭时才能从 document 上精确移除
    overviewOutsideClickHandlers.set(button, handleOutsideClick);

  } else {
    overviewOpen.delete(path);

    // 移除外部点击监听器
    const handler = overviewOutsideClickHandlers.get(button);
    if (handler) {
      document.removeEventListener("click", handler);
      overviewOutsideClickHandlers.delete(button);
    }
  }
  
  /*
  if (next) overviewOpen.add(path);
  else overviewOpen.delete(path);*/
  button.setAttribute("aria-expanded", String(next));
}

/**
 * 左侧导航下拉面板（Phase 29：三列真入口 —— 统计 / 修改 / 主题）。
 *
 *  - 「统计」= 除「设置」外的小工具（7 个按钮共用一个 tabbed 弹窗，`openWidgetsPopup`）；
 *  - 「修改」= 设置 / 修改工作流 / 修改节点顺序（开关）/ 总览开关（开关）；
 *  - 「主题」= 8 套主题的文字按钮（`renderThemeSwitch`）。
 *
 * 面板每次 `fillNavRail` 都会重建 → 「已归档（n）」这类计数天然跟着数据走，
 * 不再需要「局部刷新时改按钮标题」那一套。
 *
 * @returns 面板的 HTMLElement
 */
function createMenuPanel(
  host: WfViewHost,
  file: TFile,
  refresh: () => void,
  theme: string,
  ctx: WidgetContext,
): HTMLElement {
  // 1. 创建面板容器（挂在导航条里，由 `renderCollapseToggle` 控制开合）
  //    走 `detachedDiv()`（= 全局 `createDiv()` + `classList.add`）：面板要**游离**造好再交给
  //    `renderCollapseToggle` 挂上导航条，不能直接 `document.createDiv()`（document 只允许一个根元素）。
  //    也不写 `panel.className = …`：`className` 是浏览器原生属性，Obsidian 的 DOM 桩里没有对应 setter，
  //    单测就查不到 `.wf-panel-overview`。
  const panel = detachedDiv("wf-panel-overview");
  panel.setAttribute("aria-hidden", "true");

  // 2. ① 统计：除「设置」外的小工具（设置属于「修改」列）—— 7 个按钮共用一个 tabbed 弹窗
  const statsCol = panel.createDiv({ cls: "wf-panel-column" });
  statsCol.createDiv({ cls: "wf-panel-title", text: t("view.nav.stats") });
  const statsList = statsCol.createDiv({ cls: "wf-panel-list" });
  const statsListgroup = statsList.createDiv({ cls: "wf-panel-group" });
  for (const widget of WIDGETS) {
    if (widget.action === "openSettings") continue;
    const button = statsListgroup.createEl("button", {
      cls: "wf-panel-btn",
      text: widgetLabel(widget, ctx),
    });
    button.onclick = () => openWidgetsPopup(ctx, widget.id);
  }

  // 3. ② 修改：设置 / 修改工作流 / 修改节点顺序（开关）/ 总览开关（开关）
  const editCol = panel.createDiv({ cls: "wf-panel-column" });
  editCol.createDiv({ cls: "wf-panel-title", text: t("view.nav.modify") });
  const editList = editCol.createDiv({ cls: "wf-panel-list" });
  const editListgroup = editList.createDiv({ cls: "wf-panel-group" });
  const settings = editListgroup.createEl("button", {
    cls: "wf-panel-btn",
    text: t("view.widget.settings"),
  });
  settings.onclick = () => host.openSettings();
  const editWorkflows = editListgroup.createEl("button", {
    cls: "wf-panel-btn",
    text: t("view.block.editWorkflows"),
  });
  editWorkflows.onclick = () => void openWorkflowEditor(host, file, refresh, theme);
  const reorder = editListgroup.createEl("button", { cls: "wf-panel-btn" });
  renderReorderPanelButton(reorder, host, file, refresh);
  const overviewButton = editListgroup.createEl("button", { cls: "wf-panel-btn" });
  renderOverviewPanelButton(overviewButton, file.path);
  // Phase 33：第 5 个 —— 藏 / 放「未分类」那一框（默认显示）
  const unclassifiedButton = editListgroup.createEl("button", { cls: "wf-panel-btn" });
  renderUnclassifiedPanelButton(unclassifiedButton, file.path);

  // 4. ③ 主题（文字按钮，作参照列）
  const themeCol = panel.createDiv({ cls: "wf-panel-column" });
  themeCol.createDiv({ cls: "wf-panel-title", text: t("view.theme.label") });
  renderThemeSwitch(themeCol, host, file, refresh, theme);

  return panel;
}

/* ------------------------------------------------------------------ *
 * Phase 28：小工具「导入 / 导出数据」（原来是看板工具行的折叠面板）
 * ------------------------------------------------------------------ */

/**
 * 「导入 / 导出数据」小工具弹窗内容（Phase 28 搬进弹窗；Phase 37 重写；Phase 38 收敛成两段）。
 *
 * 两块，各有「一个文件列表」：
 *  1. **导入**：可编辑的多行路径清单（每行一个 JSON 路径）+ 三个按钮
 *     「选择…」（宿主文件对话框多选，追加进清单）/「导入主看板」/「导入已归档」——
 *     两个导入按钮**面对的始终是同一个清单**，只是落点不同：
 *     主看板 → `host.importJsonPaths(file, paths, "board")`（把源里的工作流并进当前看板）；
 *     已归档 → `host.importJsonPaths(file, paths, "archive")`（每个源落一份
 *     `archive/*.wf.json`，不动看板 —— 全局视角）。
 *  2. **导出**：只读清单（当前看板 JSON + 全部归档 JSON 的绝对路径，现算）
 *     + 「复制看板路径」/「复制看板及已归档路径」两个复制按钮。
 *
 * 两个列表等宽等高、每行不换行、超长路径在列表内横向滚动（见 styles.css 的 `.wf-data-list`）；
 * 导出清单是 `readonly` —— 能选中、能复制，但改不动。
 *
 * 弹窗每次打开 / 数据刷新都会 `fillWidgetTab` → 换 body → 重画，
 * 所以导入清单按 `file.path` 记在 `dataPaths`，重开时回填；导出清单是派生的，每次现算。
 *
 * 「选择…」走宿主的桌面文件对话框（移动端 / 取不到对话框 → 空数组，输入框照样能手填）。
 */
function renderDataWidget(box: HTMLElement, host: WfViewHost, file: TFile, refresh: () => void): void {
  const path = file.path;
  const panel = box.createDiv({ cls: "wf-data-panel" });
  //panel.createDiv({ cls: "wf-data-title", text: t("view.data.title") });

  /** 按行拆路径：去空白、丢空行（用户从导出区整段粘过来也认） */
  const pathsOf = (input: HTMLTextAreaElement): string[] =>
    input.value
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0);

  /* ---- ① 导入：一个可编辑清单 + 三个按钮（两个导入按钮共用这份清单） ---- */
  const importSection = panel.createDiv({ cls: "wf-data-section" });
  importSection.createDiv({ cls: "wf-data-section-title", text: t("view.data.sectionImport") });
  importSection.createDiv({ cls: "wf-data-hint", text: t("view.data.pathsHint") });

  const importBox = importSection.createEl("textarea", {
    cls: "wfjson-input wf-data-list wf-data-import-paths",
  });
  importBox.placeholder = t("view.data.placeholder");
  importBox.spellcheck = false;
  importBox.value = dataPaths.get(path) ?? "";

  const importActions = importSection.createDiv({ cls: "wf-data-actions" });
  const pick = importActions.createEl("button", { cls: "wf-data-btn", text: t("view.data.pick") });
  const importBoard = importActions.createEl("button", {
    cls: "wf-data-btn",
    text: t("view.data.importBoard"),
  });
  const importArchive = importActions.createEl("button", {
    cls: "wf-data-btn",
    text: t("view.data.importArchive"),
  });

  /** 输入即记：弹窗重开 / 重画时把清单原文填回来（不 trim，保留用户的行） */
  const remember = (): void => {
    dataPaths.set(path, importBox.value);
  };

  const refreshDisabled = (): void => {
    const empty = pathsOf(importBox).length === 0;
    importBoard.disabled = empty;
    importArchive.disabled = empty;
  };

  importBox.oninput = () => {
    remember();
    refreshDisabled();
  };
  refreshDisabled();

  /** 「选择…」：把选中的绝对路径**追加**到清单末尾（不覆盖手填的那几行，去重） */
  pick.onclick = () => {
    void host.pickImportJsonPaths().then((picked) => {
      if (picked.length === 0) return;
      const merged = pathsOf(importBox);
      for (const item of picked) {
        if (!merged.includes(item)) merged.push(item);
      }
      importBox.value = merged.join("\n");
      remember();
      refreshDisabled();
    });
  };

  /** 两个落点：`board` 并进当前看板 / `archive` 各落一份归档文件（清单是同一份） */
  const runImport = (mode: "board" | "archive"): void => {
    const paths = pathsOf(importBox);
    if (paths.length === 0) return;
    // 结果（体检报告 / 写盘结果 / 失败提示）全部由插件的弹窗与 Notice 负责，视图只发起
    void host.importJsonPaths(file, paths, mode).then(() => refresh());
  };
  importBoard.onclick = () => runImport("board");
  importArchive.onclick = () => runImport("archive");

  /* ---- ② 导出：只读清单 + 两个复制按钮（路径换算 / 移动端回落全在插件侧） ---- */
  const exportSection = panel.createDiv({ cls: "wf-data-section" });
  exportSection.createDiv({ cls: "wf-data-section-title", text: t("view.data.sectionExport") });
  const exportPaths = host.boardJsonPaths(file);
  const exportBox = exportSection.createEl("textarea", {
    cls: "wfjson-input wf-data-list wf-data-export-paths",
  });
  exportBox.readOnly = true;
  exportBox.spellcheck = false;
  exportBox.value = exportPaths.join("\n");
  //exportSection.createDiv({ cls: "wf-data-hint", text: t("view.data.exportHint") });

  const exportActions = exportSection.createDiv({ cls: "wf-data-actions" });
  const copyBoard = exportActions.createEl("button", { cls: "wf-data-btn", text: t("view.data.copyBoard") });
  const copyAll = exportActions.createEl("button", { cls: "wf-data-btn", text: t("view.data.copyAll") });
  copyBoard.onclick = () => {
    const first = exportPaths[0];
    if (first !== undefined) host.copyText(first);
  };
  copyAll.onclick = () => {
    if (exportPaths.length > 0) host.copyText(exportPaths.join("\n"));
  };
}

/* ------------------------------------------------------------------ *
 * Phase 28：小工具「开始 / 完成记录」（双列倒序时间线）
 * ------------------------------------------------------------------ */

/**
 * 画 🗒 弹窗的内容：左「完成记录」、右「开始记录」，各自按时间倒序。
 *
 * 数据全部由 `collectNodeRecords(wfDoc)` 派生（只读）；时间 / 耗时精确到小时
 * （`formatHourStamp` / `formatHourSpan`）。超链接数量与卡片 🔗 同口径（反向 YAML 索引）。
 */
function renderRecordsWidget(box: HTMLElement, host: WfViewHost, wfDoc: WfJsonDocument): void {
  const records = collectNodeRecords(wfDoc);
  if (records.completed.length === 0 && records.started.length === 0) {
    box.createDiv({ cls: "wf-widget-placeholder", text: t("view.widget.emptyRecords") });
    return;
  }

  const row = box.createDiv({ cls: "wf-records" });
  renderRecordColumn(
    row,
    t("view.records.completed", { count: records.completed.length }),
    records.completed,
    host,
    true,
  );
  renderRecordColumn(
    row,
    t("view.records.started", { count: records.started.length }),
    records.started,
    host,
    false,
  );
}

/** 一列记录（标题 + 若干行）；`completed` 决定多显示「耗时 / 完成时间」还是「开始时间」 */
function renderRecordColumn(
  parent: HTMLElement,
  title: string,
  records: readonly NodeRecord[],
  host: WfViewHost,
  completed: boolean,
): void {
  const column = parent.createDiv({ cls: "wf-records-col" });
  column.createDiv({ cls: "wf-records-col-title", text: title });
  for (const record of records) {
    const item = column.createDiv({ cls: "wf-records-item" });
    item.createDiv({ cls: "wf-records-name", text: record.node.title });
    const meta = item.createDiv({ cls: "wf-records-meta" });
    if (completed) {
      const span = formatHourSpan(recordDurationMs(record));
      if (span.length > 0) meta.createSpan({ text: t("view.records.duration", { span }) });
      const time = formatHourStamp(record.latestCompletionMs);
      if (time.length > 0) meta.createSpan({ text: t("view.records.completedAt", { time }) });
    } else {
      const time = formatHourStamp(record.earliestStartMs);
      if (time.length > 0) meta.createSpan({ text: t("view.records.startedAt", { time }) });
    }
    const links = host.linkedFiles(nodeRefFor(record.workflow, record.node)).length;
    meta.createSpan({ text: t("view.records.links", { count: links }) });
  }
}

/* ------------------------------------------------------------------ *
 * Phase 40：「schema警告」小工具（只读）
 *
 * 校验语义收窄后，`SCHEMA_UNKNOWN_FIELD` 只是 **warning** —— 关键字段齐就照常画看板，
 * 「多出来、不在 wfjson 设计内」的字段在这里单独列一份，供人决定删不删。
 * 数据源是 `AnalyzeResult.issues`（引擎已经按 code 打过标记），视图不再自己扫 JSON。
 *
 * 行内只列完整 JSON 指针（`/workflows/0/root/prority`）—— 曾经想再补一列「裸字段名」，
 * 那版的 `unknownFieldNameOf()` 一直停在注释里没接回，Phase 44 顺手删掉（lint 基线只认现有代码）。
 * ------------------------------------------------------------------ */

function renderSchemaWarningsWidget(box: HTMLElement, result: AnalyzeResult): void {
  const unknown = issuesWithCode(result.issues, "SCHEMA_UNKNOWN_FIELD");
  if (unknown.length === 0) {
    box.createDiv({ cls: "wf-widget-placeholder", text: t("view.schemaWarn.empty") });
    return;
  }
  box.createDiv({
    cls: "wf-schema-warn-summary",
    text: t("view.schemaWarn.summary", { count: unknown.length }),
  });
  const list = box.createDiv({ cls: "wf-schema-warn-list" });
  for (const item of unknown) {
    const row = list.createDiv({ cls: "wf-schema-warn-item" });
    //row.createDiv({ cls: "wf-schema-warn-field", text: unknownFieldNameOf(item.path) });
    if (item.path !== undefined) {
      row.createDiv({ cls: "wf-schema-warn-path", text: t("view.schemaWarn.path", { path: item.path }) });
    }
  }
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
  row.createSpan({ cls: "wf-theme-switch-label", text: t("view.theme.label") });
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
  theme: string,
): void {
  // Phase 24：只停这篇笔记的 tick（另一个看板里的计时不受影响）
  stopTimerTicker(file.path);
  if (active === undefined) {
    box.createDiv({ cls: "wf-app-title", text: appTitleText(host) });
    renderTimerResume(box, host, file, refresh, lastCompletedEntry(wfDoc), theme);
    return;
  }

  const timer = box.createDiv({ cls: "wf-timer" });
  timer.createDiv({ cls: "wf-timer-label", text: t("view.timer.running", { title: active.nodeTitle }) });
  const clock = timer.createSpan({ cls: "wf-timer-clock" });
  updateClock(clock, active.startAt);
  timerHandles.set(file.path, window.setInterval(() => updateClock(clock, active.startAt), 1000));

  // Phase 16：按钮挂在 `.wf-timer` 里（总览第 2 行因此是**一整块**，三行结构不被拆散）
  const actions = timer.createDiv({ cls: "wf-timer-actions" });

  const record = actions.createEl("button", {
    cls: "wf-timer-btn wf-timer-btn--record",
    text: t("view.timer.stopRecord"),
  });
  record.onclick = () => void stopTimer(host, file, active.nodeId, active.nodeTitle, "record", refresh, theme);
  const discard = actions.createEl("button", {
    cls: "wf-timer-btn wf-timer-btn--discard",
    text: t("view.timer.stopDiscard"),
  });
  discard.onclick = () => void stopTimer(host, file, active.nodeId, active.nodeTitle, "discard", refresh, theme);
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
  theme: string,
): void {
  if (target === undefined) return;
  const row = box.createDiv({ cls: "wf-timer-resume" });
  const label = `${t("view.timer.resumeTask", { title: target.nodeTitle })} · ${t("view.timer.resumeAction")}`;
  const button = row.createEl("button", { cls: "wf-timer-resume-btn", text: label });
  // 悬浮给全名 + 那条会话的结束时刻（按钮文案本身过长会省略号）
  button.title = `${target.nodeTitle} · ${target.endAt}`;
  button.onclick = () => void startTimer(host, file, target.nodeId, target.nodeTitle, refresh, theme);
}

/* ------------------------------------------------------------------ *
 * 近 21 天方块阵（契约 §7.2；视图微调见 data_ixd_discuss_interact_v0.2.md《Phase 3 视图调整定稿》v0.6）
 * ------------------------------------------------------------------ */

/** 方块阵窗口天数（Phase 3 视图微调 v0.6：30 → 21 = 3 个整周一横条） */
const HEATMAP_DAYS = 21;

/* ------------------------------------------------------------------ *
 * Phase 28：21 天窗口的结束日期
 *
 * 方块阵与甘特图共用同一个窗口（`buildHeatmap` / `buildGantt` 的 `now` 只用来回推 21 个本地日期）。
 * 默认「今天」在归档回看时是错的 —— 归档数据停在归档那天，用今天回推 21 天往往一格都没有。
 * 所以这里把窗口结束日做成可改的：
 *  - 主看板默认今天；
 *  - 归档看板默认归档时间（`archive.archivedAt`，缺失再回落今天）；
 *  - 用户手选后记在 `ganttAnchors`（按 `file.path` 分桶，纯会话内存，不落盘）。
 * ------------------------------------------------------------------ */

/** 日期输入的取值形态（`<input type="date">` 给的就是这个） */
const GANTT_ANCHOR_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 用户手选的窗口结束日（按看板路径分桶；纯会话内存，与 `overviewCollapsed` 同口径） */
const ganttAnchors = new Map<string, string>();

/** `YYYY-MM-DD` → 本地日期；格式不对 / 不存在的日期（如 2026-02-30）返回 undefined */
function anchorDateOf(key: string): Date | undefined {
  if (!GANTT_ANCHOR_RE.test(key)) return undefined;
  const stamp = parseIso(key);
  if (stamp === undefined) return undefined;
  const date = new Date(stamp);
  return formatLocalDate(date) === key ? date : undefined;
}

/** 归档看板的窗口结束日 = 最晚的归档时间（没有归档元数据 / 时间就返回 undefined） */
function archiveAnchorKey(doc: WfJsonDocument): string | undefined {
  // Phase 28：归档文件自带快照时间（首选）
  const snapshot = typeof doc.archivedAt === "string" ? doc.archivedAt.slice(0, 10) : undefined;
  if (snapshot !== undefined && anchorDateOf(snapshot) !== undefined) return snapshot;

  const stamps: string[] = [];
  for (const workflow of doc.workflows) {
    const at = workflow.archive?.archivedAt;
    if (typeof at === "string" && at.length > 0) stamps.push(at);
  }
  const keys = stamps
    .map((stamp) => stamp.slice(0, 10))
    .filter((key) => anchorDateOf(key) !== undefined)
    .sort();
  return keys.length > 0 ? keys[keys.length - 1] : undefined;
}

/** 这个看板的窗口结束日：手选 > 归档日（仅归档看板）> 今天 */
function ganttAnchorKey(ctx: WidgetContext): string {
  const stored = ganttAnchors.get(ctx.file.path);
  if (stored !== undefined && anchorDateOf(stored) !== undefined) return stored;
  if (isArchiveBoardPath(ctx.file.path)) {
    const archived = archiveAnchorKey(ctx.wfDoc);
    if (archived !== undefined) return archived;
  }
  return formatLocalDate(new Date());
}

/**
 * 方块阵（Phase 3 视图微调 v0.6）：**单行横条**，窗口 = 本地 21 天（含窗口结束日，默认今天，**最新在最右**）。
 * Phase 28：结束日由调用方给（`anchor`）—— 归档看板默认用归档日，回看时才看得到当时那 21 天。
 * 每 7 格包进一个 `.wf-heat-week` 容器（周与周之间的竖分割线挂在 styles.css）。
 * 放弃「周一在顶」的日历竖排 → 不按日历周对齐，**不补空**（旧 `.wf-heat--empty` 已弃用），
 * 也不再渲染左侧星期标签列（`.wf-heat-weekdays` / `.wf-heat-weekday` 已弃用）。
 * Phase 8：删掉「少 → 多」图例（`.wf-heat-legend*` 已弃用）—— 档位一眼可比，不需要重复解释。
 * 只挂 class（档位 → `.wf-heat--l0` … `.wf-heat--l4`），颜色 / 尺寸全部在 styles.css。
 */
function renderHeatmap(box: HTMLElement, time: TimeAggregate, anchor: Date, theme: string): void {
  const section = box.createDiv({ cls: "wf-heatmap" });
  section.createDiv({ cls: "wf-heatmap-title", text: t("view.heatmap.title", { days: HEATMAP_DAYS }) });

  const body = section.createDiv({ cls: "wf-heatmap-body" });
  const cells = buildHeatmap(time, anchor, HEATMAP_DAYS);
  for (let start = 0; start < cells.length; start += 7) {
    const week = body.createDiv({ cls: "wf-heat-week" });
    for (const cell of cells.slice(start, start + 7)) {
      const square = week.createDiv({ cls: `wf-heat wf-heat--l${cell.level}` });
      square.onmouseenter = () => openHeatTip(square, cell, theme);
      square.onmouseleave = () => closeHeatTip();
    }
  }
}

/**
 * 方块阵悬浮详情：日期 + 当天「各工作流耗时」（无数据 → 「无记录」）。
 * 定位用 `getBoundingClientRect` + `left/top`（与右键菜单同类：这两个坐标是**唯一**允许的内联样式，
 * 其余外观一律 styles.css）；挂到 `document.body`（body 是合法容器，不是 `document`）。
 */
function openHeatTip(square: HTMLElement, cell: HeatmapCell, theme: string): void {
  closeHeatTip();
  const tip = document.body.createDiv({ cls: "wf-heat-tip" });
  themeOverlay(tip, theme);
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
 *  Phase 8：去掉 10 分钟刻度格；每个工作流一种颜色（按 `workflows[]` 顺序取色）。
 *  Phase 21：色号从 6 种扩到 12 种（c0…c11；每套主题的浅色系统 / 暗色系统各给一套 12 色），12 色一循环。
 *  只挂 class；底色 / 分割线 / 高亮色 / 尺寸全部在 styles.css（`.wf-gantt*`）。
 *
 *  ⚠️ 唯一的内联样式：高亮段的 `left` / `width`、刻度的 `left` —— 它们是**按数据算出来的占位**
 *     （同右键菜单的 left/top，没法写进 CSS），其余外观一律走 styles.css。
 * ------------------------------------------------------------------ */

/** 甘特图窗口（与方块阵同窗口：21 天 = 3 周，最新在最下；Phase 28 起结束日可由日期输入改） */
const GANTT_DAYS = HEATMAP_DAYS;

/**
 * Phase 8 / 21：甘特图每个工作流一种颜色。
 *
 * 主题给 **12 种**时间色（`--wf-gantt-c0` … `--wf-gantt-c11`，每套主题的浅色 / 暗色系统各一套），
 * 超过 12 个工作流按 `workflows[]` 顺序从头循环 —— 改这里必须同时改 styles.css 里的 `--wf-gantt-cN`
 * 与 `.wf-gantt-span--wN` 取色规则（views/wfView.test.ts 有静态契约断言兜底）。
 */
const GANTT_WORKFLOW_COLORS = 12;

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
function renderGantt(box: HTMLElement, time: TimeAggregate, anchor: Date, theme: string): void {
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
    const tick = axisTrack.createSpan({ cls: "wf-gantt-tick", text: `${hour < 10 ? "0" : ""}${hour}` });
    tick.style.left = `${ganttPercent(hour * 60)}%`;
  }

  const rows = buildGantt(time, anchor, GANTT_DAYS);
  rows.forEach((row, index) => {
    // Phase 9 v0.7 ③：每 7 行一组（与方块阵 .wf-heat-week 同口径），组首加一道横分割线
    const weekStart = index > 0 && index % 7 === 0;
    const line = body.createDiv({ cls: weekStart ? "wf-gantt-row wf-gantt-row--week-start" : "wf-gantt-row" });
    const date = line.createDiv({ cls: "wf-gantt-date" });
    // Phase 13：纵坐标日期只显示「月-日」（引擎侧 row.date 仍是 YYYY-MM-DD，悬浮提示照旧给完整日期）
    date.createSpan({ cls: "wf-gantt-date-label", text: row.date.slice(5) });
    if (row.totalHours > 0) date.createSpan({ cls: "wf-gantt-date-hours", text: `${row.totalHours}h` });

    const lane = line.createDiv({ cls: "wf-gantt-track" });
    for (const span of row.spans) {
      const colorIndex = span.workflowIndex % GANTT_WORKFLOW_COLORS;
      const bar = lane.createDiv({ cls: `wf-gantt-span wf-gantt-span--w${colorIndex}` });
      bar.style.left = `${ganttPercent(span.startMinute)}%`;
      bar.style.width = `${ganttWidth(span)}%`;
      bar.onmouseenter = () => openGanttTip(bar, row.date, row.weekday, span, theme);
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
function openGanttTip(bar: HTMLElement, date: string, weekday: number, span: GanttSpan, theme: string): void {
  closeHeatTip();
  const tip = document.body.createDiv({ cls: "wf-heat-tip wf-gantt-tip" });
  themeOverlay(tip, theme);
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
const WHEEL_PASS_SELECTORS: readonly string[] = [".wf-card", ".wf-caret", "button", ".wf-lane-head", ".wf-drawer-handle"];

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
function enableGapWheelScroll(scroller: HTMLElement): void {
  scroller.addEventListener(
    "wheel",
    (event) => {
      if (event.deltaX !== 0) return;              // 横向滚不在这里处理
      if (event.defaultPrevented) return;          // 列已经吃掉这次滚轮

      // 光标在 gap 上时，找横向最近的列，把 deltaY 灌进它的 scrollTop
      const column = nearestColumnAt(scroller, event.clientX);
      if (column === null) return;

      const before = column.scrollTop;
      column.scrollTop += event.deltaY;
      if (column.scrollTop !== before) event.preventDefault(); // 真的滚了才挡冒泡
    },
    { passive: false },
  );
}

function nearestColumnAt(scroller: HTMLElement, clientX: number): HTMLElement | null {
  const cols = Array.from(scroller.querySelectorAll<HTMLElement>(":scope > .wf-column"));
  if (cols.length === 0) return null;
  let best: HTMLElement = cols[0];
  let bestDist = Infinity;
  for (const col of cols) {
    const r = col.getBoundingClientRect();
    const dist = clientX < r.left ? r.left - clientX : clientX > r.right ? clientX - r.right : 0;
    if (dist < bestDist) { bestDist = dist; best = col; }
  }
  return best;
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
  ctx: WidgetContext,
  laneReuse?: LaneReuse,
): HTMLElement {
  const groups = groupWorkflows(wfDoc);
  const block = container.createDiv({ cls: "wf-block" });
  //block.createDiv({cls:"wf-block-title-row"});
  //block.createDiv({ cls: "wf-block-title", text: t("view.block.active", { count: groups.active.length , active :summary.active.doing,total:summary.active.total,blocked:summary.active.blocked}) });

  // Phase 27 M2：外层 `.wf-block-body` = 钉死的「未分类」框 + 横滚的泳道区（契约 §4.3）
  const body = block.createDiv({ cls: "wf-block-body" });
  const initialContext: NavContext = openDrawer.get(file.path) ?? "active";
  body.dataset.context = initialContext;

  /*
   * Phase 33 框① = 未分类（钉死、不参与横滚）。显隐由导航面板「修改」列的开关遥控（默认显示）。
   *
   * **与框② 平级**：直接挂在 `.wf-block-body` 上（DOM 里排最前，CSS 用 `order: 0` 钉在最左）。
   * 为什么不能像初版那样嵌在框② 的 `.wf-active-columns` 里：那样「未分类 + 进行中工作流 +
   * 导航栏」会全挤在框② 一个框里；而且框① 会跟着 `.wf-pane-active` 一起 `display: none`，
   * 切到已完成 / 已取消就看不见了。现在它**跨上下文常显**（契约 §3 修订）。
   */
  const unclassifiedFrame = body.createDiv({ cls: "wf-board-frame wf-board-frame--unclassified" });
  // Phase 36：归档看板上默认隐藏（见 `isUnclassifiedVisible`），面板开关仍可放出来
  applyUnclassifiedFrameVisible(unclassifiedFrame, isUnclassifiedVisible(file.path));
  unclassifiedFrameEls.set(file.path, unclassifiedFrame);
  renderUnclassifiedColumn(host, unclassifiedFrame, file, groups.unclassified, refresh, ctx.theme);

  /*
   * Phase 33 框② = 进行中工作流（横滚）+ 导航栏（最右）。
   *
   * 为什么框② 包 pane 而不是只包横滚区：导航栏必须**跨上下文常驻**（切到已完成 / 已取消时
   * 它的横杠换成那个分组的，用户还要能切回来），所以它不能待在 `.wf-pane-active` 里
   * （那个 pane 在非 active 上下文是 `display:none`）。于是框② = pane 的父级 + rail 的兄弟。
   * 非 active 上下文里框里只剩 rail，皮肤靠 `[data-context="active"]` 关掉 → 那两个 pane**不套框**。
   * 框② 里现在只有「横滚区 + 导航栏」两件东西（框① 已挪到它外面，见上）。
   */
  const activeFrame = body.createDiv({ cls: "wf-board-frame wf-board-frame--active" });
  // active 列包一层 pane，方便三态统一切换
  const activePane = activeFrame.createDiv({ cls: "wf-pane wf-pane-active" });
  // ↓ 原来直接挂在 body 上的 active 列结构，父节点换成 activePane
  const columns = activePane.createDiv({ cls: "wf-active-columns" });
/*
  const activePane_doing = activeFrame.createDiv({ cls: "wf-pane wf-pane-active" });
  const columns_doing = activePane_doing.createDiv({ cls: "wf-active-columns" });*/
  const scroll = columns.createDiv({ cls: "wf-active-scroll" });
  enableGapWheelScroll(scroll);
  for (const workflow of groups.active) {
    const column = scroll.createDiv({ cls: "wf-column" });
    // 栏头挂一个颜色方块：与甘特图里该 workflow 的时段同色（`--wf-gantt-cN`）
    renderLane(host, column, file, workflow, refresh, lanes, workflowColorIndex(wfDoc, workflow.id), laneReuse, ctx.theme);
  }

  // Phase 33：导航栏搬进块内最右（框② 的第二列）。放在横滚区之后 → 首次渲染时
  // `columnsOf()` 已经能查到 `.wf-active-columns`，高亮 / 滚动绑定一上来就有真容器
  const navRail = renderNavRail(activeFrame, groups, file.path, host, file, refresh, ctx.theme, ctx);

  // Phase 5 ③ / Phase 15 / Phase 29：块里只留拖拽说明；入口按钮全搬进左侧导航面板的「修改」列
  renderReorderHelp(block, reorderEnabled.has(file.path), file.path);

  // 追加两个可切换的 pane（Phase 33：它们不套框，靠 CSS 的 order:1 夹在框① 与框② 之间）
  renderContextPane(host, body, file, wfDoc, "archived",  refresh, lanes, laneReuse, ctx.theme);
  renderContextPane(host, body, file, wfDoc, "cancelled", refresh, lanes, laneReuse, ctx.theme);
  return navRail;
}

/**
 * Phase 27 M2：「未分类」钉死列（契约 §4.3 / §4.4）。
 *
 *  - 永远渲染（没有未分类节点时也留列头 + 「＋ 新建节点」）—— 否则「第一次用」没有落脚点；
 *  - 列头同时是**隐藏 root 的落点**：把任意节点拖上去 = `host.attachNodeToUnclassified`
 *    （整棵子树跟着走，见引擎 `attachNodeToUnclassified`）；
 *  - 每棵未分类树走 `renderSubtree(..., isRoot = false, groups.unclassified)` —— 节点就是普通节点
 *    （状态 / 进度 / 计时 / 右键 / 拖拽全部复用），只是外层多包一个 `.wf-unclassified-item`；
 *  - **不走** `renderLane`：未分类不是泳道（没有泳道头徽标、不进 `LaneIndex.layout`、不参与甘特配色）。
 */
function renderUnclassifiedColumn(
  host: WfViewHost,
  parent: HTMLElement,
  file: TFile,
  workflow: WfWorkflow | undefined,
  refresh: () => void,
  theme: string,
): void {
  const column = parent.createDiv({ cls: "wf-column wf-unclassified" });
  const lane = column.createDiv({ cls: "wf-lane" });
  const head = lane.createDiv({ cls: "wf-lane-head" });

  // 1. 创建按钮，去掉 text 属性
  const newButton = head.createEl("button", { cls: "wf-unclassified-new" });
  // 2. 设置 plus 图标
  setIcon(newButton, "plus");

  newButton.onclick = () => void addUnclassifiedChild(host, file, refresh, theme);
  head.createDiv({ cls: "wf-lane-title", text: t("view.unclassified.title") });

  // 列头落点：只把「正拖着一张卡片」当成有效拖拽源（外部拖文件进来不受影响）
  head.ondragover = (event) => {
    if (draggingNodeId === null) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    head.classList.toggle("wf-unclassified-head--drop", true);
  };
  head.ondragleave = () => {
    head.classList.toggle("wf-unclassified-head--drop", false);
  };
  head.ondrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    head.classList.toggle("wf-unclassified-head--drop", false);
    const movingId = draggingNodeId;
    draggingNodeId = null;
    draggingKeepSubtree = false;
    if (movingId === null) return;
    void attachToUnclassified(host, file, movingId, refresh);
  };

  const list = lane.createDiv({ cls: "wf-unclassified-body" });
  if (workflow === undefined) return; // 懒创建：还没有任何未分类节点 → 只留列头
  const children = Array.isArray(workflow.root.children) ? workflow.root.children : [];
  for (const child of children) {
    const item = list.createDiv({ cls: "wf-unclassified-cell" });
    item.appendChild(renderSubtree(host, file, child, refresh, false, workflow, theme));
    item.createDiv({ cls: "wf-elbow wf-elbow--ghost" });   // 透明 elbow，保持占位
  }
}

/**
 * 未分类列「＋ 新建节点」：面板 tab 2 复用「加子节点」表单（插件对隐藏 root 开），成功后整块重渲染。
 *
 * `theme` 原样交给宿主 —— 这个入口和「节点右键 → 面板」是**同一张** `.wf-side-panel`
 * （tab / 标题 / 表单皮肤全按 `data-wf-theme` 命中），漏传就退回素净基线，两处弹窗观感不一致。
 */
async function addUnclassifiedChild(
  host: WfViewHost,
  file: TFile,
  refresh: () => void,
  theme: string,
): Promise<void> {
  const outcome = await host.openUnclassifiedChildPanel(file, theme);
  if (outcome.cancelled || outcome.result === undefined) return; // 取消不是失败
  const result = outcome.result;
  if (!result.success) {
    host.notify(t("view.notify.writeFailed", { reason: result.reason ?? t("view.notify.unknownReason") }));
    return;
  }
  if (!result.changed) {
    host.notify(t("view.notify.noNewChild", { title: t("view.unclassified.title") }));
    return;
  }
  const notes = [...(result.warnings ?? [])];
  host.notify(
    t("view.notify.childAdded", {
      title: t("view.unclassified.title"),
      notes:
        notes.length > 0
          ? t("view.notify.notesSuffix", { list: notes.join(t("view.notify.listSep")) })
          : "",
      suffix: warningSuffix(result.issues),
    }),
  );
  // 懒创建：这一笔可能刚把未分类 workflow 写进 `workflows[]` → 分组变了，整块重渲染最稳
  rememberFreshAnalysis(file, result.analysis);
  refresh();
}

/** 列头落点：把节点（整棵子树）搬进未分类；成功整块重渲染（拓扑变了） */
async function attachToUnclassified(
  host: WfViewHost,
  file: TFile,
  nodeId: string,
  refresh: () => void,
): Promise<void> {
  const result = await host.attachNodeToUnclassified(file, nodeId);
  if (!result.ok) {
    host.notify(t("view.notify.reorderFailed", { reason: result.reason ?? t("view.notify.unknownReason") }));
    return;
  }
  if (result.unchanged === true) return; // 本来就是未分类顶层节点：不写盘、不重画
  rememberFreshAnalysis(file, result.analysis);
  refresh();
}

/**
 * 拖拽规则说明（Phase 21 ⑥ / Phase 29）：开关「开」时显示、关时隐藏。
 *
 * Phase 29：开关搬进导航面板 → 这里顺手把句柄登记进 `reorderHelpEls`
 * （按钮靠它原位遥控显隐，两者不在同一棵 DOM 上）。
 * 只切一个类名（`--hidden` → `display: none`），不删元素 —— 开关原位切换时才不用重渲染；
 * 文本里用 `\n` 分行，靠 CSS 的 `white-space: pre-line` 原样折行（不为每行建元素）。
 */
function renderReorderHelp(block: HTMLElement, visible: boolean, path: string): HTMLElement {
  const help = block.createDiv({ cls: "wf-reorder-help", text: t("view.reorder.help") });
  setReorderHelpVisible(help, visible);
  reorderHelpEls.set(path, help);
  return help;
}

/** 显隐拖拽说明（Phase 21：开关原位切换的唯一「结构」变化就是这一下） */
function setReorderHelpVisible(help: HTMLElement, visible: boolean): void {
  help.classList.toggle("wf-reorder-help--hidden", !visible);
}

/**
 * 面板里「修改节点顺序」文字按钮（Phase 29：从块尾搬进导航面板的「修改」列）。
 *
 * 开 → 卡片可拖；关 → 原交互（右键菜单 / 点击）一律不变。**原位切换、不重渲染**：
 * 整块重渲染会把「用户折叠的子树」与滚动位置一起重建，表现为一开一关画面就跳、折叠被展开。
 * 这里只改三处（见 `applyReorderMode`）：① 按钮文案 / `aria-pressed` / 开态类；
 * ② 说明块显隐（经 `reorderHelpEls` 找块里那段）；③ 每张已注册卡片的拖拽能力。
 */
function renderReorderPanelButton(
  button: HTMLElement,
  host: WfViewHost,
  file: TFile,
  refresh: () => void,
): void {
  const on = reorderEnabled.has(file.path);
  button.setText(`${t("view.block.reorderNodes")}：${t(on ? "view.reorder.on" : "view.reorder.off")}`);
  button.title = t("view.reorder.hint");
  button.setAttribute("aria-pressed", on ? "true" : "false");
  button.classList.toggle("wf-panel-btn--on", on);
  button.onclick = () => {
    const next = !reorderEnabled.has(file.path);
    if (next) reorderEnabled.add(file.path);
    else reorderEnabled.delete(file.path);
    draggingNodeId = null;
    draggingKeepSubtree = false;
    applyReorderMode(host, file, next, { button, help: reorderHelpEls.get(file.path), refresh });
  };
}

/**
 * Phase 31：顶部 `.wf-overview` 展开 / 收起的**唯一写入口**。
 *
 * 面板「总览」按钮与「开始任务」（`startTimer`）都要改这一处状态，写在这里才不会两边各写一套：
 * 「改 Set」与「切 `is-open`」必须同时发生，漏一步就会出现「按钮显示开、块却是收的」这种自相矛盾的状态。
 * 只切类名、不重渲染 —— overview 里的计时 tick 不受影响。
 *
 * Phase 36：同时记进 `overviewExplicit` —— 归档看板默认隐藏，用户一旦动过开关就按 `overviewCollapsed` 走。
 */
function setOverviewCollapsed(path: string, collapsed: boolean): void {
  if (collapsed) overviewCollapsed.add(path);
  else overviewCollapsed.delete(path);
  overviewExplicit.add(path);
  renderSessions.get(path)?.overview.classList.toggle("is-open", !collapsed);
}

/**
 * 面板里「总览」文字按钮（Phase 29）：控制顶部 `.wf-overview`（计时 / 大标题）的显隐。
 *
 * **默认展开**（`overviewCollapsed` 里没有 = 展开），按钮负责把它藏起来 / 放出来。
 * Phase 31：翻转走 `setOverviewCollapsed`（与「开始任务后自动展开」共用同一个写入口）。
 * Phase 36：归档看板默认是「关」，按钮文案与 `aria-pressed` 按实际可见性来（`isOverviewVisible`）。
 */
function renderOverviewPanelButton(button: HTMLElement, path: string): void {
  const visible = isOverviewVisible(path);
  button.setText(`${t("view.nav.overview")}：${t(visible ? "view.reorder.on" : "view.reorder.off")}`);
  button.setAttribute("aria-pressed", visible ? "true" : "false");
  button.classList.toggle("wf-panel-btn--on", visible);
  button.onclick = () => {
    // 点之前的状态取反 = 点完应该的样子（现读，别用渲染时捕获的 `visible`：
    // 「开始任务」也会改这一处状态，按钮没跟着重画时闭包会过期）
    setOverviewCollapsed(path, isOverviewVisible(path));
    renderOverviewPanelButton(button, path);
  };
}

/**
 * Phase 33：框①（未分类那一框）显隐的**唯一写入口**（与 `setOverviewCollapsed` 同口径）。
 *
 * 「改 Set」与「切类名」必须同时发生：漏一步就会出现「按钮说藏了、块还亮着」这种自相矛盾的状态。
 * 只切类名、不重渲染 —— 横滚位置、子树折叠态、计时 tick 全都不受影响。
 * Phase 36：同时记进 `unclassifiedExplicit` —— 归档看板默认隐藏，用户一旦动过开关就按 `unclassifiedHidden` 走。
 */
function setUnclassifiedHidden(path: string, hidden: boolean): void {
  if (hidden) unclassifiedHidden.add(path);
  else unclassifiedHidden.delete(path);
  unclassifiedExplicit.add(path);
  const frame = unclassifiedFrameEls.get(path);
  if (frame !== undefined) applyUnclassifiedFrameVisible(frame, !hidden);
}

/** 框①显隐的落点：只切一个类名（`is-hidden` → `display: none`），不删元素（同 `setReorderHelpVisible`） */
function applyUnclassifiedFrameVisible(frame: HTMLElement, visible: boolean): void {
  frame.classList.toggle("is-hidden", !visible);
}

/**
 * Phase 33：面板「修改」列里「未分类」文字按钮 —— 控制框① 的显隐。
 *
 * **默认显示**（`unclassifiedHidden` 里没有 = 显示），按钮负责把它藏起来 / 放出来。
 * 文案口径与「总览」「修改节点顺序」一致：`名字：开/关` 换成更直白的 `名字：显示/隐藏`
 * （藏起来的是一个整块区域，不是「功能开关」）。
 * Phase 36：归档看板上默认是「隐藏」，按钮文案与 `aria-pressed` 按实际可见性来。
 */
function renderUnclassifiedPanelButton(button: HTMLElement, path: string): void {
  const visible = isUnclassifiedVisible(path);
  const state = visible ? "view.nav.unclassifiedShow" : "view.nav.unclassifiedHide";
  button.setText(`${t("view.unclassified.title")}：${t(state)}`);
  button.title = t("view.nav.unclassifiedHint");
  button.setAttribute("aria-pressed", visible ? "true" : "false");
  button.classList.toggle("wf-panel-btn--on", visible);
  button.onclick = () => {
    // 现读状态（同 `renderOverviewPanelButton`：别用渲染时捕获的 `visible`）
    setUnclassifiedHidden(path, isUnclassifiedVisible(path));
    renderUnclassifiedPanelButton(button, path);
  };
}

/**
 * Phase 21 ⑤：开关原位切换 —— 只改「按钮 / 说明 / 卡片拖拽能力」，**不重渲染**。
 *
 * 卡片从 `nodeRegistry` 里拿（每个节点登记过 `card` + `node` + `isRoot`），
 * 因此折叠态、滚动位置、泳道排版全都原样不动 —— 这就是「开关时不移动渲染画面」的实现方式。
 */
function applyReorderMode(
  host: WfViewHost,
  file: TFile,
  on: boolean,
  context: { button: HTMLElement; help?: HTMLElement; refresh: () => void },
): void {
  context.button.setText(`${t("view.block.reorderNodes")}：${t(on ? "view.reorder.on" : "view.reorder.off")}`);
  context.button.classList.toggle("wf-panel-btn--on", on);
  context.button.setAttribute("aria-pressed", on ? "true" : "false");
  // Phase 29：说明块在泳道块里，开关在导航面板里 —— 块还没画出来时（空文件 / 兜底提示）可能取不到
  if (context.help !== undefined) setReorderHelpVisible(context.help, on);

  const registry = nodeRegistry.get(file.path);
  if (registry === undefined) return; // 还没画过卡片（空文件 / 兜底提示）→ 下次渲染按 reorderEnabled 生效
  for (const handles of registry.values()) {
    // Phase 27 M1：根节点不再被跳过 —— 它当**落点**（只接 after），非根仍是「源 + 落点」
    if (on) enableCardDrag(host, handles.card, file, handles.node, context.refresh, handles.isRoot ? { draggable: false } : {});
    else disableCardDrag(handles.card);
  }
}

/**
 * 「⚙️ 修改工作流…」（Phase 5 ③）：表单与写回都在插件侧（分字段 + 增删，引擎先整批预检）。
 * Phase 25：落点从居中 Modal 换成**右侧面板 tab 3**（`openNodePanel(..., "workflow")`，节点可空）。
 *  - 有增删（`structureChanged`）→ 泳道与计数都变了 → **整块重渲染**（`refresh`）；
 *  - 只改字段 → 局部刷新根节点那一列（`refreshChrome` 顺带重画泳道头徽标）。
 */
async function openWorkflowEditor(host: WfViewHost, file: TFile, refresh: () => void,
  theme:string,): Promise<void> {
  const outcome = await host.openNodePanel(file, undefined, "workflow", undefined, theme);
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
    // A 案：结构变了要整块重渲染 → 同样把写回后的分析带过去（不重读盘）
    rememberFreshAnalysis(file, result.analysis);
    refresh();
    return;
  }
  await refreshNodes(host, file, result.changedNodeIds, refresh, result.analysis,
  theme);
}

/* ------------------------------------------------------------------ *
 * Phase 25 ③：左侧导航条（三套上下文：进行中 / 已完成 / 已取消）
 * ------------------------------------------------------------------ */

/** 导航条 / 抽屉的上下文：`"active"` = 进行中（两个抽屉都关） */
type NavContext = "active" | WorkflowState;

/** 某上下文下要列出的 workflow（导航横杠 = 这里的每一项） */
function workflowsOf(groups: WorkflowGroups, context: NavContext): WfWorkflow[] {
  if (context === "archived") return groups.archived;
  if (context === "cancelled") return groups.cancelled;
  return groups.active;
}

/**
 * 导航条（§5.4）：一列横杠，一条对应「当前可见主体」里的一栏 workflow。
 *
 * Phase 33：它现在是**框② 的最后一列**（`parent` = `.wf-board-frame--active`，块内最右），
 * 不再是 `.wf-main` 的第一个子元素；当前上下文 0 条 workflow 时是空栏（不占宽度）。
 * 初始上下文 = `openDrawer` 里那个值（整块重渲染后抽屉若还开着，导航条要留在那个上下文）。
 */
function renderNavRail(parent: HTMLElement, groups: WorkflowGroups, path: string,
  host: WfViewHost,      
  file: TFile,           
  refresh: () => void,   
  theme: string,
  ctx: WidgetContext,
): HTMLElement {
  const rail = parent.createDiv({ cls: "wf-nav-rail" });

  
  // 1. 先调用 fillNavRail（如果它内部清空了 rail，也不会影响后续操作）
  const context: NavContext = openDrawer.get(path) ?? "active";
  fillNavRail(rail, workflowsOf(groups, context), context, path, host, file, refresh, theme, ctx);



  // 4. 【关键】把包裹容器插入到 rail 的第一个位置
  //rail.prepend(toggleWrapper);

  return rail;
}

function setActiveNavItem(path: string, index: number): void {
  const rail = renderSessions.get(path)?.navRail;
  if (rail === undefined) return;
  rail.querySelectorAll<HTMLElement>(".wf-nav-item").forEach((el, i) => {
    const on = i === index;
    el.classList.toggle("is-active", on);
    if (on) el.setAttribute("aria-current", "true");
    else el.removeAttribute("aria-current");
  });
}


const navScrollLock = new Map<string, symbol>();

/**
 * 按上下文重画横杠（**整体切换**，不是叠加），并重新绑滚动高亮。
 * 每条横杠的 `title` / `aria-label` 是 workflow 标题（平时只是一条短横杠，hover 才看得见）。
 */function fillNavRail(
  rail: HTMLElement,
  workflows: readonly WfWorkflow[],
  context: NavContext,
  path: string,
  host: WfViewHost,      // 新增
  file: TFile,           // 新增
  refresh: () => void,   // 新增
  theme: string,         // 新增
  ctx: WidgetContext,    // 新增（面板里的 widget 弹窗要数据）
): void {
  rail.empty();


  // ==========================================
  // 1. 先创建下拉开关的包裹容器 (放到最前面)
  // ==========================================
  const toggleWrapper = rail.createDiv({ cls: "wf-dropdown-wrapper  wf-nav-toggle-wrapper" });
  // 创建面板，并为了防冲突，给 id 加上 path 标识
  const overviewPanel = createMenuPanel(host, file, refresh, theme, ctx);
  overviewPanel.id = `wf-starthome`; 
  // Phase 29：面板每次重建都是合着的 → 恢复「用户本来开着」的展开态
  if (overviewOpen.has(path)) overviewPanel.classList.add("is-open");
  toggleWrapper.appendChild(overviewPanel);
  // 创建按钮（传入 toggleWrapper）
  renderCollapseToggle(toggleWrapper, overviewPanel, path);

  const toggleWrapper_home = rail.createDiv({ cls: " wf-nav-toggle-wrapper" });
  // ① home（原样）
  /*
  const home = toggleWrapper_home.createEl("button", {
    cls: context === "active" ? "wf-collapse-toggle wf-nav-home is-active" : "wf-collapse-toggle wf-nav-home",
  });*/
  const home = toggleWrapper_home.createEl("button", {
    cls: context === "active" ? "wf-collapse-toggle is-active" : "wf-collapse-toggle",
  });
  setIcon(home, "minus"); 
  home.dataset.label = t("state.active");
  home.setAttribute("aria-label", home.dataset.label);
  home.onclick = () => showContext(path, "active",host,file,refresh,theme);

  // ② 横杠组包一层，tooltip 与横杠同层，定位才准
  const bars = rail.createDiv({ cls: "wf-nav-bars" });

  // 【先创建提示框和对应的行】
  const tip = bars.createDiv({ cls: "wf-nav-tooltip" });
  const tooltipRows: HTMLElement[] = [];
  workflows.forEach((w) => {
    const row = tip.createDiv({ cls: "wf-nav-tooltip-row", text: w.title });
    tooltipRows.push(row);
  });

  // 【再创建横杠按钮】
  workflows.forEach((workflow, index) => {
    const item = bars.createEl("button", {
      cls: index === 0 ? "wf-nav-item is-active" : "wf-nav-item",
    });
    item.dataset.label = workflow.title;   
    //item.setAttribute("aria-label", t("view.nav.item", { title: workflow.title }));
    if (index === 0) item.setAttribute("aria-current", "true");
    item.onclick = () => scrollToColumn(path, context, index);

    // 【新增：鼠标滑入滑出时，同步高亮对应的文字行】
    item.onmouseenter = () => tooltipRows[index]?.classList.add("is-hover");
    item.onmouseleave = () => tooltipRows[index]?.classList.remove("is-hover");
  });

  bindNavScrollHighlight(path, context);
  updateNavHighlight(path, context);

  const toggleWrapper_archived = rail.createDiv({ cls: "wf-nav-toggle-wrapper" });
  appendNavExtra(toggleWrapper_archived, path, "archived",  t("view.block.doneFlow"),        context,host,file,refresh,theme);
  const toggleWrapper_cancelled = rail.createDiv({ cls: "wf-nav-toggle-wrapper" });
  appendNavExtra(toggleWrapper_cancelled, path, "cancelled", t("view.block.cancelledFlow"), context,host,file,refresh,theme);
}

/** 抽屉开合时（`setDrawer` 调用）：导航条整体换成新上下文的横杠 */
function syncNavRail(path: string, context: NavContext,
  host: WfViewHost,      // 新增
  file: TFile,           // 新增
  refresh: () => void,   // 新增
  theme: string,         // 新增
  ): void {
  const session = renderSessions.get(path);
  if (session?.navRail === undefined) return;
  fillNavRail(session.navRail, workflowsOf(groupWorkflows(session.ctx.wfDoc), context), context, path, host, file, refresh, theme, session.ctx);
}
//calendar-search
function appendNavExtra(
  parent: HTMLElement,
  path: string,
  key: "archived" | "cancelled",
  label: string,
  context: NavContext,
  host: WfViewHost,      // 新增
  file: TFile,           // 新增
  refresh: () => void,   // 新增
  theme:string,
): void {
  const glyph: Record<"archived" | "cancelled", string> = {
  archived: "bookmark-check",
  cancelled: "pause",
};
  const btn = parent.createEl("button", { cls: "wf-collapse-toggle" });
  setIcon(btn, glyph[key]); 
  btn.dataset.label = label;
  btn.dataset.key = key;
  btn.setAttribute("aria-label", label);
  if (context === key) btn.classList.add("is-active");
  btn.onclick = () => showContext(path, key,host,file,refresh,theme);   // ← 不再 toggle
}

/** 切到目标上下文。已在目标上下文时 no-op（避免重复重建 rail、重置滚动位置）。 */
function showContext(
  path: string, 
  target: NavContext,
  host: WfViewHost,      // 新增
  file: TFile,           // 新增
  refresh: () => void,
  theme: string,         // 新增
  ): void {
  const session = renderSessions.get(path);
  if (session === undefined) return;

  const current = openDrawer.get(path) ?? "active";
  if (current === target) return;   // ← 关键：同目标不重入

  if (target === "active") openDrawer.delete(path);
  else openDrawer.set(path, target);

  const container = lastContainers.get(path);
  const body = container?.querySelector<HTMLElement>(".wf-block-body");
  if (body !== undefined && body !== null) {
    body.dataset.context = target;
    const pane = body.querySelector<HTMLElement>(`.wf-pane-${target}`);
    const scroller = pane?.querySelector<HTMLElement>(".wf-active-scroll")
      ?? pane?.querySelector<HTMLElement>(".wf-drawer-columns");
    if (scroller !== undefined && scroller !== null) scroller.scrollLeft = 0;
  }

  if (session.navRail !== undefined) {
    fillNavRail(
      session.navRail,
      workflowsOf(groupWorkflows(session.ctx.wfDoc), target),
      target,
      path, host, file, refresh, theme, session.ctx
    );
  }
}

/**
 * 某上下文的分栏外层（跳转与高亮都读它）。
 *
 * 为什么现查而不存句柄：整块重渲染会把分栏元素全换掉，句柄必然作废；
 * 现查永远拿到当前 DOM。查询起点是 `lastContainers`（`renderWorkflowView` 每帧更新），
 * Dataview 内嵌与看板两种宿主因此通用。
 */
function columnsOf(path: string, context: NavContext): HTMLElement | undefined {
  const container = lastContainers.get(path);
  if (container === undefined) return undefined;
  if (context === "active") return container.querySelectorAll<HTMLElement>(".wf-active-columns")[0];
  const drawer = container.querySelectorAll<HTMLElement>(`.wf-drawer-${context}`)[0];
  return drawer?.querySelectorAll<HTMLElement>(".wf-drawer-columns")[0];
}

/**
 * 点横杠 → 平滑横滚到第 `index` 栏（§5.2）。
 *
 * `left` 取「该栏 offsetLeft」与「能滚的最大距离」的小者：靠后的窄栏因此滚到最右（目标可见），
 * 而不是停在中间留白。（`.wf-*-columns` 有 `position: relative`，`offsetLeft` 即相对滚动容器的距离。）
 */
function scrollToColumn(path: string, context: NavContext, index: number): void {
  const columns = columnsOf(path, context);
  if (columns === undefined) return;

  const scroller = columns.querySelector<HTMLElement>(".wf-active-scroll") ?? columns;
  const cols = Array.from(scroller.querySelectorAll<HTMLElement>(".wf-column"))
    .filter(el => !el.classList.contains("wf-unclassified"));

  const column = cols[index];
  if (column === undefined) return;

  // ① 乐观高亮：点击即生效，不等滚动
  setActiveNavItem(path, index);

  // ② 上锁：告诉滚动处理器「这次位置变化是我造成的，别动高亮」
  const token = Symbol();
  navScrollLock.set(path, token);

  const maxLeft = Math.max(0, scroller.scrollWidth - scroller.clientWidth);
  const left = Math.min(column.offsetLeft, maxLeft);

  scroller.scrollTo({ left, behavior: "smooth" });
  const releaseOnUserInput = (): void => {
    if (navScrollLock.get(path) === token) navScrollLock.delete(path);
  };
  scroller.addEventListener("wheel", releaseOnUserInput, { passive: true, once: true });
  scroller.addEventListener("touchstart", releaseOnUserInput, { passive: true, once: true });
  scroller.addEventListener("pointerdown", releaseOnUserInput, { passive: true, once: true });

  // ③ 解锁：scrollend 为主，超时兜底（目标位置已就位时不会有 scroll 事件）
  const unlock = (): void => {
    if (navScrollLock.get(path) !== token) return; // 已被下一次点击接管，不要抢
    navScrollLock.delete(path);                    // ← set(path, null) 换成 delete
    //updateNavHighlight(path, context);
  };
  if ("onscrollend" in scroller) {
    scroller.addEventListener("scrollend", unlock, { once: true });
  }
  window.setTimeout(unlock, 500);

  // 注意：这里不要再调 updateNavHighlight！
}

/** 已经挂过 scroll 监听的分栏外层（`WeakSet`：同一元素不重复挂，节点回收后自动失效） */
const navScrollBound = new WeakSet<HTMLElement>();


function bindNavScrollHighlight(path: string, context: NavContext): void {
  const columns = columnsOf(path, context);
  if (columns === undefined) return;

  // 找到真正的横滚容器
  const scroller = columns.querySelector<HTMLElement>(".wf-active-scroll") ?? columns;
  
  if (navScrollBound.has(scroller)) return;
  navScrollBound.add(scroller);

  let scheduled = false;
  scroller.addEventListener(
    "scroll",
    () => {
      if (navScrollLock.get(path) !== undefined) return; // ← 新增：程序化滚动中，跳过位置驱动的高亮
      if (scheduled) return;
      scheduled = true;
      window.requestAnimationFrame(() => {
        scheduled = false;
        updateNavHighlight(path, context);
      });
    },
    { passive: true },
  );
}

/** 重算高亮：最左可见栏 = 第一个 `offsetLeft + offsetWidth > scrollLeft + 1` 的栏（初始 = 第 0 栏） */
function updateNavHighlight(path: string, context: NavContext): void {
  const rail = renderSessions.get(path)?.navRail;
  if (rail === undefined) return;
  const columns = columnsOf(path, context);
  if (columns === undefined) return;

  // 1. 找到真正的横滚容器（兼容旧结构：如果找不到 .wf-active-scroll 就用外层）
  const scroller = columns.querySelector<HTMLElement>(".wf-active-scroll") ?? columns;

  const items = rail.querySelectorAll<HTMLElement>(".wf-nav-item");
  
  // 2. 只取真正的 workflow 列，排除未分类列
  const columnList = Array.from(scroller.querySelectorAll<HTMLElement>(".wf-column"))
    .filter(el => !el.classList.contains("wf-unclassified"));

  if (columnList.length === 0) return;

  // 3. 用真正的滚动容器的 scrollLeft 来计算可视边界
  const edge = scroller.scrollLeft + 1;

  // Phase 33：找不到「可见栏」（例如桩里没有布局、或全部被夹到 0 宽）时留在第 0 栏 ——
  // 原写法每轮先赋值再判断，这种退化情形会停到最后一栏，高亮跟实际完全相反。
  let activeIndex = 0;
  for (let index = 0; index < columnList.length; index += 1) {
    const column = columnList[index];
    if (column.offsetLeft + column.offsetWidth > edge) {
      activeIndex = index;
      break;
    }
  }
  
  items.forEach((item, index) => {
    item.classList.toggle("is-active", index === activeIndex);
    if (index === activeIndex) item.setAttribute("aria-current", "true");
    else item.removeAttribute("aria-current");
  });
}

/* ------------------------------------------------------------------ *
 * Phase 25 ④⑤：上拉抽屉（已完成流 / 已取消流，口径 9）
 * ------------------------------------------------------------------ */

/** 渲染某个上下文的分栏 pane，供 .wf-block-body 内切换显示（原 renderDrawer 的内容部分）。 */
function renderContextPane(
  host: WfViewHost,
  body: HTMLElement,
  file: TFile,
  wfDoc: WfJsonDocument,
  state: "archived" | "cancelled",
  refresh: () => void,
  lanes: LaneIndex,
  laneReuse?: LaneReuse,
  theme = "",
): HTMLElement | undefined {
  const groups = groupWorkflows(wfDoc);
  const list = state === "archived" ? groups.archived : groups.cancelled;
  if (list.length === 0) return undefined; // 空上下文不建 pane，和原来返回 undefined 语义一致

  const pane = body.createDiv({ cls: `wf-pane wf-pane-${state} wf-drawer-${state}` });
  const columns = pane.createDiv({ cls: "wf-drawer-columns" });
  for (const workflow of list) {
    const column = columns.createDiv({ cls: "wf-column" });
    renderLane(host, column, file, workflow, refresh, lanes, undefined, laneReuse,theme);
  }
  return pane;
}

/**
 * 抽屉状态的**唯一写入口** —— 天然互斥：
 *   - `next === null`      → 全关（删键）
 *   - `next === 某个 state` → 只开它（`Map.set` 覆盖即「先关另一个」）
 *
 * 互斥不靠「同时写两个开合标记」，所以不存在两个都开 / 都忘关的中间态。
 */
function setDrawer(
  drawers: { archived?: HTMLElement; cancelled?: HTMLElement },
  path: string,
  next: WorkflowState | null,
  host: WfViewHost,
  file: TFile,
  refresh: () => void,
  theme:string,
): void {
  if (next === null) openDrawer.delete(path);
  else openDrawer.set(path, next);

  const current = openDrawer.get(path);
  for (const key of ["archived", "cancelled"] as const) {
    const drawer = drawers[key];
    if (drawer === undefined) continue; // 该分组没有 workflow：没有抽屉可开合
    const isOpen = current === key;
    drawer.classList.toggle("is-open", isOpen);
    drawer.classList.toggle("is-closed", !isOpen);
    drawer
      .querySelectorAll<HTMLElement>(".wf-drawer-handle")[0]
      ?.setAttribute("aria-expanded", String(isOpen));
  }
  // 导航条整体切到新上下文（§5.1）：有值 → 那个分组；`undefined` → 回到进行中
  syncNavRail(path, current ?? "active",host, file, refresh, theme);
}

/** handle 点击：已开的就是自己 → 关；否则开自己（另一个自动关，互斥由 `openDrawer` 单值保证） */
/*
function onDrawerHandle(
  drawers: { archived?: HTMLElement; cancelled?: HTMLElement },
  path: string,
  state: WorkflowState,
): void {
  setDrawer(drawers, path, openDrawer.get(path) === state ? null : state);
}
*/
/* ------------------------------------------------------------------ *
 * ③ 已归档块（Phase 39）：📦 弹窗 = 磁盘上全部归档文件的扁平列表
 * 数据源 = `<看板目录>/archive/*.wf.json`（`host.archiveBoardFiles()`）；说明文字 / 来源 / 标签
 * 都在归档文件自己的 `workflow.archive` 上（弹窗打开时才读，见下方 `archiveMetaCache`）。
 * ------------------------------------------------------------------ */

/**
 * 📦 弹窗的内容：**磁盘上全部归档文件的扁平列表**（Phase 39 重写）。
 *
 *  - 不按工作流分组：一条归档 = 磁盘上一份 `.wf.json`，行首显示来源节点（`from_node`）；
 *  - 懒加载：列表先用 `host.archiveBoardFiles()` 的文件名占位，**打开弹窗时才**
 *    `host.readArchiveMeta()` 逐个读 json（结果缓存在 `archiveMetaCache`）；
 *  - 每行两个按钮：「编辑归档信息」（改归档文件自己的 `workflow.archive`）与
 *    「打开归档看板」（恒显示）；三段文字与标签折在行内 `<details>` 里；
 *  - 标签筛选统一在顶部（标签同样来自归档文件自己）。
 */
const archiveMetaCache = new Map<string, ArchiveFileMeta | undefined>();

/** 弹窗会话号：关窗时 +1，异步读数回来发现会话变了就丢弃（别往已关的弹窗里写） */
let archiveMetaSession = 0;

function renderArchiveWidget(
  box: HTMLElement,
  host: WfViewHost,
  file: TFile,
  _wfDoc: WfJsonDocument,
  refresh: () => void,
): void {
  const paths = host.archiveBoardFiles();
  const missing = paths.filter((path) => !archiveMetaCache.has(path));

  // 慢路径：还有没读过的归档文件 → 先给一行占位，读完再整块重画（弹窗刚开的一瞬间）
  if (missing.length > 0) {
    box.empty();
    box.createDiv({ cls: "wf-widget-placeholder", text: t("view.archive.loading") });
    const session = archiveMetaSession;
    void Promise.all(
      missing.map(async (path) => {
        let meta: ArchiveFileMeta | undefined;
        try {
          meta = await host.readArchiveMeta(path);
        } catch {
          meta = undefined;
        }
        archiveMetaCache.set(path, meta);
      }),
    ).then(() => {
      // 弹窗已经关了（关了又开是另一个会话）→ 这次读数作废
      if (session !== archiveMetaSession) return;
      renderArchiveWidget(box, host, file, _wfDoc, refresh);
    });
    return;
  }

  box.empty();
  const allTags = host.archiveTags();
  const selected = archiveTagFilter.get(file.path) ?? [];
  const selectedSet = new Set(selected);

  if (allTags.length > 0) {
    const filter = box.createDiv({ cls: "wf-archive-filter" });
    filter.createDiv({ cls: "wf-archive-filter-title", text: t("view.archive.filter") });
    for (const tag of allTags) {
      const chip = filter.createEl("button", { cls: "wf-archive-filter-chip", text: tag });
      chip.classList.toggle("is-active", selectedSet.has(tag));
      chip.onclick = () => {
        const next = new Set(archiveTagFilter.get(file.path) ?? []);
        if (next.has(tag)) next.delete(tag);
        else next.add(tag);
        archiveTagFilter.set(file.path, [...next]);
        refresh();
      };
    }
  }

  const visible = paths.filter((path) => {
    if (selectedSet.size === 0) return true;
    const tags = archiveMetaCache.get(path)?.tag ?? [];
    return tags.some((tag) => selectedSet.has(tag));
  });

  const section = box.createDiv({ cls: "wf-archive-files" });
  //section.createDiv({ cls: "wf-archive-group-title", text: t("view.archive.filesTitle", { count: String(visible.length) }) });
  //section.createDiv({ cls: "wf-archive-files-hint", text: t("view.archive.filesHint") });
  if (visible.length === 0) {
    section.createDiv({ cls: "wf-widget-placeholder", text: t("view.widget.emptyArchive") });
    return;
  }
  for (const path of visible) section.appendChild(archiveFileRow(host, file.path, path, archiveMetaCache.get(path), refresh));
}

/**
 * 一行归档文件：来源节点标题 + 来源 / 时间 + 两个按钮 + 折叠的说明。
 *
 * `meta === undefined`（读不出来）时回落文件名；两个按钮仍然都显示 ——
 * 「打开归档看板」恒显示是本轮定稿的口径（文件缺失由宿主 `Notice` 说明）。
 *
 * `popupPath` = 弹窗所属看板的笔记路径（`widgetPopups` 的键）：点「打开归档看板」
 * 之后要用它把弹窗收掉（见下面 `open.onclick`）。
 */
function archiveFileRow(
  host: WfViewHost,
  popupPath: string,
  path: string,
  meta: ArchiveFileMeta | undefined,
  refresh: () => void,
): HTMLElement {
  const row = detachedDiv("wf-archive-row wf-archive-row--file");
  const baseName = path.slice(path.lastIndexOf("/") + 1).replace(/\.wf\.json$/i, "");
  row.createDiv({ cls: "wf-archive-row-title", text: meta?.fromNode ?? meta?.title ?? baseName });

  const bits: string[] = [];
  if (meta?.fromWorkflow !== undefined) bits.push(t("view.archive.fromWorkflow", { title: meta.fromWorkflow }));
  if (meta?.archivedAt !== undefined) bits.push(t("view.archive.archivedAt", { time: meta.archivedAt }));
  row.createDiv({ cls: "wf-archive-row-meta", text: bits.length > 0 ? bits.join(" · ") : path });

  const actions = row.createDiv({ cls: "wf-archive-row-actions" });
  const edit = actions.createEl("button", { cls: "wf-archive-row-btn", text: t("view.archive.edit") });
  edit.onclick = () => {
    void host.openArchiveMetaEditor(path).then((outcome) => {
      if (outcome.cancelled) return;
      archiveMetaCache.delete(path);
      refresh();
    });
  };
  const open = actions.createEl("button", { cls: "wf-archive-row-btn", text: t("view.archive.open") });
  open.onclick = () => {
    openArchiveFile(host, path);
    // Phase 41：归档看板开在**新页签**上，而弹窗挂在 `document.body`（fixed 全屏遮罩）——
    // 不关就一直盖在新页面上，看起来像「没跳转」。开完立刻收掉本文件的弹窗，
    // 页面才真的停在刚打开的归档看板上。
    closeWidgetPopup(popupPath);
  };

  const details = row.createEl("details", { cls: "wf-archive-row-notes" });
  details.createEl("summary", { cls: "wf-archive-row-notes-title", text: t("view.archive.infoTitle") });
  const lines = meta === undefined ? [] : archiveMetaLines(meta);
  if (lines.length === 0) details.createDiv({ cls: "wf-archive-row-note", text: t("view.archive.infoEmpty") });
  for (const line of lines) details.createDiv({ cls: "wf-archive-row-note", text: line });
  return row;
}

/** 归档文件自己的三段文字 + 标签（空的段不占位） */
function archiveMetaLines(meta: ArchiveFileMeta): string[] {
  const lines: string[] = [];
  if (meta.summary !== undefined) lines.push(t("view.archive.summary", { text: meta.summary }));
  if (meta.idea !== undefined) lines.push(t("view.archive.idea", { text: meta.idea }));
  if (meta.review !== undefined) lines.push(t("view.archive.review", { text: meta.review }));
  if (meta.tag !== undefined && meta.tag.length > 0) lines.push(t("view.archive.tag", { text: meta.tag.join(", ") }));
  return lines;
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
      if (index > 0) line.createSpan({ cls: "wf-card-sep", text: " · " });
      line.createSpan({
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

/**
 * 打开归档文件（`archive/<workflowId>-<nodeId>.wf.json`）。
 *
 * Phase 24 起走宿主：插件把它开成**归档看板**（一个 leaf = 一个看板），不再是 md 源码标签页。
 * 归档文件 不存在时由宿主 `Notice` 提示 —— 这里**不**回落 `openLinkText`，
 * 否则同一个链接会「有时开 md、有时开看板」。
 */
function openArchiveFile(host: WfViewHost, path: string): void {
  host.openArchiveBoard(path);
}

/**
 * 一条泳道：标题行 + 树（根节点在最上）。
 * `colorIndex` 给了就在栏头最前面挂一个颜色方块（Phase 16：只有「正在进行」的分栏传）。
 *
 * C 案（`reuse`）：上一帧同一条泳道的正文元素还在 → 原地挂回来复用。
 * 滚动宿主不换，写回后的重渲染因此没有「先跳到底 / 跳到顶再拨回来」的中间态：
 * 复用的正文按抄下来的 `top` 复原，**新**出现的泳道（打开笔记那一帧 / 新增的流）才滚到底。
 */
function renderLane(
  host: WfViewHost,
  parent: HTMLElement,
  file: TFile,
  workflow: WfWorkflow,
  refresh: () => void,
  lanes: LaneIndex,
  colorIndex?: number,
  reuse?: LaneReuse,
  theme = "",
): void {
  const lane = parent.createDiv({ cls: "wf-lane" });
  const head = lane.createDiv({ cls: "wf-lane-head" });
  fillLaneHead(head, workflow, colorIndex);

  // 记进会话：局部刷新时原位改徽标文字；分组变了（进/出折叠区）则整块重渲染
  lanes.heads.set(workflow.id, head);
  if (colorIndex !== undefined) lanes.colors.set(workflow.id, colorIndex);
  lanes.layout.set(workflow.id, workflow.state ?? "");

  const reused = reuse?.bodies.get(workflow.id);
  const remembered = reuse?.tops.get(workflow.id);
  // 认领属性：整块重渲染时 `captureLaneScroll` / `captureLaneBodies` 靠它把「哪条泳道」对回来
  const body = reused ?? lane.createDiv({ cls: "wf-lane-body" });
  if (reused !== undefined) {
    // 认领过就从快照里摘掉（同 id 只可能有一条泳道，这一步纯属防御）
    reuse?.bodies.delete(workflow.id);
    // 先清空（此时还游离，旧树不会再被挂上去），再把正文挂回新泳道
    body.empty();
    lane.appendChild(body);
  }
  body.setAttribute(LANE_WORKFLOW_ATTR, workflow.id);
  body.appendChild(renderSubtree(host, file, workflow.root, refresh, true, workflow,theme));
  // 复用的正文回到用户看到的位置；新泳道滚到底（打开笔记时最新进度在最下面）
  body.scrollTop = remembered ?? body.scrollHeight;
}

/** 泳道头内容（颜色方块 + 标题 + 徽标）；先 empty 再填，供局部刷新复用 */
function fillLaneHead(head: HTMLElement, workflow: WfWorkflow, colorIndex?: number): void {
  head.empty();
  if (colorIndex !== undefined) {
    // 颜色只来自主题（`--wf-gantt-cN` 与甘特图同时段同色）；内联样式只负责「哪一个色号」
    const chip = head.createSpan({ cls: "wf-lane-color" });
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
 * 用 Obsidian 的**全局** `createDiv()`（返回游离元素，`obsidian.d.ts` 的 `declare global` 区），
 * 单测里由 `views/testDomStub.ts` 的 `installDomStub()` 补同构桩。
 *
 * ⚠️ 不能写 `document.createDiv()`：那个是「创建 + 立刻 append 到接收者」，接收者是 `document`
 * 时会往 document 根节点 append，直接抛 `HierarchyRequestError: Only one element on document allowed`
 * （真实 vault 里必崩；桩里的 `document.createDiv` 故意抛同一个错来守这条）。
 */
function detachedDiv(cls: string): HTMLElement {
  const el = createDiv();
  // 类名可能带空格（卡片是多类名）→ 必须拆成单个 token，classList 不接受含空格的 token
  for (const name of cls.split(/\s+/)) {
    if (name.length > 0) el.classList.add(name);
  }
  return el;
}

/**
 * note 的条目清单（视图侧兜脏数据）：非数组 → 空。
 *
 * **保留原始下标**：方框点击要把 `index` 原样交给引擎的 `toggleNodeNoteDone`
 * （它按 `node.note[index]` 定位），所以不能先 filter 完再取新下标。
 */
function noteItems(node: WfNode): { item: WfNoteItem; index: number }[] {
  const raw = node.note;
  if (!Array.isArray(raw)) return [];
  const list: { item: WfNoteItem; index: number }[] = [];
  raw.forEach((item, index) => {
    if (typeof item?.text === "string" && item.text.trim().length > 0) list.push({ item, index });
  });
  return list;
}

/**
 * 要不要渲染 note 卡片（Phase 20）：开关 ON **且** 至少有一条非空条目。
 * 这是视图侧的唯一判定入口（引擎保证「有开关就有条目」，这里再兜一道脏数据）。
 */
function noteCardVisible(node: WfNode): boolean {
  return node.noteVisible === true && noteItems(node).length > 0;
}

/** 一条 note 只显示第一行（换行符之后的部分截掉；卡片上永远不折行） */
function noteFirstLine(text: string): string {
  const breakAt = text.indexOf("\n");
  return (breakAt >= 0 ? text.slice(0, breakAt) : text).trim();
}

/**
 * note 卡片：节点的附属卡，挂在同一列里、卡片的下一行。
 *
 * 硬约束（Phase 20 契约 §5 + 本轮修订）：
 *  1. **不参与拖拽排序** —— 不加 `wf-card--draggable`，`closest(".wf-card")` 落空即可；
 *  2. 右键**只有一项**「🔖 设置 note 节点…」，与节点菜单里那一项进同一个 Modal
 *     （一个字段仍只有一个编辑入口，只是多开了一扇门）；
 *  3. 装饰一律交给 CSS（连线由 `.wf-note::before` 补，行内方框由 `.wf-note-check` 画）。
 *
 * 一行一条，最多渲染 `host.noteLines()` 条（设置面板的「note 卡片显示条数」；超出**静默截断**）：
 *  - 文字（`done` 缺省）：没有方框，只有一行文本；
 *  - 待办（`done === false`）：空心方框 + 文本，点方框 → 已办；
 *  - 已办（`done === true`）：**对号**（不是实心方块，方框与对号同为 14px 槽位 → 正文照样对齐）
 *    + 文本（删除线），点它 → 待办。
 */
function renderNoteCard(host: WfViewHost, file: TFile, node: WfNode, refresh: () => void,theme:string): HTMLElement {
  const box = detachedDiv("wf-note");
  box.createSpan({ cls: "wf-note-tag", text: t("view.nodeNote.tag") });
  const body = box.createDiv({ cls: "wf-note-body" });

  const limit = Math.max(1, host.noteLines());
  for (const { item, index } of noteItems(node).slice(0, limit)) {
    const row = body.createDiv({ cls: "wf-note-item" });
    if (item.done === undefined) {
      // 文字：没有方框（要变待办 / 已办只能走弹窗的单选框）
      row.addClass("wf-note-item--text");
      row.createSpan({ cls: "wf-note-text", text: noteFirstLine(item.text) });
      continue;
    }
    const done = item.done === true;
    row.addClass(done ? "wf-note-item--done" : "wf-note-item--todo");
    const check = row.createEl("button", {
      cls: "wf-note-check",
      attr: {
        type: "button",
        "aria-label": t(done ? "view.nodeNote.markTodo" : "view.nodeNote.markDone"),
      },
    });
    if (done) check.addClass("wf-note-check--done");
    check.onclick = (event) => {
      event.preventDefault();
      event.stopPropagation();
      void toggleNoteItem(host, file, node, index, refresh,theme);
    };
    row.createSpan({ cls: "wf-note-text", text: noteFirstLine(item.text) });
  }

  box.oncontextmenu = (event) => {
    event.preventDefault();
    event.stopPropagation();
    openMenu(
      { x: event.clientX, y: event.clientY },
      [
        {
          text: t("view.menu.setNodeNote"),
          run: () => void editNote(host, file, node, refresh,theme),
        },
      ],
      overlayTheme(file),
    );
  };
  return box;
}

/**
 * 递归渲染子树，返回一个「列」元素（未挂到父级，由调用方 append）：
 *  列 = [自己的卡片, 子节点行]；子节点行是横向 flex：
 *    第 1 个子节点仍在本列（= 同列下一行），第 2..n 个各自右开一列（行号与第 1 个对齐）。
 * 连线由 `.wf-cell` 的伪元素（竖线 + 横线）用 CSS 画，Phase 4 再考虑换成 SVG。
 *
 * 副作用：把「列 + 卡片」登记进 `nodeRegistry`（键 = `file.path` / `node.id`），
 * 写回成功后 `refreshNodes()` 就能只重建受影响的列；`isRoot` 一并记下，
 * 重建时才知道归档段该走「归档整个工作流」还是「为此及之后归档」。
 *
 * Phase 22：`workflow`（整条流）随递归一路带下去 —— 根节点卡片的右键菜单要拿它做
 * 「📦 归档整个工作流」的资格判断（非根节点用不到，但也一起传，避免两套签名）。
 */
function renderSubtree(
  host: WfViewHost,
  file: TFile,
  node: WfNode,
  refresh: () => void,
  isRoot = false,
  workflow?: WfWorkflow,
  theme = "",
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
          // Phase 21 ⑤：先切 DOM（不等写回），再把折叠态写进 JSON —— 整块重渲染 / 重启都不会丢
          setCollapsed(file.path, node.id, nowCollapsed);
          void persistCollapse(host, file, node.id, nowCollapsed, refresh);
          return nowCollapsed;
        };
  const card = renderCard(host, file, node, refresh, toggle, collapsed, isRoot, workflow,theme);
  column.appendChild(card);
  // Phase 20：note 卡片挂在**列**上（不是卡片里）→ 折叠子节点时它仍在、列重建时自然一起换。
  // 右键只有「设置 note 节点…」一项（见 renderNoteCard）。
  if (noteCardVisible(node)) column.appendChild(renderNoteCard(host, file, node, refresh,theme));
  registerNode(file.path, node.id, { column, card, isRoot, node, workflow });

  if (row !== null) {
    kids.forEach((child, index) => {
      const cell = detachedDiv("wf-cell");
      if (index > 0) cell.addClass("wf-cell--side");
      if (index < kids.length - 1) cell.addClass("wf-cell--has-next");
      cell.createDiv({ cls: "wf-elbow" });
      cell.appendChild(renderSubtree(host, file, child, refresh, false, workflow,theme));
      row.appendChild(cell);
    });
    column.appendChild(row);
  }
  return column;
}

/**
 * 一个节点卡片：
 *  - 底色：`done` → 白底，其余 → 黄底（内容一律黑字）；
 *  - 边框：有资料文件 → 实线，无 → 虚线；重要度 4（Critical）→ 加粗（类名控制，见 styles.css）；
 *  - 左键标题：无动作（Phase 27：纪要锚点已弃用），只留 tooltip 说明右键能做什么；
 *    右键 → 资料文件 / 改状态 / 计时 / 改信息 / 加子节点 / 删除；
 *  - Phase 15：开着「修改节点顺序」时非根卡片可拖（`enableCardDrag`），关时一个 `drag*` 监听都不挂；
 *    Phase 27 M1：根卡片开着时也挂**落点**（`{ draggable: false }`，只接 `after`）；
 *  - Phase 22：`workflow` 只用于右键菜单（根节点给「📦 归档整个工作流」）；
 *    Phase 27 M3：`workflow` 还用于资料查询的 title 兜底（`host.linkedFiles`）。
 */
function renderCard(
  host: WfViewHost,
  file: TFile,
  node: WfNode,
  refresh: () => void,
  toggle?: () => boolean,
  collapsed = false,
  isRoot = false,
  workflow?: WfWorkflow,
  theme = "",
): HTMLElement {
  const links = linksForNode(host, node, workflow);
  const card = detachedDiv(cardClasses(node, links.length));
  const top = card.createDiv({ cls: "wf-card-top" });
  const kids = Array.isArray(node.children) ? node.children : [];

  if (kids.length > 0) {
    const caret = top.createSpan({ cls: "wf-caret", text: collapsed ? "▸" : "▾" });
    if (toggle) {
      caret.onclick = (event) => {
        event.stopPropagation();
        caret.setText(toggle() ? "▸" : "▾");
      };
    }
  }

  const dot = top.createSpan({ cls: `wf-dot wf-dot-${node.status}` });
  dot.title = statusLabel(node.status);

  const titleEl = top.createSpan({ cls: "wf-card-title", text: node.title });
  // Phase 27 M3：标题不再可点跳纪要 —— tooltip 只说「右键能做什么」
  titleEl.title = t("view.card.titleTooltip");

  const meta = card.createDiv({ cls: "wf-card-meta" });
  const progress = node.progress ?? 0;
  const progressMax = node.progress_max ?? 1;
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

  // Phase 45：节点概要已废弃 —— 卡片不再渲染摘要（说明改在工作流的 archive 里）

  // v1.6 进度条：宽度按 progress / progress_max（缺省 0 / 1）；颜色随状态由 CSS 决定
  // Phase 17：四段（标题 / 元信息 / 时间 / 概要）之后才收尾成一条进度；Phase 45 去掉概要段
  const percent = progressPercent(progress, progressMax);
  const bar = card.createDiv({ cls: "wf-card-progress" });
  bar.title = t("view.card.progressTitle", { progress, max: progressMax, percent });
  const fill = bar.createDiv({ cls: "wf-card-progress-fill" });
  fill.style.width = `${percent}%`;

  card.oncontextmenu = (event) => {
    event.preventDefault();
    event.stopPropagation();
    openCardMenu(host, file, node, event, refresh, isRoot, workflow,theme);
  };

  // Phase 15：开着「修改节点顺序」时，**非根**卡片可拖（根节点没有父节点，引擎也会拒绝）
  // Phase 27 M1：根卡片不再是「什么都不挂」—— 它当**落点**（只接 after，见 `CardDragOptions`）
  if (reorderEnabled.has(file.path)) {
    enableCardDrag(host, card, file, node, refresh, isRoot ? { draggable: false } : {});
  }
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
 * 卡片拖拽能力的两档（Phase 27 M1，契约 §3.2）：
 *
 *  - 缺省 = 「源 + 落点」：挂 `draggable` / `dragstart` / `dragend` 与落点三件套（Phase 15 原样）；
 *  - `draggable: false` = **只做落点**：根卡片不能当源，但可以把别的节点拖到它下半当子节点。
 */
interface CardDragOptions {
  /** 默认 true；false = 只做落点（`renderCard` / `applyReorderMode` 对 `isRoot` 传它） */
  draggable?: boolean;
}

/**
 * 把一张卡片变成「拖拽源 + 落点」（Phase 15；Phase 27 M1 拆出「仅落点」档）。
 *
 *  - 落点判定走纯函数 `resolveDrop`：上半 = 插到它之前（同级），下半 = 成为它的子节点；
 *  - 拖拽中的源节点记在模块级 `draggingNodeId`（一次只可能有一个），`drop` / `dragend` 清空；
 *  - Phase 21：`dragstart` 时把「这张卡片当时是否折叠」拍进 `draggingKeepSubtree` ——
 *    折叠节点整棵子树跟着走（引擎 `keepSubtree`），普通节点仍然先把 children 摊回原位；
 *  - Phase 27 M1（`options.draggable === false`）：不挂源的三件套；`dragover` 只在**下半段**亮并
 *    `preventDefault`，上半段既不亮也不可落（`after` 是根节点唯一合法的落法：`before` 等于「插到根
 *    的同级」，根没有同级）。`drop` 里再兜一次底：`before` 直接 return。
 */
function enableCardDrag(
  host: WfViewHost,
  card: HTMLElement,
  file: TFile,
  node: WfNode,
  refresh: () => void,
  options: CardDragOptions = {},
): void {
  const canDrag = options.draggable !== false;
  if (canDrag) {
    card.addClass("wf-card--draggable");
    card.setAttribute("data-node-id", node.id);
    card.draggable = true;

    card.ondragstart = (event) => {
      if (!reorderEnabled.has(file.path)) return;
      draggingNodeId = node.id;
      draggingKeepSubtree = isCollapsed(file.path, node);
      card.classList.toggle("wf-card--dragging", true);
      if (event.dataTransfer) {
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", node.id);
      }
    };

    card.ondragend = () => {
      draggingNodeId = null;
      draggingKeepSubtree = false;
      card.classList.toggle("wf-card--dragging", false);
      clearDropMarks(card);
    };
  }

  card.ondragover = (event) => {
    if (draggingNodeId === null || draggingNodeId === node.id) return;
    const position = resolveDrop(cardRectOf(card), event.clientY);
    if (!canDrag && position === "before") {
      // 根卡片的前半段：不亮、也不拦默认行为（松手不会落到这里）
      clearDropMarks(card);
      return;
    }
    event.preventDefault(); // 不阻止默认行为浏览器不会派发 drop
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    markDropPosition(card, position);
  };

  card.ondragleave = () => {
    clearDropMarks(card);
  };

  card.ondrop = (event) => {
    event.preventDefault();
    event.stopPropagation();
    const position = resolveDrop(cardRectOf(card), event.clientY);
    const movingId = draggingNodeId;
    const keepSubtree = draggingKeepSubtree;
    draggingNodeId = null;
    draggingKeepSubtree = false;
    clearDropMarks(card);
    if (!canDrag && position === "before") return;
    if (movingId === null || movingId === node.id) return;
    void applyReorder(host, file, movingId, node.id, position, keepSubtree, refresh);
  };
}

/**
 * 关掉拖拽（Phase 21 ⑤）：开关原位切「关」时逐张摘掉监听 / 属性 / 抓手光标，**不重画卡片**。
 *
 * 与 `enableCardDrag` 严格对称 —— 摘完卡片就和 Phase 15 之前完全一样（只有右键 / 点击）。
 */
function disableCardDrag(card: HTMLElement): void {
  card.removeClass("wf-card--draggable");
  card.classList.toggle("wf-card--dragging", false);
  clearDropMarks(card);
  card.draggable = false;
  card.removeAttribute("data-node-id");
  card.ondragstart = null;
  card.ondragend = null;
  card.ondragover = null;
  card.ondragleave = null;
  card.ondrop = null;
}

/**
 * drop 落地（Phase 15）：写回 → 成功**整块重渲染**（拓扑变了，局部刷新定位不到新位置；
 * Phase 9 §⑨-9 的串行 + last-wins 已保证不跳位）；引擎拒绝 / 写回失败走 `Notice`。
 * 与现状字节一致（拖回原位）时 `changed = false`：没写盘，也就不用重画、不提示。
 *
 * Phase 21：`keepSubtree` 如实转发给引擎（折叠节点整棵子树跟着走）。
 */
async function applyReorder(
  host: WfViewHost,
  file: TFile,
  movingId: string,
  targetId: string,
  position: ReorderPosition,
  keepSubtree: boolean,
  refresh: () => void,
): Promise<void> {
  const result = await host.moveNode(file, movingId, targetId, position, { keepSubtree });
  if (!result.success) {
    host.notify(t("view.notify.reorderFailed", { reason: result.reason ?? t("view.notify.unknownReason") }));
    return;
  }
  if (!result.changed) return;
  // A 案：改顺序必须整块重渲染；把写回后的分析带过去，`paint` 不用再读盘 + 重校验
  rememberFreshAnalysis(file, result.analysis);
  refresh();
}

/**
 * Phase 21 ⑤：折叠三角点击的落盘（把 `collapsed` 写进 JSON）。
 *
 * 视图已经先切了 DOM，这里只负责写回：
 *  - 成功 / 本来就是这个状态 → 什么都不做（不重渲染、不跳位）；
 *  - 失败 → 提示原因 + 整块重渲染（以 JSON 为准，DOM 跟着回去）。
 */
async function persistCollapse(
  host: WfViewHost,
  file: TFile,
  nodeId: string,
  collapsed: boolean,
  refresh: () => void,
): Promise<void> {
  const result = await host.setNodeCollapsed(file, nodeId, collapsed);
  if (result.success) return;
  host.notify(t("view.notify.collapseFailed", { reason: result.reason ?? t("view.notify.unknownReason") }));
  refresh();
}

/** 卡片的类名：底色 / 边框 / 加粗 / 状态（全部交给 styles.css） */
function cardClasses(node: WfNode, linkCount: number): string {
  const classes = ["wf-card", `wf-card--${node.status}`];
  classes.push(node.status === "done" ? "wf-card--done" : "wf-card--open");
  // Phase 27 M3：实线边框看「有没有资料文件」（`host.linkedFiles` 的返回条数）
  classes.push(linkCount > 0 ? "wf-card--solid" : "wf-card--dashed");
  if (node.importance !== undefined && node.importance >= 4) classes.push("wf-card--bold");
  return classes.join(" ");
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

function openMenu(position: { x: number; y: number }, entries: MenuEntry[], theme: string): void {
  closeMenu();
  ensureMenuBinding();
  const box = document.body.createDiv({ cls: "wf-menu" });
  themeOverlay(box, theme);
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

/**
 * 节点卡片菜单：资料文件 → 状态 → 计时 → 结构（改信息 / note / 加子节点 / 删除）→ 归档。
 *
 * Phase 27 M3：资料那一段改读 `host.linkedFiles()`（反向 YAML 归属）——
 * 每条菜单项 = `📄 文件名`，点了走 `host.openLinkedFile(path)`；
 * 「跳到本文件纪要」整项删除（纪要段已弃用）。
 *
 * Phase 34：菜单最多列 5 份（`LINK_MENU_LIMIT`），超出补一行「… 另有 N 份」；
 * 末尾追加「🗂 编辑节点链接文档…」→ 面板 tab 6（列表 / 刷新 / 新建都在那里）。
 */
function openCardMenu(
  host: WfViewHost,
  file: TFile,
  node: WfNode,
  event: MouseEvent,
  refresh: () => void,
  isRoot = false,
  workflow?: WfWorkflow,
  theme = "",
): void {
  const entries: MenuEntry[] = [];
  const links = linksForNode(host, node, workflow);
  // Phase 34：菜单最多列 5 份（超出走「编辑节点链接文档」看全部）
  const shownLinks = links.slice(0, LINK_MENU_LIMIT);

  for (const link of shownLinks) {
    entries.push({
      text: `${LINKED_FILE_ICON} ${link.title}`,
      run: () => host.openLinkedFile(link.path),
    });
  }
  if (links.length === 0) entries.push({ text: t("view.menu.noLinks"), run: () => undefined });
  else if (links.length > shownLinks.length) {
    entries.push({
      text: t("view.menu.moreLinks", { count: links.length - shownLinks.length }),
      run: () => undefined,
    });
  }
  // Phase 34：列表 + 新建都收进面板 tab 6（不新造 Modal）
  entries.push({
    text: t("view.menu.editLinkDocs"),
    run: () => void editLinkDocs(host, file, node, refresh, theme, workflow),
  });

  for (const status of NODE_STATUSES) {
    if (status === node.status) continue;
    entries.push({
      text: t("view.menu.markAs", { icon: STATUS_ICON[status], label: statusLabel(status) }),
      run: () => void changeStatus(host, file, node, status, refresh,theme),
    });
  }

  // Phase 3 计时：没有进行中 → 「开始这个任务」；本节点正在计时 → 「结束并记录 / 结束并丢弃」；
  // 别的节点正在计时 → 提示先结束它（引擎侧还有一道并发闸门兜底）
  const running = timeAggregates.get(file.path)?.activeEntry;
  if (running === undefined) {
    entries.push({
      text: t("view.menu.startTimer"),
      run: () => void startTimer(host, file, node.id, node.title, refresh,theme),
    });
  } else if (running.nodeId === node.id) {
    entries.push({
      text: t("view.menu.stopRecord"),
      run: () => void stopTimer(host, file, node.id, node.title, "record", refresh,theme),
    });
    entries.push({
      text: t("view.menu.stopDiscard"),
      run: () => void stopTimer(host, file, node.id, node.title, "discard", refresh,theme),
    });
  } else {
    entries.push({ text: t("view.menu.otherTimer", { title: running.nodeTitle }), run: () => undefined });
  }

  // Phase 2 的结构写回：右键菜单只保留「编辑节点信息」一个入口（其余并入面板 tab）
  // Phase 5 ②：分字段改 summary / type / importance / progress / owner / dueAt
  // Phase 36：note / 加子节点 / 删除本节点 已并入同一个面板的对应 tab，不再单独列菜单项
  entries.push({
    text: t("view.menu.editNode"),
    run: () => void editInfo(host, file, node, refresh,theme),
  });

  // Phase 4 归档：整棵子树（含本节点）都已完成才能归档；非根 / 叶子 / 已归档 / 有未完成后代 → 写明原因
  // Phase 22：**根节点**改走「归档整个工作流」—— 资格看整棵树全 done（根 / 叶子流都能归档）
  const archive = node.archive;
  if (archive !== undefined) {
    entries.push({
      text: t("view.menu.openArchive"),
      run: () => host.openArchiveBoardByWorkflowId(archive.workflowId),
    });
  }
  if (isRoot && workflow !== undefined) {
    const verdict = workflowArchiveEligibility(workflow);
    if (verdict.ok) {
      entries.push({
        text: t("view.menu.archiveWorkflow"),
        run: () => void archiveWholeWorkflow(host, file, workflow, refresh,theme),
      });
    } else {
      const reason = verdict.reason ?? t("view.menu.cannotArchive");
      entries.push({
        text: t("view.menu.archiveWorkflowBlocked", { reason }),
        run: () => host.notify(t("view.notify.cannotArchive", { title: workflow.title, reason })),
      });
    }
  } else {
    // 非根：节点级「为此及之后归档」（Phase 4 口径，行为一字未改）；
    // 根节点但拿不到 workflow（防御）时，`archiveEligibility` 会给「根节点不能归档」这条原因
    const eligibility = archiveEligibility(node, isRoot);
    if (eligibility.ok) {
      entries.push({
        text: t("view.menu.archiveFrom"),
        run: () => void archiveBranch(host, file, node, refresh,theme),
      });
    } else {
      const reason = eligibility.reason ?? t("view.menu.cannotArchive");
      entries.push({
        text: t("view.menu.archiveFromBlocked", { reason }),
        run: () => host.notify(t("view.notify.cannotArchive", { title: node.title, reason })),
      });
    }
  }

  openMenu({ x: event.clientX, y: event.clientY }, entries, overlayTheme(file));
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
  theme:string,
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
  await refreshNodes(host, file, [node.id], refresh, result.analysis,theme);
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
  theme:string,
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
  // Phase 31：开始计时就展开顶部总览 —— 用户要立刻看到正计时器 / 「继续上次」那一行。
  // 必须放在 `refreshNodes` 之前：局部刷新只切已存在元素的类，`fallback()` 整块重渲染则按
  // `overviewCollapsed` 重建 `.wf-overview` —— 先改状态，两条路径都拿到「展开」。
  setOverviewCollapsed(file.path, false);
  await refreshNodes(host, file, result.changedNodeIds, refresh, result.analysis,theme);
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
  theme:string,
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
  // Phase 31：结束**不**收起总览 —— 收起来会打断「马上开下一个任务」的动作；
  // 这时候总览里正好是「继续上次」那一行（见 Phase 17/18 契约「继续上次」）。
  await refreshNodes(host, file, result.changedNodeIds, refresh, result.analysis,theme);
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
 *     A 案：写回方法的返回里已经带了「写回后」的 `analysis`（`fresh`），
 *     那就**不重读**，直接拿它重建受影响的列；
 *  2. 只重建 `changedNodeIds` 命中的列：被重建的列整棵子树由新 DOM 覆盖，命中的后代直接跳过；
 *  3. 总览（含正计时器与方块阵）/ 页脚 / 泳道头只原位换内容 —— 树上的展开状态与滚动位置因此保住。
 */
async function refreshNodes(
  host: WfViewHost,
  file: TFile,
  changedNodeIds: readonly string[],
  fallback: () => void,
  fresh: AnalyzeResult| undefined, // 允许为空
  theme:string,
): Promise<void> {
  const registry = nodeRegistry.get(file.path);
  const session = renderSessions.get(file.path);
  const targets = [...new Set(changedNodeIds)];
  if (registry === undefined || session === undefined || targets.length === 0) {
    fallback();
    return;
  }

  const result = fresh ?? (await host.analyzeFile(file));
  if (!result.found || result.hasError || result.document === undefined) {
    fallback();
    return;
  }
  const wfDoc = result.latestDocument ?? result.document;
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
    handles.column.replaceWith(renderSubtree(host, file, entry.node, fallback, handles.isRoot, handles.workflow,theme));
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
  refreshChrome(host, file, fallback, session, wfDoc, result, new Date(),theme);
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
  theme:string,
): void {
  const time = aggregateTimeEntries(wfDoc);
  timeAggregates.set(file.path, time);
  // Phase 16：侧边栏按钮 / 弹窗读的是这同一份上下文 → 就地换字段（挂在按钮上的闭包不必重挂）
  session.ctx.wfDoc = wfDoc;
  session.ctx.time = time;
  session.ctx.result = result;
  session.ctx.now = now;
  session.ctx.refresh = refresh;
  // Phase 29：overview 只剩计时 / 大标题 → 整块重填
  fillOverview(session.overview, session.ctx);
  // Phase 25：导航条横杠的条数 / 标题跟着分组走（抽屉上下文不变，仍是 `openDrawer` 里那个）
  syncNavRail(file.path, openDrawer.get(file.path) ?? "active", host, file, refresh, theme);
  // Phase 18 ③：大标题在局部刷新时跟着设置项变（设置面板改了引导性话语 → 下一次刷新即生效）
  //if (isAttached(session.title)) session.title.setText(appTitleText(host));
  session.footer.setText(footerText(result));
  for (const workflow of wfDoc.workflows ?? []) {
    const head = session.lanes.heads.get(workflow.id);
    if (head !== undefined && isAttached(head)) {
      fillLaneHead(head, workflow, session.lanes.colors.get(workflow.id));
    }
  }
  session.lanes.layout = layoutOf(wfDoc);
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
 * 「✏️ 编辑节点信息…」（Phase 5 ②）：分字段收集 `summary` / `type` / `importance` /
 * `progress` / `owner` / `dueAt` → 插件 `setNodeInfo`（引擎 `editNodeInfo`：patch 覆盖 /
 * clear 删除 / 其余不动）→ 局部刷新该节点那一列。
 *
 * Phase 25：表单落点 = 右侧面板 tab 1（`openNodePanel(file, node, "info")`），
 * 结果与刷新链路与旧 Modal 完全一致。
 */
async function editInfo(host: WfViewHost, file: TFile, node: WfNode, refresh: () => void,
  theme:string,): Promise<void> {
  const outcome = await host.openNodePanel(file, node, "info", undefined, theme);
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
  await refreshNodes(host, file, result.changedNodeIds, refresh, result.analysis,
  theme);
}

/**
 * 「🗂 编辑节点链接文档…」（Phase 34）：面板 tab 6 里浏览匹配到的资料文件、
 * 新建带四键 frontmatter 的链接文档、改本节点的「新建相对路径」。
 *
 * 面板可以连续新建多份（不关窗），结果一次性带回：
 *  - `createdPaths.length > 0` → 「已新建 N 份」；
 *  - 只改了目录 → 「已更新新建相对路径」；
 *  - 只是看了看（`changed = false`）→ 不提示、不刷新（与取消一致）。
 */
async function editLinkDocs(
  host: WfViewHost,
  file: TFile,
  node: WfNode,
  refresh: () => void,
  theme: string,
  workflow?: WfWorkflow,
): Promise<void> {
  const outcome = await host.openNodePanel(file, node, "links", workflow, theme);
  if (outcome.cancelled || outcome.result === undefined) return; // 取消不是失败：不提示、不重渲染
  const result = outcome.result;
  if (!result.success) {
    host.notify(t("view.notify.writeFailed", { reason: result.reason ?? t("view.notify.unknownReason") }));
    return;
  }
  if (!result.changed) return;
  if (result.createdPaths.length > 0) {
    host.notify(t("view.notify.linkDocsCreated", { title: node.title, count: result.createdPaths.length }));
  } else if (result.linkDirChanged) {
    host.notify(t("view.notify.linkDirSaved", { title: node.title }));
  }
  await refreshNodes(host, file, result.changedNodeIds, refresh, result.analysis, theme);
}

/**
 * 「🔖 设置 note 节点…」（Phase 20）：面板 tab「设置 note 节点」（条目表格 + 显示开关）→
 * 插件 `setNodeNote`（引擎 `editNodeNote`：条目逐条 trim、空数组两键全删、OFF 不写 `false`）→
 * 局部刷新该节点那一列（note 卡片随列重建自动出现 / 消失）。
 *
 * Phase 36：note 节点并入「编辑节点信息」同一张面板，本函数只是 note 卡右键的快捷入口。
 */
async function editNote(host: WfViewHost, file: TFile, node: WfNode, refresh: () => void,
  theme:string,): Promise<void> {
  const outcome = await host.openNodePanel(file, node, "note", undefined, theme);
  if (outcome.cancelled || outcome.result === undefined) return; // 取消不是失败：不提示、不重渲染
  const result = outcome.result;
  if (!result.success) {
    host.notify(t("view.notify.writeFailed", { reason: result.reason ?? t("view.notify.unknownReason") }));
    return;
  }
  if (!result.changed) {
    host.notify(t("view.notify.nodeNoteUnchanged", { title: node.title }));
    return;
  }
  host.notify(t("view.notify.nodeNoteUpdated", { title: node.title, suffix: warningSuffix(result.issues) }));
  await refreshNodes(host, file, result.changedNodeIds, refresh, result.analysis,
  theme);
}

/**
 * note 卡片上的方框点击（Phase 20 修订）：待办 ↔ 已办。
 *
 * 与 `changeStatus` 同形：写回成功 → 局部刷新该节点那一列；
 * `changed = false`（引擎判没变）→ 什么都不做；失败 → 提示原因。
 */
async function toggleNoteItem(
  host: WfViewHost,
  file: TFile,
  node: WfNode,
  index: number,
  refresh: () => void,
  theme:string,
): Promise<void> {
  const result = await host.toggleNodeNote(file, node.id, index);
  if (!result.success) {
    host.notify(t("view.notify.writeFailed", { reason: result.reason ?? t("view.notify.unknownReason") }));
    return;
  }
  if (!result.changed) return;
  await refreshNodes(host, file, result.changedNodeIds, refresh, result.analysis,
  theme);
}

/**
 * 「📦 为此及之后归档…」（Phase 4）：面板 tab 4 收集三段文字 → 插件侧建归档文件 + 本文件浓缩 →
 * 局部刷新浓缩节点那一列（`refreshNodes` 会顺带重画 ③ 已归档块，新归档立即出现在下面）。
 * 归档文件 可能是幂等重试复用的（`reusedArchiveFile`），提示里说清，免得用户以为没生效。
 */
async function archiveBranch(host: WfViewHost, file: TFile, node: WfNode, refresh: () => void,theme:string): Promise<void> {
  const outcome = await host.openNodePanel(file, node, "archive", undefined, theme);
  if (outcome.cancelled || outcome.result === undefined) return;
  await reportArchive(host, file, node.title, outcome.result, refresh,theme);
}

/**
 * 「📦 归档整个工作流…」（Phase 22）：面板 tab 4 收集三段文字 → 插件侧建归档文件 + 把整条流压成
 * 「根节点 + archive + workflow_archive 台账」→ 局部刷新根节点那一列。
 *
 * 与 `archiveBranch` 只差「入口是谁」：表单是同一张（`ArchiveNodeModal`），结果形状
 * （`ArchiveNodeResult`）与提示文案完全共用；target 由**传不传 `workflow`** 决定
 * （契约 §6.1 选项卡 4：面板不合并二者语义）。
 */
async function archiveWholeWorkflow(
  host: WfViewHost,
  file: TFile,
  workflow: WfWorkflow,
  refresh: () => void,
  theme:string,
): Promise<void> {
  const outcome = await host.openNodePanel(file, workflow.root, "archive", workflow, theme);
  if (outcome.cancelled || outcome.result === undefined) return;
  await reportArchive(host, file, workflow.title, outcome.result, refresh,theme);
}

/**
 * 归档结果的统一反馈（节点级 / 整条流共用）：失败 → 说明原因；没变 → 明说；
 * 成功 → 一条提示（含压缩节点数 / 归档文件 地址 / 幂等复用的说明）+ 局部刷新。
 */
async function reportArchive(
  host: WfViewHost,
  file: TFile,
  title: string,
  result: ArchiveNodeResult,
  refresh: () => void,
  theme:string,
): Promise<void> {
  if (!result.success) {
    host.notify(t("view.notify.archiveFailed", { reason: result.reason ?? t("view.notify.unknownReason") }));
    return;
  }
  if (!result.changed) {
    host.notify(t("view.notify.unchanged", { title }));
    return;
  }
  const target = result.archiveFile ?? "archive/";
  if (result.appended === true) {
    host.notify(
      t("view.notify.archiveAppended", {
        title,
        count: result.nodeCount ?? 0,
        target,
        suffix: warningSuffix(result.issues),
      }),
    );
    await refreshNodes(host, file, result.changedNodeIds, refresh, result.analysis,
    theme,);
    return;
  }
  const reused = result.reusedArchiveFile === true ? t("view.notify.archiveReused") : "";
  host.notify(
    t("view.notify.archived", {
      title,
      count: result.nodeCount ?? 0,
      target,
      reused,
      suffix: warningSuffix(result.issues),
    }),
  );
  await refreshNodes(host, file, result.changedNodeIds, refresh, result.analysis,
  theme,);
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
  const upgraded = result.upgradedFrom !== undefined ? t("view.notify.upgraded") : "";
  const tail = result.hasIssue ? t("view.notify.issuesHint") : t("view.notify.noIssues");
  return t("view.notify.schemaLine", { version, upgraded, error, warning, info, tail });
}
