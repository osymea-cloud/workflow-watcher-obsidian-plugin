/**
 * wfjson 数据模型（Schema v1.9）
 *
 * 规范文档：doc/datacontact/data_ixd_v01.md（v1.0 历史版本见 doc/datacontact/data_ixd_v0.md）
 * 讨论结论：doc/datacontact/data_ixd_discuss.md（决策 1~5）
 * Phase 3 契约：doc/datacontact/data_ixd_phase3_contract.md（`timeEntries` + `archive`，跳过从未发布的 1.2）
 *
 * 本目录（src/engine）的三条硬约束：
 *  1. 不依赖 obsidian 包，纯 TypeScript + 标准库，可在纯 Node 环境直接单测；
 *  2. 只使用「可擦除语法」（无 enum / namespace / 参数属性），以便 `node --test` 直接运行 .ts；
 *  3. 所有相对 import 带显式 .ts 后缀（esbuild 与 Node 均可解析）。
 */

/** wfjson 代码块的语言标签（一文件一块，内含 workflows 数组） */
export const WFJSON_LANG = "wfjson";

/**
 * 外置 JSON（侧车）目录（v0.7 §⑧）。
 *
 * 路径镜像规则：笔记 `A/B/笔记.md` → `_wfjson/A/B/笔记.wf.json`。
 * 目录名以 `_` 开头（Obsidian 列表里靠前），扩展名是 `.json`，因此不会被当成笔记；
 * 正文里的 block 锚点（`^nd-xxx`）与纪要段仍然留在笔记里（它们是内容，不是数据）。
 */
export const WFJSON_FOLDER = "_wfjson";

/** 当前实现的 Schema 版本（写回统一以本版本落盘；Phase 9 起为 1.9） */
export const SCHEMA_VERSION = "1.9";

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
} as const;

/** 由 JSON 聚合生成、必须存在的四个摘要字段（`wf-theme` 不在其中） */
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
 * Phase 3 **只声明结构**；**字段结构于 Phase 4 定稿**（见 `doc/datacontact/data_ixd_v01.md`
 * §2.10 与 `data_ixd_discuss_interact_v0.3.md`《归档功能定稿契约（Phase 4）》）。
 * 因 v1.3 的 `archive` 当时仅声明、磁盘上无 v1.3 归档数据，故**不升 `schemaVersion`**
 * （仍留在 `"1.3"` 内定稿）；归档写回逻辑（浓缩节点处理 / 归档 md 生成 / 「已归档」块）**待落地**。
 */
export interface WfArchive {
  /** 概括（归档表单选填） */
  summary?: string;
  /** 底层原理 / 启发（归档表单选填） */
  idea?: string;
  /** 怎么提高效率 / 接下来做什么（归档表单选填） */
  review?: string;
  /** 归档时间（**日期 + 精确到分钟**，如 "2026-10-12 14:30"） */
  archivedAt: string;
  /**
   * @deprecated v0.7 §⑨-2：归档时**不再写入**本字段（地址改存正文纪要段的
   * `归档：[[...]]` 行）；Schema 保留声明以兼容旧文件，读时作为回落值。
   */
  file?: string;
  /**
   * 归档 md 里的 workflow id：与归档 md 侧 `workflow.originId`
   * （= 本浓缩节点 `id`）**双向引用**。
   */
  workflowId: string;
  /** 归档 md 写入时的 `schemaVersion`（当前 `"1.9"`），供按归档文件的版本解析 */
  schemaVersion: string;
}

/** 工作流节点（同构递归，叶子 children 为 []） */
export interface WfNode {
  id: string;
  title: string;
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
  /** 同文件纪要的 block id（如 "^nd-uuid-001"） */
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
  root: WfNode;
}

/** 一个 wfjson 代码块对应的完整文档 */
export interface WfJsonDocument {
  schemaVersion: string;
  /** 文件级稳定 id */
  id: string;
  updatedAt?: string;
  workflows: WfWorkflow[];
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
