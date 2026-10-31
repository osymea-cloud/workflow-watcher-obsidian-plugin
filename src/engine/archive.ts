/**
 * 归档（Phase 4）：子树浓缩 + 归档 md 生成（纯 TypeScript、零 Obsidian 依赖）。
 *
 * 定稿契约：`doc/datacontact/data_ixd_discuss_interact_v0.3.md`《归档功能定稿契约（Phase 4）》、
 * `doc/datacontact/data_ixd_v01.md` §2.10（`archive` 字段）/ §5（写回顺序）。
 *
 * 本文件只算「文档该长什么样」：内存改动（`archiveNode`）+ 归档 md 的文本（`planArchive`）；
 * 落盘（`vault.create` / `vault.process`）与 Modal 在 main.ts，视图（views/wfView.ts）只管交互。
 *
 * 两步（**先建归档 md → 成功后改原文件**；中途失败可幂等重试）：
 *   1. `planArchive()`：只读地算出归档计划 —— 归档 md 的完整文本（frontmatter + wfjson 代码块 +
 *      每个节点的纪要段落：Phase 9 起会把源文件子树各段的文字 + 超链接复制进去，锚点 / id 已重映射）、
 *      确定性路径 `archive/<workflowId>-<nodeId>.md`、要挂到浓缩节点上的 `archive` 字段、
 *      要从原文件正文删掉的纪要锚点；
 *   2. `archiveNode()`：把原文件的内存文档改对 —— 浓缩节点只保留
 *      `id / title / status=done / importance / tags / 时间信息（timeEntries 累加 + completedAt 取最晚）/
 *      自己的 noteAnchor / archive`，`children` 清空，子树整体消失；被删后代的正文段落通过
 *      `removedNoteAnchors` 上报给 `writeBackDocument` 删掉。
 *
 * 边界（任一不满足即拒绝，文档一动不动；理由文案同时用于右键菜单置灰与写回提示）：
 *   - 根节点不能归档（它是泳道入口，也是「正在进行」块的定位点）；
 *   - 叶子节点没有子树，没什么可浓缩；
 *   - 浓缩节点及其**全部后代**必须 `done`（"为此及之后归档" = 这个位置往后都做完了）；
 *   - 已经带 `archive` 的节点不再归档（先清掉它的 `archive` 再来：否则会留下「旧归档 md +
 *     新浓缩结果」的错配，见 `planArchive` 的注释）。
 *
 * 归档 md（`archive/<workflowId>-<nodeId>.md`）：
 *   - 内容 = 原子树（浓缩节点当根）+ 全部后代，**所有数据保留**（status / 时间 / 链接 / 关系 /
 *     纪要摘要都在），只有正文段落是空壳（`### 标题 ^新id` + 占位文本，等用户补写）；
 *   - 节点 `id` / `noteAnchor` **全部重新生成**（契约：不做节点追溯）：`noteAnchor` = `^新id`，
 *     由 `writeBackDocument` 自动补出 `### 标题 ^新id` 段落；
 *   - `relations[].target` 跟着重定向（否则归档 md 里全是「目标找不到」）：指向子树内部 → 换成新 id；
 *     指向子树外部（留在原文件里的邻居 / 工作流）→ 写成跨文件引用 `<原文件id>#<原id>`（契约的跨文件写法）；
 *   - `workflow`：新 id（= 浓缩节点的 `archive.workflowId`）、`title` = `<原节点标题>（已归档）`、
 *     `originId` = 原文档浓缩节点 `id`；**不带 `state`**（缺省即进行中，归档 md 自己还能被再归档 / 取消）；
 *   - `document.id` 也新生成（文件级稳定 id，不与原文件冲突）。
 *
 * 幂等重试（路径确定性 + `createIfAbsent`）：`workflowId` 每次 plan 都是新 uuid，重试时**推不出来**，
 * 所以插件层按 `-<nodeId>.md` 扫 `archive/`（`isArchivePathForNode`）→ 读回候选文件身份
 * （`readArchivedWorkflowIdentity`）→ 只有 `originId === nodeId` 才认这一份（顺序：先扫 → 命中复用；
 * 没有命中才 `create`）。这样 `archive.file` / `archive.workflowId` 永远与磁盘上那份一致，
 * 重试也不会覆盖用户已经补写过纪要的归档 md。
 */

import { analyzeMarkdown } from "./analyze.ts";
import { anchorForNode, newFileId, newNodeId, newWorkflowId } from "./ids.ts";
import { collectNoteSectionContents, replaceNoteSectionContent } from "./noteSection.ts";
import { formatLocalDate, formatLocalIso, parseIso } from "./time.ts";
import { findNode, findParentNode } from "./tree.ts";
import {
  SCHEMA_VERSION,
  type WfArchive,
  type WfJsonDocument,
  type WfNode,
  type WfTimeEntry,
  type WfWorkflow,
} from "./types.ts";
import { writeBackDocument } from "./wfjsonWrite.ts";

/* ------------------------------------------------------------------ *
 * 常量
 * ------------------------------------------------------------------ */

/** 归档 md 所在目录（vault 相对路径；不存在时由插件层新建） */
export const ARCHIVE_FOLDER = "archive";

/** 归档 md 里 workflow 标题的后缀（人一眼看出这是归档文件里的流） */
export const ARCHIVE_TITLE_SUFFIX = "（已归档）";

/**
 * 浓缩节点要**删掉**的字段（契约 §5「删除字段清单」）。
 * 其余字段（`id` / `title` / `status` / `importance` / `startAt` / `updatedAt` /
 * `completedAt` / `noteAnchor` / `timeEntries` / `archive`）保留。
 * v1.6 起 `progress` / `progress_max` 都删；`links_relative_path` 也删。
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
 * 根节点 / 叶子 / 已归档 / 子树里有非 done → 拒绝。
 *
 * 视图拿到的就是文档里的节点对象，所以这里不需要文档；`isRoot` 由调用方给
 * （视图的 `renderSubtree` 知道，写回侧用 `findParentNode` 算）。
 */
export function archiveEligibility(node: WfNode, isRoot: boolean): ArchiveEligibility {
  if (isRoot) return { ok: false, reason: "根节点不能归档" };
  if (node.archive !== undefined) return { ok: false, reason: "该节点已归档" };
  const children = node.children ?? [];
  if (children.length === 0) return { ok: false, reason: "叶子节点没有子树" };
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
}

export interface ArchivePlan {
  /** 原文档里的浓缩节点 id（`archive.file` / 「已归档」块都用它定位） */
  nodeId: string;
  nodeTitle: string;
  /** 归档 md 的 vault 相对路径（确定性：`archive/<workflowId>-<nodeId>.md`） */
  file: string;
  /** 归档 md 里的 workflow id（要写进浓缩节点的 `archive.workflowId`） */
  workflowId: string;
  /** 归档 md 的完整文本（frontmatter + wfjson 代码块 + 每个节点的空壳纪要段落） */
  markdown: string;
  /** 要挂到原文档浓缩节点上的 `archive` 字段 */
  archive: WfArchive;
  /** 归档 md 里的节点数（浓缩节点 + 全部后代） */
  nodeCount: number;
  /** 要从原文件正文删掉的纪要锚点（被删后代，按先序；不含浓缩节点自己） */
  removedNoteAnchors: string[];
  /**
   * 归档 md 对应的**文档对象**（新 workflow：id / originId / 重映射后的 id 都在里面）。
   *
   * 与 `markdown` 是同一份数据的两种形态：`markdown` = frontmatter + 代码块 + 空壳纪要段。
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

/** 归档 md 的确定性路径（`archive/<workflowId>-<nodeId>.md`） */
export function archiveFilePath(workflowId: string, nodeId: string): string {
  return `${ARCHIVE_FOLDER}/${workflowId}-${nodeId}.md`;
}

/** 纪要段里「归档地址」行的前缀（v0.7 §⑨-2：地址从 JSON 搬进正文） */
export const ARCHIVE_NOTE_PREFIX = "归档：";

/**
 * 浓缩节点纪要段里那一行归档地址（v0.7 §⑨-2）：
 * `归档：[[archive/<workflowId>-<nodeId>.md]] summary：<概括>`
 * （`summary` 为空时只写前半段）。
 *
 * 为什么放正文：`archive.file` 弃用后 JSON 不再持有归档地址，
 * 人打开笔记就能看到「浓缩到哪去了」，也便于手工移动归档文件后改一行即可。
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

/**
 * 组装 `archive` 字段（只写有值的可选键；三个必填键一定有）。
 * v0.7 §⑨-2：**不再写 `file`** —— 归档地址改为浓缩节点纪要段的「归档：」行。
 */
function buildArchiveField(
  form: ArchiveFormInput,
  archivedAt: string,
  workflowId: string,
): WfArchive {
  const archive: WfArchive = { archivedAt, workflowId, schemaVersion: SCHEMA_VERSION };
  const summary = cleanField(form.summary);
  const idea = cleanField(form.idea);
  const review = cleanField(form.review);
  if (summary !== undefined) archive.summary = summary;
  if (idea !== undefined) archive.idea = idea;
  if (review !== undefined) archive.review = review;
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
 * 复制子树进归档 md：**所有数据保留**，只换 `id` / `noteAnchor`（重新生成）+ 重定向 `relations`。
 * 归档 md 的根节点 = 原浓缩节点，它的 `archive` 字段留在原文档那份上（这里删掉）。
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
  copy.noteAnchor = anchorForNode(id);
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

/** 组装归档 md 的文档（workflow 新 id + originId 双向引用 + 标题带「（已归档）」；idMap 回传给正文复制用） */
function buildArchivedDocument(
  node: WfNode,
  workflowId: string,
  sourceFileId: string,
  now: Date,
  idMap: Map<string, string>,
): WfJsonDocument {
  planBranchIds(node, idMap);
  const workflow: WfWorkflow = {
    id: workflowId,
    title: `${node.title}${ARCHIVE_TITLE_SUFFIX}`,
    originId: node.id,
    root: copyArchivedBranch(node, idMap, sourceFileId, true),
  };
  return {
    schemaVersion: SCHEMA_VERSION,
    id: newFileId(),
    updatedAt: formatLocalIso(now),
    workflows: [workflow],
  };
}

/**
 * Phase 9：把源文件子树每个节点的**正文纪要内容**复制进归档 md（id / 锚点已重映射）。
 *
 * 源段落优先成对标志段，旧文件按「标题 + 锚点」边界兜底（`collectNoteSectionContents`）。
 * 只替换归档 md 里对应新 id 的空壳段；源内容为空 / 占位符时保留占位符。
 */
function copyNoteSections(
  archiveMarkdown: string,
  sourceMarkdown: string,
  sourceDocument: WfJsonDocument,
  subtreeRoot: WfNode,
  idMap: ReadonlyMap<string, string>,
): string {
  const contents = collectNoteSectionContents(sourceMarkdown, sourceDocument);
  if (contents.size === 0) return archiveMarkdown;

  let current = archiveMarkdown;
  const walk = (node: WfNode): void => {
    const content = contents.get(node.id);
    const targetId = idMap.get(node.id);
    if (content !== undefined && targetId !== undefined) {
      const replaced = replaceNoteSectionContent(current, targetId, content);
      if (replaced.found) current = replaced.markdown;
    }
    for (const child of node.children ?? []) walk(child);
  };
  walk(subtreeRoot);
  return current;
}

/**
 * 算出归档计划（**只读**：不动传入的文档，也不落盘）。
 *
 * 归档 md 的文本走引擎自己的写回器（`writeBackDocument("", …)`）：frontmatter 摘要 + wfjson
 * 代码块 + 每个节点一个 `### 标题 ^新id` 段落（先占位，再由 `sourceMarkdown` 复制正文），
 * 因此产物天生通过 Schema 与幂等校验。
 *
 * 为什么拒绝「已带 `archive` 的节点」：`archive.workflowId` 是随机 uuid，重新归档必然生成
 * **新的**归档 md，老的 `archive.file` 就成了没人引用的孤儿文件（而新浓缩结果又丢掉了一份信息），
 * 所以要求用户先清掉 `archive` 再来 —— 宁可让他明确地做这件事。
 */
export function planArchive(
  document: WfJsonDocument,
  nodeId: string,
  form: ArchiveFormInput = {},
  now: Date = new Date(),
  sourceMarkdown?: string,
): ArchivePlanResult {
  const check = checkArchiveEligibility(document, nodeId);
  if (!check.ok || check.node === undefined) {
    return { ok: false, reason: check.reason ?? `节点 ${nodeId} 不能归档` };
  }
  const node = check.node;

  const workflowId = newWorkflowId();
  const archivedAt = formatArchivedAt(now);
  const file = archiveFilePath(workflowId, nodeId);
  // v0.7 §⑨-2：`file` 只进 ArchivePlan（插件据此建 md），不再写进 JSON 的 `archive`
  const archive = buildArchiveField(form, archivedAt, workflowId);
  const idMap = new Map<string, string>();
  const archivedDocument = buildArchivedDocument(node, workflowId, document.id, now, idMap);
  let markdown = writeBackDocument("", archivedDocument, { now }).markdown;
  // Phase 9：v0.7 §⑥ —— 归档 md 复制子树正文纪要（文字 + 超链接），锚点 / id 已重映射
  if (sourceMarkdown !== undefined && sourceMarkdown.trim().length > 0) {
    markdown = copyNoteSections(markdown, sourceMarkdown, document, node, idMap);
  }

  const descendants = collectDescendants(node);
  return {
    ok: true,
    plan: {
      nodeId,
      nodeTitle: node.title,
      file,
      workflowId,
      markdown,
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
 * 前置（不满足即拒绝，文档一动不动）：`planArchive` 已建好归档 md，这里只负责把原文件改对；
 * 资格判断会**再跑一次**（plan 与写回之间用户可能改了文件：加了子节点 / 改了状态 / 别人删了节点）。
 * 通过后：
 *   - 挂 `archive`（`archive.workflowId` 指向磁盘上那份归档 md；地址写进纪要段的「归档：」行）；
 *   - `children` 清空 + 删「归档后无意义」的字段；
 *   - `timeEntries` 累加全部后代、`completedAt` 取最晚、`updatedAt` 记成归档时间。
 *
 * 幂等：`archive` 已存在 / 子树里有非 done / 根 / 叶子 → 拒绝，返回值里带原因，绝不半途改一半。
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
 * ④ 幂等重试：认回上次建的那份归档 md
 * ------------------------------------------------------------------ */

/** 归档 md 的身份（幂等重试时用来核对「这个文件是不是这个节点上次建的」） */
export interface ArchivedWorkflowIdentity {
  /** 归档 md 里第一个 workflow 的 id（= 上次 plan 生成的 `archive.workflowId`） */
  workflowId?: string;
  /** 归档 md 里第一个 workflow 的 `originId`（= 上次那个浓缩节点的 id） */
  originId?: string;
  /** 归档 md 里的节点数（读回来做提示 / 核对用） */
  nodeCount?: number;
}

/**
 * 从归档 md 的文本里读回 `workflow.id` / `workflow.originId`（只读；解析不出来就返回 `{}`）。
 *
 * 重试时 `planArchive` 只能给出**新的**（随机）`workflowId`，所以必须从磁盘上那份文件读回真实身份，
 * 否则 `archive.workflowId` 与纪要段「归档：」行会互相错配（文件在 A 路径、行里写着 B 的 id）。
 */
export function readArchivedWorkflowIdentity(markdown: string): ArchivedWorkflowIdentity {
  const analysis = analyzeMarkdown(markdown);
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

/**
 * 候选归档文件是否可能是某节点的归档产物（路径判据，不需要读文件）：
 * `archive/<workflowId>-<nodeId>.md` 或 `archive/<nodeId>.md`。
 * 命中后还要用 `readArchivedWorkflowIdentity` 核对 `originId`（同名不等于同一个节点）。
 */
export function isArchivePathForNode(path: string, nodeId: string): boolean {
  const name = path.slice(path.lastIndexOf("/") + 1);
  return name === `${nodeId}.md` || name.endsWith(`-${nodeId}.md`);
}
