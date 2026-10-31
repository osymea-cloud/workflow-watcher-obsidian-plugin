/**
 * 聚合统计（Phase 1）：「状态总览」那一行数字的唯一来源，供视图与测试复用。
 *
 * 口径（doc/datacontact/data_ixd_discuss_interact.md「状态总览」）：
 *  - 只统计**非完成且非取消**的 workflow，即 `state` 缺省（进行中）的 workflow；
 *  - `B` = 这些 workflow 的**全部节点**数（不排除 `done` / `cancelled`）；
 *  - `a` = 其中 `status = "doing"` 的节点数；`blocked` 单独提示（`n`）；
 *  - 没有进行中的 workflow 时 `a/B = 0/0`、受阻 `0`。
 */

import { workflowContribution } from "./consistency.ts";
import { t } from "./i18n.ts";
import { walkWorkflow } from "./tree.ts";
import {
  NODE_STATUSES,
  isWorkflowState,
  type NodeStatus,
  type WfJsonDocument,
  type WfNode,
  type WfWorkflow,
  type WorkflowState,
} from "./types.ts";

/** 一组节点的状态计数（`total` = 全部节点，含 done / cancelled） */
export interface NodeStatusCounts {
  total: number;
  todo: number;
  doing: number;
  blocked: number;
  done: number;
  cancelled: number;
}

/** 全 0 的计数（空集合口径） */
export function emptyStatusCounts(): NodeStatusCounts {
  return { total: 0, todo: 0, doing: 0, blocked: 0, done: 0, cancelled: 0 };
}

/** 按 `status` 统计节点数 */
export function countNodeStatuses(nodes: readonly WfNode[]): NodeStatusCounts {
  const counts = emptyStatusCounts();
  counts.total = nodes.length;
  for (const node of nodes) counts[node.status] += 1;
  return counts;
}

/** 单个 workflow 的汇总（节点计数 + 贡献状态 + 是否计入「状态总览」） */
export interface WorkflowSummary extends NodeStatusCounts {
  id: string;
  title: string;
  /** 缺省 = 进行中 */
  state?: WorkflowState;
  originId?: string;
  /** 该 workflow 的贡献状态（两步聚合的第一步，见 consistency.workflowContribution） */
  contribution: NodeStatus;
  /** 是否计入「状态总览」（`state` 缺省的进行中 workflow） */
  active: boolean;
  /** 是否全部节点都已完成（0 节点的 workflow 视为 false） */
  allDone: boolean;
}

/** 汇总单个 workflow（`state` 非法时按「进行中」处理，避免数据在视图里凭空消失） */
export function summarizeWorkflow(workflow: WfWorkflow): WorkflowSummary {
  const nodes = walkWorkflow(workflow).map((visit) => visit.node);
  const counts = countNodeStatuses(nodes);
  const state = isWorkflowState(workflow.state) ? workflow.state : undefined;
  const summary: WorkflowSummary = {
    total: counts.total,
    todo: counts.todo,
    doing: counts.doing,
    blocked: counts.blocked,
    done: counts.done,
    cancelled: counts.cancelled,
    id: workflow.id,
    title: workflow.title,
    contribution: workflowContribution(workflow),
    active: state === undefined,
    allDone: nodes.length > 0 && counts.done === nodes.length,
  };
  if (state !== undefined) summary.state = state;
  if (workflow.originId !== undefined) summary.originId = workflow.originId;
  return summary;
}

/** 文件级汇总：`workflows` 按文档顺序，`active` 为「状态总览」的统计口径 */
export interface DocumentSummary {
  workflows: WorkflowSummary[];
  /** 只累加 `state` 缺省（进行中）的 workflow */
  active: NodeStatusCounts;
  activeWorkflowCount: number;
  archivedWorkflowCount: number;
  cancelledWorkflowCount: number;
  /** 文件内全部节点数（不分 workflow 状态） */
  nodeTotal: number;
}

/** 汇总整个文档（视图的「状态总览」直接用这里的结果） */
export function summarizeDocument(document: WfJsonDocument): DocumentSummary {
  const workflows = document.workflows.map((workflow) => summarizeWorkflow(workflow));
  const active = emptyStatusCounts();
  for (const summary of workflows) {
    if (!summary.active) continue;
    active.total += summary.total;
    for (const status of NODE_STATUSES) active[status] += summary[status];
  }
  return {
    workflows,
    active,
    activeWorkflowCount: workflows.filter((summary) => summary.active).length,
    archivedWorkflowCount: workflows.filter((summary) => summary.state === "archived").length,
    cancelledWorkflowCount: workflows.filter((summary) => summary.state === "cancelled").length,
    nodeTotal: workflows.reduce((sum, summary) => sum + summary.total, 0),
  };
}

/**
 * 「状态总览」第一行文本（Phase 9 v0.7 ②）：`进行中：a/B 阻滞：n`
 * （无进行中 workflow 时 `0/0`，阻滞无则 `0`）
 */
export function formatStatusOverview(summary: DocumentSummary): string {
  return t("stats.overview", {
    doing: summary.active.doing,
    total: summary.active.total,
    blocked: summary.active.blocked,
  });
}

/** 按 workflow 状态分组（视图分块用），各组内保持 `workflows[]` 的文档顺序 */
export interface WorkflowGroups {
  /** `state` 缺省（进行中）→ 「正在进行」块 */
  active: WfWorkflow[];
  /** `state = archived` → 「已完成流」折叠区 */
  archived: WfWorkflow[];
  /** `state = cancelled` → 「已取消流」折叠区 */
  cancelled: WfWorkflow[];
}

export function groupWorkflows(document: WfJsonDocument): WorkflowGroups {
  const groups: WorkflowGroups = { active: [], archived: [], cancelled: [] };
  for (const workflow of document.workflows) {
    const state = isWorkflowState(workflow.state) ? workflow.state : undefined;
    if (state === "archived") groups.archived.push(workflow);
    else if (state === "cancelled") groups.cancelled.push(workflow);
    else groups.active.push(workflow);
  }
  return groups;
}

/** 单个 workflow 内「是否还有未完成节点」的快捷判断（节点全 done / cancelled 即视为已收尾） */
export function isWorkflowSettled(workflow: WfWorkflow): boolean {
  const nodes = walkWorkflow(workflow).map((visit) => visit.node);
  return nodes.every((node) => node.status === "done" || node.status === "cancelled");
}
