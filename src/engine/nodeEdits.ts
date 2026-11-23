/**
 * 节点编辑（Phase 2 右键菜单的三个写回功能 + Phase 5 ② 编辑节点信息；纯函数、零 Obsidian 依赖）。
 *
 * 定位：本模块只回答「内存里的文档该改成什么样」，不写盘、不弹窗。
 * 与插件层（main.ts 的 WfViewHost 实现）一一对应：
 *   editNodeLinks   → setNodeLinks    （编辑资源列表）
 *   appendChildNode → addChildNode    （添加子节点）
 *   removeNode      → deleteNode      （删除本节点）
 *   editNodeInfo    → setNodeInfo     （编辑节点信息：summary / type / importance / progress / owner / dueAt）
 *   editNodeNote    → setNodeNote     （Phase 20：note 卡片正文 + 显示开关）
 *
 * 写盘统一由上层套进 `mutateFile` → `applyMutation`（安全闸门 → 1.0→1.1 升格 →
 * 三段写回 → 幂等校验），因此这里的每个函数都必须做到「要么把文档改对，要么什么都不动」：
 * 校验不过一律返回 `ok=false` + 中文原因，调用方据此 `reject`（文本保持原样）。
 *
 * 约定（与契约 doc/datacontact/data_ixd_phase2_contract.md 第 4 节对齐）：
 *  - 受影响节点的 `updatedAt` 由本模块显式维护（applyMutation 只刷新 document.updatedAt）；
 *  - 删除节点时把它的 timeEntries / children / relations 摊平进父节点，
 *    旧文件里的成对纪要段落由 `removedNoteAnchors` 上报给写回层清掉。
 */

import { createNode, type NewNodeInput } from "./factory.ts";
import { anchorForNode } from "./ids.ts";
import { findNode, findParentNode } from "./tree.ts";
import { formatLocalIso, isIsoDateOrDateTime } from "./time.ts";
import {
  IMPORTANCE_MAX,
  IMPORTANCE_MIN,
  PROGRESS_MAX,
  PROGRESS_MIN,
  type WfJsonDocument,
  type WfLink,
  type WfNode,
  type WfNoteItem,
  type WfRelation,
} from "./types.ts";
import { sanitizeTitle, type NoteLinkMerge } from "./wfjsonWrite.ts";

/** 三个编辑操作的共同返回：`ok=false` 时文档未被改动，只有 `reason` 有意义 */
export interface NodeEditResult {
  ok: boolean;
  /** ok=false 时的原因（直接给用户看的中文） */
  reason?: string;
  /** 受影响的节点 id（供上层做局部刷新） */
  changedNodeIds: string[];
}

/** 编辑资源列表的返回 */
export interface NodeLinksEditResult extends NodeEditResult {
  /**
   * 新内容与现状完全一致（Modal 里点了保存但一个字没改）→ 上层可以跳过写回，
   * 不白白刷新 `updatedAt` / 不产生一次无意义的三段重写。
   */
  unchanged?: boolean;
}

export interface AddChildEditResult extends NodeEditResult {
  /** ok=true 时新节点的 id（写回后正文会补上 `### 标题 ^id`） */
  childId?: string;
  /** 标题清洗给出的提示（如含 # / | / [ / ]），供上层转成 Notice */
  warnings: string[];
}

export interface DeleteNodeEditResult extends NodeEditResult {
  /** ok=true 时的父节点 id（供上层定位重刷范围） */
  parentId?: string;
  /** 需要从正文删掉的纪要锚点（被删节点自己的段落） */
  removedNoteAnchors: string[];
  /** Phase 9：把被删节点纪要段里的超链接行合并进父节点纪要段（`mutateFile` 透传给写回层） */
  mergeNoteSections: NoteLinkMerge[];
}

export interface AddChildInput {
  title: string;
  importance?: number;
  urgency?: number;
  /** v1.6：已完成量（缺省 0） */
  progress?: number;
  /** v1.6：总量（缺省 1） */
  progress_max?: number;
  /** Phase 9：负责人 / 截止时间（表单同一行填写；空 = 不写） */
  owner?: string;
  dueAt?: string;
  /** @deprecated v1.6 已弃用（仅为兼容旧调用方保留） */
  tags?: string[];
}

/* ------------------------------------------------------------------ *
 * 1) 编辑资源列表
 * ------------------------------------------------------------------ */

/** 深拷贝一条链接（只保留 schema 1.1 定义的字段，避免写入未知键被 Schema 拒掉） */
function cloneLink(link: WfLink): WfLink {
  const copy: WfLink = { id: link.id, type: link.type, target: link.target };
  if (link.role !== undefined) copy.role = link.role;
  if (link.label !== undefined) copy.label = link.label;
  if (link.reason !== undefined) copy.reason = link.reason;
  return copy;
}

/**
 * 整表替换 `node.links`（Modal 侧已按 Schema 校验过内容）。
 *
 * @deprecated Phase 9：视图不再提供 links 编辑器（超链接在正文纪要段维护）。
 * 仅为兼容旧调用方 / 旧测试保留；新代码请直接改正文段（`replaceNoteSectionContent`）。
 *
 * 写回后的幂等校验仍是最后一道闸门：若出现 link 级 error（如 DUPLICATE_LINK_ID），
 * `applyMutation` 会整笔回滚，上层拿到 success=false + issues。
 *
 * 内容与现状一致时返回 `unchanged=true` + 空 `changedNodeIds`（文档一动不动）。
 */
export function editNodeLinks(
  document: WfJsonDocument,
  nodeId: string,
  links: readonly WfLink[],
  now: Date = new Date(),
): NodeLinksEditResult {
  const node = findNode(document, nodeId);
  if (!node) return { ok: false, reason: `节点 ${nodeId} 不存在（可能已被删除）`, changedNodeIds: [] };

  const next = links.map(cloneLink);
  if (JSON.stringify(node.links ?? []) === JSON.stringify(next)) {
    return { ok: true, changedNodeIds: [], unchanged: true };
  }

  node.links = next;
  node.updatedAt = formatLocalIso(now);
  return { ok: true, changedNodeIds: [nodeId] };
}

/* ------------------------------------------------------------------ *
 * 2) 添加子节点
 * ------------------------------------------------------------------ */

/**
 * 在 `parentId` 的 children 末尾追加一个新节点。
 * 默认值（契约 §2 已锁定）：status=todo、progress=0、startAt=now、id/noteAnchor 由工厂生成、
 * children=[]；todo 不写 statusHistory。title 先经 `sanitizeTitle`（空 / 含换行直接拒绝）。
 */
export function appendChildNode(
  document: WfJsonDocument,
  parentId: string,
  input: AddChildInput,
  now: Date = new Date(),
): AddChildEditResult {
  const parent = findNode(document, parentId);
  if (!parent) {
    return { ok: false, reason: `节点 ${parentId} 不存在（可能已被删除）`, changedNodeIds: [], warnings: [] };
  }

  const sanitized = sanitizeTitle(input.title);
  if (!sanitized.ok) {
    return {
      ok: false,
      reason: sanitized.reason ?? "标题不合法",
      changedNodeIds: [],
      warnings: sanitized.warnings,
    };
  }

  const childInput: NewNodeInput = {
    title: sanitized.title,
    status: "todo",
    progress: input.progress ?? 0,
    progress_max: input.progress_max ?? 1,
    startAt: formatLocalIso(now),
  };
  if (input.importance !== undefined) childInput.importance = input.importance;
  if (input.urgency !== undefined) childInput.urgency = input.urgency;
  if (input.owner !== undefined && input.owner.trim().length > 0) childInput.owner = input.owner.trim();
  if (input.dueAt !== undefined && input.dueAt.trim().length > 0) childInput.dueAt = input.dueAt.trim();
  if (input.tags !== undefined && input.tags.length > 0) childInput.tags = [...input.tags];
  // Phase 34：父节点设置过「新建链接文档」的默认目录 → 新子节点继承（整棵子树共用一套落点）
  if (parent.linkDir !== undefined && parent.linkDir.length > 0) childInput.linkDir = parent.linkDir;
  const child = createNode(childInput, now);

  if (!Array.isArray(parent.children)) parent.children = [];
  parent.children.push(child);
  parent.updatedAt = formatLocalIso(now);
  return { ok: true, childId: child.id, changedNodeIds: [parentId, child.id], warnings: sanitized.warnings };
}

/* ------------------------------------------------------------------ *
 * 3) 删除本节点（先摊平进父节点，再从树里摘掉）
 * ------------------------------------------------------------------ */

/** v1.3：带 `archive`（浓缩归档标记）的节点不允许删除 */
function hasArchive(node: WfNode): boolean {
  return node.archive !== undefined;
}

/** v1.3：删除节点时把它的计时条目按原顺序并入父节点（父节点没有则整体搬过去） */
function mergeTimeEntries(parent: WfNode, node: WfNode): void {
  const extra = node.timeEntries;
  if (!Array.isArray(extra) || extra.length === 0) return;
  const current = parent.timeEntries;
  parent.timeEntries = Array.isArray(current) ? [...current, ...extra] : [...extra];
}

/**
 * relations 合并：出边上移父节点，过滤 `target == 被删节点`（父节点上会变成悬空）
 * 与 `target == 父节点`（会变成 RELATION_SELF_DEPENDENCY error）。
 * 入边（别的节点指向被删节点）不主动清理，留给一致性检查以 RELATION_TARGET_UNKNOWN（warning）暴露。
 */
function mergeRelations(parent: WfNode, node: WfNode, removedId: string, parentId: string): void {
  const moved: WfRelation[] = [...(parent.relations ?? []), ...(node.relations ?? [])].filter(
    (relation) => relation.target !== removedId && relation.target !== parentId,
  );
  if (moved.length > 0) parent.relations = moved;
}

/** 被删节点的全部后代 id（先序；供上层清理 DOM 注册表） */
function descendantIds(node: WfNode): string[] {
  const ids: string[] = [];
  for (const child of node.children ?? []) ids.push(child.id, ...descendantIds(child));
  return ids;
}

export interface RemoveNodeOptions {
  /**
   * @deprecated Phase 27：纪要段范式已弃用 —— 删除节点只「删旧段」，不再有「合并链接」语义。
   * 参数保留只为兼容旧调用方（传什么都一样）。
   */
  mergeNoteSection?: boolean;
}

/**
 * 删除节点：
 *  1. 根节点（无父）与带 archive 的节点拒绝；
 *  2. `parent.timeEntries` += `node.timeEntries`（v1.3 计时条目按原顺序并入）；
 *  3. `parent.children` 用 `node.children` 原位替换（等价于「删掉本节点、子节点上移」）；
 *  4. `parent.relations` += `node.relations`（过滤将成悬空 / 自依赖的两类目标）；
 *  5. completedAt 不参与合并；`parent.updatedAt` 刷新；
 *  6. Phase 27：`removedNoteAnchors` 只用于把旧文件里成对的纪要段**清掉**；
 *     `mergeNoteSections` 恒为空数组（「把链接并进父节点」的语义已随纪要段弃用）。
 *
 * `links[]` 已弃用：这里不再把 `node.links` 并进 `parent.links`（那会让旧数据在 JSON 里继续流传）。
 */
export function removeNode(
  document: WfJsonDocument,
  nodeId: string,
  now: Date = new Date(),
  options: RemoveNodeOptions = {},
): DeleteNodeEditResult {
  const node = findNode(document, nodeId);
  if (!node) {
    return {
      ok: false,
      reason: `节点 ${nodeId} 不存在（可能已被删除）`,
      changedNodeIds: [],
      removedNoteAnchors: [],
      mergeNoteSections: [],
    };
  }

  const parent = findParentNode(document, nodeId);
  if (!parent) {
    return {
      ok: false,
      reason: `「${node.title}」是工作流根节点，不能删除`,
      changedNodeIds: [],
      removedNoteAnchors: [],
      mergeNoteSections: [],
    };
  }
  if (hasArchive(node)) {
    return {
      ok: false,
      reason: `「${node.title}」是归档来源节点（带 archive），不能删除`,
      changedNodeIds: [],
      removedNoteAnchors: [],
      mergeNoteSections: [],
    };
  }

  mergeTimeEntries(parent, node);

  const index = parent.children.indexOf(node);
  if (index >= 0) parent.children.splice(index, 1, ...(node.children ?? []));
  const promotedIds = descendantIds(node);

  mergeRelations(parent, node, node.id, parent.id);
  parent.updatedAt = formatLocalIso(now);

  // Phase 27：纪要段范式已弃用 —— 只上报「删旧段」，不再把 `links[]` 并进父节点纪要段。
  // 旧文件若还留着 `^<id>` 的成对纪要段，写回时按这个锚点整段清掉。
  const anchor = node.noteAnchor ?? anchorForNode(node.id);

  return {
    ok: true,
    parentId: parent.id,
    changedNodeIds: [parent.id, ...promotedIds],
    removedNoteAnchors: [anchor],
    mergeNoteSections: [],
  };
}

/* ------------------------------------------------------------------ *
 * 4) 编辑节点信息（Phase 5 ②；契约见 data_ixd_discuss_interact_v0.4.md《Phase 5 定稿契约》）
 *
 * 只碰这 5 个字段：type / importance / progress / owner / dueAt（外加必填的 title）
 * （`summary` 自 Phase 45 起废弃，不再由本模块读写）。
 * （`title` / `status` / `links` / `tags` … 各有专门的入口，这里一律不动）。
 *
 * 语义（**逐字段**）：`patch` 覆盖 / `clear` 删除 / 其余不动。
 *  - `clear` 只对「`patch` 没给的字段」生效：同一字段两处都出现时 `patch` 赢（Modal 不会这么发）；
 *  - 字符串字段 `trim` 后为空 → 等价于删除该键（Schema 的 `TEXT` 是 `minLength: 1`，不写空串）；
 *  - 数值 / 时间字段就地校验（与 Schema 同一套边界），不合法 → `ok=false` + 中文原因，文档一动不动；
 *  - 一个字都没改 → `unchanged=true`（不刷 `updatedAt`、不产生一次无意义的三段重写）。
 * ------------------------------------------------------------------ */

/** 可编辑的节点信息字段（v1.6 Modal 的分字段表单与此一一对应，顺序即展示顺序） */
export const NODE_INFO_FIELDS = [
  "title",
  "progress",
  "progress_max",
  "owner",
  "dueAt",
  "type",
  "importance",
  "urgency",
] as const;
export type NodeInfoFieldKey = (typeof NODE_INFO_FIELDS)[number];

/** 字段中文名（Modal 标签 / 报错提示共用）；带 ★ 的是必填项（Modal 用红色 * 标出） */
export const NODE_INFO_LABELS: Readonly<Record<NodeInfoFieldKey, string>> = {
  title: "标题",
  progress: "已完成",
  progress_max: "总量",
  owner: "负责人",
  dueAt: "截止时间",
  type: "类型",
  importance: "重要度",
  urgency: "紧急度",
};

/** 必填字段（Modal 显示红色 *；清空会被拒绝） */
export const NODE_INFO_REQUIRED_FIELDS: readonly NodeInfoFieldKey[] = ["title"];

/** `type` 输入框的 datalist 建议值（自由字符串，这里只给常用几个） */
export const NODE_TYPE_SUGGESTIONS: readonly string[] = ["决策", "调查", "执行", "验证", "资料"];

/** 节点信息的分字段改动：`patch` = 覆盖，`clear` = 删除（见本节顶部语义） */
export interface NodeInfoPatch {
  title?: string;
  type?: string;
  importance?: number;
  urgency?: number;
  progress?: number;
  progress_max?: number;
  owner?: string;
  dueAt?: string;
}

export interface NodeInfoEditResult extends NodeEditResult {
  /** 内容与现状完全一致 → 上层可以跳过写回（不刷 `updatedAt`） */
  unchanged?: boolean;
}

/* ------------------------------------------------------------------ *
 * Phase 20：note 卡片（契约见 data_ixd_discuss_interact_v0.20.md《Phase 20 定稿契约》）
 *
 * 只碰 2 个键：`note`（文字 / 待办 的条目集合，空数组 → 删键）与 `noteVisible`（开关，false → 删键）。
 * 不复用 `editNodeInfo`：它是「7 个字段 + patch 覆盖 / clear 删除」的契约，
 * 塞进数组 + 布尔开关 + 空数组清键会把 `NODE_INFO_FIELDS` 与既有测试搅浑。
 * ------------------------------------------------------------------ */

/** note 的改动：`items` = 要写入的条目（内部逐条 trim、丢空行），`visible` = 药丸开关 */
export interface NodeNotePatch {
  items: WfNoteItem[];
  visible: boolean;
}

/** 与 `NodeInfoEditResult` 同形：一个字都没改 → `unchanged=true`（上层不写盘） */
export interface NodeNoteEditResult extends NodeEditResult {
  /** 内容与现状完全一致（逐条 trim 后比较）→ 上层跳过写回、不刷 `updatedAt` */
  unchanged?: boolean;
}

/**
 * 把弹窗收来的条目「洗」成可落盘的形态：
 *  1. 逐条 `trim`，**trim 后为空的行直接丢掉**（不给 Schema 的 `minLength: 1` 留坑）；
 *  2. `done` 归一化：`true` → 写 `true`；`false` → 写 `false`；缺省 / `undefined` → **不写这个键**（= 文字）。
 *
 * 返回的是新数组（不改入参），便于 `editNodeNote` / `toggleNodeNoteDone` 共用。
 */
export function normalizeNoteItems(items: readonly WfNoteItem[]): WfNoteItem[] {
  const normalized: WfNoteItem[] = [];
  for (const item of items) {
    const text = typeof item?.text === "string" ? item.text.trim() : "";
    if (text.length === 0) continue;
    const clean: WfNoteItem = { text };
    if (item.done === true) clean.done = true;
    else if (item.done === false) clean.done = false;
    normalized.push(clean);
  }
  return normalized;
}

/**
 * 设置 note 卡片的条目与开关（Phase 20）：
 *  1. 节点不存在 → `ok=false` + 原因，文档一动不动；
 *  2. 条目逐条 trim、空行丢弃；洗完为空 → `note` / `noteVisible` **两键一并删除**
 *     （杜绝「有开关没内容」）；
 *  3. `visible=false` → 删 `noteVisible`（不写 `false`）；`visible=true` → 写 `true`；
 *  4. 与现状一致（逐条 trim 后比较）→ `unchanged=true`；有改动 → 刷 `node.updatedAt`。
 */
export function editNodeNote(
  document: WfJsonDocument,
  nodeId: string,
  patch: NodeNotePatch,
  now: Date = new Date(),
): NodeNoteEditResult {
  const node = findNode(document, nodeId);
  if (!node) return { ok: false, reason: `节点 ${nodeId} 不存在（可能已被删除）`, changedNodeIds: [] };

  const before = JSON.stringify(node);

  const items = normalizeNoteItems(patch.items);
  if (items.length === 0) {
    delete node.note;
    delete node.noteVisible;
  } else {
    node.note = items;
    // OFF 即默认值 → 删键；不要写 `noteVisible: false`（与 collapsed 同一套惯例）
    if (patch.visible) node.noteVisible = true;
    else delete node.noteVisible;
  }

  if (JSON.stringify(node) === before) return { ok: true, changedNodeIds: [], unchanged: true };
  node.updatedAt = formatLocalIso(now);
  return { ok: true, changedNodeIds: [nodeId] };
}

/**
 * note 卡片上的方框点击（Phase 20 修订）：把第 `index` 条在「待办 ↔ 已办」之间翻转。
 *
 * 只碰 `done` 一个键：
 *  - `false`（待办）→ `true`（已办）；
 *  - `true`（已办）→ `false`（待办）；
 *  - 缺省（文字）→ **不处理**（`ok=false`）：文字要变待办/已办只能走弹窗的单选框，
 *    卡片上本来也不给文字画方框，这里只是兜住脏数据 / 竞态。
 *
 * **不动 `noteVisible`**：翻一个待办不该顺手把卡片打开或关掉。
 */
export function toggleNodeNoteDone(
  document: WfJsonDocument,
  nodeId: string,
  index: number,
  now: Date = new Date(),
): NodeNoteEditResult {
  const node = findNode(document, nodeId);
  if (!node) return { ok: false, reason: `节点 ${nodeId} 不存在（可能已被删除）`, changedNodeIds: [] };

  const items = node.note ?? [];
  const target = items[index];
  if (!target) {
    return { ok: false, reason: `第 ${index + 1} 条 note 不存在（可能已被删掉）`, changedNodeIds: [] };
  }
  if (target.done === undefined) {
    return { ok: false, reason: "这一行是文字，不是待办；请到「设置 note 节点」里改类型", changedNodeIds: [] };
  }

  target.done = target.done !== true;
  node.updatedAt = formatLocalIso(now);
  return { ok: true, changedNodeIds: [nodeId] };
}

/**
 * 折叠三角点击（Phase 21 ⑤）的返回：`collapsed` = 目标状态，
 * `unchanged = true` → 文档本来就是这个状态（上层不写盘、不刷 `updatedAt`）。
 */
export interface NodeCollapseEditResult extends NodeEditResult {
  unchanged?: boolean;
}

/**
 * 折叠三角点击（Phase 21 ⑤）：把节点卡片的折叠态**直接写进 JSON**（`collapsed`）。
 *
 * 为什么落到 JSON（而不是像 Phase 15 那样只留视图会话内存）：
 *  - 整块重渲染（切主题 / Dataview 自动重跑 / 拖拽改顺序后）不该把用户收起的子树又展开；
 *  - 折叠态本来就是渲染事实，落盘后重启 Obsidian 也还在。
 *
 * 口径：
 *  - `true` / `false` **都显式落盘**（不删键）—— 仓库里现有 wfjson 块本来就带 `"collapsed": false`，
 *    保持键存在，写回后字节形状不变；
 *  - 与现状一致 → `unchanged = true`（拖回原样 / 重复点击不产生写盘）；
 *  - 有改动 → 刷 `node.updatedAt`（与 `editNodeNote` 同口径；`document.updatedAt` 由 applyMutation 管）。
 */
export function setNodeCollapsed(
  document: WfJsonDocument,
  nodeId: string,
  collapsed: boolean,
  now: Date = new Date(),
): NodeCollapseEditResult {
  const node = findNode(document, nodeId);
  if (!node) return { ok: false, reason: `节点 ${nodeId} 不存在（可能已被删除）`, changedNodeIds: [] };

  const next = collapsed === true;
  if ((node.collapsed === true) === next) return { ok: true, changedNodeIds: [], unchanged: true };

  node.collapsed = next;
  node.updatedAt = formatLocalIso(now);
  return { ok: true, changedNodeIds: [nodeId] };
}

/**
 * 整数 + 区间校验（与 Schema 的 `minimum` / `maximum` / `type: integer` 一致）。
 * 抽出来是为了「Modal 就地校验」与「引擎兜底校验」用**同一句话**报错；
 * `workflowEdits.ts` 也复用它（工作流 / 根节点的字段边界一模一样）。
 */
export function checkIntegerInRange(label: string, value: number, min: number, max: number): string | undefined {
  if (!Number.isInteger(value)) return `${label}必须是整数（当前 ${value}）`;
  if (value < min || value > max) return `${label}必须在 ${min}-${max} 之间（当前 ${value}）`;
  return undefined;
}

/** ISO8601 时间校验（空串不报错 —— 「清空」有专门的 clear 语义） */
export function checkIsoTimestamp(label: string, value: string): string | undefined {
  const text = value.trim();
  if (text.length === 0) return undefined;
  if (!isIsoDateOrDateTime(text)) {
    return `${label}「${value}」不是合法的 ISO8601 日期 / 日期时间（如 2026-10-10 或 2026-10-10T18:00:00+08:00）`;
  }
  return undefined;
}

/** 校验 `patch`（返回中文原因；全部合法时 undefined） */
export function validateNodeInfoPatch(patch: NodeInfoPatch): string | undefined {
  if (patch.title !== undefined) {
    const checked = sanitizeTitle(patch.title);
    if (checked.reason !== undefined) return checked.reason;
  }
  if (patch.importance !== undefined) {
    const reason = checkIntegerInRange(NODE_INFO_LABELS.importance, patch.importance, IMPORTANCE_MIN, IMPORTANCE_MAX);
    if (reason !== undefined) return reason;
  }
  if (patch.urgency !== undefined) {
    const reason = checkIntegerInRange(NODE_INFO_LABELS.urgency, patch.urgency, IMPORTANCE_MIN, IMPORTANCE_MAX);
    if (reason !== undefined) return reason;
  }
  if (patch.progress !== undefined) {
    const reason = checkIntegerInRange(NODE_INFO_LABELS.progress, patch.progress, PROGRESS_MIN, PROGRESS_MAX);
    if (reason !== undefined) return reason;
  }
  if (patch.progress_max !== undefined) {
    const reason = checkIntegerInRange(NODE_INFO_LABELS.progress_max, patch.progress_max, PROGRESS_MIN, PROGRESS_MAX);
    if (reason !== undefined) return reason;
  }
  if (patch.dueAt !== undefined) {
    const reason = checkIsoTimestamp(NODE_INFO_LABELS.dueAt, patch.dueAt);
    if (reason !== undefined) return reason;
  }
  return undefined;
}

/**
 * v1.6：`progress` 与 `status` 完全解耦（旧护栏已删除）。
 * 唯一的提示级约束是写回后可能出现的 `PROGRESS_OVER_MAX`（不拦写回），因此这里不做拦截。
 */

/** 删掉一个信息字段（逐字段写全，避免用 `delete node[key]` 这种越过类型检查的写法） */
function clearInfoField(node: WfNode, key: NodeInfoFieldKey): void {
  switch (key) {
    case "title":
      return; // 必填字段：不允许清空（Modal 会把该行的清空按钮置灰）
    case "type":
      delete node.type;
      break;
    case "importance":
      delete node.importance;
      break;
    case "urgency":
      delete node.urgency;
      break;
    case "progress":
      delete node.progress;
      break;
    case "progress_max":
      delete node.progress_max;
      break;
    case "owner":
      delete node.owner;
      break;
    case "dueAt":
      delete node.dueAt;
      break;
  }
}

/** 写入一个文本字段（trim 后为空 → 删键，不写空串） */
function setInfoText(node: WfNode, key: "type" | "owner", raw: string): void {
  const text = raw.trim();
  if (text.length === 0) {
    clearInfoField(node, key);
    return;
  }
  node[key] = text;
}

/**
 * 编辑节点信息（Phase 7）：
 *  1. 节点不存在 / patch 不合法 → `ok=false` + 原因（文档一动不动）；v1.6 不再校验 progress 与 status；
 *  2. `clear`（`patch` 没给的字段）→ 删键（title 必填，跳过）；
 *  3. `patch` → 覆盖（文本 trim，空串按删除处理）；
 *  4. 与现状一致 → `unchanged=true`；有改动 → 刷 `node.updatedAt`。
 */
export function editNodeInfo(
  document: WfJsonDocument,
  nodeId: string,
  patch: NodeInfoPatch = {},
  clear: readonly NodeInfoFieldKey[] = [],
  now: Date = new Date(),
): NodeInfoEditResult {
  const node = findNode(document, nodeId);
  if (!node) return { ok: false, reason: `节点 ${nodeId} 不存在（可能已被删除）`, changedNodeIds: [] };

  const invalid = validateNodeInfoPatch(patch);
  if (invalid !== undefined) return { ok: false, reason: invalid, changedNodeIds: [] };

  const before = JSON.stringify(node);

  for (const key of clear) {
    if (patch[key] !== undefined) continue; // 同一字段两处都出现 → patch 赢
    clearInfoField(node, key);
  }
  if (patch.title !== undefined) node.title = sanitizeTitle(patch.title).title;
  if (patch.type !== undefined) setInfoText(node, "type", patch.type);
  if (patch.owner !== undefined) setInfoText(node, "owner", patch.owner);
  if (patch.importance !== undefined) node.importance = patch.importance;
  if (patch.urgency !== undefined) node.urgency = patch.urgency;
  if (patch.progress !== undefined) node.progress = patch.progress;
  if (patch.progress_max !== undefined) node.progress_max = patch.progress_max;
  if (patch.dueAt !== undefined) {
    const dueAt = patch.dueAt.trim();
    if (dueAt.length === 0) delete node.dueAt;
    else node.dueAt = dueAt;
  }

  if (JSON.stringify(node) === before) return { ok: true, changedNodeIds: [], unchanged: true };
  node.updatedAt = formatLocalIso(now);
  return { ok: true, changedNodeIds: [nodeId] };
}

/* ------------------------------------------------------------------ *
 * Phase 34：链接文档的默认目录（`node.linkDir`）
 * ------------------------------------------------------------------ */

/**
 * 归一「新建链接文档的目录」（vault 相对路径）：
 *  - `\` → `/`、合并重复斜杠、去掉首尾斜杠；
 *  - 空串 = 库根（调用方按「删键 / 没设置」处理，这里只负责归一）；
 *  - 含 `.` / `..` 段 → `undefined`（拒绝：不允许跳出库根或用相对段绕路）。
 */
export function normalizeNodeLinkDir(raw: string): string | undefined {
  const text = raw.trim().replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\/+|\/+$/g, "");
  if (text.length === 0) return "";
  if (text.split("/").some((segment) => segment === "." || segment === "..")) return undefined;
  // 文件系统禁用字符（与「文件名」的清洗口径一致；`/` 已在上面归一掉）
  if (/[:*?"<>|]/.test(text)) return undefined;
  return text;
}

export interface NodeLinkDirEditResult extends NodeEditResult {
  /** true = 与现状一致（没写盘、没刷 `updatedAt`） */
  unchanged?: boolean;
}

/**
 * 设置节点的「新建链接文档」默认目录（Phase 34）：
 *  1. 节点不存在 / 目录非法（`.` / `..` 段）→ `ok=false` + 原因，文档一动不动；
 *  2. 空串 → **删键**（缺省即「没设置过」，不写空串）；
 *  3. 与现状一致 → `unchanged=true`（不写盘）；
 *  4. 有改动 → 写 `node.linkDir` 并刷新 `updatedAt`。
 */
export function setNodeLinkDir(
  document: WfJsonDocument,
  nodeId: string,
  linkDir: string,
  now: Date = new Date(),
): NodeLinkDirEditResult {
  const node = findNode(document, nodeId);
  if (!node) return { ok: false, reason: `节点 ${nodeId} 不存在（可能已被删除）`, changedNodeIds: [] };

  const normalized = normalizeNodeLinkDir(linkDir);
  if (normalized === undefined) {
    return { ok: false, reason: "目录不合法：不能包含 . / .. 段", changedNodeIds: [] };
  }

  if ((node.linkDir ?? "") === normalized) return { ok: true, changedNodeIds: [], unchanged: true };

  if (normalized.length === 0) delete node.linkDir;
  else node.linkDir = normalized;
  node.updatedAt = formatLocalIso(now);
  return { ok: true, changedNodeIds: [nodeId] };
}

