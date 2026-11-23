/**
 * 归档（Phase 4；Phase 28 起产物是纯 `.wf.json`）：子树浓缩 + 归档文档生成（纯 TypeScript、零 Obsidian 依赖）。
 *
 * 定稿契约：`doc/datacontact/data_ixd_discuss_interact_v0.3.md`《归档功能定稿契约（Phase 4）》、
 * `doc/datacontact/data_ixd_v01.md` §2.10（`archive` 字段）/ §5（写回顺序）。
 *
 * 本文件只算「文档该长什么样」：内存改动（`archiveNode`）+ 归档文档（`planArchive().document`）；
 * 落盘（`vault.create` / `vault.process`）与 Modal 在 main.ts，视图（views/wfView.ts）只管交互。
 *
 * 两步（**先建归档 `.wf.json` → 成功后改原文件**；中途失败可幂等重试）：
 *   1. `planArchive()`：只读地算出归档计划 —— 归档文档（`WfJsonDocument`，workflow 带
 *      `archive` 元数据：时间 / 来源 / 三段文字）、确定性路径 `archive/<短id>.wf.json`、
 *      要挂到浓缩节点上的 `archive` 指针（`{ workflowId }`）、要从原文件正文删掉的旧纪要锚点；
 *   2. `archiveNode()`：把原文件的内存文档改对 —— 浓缩节点只保留
 *      `id / title / status=done / importance / tags / 时间信息（timeEntries 累加 + completedAt 取最晚）/
 *      archive`，`children` 清空，子树整体消失；被删后代的旧纪要段通过
 *      `removedNoteAnchors` 上报给写回层删掉。
 *
 * 边界（任一不满足即拒绝，文档一动不动；理由文案同时用于右键菜单置灰与写回提示）：
 *   - 根节点不能归档（它是泳道入口，也是「正在进行」块的定位点）；
 *   - 叶子节点没有子树，没什么可浓缩（已归档节点同理：没有「新子树」可追加）；
 *   - 浓缩节点及其**全部后代**必须 `done`（"为此及之后归档" = 这个位置往后都做完了）。
 *
 * Phase 36（重复归档）：节点带 `archive` **不再**一票否决 —— 只要又长出新的（全 done）子树，
 * 就允许再归档一次：本次子树**追加**到旧归档文件的根节点下（`planArchiveAppend`），
 * `archive.workflowId` 沿用旧的、`archivedAt` 取本次 —— 一个节点始终只有一份不断长大的归档文件。
 *
 * 归档文件（`archive/<workflowId>-<nodeId>.wf.json`，Phase 28 起只产这一份纯 JSON）：
 *   - 内容 = 原子树（浓缩节点当根）+ 全部后代，**所有数据保留**（status / 时间 / 关系 / 纪要摘要都在），
 *     没有 md 正文 / 纪要段（Phase 27 起不再生成 `### 标题 ^新id` 段落）；
 *   - 节点 `id` **全部重新生成**（契约：不做节点追溯），`noteAnchor` 不再生成 / 随写回剥离；
 *   - `relations[].target` 跟着重定向（否则归档文件里全是「目标找不到」）：指向子树内部 → 换成新 id；
 *     指向子树外部（留在原文件里的邻居 / 工作流）→ 写成跨文件引用 `<原文件id>#<原id>`（契约的跨文件写法）；
 *   - `workflow`：新 id（= 浓缩节点的 `archive.workflowId`）、`title` = `<原节点标题>（已归档）`、
 *     `originId` = 原文档浓缩节点 `id`；**不带 `state`**（缺省即进行中，归档文件自己还能被再归档 / 取消）；
 *   - `document.id` 也新生成（文件级稳定 id，不与原文件冲突）。
 *
 * 幂等重试（路径确定性 + `createIfAbsent`）：`workflowId` 每次 plan 都是新 uuid，重试时**推不出来**，
 * 所以插件层按文件名里的短 uid（`isArchivePathForNode`）扫 `archive/` → 读回候选文件身份
 * （`readArchivedWorkflowIdentity`）→ 只有 `originId === nodeId` 才认这一份（顺序：先扫 → 命中复用；
 * 没有命中才 `create`）。这样节点侧 `archive.workflowId` 永远与磁盘上那份一致，重试也不会覆盖既有归档。
 *
 * Phase 28（本模块的落盘形态）：`plan.document` 直接由插件 `stringifyWfJson` 写成
 * `archive/<workflowId>-<nodeId>.wf.json`（**单文件**，不再有 md / 侧车成对形态）。
 * 老的内联归档（正文里带 wfjson 代码块）仍读得动，身份用 `readArchivedWorkflowIdentity(markdown)` 兜底。
 *
 * Phase 22（「归档整个工作流」）：根节点也能归档 —— 走的是同一套浓缩 / 归档文件机制，只有三处不同：
 *   1. 资格看**整棵树全 done**（`workflowArchiveEligibility`），不再要求「有子树」；
 *   2. 归档文件的 `workflow` **不写 `originId`**（整条流都搬过去了，没有「来源节点」这一说）；
 *   3. 原文件额外写一条**文件级台账** `workflow_archive[]`（`workflowId` / `title` / `noteAnchor` / `archive`），
 *      重试时的认领判据也变成「这份文件没有 `originId`」。
 * 节点级归档（`archiveNode`）的行为与字段一个字节都没动。
 */

import { analyzeDocument, analyzeMarkdown } from "./analyze.ts";
import { anchorForNode, newFileId, newNodeId, newWorkflowId, shortIdOf } from "./ids.ts";
import { formatLocalDate, formatLocalIso, parseIso } from "./time.ts";
import { findNode, findNodePath, findParentNode } from "./tree.ts";
import {
  boardFolderOf,
  SCHEMA_VERSION,
  type WfArchive,
  type WfJsonDocument,
  type WfNode,
  type WfTimeEntry,
  type WfWorkflow,
  type WfWorkflowArchive,
  type WfWorkflowArchiveEntry,
} from "./types.ts";

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/**
 * 归档文件 所在目录的**当前**值（vault 相对路径；不存在时由插件层新建）。
 *
 * 跟着设置 `boardFolder` 走 —— 默认 `_workflowwatcher/archive`。
 * 需要**出厂默认值**（测试 / 兼容）时读下面的 `ARCHIVE_FOLDER` 常量。
 */
export function archiveFolderOf(): string {
  return `${boardFolderOf()}/archive`;
}

/** 归档文件 所在目录的出厂默认值（默认看板目录下；业务代码用 `archiveFolderOf()`） */
export const ARCHIVE_FOLDER = "_workflowwatcher/archive";

/** 归档文件 里 workflow 标题的后缀（人一眼看出这是归档文件里的流） */
export const ARCHIVE_TITLE_SUFFIX = "（已归档）";

/**
 * 浓缩节点要**删掉**的字段（契约 §5「删除字段清单」）。
 * 其余字段（`id` / `title` / `status` / `importance` / `startAt` / `updatedAt` /
 * `completedAt` / `timeEntries` / `archive`）保留。
 * v1.6 起 `progress` / `progress_max` 都删；`links_relative_path` 也删。
 *
 * Phase 45：`summary` 仍是本清单成员 —— 节点概要已废弃，但**旧文件里可能还留着**，
 * 浓缩归档时顺手清掉（说明文字改在工作流的 `workflow.archive` 上）。
 */
type PrunedField =
  | "summary"
  | "type"
  | "urgency"
  | "collapsed"
  | "progress"
  | "progress_max"
  | "owner"
  | "dueAt"
  | "links_relative_path"
  | "estimate"
  | "aliases"
  | "aiContext"
  | "relations"
  | "links"
  | "statusHistory";

const PRUNED_FIELDS: readonly PrunedField[] = [
  "summary",
  "type",
  "urgency",
  "collapsed",
  "progress",
  "progress_max",
  "owner",
  "dueAt",
  "links_relative_path",
  "estimate",
  "aliases",
  "aiContext",
  "relations",
  "links",
  "statusHistory",
];

/* ------------------------------------------------------------------ *
 * ① 归档资格（视图置灰 + 引擎拒绝共用同一套理由）
 * ------------------------------------------------------------------ */

export interface ArchiveEligibility {
  ok: boolean;
  /** 不能归档的一句话理由（`ok = false` 时给出；文案保持短，右键菜单会拼在菜单项里） */
  reason?: string;
}

/** 子树里第一个非 `done` 的节点（含自身；都 done 时 undefined） */
function firstUnfinished(node: WfNode): WfNode | undefined {
  if (node.status !== "done") return node;
  for (const child of node.children ?? []) {
    const found = firstUnfinished(child);
    if (found !== undefined) return found;
  }
  return undefined;
}

/**
 * 「为此及之后归档」的资格判断（**只看这一棵子树**，不看文档别处）：
 * 根节点 / 叶子 / 子树里有非 done → 拒绝。
 *
 * Phase 36：已归档节点**不再**直接拒绝 —— 再长出新的全 done 子树时可以再归档一次（追加，
 * 见 `planArchiveAppend`）；只有「已归档且没有子树」时给一条更贴切的原因（而不是「叶子节点」）。
 *
 * 视图拿到的就是文档里的节点对象，所以这里不需要文档；`isRoot` 由调用方给
 * （视图的 `renderSubtree` 知道，写回侧用 `findParentNode` 算）。
 */
export function archiveEligibility(node: WfNode, isRoot: boolean): ArchiveEligibility {
  if (isRoot) return { ok: false, reason: "根节点不能归档" };
  const children = node.children ?? [];
  if (children.length === 0) {
    return {
      ok: false,
      reason: node.archive !== undefined ? "已归档，没有新子树可追加" : "叶子节点没有子树",
    };
  }
  const unfinished = firstUnfinished(node);
  if (unfinished !== undefined) {
    return { ok: false, reason: `子树里「${unfinished.title}」还没做完` };
  }
  return { ok: true };
}

export interface ArchiveEligibilityCheck extends ArchiveEligibility {
  /** 命中的节点（不存在时缺省） */
  node?: WfNode;
  /** 是否是 workflow 根节点（根节点不能归档） */
  isRoot?: boolean;
}

/** 按 id 在文档里查资格（写回侧用；节点不存在也算不通过） */
export function checkArchiveEligibility(document: WfJsonDocument, nodeId: string): ArchiveEligibilityCheck {
  const node = findNode(document, nodeId);
  if (node === undefined) return { ok: false, reason: `节点 ${nodeId} 不存在（可能已被删除）` };
  const isRoot = findParentNode(document, nodeId) === undefined;
  const verdict = archiveEligibility(node, isRoot);
  const check: ArchiveEligibilityCheck = { ok: verdict.ok, node, isRoot };
  if (verdict.reason !== undefined) check.reason = verdict.reason;
  return check;
}

/* ------------------------------------------------------------------ *
 * ② 归档计划（只读：不改文档）
 * ------------------------------------------------------------------ */

/** 归档表单（Modal 收集；三项都选填，空串按「没填」处理 → 省略该键） */
export interface ArchiveFormInput {
  /** 概括 */
  summary?: string;
  /** 底层原理 / 启发 */
  idea?: string;
  /** 怎么提高效率 / 接下来做什么 */
  review?: string;
  /** 归档标签（Phase 39：枚举来自 archive_tag.yaml，可多选） */
  tag?: string[];
}

export interface ArchivePlan {
  /** 原文档里的浓缩节点 id（`archive.file` / 「已归档」块都用它定位） */
  nodeId: string;
  nodeTitle: string;
  /** 归档文件的 vault 相对路径（确定性：`archive/<workflowId>-<nodeId>.wf.json`） */
  file: string;
  /** 归档文件里的 workflow id（要写进浓缩节点的 `archive.workflowId`） */
  workflowId: string;
  /** 要挂到原文档浓缩节点上的 `archive` 字段 */
  archive: WfArchive;
  /** 归档文件里的节点数（浓缩节点 + 全部后代） */
  nodeCount: number;
  /** 要从原文件正文删掉的纪要锚点（被删后代，按先序；不含浓缩节点自己） */
  removedNoteAnchors: string[];
  /**
   * 归档文件对应的**文档对象**（新 workflow：id / originId / 重映射后的 id 都在里面）。
   *
   * Phase 28 起归档只产这一份 JSON（不再生成 md / 侧车成对形态）。
   */
  document: WfJsonDocument;
}

export interface ArchivePlanResult {
  ok: boolean;
  reason?: string;
  plan?: ArchivePlan;
}

/** 归档时间：`YYYY-MM-DD HH:MM`（本地日历 + 精确到分钟；契约定的展示口径） */
export function formatArchivedAt(now: Date = new Date()): string {
  const hour = now.getHours();
  const minute = now.getMinutes();
  return `${formatLocalDate(now)} ${hour < 10 ? `0${hour}` : hour}:${minute < 10 ? `0${minute}` : minute}`;
}

/** 文件名时间戳：`YYYYMMDD-HHmmss`（本地） */
function formatFileStamp(now: Date): string {
  const p = (n: number): string => (n < 10 ? `0${n}` : `${n}`);
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}`;
}

/** 清洗文件名片段：路径分隔符 / 非法字符 / 空白 → `-`，去掉首尾 `-`；空 → `archive` */
function sanitizeFilePart(value: string): string {
  const text = value.trim().replace(/[/\\:*?"<>|\s]+/g, "-").replace(/^-+|-+$/g, "");
  return text.length > 0 ? text : "archive";
}

/** 归档文件名（不含目录）：`<工作流名>-<节点名>-<时间戳>-<uid16>.wf.json` */
export function archiveFileBase(workflowName: string, nodeName: string, nodeId: string, now: Date): string {
  return `${sanitizeFilePart(workflowName)}-${sanitizeFilePart(nodeName)}-${formatFileStamp(now)}-${shortIdOf(nodeId)}.wf.json`;
}

/** 归档文件的 vault 相对路径（Phase 39：人类可读 + 16 位短 uid） */
export function archiveFilePathFor(workflowName: string, nodeName: string, nodeId: string, now: Date): string {
  return `${archiveFolderOf()}/${archiveFileBase(workflowName, nodeName, nodeId, now)}`;
}

/** 找 nodeId 所属工作流的标题（`planArchive` 用；找不到 → undefined） */
function owningWorkflowTitle(document: WfJsonDocument, nodeId: string): string | undefined {
  const path = findNodePath(document, nodeId);
  if (path.length === 0) return undefined;
  const rootId = path[0].id;
  return (document.workflows ?? []).find((wf) => wf.root.id === rootId)?.title;
}

/** 纪要段里「归档地址」行的前缀（v0.7 §⑨-2：地址从 JSON 搬进正文） */
export const ARCHIVE_NOTE_PREFIX = "归档：";

/**
 * 浓缩节点纪要段里那一行归档地址（v0.7 §⑨-2 的**历史 helper**）。
 *
 * Phase 27 起引擎不再写这一行（纪要段范式已弃用），Phase 39 起 `archive.file` 也已删除；
 * 保留它只为旧调用方 / `mergeNoteSections` 的兼容测试。
 */
export function renderArchiveNoteLine(file: string, summary?: string): string {
  const text = summary?.trim() ?? "";
  const head = `${ARCHIVE_NOTE_PREFIX}[[${file}]]`;
  return text.length > 0 ? `${head} summary：${text}` : head;
}

/**
 * 从一段纪要内容里取归档地址（v0.7 §⑨-2）：第一处 `归档：[[...]]` 的链接目标。
 * 兼容 `[[目标|别名]]` / `[[目标#锚点]]`（都只取目标本身）；没写这一行 → undefined。
 */
export function extractArchiveReference(content: string): string | undefined {
  if (content.length === 0) return undefined;
  for (const line of content.split(/\r?\n/)) {
    const match = /^\s*归档[：:]\s*\[\[([^\]|#]+)(?:[|#][^\]]*)?\]\]/.exec(line);
    if (match !== null) {
      const target = match[1].trim();
      if (target.length > 0) return target;
    }
  }
  return undefined;
}

/** 子树里的全部后代（先序，不含自身） */
export function collectDescendants(node: WfNode): WfNode[] {
  const list: WfNode[] = [];
  for (const child of node.children ?? []) {
    list.push(child);
    list.push(...collectDescendants(child));
  }
  return list;
}

/** 节点的正文锚点（没写 `noteAnchor` 时按 `id` 推导 —— 与 `writeBackDocument` 的默认一致） */
function anchorOf(node: WfNode): string {
  return node.noteAnchor ?? anchorForNode(node.id);
}

/** 表单字段清洗：trim 后为空 → 省略该键（Schema 的 `TEXT` 是 minLength 1） */
function cleanField(raw: string | undefined): string | undefined {
  if (raw === undefined) return undefined;
  const text = raw.trim();
  return text.length > 0 ? text : undefined;
}

/** 清洗标签清单：trim、去空、去重；一条不剩 → undefined（删键） */
function cleanTags(tags: readonly string[] | undefined): string[] | undefined {
  if (tags === undefined || tags.length === 0) return undefined;
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of tags) {
    const text = raw.trim();
    if (text.length === 0 || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result.length > 0 ? result : undefined;
}

/**
 * 节点侧归档指针（`node.archive`）：只有归档文件里的 workflow id。
 *
 * 说明文字 / 归档时间 / 来源都在归档文件自己的 `workflow.archive` 上（`buildWorkflowArchive`）。
 */
export function buildNodeArchiveRef(workflowId: string): WfArchive {
  return { workflowId };
}

/**
 * 组装归档文件自己的元数据（`workflow.archive`）。
 *
 * 三段文字 / 标签只写有值的键（空串 = 省略该键；Schema 的 `TEXT` 是 minLength 1）。
 * `from_workflow` / `from_node` 是归档那一刻的快照（改名后不追）。
 */
export function buildWorkflowArchive(
  form: ArchiveFormInput,
  archivedAt: string,
  fromWorkflow: string,
  fromNode: string,
): WfWorkflowArchive {
  const archive: WfWorkflowArchive = { archivedAt, from_workflow: fromWorkflow, from_node: fromNode };
  const summary = cleanField(form.summary);
  const idea = cleanField(form.idea);
  const review = cleanField(form.review);
  const tag = cleanTags(form.tag);
  if (summary !== undefined) archive.summary = summary;
  if (idea !== undefined) archive.idea = idea;
  if (review !== undefined) archive.review = review;
  if (tag !== undefined) archive.tag = tag;
  return archive;
}

/** 结构克隆（节点都是纯数据：JSON 往返足够，且天然断开与原树的引用） */
function cloneBranch(node: WfNode): WfNode {
  return JSON.parse(JSON.stringify(node)) as WfNode;
}

/** 先给子树所有节点起好新 id（同时建「旧 id → 新 id」映射，供 `relations` 重定向用） */
function planBranchIds(node: WfNode, map: Map<string, string>): void {
  map.set(node.id, newNodeId());
  for (const child of node.children ?? []) planBranchIds(child, map);
}

/**
 * 重定向 `relations[].target`（改的是**副本**，原文档一动不动）：
 *  - 子树内部 → 换成新 id（关系图留在归档里）；
 *  - 子树外部（原文件里还在的邻居 / 工作流）→ 跨文件引用 `<原文件id>#<原id>`（契约写法，
 *    一致性检查对含 `#` 的目标不做文件内校验）；
 *  - 本来就带 `#` → 原样保留。
 */
function remapRelations(node: WfNode, idMap: ReadonlyMap<string, string>, sourceFileId: string): void {
  for (const relation of node.relations ?? []) {
    if (relation.target.includes("#")) continue;
    relation.target = idMap.get(relation.target) ?? `${sourceFileId}#${relation.target}`;
  }
}

/**
 * 复制子树进归档文件：**所有数据保留**，只换 `id` / `noteAnchor`（重新生成）+ 重定向 `relations`。
 * 归档文件 的根节点 = 原浓缩节点，它的 `archive` 字段留在原文档那份上（这里删掉）。
 */
function copyArchivedBranch(
  node: WfNode,
  idMap: ReadonlyMap<string, string>,
  sourceFileId: string,
  isRoot: boolean,
): WfNode {
  const copy = cloneBranch(node);
  const id = idMap.get(node.id) ?? newNodeId();
  copy.id = id;
  // Phase 27：纪要段 / noteAnchor 范式弃用 —— 归档副本不再带锚点
  delete copy.noteAnchor;
  if (isRoot) delete copy.archive;
  remapRelations(copy, idMap, sourceFileId);
  copy.children = (node.children ?? []).map((child) => copyArchivedBranch(child, idMap, sourceFileId, false));
  return copy;
}

/** 子树节点数（含自身） */
function countBranch(node: WfNode): number {
  let total = 1;
  for (const child of node.children ?? []) total += countBranch(child);
  return total;
}

/** `buildArchivedDocument` 的两个可选项（Phase 22：整条工作流归档时用） */
interface ArchivedDocumentOptions {
  /**
   * 省略归档文件 里 `workflow.originId`（Phase 22：整条工作流归档）。
   *
   * 节点级归档靠 `originId === 浓缩节点 id` 做双向引用与幂等认领；
   * 整条流归档没有「来源节点」，写它与契约（`workflow_archive` 才记来源流）冲突，
   * 而且会让幂等认领把「整条流归档」误判成「节点级归档」。
   */
  omitOriginId?: boolean;
  /** 归档文件 里 workflow 的标题（缺省 = 被浓缩节点的标题；整条流归档传原工作流标题） */
  title?: string;
  /** 归档文件自己的元数据（`workflow.archive`：时间 / 来源 / 三段文字 / 标签） */
  archive?: WfWorkflowArchive;
}

/**
 * 组装归档文件 的文档（workflow 新 id + originId 双向引用 + 标题带「（已归档）」；idMap 回传给正文复制用）
 */
function buildArchivedDocument(
  node: WfNode,
  workflowId: string,
  sourceFileId: string,
  now: Date,
  idMap: Map<string, string>,
  options: ArchivedDocumentOptions = {},
): WfJsonDocument {
  planBranchIds(node, idMap);
  const title = `${options.title ?? node.title}${ARCHIVE_TITLE_SUFFIX}`;
  const root = copyArchivedBranch(node, idMap, sourceFileId, true);
  const workflow: WfWorkflow =
    options.omitOriginId === true
      ? { id: workflowId, title, root }
      : { id: workflowId, title, originId: node.id, root };
  if (options.archive !== undefined) workflow.archive = options.archive;
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newFileId(),
    updatedAt: formatLocalIso(now),
    // Phase 28：归档快照的归档时间（归档看板的 21 天窗口默认以它结束）
    archivedAt: formatLocalIso(now),
    workflows: [workflow],
  };
}

/**
 * 算出归档计划（**只读**：不动传入的文档，也不落盘）。
 *
 * 产物只有文档对象（`plan.document`）：Phase 28 起由插件直接 `stringifyWfJson` 写成
 * `archive/<workflowId>-<nodeId>.wf.json`，因此天生通过 Schema 与幂等校验。
 *
 * Phase 36：这是**首次**归档的入口；已归档节点再归档走 `planArchiveAppend`（追加到旧归档文件）。
 * 这里仍按「新建一份归档文件」算 —— 插件只在「节点还没有 `archive`（或旧归档文件已丢失）」时用它。
 */
export function planArchive(
  document: WfJsonDocument,
  nodeId: string,
  form: ArchiveFormInput = {},
  now: Date = new Date(),
  /** @deprecated Phase 27：归档不再复制纪要段，参数保留只为兼容调用方 */
  _sourceMarkdown?: string,
): ArchivePlanResult {
  const check = checkArchiveEligibility(document, nodeId);
  if (!check.ok || check.node === undefined) {
    return { ok: false, reason: check.reason ?? `节点 ${nodeId} 不能归档` };
  }
  const node = check.node;

  const workflowId = newWorkflowId();
  const archivedAt = formatArchivedAt(now);
  const workflowTitle = owningWorkflowTitle(document, nodeId) ?? node.title;
  const file = archiveFilePathFor(workflowTitle, node.title, nodeId, now);
  const archive = buildNodeArchiveRef(workflowId);
  const workflowArchive = buildWorkflowArchive(form, archivedAt, workflowTitle, node.title);
  const idMap = new Map<string, string>();
  const archivedDocument = buildArchivedDocument(node, workflowId, document.id, now, idMap, {
    archive: workflowArchive,
  });

  const descendants = collectDescendants(node);
  return {
    ok: true,
    plan: {
      nodeId,
      nodeTitle: node.title,
      file,
      workflowId,
      archive,
      nodeCount: countBranch(node),
      removedNoteAnchors: descendants.map(anchorOf),
      document: archivedDocument,
    },
  };
}

/* ------------------------------------------------------------------ *
 * ③ 浓缩：把子树压成一个带 `archive` 的 done 节点（内存改动）
 * ------------------------------------------------------------------ */

export interface ArchiveNodeEditResult {
  ok: boolean;
  /** 拒绝原因（`ok = false` 时给出） */
  reason?: string;
  /** 改动的节点（= 浓缩节点自身；视图据此重建它那一列） */
  changedNodeIds: string[];
  /** 被删后代的正文纪要锚点（按先序；交给 `writeBackDocument` 删段落） */
  removedNoteAnchors: string[];
  /** 被浓缩掉的子树节点数（不含浓缩节点自身） */
  removedNodeCount: number;
}

/** `timeEntries` = 自己的 + 全部后代的（先序拼接）；一条都没有 → 省略该键 */
function mergeTimeEntries(node: WfNode, descendants: readonly WfNode[]): WfTimeEntry[] | undefined {
  const merged: WfTimeEntry[] = [...(node.timeEntries ?? [])];
  for (const descendant of descendants) merged.push(...(descendant.timeEntries ?? []));
  return merged.length > 0 ? merged : undefined;
}

/** `completedAt` = 自身 + 全部后代的**最晚**一个（无法解析的跳过；都没有 → 保持原值） */
function latestCompletedAt(node: WfNode, descendants: readonly WfNode[]): string | undefined {
  let latest = node.completedAt;
  let latestMs = latest !== undefined ? parseIso(latest) ?? Number.NEGATIVE_INFINITY : Number.NEGATIVE_INFINITY;
  for (const descendant of descendants) {
    const value = descendant.completedAt;
    if (value === undefined) continue;
    const ms = parseIso(value);
    if (ms === undefined || ms <= latestMs) continue;
    latestMs = ms;
    latest = value;
  }
  return latest;
}

/** 删掉浓缩节点上「归档后无意义」的字段（契约 §5「删除字段清单」） */
function pruneCondensedNode(node: WfNode): void {
  for (const field of PRUNED_FIELDS) delete node[field];
}

/**
 * 契约 §5.1：把 `nodeId` 及其后代浓缩成一个归档节点（**内存改动**，落盘由调用方负责）。
 *
 * 前置（不满足即拒绝，文档一动不动）：`planArchive` 已建好归档文件，这里只负责把原文件改对；
 * 资格判断会**再跑一次**（plan 与写回之间用户可能改了文件：加了子节点 / 改了状态 / 别人删了节点）。
 * 通过后：
 *   - 挂 `archive`（`archive.workflowId` 指向磁盘上那份归档文件；地址写进纪要段的「归档：」行）；
 *   - `children` 清空 + 删「归档后无意义」的字段；
 *   - `timeEntries` 累加全部后代、`completedAt` 取最晚、`updatedAt` 记成归档时间。
 *
 * 幂等：子树里有非 done / 根 / 叶子 → 拒绝，返回值里带原因，绝不半途改一半。
 * Phase 36：`archive` 已存在**不再**拒绝 —— 重复归档时由调用方传入沿用旧 `workflowId` 的新
 * `archive`（见 `planArchiveAppend`），这里只负责浓缩；浓缩后节点没有子树，所以再点一次仍是拒绝
 * （原因变成「已归档，没有新子树可追加」）。
 */
export function archiveNode(
  document: WfJsonDocument,
  nodeId: string,
  archive: WfArchive,
  now: Date = new Date(),
): ArchiveNodeEditResult {
  const check = checkArchiveEligibility(document, nodeId);
  if (!check.ok || check.node === undefined) {
    return {
      ok: false,
      reason: check.reason ?? `节点 ${nodeId} 不能归档`,
      changedNodeIds: [],
      removedNoteAnchors: [],
      removedNodeCount: 0,
    };
  }

  const node = check.node;
  const descendants = collectDescendants(node);
  const removedNoteAnchors = descendants.map(anchorOf);

  node.archive = archive;
  node.children = [];
  pruneCondensedNode(node);
  const timeEntries = mergeTimeEntries(node, descendants);
  if (timeEntries === undefined) delete node.timeEntries;
  else node.timeEntries = timeEntries;
  const completedAt = latestCompletedAt(node, descendants);
  if (completedAt === undefined) delete node.completedAt;
  else node.completedAt = completedAt;
  node.updatedAt = formatLocalIso(now);

  return { ok: true, changedNodeIds: [node.id], removedNoteAnchors, removedNodeCount: descendants.length };
}

/* ------------------------------------------------------------------ *
 * ④ 整条工作流归档（Phase 22：根节点 + 全部后代 → 一个归档文件 + 文件级台账）
 * ------------------------------------------------------------------ */

/**
 * 契约 §①「归档整个工作流」的资格判断：**整棵树全 done** 才通过。
 *
 * 与节点级 `archiveEligibility` 的差别（Phase 22 定稿口径）：
 *  - 根节点**可以**归档（它就是「整条流」的入口，不再是「泳道定位点不能动」）；
 *  - 叶子 / 单节点工作流也**可以**（整条流就这一个节点，照样能搬进归档文件）。
 *
 * Phase 36（重复归档）：根节点已带 `archive` 时不再直接拒绝 —— 只要又长出新的（全 done）
 * 子树，就能再归档一次（追加到旧归档文件 的根节点下）；只有「已归档且没有子树」才拒绝。
 */
export function workflowArchiveEligibility(workflow: WfWorkflow): ArchiveEligibility {
  const root = workflow.root;
  if ((root.children ?? []).length === 0 && root.archive !== undefined) {
    return { ok: false, reason: "已归档，没有新子树可追加" };
  }
  const unfinished = firstUnfinished(root);
  if (unfinished !== undefined) {
    return { ok: false, reason: `子树里「${unfinished.title}」还没做完` };
  }
  return { ok: true };
}

export interface WorkflowArchivePlan {
  /** 原工作流 id（写进 `workflow_archive[].workflowId`） */
  sourceWorkflowId: string;
  /** 原工作流标题（写进 `workflow_archive[].title`，也是归档文件 里 workflow 的标题） */
  workflowTitle: string;
  /** 浓缩根节点 id（归档文件 文件名 `archive/<新 workflowId>-<rootNodeId>.md` 用它） */
  rootNodeId: string;
  /** 根节点标题（浓缩后根节点标题不变） */
  rootTitle: string;
  /** 原根节点的纪要锚点（写进 `workflow_archive[].noteAnchor`；也是「归档：」行所在段落） */
  noteAnchor: string;
  /** 归档文件的 vault 相对路径（确定性：`archive/<新 workflowId>-<rootNodeId>.wf.json`） */
  file: string;
  /** 归档文件里的**新** workflow id（= 浓缩根节点的 `archive.workflowId`） */
  archiveWorkflowId: string;
  /** 要挂到根节点（以及 `workflow_archive[]` 条目）上的 `archive` 字段 */
  archive: WfArchive;
  /** 归档文件里的节点数（整棵树，含根） */
  nodeCount: number;
  /** 要从原文件正文删掉的纪要锚点（除根节点外的全部节点，按先序） */
  removedNoteAnchors: string[];
  /** 归档文件 对应的文档对象（新 workflow：**不带 `originId`**） */
  document: WfJsonDocument;
}

export interface WorkflowArchivePlanResult {
  ok: boolean;
  reason?: string;
  plan?: WorkflowArchivePlan;
}

/**
 * 算出「整条工作流归档」的计划（**只读**：不动传入的文档，也不落盘）。
 *
 * 与 `planArchive` 共用同一套机制（`buildArchivedDocument` / `writeBackDocument`），只有两点不同：
 * 归档文件 的 workflow **不带 `originId`**、标题取**原工作流标题**（节点级归档取浓缩节点标题）。
 * 因此产物天生通过 Schema 与幂等校验。
 */
export function planWorkflowArchive(
  document: WfJsonDocument,
  workflowId: string,
  form: ArchiveFormInput = {},
  now: Date = new Date(),
  /** @deprecated Phase 27：归档文件 不再复制纪要段，参数保留只为兼容调用方 */
  _sourceMarkdown?: string,
): WorkflowArchivePlanResult {
  const workflow = (document.workflows ?? []).find((item) => item.id === workflowId);
  if (workflow === undefined) {
    return { ok: false, reason: `工作流 ${workflowId} 不存在（可能已被删除）` };
  }
  const verdict = workflowArchiveEligibility(workflow);
  if (!verdict.ok) return { ok: false, reason: verdict.reason ?? `工作流 ${workflowId} 不能归档` };

  const root = workflow.root;
  const archiveWorkflowId = newWorkflowId();
  const archivedAt = formatArchivedAt(now);
  const file = archiveFilePathFor(workflow.title, root.title, root.id, now);
  const archive = buildNodeArchiveRef(archiveWorkflowId);
  const workflowArchive = buildWorkflowArchive(form, archivedAt, workflow.title, root.title);
  const idMap = new Map<string, string>();
  const archivedDocument = buildArchivedDocument(root, archiveWorkflowId, document.id, now, idMap, {
    omitOriginId: true,
    title: workflow.title,
    archive: workflowArchive,
  });

  return {
    ok: true,
    plan: {
      sourceWorkflowId: workflow.id,
      workflowTitle: workflow.title,
      rootNodeId: root.id,
      rootTitle: root.title,
      noteAnchor: anchorOf(root),
      file,
      archiveWorkflowId,
      archive,
      nodeCount: countBranch(root),
      removedNoteAnchors: collectDescendants(root).map(anchorOf),
      document: archivedDocument,
    },
  };
}

export interface ArchiveWorkflowEditResult {
  ok: boolean;
  /** 拒绝原因（`ok = false` 时给出） */
  reason?: string;
  /** 改动的节点（= 浓缩后的根节点） */
  changedNodeIds: string[];
  /** 被删后代的正文纪要锚点（按先序；不含根节点） */
  removedNoteAnchors: string[];
  /** 被浓缩掉的子树节点数（不含根节点） */
  removedNodeCount: number;
  /** 写进 `document.workflow_archive` 的台账条目（`ok = false` 时缺省） */
  entry?: WfWorkflowArchiveEntry;
}

/** 拒绝结果的统一形状（`archiveWorkflow` 用；字段全是空数组） */
function workflowArchiveRejected(reason: string): ArchiveWorkflowEditResult {
  return { ok: false, reason, changedNodeIds: [], removedNoteAnchors: [], removedNodeCount: 0 };
}

/**
 * 契约 §①：把整条工作流浓缩成「根节点 + `archive` + 文件级台账」（**内存改动**，落盘由调用方负责）。
 *
 * 前置（不满足即拒绝，文档一动不动）：`planWorkflowArchive` 已建好归档文件；
 * 资格**再跑一次**（plan 与写回之间用户可能改了文件：加了子节点 / 改了状态 / 别人删了节点）。
 * 通过后：
 *  - 根节点挂 `archive`、`children` 清空、删「归档后无意义」的字段（与节点级浓缩同一套 `pruneCondensedNode`）；
 *  - `timeEntries` 累加全部后代、`completedAt` 取最晚、`updatedAt` 记成归档时间；
 *  - `document.workflow_archive` 追加一条台账（同 `workflowId` 的旧条目先摘掉 —— 手工清掉 `archive`
 *    再归档一次时不留重复）。
 *
 * 台账里的 `noteAnchor` / `workflowId` / `title` 都在**浓缩之前**取值（浓缩不改它们，只是读起来更直白）。
 */
export function archiveWorkflow(
  document: WfJsonDocument,
  workflowId: string,
  archive: WfArchive,
  now: Date = new Date(),
): ArchiveWorkflowEditResult {
  const workflow = (document.workflows ?? []).find((item) => item.id === workflowId);
  if (workflow === undefined) return workflowArchiveRejected(`工作流 ${workflowId} 不存在（可能已被删除）`);
  const verdict = workflowArchiveEligibility(workflow);
  if (!verdict.ok) return workflowArchiveRejected(verdict.reason ?? `工作流 ${workflowId} 不能归档`);

  const root = workflow.root;
  const descendants = collectDescendants(root);
  const removedNoteAnchors = descendants.map(anchorOf);
  const entry: WfWorkflowArchiveEntry = {
    workflowId: workflow.id,
    title: workflow.title,
    noteAnchor: anchorOf(root),
    archive,
  };

  root.archive = archive;
  root.children = [];
  pruneCondensedNode(root);
  const timeEntries = mergeTimeEntries(root, descendants);
  if (timeEntries === undefined) delete root.timeEntries;
  else root.timeEntries = timeEntries;
  const completedAt = latestCompletedAt(root, descendants);
  if (completedAt === undefined) delete root.completedAt;
  else root.completedAt = completedAt;
  root.updatedAt = formatLocalIso(now);

  const ledger = (document.workflow_archive ?? []).filter((item) => item.workflowId !== workflow.id);
  ledger.push(entry);
  document.workflow_archive = ledger;

  return {
    ok: true,
    changedNodeIds: [root.id],
    removedNoteAnchors,
    removedNodeCount: descendants.length,
    entry,
  };
}

/* ------------------------------------------------------------------ *
 * ④-b 重复归档（Phase 36）：把新子树追加到已有归档文件 的根节点下
 * ------------------------------------------------------------------ */

/**
 * 重复归档的计划（**只读**：不动传入的文档，也不落盘）。
 *
 * 与 `planArchive` 的区别（Phase 36 定稿口径）：
 *  - **不新建**归档文件 / 不新建 workflow：目标根 = `archivedDocument.workflows[0].root`，
 *    `archive.workflowId` 沿用旧的（一个节点永远只有一份归档文件，越归档越长）；
 *  - 只对 `node.children`（本次新完成的子树）重映射 id / 重定向 `relations`，产物作为
 *    **新子节点追加**到目标根末尾（旧的归档内容一个字节都不动）；
 *  - `archive` 字段以旧值为底：`archivedAt` 更新为本次、`schemaVersion` 取当前；
 *    `summary` / `idea` / `review` 只有本次表单填了才覆盖（空着 = 保留旧值）。
 *
 * 前置（不满足即拒绝，不动任何东西）：`node.archive !== undefined`（必须有旧归档）+
 * `node.children` 非空（有新子树可追加）。「全 done」等资格由调用方先用
 * `archiveEligibility` 判过（视图置灰 / 插件写回前各判一次）。
 */
export interface ArchiveAppendPlan {
  /** 归档文件 的目标根节点 id（= `archivedDocument.workflows[0].root.id`） */
  rootId: string;
  /** 要追加到目标根 `children` 末尾的节点（id 已重映射、`relations` 已重定向） */
  appendedChildren: WfNode[];
  /** 追加的节点数（含全部后代，不含目标根） */
  appendedNodeCount: number;
  /** 本次要挂回原节点的新 `archive` 字段（`workflowId` 沿用旧归档） */
  archive: WfArchive;
  /** 归档文件自己的新元数据（`archivedAt` 刷新为本次；`from_*` 不变；表单填了才覆盖说明） */
  archiveMeta: WfWorkflowArchive;
  /** 要从原文件正文删掉的纪要锚点（被追加的后代，按先序） */
  removedNoteAnchors: string[];
}

export interface ArchiveAppendPlanResult {
  ok: boolean;
  reason?: string;
  plan?: ArchiveAppendPlan;
}

export function planArchiveAppend(
  archivedDocument: WfJsonDocument,
  sourceFileId: string,
  node: WfNode,
  form: ArchiveFormInput = {},
  now: Date = new Date(),
): ArchiveAppendPlanResult {
  const archivedWorkflow = archivedDocument.workflows?.[0];
  if (archivedWorkflow === undefined) {
    return { ok: false, reason: "归档文件里没有工作流（可能已损坏）" };
  }
  if (node.archive === undefined) {
    return { ok: false, reason: "该节点还没有归档，不能追加" };
  }
  const children = node.children ?? [];
  if (children.length === 0) return { ok: false, reason: "叶子节点没有子树" };

  // 只给本次子树起新 id（旧归档里的 id 一个都不碰）
  const idMap = new Map<string, string>();
  for (const child of children) planBranchIds(child, idMap);
  const appendedChildren = children.map((child) =>
    copyArchivedBranch(child, idMap, sourceFileId, false),
  );

  // archive：节点侧沿用旧 workflowId；归档文件自己的元数据只刷新「归档时间」，
  // 来源（from_*）与未重填的说明保持首次归档时的值
  const archive = buildNodeArchiveRef(archivedWorkflow.id ?? node.archive.workflowId);
  const archiveMeta: WfWorkflowArchive = {
    ...(archivedWorkflow.archive ?? {
      archivedAt: formatArchivedAt(now),
      from_workflow: archivedWorkflow.title,
      from_node: archivedWorkflow.root.title,
    }),
    archivedAt: formatArchivedAt(now),
  };
  const summary = cleanField(form.summary);
  const idea = cleanField(form.idea);
  const review = cleanField(form.review);
  if (summary !== undefined) archiveMeta.summary = summary;
  if (idea !== undefined) archiveMeta.idea = idea;
  if (review !== undefined) archiveMeta.review = review;
  const tag = cleanTags(form.tag);
  if (tag !== undefined) archiveMeta.tag = tag;

  const descendants = collectDescendants(node);
  return {
    ok: true,
    plan: {
      rootId: archivedWorkflow.root.id,
      appendedChildren,
      appendedNodeCount: descendants.length,
      archive,
      archiveMeta,
      removedNoteAnchors: descendants.map(anchorOf),
    },
  };
}

/* ------------------------------------------------------------------ *
 * ⑤ 幂等重试：认回上次建的那份归档文件
 * ------------------------------------------------------------------ */

/** 归档文件 的身份（幂等重试时用来核对「这个文件是不是这个节点上次建的」） */
export interface ArchivedWorkflowIdentity {
  /** 归档文件 里第一个 workflow 的 id（= 上次 plan 生成的 `archive.workflowId`） */
  workflowId?: string;
  /**
   * 归档文件 里第一个 workflow 的 `originId`（= 上次那个浓缩节点的 id）。
   *
   * **缺省 = 整条工作流归档**（Phase 22 的 `planWorkflowArchive` 不写 `originId`）——
   * 插件层正是靠这一点区分「节点级归档」与「整条流归档」，认领重试文件时不会互相误判。
   */
  originId?: string;
  /** 归档文件 里的节点数（读回来做提示 / 核对用） */
  nodeCount?: number;
}

/**
 * 从归档文件的内容里读回 `workflow.id` / `workflow.originId`（只读；解析不出来就返回 `{}`）。
 *
 * 重试时 `planArchive` 只能给出**新的**（随机）`workflowId`，所以必须从磁盘上那份文件读回真实身份，
 * 否则 `archive.workflowId` 与纪要段「归档：」行会互相错配（文件在 A 路径、行里写着 B 的 id）。
 *
 * Phase 28：归档只产 `<同名>.wf.json`（纯 JSON），调用方传 `readArchivedWorkflowIdentity("", jsonText)`；
 * `markdown` 参数保留给老的内联归档（正文里带 wfjson 代码块）兜底。
 */
export function readArchivedWorkflowIdentity(
  markdown: string,
  jsonText?: string,
): ArchivedWorkflowIdentity {
  const analysis =
    jsonText === undefined
      ? analyzeMarkdown(markdown)
      : analyzeDocument({ noteMarkdown: markdown, jsonText, jsonSource: "sidecar" });
  const document = analysis.document ?? analysis.latestDocument;
  const workflow = document?.workflows?.[0];
  if (workflow === undefined) return {};
  const identity: ArchivedWorkflowIdentity = {
    workflowId: workflow.id,
    nodeCount: countBranch(workflow.root),
  };
  if (workflow.originId !== undefined) identity.originId = workflow.originId;
  return identity;
}

/** 「已归档」弹窗一行要显示的东西（从归档文件现读；读不出来 → undefined） */
export interface ArchiveFileMeta {
  /** 归档文件的 vault 相对路径 */
  path: string;
  /** 归档文件里第一个 workflow 的 id（= 原文档节点 `archive.workflowId`） */
  workflowId: string;
  /** 归档文件里第一个 workflow 的标题 */
  title: string;
  /** 归档时间（`workflow.archive.archivedAt`；旧文件回落文件级 `archivedAt`） */
  archivedAt?: string;
  /** 来源工作流标题（归档文件自己的 `workflow.archive.from_workflow`） */
  fromWorkflow?: string;
  /** 来源节点标题（归档文件自己的 `workflow.archive.from_node`） */
  fromNode?: string;
  summary?: string;
  idea?: string;
  review?: string;
  tag?: string[];
  /** 归档文件里的节点数（含根） */
  nodeCount?: number;
}

/**
 * 读归档文件的元数据（纯函数）。
 *
 * 「已归档」弹窗打开时才调用它（懒加载：看板本身渲染不读 `archive/` 下的 json），
 * 一次读回：workflow id / 标题 / 归档时间 / 来源 / 三段文字 / 标签 / 节点数。
 * 认不出（不是 wfjson / 没有 workflow）→ undefined。
 */
export function readArchiveFileMeta(path: string, jsonText: string): ArchiveFileMeta | undefined {
  const analysis = analyzeDocument({ noteMarkdown: "", jsonText, jsonSource: "sidecar" });
  const document = analysis.document ?? analysis.latestDocument;
  const workflow = document?.workflows?.[0];
  if (workflow === undefined) return undefined;
  const meta: ArchiveFileMeta = {
    path,
    workflowId: workflow.id,
    title: workflow.title,
    nodeCount: countBranch(workflow.root),
  };
  const archive = workflow.archive;
  if (archive !== undefined) {
    meta.archivedAt = archive.archivedAt;
    meta.fromWorkflow = archive.from_workflow;
    meta.fromNode = archive.from_node;
    if (archive.summary !== undefined) meta.summary = archive.summary;
    if (archive.idea !== undefined) meta.idea = archive.idea;
    if (archive.review !== undefined) meta.review = archive.review;
    if (archive.tag !== undefined) meta.tag = [...archive.tag];
  } else if (typeof document?.archivedAt === "string") {
    // 旧文件没有 workflow.archive：仍然给出快照时间，来源留空（视图回落文件名）
    meta.archivedAt = document.archivedAt;
  }
  return meta;
}

/**
 * 候选归档文件是否可能是某节点的归档产物（路径判据，不需要读文件）：
 * `archive/<workflowId>-<nodeId>.wf.json` 或 `archive/<nodeId>.wf.json`。
 * 命中后还要用 `readArchivedWorkflowIdentity` 核对 `originId`（同名不等于同一个节点）。
 */
export function isArchivePathForNode(path: string, nodeId: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  const uid = shortIdOf(nodeId);
  return name.endsWith(`-${uid}.wf.json`);
}

/* ------------------------------------------------------------------ *
 * ⑥ 编辑归档信息（Phase 38）：只改浓缩节点 `archive` 的三段文字
 * ------------------------------------------------------------------ */

/** 编辑归档文件元数据的返回（`ok = false` 时文档一动不动） */
export interface WorkflowArchiveInfoEditResult {
  ok: boolean;
  reason?: string;
  /** 三段文字 / 标签有没有任何一处变了（false = 与现状一致，调用方可不写盘） */
  changed?: boolean;
  /** 被编辑的归档 workflow id（归档文件里的 `workflow.id`） */
  workflowId: string;
}

/** 标签清单相等性（顺序 + 内容；都为空也算相等） */
function sameTags(a: readonly string[] | undefined, b: readonly string[] | undefined): boolean {
  const x = a ?? [];
  const y = b ?? [];
  if (x.length !== y.length) return false;
  return x.every((value, index) => value === y[index]);
}

/** `applyArchiveNotes` 能写的字段（节点 `archive` 与归档文件的 `workflow.archive` 共用） */
interface ArchiveNoteCarrier {
  summary?: string;
  idea?: string;
  review?: string;
  tag?: string[];
}

/** 把三段文字 + 标签写进归档标记；`undefined` = 删键（Schema 的 `TEXT` 是 minLength 1，不写空串） */
function applyArchiveNotes(
  archive: ArchiveNoteCarrier,
  summary?: string,
  idea?: string,
  review?: string,
  tag?: string[],
): void {
  if (summary === undefined) delete archive.summary;
  else archive.summary = summary;
  if (idea === undefined) delete archive.idea;
  else archive.idea = idea;
  if (review === undefined) delete archive.review;
  else archive.review = review;
  if (tag === undefined) delete archive.tag;
  else archive.tag = tag;
}

/**
 * 编辑归档文件自己的元数据（`workflow.archive` 的三段文字 + 标签）。
 *
 * 只动 `summary` / `idea` / `review` / `tag`，**不碰** `archivedAt` / `from_workflow` / `from_node`
 * （归档时间与来源是归档那一刻的事实，改说明不改它们）。
 *
 * 旧文件没有 `workflow.archive` 时按 `workflow.title` / `root.title` / 本次时间补一个
 * （用户仍能在「已归档」弹窗里直接编辑那条记录）。
 *
 * 前置（不满足即拒绝，文档一动不动）：`workflowId` 在文档里存在。
 */
export function editWorkflowArchiveInfo(
  document: WfJsonDocument,
  workflowId: string,
  form: ArchiveFormInput = {},
  now: Date = new Date(),
): WorkflowArchiveInfoEditResult {
  const workflow = (document.workflows ?? []).find((item) => item.id === workflowId);
  if (workflow === undefined) {
    return { ok: false, reason: `工作流 ${workflowId} 不存在（可能已被删除）`, workflowId };
  }
  const existing = workflow.archive;
  const archive: WfWorkflowArchive = existing ?? {
    archivedAt: formatArchivedAt(now),
    from_workflow: workflow.title,
    from_node: workflow.root.title,
  };

  const summary = cleanField(form.summary);
  const idea = cleanField(form.idea);
  const review = cleanField(form.review);
  const tag = cleanTags(form.tag);

  const changed =
    existing === undefined ||
    (summary ?? undefined) !== (archive.summary ?? undefined) ||
    (idea ?? undefined) !== (archive.idea ?? undefined) ||
    (review ?? undefined) !== (archive.review ?? undefined) ||
    !sameTags(tag, archive.tag);

  applyArchiveNotes(archive, summary, idea, review, tag);
  if (existing === undefined) workflow.archive = archive;
  if (!changed) return { ok: true, changed: false, workflowId };
  document.updatedAt = formatLocalIso(now);
  return { ok: true, changed: true, workflowId };
}

/* ------------------------------------------------------------------ *
 * ⑥-b 修改工作流弹窗：任意工作流写四条复盘说明（Phase 45）
 * ------------------------------------------------------------------ */

/**
 * 把表单里的 summary / idea / review / tag 写进 `workflow.archive`，返回**是否真的改了**。
 *
 * 与 `editWorkflowArchiveInfo` 的区别：**不合成** `archivedAt` / `from_workflow` / `from_node`
 * —— 普通工作流没有「归档」这件事，这四个键只是复盘说明。归档文件（本身带三个事实键）用这张表
 * 改说明时，那三个键原样保留。
 *
 * 四条说明全空：
 *  - 本来就没有 `archive` → 什么都不做（返回 false）；
 *  - 只有说明、没有事实键 → 整个 `workflow.archive` 删掉（不留空对象）；
 *  - 还留着事实键 → 只删说明，`workflow.archive` 保留（仍是「真归档」）。
 *
 * 空串按「没填」处理（Schema 的 `TEXT` 是 minLength 1，不写空串）。
 */
export function applyWorkflowArchiveNotes(workflow: WfWorkflow, form: ArchiveFormInput): boolean {
  const summary = cleanField(form.summary);
  const idea = cleanField(form.idea);
  const review = cleanField(form.review);
  const tag = cleanTags(form.tag);
  const before = workflow.archive === undefined ? "" : JSON.stringify(workflow.archive);

  if (summary === undefined && idea === undefined && review === undefined && tag === undefined) {
    if (workflow.archive === undefined) return false;
  }

  const archive: WfWorkflowArchive = { ...(workflow.archive ?? {}) };
  applyArchiveNotes(archive, summary, idea, review, tag);

  const hasNotes =
    archive.summary !== undefined ||
    archive.idea !== undefined ||
    archive.review !== undefined ||
    archive.tag !== undefined;
  const hasFacts =
    archive.archivedAt !== undefined ||
    archive.from_workflow !== undefined ||
    archive.from_node !== undefined;
  if (!hasNotes && !hasFacts) delete workflow.archive;
  else workflow.archive = archive;

  const after = workflow.archive === undefined ? "" : JSON.stringify(workflow.archive);
  return before !== after;
}

/** `setWorkflowArchiveNotes` 的返回（`ok = false` 时文档一动不动） */
export interface WorkflowArchiveNotesResult {
  ok: boolean;
  reason?: string;
  /** 四条说明有没有任何一处变了（false = 与现状一致，调用方可不写盘） */
  changed?: boolean;
  workflowId: string;
}

/**
 * 按 id 给**任意工作流**写四条复盘说明（`workflow.archive` 的 summary / idea / review / tag）。
 *
 * 语义与 `applyWorkflowArchiveNotes` 完全一致；这里只多做「查工作流 → 刷 `document.updatedAt`」。
 * 「修改工作流」弹窗保存时，说明随 `WorkflowPatch.archive` 走同一次写回，不单独调它；
 * 本函数留给需要直接改一条工作流说明的调用方（测试 / 将来的快捷入口）。
 */
export function setWorkflowArchiveNotes(
  document: WfJsonDocument,
  workflowId: string,
  form: ArchiveFormInput = {},
  now: Date = new Date(),
): WorkflowArchiveNotesResult {
  const workflow = (document.workflows ?? []).find((item) => item.id === workflowId);
  if (workflow === undefined) {
    return { ok: false, reason: `工作流 ${workflowId} 不存在（可能已被删除）`, workflowId };
  }
  if (!applyWorkflowArchiveNotes(workflow, form)) return { ok: true, changed: false, workflowId };
  document.updatedAt = formatLocalIso(now);
  return { ok: true, changed: true, workflowId };
}

/* ------------------------------------------------------------------ *
 * ⑦ 归档标签枚举（archive_tag.yaml，看板根目录；Phase 39）
 * ------------------------------------------------------------------ */

/** 归档标签枚举文件名（放在看板根目录，与 archive/ 平级） */
export const ARCHIVE_TAG_FILE = "archive_tag.yaml";

/** 解析 archive_tag.yaml 文本 → 标签清单（去重、去空、保序） */
export function parseArchiveTagYaml(text: string): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith("#")) continue;
    const item = /^-\s*(.+)$/.exec(line);
    if (item === null) continue;
    const value = item[1].trim().replace(/^["']|["']$/g, "").trim();
    if (value.length === 0 || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

/** 序列化标签清单 → archive_tag.yaml 文本（去重 + 排序，稳定可读） */
export function stringifyArchiveTagYaml(tags: readonly string[]): string {
  const list = [...new Set(tags.map((tag) => tag.trim()).filter((tag) => tag.length > 0))].sort();
  if (list.length === 0) return "tags: []\n";
  return `tags:\n${list.map((tag) => `  - ${tag}`).join("\n")}\n`;
}