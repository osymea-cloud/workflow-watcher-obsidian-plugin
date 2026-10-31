/**
 * Markdown 词法扫描（不依赖 obsidian 的解析器）：
 *  - 行切分与偏移；
 *  - 围栏代码块识别（``` / ~~~），用于定位 wfjson 代码块 & 跳过块内文本；
 *  - 正文 block 锚点（^nd-xxx）索引，用于 noteAnchor 一致性检查。
 */

import { parseFrontmatter, type FrontmatterInfo } from "./frontmatter.ts";
import { WFJSON_LANG } from "./types.ts";
import { ANCHOR_MARK, ANCHOR_PATTERN } from "./ids.ts";

export interface LineInfo {
  /** 1 基行号 */
  number: number;
  /** 行文本（已去掉结尾的 \r） */
  text: string;
  /** 行首在原文中的偏移 */
  start: number;
  /** 行尾（含换行符）在原文中的偏移 */
  end: number;
}

/** 按 \n 切分，保留每行的原文偏移（便于写回时精确替换） */
export function splitLines(markdown: string): LineInfo[] {
  const lines: LineInfo[] = [];
  let cursor = 0;
  let number = 1;
  for (;;) {
    const newline = markdown.indexOf("\n", cursor);
    const lineEnd = newline === -1 ? markdown.length : newline;
    let text = markdown.slice(cursor, lineEnd);
    if (text.endsWith("\r")) text = text.slice(0, -1);
    lines.push({ number, text, start: cursor, end: newline === -1 ? markdown.length : newline + 1 });
    if (newline === -1) break;
    cursor = newline + 1;
    number += 1;
  }
  return lines;
}

const FENCE_OPEN_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)[ \t]*(.*)$/;
const FENCE_CLOSE_RE = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;

export interface CodeFence {
  /** 语言标签（小写），如 wfjson */
  lang: string;
  /** 语言标签之后的信息串 */
  info: string;
  /** 起始围栏标记（``` 或 ~~~，可能长于 3 个字符） */
  marker: string;
  /** 起始围栏所在行（1 基） */
  startLine: number;
  /** 结束围栏所在行；未闭合时等于最后一行行号 */
  endLine: number;
  /** 内容首行（1 基） */
  contentStartLine: number;
  /** 内容末行（1 基）；空内容时可能小于 contentStartLine */
  contentEndLine: number;
  /** 内容文本（不含围栏与行尾换行） */
  content: string;
  closed: boolean;
}

/** 扫描所有围栏代码块（跳过 frontmatter 区域） */
export function findCodeFences(markdown: string, frontmatter?: FrontmatterInfo): CodeFence[] {
  const info = frontmatter ?? parseFrontmatter(markdown);
  const lines = splitLines(markdown);
  const fences: CodeFence[] = [];
  let current: { marker: string; lang: string; info: string; startLine: number } | null = null;

  for (const line of lines) {
    if (info.present && line.number >= info.startLine && line.number <= info.endLine) continue;
    if (current === null) {
      const match = FENCE_OPEN_RE.exec(line.text);
      if (!match) continue;
      const marker = match[1];
      current = {
        marker,
        lang: (match[2] ?? "").toLowerCase(),
        info: match[3] ?? "",
        startLine: line.number,
      };
      continue;
    }
    const closeMatch = FENCE_CLOSE_RE.exec(line.text);
    if (closeMatch && closeMatch[1][0] === current.marker[0] && closeMatch[1].length >= current.marker.length) {
      const contentStartLine = current.startLine + 1;
      const contentEndLine = line.number - 1;
      fences.push({
        lang: current.lang,
        info: current.info,
        marker: current.marker,
        startLine: current.startLine,
        endLine: line.number,
        contentStartLine,
        contentEndLine,
        content: sliceLines(lines, contentStartLine, contentEndLine),
        closed: true,
      });
      current = null;
    }
  }

  if (current !== null) {
    const lastLine = lines.length > 0 ? lines[lines.length - 1].number : current.startLine;
    const contentStartLine = current.startLine + 1;
    fences.push({
      lang: current.lang,
      info: current.info,
      marker: current.marker,
      startLine: current.startLine,
      endLine: lastLine,
      contentStartLine,
      contentEndLine: lastLine,
      content: sliceLines(lines, contentStartLine, lastLine),
      closed: false,
    });
  }

  return fences;
}

/** 取 [fromLine, toLine]（1 基，闭区间）的原文；越界时返回空串 */
function sliceLines(lines: readonly LineInfo[], fromLine: number, toLine: number): string {
  if (toLine < fromLine) return "";
  if (!lines[fromLine - 1] || !lines[toLine - 1]) return "";
  return lines
    .slice(fromLine - 1, toLine)
    .map((line) => line.text)
    .join("\n");
}

/** 所有 wfjson 代码块（决策 5：正常应只有一个） */
export function findWfJsonBlocks(markdown: string, frontmatter?: FrontmatterInfo): CodeFence[] {
  return findCodeFences(markdown, frontmatter).filter((fence) => fence.lang === WFJSON_LANG);
}

/** 廉价预判：文本中是否可能出现 wfjson 代码块（用于跳过无关文件） */
export const WFJSON_FENCE_HINT_RE = /^ {0,3}(?:`{3,}|~{3,})[ \t]*wfjson\b/im;

export function mayContainWfJsonBlock(markdown: string): boolean {
  return WFJSON_FENCE_HINT_RE.test(markdown);
}

/** 用新内容替换代码块内容（保留两侧围栏与原文其它部分，换行风格沿用原文） */
export function replaceBlockContent(markdown: string, fence: CodeFence, content: string): string {
  const lines = splitLines(markdown);
  const header = lines[fence.contentStartLine - 1];
  const offset = header ? header.start : markdown.length;
  const closerIndex = fence.closed ? fence.endLine - 1 : lines.length;
  const closer = lines[closerIndex];
  const tail = closer ? markdown.slice(closer.start) : "";
  const newline = markdown.includes("\r\n") ? "\r\n" : "\n";
  const body = content.replace(/\r?\n/g, newline);
  const normalized = body.endsWith(newline) ? body : body + newline;
  return markdown.slice(0, offset) + normalized + tail;
}

/* ------------------------------------------------------------------ *
 * 正文 block 锚点（^nd-xxx）扫描
 * ------------------------------------------------------------------ */

export interface BlockHeadingRef {
  /** 标题层级（1-6） */
  level: number;
  /** 标题文本（不含锚点） */
  text: string;
}

export interface BlockAnchorRef {
  /** 完整锚点（含 ^），如 ^nd-uuid-001 */
  anchor: string;
  /** 锚点正文（不含 ^），如 nd-uuid-001 */
  id: string;
  /** 所在行号（1 基） */
  line: number;
  /** 该行原文 */
  raw: string;
  /** 若锚点挂在标题行上，则记录标题信息 */
  heading?: BlockHeadingRef;
}

const HEADING_RE = /^(#{1,6})[ \t]+(.*)$/;
const TRAILING_ANCHOR_RE = /^(.*?)(^|[ \t])\^([A-Za-z0-9_-]+)[ \t]*$/;

/**
 * 扫描正文中所有 block 锚点。
 * 跳过 frontmatter 与围栏代码块（wfjson 块内的内容不会被当成锚点）。
 */
export function findBlockAnchors(markdown: string, frontmatter?: FrontmatterInfo): BlockAnchorRef[] {
  const info = frontmatter ?? parseFrontmatter(markdown);
  const lines = splitLines(markdown);
  const fences = findCodeFences(markdown, info);
  const inFence = new Set<number>();
  for (const fence of fences) {
    for (let line = fence.startLine; line <= fence.endLine; line += 1) inFence.add(line);
  }

  const refs: BlockAnchorRef[] = [];
  for (const line of lines) {
    if (info.present && line.number >= info.startLine && line.number <= info.endLine) continue;
    if (inFence.has(line.number)) continue;
    const match = TRAILING_ANCHOR_RE.exec(line.text);
    if (!match) continue;
    const id = match[3];
    if (!ANCHOR_PATTERN.test(id)) continue;
    const before = match[1] ?? "";
    const ref: BlockAnchorRef = {
      anchor: ANCHOR_MARK + id,
      id,
      line: line.number,
      raw: line.text,
    };
    const headingMatch = HEADING_RE.exec(before.trim());
    if (headingMatch) {
      ref.heading = { level: headingMatch[1].length, text: (headingMatch[2] ?? "").trim() };
    }
    refs.push(ref);
  }
  return refs;
}

/** 锚点 → 出现位置列表（同一锚点出现多次即为错误，由一致性层报出） */
export function indexBlockAnchors(refs: readonly BlockAnchorRef[]): Map<string, BlockAnchorRef[]> {
  const index = new Map<string, BlockAnchorRef[]>();
  for (const ref of refs) {
    const bucket = index.get(ref.anchor);
    if (bucket) bucket.push(ref);
    else index.set(ref.anchor, [ref]);
  }
  return index;
}

/** 便于上层使用的别名 */
export type MarkdownAnchors = Map<string, BlockAnchorRef[]>;

/** 把锚点转义成可安全嵌入正则的字面量（供上层查找原始锚点文本） */
export function escapeBlockAnchorRegExp(anchor: string): string {
  return anchor.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
