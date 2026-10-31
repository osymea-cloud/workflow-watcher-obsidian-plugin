/**
 * 节点编辑（Phase 2 右键菜单的三个写回功能 + Phase 5 ② 编辑节点信息；纯函数、零 Obsidian 依赖）。
 *
 * 定位：本模块只回答「内存里的文档该改成什么样」，不写盘、不弹窗。
 * 与插件层（main.ts 的 WfViewHost 实现）一一对应：
 *   editNodeLinks   → setNodeLinks    （编辑资源列表）
 *   appendChildNode → addChildNode    （添加子节点）
 *   removeNode      → deleteNode      （删除本节点）
 *   editNodeInfo    → setNodeInfo     （编辑节点信息：summary / type / importance / progress / owner / dueAt）
 *
 * 写盘统一由上层套进 `mutateFile` → `applyMutation`（安全闸门 → 1.0→1.1 升格 →
 * 三段写回 → 幂等校验），因此这里的每个函数都必须做到「要么把文档改对，要么什么都不动」：
 * 校验不过一律返回 `ok=false` + 中文原因，调用方据此 `reject`（文本保持原样）。
 *
 * 约定（与契约 doc/datacontact/data_ixd_phase2_contract.md 第 4 节对齐）：
 *  - 受影响节点的 `updatedAt` 由本模块显式维护（applyMutation 只刷新 document.updatedAt）；
 *  - 删除节点时把它的 links / timeEntries / children / relations 摊平进父节点，
 *    正文纪要段落由 `removedNoteAnchors` 上报给 `writeBackDocument` 删除。
 */

import { createNode, type NewNodeInput } from "./factory.ts";
import { anchorForNode } from "./ids.ts";
import { renderNoteLinkLine } from "./noteSection.ts";
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
   * Phase 9 删除弹窗二选一：`true`（默认）= 把被删节点的超链接行合并进父节点纪要段；
   * `false` = 连本节点纪要段一起删除，不做合并。
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
 *  6. Phase 9：`mergeNoteSection !== false` 时，被删节点的超链接（正文段落里的行 + 尚未迁移的
 *     `links[]`）由 `mergeNoteSections` 上报，写回时合并进父节点纪要段；本节点段落由
 *     `removedNoteAnchors` 删除（子节点段落若被连带吃掉，写回时按 JSON 补回）。
 *     `mergeNoteSection === false` 时不合并，只删本段。
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

  const anchor = node.noteAnchor ?? anchorForNode(node.id);
  const legacyLines = (node.links ?? []).map(renderNoteLinkLine);
  const mergeNoteSections =
    options.mergeNoteSection === false
      ? []
      : [{ sourceAnchor: anchor, targetNodeId: parent.id, lines: legacyLines }];

  return {
    ok: true,
    parentId: parent.id,
    changedNodeIds: [parent.id, ...promotedIds],
    removedNoteAnchors: [anchor],
    mergeNoteSections,
  };
}

/* ------------------------------------------------------------------ *
 * 4) 编辑节点信息（Phase 5 ②；契约见 data_ixd_discuss_interact_v0.4.md《Phase 5 定稿契约》）
 *
 * 只碰这 6 个字段：summary / type / importance / progress / owner / dueAt
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
  "summary",
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
  summary: "概要",
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
  summary?: string;
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
    case "summary":
      delete node.summary;
      break;
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
function setInfoText(node: WfNode, key: "summary" | "type" | "owner", raw: string): void {
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
  if (patch.summary !== undefined) setInfoText(node, "summary", patch.summary);
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
