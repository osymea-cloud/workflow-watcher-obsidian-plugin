/**
 * wfjson 代码块的抽取与「严格 JSON」解析。
 *
 * 决策 1：wfjson 内必须是严格 JSON（零注释、零尾随逗号、无 BOM）。
 * 本模块先做一次廉价的严格性预扫描（精确到行列地报出注释与尾随逗号），
 * 预扫描发现问题时不再交给 JSON.parse（否则只会多出一条含糊的语法错误）。
 */

import { issueMsg, t } from "./i18n.ts";
import { issue, type WfIssue } from "./issues.ts";
import { parseFrontmatter, type FrontmatterInfo } from "./frontmatter.ts";
import { findWfJsonBlocks, type CodeFence } from "./markdownScan.ts";

export interface JsonBlockExtraction {
  frontmatter: FrontmatterInfo;
  /** 文件中所有 wfjson 代码块 */
  blocks: CodeFence[];
  /** 参与解析的代码块（第一个） */
  block?: CodeFence;
  issues: WfIssue[];
}

/** 定位 wfjson 代码块，并报出「多个块 / 未闭合 / 一个都没有」问题 */
export function extractWfJsonBlock(markdown: string, frontmatter?: FrontmatterInfo): JsonBlockExtraction {
  const info = frontmatter ?? parseFrontmatter(markdown);
  const blocks = findWfJsonBlocks(markdown, info);
  const issues: WfIssue[] = [];

  blocks.forEach((block, index) => {
    if (index > 0) {
      issues.push(
        issue(
          "MULTIPLE_WFJSON_BLOCKS",
          issueMsg(
            "multipleBlocks",
            `第 ${block.startLine} 行出现第 ${index + 1} 个 wfjson 代码块（本文件共 ${blocks.length} 个）`,
            { line: block.startLine, index: index + 1, total: blocks.length },
          ),
          { line: block.startLine, path: "/workflows" },
        ),
      );
    }
    if (!block.closed) {
      issues.push(
        issue("WFJSON_BLOCK_UNCLOSED", issueMsg("blockUnclosed", `第 ${block.startLine} 行开始的 wfjson 代码块缺少结束围栏`, {
            line: block.startLine,
          }), {
          line: block.startLine,
        }),
      );
    }
  });

  if (blocks.length === 0) {
    issues.push(
      issue("NO_WFJSON_BLOCK", issueMsg("noBlock", "未发现 ```wfjson 代码块"), {
        line: info.present ? info.endLine : 1,
      }),
    );
  }

  const result: JsonBlockExtraction = { frontmatter: info, blocks, issues };
  if (blocks.length > 0) result.block = blocks[0];
  return result;
}

/** 文本内偏移 → 行/列（1 基） */
export function lineColumnAt(text: string, offset: number): { line: number; column: number } {
  let line = 1;
  let lastBreak = -1;
  const limit = Math.min(Math.max(offset, 0), text.length);
  for (let i = 0; i < limit; i += 1) {
    if (text.charCodeAt(i) === 10) {
      line += 1;
      lastBreak = i;
    }
  }
  return { line, column: limit - lastBreak };
}

/** 取某行文本（1 基）；越界返回空串 */
export function textLineAt(text: string, line: number): string {
  return text.split("\n")[line - 1] ?? "";
}

export interface StrictJsonScan {
  /** 去掉 BOM 后的文本 */
  text: string;
  hadBom: boolean;
  issues: WfIssue[];
  /** 是否发现「必须先修掉」的语法问题（注释 / 尾随逗号） */
  hasBlockingError: boolean;
}

/**
 * 严格性预扫描：BOM、`//` 与块注释、尾随逗号。
 * 只做字符级判断（字符串字面量内部一律跳过），因此无需完整解析器。
 */
export function scanStrictJson(source: string, lineBase = 1): StrictJsonScan {
  const issues: WfIssue[] = [];
  let text = source;
  let hadBom = false;
  if (text.startsWith("\uFEFF")) {
    hadBom = true;
    text = text.slice(1);
    issues.push(issue("JSON_BOM", issueMsg("jsonBom", "wfjson 内容以 BOM 开头（已自动忽略）"), { line: lineBase }));
  }

  let inString = false;
  let escaped = false;
  let lastComma: { line: number; column: number } | null = null;
  let blocking = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      // 字符串字面量本身就是一个「值」：它前面的那个逗号是分隔符，不是尾随逗号。
      // 不在这里清掉的话，`["a", "b"]` 这种「最后一个元素是字符串」的数组会被误报。
      lastComma = null;
      continue;
    }
    if (char === "/" && (text[i + 1] === "/" || text[i + 1] === "*")) {
      const isBlock = text[i + 1] === "*";
      const at = lineColumnAt(text, i);
      let end = i + 2;
      if (isBlock) {
        const close = text.indexOf("*/", end);
        end = close === -1 ? text.length : close + 2;
      } else {
        const newline = text.indexOf("\n", end);
        end = newline === -1 ? text.length : newline;
      }
      const excerpt = text.slice(i, Math.min(end, i + 40)).replace(/\s+/g, " ").trim();
      issues.push(
        issue("JSON_COMMENT_NOT_ALLOWED", issueMsg(
          "commentNotAllowed",
          `${isBlock ? t("issue.commentKind.block") : t("issue.commentKind.line")}：${excerpt}`,
          { kind: isBlock ? t("issue.commentKind.block") : t("issue.commentKind.line"), excerpt },
        ), {
          line: lineBase + at.line - 1,
        }),
      );
      blocking = true;
      i = end - 1;
      continue;
    }
    if (char === ",") {
      const at = lineColumnAt(text, i);
      lastComma = { line: lineBase + at.line - 1, column: at.column };
      continue;
    }
    if (char === "}" || char === "]") {
      if (lastComma) {
        issues.push(
          issue("JSON_TRAILING_COMMA", issueMsg(
            "trailingComma",
            `第 ${lastComma.line} 行第 ${lastComma.column} 列的逗号之后直接是 “${char}”`,
            { line: lastComma.line, column: lastComma.column, char },
          ), {
            line: lastComma.line,
          }),
        );
        blocking = true;
        lastComma = null;
      }
      continue;
    }
    if (!/\s/.test(char)) lastComma = null;
  }

  return { text, hadBom, issues, hasBlockingError: blocking };
}

export interface JsonErrorLocation {
  offset?: number;
  /** 在 text 内的行号（1 基） */
  line?: number;
  column?: number;
}

/** 从 V8 的 JSON.parse 报错信息里抠出位置（各版本格式不同，尽力而为） */
export function locateJsonError(message: string): JsonErrorLocation {
  const positionMatch = /at position (\d+)/.exec(message);
  const lineMatch = /\(line (\d+) column (\d+)\)/.exec(message);
  const location: JsonErrorLocation = {};
  if (positionMatch) location.offset = Number(positionMatch[1]);
  if (lineMatch) {
    location.line = Number(lineMatch[1]);
    location.column = Number(lineMatch[2]);
  }
  return location;
}

export interface WfJsonParseResult {
  /** 是否发现 wfjson 代码块（外置 JSON 模式下由调用方置 true） */
  found: boolean;
  block?: CodeFence;
  /** 代码块内容原文（含可能的 BOM） */
  source: string;
  /** 去掉 BOM 后的内容 */
  text: string;
  /** 解析结果（仅语法完全正确时存在） */
  value?: unknown;
  /** 代码块内容第 1 行在文件中的行号（外置 JSON 模式为 1） */
  lineBase: number;
  issues: WfIssue[];
}

export interface WfJsonTextParseResult {
  /** 去掉 BOM 后的文本 */
  text: string;
  /** 解析结果（仅语法完全正确时存在） */
  value?: unknown;
  /** 文本第 1 行在所在文件中的行号（1 基） */
  lineBase: number;
  issues: WfIssue[];
}

/**
 * 严格 JSON 文本解析（不做 Schema 校验）。
 *
 * 与 `parseWfJsonBlock` 共用同一套严格性预扫描；区别只在于输入是「一段 JSON 文本」，
 * 因此外置 JSON（`_workflowwatcher/` 下的 `*.wf.json`）可以直接复用，行号以该文件为准（`lineBase = 1`）。
 */
export function parseWfJsonText(source: string, lineBase = 1): WfJsonTextParseResult {
  const result: WfJsonTextParseResult = { text: source, lineBase, issues: [] };
  const scan = scanStrictJson(source, lineBase);
  result.text = scan.text;
  result.issues.push(...scan.issues);
  if (scan.hasBlockingError) return result; // 已有精确到行列的报错，不再叠加含糊的语法错误

  if (scan.text.trim().length === 0) {
    result.issues.push(issue("JSON_PARSE_ERROR", issueMsg("emptyJson", "wfjson 内容为空"), { line: lineBase }));
    return result;
  }

  try {
    result.value = JSON.parse(scan.text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const location = locateJsonError(message);
    const at =
      location.line !== undefined
        ? { line: location.line, column: location.column }
        : location.offset !== undefined
          ? lineColumnAt(scan.text, location.offset)
          : undefined;
    const line = at ? lineBase + at.line - 1 : lineBase;
    const details: string[] = [message];
    if (at) {
      const sourceLine = textLineAt(scan.text, at.line);
      if (sourceLine.length > 0) {
        const shown = sourceLine.length > 120 ? `${sourceLine.slice(0, 120)}…` : sourceLine;
        details.push(t("issue.sourceLine", { text: shown }));
      }
    }
    result.issues.push(
      issue(
        "JSON_PARSE_ERROR",
        issueMsg(
          "parseError",
          `JSON 解析失败${at ? `（第 ${line} 行第 ${at.column ?? 1} 列附近）` : ""}`,
          { where: at ? t("issue.parseErrorWhere", { line, column: at.column ?? 1 }) : "" },
        ),
        { line, details },
      ),
    );
  }
  return result;
}

/** 抽取 wfjson 代码块并做严格 JSON 解析（不做 Schema 校验） */
export function parseWfJsonBlock(markdown: string, frontmatter?: FrontmatterInfo): WfJsonParseResult {
  const extraction = extractWfJsonBlock(markdown, frontmatter);
  const block = extraction.block;
  const result: WfJsonParseResult = {
    found: block !== undefined,
    lineBase: block ? block.contentStartLine : 1,
    source: block ? block.content : "",
    text: block ? block.content : "",
    issues: [...extraction.issues],
  };
  if (block) result.block = block;
  if (!block) return result;

  const parsed = parseWfJsonText(block.content, block.contentStartLine);
  result.text = parsed.text;
  result.issues.push(...parsed.issues);
  if (parsed.value !== undefined) result.value = parsed.value;
  return result;
}
