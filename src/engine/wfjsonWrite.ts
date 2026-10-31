/**
 * 写回层：`stringifyWfJson` / `buildWfJsonBlock` / `upsertWfJsonBlock`；
 *  - frontmatter 摘要字段：`buildFrontmatterSummary` / `upsertFrontmatterSummary`；
 *  - 节点纪要段落：`sanitizeTitle` / `appendNoteSection` / `ensureNoteSections` / `removeNoteSections`；
 *  - 变更编排的写回：`writeBackDocument`（代码块 + 摘要 + 先删后补纪要段落）。
 */

import { anchorForNode, anchorToTarget } from "./ids.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { findBlockAnchors, findCodeFences, findWfJsonBlocks, indexBlockAnchors, replaceBlockContent, splitLines } from "./markdownScan.ts";
import { aggregateStatus } from "./consistency.ts";
import {
  NOTE_HEADING_LEVEL,
  NOTE_PLACEHOLDER,
  appendNoteSectionLines,
  extractNoteLinks,
  findNoteSections,
  getNoteSectionContent,
  renderNoteLinkLine,
  renderNoteSection,
  wrapNoteSections,
  type NoteSectionRenderOptions,
} from "./noteSection.ts";
import { walkNodes } from "./tree.ts";
import { formatLocalIso, toDateOnly } from "./time.ts";
import { FRONTMATTER_FIELDS, WFJSON_LANG, type WfJsonDocument, type WfNode } from "./types.ts";

/** wfjson 代码块的序列化缩进（严格 JSON，零注释） */
const JSON_INDENT = 2;

/** 纪要段落默认标题层级（形如 `### 标题 ^nd-xxx`；Phase 9 起带标志） */
export const DEFAULT_NOTE_HEADING_LEVEL = NOTE_HEADING_LEVEL;

/** 新建节点时写入正文的占位文本 */
export const DEFAULT_NOTE_PLACEHOLDER = NOTE_PLACEHOLDER;

export interface WriteDocumentOptions {
  /** JSON 缩进空格数（默认 2） */
  indent?: number;
}

/** 文档 → 严格 JSON 文本（带结尾换行） */
export function stringifyWfJson(document: WfJsonDocument, options: WriteDocumentOptions = {}): string {
  const indent = options.indent ?? JSON_INDENT;
  const json = JSON.stringify(document, null, indent);
  return json.endsWith("\n") ? json : `${json}\n`;
}

/** 文档 → 完整的 wfjson 代码块文本（含两侧围栏） */
export function buildWfJsonBlock(document: WfJsonDocument, options: WriteDocumentOptions = {}): string {
  return `\`\`\`${WFJSON_LANG}\n${stringifyWfJson(document, options)}\`\`\`\n`;
}

export type WfJsonWriteAction = "replaced" | "appended";

export interface WfJsonWriteResult {
  markdown: string;
  action: WfJsonWriteAction;
  /** 写入后代码块起始行（1 基） */
  line: number;
}

/**
 * 把文档写入 md：
 *  - 已有 wfjson 代码块 → 替换第一个块的内容（其余块保持原样，由一致性检查报错）；
 *  - 没有 → 在文件末尾追加一个代码块。
 */
export function upsertWfJsonBlock(
  markdown: string,
  document: WfJsonDocument,
  options: WriteDocumentOptions = {},
): WfJsonWriteResult {
  const blocks = findWfJsonBlocks(markdown);
  if (blocks.length > 0) {
    const block = blocks[0];
    const next = replaceBlockContent(markdown, block, stringifyWfJson(document, options));
    return { markdown: next, action: "replaced", line: block.startLine };
  }

  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  const blockText = buildWfJsonBlock(document, options);
  if (markdown.trim().length === 0) {
    return { markdown: blockText, action: "appended", line: 1 };
  }
  const trimmed = markdown.replace(/(?:\r?\n)+$/, "");
  const next = `${trimmed}${newline}${newline}${blockText}`;
  const line = splitLines(next).length - splitLines(blockText).length + 1;
  return { markdown: next, action: "appended", line };
}

export interface WfJsonBlockInfo {
  found: boolean;
  /** 是否存在多个 wfjson 代码块 */
  multiple: boolean;
  closed: boolean;
  /** 代码块内容起始行（1 基） */
  line: number;
  /** 全部 wfjson 代码块的起始行 */
  lines: number[];
}

/** 快速查看 md 里的 wfjson 代码块状况（供上层提示用） */
export function inspectWfJsonBlocks(markdown: string): WfJsonBlockInfo {
  const frontmatter = parseFrontmatter(markdown);
  const blocks = findWfJsonBlocks(markdown, frontmatter);
  const fences = findCodeFences(markdown, frontmatter);
  return {
    found: blocks.length > 0,
    multiple: blocks.length > 1,
    closed: blocks.every((block) => block.closed),
    line: blocks.length > 0 ? blocks[0].contentStartLine : 0,
    lines: blocks.map((block) => block.startLine),
  };
}

/**
 * 删掉笔记里所有 wfjson 代码块（迁移到外置 JSON 时用）。
 *
 * 边界处理：连块后的一行空行一起删（块在文件末尾时删块前的那行），
 * 这样「正文 + 空行 + 代码块」迁移后不会留下多余空行；重复调用文本逐字节稳定。
 */
export function removeWfJsonBlocks(markdown: string): { markdown: string; removedLines: number[] } {
  const blocks = findWfJsonBlocks(markdown);
  if (blocks.length === 0) return { markdown, removedLines: [] };

  const lines = splitLines(markdown).map((line) => line.text);
  const doomed = new Set<number>();
  const removedLines: number[] = [];
  for (const block of blocks) {
    removedLines.push(block.startLine);
    for (let index = block.startLine - 1; index <= block.endLine - 1; index += 1) doomed.add(index);
    if (block.endLine < lines.length && (lines[block.endLine] ?? "").trim().length === 0) {
      doomed.add(block.endLine);
    } else if (block.startLine >= 2 && (lines[block.startLine - 2] ?? "").trim().length === 0) {
      doomed.add(block.startLine - 2);
    }
  }

  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  return { markdown: lines.filter((_line, index) => !doomed.has(index)).join(newline), removedLines };
}

/* ---- frontmatter 摘要字段（决策 5：仅保留少量可检索的扁平面包屑） ---- */

export interface FrontmatterSummary {
  tags: string[];
  status: string;
  titles: string[];
  updated: string;
}

/**
 * 由文档推导 frontmatter 摘要字段的值。
 * `wf-status` 走 v1.1 的**两步聚合**（`aggregateStatus(document)`）：
 * 先按 workflow 算贡献状态（缺省=进行中→节点聚合；archived→done；cancelled→cancelled），
 * 再按 `doing > blocked > todo > cancelled > done` 合并。
 */
export function buildFrontmatterSummary(document: WfJsonDocument, now: Date = new Date()): FrontmatterSummary {
  const visits = walkNodes(document);
  const tags: string[] = [];
  for (const visit of visits) {
    for (const tag of visit.node.tags ?? []) {
      if (!tags.includes(tag)) tags.push(tag);
    }
  }
  return {
    tags,
    status: aggregateStatus(document),
    titles: document.workflows.map((workflow) => workflow.title),
    updated: document.updatedAt !== undefined ? toDateOnly(document.updatedAt) : toDateOnly(formatLocalIso(now)),
  };
}

/** YAML 标量渲染：含特殊字符时加双引号 */
export function renderYamlScalar(value: string): string {
  if (value.length === 0) return '""';
  if (/^[\s]|[\s]$|[,:\[\]{}#&*!|>'"%@`]/.test(value)) return `"${value.replace(/"/g, '\\"')}"`;
  return value;
}

/** YAML 值渲染：数组用内联形式 [a, b] */
export function renderYamlValue(value: string | string[]): string {
  if (Array.isArray(value)) return `[${value.map(renderYamlScalar).join(", ")}]`;
  return renderYamlScalar(value);
}

export interface FrontmatterWriteResult {
  markdown: string;
  action: "created" | "updated";
  /** 写入的字段行（1 基，按字段名索引） */
  lines: Record<string, number>;
}

/**
 * 写入/更新 frontmatter 的 wf-* 摘要字段：
 *  - 已有 frontmatter → 逐字段覆盖或追加到 `---` 之前；
 *  - 没有 frontmatter → 在文件最前面创建一个；
 *  - 其它既有字段（如 title / 用户自己的标签）保持原样。
 */
export function upsertFrontmatterSummary(
  markdown: string,
  document: WfJsonDocument,
  now: Date = new Date(),
): FrontmatterWriteResult {
  const info = parseFrontmatter(markdown);
  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  const summary = buildFrontmatterSummary(document, now);
  const entries: [string, string | string[]][] = [
    [FRONTMATTER_FIELDS.tags, summary.tags],
    [FRONTMATTER_FIELDS.status, summary.status],
    [FRONTMATTER_FIELDS.titles, summary.titles],
    [FRONTMATTER_FIELDS.updated, summary.updated],
  ];
  const lines: Record<string, number> = {};

  if (!info.present) {
    const created = entries.map(([key, value]) => `${key}: ${renderYamlValue(value)}`);
    const prefix = ["---", ...created, "---", "", ""].join(newline);
    entries.forEach(([key], index) => {
      lines[key] = index + 2; // 第 1 行是 ---，字段从第 2 行开始
    });
    return { markdown: prefix + markdown, action: "created", lines };
  }

  const text = markdown.startsWith("\uFEFF") ? markdown.slice(1) : markdown;
  const body = splitLines(text).map((line) => line.text);
  const byKey = new Map(info.fields.map((field) => [field.key, field]));
  const closingIndex = info.endLine - 1;

  // 先覆盖已有字段。
  // v0.8 修复：历史版本把 `wf-tags` / `wf-titles` 写成「键行 + 块序列」（`wf-tags:` 后跟 `  - 树干`），
  // 只改键行会把子行留成孤儿 —— 渲染出来像一行「空格」，Obsidian 直接判 frontmatter 非法。
  // 这里覆盖键行时，把它名下紧跟的 `- item` 块序列子行一并删掉（与 `setFrontmatterField` 的游标跳过一致）。
  const doomed = new Set<number>();
  for (const [key, value] of entries) {
    const field = byKey.get(key);
    if (!field) continue;
    const index = field.line - 1;
    body[index] = `${key}: ${renderYamlValue(value)}`;
    let cursor = index + 1;
    while (cursor < closingIndex && /^\s*-\s+/.test(body[cursor] ?? "")) {
      doomed.add(cursor);
      cursor += 1;
    }
  }

  // 块序列子行被删掉后，结束 `---` 的位置要跟着前移
  const kept = doomed.size > 0 ? body.filter((_line, index) => !doomed.has(index)) : body;
  const keptClosing = closingIndex - [...doomed].filter((index) => index < closingIndex).length;

  // 再把缺失字段插到结束的 `---` 之前（保持稳定顺序）
  const missing = entries.filter(([key]) => !byKey.has(key));
  missing.forEach(([key, value], index) => {
    kept.splice(keptClosing + index, 0, `${key}: ${renderYamlValue(value)}`);
  });

  // 行号按最终文本重算（覆盖 / 插入 / 删除都会让原行号失效）
  const summaryKeys = new Set(entries.map(([key]) => key));
  kept.forEach((line, index) => {
    const match = /^([A-Za-z0-9_.-]+)\s*:/.exec(line);
    if (match === null || !summaryKeys.has(match[1])) return;
    if (lines[match[1]] === undefined) lines[match[1]] = index + 1;
  });

  // 注意：splitLines 对「以换行结尾」的文本会多切出一个空行元素，
  // `join` 之后已经带上了结尾换行；再补一个会让每次写回都多出一个空行（破坏幂等）。
  const endedWithNewline = /\r?\n$/.test(text);
  const lastIsBlank = kept.length > 0 && kept[kept.length - 1] === "";
  const suffix = endedWithNewline && !lastIsBlank ? newline : "";
  return {
    markdown: kept.join(newline) + suffix,
    action: "updated",
    lines,
  };
}

/* ---- 标题清洗（Phase 2：添加子节点 / 追加纪要段落前的统一入口） ---- */

export interface SanitizeTitleResult {
  /** 是否可以安全写入（false 时 `title` 只是去掉首尾空白后的近似值） */
  ok: boolean;
  /** 去掉首尾空白后的标题 */
  title: string;
  /** ok=false 的原因（标题为空 / 含换行符） */
  reason?: string;
  /** ok=true 时的风险提示（视图/Modal 可提示用户改名） */
  warnings: string[];
}

/**
 * 清洗节点标题（新建节点 / 添加子节点共用）。
 *
 * 纪要段落形如 `### {title} ^{id}`，一个标题行要同时被 Obsidian 的大纲与 block 锚点解析：
 *  - 空标题 → 拒绝（无标题的卡片与锚点都不可读）；
 *  - 含 `\r` / `\n` → 拒绝（会把一行标题拆成两行，锚点可能落到正文行上）；
 *  - 含 `#` / `|` / `[` / `]` → 允许但给出提示（建议改名，避免渲染歧义）。
 */
export function sanitizeTitle(raw: string): SanitizeTitleResult {
  const title = raw.trim();
  if (title.length === 0) return { ok: false, title: "", reason: "标题不能为空", warnings: [] };
  if (/[\r\n]/.test(raw)) return { ok: false, title, reason: "标题不能包含换行符", warnings: [] };
  const warnings: string[] = [];
  if (/[#|[\]]/.test(title)) {
    warnings.push("标题含 # / | / [ / ]，会写进纪要段落标题行；如渲染异常请改名");
  }
  return { ok: true, title, warnings };
}

/* ---- 纪要段落（决策 4：新建节点时在正文落一个带锚点的段落） ---- */

export interface NoteSectionOptions {
  /** 标题层级（默认 3 → ###） */
  level?: number;
  /** 占位正文（默认「（纪要待补充）」） */
  placeholder?: string;
}

export interface NoteSectionResult {
  markdown: string;
  /** 是否真的追加了段落（已存在时为 false） */
  added: boolean;
  anchor: string;
}

/** 为单个节点追加 `### 标题 ^nd-xxx` 纪要段落（锚点已存在则原样返回；Phase 9 起带标志对） */
export function appendNoteSection(
  markdown: string,
  node: WfNode,
  options: NoteSectionOptions = {},
): NoteSectionResult {
  const info = parseFrontmatter(markdown);
  const anchors = indexBlockAnchors(findBlockAnchors(markdown, info));
  const anchor = node.noteAnchor ?? anchorForNode(node.id);
  if (anchors.has(anchor)) return { markdown, added: false, anchor };

  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  const renderOptions: NoteSectionRenderOptions = {
    level: options.level ?? DEFAULT_NOTE_HEADING_LEVEL,
    placeholder: options.placeholder ?? DEFAULT_NOTE_PLACEHOLDER,
  };
  const block = `${renderNoteSection(node, renderOptions).replace(/\n/g, newline)}${newline}`;

  if (markdown.trim().length === 0) return { markdown: block, added: true, anchor };
  const trimmed = markdown.replace(/(?:\r?\n)+$/, "");
  return { markdown: `${trimmed}${newline}${newline}${block}`, added: true, anchor };
}

export interface EnsureNoteSectionsResult {
  markdown: string;
  /** 新追加的锚点（按先序） */
  added: string[];
}

/** 为文档内所有缺少纪要段落的节点补齐 `### 标题 ^nd-xxx`（先序） */
export function ensureNoteSections(
  markdown: string,
  document: WfJsonDocument,
  options: NoteSectionOptions = {},
): EnsureNoteSectionsResult {
  let current = markdown;
  const added: string[] = [];
  for (const visit of walkNodes(document)) {
    const result = appendNoteSection(current, visit.node, options);
    current = result.markdown;
    if (result.added) added.push(result.anchor);
  }
  return { markdown: current, added };
}

/* ---- 纪要段落删除（Phase 2：删除节点时连带清掉它在正文里的纪要段落） ---- */

/** 标题行识别（`### xxx`），用于界定一个纪要段落的范围 */
const SECTION_HEADING_RE = /^(#{1,6})[ \t]/;

export interface RemoveNoteSectionsResult {
  markdown: string;
  /** 实际删掉的锚点（按传入顺序，锚点行在正文里存在过） */
  removed: string[];
  /** 正文里找不到的锚点（原样保留，交给一致性检查报 ORPHAN_BLOCK_ANCHOR） */
  missing: string[];
}

/**
 * 按 `noteAnchor` 删除正文里的纪要段落（删除节点依赖）。
 *
 * 段落边界：锚点所在行是标题行（`### 标题 ^nd-xxx`）时，删到
 * 「下一个层级 ≤ 本标题层级」的标题行之前（子标题一并带走，末尾空行一并清掉）；
 * 锚点不在标题行时只删它自己那一行。
 *
 * 调用顺序上必须先删后补（见 `writeBackDocument`）：本函数删掉的段落若连带吃掉了
 * 仍在 JSON 里的子节点段落，`ensureNoteSections` 会按 JSON 重新补回来。
 */
export function removeNoteSections(markdown: string, anchors: readonly string[]): RemoveNoteSectionsResult {
  const targets = anchors.filter((anchor) => anchor.length > 0);
  if (targets.length === 0) return { markdown, removed: [], missing: [] };

  const info = parseFrontmatter(markdown);
  const byAnchor = indexBlockAnchors(findBlockAnchors(markdown, info));
  const sections = findNoteSections(markdown, info);
  const lines = splitLines(markdown).map((line) => line.text);
  const doomed = new Set<number>();
  const removed: string[] = [];
  const missing: string[] = [];

  for (const anchor of targets) {
    const nodeId = anchorToTarget(anchor);
    // Phase 9：优先按标志对删（含标题行），段落边界不再依赖标题层级
    const section = sections.find((item) => item.nodeId === nodeId);
    if (section !== undefined) {
      removed.push(anchor);
      const start = section.headingLine > 0 ? section.headingLine - 1 : section.beginLine - 1;
      const end = section.endLine - 1;
      for (let i = start; i <= end; i += 1) doomed.add(i);
      // 顺带清掉段落后面的一行空行，避免连续空行越攒越多
      if (end + 1 < lines.length && (lines[end + 1] ?? "").trim().length === 0) doomed.add(end + 1);
      continue;
    }

    const refs = byAnchor.get(anchor);
    if (refs === undefined || refs.length === 0) {
      missing.push(anchor);
      continue;
    }
    removed.push(anchor);
    const start = refs[0].line - 1;
    let end = start;
    const heading = SECTION_HEADING_RE.exec(lines[start] ?? "");
    if (heading !== null) {
      const level = heading[1].length;
      end = lines.length - 1;
      for (let i = start + 1; i < lines.length; i += 1) {
        const next = SECTION_HEADING_RE.exec(lines[i] ?? "");
        if (next !== null && next[1].length <= level) {
          end = i - 1;
          break;
        }
      }
      while (end > start && (lines[end] ?? "").trim().length === 0) end -= 1;
    }
    for (let i = start; i <= end; i += 1) doomed.add(i);
  }

  if (doomed.size === 0) return { markdown, removed, missing };
  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  const kept = lines.filter((_line, index) => !doomed.has(index));
  return { markdown: kept.join(newline), removed, missing };
}

/* ---- 变更编排的写回（决策：代码块 + frontmatter 摘要 + 先删后补纪要段落） ---- */

/** 删除节点时把它的纪要段超链接并进父节点（Phase 9：「超链接合并进上级条目」） */
export interface NoteLinkMerge {
  /**
   * 被删节点的 noteAnchor（如 `^nd-x`）。
   * 只是「往目标段落追加几行」时省略（v0.7 §⑨-2 的归档地址行就是这样：没有源段落要抄）。
   */
  sourceAnchor?: string;
  /** 合并目标节点 id（父节点） */
  targetNodeId: string;
  /**
   * 额外要合并的行（被删节点 JSON 里还没迁移的 `links[]` → `renderNoteLinkLine` 的结果）。
   * 这些行在源段落删除后就没有别的载体了，因此由删节点一侧显式带上。
   */
  lines?: readonly string[];
}

export interface WriteBackOptions extends WriteDocumentOptions, NoteSectionOptions {
  /** frontmatter 的 wf-updated 取值基准时间（默认当前时间） */
  now?: Date;
  /** 需要从正文删掉的纪要锚点（删除节点时由 mutator 上报，默认不删） */
  removedNoteAnchors?: readonly string[];
  /** 删除节点时把源段落的超链接行追加到目标段落（默认不合并） */
  mergeNoteSections?: readonly NoteLinkMerge[];
  /**
   * 是否把旧文件 JSON 里的 `links[]` 迁进正文纪要段（默认 true）。
   * 迁移后 `node.links` 被删除 → 代码块里不再落盘（deprecate 范式的落地）。
   */
  migrateLinks?: boolean;
}

/** 只重写笔记（frontmatter 摘要 + 先删后补纪要段落）的结果（v0.7 §⑧ 侧车模式用） */
export interface WriteNoteBackResult {
  /** 写回后的完整 md 文本（不含 JSON；侧车模式下 JSON 在外置文件里） */
  markdown: string;
  /** frontmatter 动作（创建 / 更新） */
  frontmatter: "created" | "updated";
  /** 本次新补的纪要锚点（按先序） */
  addedAnchors: string[];
  /** 本次从正文删掉的纪要锚点（按传入顺序） */
  removedAnchors: string[];
  /** 本次从 `links[]` 迁进正文的节点 id（按先序） */
  migratedLinkNodeIds: string[];
}

export interface WriteBackResult extends WriteNoteBackResult {
  /** wfjson 代码块动作（替换已有块 / 追加新块） */
  action: WfJsonWriteAction;
}

/**
 * 旧文件迁移：把每个节点 `links[]` 里的条目写进它的正文纪要段（Phase 9 的核心迁移）。
 *
 *  - 纪要段有标志对 → 直接追加；没有 → 先 `wrapNoteSections` 给旧段落补标志再追加；
 *  - 连标题段落都没有 → 跳过（该节点照样保留 `links`，交给一致性 / 用户处理，不静默丢数据）；
 *  - 迁移成功的节点删掉 `links`（写回代码块时自然不再落盘）。
 *
 * 幂等：迁移过一遍之后 `links` 键已不存在，第二次不会再追加。
 */
export function migrateLinksToNoteSections(
  markdown: string,
  document: WfJsonDocument,
): { markdown: string; migratedNodeIds: string[] } {
  let current = markdown;
  let wrapped = false;
  const migratedNodeIds: string[] = [];

  for (const visit of walkNodes(document)) {
    const node = visit.node;
    const links = node.links;
    if (!Array.isArray(links) || links.length === 0) continue;
    const lines = links.map(renderNoteLinkLine);

    let attempt = appendNoteSectionLines(current, node.id, lines);
    if (!attempt.appended && !wrapped) {
      const result = wrapNoteSections(current, document);
      current = result.markdown;
      wrapped = true;
      attempt = appendNoteSectionLines(current, node.id, lines);
    }
    if (!attempt.appended) continue;
    current = attempt.markdown;
    delete node.links;
    migratedNodeIds.push(node.id);
  }
  return { markdown: current, migratedNodeIds };
}

/**
 * 删除节点时的「超链接合并进上级条目」：把源段落里**含链接的行**追加到目标段落末尾。
 * 源段落随后由 `removeNoteSections` 整段删掉。
 */
export function mergeNoteSectionLinks(markdown: string, merges: readonly NoteLinkMerge[]): string {
  let current = markdown;
  for (const merge of merges) {
    const content =
      merge.sourceAnchor !== undefined ? getNoteSectionContent(current, merge.sourceAnchor) : undefined;
    const linkLines = [
      ...(content?.split(/\r?\n/).filter((line) => extractNoteLinks(line).length > 0) ?? []),
      ...(merge.lines ?? []),
    ];
    if (linkLines.length === 0) continue;
    const appended = appendNoteSectionLines(current, merge.targetNodeId, linkLines);
    if (appended.appended) current = appended.markdown;
  }
  return current;
}

/**
 * 只重写笔记正文（**不碰 JSON 代码块**）：先删后补纪要段落 + 迁移遗留 `links[]` + frontmatter 摘要。
 *
 * 侧车模式（v0.7 §⑧）的写回入口：JSON 在 `_wfjson/…/*.wf.json` 里，笔记里只留内容。
 * 顺序与 `writeBackDocument` 的 1~4 步完全一致（合并 → 删除 → 补段 → 迁移），因此旧段落/超链接不会丢。
 */
export function writeBackNote(
  markdown: string,
  document: WfJsonDocument,
  options: WriteBackOptions = {},
): WriteNoteBackResult {
  const now = options.now ?? new Date();
  const migrateLinks = options.migrateLinks !== false;
  const migrated = migrateLinks
    ? migrateLinksToNoteSections(markdown, document)
    : { markdown, migratedNodeIds: [] as string[] };
  const merged = mergeNoteSectionLinks(migrated.markdown, options.mergeNoteSections ?? []);
  const removed = removeNoteSections(merged, options.removedNoteAnchors ?? []);
  const sections = ensureNoteSections(removed.markdown, document, options);
  const late = migrateLinks
    ? migrateLinksToNoteSections(sections.markdown, document)
    : { markdown: sections.markdown, migratedNodeIds: [] as string[] };
  const frontmatter = upsertFrontmatterSummary(late.markdown, document, now);
  return {
    markdown: frontmatter.markdown,
    frontmatter: frontmatter.action,
    addedAnchors: sections.added,
    removedAnchors: removed.removed,
    migratedLinkNodeIds: [...migrated.migratedNodeIds, ...late.migratedNodeIds],
  };
}

/**
 * 写回（笔记模式）：`writeBackNote` 的全部步骤 + 最后把 JSON 写回代码块。
 *
 * 步骤与顺序固定（每一步都为了不丢数据 / 保持幂等）：
 *  1. 先把遗留 `links[]` 迁进正文（旧段落先补标志），删节点时「合并进上级条目」才有内容可搬；
 *  2. 合并必须在删除之前（源段落这时还在）；
 *  3. 先删掉已消失节点的段落，再按 JSON 补齐缺失段落，因此删父节点时被连带吃掉的子节点段落会被自动补回来；
 *  4. 补出来的新段落再迁一次 `links[]`（首写时节点没有任何段落，第一次迁移会跳过）——
 *     否则代码块已落盘 `links`、下次写回又迁一遍，会产生重复超链接；
 *  5. 最后才写代码块 / 摘要（此时内存文档里的 `links` 已清空，落盘的 JSON 自然不再含它）。
 */
export function writeBackDocument(
  markdown: string,
  document: WfJsonDocument,
  options: WriteBackOptions = {},
): WriteBackResult {
  const note = writeBackNote(markdown, document, options);
  const block = upsertWfJsonBlock(note.markdown, document, options);
  return {
    markdown: block.markdown,
    action: block.action,
    frontmatter: note.frontmatter,
    addedAnchors: note.addedAnchors,
    removedAnchors: note.removedAnchors,
    migratedLinkNodeIds: note.migratedLinkNodeIds,
  };
}

