/**
 * 「未分类」伪工作流（Phase 27 M2）—— 纯函数、零 Obsidian 依赖。
 *
 * 数据模型（契约 §4.1 方案 B）：未分类也是**一条普通 `WfWorkflow`**，只是 `id` 取保留值
 * `UNCLASSIFIED_WORKFLOW_ID`，`root` 只当容器（视图不渲染它）。于是：
 *  - schema / `WfJsonDocument` 结构完全不变；
 *  - 未分类节点就是普通 `WfNode`（状态、进度、计时、右键菜单、拖拽全部复用）；
 *  - **懒创建**：第一次「+ 新建」或第一次拖进列头时才把这条 workflow 写进 `workflows[]`。
 *
 * 三个入口：
 *  - `ensureUnclassifiedWorkflow`  拿容器（没有就建）；
 *  - `addUnclassifiedNode`         在容器里新建一个顶层节点（复用 `factory.createNode`）；
 *  - `attachNodeToUnclassified`    把已有节点**整棵子树**搬到容器里当顶层节点。
 *
 * `document.updatedAt` 不在这里维护：写回链路（`applyMutation`）会统一刷新它。
 */

import { createNode, createWorkflow } from "./factory.ts";
import { t } from "./i18n.ts";
import type { NodeEditResult } from "./nodeEdits.ts";
import { formatLocalIso } from "./time.ts";
import { findNodeVisit, findWorkflow } from "./tree.ts";
import { UNCLASSIFIED_WORKFLOW_ID, type WfJsonDocument, type WfNode, type WfWorkflow } from "./types.ts";
import { sanitizeTitle } from "./wfjsonWrite.ts";

/** 「+ 新建节点」表单的入参（与 `AddChildInput` 同形，去掉 tags —— v1.6 已弃用） */
export interface UnclassifiedAddInput {
  title: string;
  importance?: number;
  urgency?: number;
  progress?: number;
  progress_max?: number;
  owner?: string;
  dueAt?: string;
}

/** 新建未分类节点的返回（`warnings` 与「添加子节点」同口径：标题清洗提示） */
export interface UnclassifiedAddResult {
  ok: boolean;
  reason?: string;
  nodeId?: string;
  warnings: string[];
}

/** 搬到未分类的返回（`unchanged` = 它本来就是未分类顶层节点，不必写盘） */
export interface AttachToUnclassifiedResult extends NodeEditResult {
  unchanged?: boolean;
}

/** 未分类 workflow 的标题（与列头共用 i18n；随手新建时按当前语言落盘） */
function unclassifiedTitle(): string {
  return t("view.unclassified.title");
}

/** 容器里的顶层节点（`root.children` 可能缺省，读侧一律走这里） */
function unclassifiedChildren(workflow: WfWorkflow): WfNode[] {
  if (!Array.isArray(workflow.root.children)) workflow.root.children = [];
  return workflow.root.children;
}

/**
 * 拿到未分类 workflow；没有就建一条（`root` 只当容器，`children` 为空）。**幂等**。
 *
 * `state` 不写（缺省 = 进行中）—— 但 `groupWorkflows` 会按保留 id 先分桶，所以它不会
 * 混进「正在进行」的工作流列表里。
 */
export function ensureUnclassifiedWorkflow(document: WfJsonDocument, now: Date = new Date()): WfWorkflow {
  const existing = findWorkflow(document, UNCLASSIFIED_WORKFLOW_ID);
  if (existing !== undefined) {
    unclassifiedChildren(existing);
    return existing;
  }
  const title = unclassifiedTitle();
  const workflow = createWorkflow({ id: UNCLASSIFIED_WORKFLOW_ID, title }, now);
  workflow.root.title = title;
  workflow.root.children = [];
  document.workflows.push(workflow);
  return workflow;
}

/**
 * 在未分类下新建一个顶层节点（顺带 `ensure`）。
 *
 * 与「添加子节点」（`appendChildNode`）同口径：`status = todo`、`progress = 0`、
 * `startAt = now`、标题先过 `sanitizeTitle`（空 / 含换行直接拒绝）。
 */
export function addUnclassifiedNode(
  document: WfJsonDocument,
  input: UnclassifiedAddInput,
  now: Date = new Date(),
): UnclassifiedAddResult {
  const sanitized = sanitizeTitle(input.title);
  if (!sanitized.ok) {
    return { ok: false, reason: sanitized.reason ?? "标题不合法", warnings: sanitized.warnings };
  }

  const workflow = ensureUnclassifiedWorkflow(document, now);
  const nodeInput = {
    title: sanitized.title,
    status: "todo" as const,
    progress: input.progress ?? 0,
    progress_max: input.progress_max ?? 1,
    startAt: formatLocalIso(now),
  };
  const node = createNode(
    {
      ...nodeInput,
      ...(input.importance !== undefined ? { importance: input.importance } : {}),
      ...(input.urgency !== undefined ? { urgency: input.urgency } : {}),
      ...(input.owner !== undefined && input.owner.trim().length > 0 ? { owner: input.owner.trim() } : {}),
      ...(input.dueAt !== undefined && input.dueAt.trim().length > 0 ? { dueAt: input.dueAt.trim() } : {}),
    },
    now,
  );

  unclassifiedChildren(workflow).push(node);
  workflow.root.updatedAt = formatLocalIso(now);
  return { ok: true, nodeId: node.id, warnings: sanitized.warnings };
}

/**
 * 把某节点「搬到未分类当顶层节点」：**整棵子树跟着走**（保留 children），
 * 并从原父节点的 children 里摘掉（**不**提升它的 children —— 等同 `keepSubtree`）。
 *
 * 拒绝条件（与拖拽护栏同口径）：
 *  - 节点不存在；
 *  - 节点是某条流的 root（根不能被搬走）。
 *
 * 已经是未分类顶层节点 → `ok = true` + `unchanged = true`（不写盘）。
 */
export function attachNodeToUnclassified(
  document: WfJsonDocument,
  nodeId: string,
  now: Date = new Date(),
): AttachToUnclassifiedResult {
  const visit = findNodeVisit(document, nodeId);
  if (visit === undefined) {
    return { ok: false, reason: `节点 ${nodeId} 不存在（可能已被删除）`, changedNodeIds: [] };
  }
  if (visit.parent === undefined) {
    return { ok: false, reason: `工作流根节点「${visit.node.title}」不能被移动`, changedNodeIds: [] };
  }

  const target = ensureUnclassifiedWorkflow(document, now);
  if (visit.workflow.id === UNCLASSIFIED_WORKFLOW_ID && visit.parent.id === target.root.id) {
    return { ok: true, unchanged: true, changedNodeIds: [] };
  }

  // 从原父节点的 children 里摘掉（整棵子树跟着走，兄弟不动）
  const siblings = Array.isArray(visit.parent.children) ? visit.parent.children : [];
  const index = siblings.indexOf(visit.node);
  if (index >= 0) siblings.splice(index, 1);

  unclassifiedChildren(target).push(visit.node);

  const timestamp = formatLocalIso(now);
  visit.node.updatedAt = timestamp;
  visit.parent.updatedAt = timestamp;
  target.root.updatedAt = timestamp;

  return {
    ok: true,
    changedNodeIds: [visit.node.id, visit.parent.id, target.root.id],
  };
}
