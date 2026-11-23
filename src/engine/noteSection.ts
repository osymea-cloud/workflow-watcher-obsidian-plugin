/**
 * 正文纪要段（Phase 9）：**超链接的唯一来源**。
 *
 * 契约：`doc/datacontact/phase9_link.md`《实现计划：正文超链接管理区（links[] 废弃）》
 *   - `links[]` 走已有 deprecate 范式：Schema 保留、读时忽略、新数据不再产生；
 *   - 每个节点的纪要段用「开始 / 结束标志对」圈出机器边界（HTML 注释，阅读视图不可见）；
 *   - 跳转锚点 `^nd-xxx` 仍留在标题行（Obsidian block 导航照旧可用）。
 *
 * 格式（定稿）：
 * ```markdown
 * ### 采集竞品截图 ^nd-uuid-001
 * <!-- wf-note:begin:nd-uuid-001 -->
 * - [竞品分析报告](https://example.com)
 * - [[访谈录音整理]]
 * <!-- wf-note:end:nd-uuid-001 -->
 * ```
 *
 * 为什么用 HTML 注释：阅读视图不可见、机器好扫、不会和 `findBlockAnchors`
 * （扫行尾 `^...`）冲突。
 *
 * 本文件是纯函数 + 零 Obsidian 依赖，`node --test` 可直接跑。
 */

import { parseFrontmatter, type FrontmatterInfo } from "./frontmatter.ts";
import { LANGS, issueMsg, tIn } from "./i18n.ts";
import { anchorForNode, anchorToTarget } from "./ids.ts";
import { findBlockAnchors, findCodeFences, splitLines } from "./markdownScan.ts";
import { IMAGE_EXTENSIONS, type LinkType, type WfJsonDocument, type WfLink, type WfNode } from "./types.ts";

/* ------------------------------------------------------------------ *
 * 常量与类型
 * ------------------------------------------------------------------ */

/** 纪要段落默认标题层级（形如 `### 标题 ^nd-xxx`） */
export const NOTE_HEADING_LEVEL = 3;

/**
 * 新建节点时写入正文的占位文本（中文写法）。
 *
 * 取自字典 `template.notePlaceholder` 的 zh 值 —— 模板命令写进去的占位符与引擎判断的
 * 占位符必须是同一串文字，集中在一处才不会漂移。
 */
export const NOTE_PLACEHOLDER: string = tIn("zh", "template.notePlaceholder");

/**
 * 占位符的**全部语言写法**（zh / en）。
 *
 * 判断「这段正文只是占位符」不能只看当前语言：中文环境下插入的模板（或建出的节点），
 * 用户切到英文后那段文字仍然是占位符，若只认当前语言就会被当成真实内容（归档会复制它、
 * 追加超链接时也不会先丢掉它）。
 */
const NOTE_PLACEHOLDERS: readonly string[] = LANGS.map((lang) => tIn(lang, "template.notePlaceholder"));

/** 这段文字是否只是一句占位符（中英两种写法都算；空串不算） */
export function isNotePlaceholder(text: string): boolean {
  return NOTE_PLACEHOLDERS.includes(text.trim());
}

/** 开始 / 结束标志的前缀（导出给上层做提示文案与测试断言） */
export const NOTE_BEGIN_PREFIX = "<!-- wf-note:begin:";
export const NOTE_END_PREFIX = "<!-- wf-note:end:";

const NOTE_BEGIN_RE = /^[ \t]*<!--[ \t]*wf-note:begin:([A-Za-z0-9_-]+)[ \t]*-->[ \t]*$/;
const NOTE_END_RE = /^[ \t]*<!--[ \t]*wf-note:end:([A-Za-z0-9_-]+)[ \t]*-->[ \t]*$/;
const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;

/** 一个成对的纪要段（begin … end） */
export interface NoteSection {
  /** 标志里的节点 id（= `noteAnchor` 去掉 `^`） */
  nodeId: string;
  /** 标题行（1 基；-1 = 开始标志上方没有带该锚点的标题行） */
  headingLine: number;
  /** 开始标志行（1 基） */
  beginLine: number;
  /** 结束标志行（1 基） */
  endLine: number;
  /** 两标志之间的内容（不含标志本身） */
  content: string;
  /** 内容首行（1 基） */
  contentStartLine: number;
  /** 内容末行（1 基）；空内容时 < contentStartLine */
  contentEndLine: number;
  /** 标题层级（没有标题行时为 `NOTE_HEADING_LEVEL`） */
  level: number;
}

/** 标志扫描出的结构问题（一致性层转成 `NOTE_SECTION_*` 问题码） */
export interface NoteMarkerProblem {
  kind: "unpaired-begin" | "unpaired-end" | "nested" | "mismatch";
  /** 出问题的节点 id（mismatch 时是结束标志里的那个） */
  nodeId: string;
  /** 行号（1 基） */
  line: number;
  /** 可直接展示的中文说明 */
  message: string;
}

/** 正文里解析出的一条超链接（视图右键菜单 / 卡片实线边框的数据源） */
export interface ParsedNoteLink {
  /** 展示文字（md 链接的文字 / wiki 别名 / URL 本身） */
  label: string;
  /** 裸目标（URL / 笔记名 / 文件路径） */
  target: string;
  /** 由语法推断：`http→web`、`![[` / 图片扩展名 → image、其余 → md */
  type: LinkType;
  /** 原始 markdown 片段（便于调试） */
  raw: string;
}

export interface NoteSectionRenderOptions {
  /** 标题层级（默认 3 → ###） */
  level?: number;
  /** 占位正文（默认「（纪要待补充）」） */
  placeholder?: string;
  /** 段落内容（给了就不再写占位符） */
  content?: string;
}

/* ------------------------------------------------------------------ *
 * 标志文本
 * ------------------------------------------------------------------ */

/** `<!-- wf-note:begin:<nodeId> -->` */
export function noteBeginMarker(nodeId: string): string {
  return `${NOTE_BEGIN_PREFIX}${nodeId} -->`;
}

/** `<!-- wf-note:end:<nodeId> -->` */
export function noteEndMarker(nodeId: string): string {
  return `${NOTE_END_PREFIX}${nodeId} -->`;
}

/** 把锚点 / id / 节点统一收成「不带 ^ 的节点 id」 */
export function noteIdOf(value: string): string {
  return value.startsWith("^") ? anchorToTarget(value) : value;
}

/* ------------------------------------------------------------------ *
 * 扫描：成对段落 + 结构问题
 * ------------------------------------------------------------------ */

function newlineOf(markdown: string): string {
  return markdown.includes("\r\n") ? "\r\n" : "\n";
}

/** 跳过 frontmatter 与围栏代码块的行号集合（1 基） */
function skippedLines(markdown: string, info: FrontmatterInfo): Set<number> {
  const skipped = new Set<number>();
  if (info.present) {
    for (let line = info.startLine; line <= info.endLine; line += 1) skipped.add(line);
  }
  for (const fence of findCodeFences(markdown, info)) {
    for (let line = fence.startLine; line <= fence.endLine; line += 1) skipped.add(line);
  }
  return skipped;
}

/**
 * 扫描全部成对的纪要段（跳过 frontmatter 与围栏代码块）。
 *
 * 不配对 / 嵌套 / id 不匹配的段落**不会被当成段落**（它们由 `checkNoteMarkers` 报告），
 * 这样后续的读取 / 替换永远只会碰结构完整的段。
 */
export function findNoteSections(markdown: string, frontmatter?: FrontmatterInfo): NoteSection[] {
  const info = frontmatter ?? parseFrontmatter(markdown);
  const lines = splitLines(markdown);
  const skipped = skippedLines(markdown, info);
  const sections: NoteSection[] = [];
  let open: { nodeId: string; beginLine: number } | null = null;
  let nested = false;

  for (const line of lines) {
    if (skipped.has(line.number)) continue;
    const begin = NOTE_BEGIN_RE.exec(line.text);
    if (begin !== null) {
      // 嵌套 = 结构已损坏：整份文件的段落都不可信（一致性层会报 NOTE_SECTION_NESTED）
      if (open !== null) nested = true;
      open = { nodeId: begin[1] ?? "", beginLine: line.number };
      continue;
    }
    const end = NOTE_END_RE.exec(line.text);
    if (end === null) continue;
    const nodeId = end[1] ?? "";
    if (open === null || open.nodeId !== nodeId) {
      open = null;
      continue;
    }
    const heading = findHeadingAbove(lines, skipped, open.beginLine, nodeId);
    sections.push({
      nodeId,
      headingLine: heading.line,
      beginLine: open.beginLine,
      endLine: line.number,
      contentStartLine: open.beginLine + 1,
      contentEndLine: line.number - 1,
      content: sliceContent(lines, open.beginLine + 1, line.number - 1),
      level: heading.level,
    });
    open = null;
  }
  return nested ? [] : sections;
}

/** 从开始标志往上找「带该锚点的标题行」（中间允许空行） */
function findHeadingAbove(
  lines: readonly { number: number; text: string }[],
  skipped: ReadonlySet<number>,
  beginLine: number,
  nodeId: string,
): { line: number; level: number } {
  for (let index = beginLine - 2; index >= 0; index -= 1) {
    const line = lines[index];
    if (line === undefined) break;
    if (skipped.has(line.number)) break;
    if (line.text.trim().length === 0) continue;
    const heading = HEADING_RE.exec(line.text);
    if (heading !== null && line.text.trimEnd().endsWith(`^${nodeId}`)) {
      return { line: line.number, level: heading[1].length };
    }
    break;
  }
  return { line: -1, level: NOTE_HEADING_LEVEL };
}

function sliceContent(lines: readonly { text: string }[], startLine: number, endLine: number): string {
  if (endLine < startLine) return "";
  return lines
    .slice(startLine - 1, endLine)
    .map((line) => line.text)
    .join("\n");
}

/**
 * 结构问题：标志缺失配对 / 嵌套 / 结束标志无对应开始 / id 不匹配。
 * 返回顺序按行号；一致性层据此报 `NOTE_SECTION_UNPAIRED` / `NOTE_SECTION_NESTED` / `NOTE_SECTION_ID_MISMATCH`。
 */
export function checkNoteMarkers(markdown: string, frontmatter?: FrontmatterInfo): NoteMarkerProblem[] {
  const info = frontmatter ?? parseFrontmatter(markdown);
  const lines = splitLines(markdown);
  const skipped = skippedLines(markdown, info);
  const problems: NoteMarkerProblem[] = [];
  let open: { nodeId: string; beginLine: number } | null = null;

  for (const line of lines) {
    if (skipped.has(line.number)) continue;
    const begin = NOTE_BEGIN_RE.exec(line.text);
    if (begin !== null) {
      const nodeId = begin[1] ?? "";
      if (open !== null) {
        problems.push({
          kind: "nested",
          nodeId,
          line: line.number,
          message: issueMsg(
            "noteMarkerNested",
            `「wf-note:begin:${nodeId}」嵌套在第 ${open.beginLine} 行开始的段落（${open.nodeId}）里；请先补上它的结束标志`,
            { id: nodeId, line: open.beginLine, parent: open.nodeId },
          ),
        });
      }
      open = { nodeId, beginLine: line.number };
      continue;
    }
    const end = NOTE_END_RE.exec(line.text);
    if (end === null) continue;
    const nodeId = end[1] ?? "";
    if (open === null) {
      problems.push({
        kind: "unpaired-end",
        nodeId,
        line: line.number,
        message: issueMsg("noteMarkerUnpairedEnd", `结束标志「wf-note:end:${nodeId}」没有对应的开始标志`, {
            id: nodeId,
          }),
      });
      continue;
    }
    if (open.nodeId !== nodeId) {
      problems.push({
        kind: "mismatch",
        nodeId,
        line: line.number,
        message: issueMsg(
            "noteMarkerMismatch",
            `结束标志是「${nodeId}」，但第 ${open.beginLine} 行的开始标志是「${open.nodeId}」`,
            { id: nodeId, line: open.beginLine, parent: open.nodeId },
          ),
      });
      continue;
    }
    open = null;
  }

  if (open !== null) {
    problems.push({
      kind: "unpaired-begin",
      nodeId: open.nodeId,
      line: open.beginLine,
      message: issueMsg(
        "noteMarkerUnpairedBegin",
        `开始标志「wf-note:begin:${open.nodeId}」到文件末尾都没有结束标志`,
        { id: open.nodeId },
      ),
    });
  }
  return problems;
}

/* ------------------------------------------------------------------ *
 * 超链接解析
 * ------------------------------------------------------------------ */

const MD_LINK_RE = /(!?)\[([^\]]*)\]\(([^)\s]+)(?:[ \t]+"[^"]*")?\)/g;
const WIKI_LINK_RE = /(!?)\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
const BARE_URL_RE = /https?:\/\/[^\s<>()\]]+/g;

/** 由语法推断链接类型（契约：http→web、`![[` / 图片扩展名 → image、其余 → md） */
export function inferNoteLinkType(target: string, embed = false): LinkType {
  if (/^https?:\/\//i.test(target)) return "web";
  if (embed) return "image";
  const lower = target.toLowerCase();
  if (IMAGE_EXTENSIONS.some((ext) => lower.endsWith(ext))) return "image";
  return "md";
}

/**
 * 从一个纪要段的内容里解析超链接（每行可有多条；按出现顺序、按原文去重）。
 * 支持：`[文字](目标)`、`![文字](图片)`、`[[笔记]]`、`[[笔记|别名]]`、`![[图片]]`、裸 URL。
 */
export function extractNoteLinks(content: string): ParsedNoteLink[] {
  const links: ParsedNoteLink[] = [];
  const seen = new Set<string>();
  const push = (link: ParsedNoteLink): void => {
    if (seen.has(link.raw)) return;
    seen.add(link.raw);
    links.push(link);
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.length === 0) continue;

    let matched = false;
    for (const match of line.matchAll(WIKI_LINK_RE)) {
      const embed = match[1] === "!";
      const target = (match[2] ?? "").trim();
      if (target.length === 0) continue;
      const alias = (match[3] ?? "").trim();
      push({
        label: alias.length > 0 ? alias : target,
        target,
        type: inferNoteLinkType(target, embed),
        raw: match[0],
      });
      matched = true;
    }
    for (const match of line.matchAll(MD_LINK_RE)) {
      const embed = match[1] === "!";
      const target = (match[3] ?? "").trim();
      if (target.length === 0) continue;
      const text = (match[2] ?? "").trim();
      push({
        label: text.length > 0 ? text : target,
        target,
        type: inferNoteLinkType(target, embed),
        raw: match[0],
      });
      matched = true;
    }
    if (matched) continue;

    for (const match of line.matchAll(BARE_URL_RE)) {
      const target = match[0];
      push({ label: target, target, type: "web", raw: target });
    }
  }
  return links;
}

/**
 * 一条旧 `links[]` → 正文 markdown 行（迁移 / 删节点合并共用）。
 *
 * 与 `extractNoteLinks` 的语法一一对应：web / file → `[label](target)`、
 * image → `![[target]]`、md → `[[target]]`（label 与 target 不同时用 `[[target|label]]`）。
 */
export function renderNoteLinkLine(link: Pick<WfLink, "type" | "target" | "label">): string {
  const label = link.label ?? link.target;
  if (link.type === "web" || link.type === "file") return `- [${label}](${link.target})`;
  if (link.type === "image") return `- ![[${link.target}]]`;
  return label === link.target ? `- [[${link.target}]]` : `- [[${link.target}|${label}]]`;
}

/* ------------------------------------------------------------------ *
 * 读 / 写段落内容
 * ------------------------------------------------------------------ */

/** 取某个节点纪要段的内容（按 id / 锚点定位；没有成对标志时返回 undefined） */
export function getNoteSectionContent(markdown: string, nodeIdOrAnchor: string): string | undefined {
  const nodeId = noteIdOf(nodeIdOrAnchor);
  const section = findNoteSections(markdown).find((item) => item.nodeId === nodeId);
  return section?.content;
}

export interface ReplaceNoteSectionResult {
  markdown: string;
  /** 是否找到了成对的标志段（false 时 markdown 原样返回） */
  found: boolean;
}

/**
 * 替换某个节点纪要段的内容（保留标题行与两侧标志）。
 *
 * 内容按原文换行风格写入；空内容写成一行空行（保持「标志之间至少一行」，
 * 避免 `begin` / `end` 相邻被误读）。
 */
export function replaceNoteSectionContent(
  markdown: string,
  nodeIdOrAnchor: string,
  content: string,
): ReplaceNoteSectionResult {
  const nodeId = noteIdOf(nodeIdOrAnchor);
  const section = findNoteSections(markdown).find((item) => item.nodeId === nodeId);
  if (section === undefined) return { markdown, found: false };

  const newline = newlineOf(markdown);
  const lines = splitLines(markdown).map((line) => line.text);
  const normalized = content.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const body = normalized.length > 0 ? normalized.split("\n") : [""];
  const before = lines.slice(0, section.beginLine);
  const after = lines.slice(section.endLine - 1);
  return { markdown: [...before, ...body, ...after].join(newline), found: true };
}

export interface AppendNoteSectionLinesResult {
  markdown: string;
  /** 是否写进了目标段（false = 目标段没有成对标志） */
  appended: boolean;
}

/** 把若干行追加到目标节点纪要段的末尾（删除节点时「超链接合并进上级条目」用） */
export function appendNoteSectionLines(
  markdown: string,
  nodeIdOrAnchor: string,
  linesToAdd: readonly string[],
): AppendNoteSectionLinesResult {
  const nodeId = noteIdOf(nodeIdOrAnchor);
  const section = findNoteSections(markdown).find((item) => item.nodeId === nodeId);
  const cleaned = linesToAdd.map((line) => line.trimEnd()).filter((line) => line.trim().length > 0);
  if (section === undefined || cleaned.length === 0) return { markdown, appended: false };

  const newline = newlineOf(markdown);
  const lines = splitLines(markdown).map((line) => line.text);
  const existing = section.content.length > 0 ? section.content.split("\n") : [];
  // 占位文本不算内容：追加前先丢掉占位符（中英两种写法都丢）
  const kept = existing.filter((line) => line.trim().length > 0 && !isNotePlaceholder(line));
  const body = [...kept, ...cleaned];
  const before = lines.slice(0, section.beginLine);
  const after = lines.slice(section.endLine - 1);
  return { markdown: [...before, ...body, ...after].join(newline), appended: true };
}

/* ------------------------------------------------------------------ *
 * 生成段落（带标志）
 * ------------------------------------------------------------------ */

function clampLevel(level: number | undefined): number {
  return Math.min(Math.max(level ?? NOTE_HEADING_LEVEL, 1), 6);
}

/** 生成一个节点的纪要段（标题 + 开始标志 + 内容 / 占位 + 结束标志），不含前后空行 */
export function renderNoteSection(node: WfNode, options: NoteSectionRenderOptions = {}): string {
  const anchor = node.noteAnchor ?? anchorForNode(node.id);
  const nodeId = noteIdOf(anchor);
  const level = "#".repeat(clampLevel(options.level));
  const placeholder = options.placeholder ?? NOTE_PLACEHOLDER;
  const content = options.content?.replace(/\r\n/g, "\n").replace(/\n+$/, "") ?? "";
  const body = content.length > 0 ? content.split("\n") : [placeholder];
  return [`${level} ${node.title} ${anchor}`, noteBeginMarker(nodeId), ...body, noteEndMarker(nodeId)].join("\n");
}

/* ------------------------------------------------------------------ *
 * 兼容旧文件：把「标题边界」段落补上标志（幂等）
 * ------------------------------------------------------------------ */

export interface WrapNoteSectionsResult {
  markdown: string;
  /** 本次补了标志的节点 id（按出现顺序） */
  wrapped: string[];
}

/** 文档内全部节点 id（含根） */
function collectNodeIds(document: WfJsonDocument): Set<string> {
  const ids = new Set<string>();
  const walk = (node: WfNode): void => {
    ids.add(node.id);
    for (const child of node.children ?? []) walk(child);
  };
  for (const workflow of document.workflows) walk(workflow.root);
  return ids;
}

/**
 * 给旧格式（只有 `### 标题 ^nd-x`，没有标志）的纪要段补上开始 / 结束标志。
 *
 * 段落边界：从标题行的下一行，到「下一个带 block 锚点的标题」或「层级 ≤ 本标题层级」的标题之前。
 * 前者保证父子节点的标志对永远顺序排列（不嵌套），后者保证不吞掉父级内容。
 * 已经有成对标志的段落一律不动（幂等）。
 *
 * 注意：本函数**不落盘**，由调用方决定何时写回。
 */
export function wrapNoteSections(markdown: string, document: WfJsonDocument): WrapNoteSectionsResult {
  const info = parseFrontmatter(markdown);
  const anchors = findBlockAnchors(markdown, info);
  const existing = new Set(findNoteSections(markdown, info).map((section) => section.nodeId));
  const nodeIds = collectNodeIds(document);

  const lines = splitLines(markdown).map((line) => line.text);
  const newline = newlineOf(markdown);
  /** 带 block 锚点的标题行（任何节点的段落起点）——父段遇到它就必须收尾，避免标志对嵌套 */
  const anchoredHeadingLines = new Set(anchors.map((anchor) => anchor.line));
  /** 在 0 基下标 `index` 之前插入（= 原第 index+1 行之前；index = lines.length 表示文件末尾） */
  const begins = new Map<number, string[]>();
  const ends = new Map<number, { id: string; level: number }[]>();
  const wrapped: string[] = [];

  for (const anchor of anchors) {
    const id = anchor.id;
    if (!nodeIds.has(id) || existing.has(id)) continue;
    if (anchor.heading === undefined) continue;
    const start = anchor.line - 1;
    const level = anchor.heading.level;
    let end = lines.length - 1;
    for (let index = start + 1; index < lines.length; index += 1) {
      const next = HEADING_RE.exec(lines[index] ?? "");
      // 遇到「别的节点段落起点」或「层级 ≤ 本标题」就收尾：
      // 前者保证各节点的标志对永远顺序排列（不嵌套），后者保证不吞掉父级内容。
      if (next !== null && (anchoredHeadingLines.has(index + 1) || next[1].length <= level)) {
        end = index - 1;
        break;
      }
    }
    while (end > start && (lines[end] ?? "").trim().length === 0) end -= 1;

    // 同一插入点可能被多个段落共用（例如父段的 end 与子段的 end 都落在下个标题前）：
    // 用数组累计而不是 Map.set 覆盖，否则会丢掉外层段落的结束标志。
    const endAt = end + 1;
    // 开始标志贴在标题下一行的正文前（跳过紧跟标题的空行，内容首行不留空行）
    let beginAt = start + 1;
    while (beginAt < endAt && (lines[beginAt] ?? "").trim().length === 0) beginAt += 1;
    const beginList = begins.get(beginAt) ?? [];
    beginList.push(noteBeginMarker(id));
    begins.set(beginAt, beginList);

    const endList = ends.get(endAt) ?? [];
    endList.push({ id, level });
    // 同一行要收多个段落时：层级深的先收（内层 end 在前、外层 end 在后）
    endList.sort((a, b) => b.level - a.level);
    ends.set(endAt, endList);
    wrapped.push(id);
  }

  if (wrapped.length === 0) return { markdown, wrapped };

  const output: string[] = [];
  for (let index = 0; index <= lines.length; index += 1) {
    for (const marker of begins.get(index) ?? []) output.push(marker);
    for (const item of ends.get(index) ?? []) output.push(noteEndMarker(item.id));
    const line = lines[index];
    if (line !== undefined) output.push(line);
  }
  return { markdown: output.join(newline), wrapped };
}

/* ------------------------------------------------------------------ *
 * 汇总：节点 id → 正文超链接（视图右键菜单 / 卡片边框）
 * ------------------------------------------------------------------ */

/**
 * 收集每个节点的正文超链接。
 *
 * 数据源优先级：成对标志段 → 旧格式（标题边界）段落。
 * 只返回文档里真实存在的节点（旧段落残留不参与渲染）。
 */
export function collectNoteLinks(
  markdown: string,
  document: WfJsonDocument,
  frontmatter?: FrontmatterInfo,
): Map<string, ParsedNoteLink[]> {
  const map = new Map<string, ParsedNoteLink[]>();
  const nodeIds = collectNodeIds(document);

  for (const section of findNoteSections(markdown, frontmatter)) {
    if (!nodeIds.has(section.nodeId)) continue;
    map.set(section.nodeId, extractNoteLinks(section.content));
  }

  // 旧格式兜底：按标题边界取段落内容（与 wrapNoteSections 同一规则：遇到别的节点标题就收尾）
  const info = frontmatter ?? parseFrontmatter(markdown);
  const lines = splitLines(markdown).map((line) => line.text);
  const anchors = findBlockAnchors(markdown, info);
  const anchoredHeadingLines = new Set(anchors.map((anchor) => anchor.line));
  for (const anchor of anchors) {
    if (!nodeIds.has(anchor.id) || map.has(anchor.id)) continue;
    if (anchor.heading === undefined) continue;
    const start = anchor.line - 1;
    const level = anchor.heading.level;
    let end = lines.length - 1;
    for (let index = start + 1; index < lines.length; index += 1) {
      const next = HEADING_RE.exec(lines[index] ?? "");
      if (next !== null && (anchoredHeadingLines.has(index + 1) || next[1].length <= level)) {
        end = index - 1;
        break;
      }
    }
    map.set(anchor.id, extractNoteLinks(lines.slice(start + 1, end + 1).join("\n")));
  }
  return map;
}

/**
 * 收集每个节点的**正文纪要内容**（Phase 9 归档复制用：整段文字 + 超链接一起搬）。
 *
 * 数据源优先级与 `collectNoteLinks` 一致：成对标志段 → 旧格式（标题边界）段落。
 * 只返回文档里真实存在的节点；没有段落 / 段落为占位符时不出现在 Map 里。
 */
export function collectNoteSectionContents(
  markdown: string,
  document: WfJsonDocument,
  frontmatter?: FrontmatterInfo,
): Map<string, string> {
  const map = new Map<string, string>();
  const nodeIds = collectNodeIds(document);
  const seen = new Set<string>();
  const clean = (content: string): string => content.replace(/\r\n/g, "\n").replace(/\n+$/, "");
  const usable = (content: string): boolean => {
    const text = content.trim();
    return text.length > 0 && !isNotePlaceholder(text);
  };

  for (const section of findNoteSections(markdown, frontmatter)) {
    if (!nodeIds.has(section.nodeId)) continue;
    seen.add(section.nodeId);
    if (!usable(section.content)) continue;
    map.set(section.nodeId, clean(section.content));
  }

  const info = frontmatter ?? parseFrontmatter(markdown);
  const lines = splitLines(markdown).map((line) => line.text);
  const anchors = findBlockAnchors(markdown, info);
  const anchoredHeadingLines = new Set(anchors.map((anchor) => anchor.line));
  for (const anchor of anchors) {
    if (!nodeIds.has(anchor.id) || seen.has(anchor.id) || map.has(anchor.id)) continue;
    if (anchor.heading === undefined) continue;
    const start = anchor.line - 1;
    const level = anchor.heading.level;
    let end = lines.length - 1;
    for (let index = start + 1; index < lines.length; index += 1) {
      const next = HEADING_RE.exec(lines[index] ?? "");
      if (next !== null && (anchoredHeadingLines.has(index + 1) || next[1].length <= level)) {
        end = index - 1;
        break;
      }
    }
    const content = lines.slice(start + 1, end + 1).join("\n");
    if (usable(content)) map.set(anchor.id, clean(content));
  }
  return map;
}
