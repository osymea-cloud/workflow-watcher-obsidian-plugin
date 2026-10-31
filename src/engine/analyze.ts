/**
 * 分析入口（把「抽取 → 严格 JSON → Schema → 一致性」串起来）。
 *
 * 分层策略（不静默失败，但也不在坏数据上继续瞎跑）：
 *  1. 没有 wfjson 代码块 → 只报 NO_WFJSON_BLOCK（info），found=false；
 *  2. JSON 语法不合法 → 只报语法类问题，不做 Schema / 一致性检查；
 *  3. Schema 校验有 error → 报出字段级问题，跳过一致性检查（结构未定型，查一致性会误导）；
 *  4. 结构合法 → 再做一致性检查（noteAnchor ↔ 正文、id、状态、links、relations、frontmatter）。
 */

import { issueMsg, t } from "./i18n.ts";
import { countIssues, formatIssues, hasErrors, issue, sortIssues, type IssueCounts, type WfIssue } from "./issues.ts";
import {
  isNodeStatus,
  isPlainObject,
  SUPPORTED_SCHEMA_VERSIONS,
  type WfJsonDocument,
  type WfNode,
  type WfWorkflow,
} from "./types.ts";
import { WFJSON_SCHEMA } from "./wfjsonSchema.ts";
import { validateAgainstSchema, type JsonSchemaObject } from "./schemaValidator.ts";
import { parseWfJsonBlock, parseWfJsonText, type WfJsonParseResult } from "./wfjsonParse.ts";
import { parseFrontmatter, type FrontmatterInfo } from "./frontmatter.ts";
import { findBlockAnchors, findWfJsonBlocks, indexBlockAnchors } from "./markdownScan.ts";
import { collectNoteLinks, findNoteSections, type NoteSection, type ParsedNoteLink } from "./noteSection.ts";
import { checkConsistency } from "./consistency.ts";
import { upgradeDocument } from "./upgrade.ts";

export interface AnalyzeOptions {
  /** 文件路径（仅用于展示与报错信息） */
  file?: string;
  /** 是否执行一致性检查（默认 true） */
  consistency?: boolean;
  /** 是否在「没有 wfjson 代码块」时仍返回 info 级提示（默认 true） */
  reportMissing?: boolean;
}

/** JSON 来源（v0.7 §⑧）：笔记内代码块 or 外置 `_wfjson/…/*.wf.json` */
export type WfJsonSource = "note" | "sidecar";

/**
 * 分析一份「笔记 + JSON」输入（v0.7 §⑧ 复用的主入口）。
 *
 * 两种模式：
 *  - 笔记模式（默认）：JSON 从 `noteMarkdown` 里的 wfjson 代码块抽取（旧行为，完全兼容）；
 *  - 侧车模式：显式传入 `jsonText`（`_wfjson/` 下的外置 JSON），笔记内代码块**不参与解析**，
 *    正文锚点 / 纪要段 / frontmatter 仍从笔记读。`file` 保持笔记路径，`jsonFile` 记侧车路径。
 */
export interface AnalyzeDocumentInput extends AnalyzeOptions {
  /** 笔记正文：frontmatter、纪要段、block 锚点都从这里读 */
  noteMarkdown: string;
  /** 外置 JSON 文本；传入即侧车模式（空串会报 JSON_PARSE_ERROR，而不是悄悄回退到笔记） */
  jsonText?: string;
  /** 显式声明来源（默认按是否传入 `jsonText` 推断） */
  jsonSource?: WfJsonSource;
  /** 外置 JSON 文件路径（仅用于展示与提示） */
  jsonFile?: string;
}

export interface AnalyzeResult {
  file?: string;
  /** JSON 来源（v0.7 §⑧）：`note` = 笔记内代码块；`sidecar` = `_wfjson/…/*.wf.json` */
  jsonSource?: WfJsonSource;
  /** 外置 JSON 文件路径（侧车模式下有；`file` 始终是笔记路径） */
  jsonFile?: string;
  /** 是否发现 wfjson（侧车模式下文件存在即 true，内容坏不坏由 issues 报） */
  found: boolean;
  /** 解析层结果（代码块 / 原文 / JSON 值） */
  parse: WfJsonParseResult;
  /** 结构合法时的文档对象（**文件中实际的版本**，未经升格） */
  document?: WfJsonDocument;
  /**
   * 只读渲染用的文档：内存升格到最新版（`SCHEMA_VERSION`）之后的对象。
   * 文件本身已是最新版时与 `document` 同一引用；旧版（如 1.0）时是新对象——**不会落盘**。
   */
  latestDocument?: WfJsonDocument;
  /** 发生过内存升格时，记下原始的 schemaVersion（未升格时为 undefined） */
  upgradedFrom?: string;
  /** 实际使用的 schema（便于外部工具复用契约） */
  schema: JsonSchemaObject;
  /** frontmatter 解析结果（v1.6：视图从这里读 `wf-theme` 偏好） */
  frontmatter: FrontmatterInfo;
  /**
   * 每个节点的正文超链接（Phase 9：`links[]` 的唯一替代）。
   * 成对标志段优先，旧格式（标题边界）段落兜底；nodeId → 链接列表。
   */
  noteLinks: Map<string, ParsedNoteLink[]>;
  /** 正文里成对的纪要段（Phase 9；旧文件没有标志时是空数组） */
  noteSections: NoteSection[];
  /** 代码块内 JSON 的行号基准（内容第 1 行的文件行号） */
  lineBase: number;
  issues: WfIssue[];
  counts: IssueCounts;
  /** 是否存在 error 级问题 */
  hasError: boolean;
  /** 是否存在问题（含 warning / info） */
  hasIssue: boolean;
}

/** 只做 Schema 校验（含 schemaVersion 白名单检查） */
export function validateWfJsonValue(value: unknown): WfIssue[] {
  const issues = validateAgainstSchema(value, WFJSON_SCHEMA);
  const version = isPlainObject(value) ? value.schemaVersion : undefined;
  if (typeof version === "string" && !SUPPORTED_SCHEMA_VERSIONS.includes(version)) {
    issues.push(
      issue(
        "SCHEMA_VERSION_UNSUPPORTED",
        issueMsg(
          "schemaVersionUnsupported",
          `schemaVersion="${version}" 不在本插件支持的列表 [${SUPPORTED_SCHEMA_VERSIONS.join(", ")}] 内`,
          { version, list: SUPPORTED_SCHEMA_VERSIONS.join(", ") },
        ),
        { path: "/schemaVersion" },
      ),
    );
  }
  return issues;
}

/** 结构合法（Schema 通过）时把 JSON 值收窄成文档对象；否则返回 undefined */
export function coerceDocument(value: unknown): WfJsonDocument | undefined {
  if (!isPlainObject(value)) return undefined;
  if (typeof value.schemaVersion !== "string" || typeof value.id !== "string") return undefined;
  if (!Array.isArray(value.workflows)) return undefined;
  if (value.updatedAt !== undefined && typeof value.updatedAt !== "string") return undefined;
  if (!value.workflows.every((item) => isPlainObject(item) && typeof item.id === "string" && typeof item.title === "string" && isCoercibleNode(item.root))) {
    return undefined;
  }
  return value as unknown as WfJsonDocument;
}

function isCoercibleNode(value: unknown): value is WfNode {
  if (!isPlainObject(value)) return false;
  if (typeof value.id !== "string" || typeof value.title !== "string") return false;
  if (!isNodeStatus(value.status)) return false;
  const children = value.children;
  if (!Array.isArray(children)) return false;
  return children.every((child) => isCoercibleNode(child));
}

/** 文档内工作流标题列表（供上层提示） */
export function workflowTitles(document: WfJsonDocument): string[] {
  return document.workflows.map((workflow: WfWorkflow) => workflow.title);
}

/** 外置 JSON 文本 → 与代码块解析同形的结果（行号以侧车文件为准） */
function parseSidecarText(jsonText: string): WfJsonParseResult {
  const parsed = parseWfJsonText(jsonText, 1);
  const result: WfJsonParseResult = {
    found: true,
    source: jsonText,
    text: parsed.text,
    lineBase: parsed.lineBase,
    issues: parsed.issues,
  };
  if (parsed.value !== undefined) result.value = parsed.value;
  return result;
}

/** 主入口：分析「笔记 + JSON」（侧车模式见 `AnalyzeDocumentInput`） */
export function analyzeDocument(input: AnalyzeDocumentInput): AnalyzeResult {
  const markdown = input.noteMarkdown;
  const sidecarMode = input.jsonText !== undefined || input.jsonSource === "sidecar";
  const parse = sidecarMode ? parseSidecarText(input.jsonText ?? "") : parseWfJsonBlock(markdown);
  const frontmatter = parseFrontmatter(markdown);
  const issues: WfIssue[] = [];
  if (parse.issues.length > 0) {
    const filtered = input.reportMissing === false ? parse.issues.filter((item) => item.code !== "NO_WFJSON_BLOCK") : parse.issues;
    issues.push(...filtered);
  }

  // 侧车模式：笔记里残留的代码块不再生效（迁移未清理干净 / 手工复制过），给出可执行的提示
  if (sidecarMode) {
    const blocks = findWfJsonBlocks(markdown, frontmatter);
    if (blocks.length > 0) {
      const target =
        input.jsonFile !== undefined
          ? t("issue.blockIgnoredTarget", { path: input.jsonFile })
          : t("issue.blockIgnoredGeneric");
      issues.push(
        issue("WFJSON_BLOCK_IGNORED", issueMsg(
            "blockIgnored",
            `第 ${blocks[0].startLine} 行起的 wfjson 代码块已被忽略${target}`,
            { line: blocks[0].startLine, target },
          ), {
          line: blocks[0].startLine,
        }),
      );
    }
  }

  const result: AnalyzeResult = {
    found: parse.found,
    parse,
    schema: WFJSON_SCHEMA,
    frontmatter,
    lineBase: parse.lineBase,
    noteLinks: new Map(),
    noteSections: [],
    issues,
    counts: countIssues(issues),
    hasError: false,
    hasIssue: false,
    jsonSource: sidecarMode ? "sidecar" : "note",
  };
  if (input.file !== undefined) result.file = input.file;
  if (input.jsonFile !== undefined) result.jsonFile = input.jsonFile;

  // 语法未通过：不再往下走
  if (parse.value === undefined) return finalize(result);

  const schemaIssues = validateWfJsonValue(parse.value);
  issues.push(...schemaIssues);
  if (hasErrors(schemaIssues)) return finalize(result);

  const document = coerceDocument(parse.value);
  if (!document) return finalize(result);
  result.document = document;

  // 只读的内存升格（决策：解析绝不落盘；旧版仅在内存里补成最新版供渲染）
  const upgrade = upgradeDocument(document);
  result.latestDocument = upgrade.document;
  if (upgrade.upgraded) result.upgradedFrom = upgrade.from;

  if (input.consistency !== false) {
    const anchors = indexBlockAnchors(findBlockAnchors(markdown, frontmatter));
    issues.push(...checkConsistency({ markdown, frontmatter, document, anchors }));
  }

  // Phase 9：正文超链接（links[] 的唯一替代）+ 成对纪要段
  result.noteSections = findNoteSections(markdown, frontmatter);
  result.noteLinks = collectNoteLinks(markdown, document, frontmatter);
  return finalize(result);
}

/** 主入口（旧签名，语义 = 笔记模式）：分析一段 md 文本 */
export function analyzeMarkdown(markdown: string, options: AnalyzeOptions = {}): AnalyzeResult {
  return analyzeDocument({ ...options, noteMarkdown: markdown });
}

function finalize(result: AnalyzeResult): AnalyzeResult {
  result.issues = sortIssues(result.issues);
  result.counts = countIssues(result.issues);
  result.hasError = hasErrors(result.issues);
  result.hasIssue = result.issues.length > 0;
  return result;
}

/** 把分析结果格式化成可直接展示 / 喂给 AI 的文本 */
export function formatAnalyzeResult(
  result: AnalyzeResult,
  options: { maxIssues?: number; headline?: string } = {},
): string {
  const headline = options.headline ?? "wfjson 分析结果";
  const text = formatIssues(result.issues, {
    headline,
    file: result.file,
    maxIssues: options.maxIssues,
  });
  if (result.jsonFile === undefined) return text;
  // 侧车模式：issue 行号以 JSON 文件为准，展示时把来源补上，避免用户拿行号去笔记里找
  return `${text}\nJSON 来源：${result.jsonFile}（报错行号以该文件为准）`;
}
