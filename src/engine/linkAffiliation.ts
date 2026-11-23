/**
 * 反向 YAML 资料归属（Phase 27 M3）—— 纯函数、零 Obsidian 依赖（`node --test` 直接跑）。
 *
 * 契约（§5.1）：**归属写在资料文件自己的 frontmatter 上**，四个键：
 *
 * ```yaml
 * ---
 * wf-workflow: 读书计划        # 人读：workflow.title
 * wf-node: 选书                # 人读：node.title
 * wf-workflow-id: wf-3f9a1c2b7d   # 可选：workflow.id
 * wf-node-id: nd-0a1b2c3d4e       # 可选：node.id
 * ---
 * ```
 *
 * 插件层从 `metadataCache` 摊平成 `AffiliationEntry[]` 喂进来（只认 `.md`，见 §5.6），
 * 本模块只负责「解析 → 建索引 → 按节点查」。视图渲染时同步取结果，不发 Promise。
 *
 * 匹配口径：**id 精确命中即权威**（改名 / 搬库后仍然命中）；id 组为空才退到
 * `workflowTitle::nodeTitle` 兜底（手动改 YAML 的主要场景）。两者都不命中 → `[]`。
 */

import { FRONTMATTER_FIELDS, type WfNode, type WfWorkflow } from "./types.ts";
import { collectDescendants } from "./archive.ts";

/** 一条「资料文件 → 归属」的原始录入（由插件层从 metadataCache 摊平后喂进来） */
export interface AffiliationEntry {
  /** 资料文件路径（vault 相对） */
  path: string;
  /** 插件层从 metadataCache 取到的原始 frontmatter 记录（只读；引擎自己解析四个键） */
  frontmatter: Record<string, unknown> | undefined;
}

/** 解析后的归属（四个键；至少要有 workflow + node 才算数） */
export interface Affiliation {
  workflowTitle: string;
  nodeTitle: string;
  workflowId?: string;
  nodeId?: string;
}

/** 一条命中结果：归属 + 文件路径 + 展示名 */
export interface LinkedFile extends Affiliation {
  path: string;
  /** 展示名：basename 去掉 `.md` */
  title: string;
}

/** 反向索引（会话内存，不落盘） */
export interface ReverseIndex {
  /** node.id → 资料文件（id 精确命中） */
  byNodeId: Map<string, LinkedFile[]>;
  /** `${workflowTitle}::${nodeTitle}` → 资料文件（title 兜底） */
  byTitle: Map<string, LinkedFile[]>;
  /** 全部资料文件（便于「反查孤儿 / 统计」，本期不强制使用） */
  all: LinkedFile[];
}

/** 查节点资料时的入参（`workflowId` / `nodeId` 缺省时只走 title 兜底） */
export interface NodeAffiliationRef {
  workflowTitle: string;
  nodeTitle: string;
  workflowId?: string;
  nodeId?: string;
}

/** 一个「空索引」（插件层字段初始化 / 视图 stub 都用它） */
export function emptyReverseIndex(): ReverseIndex {
  return { byNodeId: new Map(), byTitle: new Map(), all: [] };
}

/**
 * 取一条 frontmatter 键的「首项字符串」：字符串 → 本身；数组 → 第一个非空字符串。
 * 其它类型（数字 / 布尔 / 对象）一律当缺省 —— 手写 YAML 的容错边界就到这里。
 */
function firstString(value: unknown): string | undefined {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = firstString(item);
      if (text !== undefined) return text;
    }
  }
  return undefined;
}

/**
 * 从 frontmatter 记录里取四个键。
 *
 * `wf-workflow` 或 `wf-node` 缺一个 → `undefined`（不做「半条」人类可读归属）；
 * 只写了两个 id 的文件由 `affiliationOfIdsOnly` 兜住（验收 7：id 也算命中）。
 */
export function affiliationOf(record: Record<string, unknown> | undefined): Affiliation | undefined {
  if (record === undefined) return undefined;
  const workflowTitle = firstString(record[FRONTMATTER_FIELDS.linkWorkflow]);
  const nodeTitle = firstString(record[FRONTMATTER_FIELDS.linkNode]);
  if (workflowTitle === undefined || nodeTitle === undefined) return undefined;
  const workflowId = firstString(record[FRONTMATTER_FIELDS.linkWorkflowId]);
  const nodeId = firstString(record[FRONTMATTER_FIELDS.linkNodeId]);
  return {
    workflowTitle,
    nodeTitle,
    ...(workflowId !== undefined ? { workflowId } : {}),
    ...(nodeId !== undefined ? { nodeId } : {}),
  };
}

/**
 * 一列 frontmatter 值 → **按位置对齐**的字符串数组。
 *
 * 字符串 → `[trim 后的值]`（空串 → `[]`）；数组 → 逐项 trim，非字符串项记空串
 * （`["", nd-1]` 这种占位是四键对齐的一部分，**不能**当「没写」丢掉）。
 */
function stringsOf(value: unknown): string[] {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? [trimmed] : [];
  }
  if (Array.isArray(value)) {
    return value.map((item) => (typeof item === "string" ? item.trim() : ""));
  }
  return [];
}

/**
 * 解析**全部**归属（Phase 35：一个资料文件可以同时挂多个节点 / 工作流）。
 *
 * 四个键按 **index 对齐**成并行列表：第 i 位 = 一条归属。缺项的键按下标补空串，
 * 于是「老文件只写标题 + 新追加的带 id」也能正确配对。
 *
 * 单条口径与 `affiliationOf` 一致：
 *  - `wf-workflow` + `wf-node` 都有 → 一条人读归属；
 *  - 只有 `wf-node-id`（验收 7）→ 用 id 兜底成一条（展示名不会出现 `「」`）；
 *  - 两样都没有 → 跳过（不是一条归属）。
 */
export function affiliationsOf(record: Record<string, unknown> | undefined): Affiliation[] {
  if (record === undefined) return [];
  const workflowTitles = stringsOf(record[FRONTMATTER_FIELDS.linkWorkflow]);
  const nodeTitles = stringsOf(record[FRONTMATTER_FIELDS.linkNode]);
  const workflowIds = stringsOf(record[FRONTMATTER_FIELDS.linkWorkflowId]);
  const nodeIds = stringsOf(record[FRONTMATTER_FIELDS.linkNodeId]);
  const count = Math.max(workflowTitles.length, nodeTitles.length, workflowIds.length, nodeIds.length);

  const list: Affiliation[] = [];
  for (let i = 0; i < count; i += 1) {
    const workflowTitle = workflowTitles[i] ?? "";
    const nodeTitle = nodeTitles[i] ?? "";
    const workflowId = workflowIds[i] ?? "";
    const nodeId = nodeIds[i] ?? "";

    if (workflowTitle.length > 0 && nodeTitle.length > 0) {
      list.push({
        workflowTitle,
        nodeTitle,
        ...(workflowId.length > 0 ? { workflowId } : {}),
        ...(nodeId.length > 0 ? { nodeId } : {}),
      });
      continue;
    }
    // 只写了 id 的那一档：title 用 id 兜底（与旧的 `affiliationOfIdsOnly` 同口径）
    if (nodeId.length === 0) continue;
    list.push({
      workflowTitle: workflowTitle.length > 0 ? workflowTitle : workflowId,
      nodeTitle: nodeTitle.length > 0 ? nodeTitle : nodeId,
      ...(workflowId.length > 0 ? { workflowId } : {}),
      nodeId,
    });
  }
  return list;
}

/** `path` 的展示名：basename 去掉 `.md`（大小写不敏感） */
export function linkedFileTitle(path: string): string {
  const base = path.split("/").pop() ?? path;
  return base.replace(/\.md$/i, "");
}

/** `${workflowTitle}::${nodeTitle}` 索引键（两边都 trim，**区分大小写**） */
export function affiliationKey(workflowTitle: string, nodeTitle: string): string {
  return `${workflowTitle.trim()}::${nodeTitle.trim()}`;
}

function push(map: Map<string, LinkedFile[]>, key: string, file: LinkedFile): void {
  const list = map.get(key);
  if (list === undefined) map.set(key, [file]);
  else list.push(file);
}

/**
 * 建反向索引：无归属的文件直接跳过；同一 nodeId / title 的多个文件都收齐。
 *
 * 只有 title、没有 id 的文件也能收（进 `byTitle`）；只有 id 的文件也能收（进 `byNodeId`）。
 * Phase 35：一个文件可以有多条归属 → **每条归属各进一份**（`all` 也按归属计条数），
 * 取「文件列表」的调用方（`uniqueSorted`）会按 path 去重。
 */
export function buildReverseIndex(entries: readonly AffiliationEntry[]): ReverseIndex {
  const index = emptyReverseIndex();
  for (const entry of entries) {
    // 只认 md（插件层已经过滤一次；这里再挡一遍，纯函数也好测）
    if (!entry.path.toLowerCase().endsWith(".md")) continue;
    for (const affiliation of affiliationsOf(entry.frontmatter)) {
      const file: LinkedFile = {
        ...affiliation,
        path: entry.path,
        title: linkedFileTitle(entry.path),
      };
      index.all.push(file);
      if (affiliation.nodeId !== undefined) push(index.byNodeId, affiliation.nodeId, file);
      if (affiliation.workflowTitle !== "" && affiliation.nodeTitle !== "") {
        push(index.byTitle, affiliationKey(affiliation.workflowTitle, affiliation.nodeTitle), file);
      }
    }
  }
  return index;
}

/** 按 path 去重 + 字典序稳定排序 */
function uniqueSorted(files: readonly LinkedFile[]): LinkedFile[] {
  const seen = new Map<string, LinkedFile>();
  for (const file of files) {
    if (!seen.has(file.path)) seen.set(file.path, file);
  }
  return [...seen.values()].sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
}

/**
 * 查询某节点的资料文件。**匹配优先级：id 精确 → (workflowTitle + nodeTitle) 兜底**。
 * 结果按 path 去重、按 path 字典序稳定排序。
 */
export function resolveLinkedFiles(index: ReverseIndex, ref: NodeAffiliationRef): LinkedFile[] {
  if (ref.nodeId !== undefined) {
    const byId = index.byNodeId.get(ref.nodeId);
    if (byId !== undefined && byId.length > 0) return uniqueSorted(byId);
  }
  const byTitle = index.byTitle.get(affiliationKey(ref.workflowTitle, ref.nodeTitle));
  return byTitle !== undefined ? uniqueSorted(byTitle) : [];
}

/** 便利包装：从「节点 + 所属工作流」直接算出查询入参（视图 `renderCard` 用） */
export function nodeRefFor(workflow: WfWorkflow | undefined, node: WfNode): NodeAffiliationRef {
  return {
    workflowTitle: workflow?.title ?? "",
    nodeTitle: node.title,
    workflowId: workflow?.id,
    nodeId: node.id,
  };
}

/* ------------------------------------------------------------------ *
 * Phase 34：改名 / 归档同步用的「并集」查询
 *
 * 渲染继续走 `resolveLinkedFiles`（id 权威、不混入只靠标题命中的文件）；
 * 同步要把「所有还写着旧名字的文件」都找出来，所以另开两个并集口径。
 * ------------------------------------------------------------------ */

/** 工作流口径的查询入参（按 id 或旧标题匹配） */
export interface WorkflowAffiliationRef {
  workflowTitle: string;
  workflowId?: string;
}

/**
 * 某节点的**全部**归属文件：id 命中 ∪ `workflowTitle::oldNodeTitle` 命中，
 * 按 path 去重 + 字典序稳定排序。
 *
 * 改名同步传「旧标题」进来：只写了标题（没写 id）的文件也能被找出来一起改。
 */
export function collectAffiliatedFiles(index: ReverseIndex, ref: NodeAffiliationRef): LinkedFile[] {
  const merged: LinkedFile[] = [];
  if (ref.nodeId !== undefined) merged.push(...(index.byNodeId.get(ref.nodeId) ?? []));
  merged.push(...(index.byTitle.get(affiliationKey(ref.workflowTitle, ref.nodeTitle)) ?? []));
  return uniqueSorted(merged);
}

/**
 * 某工作流名下的**全部**归属文件：`wf-workflow-id` 命中 ∪ `wf-workflow` 标题命中，
 * 按 path 去重 + 字典序稳定排序。
 *
 * 工作流改名 / 整条流归档同步都用它：id 兜住「手改过标题」的文件，标题兜住「没写 id」的文件；
 * 标题为空时不参与标题匹配（空标题没有区分度）。
 */
export function collectWorkflowFiles(index: ReverseIndex, ref: WorkflowAffiliationRef): LinkedFile[] {
  const title = ref.workflowTitle.trim();
  return uniqueSorted(
    index.all.filter(
      (file) =>
        (ref.workflowId !== undefined && file.workflowId === ref.workflowId) ||
        (title.length > 0 && file.workflowTitle.trim() === title),
    ),
  );
}

/**
 * 节点级归档同步用：`root` 及其**全部后代**的归属文件并集。
 *
 * 每个节点仍按 `collectAffiliatedFiles` 的口径查（id 命中 ∪ `workflowTitle::nodeTitle` 兜底），
 * 再按 path 去重 + 字典序。整棵子树在归档时一起搬进归档 md，所以它们的资料文件都要跟着换
 * `wf-workflow`；整条流归档走 `collectWorkflowFiles`，不用这个。
 */
export function collectSubtreeFiles(
  index: ReverseIndex,
  workflow: WfWorkflow | undefined,
  root: WfNode,
): LinkedFile[] {
  const merged = new Map<string, LinkedFile>();
  for (const node of [root, ...collectDescendants(root)]) {
    for (const file of collectAffiliatedFiles(index, nodeRefFor(workflow, node))) merged.set(file.path, file);
  }
  return uniqueSorted([...merged.values()]);
}

/* ------------------------------------------------------------------ *
 * Phase 35：多归属写入（「添加文档地址」= 增补，不覆盖）
 *
 * 四键在文件里是**四个并行的数组**（单条时仍是标量，老文件零差异）。
 * 写回侧只做两件事：
 *  - `appendAffiliation`：把一条新归属追加到末尾（同 id / 同标题 → 幂等）；
 *  - `replaceAffiliationItem`：改名 / 归档时只替换命中的那一项，别的归属原样留着。
 * ------------------------------------------------------------------ */

/** 四键的最终值（四个数组**等长**，缺项用空串占位） */
export interface AffiliationFieldValues {
  workflowTitle: string[];
  nodeTitle: string[];
  workflowId: string[];
  nodeId: string[];
}

const AFFILIATION_FIELD_KEYS = ["workflowTitle", "nodeTitle", "workflowId", "nodeId"] as const;

/** 把四个数组补齐到同一长度（缺项补空串，保证 index 对齐） */
function alignAffiliationFields(values: AffiliationFieldValues): void {
  const count = Math.max(
    values.workflowTitle.length,
    values.nodeTitle.length,
    values.workflowId.length,
    values.nodeId.length,
  );
  for (const key of AFFILIATION_FIELD_KEYS) {
    while (values[key].length < count) values[key].push("");
  }
}

/** 去掉末尾「四项全空」的占位档（手写 YAML 里可能留了空项） */
function trimTrailingEmptyAffiliations(values: AffiliationFieldValues): void {
  let count = values.workflowTitle.length;
  while (count > 0) {
    const i = count - 1;
    const empty = AFFILIATION_FIELD_KEYS.every((key) => (values[key][i] ?? "").length === 0);
    if (!empty) break;
    count -= 1;
  }
  if (count === values.workflowTitle.length) return;
  for (const key of AFFILIATION_FIELD_KEYS) values[key].length = count;
}

export interface AppendAffiliationResult {
  /** 是否真的加了（同 nodeId / 同 nodeTitle 已在列表里 → false，调用方不必写盘） */
  changed: boolean;
  /** 四键的最终并行数组（`changed === false` 时是规整后的原值） */
  values: AffiliationFieldValues;
}

/**
 * 把一条归属**追加**到既有四键的末尾（Phase 35：「已有字段就增补，不要覆盖」）。
 *
 * - 幂等：`nodeId` 已在 `wf-node-id` 里 → 什么都不加；没有 `nodeId` 时按 `nodeTitle` 判重；
 * - 对齐：四个数组先补齐再同长追加，老文件「只写标题」也不会让新 id 配错节点；
 * - 不写多余占位：末尾全空的档会被去掉。
 */
export function appendAffiliation(
  record: Record<string, unknown> | undefined,
  tuple: Affiliation,
): AppendAffiliationResult {
  const values: AffiliationFieldValues = {
    workflowTitle: stringsOf(record?.[FRONTMATTER_FIELDS.linkWorkflow]),
    nodeTitle: stringsOf(record?.[FRONTMATTER_FIELDS.linkNode]),
    workflowId: stringsOf(record?.[FRONTMATTER_FIELDS.linkWorkflowId]),
    nodeId: stringsOf(record?.[FRONTMATTER_FIELDS.linkNodeId]),
  };
  alignAffiliationFields(values);
  trimTrailingEmptyAffiliations(values);

  const workflowTitle = tuple.workflowTitle.trim();
  const nodeTitle = tuple.nodeTitle.trim();
  const workflowId = tuple.workflowId?.trim() ?? "";
  const nodeId = tuple.nodeId?.trim() ?? "";

  // 没有节点的归属写进去只会变成一条空档，直接当「没变化」
  if (nodeTitle.length === 0) return { changed: false, values };

  const already =
    nodeId.length > 0 ? values.nodeId.includes(nodeId) : values.nodeTitle.includes(nodeTitle);
  if (already) return { changed: false, values };

  values.workflowTitle.push(workflowTitle);
  values.nodeTitle.push(nodeTitle);
  values.workflowId.push(workflowId);
  values.nodeId.push(nodeId);
  return { changed: true, values };
}

export interface ReplaceAffiliationResult {
  changed: boolean;
  values: string[];
}

/** 替换时的定位口径：id 权威、旧标题兜底（与 `resolveLinkedFiles` 同思路） */
export interface AffiliationItemMatch {
  /** 同一 index 的 id 字段（`wf-node-id` / `wf-workflow-id`）等于它 → 命中 */
  id?: string;
  /** 当前值等于它（旧标题）→ 命中；`id` 命中时不必再看 */
  title?: string;
}

/**
 * 只替换「命中的那一项」（Phase 34 改名 / 归档同步；Phase 35 起支持多归属）。
 *
 * 口径与 `resolveLinkedFiles` 一致：**id 精确命中即权威** ——
 *  1. 本列里任何一项的 id（并行数组同下标）等于 `match.id` → 只改这些项，
 *     别的归属哪怕标题同名也**不**动（同一工作流下两个同名节点各挂一份的场景）；
 *  2. 一个 id 都没命中（老文件只写了标题 / 手改过 id）→ 退到按旧标题匹配，命中项全部替换。
 *
 * 没有命中 → `changed: false`，调用方原样写回即可（`vault.process` 不产生写盘）。
 */
export function replaceAffiliationItem(
  current: readonly string[],
  ids: readonly string[],
  match: AffiliationItemMatch,
  newValue: string,
): ReplaceAffiliationResult {
  const id = match.id?.trim() ?? "";
  const title = match.title?.trim() ?? "";
  const values = [...current];

  const byId: number[] = [];
  if (id.length > 0) {
    for (let i = 0; i < values.length; i += 1) {
      if ((ids[i] ?? "").trim() === id) byId.push(i);
    }
  }
  const targets = byId.length > 0 ? byId : indexesOf(values, title);

  let changed = false;
  for (const i of targets) {
    if (values[i] === newValue) continue;
    values[i] = newValue;
    changed = true;
  }
  return { changed, values };
}

/** 某一列里 trim 后等于 `title` 的全部下标（`title` 为空 → 空数组） */
function indexesOf(values: readonly string[], title: string): number[] {
  if (title.length === 0) return [];
  const hits: number[] = [];
  for (let i = 0; i < values.length; i += 1) {
    if (values[i].trim() === title) hits.push(i);
  }
  return hits;
}
