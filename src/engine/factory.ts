/**
 * 工厂函数：创建合法的 wfjson 数据（决策 2/4：id、锚点、状态历史由插件统一生成，
 * 保证「新建出来的东西」天然通过 Schema 与一致性检查）。
 *
 * 约定（与 consistency.ts 的检查一一对应）：
 *  - 节点 id = nd-<uuid>，noteAnchor = "^" + 节点 id；
 *  - statusHistory 的末条 to 始终等于当前 status（非 todo 时自动补一条初始事件）；
 *  - status=done 时补 progress=5 与 completedAt。
 */

import { anchorForNode, newFileId, newLinkId, newNodeId, newWorkflowId } from "./ids.ts";
import { formatLocalIso } from "./time.ts";
import { SCHEMA_VERSION, PROGRESS_DEFAULT, PROGRESS_MAX_DEFAULT, type WfJsonDocument, type WfLink, type WfNode, type WfRelation, type WfStatusEvent, type WfWorkflow, type WorkflowState } from "./types.ts";

export interface NewNodeInput {
  title: string;
  /** 指定 id（导入已有数据 / 单测用）；缺省自动生成 nd-<uuid> */
  id?: string;
  summary?: string;
  type?: string;
  status?: WfNode["status"];
  /** 已完成量（v1.6，0-999，缺省 0；与 status 无关） */
  progress?: number;
  /** 总量（v1.6，0-999，缺省 1） */
  progress_max?: number;
  importance?: number;
  urgency?: number;
  collapsed?: boolean;
  owner?: string;
  /** @deprecated v1.6 已弃用（仅为兼容旧调用方保留，新代码不要再传） */
  tags?: string[];
  aliases?: string[];
  startAt?: string;
  dueAt?: string;
  /** @deprecated v1.6 已弃用（仅为兼容旧调用方保留，新代码不要再传） */
  estimate?: string | number;
  noteAnchor?: string;
  aiContext?: string;
  children?: WfNode[];
}

/** 新建节点（title 字符串等价于 { title }） */
export function createNode(input: NewNodeInput | string, now: Date = new Date()): WfNode {
  const options: NewNodeInput = typeof input === "string" ? { title: input } : input;
  const id = options.id ?? newNodeId();
  const status = options.status ?? "todo";
  const timestamp = formatLocalIso(now);

  const node: WfNode = {
    id,
    title: options.title,
    status,
    noteAnchor: options.noteAnchor ?? anchorForNode(id),
    collapsed: options.collapsed ?? false,
    children: options.children ?? [],
  };
  if (options.summary !== undefined) node.summary = options.summary;
  if (options.type !== undefined) node.type = options.type;
  if (options.owner !== undefined) node.owner = options.owner;
  if (options.startAt !== undefined) node.startAt = options.startAt;
  if (options.dueAt !== undefined) node.dueAt = options.dueAt;
  if (options.estimate !== undefined) node.estimate = options.estimate;
  if (options.tags !== undefined) node.tags = [...options.tags];
  if (options.aliases !== undefined) node.aliases = [...options.aliases];
  if (options.aiContext !== undefined) node.aiContext = options.aiContext;

  // v1.6：progress / progress_max 与 status 完全解耦（缺省 0 / 1，不再按状态对齐）
  node.progress = options.progress ?? PROGRESS_DEFAULT;
  node.progress_max = options.progress_max ?? PROGRESS_MAX_DEFAULT;
  if (options.importance !== undefined) node.importance = options.importance;
  if (options.urgency !== undefined) node.urgency = options.urgency;

  node.updatedAt = timestamp;
  // v1.6：startAt 由插件自动维护（创建即开始；导入既有数据时可用 startAt 显式覆盖）
  if (node.startAt === undefined) node.startAt = timestamp;
  if (status === "done") {
    node.completedAt = timestamp;
  }
  if (status !== "todo") {
    node.statusHistory = [{ from: "todo", to: status, at: timestamp }];
  }
  return node;
}

export interface NewWorkflowInput {
  title: string;
  id?: string;
  /** @deprecated v1.6：根节点标题恒等于 workflow.title，本项不再生效 */
  rootTitle?: string;
  root?: WfNode;
  progress?: number;
  /** 工作流级进度总量（v1.6，0-999，缺省 1） */
  progress_max?: number;
  /** 工作流级人工状态（v1.1）：缺省时**不写该键**（= 进行中）；"doing" 不是合法取值 */
  state?: WorkflowState;
  /** 归档来源（v1.1）：仅归档创建时写入（= 原文档浓缩节点的 id） */
  originId?: string;
}

/** 新建工作流（每个工作流一棵树，root 必有） */
export function createWorkflow(input: NewWorkflowInput | string, now: Date = new Date()): WfWorkflow {
  const options: NewWorkflowInput = typeof input === "string" ? { title: input } : input;
  const workflow: WfWorkflow = {
    id: options.id ?? newWorkflowId(),
    title: options.title,
    root: options.root ?? createNode({ title: options.title, status: "doing" }, now),
  };
  // v1.6：workflow.title 是唯一事实来源，根节点标题强制同步
  workflow.root.title = options.title;
  // v1.6：工作流级进度同样给默认值（0 / 1），与根节点各自独立
  workflow.progress = options.progress ?? PROGRESS_DEFAULT;
  workflow.progress_max = options.progress_max ?? PROGRESS_MAX_DEFAULT;
  if (options.state !== undefined) workflow.state = options.state;
  if (options.originId !== undefined) workflow.originId = options.originId;
  return workflow;
}

export interface NewDocumentInput {
  workflows: WfWorkflow[];
  id?: string;
  updatedAt?: string;
}

/** 新建文档（schemaVersion 固定为当前版本） */
export function createDocument(input: NewDocumentInput | WfWorkflow[], now: Date = new Date()): WfJsonDocument {
  const options: NewDocumentInput = Array.isArray(input) ? { workflows: input } : input;
  return {
    schemaVersion: SCHEMA_VERSION,
    id: options.id ?? newFileId(),
    updatedAt: options.updatedAt ?? formatLocalIso(now),
    workflows: options.workflows,
  };
}

export interface NewLinkInput {
  type: WfLink["type"];
  target: string;
  role?: WfLink["role"];
  label?: string;
  reason?: string;
  id?: string;
}

/** 新建外链（target 存裸目标） */
export function createLink(input: NewLinkInput): WfLink {
  const link: WfLink = { id: input.id ?? newLinkId(), type: input.type, target: input.target };
  if (input.role !== undefined) link.role = input.role;
  if (input.label !== undefined) link.label = input.label;
  if (input.reason !== undefined) link.reason = input.reason;
  return link;
}

/** 新建节点关系 */
export function createRelation(target: string, kind: WfRelation["kind"], note?: string): WfRelation {
  const relation: WfRelation = { target, kind };
  if (note !== undefined && note.length > 0) relation.note = note;
  return relation;
}

export interface StatusChangeOptions {
  at?: string;
  by?: string;
  note?: string;
}

/**
 * 应用一次状态变更（就地修改 node 并返回它）：
 *  - 追加 statusHistory、刷新 updatedAt；
 *  - done → 补 completedAt（若已有则保留）；其它状态 → 清除 completedAt；
 *  - v1.6：**不再修改 progress**（progress 纯手动，与 status 解耦）。
 */
export function applyStatusChange(
  node: WfNode,
  next: WfNode["status"],
  options: StatusChangeOptions = {},
): WfNode {
  const at = options.at ?? formatLocalIso();
  const from = node.status;
  if (from === next) return node;

  const history = Array.isArray(node.statusHistory) ? node.statusHistory : [];
  const event: WfStatusEvent = { from, to: next, at };
  if (options.by !== undefined) event.by = options.by;
  if (options.note !== undefined) event.note = options.note;
  history.push(event);
  node.statusHistory = history;
  node.status = next;
  node.updatedAt = at;

  // v1.6：progress 与 status 解耦，状态变更不再推进 / 回退 progress
  if (next === "done") {
    if (node.completedAt === undefined) node.completedAt = at;
  } else {
    delete node.completedAt;
  }
  return node;
}
