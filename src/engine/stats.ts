/**
 * 聚合统计（Phase 1）：「状态总览」那一行数字的唯一来源，供视图与测试复用。
 *
 * 口径（doc/datacontact/data_ixd_discuss_interact.md「状态总览」）：
 *  - 只统计**非完成且非取消**的 workflow，即 `state` 缺省（进行中）的 workflow；
 *  - `B` = 这些 workflow 的**全部节点**数（不排除 `done` / `cancelled`）；
 *  - `a` = 其中 `status = "doing"` 的节点数；`blocked` 单独提示（`n`）；
 *  - 没有进行中的 workflow 时 `a/B = 0/0`、受阻 `0`。
 *
 * Phase 27 M2：「未分类」伪工作流（`UNCLASSIFIED_WORKFLOW_ID`）特判 ——
 *  - 它的**隐藏 root 不计数**，只计 `root.children`（口径 4）；
 *  - 它**不算一条工作流**：`activeWorkflowCount` 排除它，`groupWorkflows` 给它单独分桶。
 */

import { workflowContribution } from "./consistency.ts";
import { t } from "./i18n.ts";
import { flattenSubtree, walkWorkflow } from "./tree.ts";
import {
  NODE_STATUSES,
  UNCLASSIFIED_WORKFLOW_ID,
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

/** 这条 workflow 是不是「未分类」伪流（Phase 27 M2：隐藏 root、不算一条工作流） */
export function isUnclassifiedWorkflow(workflow: WfWorkflow): boolean {
  return workflow.id === UNCLASSIFIED_WORKFLOW_ID;
}

/**
 * 汇总单个 workflow，但「未分类」只数隐藏 root 的 children（Phase 27 M2）。
 *
 * 为什么不改 `summarizeWorkflow`：归档 / 甘特等其它调用方要的是「含 root」的通用语义，
 * 特判只该发生在「状态总览」的统计口径上。
 */
function summarizeForDocument(workflow: WfWorkflow): WorkflowSummary {
  const summary = summarizeWorkflow(workflow);
  if (!isUnclassifiedWorkflow(workflow)) return summary;
  const children = Array.isArray(workflow.root.children) ? workflow.root.children : [];
  // 隐藏 root 只当容器：统计口径从它的 children 起算（`flattenSubtree` 与 `walkWorkflow` 同序）
  const counts = countNodeStatuses(flattenSubtree(children, workflow, workflow.root, [workflow.root]));
  return {
    ...summary,
    total: counts.total,
    todo: counts.todo,
    doing: counts.doing,
    blocked: counts.blocked,
    done: counts.done,
    cancelled: counts.cancelled,
    allDone: children.length > 0 && counts.done === children.length,
  };
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
  const workflows = document.workflows.map((workflow) => summarizeForDocument(workflow));
  const active = emptyStatusCounts();
  for (const summary of workflows) {
    if (!summary.active) continue;
    // 未分类的隐藏 root 已经被 `summarizeForDocument` 剔除，这里只并入数字
    active.total += summary.total;
    for (const status of NODE_STATUSES) active[status] += summary[status];
  }
  return {
    workflows,
    active,
    // 口径 4：未分类不算一条工作流（导航条 / 块标题 / 总览计数都不含它）
    activeWorkflowCount: workflows.filter(
      (summary) => summary.active && summary.id !== UNCLASSIFIED_WORKFLOW_ID,
    ).length,
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
  /**
   * Phase 27 M2：保留 id 的那一条（「未分类」，没有就是 undefined）。
   * 它**不**并进 active / archived / cancelled —— 否则导航条 / 块标题会把它算成一条工作流。
   */
  unclassified: WfWorkflow | undefined;
}

export function groupWorkflows(document: WfJsonDocument): WorkflowGroups {
  const groups: WorkflowGroups = { active: [], archived: [], cancelled: [], unclassified: undefined };
  for (const workflow of document.workflows) {
    // 先按保留 id 判（不看 state）：未分类伪流单独分桶，绝不进 active
    if (isUnclassifiedWorkflow(workflow)) {
      groups.unclassified = workflow;
      continue;
    }
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
