/**
 * 工作流树的遍历工具（同构递归树的通用操作）。
 * 供一致性检查、工厂函数、后续视图层复用；纯函数、不改动传入的数据。
 */

import type { WfJsonDocument, WfNode, WfWorkflow } from "./types.ts";

export interface NodeVisit {
  node: WfNode;
  /** 所属工作流 */
  workflow: WfWorkflow;
  /** 父节点（根节点为 undefined） */
  parent?: WfNode;
  /** 同层序号（从 0 开始） */
  index: number;
  /** 深度：根节点为 0 */
  depth: number;
  /** 从工作流根到该节点的路径（含自身） */
  path: WfNode[];
}

/** 先序遍历单个工作流的所有节点 */
export function walkWorkflow(workflow: WfWorkflow): NodeVisit[] {
  const visits: NodeVisit[] = [];
  const visit = (node: WfNode, parent: WfNode | undefined, index: number, path: WfNode[]): void => {
    const nextPath = [...path, node];
    visits.push({ node, workflow, parent, index, depth: path.length, path: nextPath });
    const children = Array.isArray(node.children) ? node.children : [];
    children.forEach((child, childIndex) => visit(child, node, childIndex, nextPath));
  };
  visit(workflow.root, undefined, 0, []);
  return visits;
}

/** 先序遍历文档内全部工作流的全部节点 */
export function walkNodes(document: WfJsonDocument): NodeVisit[] {
  return document.workflows.flatMap((workflow) => walkWorkflow(workflow));
}

/**
 * 先序遍历「若干棵子树」（Phase 27 M2）。
 *
 * 用途：未分类伪流的隐藏 root 不参与统计，需要的是「只遍历 root.children」——
 * 直接把 `root` 换成 `root.children` 再走一遍即可（顺序与 `walkWorkflow` 一致）。
 */
export function walkSubtree(
  nodes: readonly WfNode[],
  workflow: WfWorkflow,
  parent?: WfNode,
  basePath: readonly WfNode[] = [],
): NodeVisit[] {
  const visits: NodeVisit[] = [];
  const visit = (node: WfNode, parentNode: WfNode | undefined, index: number, path: WfNode[]): void => {
    const nextPath = [...path, node];
    visits.push({ node, workflow, parent: parentNode, index, depth: path.length, path: nextPath });
    const children = Array.isArray(node.children) ? node.children : [];
    children.forEach((child, childIndex) => visit(child, node, childIndex, nextPath));
  };
  nodes.forEach((node, index) => visit(node, parent, index, [...basePath]));
  return visits;
}

/** `walkSubtree` 的「只要节点」版本 */
export function flattenSubtree(
  nodes: readonly WfNode[],
  workflow: WfWorkflow,
  parent?: WfNode,
  basePath: readonly WfNode[] = [],
): WfNode[] {
  return walkSubtree(nodes, workflow, parent, basePath).map((visit) => visit.node);
}

/** 展平全部节点（去掉上下文） */
export function flattenNodes(document: WfJsonDocument): WfNode[] {
  return walkNodes(document).map((visit) => visit.node);
}

/** 文档内节点总数 */
export function countNodes(document: WfJsonDocument): number {
  return flattenNodes(document).length;
}

/** 按 id 查找节点及其上下文 */
export function findNodeVisit(document: WfJsonDocument, id: string): NodeVisit | undefined {
  return walkNodes(document).find((visit) => visit.node.id === id);
}

/** 按 id 查找节点 */
export function findNode(document: WfJsonDocument, id: string): WfNode | undefined {
  return findNodeVisit(document, id)?.node;
}

/** 按 id 查找工作流 */
export function findWorkflow(document: WfJsonDocument, id: string): WfWorkflow | undefined {
  return document.workflows.find((workflow) => workflow.id === id);
}

/** 从根到目标节点的节点链（含自身）；找不到时返回 [] */
export function findNodePath(document: WfJsonDocument, id: string): WfNode[] {
  return findNodeVisit(document, id)?.path ?? [];
}

/** 节点的父节点（根节点返回 undefined） */
export function findParentNode(document: WfJsonDocument, id: string): WfNode | undefined {
  return findNodeVisit(document, id)?.parent;
}

export interface IdIndex {
  /** id → 节点 */
  nodes: Map<string, WfNode>;
  /** id → 工作流 */
  workflows: Map<string, WfWorkflow>;
  /** id → 链接（值内为所有同 id 链接，便于发现重复） */
  links: Map<string, { nodeId: string; linkId: string }[]>;
  /** 出现重复的 id（值内按出现顺序） */
  duplicated: Map<string, string[]>;
}

function addDuplicate(duplicated: Map<string, string[]>, id: string): void {
  const bucket = duplicated.get(id);
  if (bucket) bucket.push(id);
  else duplicated.set(id, [id, id]);
}

/** 汇总文档内全部 id（含重复项，便于一致性检查一次遍历搞定） */
export function indexIds(document: WfJsonDocument): IdIndex {
  const nodes = new Map<string, WfNode>();
  const workflows = new Map<string, WfWorkflow>();
  const links = new Map<string, { nodeId: string; linkId: string }[]>();
  const duplicated = new Map<string, string[]>();

  for (const workflow of document.workflows) {
    if (workflows.has(workflow.id)) addDuplicate(duplicated, workflow.id);
    else workflows.set(workflow.id, workflow);
  }
  for (const visit of walkNodes(document)) {
    if (nodes.has(visit.node.id)) addDuplicate(duplicated, visit.node.id);
    else nodes.set(visit.node.id, visit.node);
    for (const link of visit.node.links ?? []) {
      const bucket = links.get(link.id);
      if (bucket) bucket.push({ nodeId: visit.node.id, linkId: link.id });
      else links.set(link.id, [{ nodeId: visit.node.id, linkId: link.id }]);
      const owners = links.get(link.id);
      if (owners && owners.length > 1) addDuplicate(duplicated, link.id);
    }
  }
  return { nodes, workflows, links, duplicated };
}
