/**
 * 导入 / 导出（Phase 26）：**体检** + **合并计划**，两个纯函数。
 *
 * 契约：`doc/datacontact/phase26_bound.md` §4；Phase 27 口径见 `phase27_bound.md` §5.2。
 *
 * 分工（与 `sidecar.ts` / `archive.ts` 一致）：
 *  - 本模块只算「事实」与「合并后的 json 对象」，**不读盘、不写盘**；
 *  - 真正的读写（含库外绝对路径走 Node `fs`）、弹窗、确认都在 `main.ts`；
 *  - 所以这里零 Obsidian 依赖，`node --test` 可以直接跑。
 *
 * Phase 27（纪要段范式弃用）后的两条不变量：
 *  - I4：节点 id / workflow id 全局唯一 —— 撞了就**整条 workflow 跳过**（不覆盖，口径 1）；
 *  - I5：合并后仍然无 error —— 现在只剩 JSON 结构 / schema 一条来源（正文不再参与）。
 *
 * 正文口径：导入**完全与 md 无关**（`phase27_bound.md` §5.2 第 341 行）——
 * 不读源 md、不返回目标 md；`noteAnchor` 随导入剥离（引擎不再生成该键）。
 * 数据只走侧车 JSON：笔记正文既不是输入也不是输出。
 */

import { analyzeDocument } from "./analyze.ts";
import { severityLabel } from "./i18n.ts";
import { formatLocalIso } from "./time.ts";
import type { WfJsonDocument, WfNode, WfWorkflow } from "./types.ts";

/* ------------------------------------------------------------------ *
 * 遍历（节点 id 的唯一来源）
 * ------------------------------------------------------------------ */

/** 先序展开一棵子树（含根；不用 `tree.ts` 的 visit 形状，这里只要节点本身） */
function walkNodes(node: WfNode): WfNode[] {
  const collected: WfNode[] = [node];
  for (const child of node.children ?? []) collected.push(...walkNodes(child));
  return collected;
}

/** 一个文档里全部节点（先序，按 `workflows[]` 顺序） */
function documentNodes(document: WfJsonDocument): WfNode[] {
  const nodes: WfNode[] = [];
  for (const workflow of document.workflows) nodes.push(...walkNodes(workflow.root));
  return nodes;
}

/* ------------------------------------------------------------------ *
 * 导入前体检
 * ------------------------------------------------------------------ */

export interface ImportInspectInput {
  /** 导入源的 json 文本（外置 JSON；**不是** md 里的代码块） */
  jsonText: string;
  /** 展示用路径（只进报告，不参与判断） */
  jsonPath?: string;
}

export interface ImportInspection {
  /** 结构能不能用（解析 / schema / 一致性 全过） */
  ok: boolean;
  /** error 级问题（`ok = false` 时非空；直接展示给用户，**不**落盘） */
  errors: string[];
  /** warning / info 级提示（非阻塞，展示即可） */
  warnings: string[];
  /** 合法时的文档（内存里已升格到最新版，与 `AnalyzeResult.latestDocument` 同口径） */
  document?: WfJsonDocument;
  /** 源文件里的 `schemaVersion` 原文（升格前） */
  schemaVersion?: string;
  /** 展示用：源 json 路径（报告第一行；未传就没有） */
  jsonPath?: string;

  /* ---- 数量口径（报告第一屏） ---- */
  workflowCount: number;
  nodeCount: number;
}

/**
 * 体检一份导入源（只读）。
 *
 * 流水线与 `analyzeDocument` 完全一致（解析 → schema），不另写一套；
 * Phase 27 起正文不再参与体检（纪要段 / 锚点范式弃用）→ `consistency` 整体跳过，
 * 只保留 JSON 结构 / schema 的 error。
 */
export function inspectImport(input: ImportInspectInput): ImportInspection {
  const result = analyzeDocument({
    noteMarkdown: "",
    jsonText: input.jsonText,
    jsonSource: "sidecar",
    consistency: false,
  });

  const errors: string[] = [];
  const warnings: string[] = [];
  for (const problem of result.issues) {
    const line = `${severityLabel(problem.severity)}：${problem.message}`;
    if (problem.severity === "error") errors.push(line);
    else warnings.push(line);
  }

  const document = result.latestDocument ?? result.document;
  const nodes = document === undefined ? [] : documentNodes(document);

  const inspection: ImportInspection = {
    ok: errors.length === 0,
    errors,
    warnings,
    workflowCount: document?.workflows.length ?? 0,
    nodeCount: nodes.length,
  };
  if (document !== undefined) inspection.document = document;
  const version = result.document?.schemaVersion;
  if (version !== undefined) inspection.schemaVersion = version;
  if (input.jsonPath !== undefined) inspection.jsonPath = input.jsonPath;
  return inspection;
}

/* ------------------------------------------------------------------ *
 * 合并计划
 * ------------------------------------------------------------------ */

export interface ImportPlanInput {
  /** 目标文档（当前看板，**不改**原对象） */
  target: WfJsonDocument;
  /** 导入源的文档（`inspectImport().document`） */
  incoming: WfJsonDocument;
  /** 时间基准（`updatedAt`，默认 `new Date()`；测试传定值） */
  now?: Date;
}

/** 被整条跳过的 workflow（口径 1：**不覆盖**） */
export interface ImportSkippedWorkflow {
  id: string;
  title: string;
  reason: "duplicate-workflow" | "duplicate-node";
}

export interface ImportPlanResult {
  /** 合并后的文档（新对象；`target` 不被修改） */
  document: WfJsonDocument;
  /** 真的追加进来的 workflow id（按源顺序） */
  addedWorkflowIds: string[];
  /** 因 id 冲突被整条跳过的 workflow */
  skippedWorkflows: ImportSkippedWorkflow[];
  /** 有没有真的变（全被跳过时 false → 插件不写盘） */
  changed: boolean;
}

/**
 * 深拷贝一棵子树并**剥离** `noteAnchor`（Phase 27：引擎不再生成该键，见 §5.2）。
 * 不修改传入的节点。
 */
function copyNode(node: WfNode): WfNode {
  const copy: WfNode = { ...node };
  delete copy.noteAnchor;
  if (node.children !== undefined) copy.children = node.children.map(copyNode);
  return copy;
}

/** 整条 workflow 深拷贝（根节点也走 `copyNode`） */
function copyWorkflow(workflow: WfWorkflow): WfWorkflow {
  return { ...workflow, root: copyNode(workflow.root) };
}

/**
 * 算「把 `incoming` 并进 `target`」的产物（**只读纯函数**，不落盘）。
 *
 * 合并语义（§4.3；Phase 27 收敛）：
 *  1. **追加**：新 workflow 排在 `workflows[]` 末尾，已有顺序不动；
 *  2. 撞 id（`workflow.id` 或任一 `node.id`）→ **整条跳过**，不覆盖（口径 1）；
 *  3. 只动 JSON（Phase 27：纪要段范式弃用）；笔记正文不参与，插件也不再读写它。
 *
 * 幂等：对同一份 `plan.document` 再跑一次 → `changed = false`（全部 id 已存在）。
 */
export function planWorkflowImport(input: ImportPlanInput): ImportPlanResult {
  const now = input.now ?? new Date();
  const target = input.target;

  /* 1. 目标已有的 id（workflow + 全部节点） */
  const workflowIds = new Set<string>();
  const nodeIds = new Set<string>();
  for (const workflow of target.workflows) {
    workflowIds.add(workflow.id);
    for (const node of walkNodes(workflow.root)) nodeIds.add(node.id);
  }

  /* 2. 逐条过滤（同一次导入内部也按同一套去重） */
  const added: WfWorkflow[] = [];
  const addedWorkflowIds: string[] = [];
  const skippedWorkflows: ImportSkippedWorkflow[] = [];
  for (const workflow of input.incoming.workflows) {
    const ids = walkNodes(workflow.root).map((node) => node.id);
    if (workflowIds.has(workflow.id)) {
      skippedWorkflows.push({ id: workflow.id, title: workflow.title, reason: "duplicate-workflow" });
      continue;
    }
    if (ids.some((id) => nodeIds.has(id))) {
      skippedWorkflows.push({ id: workflow.id, title: workflow.title, reason: "duplicate-node" });
      continue;
    }
    workflowIds.add(workflow.id);
    for (const id of ids) nodeIds.add(id);
    added.push(copyWorkflow(workflow));
    addedWorkflowIds.push(workflow.id);
  }

  /* 3. 拼文档：只追加 workflows；全跳过时连 `updatedAt` 都不动 */
  const document: WfJsonDocument =
    added.length === 0
      ? { ...target, workflows: [...target.workflows] }
      : { ...target, workflows: [...target.workflows, ...added], updatedAt: formatLocalIso(now) };

  return {
    document,
    addedWorkflowIds,
    skippedWorkflows,
    changed: added.length > 0,
  };
}
