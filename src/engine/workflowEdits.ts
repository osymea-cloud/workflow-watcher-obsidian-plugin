/**
 * 工作流编辑（Phase 5 ③；契约见 doc/datacontact/data_ixd_discuss_interact_v0.4.md《Phase 5 定稿契约》）。
 *
 * 三个原语 + 一个整批编排（纯函数、零 Obsidian 依赖）：
 *   addWorkflow     → main.ts `addWorkflow`     （新增一个工作流，自带新 root，追加到末尾）
 *   removeWorkflow  → main.ts `deleteWorkflow`  （连根带全部节点一起删，带两道护栏）
 *   editWorkflow    → main.ts `setWorkflowInfo` （逐字段：patch 覆盖 / clear 删除 / 其余不动）
 *   applyWorkflowEdits → main.ts `applyWorkflowPlan`（Modal「⚙️ 修改工作流」保存时**一次写回**）
 *
 * 「根节点的增减」在本模块里**等于 workflow 的增删**：一个 workflow 必有且只有一个 root
 * （新增自带新 root；删除连根带全部节点一起删）。
 *
 * 可编辑字段（改动会刷 `root.updatedAt`）：
 *   `workflow.title` / `workflow.progress` / `workflow.state`（v0.7 §⑨-8）/
 *   `workflow.archive`（Phase 45：四条复盘说明 summary / idea / review / tag）/
 *   `root.type` / `root.importance` / `root.urgency` / `root.owner` / `root.dueAt` / `root.tags`
 * 明确**不碰**：`originId`、树结构（加 / 删节点走节点右键菜单）、
 * 节点 status / 计时 / 链接（各有专门入口）。
 * `workflow.state` 的「进行中」= 删键（`clear`），`archived` / `cancelled` = `patch`。
 * Phase 45：`root.summary` 已废弃 —— 不再作为可编辑字段，说明改填 `workflow.archive`。
 *
 * 删除护栏（拒绝，一个字都不写；与 removeNode / archive.ts 同一套口径）：
 *   - 是文件里最后一个 workflow（Schema 的 `workflows` 是 `minItems: 1`）；
 *   - 该 workflow 里有**正在计时**的条目（先结束计时，别把计时器删成孤儿）；
 *   - 该 workflow 里含带 `archive` 的浓缩节点（归档来源节点不能删）。
 *
 * 写盘统一由上层套进 `mutateFile` → `applyMutation`（安全闸门 → 升格 → 三段写回 → 幂等校验），
 * 所以这里「要么把文档改对，要么什么都不动」：`applyWorkflowEdits` 先**整批预检**再动手，
 * 任一条不过就整笔拒绝（Modal 保持打开，用户看到的是原因）。
 */

import { applyWorkflowArchiveNotes, type ArchiveFormInput } from "./archive.ts";
import { createNode, createWorkflow, type NewNodeInput } from "./factory.ts";
import { checkIntegerInRange, checkIsoTimestamp } from "./nodeEdits.ts";
import { formatLocalIso } from "./time.ts";
import { aggregateTimeEntries } from "./timeStats.ts";
import { findWorkflow, walkWorkflow } from "./tree.ts";
import {
  IMPORTANCE_MAX,
  IMPORTANCE_MIN,
  PROGRESS_MAX,
  PROGRESS_MIN,
  isWorkflowState,
  type WfJsonDocument,
  type WfNode,
  type WfWorkflow,
  type WorkflowState,
} from "./types.ts";
import { sanitizeTitle } from "./wfjsonWrite.ts";

/* ------------------------------------------------------------------ *
 * 可编辑字段（Modal 的分字段表单 / clear 的取值集合）
 * ------------------------------------------------------------------ */

/**
 * `patch` 的键（= 表单里的空格）：
 *  - `title` / `progress` 属于 workflow；`rootTitle` 与其余属于 root；
 *  - `rootTitle` 有意不叫 `title`，否则与 workflow 的 `title` 在 `clear` 里分不清谁是谁。
 *
 * Phase 45：删除 `summary`（节点概要已废弃）；四条复盘说明走 `WorkflowPatch.archive`。
 */
export const WORKFLOW_EDIT_FIELDS = [
  "title",
  "progress",
  "progress_max",
  /** @deprecated v1.6：根节点标题由 workflow.title 强制同步，本项仅为兼容旧调用方保留 */
  "rootTitle",
  "type",
  "importance",
  "urgency",
  "rootProgress",
  "rootProgressMax",
  "owner",
  "dueAt",
  "tags",
  /** v0.7 §⑨-8：「进行中」= 没有该键（走 `clear`），`archived` / `cancelled` 走 `patch` */
  "state",
] as const;
export type WorkflowEditFieldKey = (typeof WORKFLOW_EDIT_FIELDS)[number];

/** 字段中文名（Modal 标签 / 报错提示共用） */
export const WORKFLOW_EDIT_LABELS: Readonly<Record<WorkflowEditFieldKey, string>> = {
  title: "工作流标题",
  progress: "工作流已完成",
  progress_max: "工作流总量",
  rootTitle: "根节点标题",
  type: "根节点类型",
  importance: "根节点重要度",
  urgency: "根节点紧急度",
  rootProgress: "根节点已完成",
  rootProgressMax: "根节点总量",
  owner: "根节点负责人",
  dueAt: "根节点截止时间",
  tags: "根节点标签",
  state: "工作流状态",
};

/** 分字段改动：`patch` = 覆盖，`clear` = 删除（同名字段两处都有时 `patch` 赢） */
export interface WorkflowPatch {
  title?: string;
  progress?: number;
  progress_max?: number;
  /** @deprecated v1.6：根节点标题恒等于 workflow.title，写入时会被覆盖 */
  rootTitle?: string;
  type?: string;
  importance?: number;
  urgency?: number;
  rootProgress?: number;
  rootProgressMax?: number;
  owner?: string;
  dueAt?: string;
  tags?: string[];
  /**
   * 工作流状态（v0.7 §⑨-8）：`archived` / `cancelled`；
   * **「进行中」不要用本字段表达** —— 走 `clear: ["state"]`（删键）。
   */
  state?: WorkflowState;
  /**
   * Phase 45：四条复盘说明（`workflow.archive` 的 summary / idea / review / tag）。
   *
   * 普通工作流只写这四个键（**不合成** `archivedAt` / `from_*`）；
   * 归档文件自己的 workflow 用同一张表改说明时，那三个事实键原样保留。
   * 给了就按「非空覆盖 / 空删键」整组应用（见 `applyWorkflowArchiveNotes`）。
   */
  archive?: ArchiveFormInput;
}

/** 三个原语的共同返回：`ok=false` 时文档未被改动，只有 `reason` 有意义 */
export interface WorkflowEditResult {
  ok: boolean;
  /** ok=false 时的原因（直接给用户看的中文） */
  reason?: string;
  /** 受影响的节点 id（供上层做局部刷新） */
  changedNodeIds: string[];
  /** **结构发生变化**（有增删）→ 视图必须整块重渲染，不能只重建几列 */
  structureChanged: boolean;
  /** 内容与现状完全一致（不刷新 `updatedAt`、不产生一次无意义的三段重写） */
  unchanged?: boolean;
  /** 需要从正文删掉的纪要锚点（删除整个 workflow 时 = 它全部节点的锚点） */
  removedNoteAnchors?: string[];
  /** 标题清洗给出的提示（含 # / | / [ / ]），供上层转成 Notice */
  warnings?: string[];
}

export interface AddWorkflowResult extends WorkflowEditResult {
  /** ok=true 时新工作流的 id */
  workflowId?: string;
  /** ok=true 时新根节点的 id（写回后正文会补上 `### 标题 ^id`） */
  rootId?: string;
}

/* ------------------------------------------------------------------ *
 * 校验（引擎兜底；Modal 保存前用同一句话就地校验）
 * ------------------------------------------------------------------ */

/** trim 后为空 → undefined（Schema 的 `TEXT` 是 `minLength: 1`，不写空串） */
function textOrUndefined(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  return text.length > 0 ? text : undefined;
}

/** 标签清洗：去空白、丢掉空项、去重保序（沿用 Modal 侧 `splitTags` 的口径） */
function cleanTags(tags: readonly string[] | undefined): string[] | undefined {
  if (tags === undefined) return undefined;
  const seen = new Set<string>();
  const cleaned: string[] = [];
  for (const tag of tags) {
    const text = typeof tag === "string" ? tag.trim() : "";
    if (text.length === 0 || seen.has(text)) continue;
    seen.add(text);
    cleaned.push(text);
  }
  return cleaned.length > 0 ? cleaned : undefined;
}

/**
 * 校验 `patch`（返回中文原因；全部合法时 undefined）。
 *
 * 边界与 Schema 完全一致：`progress` / `progress_max` / `rootProgress` / `rootProgressMax` 0-999、
 * `importance` / `urgency` 1-4（整数），`dueAt` ISO8601。
 * `title` 是必填字段：给了就不能是空串（要清空 = 删除工作流，走另一条路）；
 * `rootTitle` 自 v1.6 起由 `title` 强制覆盖（保留仅为兼容）。
 */
export function validateWorkflowPatch(patch: WorkflowPatch): string | undefined {
  if (patch.title !== undefined && patch.title.trim().length === 0) {
    return `${WORKFLOW_EDIT_LABELS.title}不能为空（要移除整个工作流请用「删除」）`;
  }
  if (patch.rootTitle !== undefined && patch.rootTitle.trim().length === 0) {
    return `${WORKFLOW_EDIT_LABELS.rootTitle}不能为空`;
  }
  if (patch.progress !== undefined) {
    const reason = checkIntegerInRange(WORKFLOW_EDIT_LABELS.progress, patch.progress, PROGRESS_MIN, PROGRESS_MAX);
    if (reason !== undefined) return reason;
  }
  if (patch.progress_max !== undefined) {
    const reason = checkIntegerInRange(WORKFLOW_EDIT_LABELS.progress_max, patch.progress_max, PROGRESS_MIN, PROGRESS_MAX);
    if (reason !== undefined) return reason;
  }
  if (patch.rootProgress !== undefined) {
    const reason = checkIntegerInRange(WORKFLOW_EDIT_LABELS.rootProgress, patch.rootProgress, PROGRESS_MIN, PROGRESS_MAX);
    if (reason !== undefined) return reason;
  }
  if (patch.rootProgressMax !== undefined) {
    const reason = checkIntegerInRange(WORKFLOW_EDIT_LABELS.rootProgressMax, patch.rootProgressMax, PROGRESS_MIN, PROGRESS_MAX);
    if (reason !== undefined) return reason;
  }
  if (patch.importance !== undefined) {
    const reason = checkIntegerInRange(WORKFLOW_EDIT_LABELS.importance, patch.importance, IMPORTANCE_MIN, IMPORTANCE_MAX);
    if (reason !== undefined) return reason;
  }
  if (patch.urgency !== undefined) {
    const reason = checkIntegerInRange(WORKFLOW_EDIT_LABELS.urgency, patch.urgency, IMPORTANCE_MIN, IMPORTANCE_MAX);
    if (reason !== undefined) return reason;
  }
  if (patch.dueAt !== undefined) {
    const reason = checkIsoTimestamp(WORKFLOW_EDIT_LABELS.dueAt, patch.dueAt);
    if (reason !== undefined) return reason;
  }
  // v0.7 §⑨-8：「进行中」靠删键（clear）表达，patch 只接受 archived / cancelled
  if (patch.state !== undefined && !isWorkflowState(patch.state)) {
    return `${WORKFLOW_EDIT_LABELS.state}只能是 archived / cancelled（进行中请留空）`;
  }
  return undefined;
}

/* ------------------------------------------------------------------ *
 * 字段级写入 / 删除
 * ------------------------------------------------------------------ */

/** 删掉一个字段（`title` / `rootTitle` 是必填：调用方已拦下，这里只做兜底） */
function clearWorkflowField(workflow: WfWorkflow, key: WorkflowEditFieldKey): void {
  const root = workflow.root;
  switch (key) {
    case "title":
    case "rootTitle":
      return;
    case "progress":
      delete workflow.progress;
      return;
    case "progress_max":
      delete workflow.progress_max;
      return;
    case "rootProgress":
      delete root.progress;
      return;
    case "rootProgressMax":
      delete root.progress_max;
      return;
    case "type":
      delete root.type;
      return;
    case "importance":
      delete root.importance;
      return;
    case "urgency":
      delete root.urgency;
      return;
    case "owner":
      delete root.owner;
      return;
    case "dueAt":
      delete root.dueAt;
      return;
    case "tags":
      delete root.tags;
      return;
    case "state":
      // v0.7 §⑨-8：清空 = 回到「进行中」（该键缺省）
      delete workflow.state;
      return;
  }
}

/**
 * 把 `patch` / `clear` 应用到某个 workflow 上，返回「是否真的改了内容」。
 *
 * 文本字段：trim 后为空 = 删除该键（Schema 的 `TEXT` 是 `minLength: 1`）；
 * `tags`：清洗（去空白 / 丢空项 / 去重保序），清空 = 删除该键。
 */
function applyEdit(workflow: WfWorkflow, patch: WorkflowPatch, clear: readonly WorkflowEditFieldKey[]): boolean {
  const root = workflow.root;
  const before = JSON.stringify(workflow);

  for (const key of clear) {
    if (patch[key] !== undefined) continue; // 同一字段两处都有 → patch 赢
    clearWorkflowField(workflow, key);
  }

  const title = textOrUndefined(patch.title);
  if (patch.title !== undefined && title !== undefined) workflow.title = title;
  if (patch.progress !== undefined) workflow.progress = patch.progress;
  if (patch.progress_max !== undefined) workflow.progress_max = patch.progress_max;
  const rootTitle = textOrUndefined(patch.rootTitle);
  if (patch.rootTitle !== undefined && rootTitle !== undefined) root.title = rootTitle;
  // v1.6：workflow.title 是唯一事实来源 —— 改标题时强制覆盖根节点标题（放在 rootTitle 之后）
  if (patch.title !== undefined && title !== undefined) root.title = workflow.title;
  if (patch.rootProgress !== undefined) root.progress = patch.rootProgress;
  if (patch.rootProgressMax !== undefined) root.progress_max = patch.rootProgressMax;

  const type = textOrUndefined(patch.type);
  if (patch.type !== undefined) {
    if (type !== undefined) root.type = type;
    else delete root.type;
  }
  if (patch.importance !== undefined) root.importance = patch.importance;
  if (patch.urgency !== undefined) root.urgency = patch.urgency;
  const owner = textOrUndefined(patch.owner);
  if (patch.owner !== undefined) {
    if (owner !== undefined) root.owner = owner;
    else delete root.owner;
  }
  const dueAt = textOrUndefined(patch.dueAt);
  if (patch.dueAt !== undefined) {
    if (dueAt !== undefined) root.dueAt = dueAt;
    else delete root.dueAt;
  }
  if (patch.tags !== undefined) {
    const tags = cleanTags(patch.tags);
    if (tags !== undefined) root.tags = tags;
    else delete root.tags;
  }
  // v0.7 §⑨-8：工作流状态（进行中不写这个键：patch 里没有就保持原样，清空走 clear）
  if (patch.state !== undefined && isWorkflowState(patch.state)) workflow.state = patch.state;

  // Phase 45：四条复盘说明（workflow.archive）—— 放在最后，结尾的 JSON 比对天然包含它
  if (patch.archive !== undefined) applyWorkflowArchiveNotes(workflow, patch.archive);

  return JSON.stringify(workflow) !== before;
}

/** 一条编辑请求的合法性（`editWorkflow` 与整批预检共用同一句话） */
function checkEditRequest(patch: WorkflowPatch, clear: readonly WorkflowEditFieldKey[]): string | undefined {
  const invalid = validateWorkflowPatch(patch);
  if (invalid !== undefined) return invalid;
  for (const key of clear) {
    if (patch[key] !== undefined) continue;
    if (key === "title" || key === "rootTitle") return `${WORKFLOW_EDIT_LABELS[key]}不能清空（必填）`;
  }
  return undefined;
}

/** 节点正文锚点（没写 `noteAnchor` 时按 `id` 推导 —— 与 writeBackDocument 的默认一致） */
function anchorOf(node: WfNode): string {
  return node.noteAnchor ?? `^${node.id}`;
}

/* ------------------------------------------------------------------ *
 * ① 新增工作流（自带新 root，追加到 `workflows[]` 末尾）
 * ------------------------------------------------------------------ */

/**
 * 新增一个工作流：
 *  - `title` 必填（先过 `sanitizeTitle`：空 / 含换行 → 拒绝，含 `#` / `|` / `[` / `]` → 提示）；
 *  - `rootTitle` 缺省 = 工作流标题；新 root 显式给 `status=doing` + `startAt=now`
 *    （其余默认值交给 `createNode`：progress=1、collapsed=false、生成 nd-<uuid> 与 `^id` 锚点）；
 *  - 其余字段（type / importance / urgency / owner / dueAt / tags / archive 四条说明）有值才写，不写空串。
 */
export function addWorkflow(
  document: WfJsonDocument,
  patch: WorkflowPatch = {},
  now: Date = new Date(),
): AddWorkflowResult {
  const warnings: string[] = [];
  const reject = (reason: string): AddWorkflowResult => ({
    ok: false,
    reason,
    changedNodeIds: [],
    structureChanged: false,
    warnings,
  });

  const invalid = validateWorkflowPatch(patch);
  if (invalid !== undefined) return reject(invalid);

  const rawTitle = textOrUndefined(patch.title);
  if (rawTitle === undefined) return reject("新增工作流必须填标题");
  const title = sanitizeTitle(rawTitle);
  if (!title.ok) return reject(title.reason ?? `${WORKFLOW_EDIT_LABELS.title}不合法`);
  warnings.push(...title.warnings);

  const rootTitle = sanitizeTitle(textOrUndefined(patch.rootTitle) ?? title.title);
  if (!rootTitle.ok) return reject(rootTitle.reason ?? `${WORKFLOW_EDIT_LABELS.rootTitle}不合法`);
  warnings.push(...rootTitle.warnings);

  const rootInput: NewNodeInput = { title: rootTitle.title, status: "doing", startAt: formatLocalIso(now) };
  const type = textOrUndefined(patch.type);
  const owner = textOrUndefined(patch.owner);
  const dueAt = textOrUndefined(patch.dueAt);
  const tags = cleanTags(patch.tags);
  if (type !== undefined) rootInput.type = type;
  if (owner !== undefined) rootInput.owner = owner;
  if (dueAt !== undefined) rootInput.dueAt = dueAt;
  if (tags !== undefined) rootInput.tags = tags;
  if (patch.importance !== undefined) rootInput.importance = patch.importance;
  if (patch.urgency !== undefined) rootInput.urgency = patch.urgency;

  const workflow = createWorkflow({ title: title.title, root: createNode(rootInput, now) }, now);
  if (patch.progress !== undefined) workflow.progress = patch.progress;
  // v0.7 §⑨-8：新增时也可以直接建成「完成 / 取消」（缺省 = 进行中）
  if (patch.state !== undefined && isWorkflowState(patch.state)) workflow.state = patch.state;
  // Phase 45：新增时也可以直接带四条复盘说明（不合成 archivedAt / from_*）
  if (patch.archive !== undefined) applyWorkflowArchiveNotes(workflow, patch.archive);
  document.workflows.push(workflow);

  return {
    ok: true,
    workflowId: workflow.id,
    rootId: workflow.root.id,
    changedNodeIds: [workflow.root.id],
    structureChanged: true,
    warnings,
  };
}

/* ------------------------------------------------------------------ *
 * ② 删除工作流（连根带全部节点；三道护栏）
 * ------------------------------------------------------------------ */

/**
 * 删除护栏（返回拒绝原因；undefined = 可以删）：
 *  - 文件里最后一个 workflow 不能删（Schema 的 `workflows` 是 `minItems: 1`）；
 *  - 有正在计时的条目 → 拒绝（先结束计时，别把计时器删成孤儿）；
 *  - 含带 `archive` 的浓缩节点 → 拒绝（与 `removeNode` 一致：归档来源节点不能删）。
 */
function checkRemoval(document: WfJsonDocument, workflow: WfWorkflow): string | undefined {
  if (document.workflows.length <= 1) {
    return "至少要保留一个工作流（wfjson 的 workflows 非空）";
  }
  const running = aggregateTimeEntries(document).activeEntry;
  if (running !== undefined && running.workflowId === workflow.id) {
    return `「${workflow.title}」里有正在计时的节点（「${running.nodeTitle}」，开始于 ${running.startAt}），请先结束计时`;
  }
  const archived = walkWorkflow(workflow).find((visit) => visit.node.archive !== undefined);
  if (archived !== undefined) {
    return `「${workflow.title}」含归档来源节点（「${archived.node.title}」带 archive），不能删除`;
  }
  return undefined;
}

/**
 * 删除一个工作流：连它的根与全部后代节点一起从 `workflows[]` 里摘掉。
 *
 * 不传 `now`：被删的节点不再落盘，`document.updatedAt` 由 `applyMutation` 统一刷新。
 * 正文里的纪要段落通过 `removedNoteAnchors`（该 workflow 全部节点的锚点）上报给
 * `writeBackDocument` 删除 —— 留着它们会变成 `NOTE_ANCHOR_MISSING_IN_BODY`（error 级）的孤儿锚点，
 * 写回的幂等校验会整笔回滚。
 */
export function removeWorkflow(document: WfJsonDocument, workflowId: string): WorkflowEditResult {
  const index = document.workflows.findIndex((workflow) => workflow.id === workflowId);
  const workflow = index >= 0 ? document.workflows[index] : undefined;
  if (workflow === undefined) {
    return { ok: false, reason: `工作流 ${workflowId} 不存在（可能已被删除）`, changedNodeIds: [], structureChanged: false };
  }
  const guard = checkRemoval(document, workflow);
  if (guard !== undefined) {
    return { ok: false, reason: guard, changedNodeIds: [], structureChanged: false };
  }

  const nodes = walkWorkflow(workflow).map((visit) => visit.node);
  document.workflows.splice(index, 1);
  return {
    ok: true,
    changedNodeIds: nodes.map((node) => node.id),
    structureChanged: true,
    removedNoteAnchors: nodes.map(anchorOf),
  };
}

/* ------------------------------------------------------------------ *
 * ③ 编辑工作流（逐字段：patch 覆盖 / clear 删除 / 其余不动）
 * ------------------------------------------------------------------ */

/** 编辑一个工作流的字段（`title` / `rootTitle` 必填：`clear` 它们会被拒绝） */
export function editWorkflow(
  document: WfJsonDocument,
  workflowId: string,
  patch: WorkflowPatch = {},
  clear: readonly WorkflowEditFieldKey[] = [],
  now: Date = new Date(),
): WorkflowEditResult {
  const workflow = findWorkflow(document, workflowId);
  if (workflow === undefined) {
    return { ok: false, reason: `工作流 ${workflowId} 不存在（可能已被删除）`, changedNodeIds: [], structureChanged: false };
  }
  const invalid = checkEditRequest(patch, clear);
  if (invalid !== undefined) {
    return { ok: false, reason: invalid, changedNodeIds: [], structureChanged: false };
  }

  const changed = applyEdit(workflow, patch, clear);
  if (!changed) return { ok: true, changedNodeIds: [], structureChanged: false, unchanged: true };
  workflow.root.updatedAt = formatLocalIso(now);
  return { ok: true, changedNodeIds: [workflow.root.id], structureChanged: false };
}

/* ------------------------------------------------------------------ *
 * ④ 整批编排（Modal「⚙️ 修改工作流」保存时一次写回）
 * ------------------------------------------------------------------ */

/** 一条「改某个已有工作流」的请求 */
export interface WorkflowEditRequest {
  id: string;
  patch?: WorkflowPatch;
  clear?: readonly WorkflowEditFieldKey[];
}

/** Modal 收集到的整批改动（一次写回全部应用；任一条不过 → 整笔拒绝） */
export interface WorkflowEditPlan {
  /** 待编辑（按数组顺序应用） */
  edits?: WorkflowEditRequest[];
  /** 待新增（按数组顺序追加到 `workflows[]` 末尾） */
  additions?: WorkflowPatch[];
  /** 待删除的 workflow id */
  removals?: string[];
}

export interface WorkflowPlanResult extends WorkflowEditResult {
  addedWorkflowIds: string[];
  removedWorkflowIds: string[];
  editedWorkflowIds: string[];
  /** 删除时上报的纪要锚点（交给 `writeBackDocument` 删段落） */
  removedNoteAnchors: string[];
  /** 全部成功（含「没有任何改动」）时为 true */
  ok: boolean;
}

/**
 * 整批应用工作流改动（**先整批预检、再动手**：任一条不过 → `ok=false` + 原因，文档一动不动）。
 *
 * 顺序：**先删 → 再改 → 最后加**（删除的 id 不会与编辑 / 新增撞车；新增一律追加到末尾）。
 * 预检覆盖：id 存在性、同一 workflow 不能既删又改、每个 patch / clear 的合法性、
 * 删除护栏（最后一个 / 正在计时 / 含 archive），以及「删完加完之后至少还剩一个 workflow」。
 *
 * 注意：`ok=false` 时文档**可能已被前面的步骤改过**（没做内存回滚）—— 这是有意的：
 * 上层 `applyMutation` 遇到 `reject` 会直接返回**原文**，这些内存改动不会被落盘。
 */
export function applyWorkflowEdits(
  document: WfJsonDocument,
  plan: WorkflowEditPlan = {},
  now: Date = new Date(),
): WorkflowPlanResult {
  const removals = [...new Set(plan.removals ?? [])];
  const edits = plan.edits ?? [];
  const additions = plan.additions ?? [];
  const warnings: string[] = [];

  const fail = (reason: string): WorkflowPlanResult => ({
    ok: false,
    reason,
    changedNodeIds: [],
    structureChanged: false,
    addedWorkflowIds: [],
    removedWorkflowIds: [],
    editedWorkflowIds: [],
    removedNoteAnchors: [],
    warnings,
  });

  // ---- 1) 整批预检（任何一条不过就整笔拒绝，Modal 保持打开让用户改） ----
  for (const id of removals) {
    const workflow = findWorkflow(document, id);
    if (workflow === undefined) return fail(`工作流 ${id} 不存在（可能已被删除）`);
    if (edits.some((edit) => edit.id === id)) {
      return fail(`「${workflow.title}」不能同时删除与编辑`);
    }
    const guard = checkRemoval(document, workflow);
    if (guard !== undefined) return fail(guard);
  }
  for (const edit of edits) {
    const workflow = findWorkflow(document, edit.id);
    if (workflow === undefined) return fail(`工作流 ${edit.id} 不存在（可能已被删除）`);
    const invalid = checkEditRequest(edit.patch ?? {}, edit.clear ?? []);
    if (invalid !== undefined) return fail(`「${workflow.title}」：${invalid}`);
  }
  for (const patch of additions) {
    const invalid = validateWorkflowPatch(patch);
    if (invalid !== undefined) return fail(`新增工作流：${invalid}`);
    if (textOrUndefined(patch.title) === undefined) return fail("新增工作流必须填标题");
  }
  if (document.workflows.length - removals.length + additions.length < 1) {
    return fail("至少要保留一个工作流（wfjson 的 workflows 非空）");
  }

  // ---- 2) 应用（预检已过 → 这里不会再失败） ----
  const changedNodeIds: string[] = [];
  const removedNoteAnchors: string[] = [];
  const removedWorkflowIds: string[] = [];
  const editedWorkflowIds: string[] = [];
  const addedWorkflowIds: string[] = [];

  for (const id of removals) {
    const result = removeWorkflow(document, id);
    if (!result.ok) return fail(result.reason ?? `删除工作流 ${id} 失败`);
    removedWorkflowIds.push(id);
    changedNodeIds.push(...result.changedNodeIds);
    removedNoteAnchors.push(...(result.removedNoteAnchors ?? []));
  }

  for (const edit of edits) {
    const result = editWorkflow(document, edit.id, edit.patch ?? {}, edit.clear ?? [], now);
    if (!result.ok) return fail(result.reason ?? `编辑工作流 ${edit.id} 失败`);
    if (result.unchanged === true) continue;
    editedWorkflowIds.push(edit.id);
    changedNodeIds.push(...result.changedNodeIds);
  }

  for (const patch of additions) {
    const result = addWorkflow(document, patch, now);
    if (!result.ok) return fail(result.reason ?? "新增工作流失败");
    if (result.workflowId !== undefined) addedWorkflowIds.push(result.workflowId);
    changedNodeIds.push(...result.changedNodeIds);
    warnings.push(...(result.warnings ?? []));
  }

  const structureChanged = removedWorkflowIds.length > 0 || addedWorkflowIds.length > 0;
  return {
    ok: true,
    changedNodeIds,
    structureChanged,
    unchanged: changedNodeIds.length === 0 && !structureChanged,
    addedWorkflowIds,
    removedWorkflowIds,
    editedWorkflowIds,
    removedNoteAnchors,
    warnings,
  };
}
