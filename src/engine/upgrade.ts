/**
 * Schema 版本升格（内存中，纯函数）。
 *
 * 决策（doc/datacontact/data_ixd_discuss_interact.md 第 4 节）：
 *  - 解析（`analyzeMarkdown`）保持**只读**：遇到旧版时仅在内存中升格为最新版供渲染；
 *  - **绝不自动落盘**，版本落盘推迟到用户下一次主动修改（`applyMutation` 以最新版写回）；
 *  - 升格只允许「新增 / 拆分字段」，**不允许合并字段**，且升格函数必须**幂等**。
 *
 * 用法：
 *   const { document, upgraded } = upgradeDocument(parsed);   // upgraded=true 时 document 是新对象
 */

import {
  IMPORTANCE_MAX,
  IMPORTANCE_MIN,
  PROGRESS_DEFAULT,
  PROGRESS_MAX,
  PROGRESS_MAX_DEFAULT,
  PROGRESS_MIN,
  SCHEMA_VERSION,
  type WfJsonDocument,
  type WfNode,
} from "./types.ts";

export interface SchemaUpgradeResult {
  /** 升格后的文档（无需升格时 === 传入对象，便于上层判断） */
  document: WfJsonDocument;
  /** 输入文档的 schemaVersion */
  from: string;
  /** 是否发生了升格 */
  upgraded: boolean;
}

interface UpgradeStep {
  /** 升格后的版本号 */
  to: string;
  /** 就地修改（只允许新增 / 拆分字段，且必须幂等） */
  apply: (document: WfJsonDocument) => void;
}

/**
 * 1.0 → 1.1：`workflow.state` / `workflow.originId` 都是**可选**字段——
 * 老数据缺省即「进行中 / 无归档来源」，语义与 v1.0 完全一致。
 * 因此本步只改写 `schemaVersion`，不补任何键（天然幂等）。
 */
const upgradeV1_0ToV1_1 = (): void => {
  // 有意留空：v1.1 新增字段都有「缺省」语义，1.0 老数据无需补值。
};

/**
 * 1.1 → 1.3：v1.3 新增的 `node.timeEntries` / `node.archive` 同样都是**可选**字段——
 * 老数据没有计时会话、也没有浓缩归档标记，语义与 v1.1 完全一致。
 * 因此本步只改写 `schemaVersion`，不补任何键（天然幂等）。1.2 从未发布，直接跳过。
 */
const upgradeV1_1ToV1_3 = (): void => {
  // 有意留空：v1.3 新增字段都有「缺省」语义，1.1 老数据无需补值。
};

/**
 * 1.3 → 1.6（Phase 7 迁移三原则）：缺失字段补默认值、已删除字段无视、同名异名数据无视。
 *  - 每个节点补 `progress`（缺省 0）/ `progress_max`（缺省 1），已有值原样保留（不再与 status 对齐）；
 *  - `importance` / `urgency` 收敛为 1-4：5（及越界值）夹取到 4，非法非数字交给 Schema 报错；
 *  - 根节点 `title` **不覆盖**（§2.3：只在新建 / 修改 workflow.title 时复制；已有标题是用户数据）；
 *    仅在根节点 title 缺失 / 为空时补成 `workflow.title`（老数据兜底）；
 *  - `estimate` / `tags` / `relations` / `link.reason` 已删除但**不做删除**（无视即可），
 *    由写回层原样丢弃 / 保留都不影响校验。
 */
const upgradeV1_3ToV1_6 = (document: WfJsonDocument): void => {
  const walk = (node: WfNode): void => {
    node.progress = clampProgress(node.progress ?? PROGRESS_DEFAULT);
    node.progress_max = clampProgress(node.progress_max ?? PROGRESS_MAX_DEFAULT);
    if (node.importance !== undefined) node.importance = clampScale(node.importance);
    if (node.urgency !== undefined) node.urgency = clampScale(node.urgency);
    for (const child of node.children ?? []) walk(child);
  };

  for (const workflow of document.workflows) {
    const trimmed = typeof workflow.root.title === "string" ? workflow.root.title.trim() : "";
    if (trimmed.length === 0) workflow.root.title = workflow.title;
    if (workflow.progress !== undefined) workflow.progress = clampProgress(workflow.progress);
    if (workflow.progress_max !== undefined) workflow.progress_max = clampProgress(workflow.progress_max);
    walk(workflow.root);
  }
};

/**
 * 1.6 → 1.9（Phase 9）：`links` / `links_relative_path` 都变成 deprecated 的**可选**键，
 * 1.6 数据语义与 1.9 完全一致（超链接迁移发生在写回层，见 `writeBackDocument`）。
 * 因此本步只改写 `schemaVersion`，不补任何键（天然幂等）。1.7 / 1.8 从未发布，直接跳过。
 */
const upgradeV1_6ToV1_9 = (): void => {
  // 有意留空：v1.9 没有新增必填字段，也没有需要补默认值的字段。
};

/** 进度夹取：非数字原样返回（交给 Schema 报 SCHEMA_TYPE），数字收敛到 0-999 的整数 */
function clampProgress(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return value;
  return Math.min(PROGRESS_MAX, Math.max(PROGRESS_MIN, Math.round(value)));
}

/** 重要度夹取：非数字原样返回，数字收敛到 1-4（5 → 4 为 Phase 7 明确要求） */
function clampScale(value: number): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return value;
  return Math.min(IMPORTANCE_MAX, Math.max(IMPORTANCE_MIN, Math.round(value)));
}

/** 升格链：`from` 版本 → 下一步；链的终点是 `SCHEMA_VERSION`（1.0 → 1.1 → 1.3 → 1.6 → 1.9） */
const UPGRADE_STEPS: Readonly<Record<string, UpgradeStep>> = {
  "1.0": { to: "1.1", apply: upgradeV1_0ToV1_1 },
  "1.1": { to: "1.3", apply: upgradeV1_1ToV1_3 },
  "1.3": { to: "1.6", apply: upgradeV1_3ToV1_6 },
  "1.6": { to: "1.9", apply: upgradeV1_6ToV1_9 },
};

/** 升级链最大步数（防御：步骤表被写坏时不至于死循环） */
const MAX_STEPS = 8;

/** wfjson 内是严格 JSON，深拷贝走 JSON 往返即可 */
function cloneDocument(document: WfJsonDocument): WfJsonDocument {
  return JSON.parse(JSON.stringify(document)) as WfJsonDocument;
}

/**
 * 把文档升格到最新版（默认就地不改，返回新对象）：
 *  - 已是 `SCHEMA_VERSION` → 原样返回（`upgraded: false`，同一引用）；
 *  - 白名单外的未知版本 → 原样返回（不猜语义，交由 Schema 白名单报错）；
 *  - 旧版 → 深拷贝后按升级链逐步升格，`schemaVersion` 改写为最新版。
 */
export function upgradeDocument(document: WfJsonDocument): SchemaUpgradeResult {
  const from = document.schemaVersion;
  if (from === SCHEMA_VERSION) return { document, from, upgraded: false };
  if (UPGRADE_STEPS[from] === undefined) return { document, from, upgraded: false };

  const copy = cloneDocument(document);
  let version = from;
  for (let step = 0; step < MAX_STEPS; step += 1) {
    const upgrade = UPGRADE_STEPS[version];
    if (!upgrade) return { document, from, upgraded: false };
    upgrade.apply(copy);
    version = upgrade.to;
    copy.schemaVersion = version;
    if (version === SCHEMA_VERSION) return { document: copy, from, upgraded: true };
  }
  return { document, from, upgraded: false };
}
