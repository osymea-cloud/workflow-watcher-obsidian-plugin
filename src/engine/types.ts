/**
 * wfjson 数据模型（Schema v1.9）
 *
 * 规范文档：doc/datacontact/data_ixd_v01.md（v1.0 历史版本见 doc/datacontact/data_ixd_v0.md）
 * 讨论结论：doc/datacontact/data_ixd_discuss.md（决策 1~5）
 * Phase 3 契约：doc/datacontact/data_ixd_phase3_contract.md（`timeEntries` + `archive`，跳过从未发布的 1.2）
 * Phase 22 契约：doc/datacontact/data_ixd_discuss_interact_v0.21md《Phase 22 定稿契约 · 工作流归档》
 *   （文件级 `workflow_archive` 台账；仍是 **1.9 内的可选字段**，理由见该契约 §①）
 *
 * 本目录（src/engine）的三条硬约束：
 *  1. 不依赖 obsidian 包，纯 TypeScript + 标准库，可在纯 Node 环境直接单测；
 *  2. 只使用「可擦除语法」（无 enum / namespace / 参数属性），以便 `node --test` 直接运行 .ts；
 *  3. 所有相对 import 带显式 .ts 后缀（esbuild 与 Node 均可解析）。
 */

/** wfjson 代码块的语言标签（一文件一块，内含 workflows 数组） */
export const WFJSON_LANG = "wfjson";

/**
 * 插件自有目录：**md 与 json 都放这里**，名字与插件同名（`_workflowwatcher`）。
 *
 * 路径规则：笔记 `A/B/笔记.md` → `_workflowwatcher/笔记~3f9a1c2b7d.wf.json`。
 *  - **第一层**：所有控制文件都直接躺在 `_workflowwatcher/` 下，一眼看全，不用点开镜像目录树；
 *  - **唯一性**：`~<noteKey>` 是笔记完整路径算出的 10 位十六进制（`sidecar.ts` 的 `noteKeyFor`），
 *    同名的两份笔记（不同目录）各有各的侧车，绝不互相覆盖；改名 / 移动时 key 跟着变，
 *    由 `main.ts` 的 rename 钩子把侧车一起改名；
 *  - 同一个 key 也写进侧车 JSON（`noteKey`）与笔记 frontmatter（`wf-key`），两边互为凭据；
 *  - 主看板的 md 也放在这里，且**名字里就带同一个键**（`_workflowwatcher/main~<key>.md` +
 *    `_workflowwatcher/main~<key>.wf.json`，只差扩展名）→ 一眼看出是一对；命名规则见 `mainBoard.ts`；
 *    文件里已经带键时 `noteKeyFor` / `sidecarPathFor` 不再补第二个键（幂等）。
 *
 * M1.6 之前的老侧车是**镜像路径**（`_workflowwatcher/A/B/笔记.wf.json`）：`legacySidecarPathFor()`
 * 仍能算出来，读盘时当兜底。文件夹改名前的本体见 `LEGACY_WFJSON_FOLDER`（`onload` 一次性搬过来）。
 * 目录名以 `_` 开头（Obsidian 列表里靠前），扩展名是 `.json` / 主看板的 `.md`；
 * 正文里的 block 锚点（`^nd-xxx`）与纪要段仍然留在笔记里（它们是内容，不是数据）。
 */
export const WFJSON_FOLDER = "_workflowwatcher";

/**
 * **当前**看板文件目录（设置项 `boardFolder`）的模块级状态。
 *
 * 默认是 `WFJSON_FOLDER`（`_workflowwatcher`）。为什么不是「常量」：
 * 用户可以在设置里把看板目录改成自己的文件夹（比如 `workflows`），
 * 而侧车路径 / 主看板路径 / 归档路径都是「运行时现算」的 ——
 * 常量在模块加载时就定死了，改设置不会生效。
 *
 * 模式与 `i18n.ts` 的 `currentLang` 完全一致：模块级可变值 + getter，
 * 由 `main.ts` 在 `onload` / 设置变更时调 `setBoardFolder()` 写一次。
 * 引擎内部所有路径函数一律读 `boardFolderOf()`，**不要**直接读 `WFJSON_FOLDER`
 * （那个常量只表示「出厂默认值」）。
 */
let activeBoardFolder: string = WFJSON_FOLDER;

/** 看板目录校验：反斜杠 → 正斜杠、去首尾空白与首尾 `/`；空串 / 非字符串回落 `WFJSON_FOLDER` */
export function normalizeBoardFolder(value: unknown): string {
  if (typeof value !== "string") return WFJSON_FOLDER;
  const trimmed = value
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\/+|\/+$/g, "")
    .replace(/\/{2,}/g, "/");
  return trimmed.length > 0 ? trimmed : WFJSON_FOLDER;
}

/** 当前看板文件目录（设置 `boardFolder`；默认 `_workflowwatcher`） */
export function boardFolderOf(): string {
  return activeBoardFolder;
}

/** 设置当前看板文件目录（`main.ts` 在 `onload` / 设置变更时调用；非字符串回落默认值） */
export function setBoardFolder(value: unknown): void {
  activeBoardFolder = normalizeBoardFolder(value);
}

/** 当前备份镜像目录：`<boardFolder>/backup`（Phase 25 的镜像落点） */
export function backupFolderOf(): string {
  return `${activeBoardFolder}/backup`;
}

/**
 * 备份镜像目录（Phase 25）：插件自管数据文件的「可恢复副本」都放这里。
 *
 * 每次 `_workflowwatcher/` 下的 md / `.wf.json`（以及 `archive/*.md`）被创建或修改，
 * `main.ts` 的事件钩子就按 `sidecar.ts` 的 `backupPathFor()` 往 `_workflowwatcher/backup/`
 * 写一份**同名同键**的 `.bak` 副本（md 也带上 `~<noteKey>`，于是 md 与它的侧车同名、只差后缀）。
 * 删除数据文件**不删副本** —— 这正是备份的目的；恢复 = 把 `.bak` 去掉、改回原名。
 */
export const WFJSON_BACKUP_FOLDER = `${WFJSON_FOLDER}/backup`;

/**
 * 插件目录改名前的旧名字（M1.6 及更早）。
 *
 * **只用于一次性搬家**：`main.ts` 的 `onload` 若发现老目录在、新目录不在，就整目录改名过来
 * （里面的老镜像路径一字不动，`legacySidecarPathFor()` 兜底照样读得到）。
 * 读写路径一律只用 `WFJSON_FOLDER` —— 别在业务代码里引用这个名字。
 */
export const LEGACY_WFJSON_FOLDER = "_wfjson";

/** 当前实现的 Schema 版本（写回统一以本版本落盘；Phase 9 起为 1.9） */
export const SCHEMA_VERSION = "1.9";

/**
 * 「未分类」伪工作流的保留 id（Phase 27 M2）。
 *
 * 它不是一条真实工作流，只是一条**普通 `WfWorkflow`**：`id` 取这个保留值、`state` 缺省（进行中），
 * 于是 schema 不用改、`walkWorkflow` / 一致性检查天然可用。`root` 只当容器（视图**不渲染** root 卡片），
 * 未分类节点 = `root.children`。
 *
 * 口径：
 *  - 懒创建（第一次「+ 新建」或第一次拖进列头时才写进 `workflows[]`，见 `unclassified.ts`）；
 *  - **不算一条工作流**：`groupWorkflows` 把它单独分桶，`activeWorkflowCount` 不计它；
 *    但它的 `root.children` 计入「状态总览」的 a/B 与 `nodeTotal`（隐藏 root 不计）。
 */
export const UNCLASSIFIED_WORKFLOW_ID = "wf-unclassified";

/**
 * 历史 Schema 版本：仍然可读（解析时在内存中升格，见 upgrade.ts）。
 * 1.1 = Phase 1（`workflow.state` / `originId`）；1.3 = Phase 3（`timeEntries` / `archive`）；
 * 1.6 = Phase 7/8（`progress` / `progress_max` 与 1-4 重要度；`links[]` 尚未废弃）。
 * 从未发布的 1.2 / 1.4 / 1.5 / 1.7 / 1.8 不在白名单内（直接跳过）。
 */
export const LEGACY_SCHEMA_VERSIONS: readonly string[] = ["1.0", "1.1", "1.3", "1.6"];

/**
 * 本插件支持的 schemaVersion 白名单（白名单**并列**）：
 * 1.0 / 1.1 老数据不得因升级而报错；解析保持只读，仅在内存中升格为最新版供渲染，
 * 版本落盘推迟到用户下一次主动修改（写回统一落最新版）。
 */
export const SUPPORTED_SCHEMA_VERSIONS: readonly string[] = [...LEGACY_SCHEMA_VERSIONS, SCHEMA_VERSION];

/* ------------------------------------------------------------------ *
 * 枚举（用 as const 数组代替 enum，保证语法可擦除）
 * ------------------------------------------------------------------ */

/** 节点完成情况 */
export const NODE_STATUSES = ["todo", "doing", "done", "blocked", "cancelled"] as const;
export type NodeStatus = (typeof NODE_STATUSES)[number];

/**
 * 工作流级**人工状态**（v1.1）：与节点 `status` 完全解耦。
 * 只有 `archived` / `cancelled` 两个合法取值；**"进行中" 靠省略该键表达**（不可写 "doing"）。
 */
export const WORKFLOW_STATES = ["archived", "cancelled"] as const;
export type WorkflowState = (typeof WORKFLOW_STATES)[number];

/** 外链类型（决定渲染形式：md→[[ ]]、image→![[ ]]、web→链接） */
export const LINK_TYPES = ["md", "web", "image", "file"] as const;
export type LinkType = (typeof LINK_TYPES)[number];

/** 外链用途 */
export const LINK_ROLES = ["detail", "source"] as const;
export type LinkRole = (typeof LINK_ROLES)[number];

/** 节点/工作流之间的关系语义 */
export const RELATION_KINDS = ["dependsOn", "related", "reference"] as const;
export type RelationKind = (typeof RELATION_KINDS)[number];

/**
 * 进度条边界（v1.6：`progress` / `progress_max` 均为 0-999 的整数）。
 * 两个字段相互独立、**不再与 status 联动**；`progress > progress_max` 不报错，只给提示级 `PROGRESS_OVER_MAX`。
 */
export const PROGRESS_MIN = 0;
export const PROGRESS_MAX = 999;
/** `progress` 缺省值（省略该键等价于 0） */
export const PROGRESS_DEFAULT = 0;
/** `progress_max` 缺省值（省略该键等价于 1） */
export const PROGRESS_MAX_DEFAULT = 1;

/** 重要程度 / 紧急程度边界（v1.6 收敛为 1-4；可读性文字见 IMPORTANCE_LABELS） */
export const IMPORTANCE_MIN = 1;
export const IMPORTANCE_MAX = 4;

/* ------------------------------------------------------------------ *
 * 中文标签（供渲染层 / 报错提示 / AI 阅读复用）
 * ------------------------------------------------------------------ */

/** v1.6：progress 不再是 0-5 量表，此常量只用于报错提示里的边界说明 */
export const PROGRESS_SCALE_HINT = `${PROGRESS_MIN}-${PROGRESS_MAX} 的整数（progress 缺省 ${PROGRESS_DEFAULT}，progress_max 缺省 ${PROGRESS_MAX_DEFAULT}）`;

/** 重要程度的可读性文字（v1.6，见 data_ixd_v0.5.md §2.5；4 在视图里以黑体强调） */
export const IMPORTANCE_LABELS: Readonly<Record<number, string>> = {
  1: "P1-Low",
  2: "P2-Medium",
  3: "P3-High",
  4: "P4-Critical",
};

/** 紧急程度的可读性文字（v1.6，见 data_ixd_v0.5.md §2.5） */
export const URGENCY_LABELS: Readonly<Record<number, string>> = {
  1: "P1-Low",
  2: "P2-Medium",
  3: "P3-High",
  4: "P4-Immediate",
};

/** 进度百分比（0-100，四舍五入）；progress_max ≤ 0 时视为 100% 以免除零 */
export function progressPercent(progress: number | undefined, progressMax: number | undefined): number {
  const value = progress ?? PROGRESS_DEFAULT;
  const max = progressMax ?? PROGRESS_MAX_DEFAULT;
  if (!Number.isFinite(value) || value <= 0) return 0;
  if (!Number.isFinite(max) || max <= 0) return 100;
  return Math.min(100, Math.round((value / max) * 100));
}

export const STATUS_LABELS: Readonly<Record<NodeStatus, string>> = {
  todo: "未开始",
  doing: "进行中",
  done: "已完成",
  blocked: "受阻",
  cancelled: "已取消",
};

export const WORKFLOW_STATE_LABELS: Readonly<Record<WorkflowState, string>> = {
  archived: "已归档",
  cancelled: "已取消",
};

/** `workflow.state` 缺省（未写该键）时的口语化称呼 */
export const WORKFLOW_STATE_DEFAULT_LABEL = "进行中";

/** 展示用：`state` 缺省 → 「进行中」，否则取中文标签 */
export function workflowStateLabel(state: WorkflowState | undefined): string {
  return state === undefined ? WORKFLOW_STATE_DEFAULT_LABEL : WORKFLOW_STATE_LABELS[state];
}

export const LINK_TYPE_LABELS: Readonly<Record<LinkType, string>> = {
  md: "笔记",
  web: "网页",
  image: "图片",
  file: "文件",
};

export const LINK_ROLE_LABELS: Readonly<Record<LinkRole, string>> = {
  detail: "详细资料",
  source: "结论来源",
};

export const RELATION_KIND_LABELS: Readonly<Record<RelationKind, string>> = {
  dependsOn: "前置依赖",
  related: "弱关联",
  reference: "参考",
};

/** 被认为是图片的目标扩展名（用于 links[].type === "image" 的一致性检查） */
export const IMAGE_EXTENSIONS: readonly string[] = [
  ".png",
  ".jpg",
  ".jpeg",
  ".gif",
  ".webp",
  ".svg",
  ".bmp",
  ".avif",
  ".tiff",
];

/** frontmatter 摘要字段（决策 5：仅保留少量可检索的扁平面包屑） */
export const FRONTMATTER_FIELDS = {
  tags: "wf-tags",
  status: "wf-status",
  titles: "wf-titles",
  updated: "wf-updated",
  /** v1.6 前端主题偏好（插件管理，可选；**不从 JSON 聚合**） */
  theme: "wf-theme",
  /**
   * Phase 24 M1.6：笔记身份键（= 侧车文件名里的 `~<key>`，也写在侧车 JSON 的 `noteKey`）。
   *
   * 可选：老笔记没有它，下次写回自动补上；抄了别人的侧车时它会与 JSON 的 `noteKey` 对不上，
   * 由一致性检查报 `FRONTMATTER_KEY_MISMATCH`。
   */
  key: "wf-key",
  /**
   * Phase 27 M3：**资料归属**（写在资料文件自己的 frontmatter 上，用户手写 / 由「给当前文件打标签」命令写入）。
   *
   * 与上面四个「由 JSON 聚合、必须存在」的摘要字段完全不同：
   *  - 这四个是**人读**的（`wf-workflow` / `wf-node` = 工作流标题 / 节点标题），改名后需手改 YAML；
   *  - 带 `-id` 的两个是**机器权威键**（搬库 / 改名后仍然精确命中）；
   *  - 写回侧（`buildFrontmatterSummary` / `writeBackNote`）**绝不覆盖**这四条。
   *
   * 解析见 `linkAffiliation.ts`（反向索引），只认 `.md` 文件。
   */
  linkWorkflow: "wf-workflow",
  linkNode: "wf-node",
  linkWorkflowId: "wf-workflow-id",
  linkNodeId: "wf-node-id",
} as const;

/**
 * 资料归属的四条 frontmatter 键（Phase 27 M3）。
 *
 * **不在** `FRONTMATTER_FIELD_NAMES` 里：那四个是「由 JSON 聚合、必须存在」的摘要字段，
 * 这四条是用户手写的关联键，缺失是常态。
 */
export const FRONTMATTER_LINK_FIELDS: readonly string[] = [
  FRONTMATTER_FIELDS.linkWorkflow,
  FRONTMATTER_FIELDS.linkNode,
  FRONTMATTER_FIELDS.linkWorkflowId,
  FRONTMATTER_FIELDS.linkNodeId,
];

/** 由 JSON 聚合生成、必须存在的四个摘要字段（`wf-theme` / `wf-key` 不在其中） */
export const FRONTMATTER_FIELD_NAMES: readonly string[] = [
  FRONTMATTER_FIELDS.tags,
  FRONTMATTER_FIELDS.status,
  FRONTMATTER_FIELDS.titles,
  FRONTMATTER_FIELDS.updated,
];

/* ------------------------------------------------------------------ *
 * 数据模型
 * ------------------------------------------------------------------ */

/**
 * 外部资料引用（统一承载 detail 详细资料 / source 结论来源）。
 *
 * @deprecated Phase 9 起超链接唯一来源改为正文纪要段（`<!-- wf-note:begin:* -->` 之间的 markdown 链接）。
 * Schema 保留该字段以兼容旧文件，但引擎**读时忽略**；写回时 `migrateLinksToNoteSections`
 * 会把内容迁进正文并删除该键，新数据不再产生。请改用 `analysis.noteLinks` / `NoteSection` API。
 */
export interface WfLink {
  id: string;
  type: LinkType;
  /** 裸目标：笔记名 / 文件名 / URL（不带 [[ ]]、![[ ]]、!） */
  target: string;
  role?: LinkRole;
  label?: string;
  reason?: string;
}

/** 节点关系（统一承载 dependsOn 依赖 / related 弱关联 / reference 参考） */
export interface WfRelation {
  /** 目标节点/工作流的 id（允许跨文件，跨文件时本插件 v1.0 不做解析） */
  target: string;
  kind: RelationKind;
  note?: string;
}

/** 状态变更事件 */
export interface WfStatusEvent {
  from: NodeStatus;
  to: NodeStatus;
  at: string;
  by?: string;
  note?: string;
}

/**
 * 计时条目（v1.3，`Node.timeEntries` 的元素）。
 *
 * 约定（Phase 3 契约 §4.1）：
 *  - `startAt` / `date` 必填；`endAt` / `hours` 进行中**省略该键**（不写 `null`）；
 *  - `date` = `toDateOnly(startAt)`（不做 UTC 换算）；跨零点整段计入开始那天，不拆分；
 *  - `hours` = `Math.round((endAt-startAt)/3600000 * 10) / 10`，≥ 0；与 `estimate` 无关。
 */
export interface WfTimeEntry {
  /** 计时会话开始时间（≈ formatLocalIso(now)） */
  startAt: string;
  /** = toDateOnly(startAt)：方块阵按它聚合 */
  date: string;
  /** 结束时间；进行中省略 */
  endAt?: string;
  /** 本次时长（小时，1 位小数）；进行中省略 */
  hours?: number;
}

/**
 * 浓缩归档标记（v1.3，`Node.archive`）。
 *
 * Phase 39 定稿：**节点上只留一个指针** —— 归档文件里的 workflow id。
 * 三段文字 / 归档时间 / 来源（原工作流名 + 原节点名）/ 标签全部搬到**归档文件自己的**
 * `workflow.archive`（见 `WfWorkflowArchive`），节点侧不再持有任何说明文字。
 *
 * 这样「一条归档记录 = 磁盘上那份归档文件」，改说明只改它自己，不会和原看板的两份副本打架。
 */
export interface WfArchive {
  /**
   * 归档文件里的 workflow id：与归档文件侧 `workflow.id` 同值
   * （节点级归档时也等于那份文件 `workflow.originId` 指向的浓缩节点 id）。
   * 视图「打开归档看板」/ 幂等重试认领都靠它在 `archive/` 里定位。
   */
  workflowId: string;
}

/**
 * 归档元数据（Phase 39，`workflow.archive`）。
 *
 * 为什么不放节点 / 台账：归档记录 = 磁盘上那份 `.wf.json`；
 * 说明文字与来源天然属于它，节点侧只留 `WfArchive.workflowId` 作指针。
 *
 * Phase 45：`archivedAt` / `from_workflow` / `from_node` 改为**选填** ——
 * 「修改工作流」弹窗允许**任意**工作流直接填写 summary / idea / review / tag 四条复盘说明；
 * 普通工作流没有「归档」这件事，因此不会合成那三个事实键（只有真归档文件才有）。
 *
 * `from_workflow` / `from_node` 是**归档那一刻**的原工作流 / 原节点标题（快照，改名后不追）。
 * 四条说明文字与标签都是选填（空串 = 省略该键）。
 */
export interface WfWorkflowArchive {
  /** 归档时间（**日期 + 精确到分钟**，如 "2026-10-12 14:30"）；普通工作流填说明时不写 */
  archivedAt?: string;
  /** 来源工作流标题（归档发生的那条流）；普通工作流填说明时不写 */
  from_workflow?: string;
  /** 来源节点标题（被浓缩的节点 / 整条流归档时的根节点）；普通工作流填说明时不写 */
  from_node?: string;
  /** 概括（归档表单 / 修改工作流弹窗选填） */
  summary?: string;
  /** 底层原理 / 启发（归档表单 / 修改工作流弹窗选填） */
  idea?: string;
  /** 怎么提高效率 / 接下来做什么（归档表单 / 修改工作流弹窗选填） */
  review?: string;
  /** 归档标签（Phase 39：枚举来自 archive_tag.yaml，多选；缺省 = 无标签） */
  tag?: string[];
}

/**
 * 整条工作流的归档台账条目（Phase 22，`WfJsonDocument.workflow_archive[]`）。
 *
 * 与 `WfArchive` 的区别：`WfArchive` 挂在**浓缩节点**上（节点级 / 工作流级都用它），
 * 这里记的是「**哪条工作流**被整体归档了、它的根节点在哪」——
 *  - `workflowId` / `title`：原工作流（浓缩后它仍留在 `workflows[]` 里，只是根节点变成了浓缩节点）；
 *  - `noteAnchor`：浓缩根节点在**本文正文**里的纪要锚点（跳转 / 定位用，与节点的 `noteAnchor` 同一个值）；
 *  - `archive`：与根节点 `archive` **同一份内容**（Phase 39 起只剩 `{ workflowId }`；
 *    三段文字 / 时间 / 来源都在归档文件自己的 `workflow.archive` 上）。
 *
 * 为什么把台账放在文件级而不是塞进 `workflows[]`：`workflows[].originId` 在归档文件 里指向原节点，
 * 归档文件 自身是独立的完整工作流（甚至还能再归档），所以「这条流是从本文整体归档走的」
 * 这件事只能由**原文件**记录；放文件级也不会影响 `workflows` 的 Schema 与视图渲染。
 */
export interface WfWorkflowArchiveEntry {
  /** 原工作流 id */
  workflowId: string;
  /** 原工作流标题 */
  title: string;
  /** 浓缩根节点在正文里的纪要锚点（如 "^nd-uuid-001"） */
  noteAnchor: string;
  /** 归档标记（与浓缩根节点的 `archive` 同值） */
  archive: WfArchive;
}

/**
 * note 卡片里的一条（Phase 20 修订：`note` 由单条 string 改成「文字 / 待办」集合）。
 *
 * 三态由 `done` 的**存在性 + 布尔值**表达（沿用仓库「缺省即默认」的惯例）：
 *  - `done` 键不存在 → **文字**（纯一行说明，卡片上不画方框）；
 *  - `done === false` → **待办**（卡片上一枚空心方框，点一下变已办）；
 *  - `done === true` → **已办**（实心方框 + 删除线，再点一下回待办）。
 *
 * 「待办 → 文字」的切换只走「设置 note 节点」弹窗的单选框（删掉 `done` 键即可），
 * 卡片上的方框只在「待办 ↔ 已办」之间翻转。
 */
export interface WfNoteItem {
  /** 单条正文（引擎内部 trim；trim 后为空的行一律丢弃） */
  text: string;
  /** 三态开关：缺省 = 文字 / false = 待办 / true = 已办 */
  done?: boolean;
}

/** 工作流节点（同构递归，叶子 children 为 []） */
export interface WfNode {
  id: string;
  title: string;
  /**
   * @deprecated Phase 45 废弃：节点的说明文字改为工作流级 `workflow.archive` 的四条复盘说明。
   * 旧文件里的值照读（卡片不再展示、表单不再编辑、引擎不再写回）；缩节归档时随 `PRUNED_FIELDS` 删掉。
   */
  summary?: string;
  /** 节点类型：决策 / 调查 / 执行 / 验证 / 资料 …（自由字符串） */
  type?: string;
  status: NodeStatus;
  importance?: number;
  urgency?: number;
  collapsed?: boolean;
  /** 已完成量（v1.6，0-999，缺省 0；与 status 完全解耦） */
  progress?: number;
  /** 总量（v1.6，0-999，缺省 1；与 progress 相互独立） */
  progress_max?: number;
  owner?: string;
  startAt?: string;
  updatedAt?: string;
  completedAt?: string;
  dueAt?: string;
  /**
   * @deprecated v1.6 起从 Schema 删除，仅为兼容旧文件保留声明；引擎读到一律忽略、也不再写回。
   */
  estimate?: string | number;
  /** @deprecated v1.6 起从 Schema 删除，仅为兼容旧文件保留声明；引擎读到一律忽略。 */
  tags?: string[];
  aliases?: string[];
  /**
   * @deprecated Phase 9 起不再使用（超链接改存正文纪要段）：Schema 保留声明以兼容旧文件，
   * 引擎读时忽略、编辑表单不再提供，也不再写回。
   */
  links_relative_path?: string;
  /**
   * Phase 20：渲染区的附注条目（**文字 / 待办 的集合**，每条一行）。
   *
   * ⚠️ **与正文纪要段的 `noteAnchor` 无关**：`noteAnchor` 是同文件纪要段的 block id
   * （超链接的载体），`note` 只是卡片下方那张附注卡片的正文。两者别合并。
   *
   * 元素三态见 `WfNoteItem`；空数组等于没有（引擎会把 `note` / `noteVisible` 一并删键）。
   */
  note?: WfNoteItem[];
  /**
   * Phase 20：note 卡片的药丸开关。**缺省 = false（OFF）**；
   * OFF 时本键不写（沿用仓库「缺省即默认」的惯例，同 `collapsed`）。
   * 关掉开关不删文本 —— 文本仍在 `note` 里，随时可以再打开。
   */
  noteVisible?: boolean;
  /**
   * @deprecated Phase 27：正文纪要段范式已弃用。
   *
   * Schema **保留**（旧文件要能读，`additionalProperties: false` 需要它继续被声明），
   * 但引擎不再生成、不再读，写回时会从 JSON 里剥离这个键。
   */
  noteAnchor?: string;
  /**
   * @deprecated Phase 9：超链接唯一来源改为正文纪要段；Schema 保留（旧文件照读），
   * 引擎读时忽略、写回时迁移进正文并删除本键。
   */
  links?: WfLink[];
  /** @deprecated v1.6 起从 Schema 删除，仅为兼容旧文件保留声明；引擎读到一律忽略、不再写回。 */
  relations?: WfRelation[];
  children: WfNode[];
  statusHistory?: WfStatusEvent[];
  /** 计时会话（v1.3）：进行中的那条省略 `endAt` / `hours` */
  timeEntries?: WfTimeEntry[];
  /** 浓缩归档标记（v1.3，字段结构 Phase 4 定稿；见 WfArchive） */
  archive?: WfArchive;
  aiContext?: string;
  /**
   * Phase 34：**新建链接文档的默认目录**（vault 相对路径，如 `资料/读书计划`）。
   *
   *  - 缺省 / 空串 = 没设置过（表单回落「第一份已匹配文档的所在目录」，再回落库根）；
   *  - 新建子节点时由 `appendChildNode` **继承父节点的值**（用户设置过的目录整棵子树通用）；
   *  - 与四个 `wf-*` frontmatter 键无关：那些键写在资料文件上，这里只是「下次新建放哪」的偏好；
   *  - Schema **1.9 内的可选字段**（不升版本）。
   */
  linkDir?: string;
}

/** 工作流：一个文件可承载多个工作流，每个工作流一棵树 */
export interface WfWorkflow {
  id: string;
  title: string;
  /**
   * 工作流级人工状态（v1.1）：`archived`（已归档）| `cancelled`（已取消）。
   * **缺省即「进行中」**（省略该键，不要写 "doing"）；与节点 status 解耦，由人交互设置。
   */
  state?: WorkflowState;
  /**
   * 归档来源（v1.1）：该 workflow 由归档创建时 = 原文档浓缩节点的 `id`；
   * 非归档创建时省略该键。仅作引用，不参与 id 前缀 / 唯一性检查。
   */
  originId?: string;
  /** 工作流级进度概览（v1.6：0-999，与 root 的 progress 相互独立，不再做大小比较） */
  progress?: number;
  /** 工作流级进度总量（v1.6：0-999，缺省 1） */
  progress_max?: number;
  /**
   * Phase 39：归档元数据（`workflow.archive`）。
   *
   * 归档文件自己的 workflow 带完整的 `archivedAt` / `from_*`；Phase 45 起**任意**工作流也可以只写
   * summary / idea / review / tag 四条复盘说明（「修改工作流」弹窗），此时不写那三个事实键。
   * 节点侧只留 `node.archive.workflowId` 指向归档文件的 workflow.id。
   * 归档文件被再次归档 / 追加时，`archivedAt` 刷新为本次时间，`from_*` 保持首次归档时的快照。
   */
  archive?: WfWorkflowArchive;
  root: WfNode;
}

/** 一个 wfjson 代码块对应的完整文档 */
export interface WfJsonDocument {
  schemaVersion: string;
  /** 文件级稳定 id */
  id: string;
  updatedAt?: string;
  workflows: WfWorkflow[];
  /**
   * Phase 24 M1.6：**笔记身份键**（10 位十六进制）= 侧车文件名里的 `~<key>`，
   * 也写进笔记 frontmatter 的 `wf-key`，两边互为凭据。
   *
   * 由笔记的 vault 路径算出（`sidecar.ts` 的 `noteKeyFor`），**不是**文档内容的一部分：
   * 插件每次写回都按当前路径重算（复制 / 改名后自愈）。老数据缺省 = 还没写过这一版，
   * 语义与以前一致 —— 与 Phase 20/22 一样是 **1.9 内的可选字段**，不升 schemaVersion。
   */
  noteKey?: string;
  /**
   * Phase 28：**归档快照的归档时间**（ISO 8601，本地时区带偏移）。
   *
   * 只有归档文件（`archive/<workflowId>-<nodeId>.wf.json`）会写；普通笔记 / 主看板缺省 = 不是归档快照。
   * 归档看板的 21 天方块阵 / 甘特图默认拿它当窗口结束日（否则回看归档时一片空白）。
   * 与 Phase 20/22 一样是 **1.9 内的可选字段**，不升 schemaVersion。
   */
  archivedAt?: string;
  /**
   * Phase 22：**整条工作流归档**的台账（文件级；一条工作流一条记录，最多与 `workflows` 等长）。
   *
   * 只有「归档整个工作流」会写它；节点级的「为此及之后归档」不写（那种只有节点的 `archive`）。
   * 缺省 = 本文没有整条工作流归档过；写得下是因为 Schema 里它是可选字段（v1.9 内）。
   */
  workflow_archive?: WfWorkflowArchiveEntry[];
}

/* ------------------------------------------------------------------ *
 * 轻量类型守卫
 * ------------------------------------------------------------------ */

export function isNodeStatus(value: unknown): value is NodeStatus {
  return typeof value === "string" && (NODE_STATUSES as readonly string[]).includes(value);
}

export function isLinkType(value: unknown): value is LinkType {
  return typeof value === "string" && (LINK_TYPES as readonly string[]).includes(value);
}

/** 是否为合法的工作流级状态（"doing" 不是合法取值：进行中靠省略该键表达） */
export function isWorkflowState(value: unknown): value is WorkflowState {
  return typeof value === "string" && (WORKFLOW_STATES as readonly string[]).includes(value);
}

export function isLinkRole(value: unknown): value is LinkRole {
  return typeof value === "string" && (LINK_ROLES as readonly string[]).includes(value);
}

export function isRelationKind(value: unknown): value is RelationKind {
  return typeof value === "string" && (RELATION_KINDS as readonly string[]).includes(value);
}

/** 是否为「普通对象」（排除 null 与数组） */
export function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
