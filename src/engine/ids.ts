/**
 * 稳定 ID 与 block 锚点规则（决策 2：全局唯一稳定 ID，AI 靠 ID 跨文件定位）
 *
 * 约定：
 *  - 文件 id:   file-<uuid>
 *  - 工作流 id: wf-<uuid>
 *  - 节点 id:   nd-<uuid>
 *  - 链接 id:   lk-<uuid>
 *  - 节点纪要锚点 = "^" + 节点 id（如 ^nd-uuid-001），与 JSON 的 noteAnchor 一一对应
 */

export const ID_KINDS = ["file", "workflow", "node", "link"] as const;
export type IdKind = (typeof ID_KINDS)[number];

export const ID_PREFIX: Readonly<Record<IdKind, string>> = {
  file: "file-",
  workflow: "wf-",
  node: "nd-",
  link: "lk-",
};

/** id 前缀对应的中文说明（用于报错提示） */
export const ID_KIND_LABELS: Readonly<Record<IdKind, string>> = {
  file: "文件",
  workflow: "工作流",
  node: "节点",
  link: "链接",
};

/** 合法 id：约定前缀 + [A-Za-z0-9_-] */
export const ID_PATTERN = /^(?:file|wf|nd|lk)-[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** 锚点正文（不含 ^ 前缀）：Obsidian block id 允许字母/数字/下划线/连字符 */
export const ANCHOR_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** noteAnchor 的完整形式（含 ^ 前缀），字符串形式，供 JSON Schema 的 pattern 使用 */
export const NOTE_ANCHOR_PATTERN = "^\\^[A-Za-z0-9][A-Za-z0-9_-]*$";

/** noteAnchor 的完整形式（含 ^ 前缀），正则形式 */
export const NOTE_ANCHOR_RE = /^\^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** 锚点标记 */
export const ANCHOR_MARK = "^";

/** RFC4122 v4 UUID（优先使用平台自带 crypto.randomUUID） */
export function uuidV4(): string {
  const cryptoApi = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
    return cryptoApi.randomUUID();
  }
  const bytes = new Uint8Array(16);
  for (let i = 0; i < bytes.length; i += 1) bytes[i] = Math.floor(Math.random() * 256);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** 生成指定类型的稳定 id */
export function newId(kind: IdKind): string {
  return `${ID_PREFIX[kind]}${uuidV4()}`;
}

export const newFileId = (): string => newId("file");
export const newWorkflowId = (): string => newId("workflow");
export const newNodeId = (): string => newId("node");
export const newLinkId = (): string => newId("link");

/** 由稳定 id 派生 16 位短 id（归档文件名用）：去前缀 → 小写 → 只留 [0-9a-z] → 补零截断到 16 位。
 * 确定性：同一个 id 永远得到同一个短 id，幂等重试据此认领归档文件。 */
export function shortIdOf(id: string): string {
  const raw = id.replace(/^[^-]+-/, "").toLowerCase().replace(/[^0-9a-z]/g, "");
  return raw.padEnd(16, "0").slice(0, 16);
}

/** 由节点 id 推导 body 锚点：nd-xxx → ^nd-xxx */
export function anchorForNode(nodeId: string): string {
  return ANCHOR_MARK + nodeId;
}

/** 是否为合法锚点（含 ^ 前缀） */
export function isNoteAnchor(value: string): boolean {
  return NOTE_ANCHOR_RE.test(value);
}

/** 去掉 ^ 前缀，得到锚点正文 */
export function anchorToTarget(anchor: string): string {
  return anchor.startsWith(ANCHOR_MARK) ? anchor.slice(ANCHOR_MARK.length) : anchor;
}

/** 由 id 判断其类型；前缀不符合约定时返回 undefined */
export function idKindOf(id: string): IdKind | undefined {
  for (const kind of ID_KINDS) {
    if (id.startsWith(ID_PREFIX[kind])) return kind;
  }
  return undefined;
}
