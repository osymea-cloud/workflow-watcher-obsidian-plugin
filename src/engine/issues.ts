/**
 * 统一的问题（issue）模型与错误码登记表。
 *
 * 设计目标（决策 4：一致性由插件维护 + 校验报错）：
 *  - 每个问题都有稳定的 code、severity、JSON Pointer path（RFC6901）与行号（能定位时）；
 *  - 每个 code 在 ISSUE_CODES 里登记中文标题与修复提示，人类与 AI 都能直接照做；
 *  - 解析层 / Schema 校验层 / 一致性层共用同一套模型，便于上层（Notice、视图、AI）统一消费。
 */

import { issueHint, severityLabel, t } from "./i18n.ts";

export type IssueSeverity = "error" | "warning" | "info";

export const SEVERITY_LABELS: Readonly<Record<IssueSeverity, string>> = {
  error: "错误",
  warning: "警告",
  info: "提示",
};

export interface IssueCodeDefinition {
  readonly severity: IssueSeverity;
  readonly title: string;
  readonly hint?: string;
}

/**
 * 错误码登记表。新增 code 时必须在此登记（severity / 中文标题 / 修复提示）。
 */
export const ISSUE_CODES = {
  // ---- 代码块与 JSON 语法 ----
  NO_WFJSON_BLOCK: {
    severity: "info",
    title: "未发现 wfjson 代码块",
    hint: "该文件不是工作流笔记，已跳过校验（决策 5：一文件一 wfjson 代码块）。",
  },
  MULTIPLE_WFJSON_BLOCKS: {
    severity: "error",
    title: "存在多个 wfjson 代码块",
    hint: "约定一文件一代码块（内含 workflows 数组）；请把多个块合并为一个（决策 5）。",
  },
  WFJSON_BLOCK_IGNORED: {
    severity: "info",
    title: "笔记内的 wfjson 代码块已被忽略",
    hint: "本笔记已使用外置 JSON（_wfjson/…）。可运行「迁移当前文件到外置 JSON」把遗留代码块清掉（清理是幂等的）。",
  },
  WFJSON_BLOCK_UNCLOSED: {
    severity: "error",
    title: "wfjson 代码块未闭合",
    hint: "请补上结束围栏（长度需不小于起始围栏）。",
  },
  JSON_BOM: {
    severity: "warning",
    title: "wfjson 内容以 BOM 开头",
    hint: "已自动忽略 BOM；建议把文件保存为「无 BOM 的 UTF-8」。",
  },
  JSON_COMMENT_NOT_ALLOWED: {
    severity: "error",
    title: "wfjson 内出现注释",
    hint: "决策 1：wfjson 内为严格 JSON（零注释）；字段说明统一写在 doc/datacontact/data_ixd_v0.md。",
  },
  JSON_TRAILING_COMMA: {
    severity: "error",
    title: "wfjson 内出现尾随逗号",
    hint: "严格 JSON 不允许对象/数组最后一项后带逗号，请删除多余的逗号（决策 1）。",
  },
  JSON_PARSE_ERROR: {
    severity: "error",
    title: "JSON 语法错误",
    hint: "请检查引号/逗号/括号是否配对；wfjson 内必须是严格 JSON。",
  },

  // ---- Schema 校验 ----
  SCHEMA_VERSION_UNSUPPORTED: {
    severity: "error",
    title: "schemaVersion 不受支持",
    hint: "请升级插件或把 schemaVersion 改回受支持版本。",
  },
  SCHEMA_TYPE: { severity: "error", title: "字段类型不符合 Schema" },
  SCHEMA_ENUM: { severity: "error", title: "字段取值不在允许集合内" },
  SCHEMA_CONST: { severity: "error", title: "字段取值必须为固定值" },
  SCHEMA_REQUIRED: { severity: "error", title: "缺少必填字段" },
  SCHEMA_UNKNOWN_FIELD: {
    severity: "error",
    title: "出现 Schema 未定义的字段",
    hint: "字段清单见 doc/datacontact/data_ixd_v0.md；新增字段需先升级 schemaVersion。",
  },
  SCHEMA_ITEMS: { severity: "error", title: "数组内容不符合要求" },
  SCHEMA_RANGE: { severity: "error", title: "数值超出允许范围" },
  SCHEMA_LENGTH: { severity: "error", title: "字符串长度不符合要求" },
  SCHEMA_PATTERN: { severity: "error", title: "字符串格式不符合要求" },
  SCHEMA_ANY_OF: { severity: "error", title: "不满足任一允许形式" },

  // ---- 稳定 ID ----
  ID_FORMAT: {
    severity: "warning",
    title: "id 前缀不符合约定",
    hint: "约定前缀：file-（文件）/ wf-（工作流）/ nd-（节点）/ lk-（链接）；建议用插件生成的 UUID。",
  },
  DUPLICATE_NODE_ID: {
    severity: "error",
    title: "节点 id 重复",
    hint: "节点 id 必须全局唯一；请重新生成重复节点的 id（并同步修改正文锚点）。",
  },
  DUPLICATE_WORKFLOW_ID: {
    severity: "error",
    title: "工作流 id 重复",
    hint: "工作流 id 必须全局唯一。",
  },
  DUPLICATE_LINK_ID: {
    severity: "error",
    title: "链接 id 重复",
    hint: "links[].id 在文件内必须唯一（便于右键菜单定位）。",
  },

  // ---- 正文纪要段标志对（Phase 9） ----
  NOTE_SECTION_UNPAIRED: {
    severity: "error",
    title: "纪要段标志没有配对",
    hint: "每个 `<!-- wf-note:begin:<id> -->` 都必须有同 id 的 end 标志；请补齐或删除多余的标志行。",
  },
  NOTE_SECTION_NESTED: {
    severity: "error",
    title: "纪要段标志嵌套",
    hint: "上一个开始标志还没遇到 end 就出现了新的 begin；请为前一个段落补上 end 标志。",
  },
  NOTE_SECTION_ID_MISMATCH: {
    severity: "error",
    title: "纪要段标志 id 不匹配",
    hint: "begin / end 标志里的节点 id 必须一致；请按标题行的锚点统一两处 id。",
  },

  // ---- noteAnchor ↔ 正文 ^blockid 一致性 ----
  NOTE_ANCHOR_MISSING_IN_BODY: {
    severity: "error",
    title: "noteAnchor 在正文中不存在",
    hint: "请在正文补一个带锚点的标题行，或在 JSON 中修正/删除 noteAnchor。",
  },
  NOTE_ANCHOR_DUPLICATED_IN_BODY: {
    severity: "error",
    title: "正文中同一个锚点出现多次",
    hint: "block id 必须唯一；请删除多余的锚点。",
  },
  NOTE_ANCHOR_NOT_ON_HEADING: {
    severity: "warning",
    title: "锚点未挂在标题行上",
    hint: "约定纪要段落形如「### 标题 ^nd-xxx」，便于左侧大纲与跳转定位。",
  },
  NOTE_ANCHOR_NOT_MATCHING_ID: {
    severity: "warning",
    title: "noteAnchor 与节点 id 不一致",
    hint: "约定 noteAnchor = \"^\" + 节点 id，便于 AI 与人类双向定位。",
  },
  ORPHAN_BLOCK_ANCHOR: {
    severity: "warning",
    title: "正文锚点未被任何节点引用",
    hint: "该锚点可能是节点删除后的残留，请删除或补回对应节点。",
  },

  // ---- 节点状态 / 时间 ----
  /** @deprecated v1.6 起废除 status ↔ progress 联动，本 code 不再产生（仅为兼容旧测试/记录保留） */
  STATUS_PROGRESS_MISMATCH: {
    severity: "warning",
    title: "status 与 progress 不一致",
    hint: "v1.6 起 progress 与 status 解耦，本规则已废除。",
  },
  STATUS_HISTORY_MISMATCH: {
    severity: "warning",
    title: "statusHistory 与 status 不一致",
    hint: "请把最新状态变更追加进 statusHistory，保持最后一条 to 等于当前 status。",
  },
  COMPLETED_AT_MISSING: {
    severity: "warning",
    title: "已完成节点缺少 completedAt",
    hint: "status=done 时建议补上完成时间 completedAt。",
  },
  /** @deprecated v1.6 起废除 status ↔ progress 联动，本 code 不再产生 */
  PROGRESS_STATUS_CONFLICT: {
    severity: "warning",
    title: "progress 与 status 的完成度明显不符",
    hint: "v1.6 起 progress 与 status 解耦，本规则已废除。",
  },
  /** @deprecated v1.6 起废除 workflow.progress 与根节点 progress 的大小比较，本 code 不再产生 */
  PROGRESS_DECREASED: {
    severity: "info",
    title: "工作流进度低于其节点进度",
    hint: "v1.6 起 progress 改为纯手动、相互独立，本规则已废除。",
  },
  PROGRESS_OVER_MAX: {
    severity: "info",
    title: "progress 大于 progress_max",
    hint: "progress / progress_max 相互独立，允许 progress > progress_max；此处仅提示，不拦写回。",
  },
  TIMESTAMP_INVALID: {
    severity: "error",
    title: "时间字段不是真实存在的日期",
    hint: "请填写真实日期（如 2 月没有 30 日），格式 YYYY-MM-DD 或 ISO8601 日期时间。",
  },
  TIMESTAMP_ORDER: {
    severity: "warning",
    title: "时间字段先后顺序不合理",
    hint: "合理顺序：startAt ≤ updatedAt ≤ completedAt，且 dueAt 一般不早于 startAt。",
  },

  // ---- 计时条目（v1.3，node.timeEntries） ----
  TIME_HOURS_RANGE: {
    severity: "error",
    title: "timeEntries[].hours 不是有效时长",
    hint: "hours 必须是有限的非负数（小时，1 位小数），= Math.round((endAt-startAt)/3600000*10)/10。",
  },
  TIME_ENTRY_ORDER: {
    severity: "error",
    title: "计时条目结束早于开始",
    hint: "timeEntries[].endAt 不得早于 startAt；开始时间失效时请「结束并丢弃」该条。",
  },
  TIME_DATE_MISMATCH: {
    severity: "warning",
    title: "timeEntries[].date 与 startAt 的日期不一致",
    hint: "约定 date = toDateOnly(startAt)（不做 UTC 换算；跨零点整段计入开始那天）。",
  },

  // ---- links ----
  LINK_TARGET_NOT_BARE: {
    severity: "warning",
    title: "links[].target 不是裸目标",
    hint: "只存裸目标（笔记名/文件名/URL）：md → [[target]]、image → ![[target]] 由渲染层组装（见 data_ixd_discuss.md 六-1）。",
  },
  LINK_TARGET_TYPE_MISMATCH: {
    severity: "warning",
    title: "links[].target 与 type 不匹配",
    hint: "web 类型请使用 http(s):// 的 URL；image 类型请使用常见图片扩展名；file 用于其余本地文件。",
  },

  // ---- relations ----
  RELATION_TARGET_UNKNOWN: {
    severity: "warning",
    title: "relations[].target 无法在本文件内解析",
    hint: "若目标是本文件内的节点/工作流，请核对 id；跨文件引用在 v1.0 暂不校验。",
  },
  RELATION_SELF_DEPENDENCY: {
    severity: "error",
    title: "节点依赖自身",
    hint: "dependsOn 不能指向自身，请删除该关系或改指其它节点。",
  },
  RELATION_CYCLE: {
    severity: "warning",
    title: "存在循环依赖",
    hint: "循环依赖会导致工作流无法排期，请检查并打断环。",
  },

  // ---- frontmatter 摘要字段 ----
  FRONTMATTER_FIELD_MISSING: {
    severity: "warning",
    title: "frontmatter 缺少 wf-* 摘要字段",
    hint: "决策 5：frontmatter 保留 wf-tags / wf-status / wf-titles / wf-updated，供 dataview 跨文件聚合。",
  },
  FRONTMATTER_STATUS_MISMATCH: {
    severity: "warning",
    title: "wf-status 与 JSON 聚合状态不一致",
    hint: "聚合规则：全部 done→done；存在 doing→doing；存在 blocked→blocked；全部 cancelled/done→cancelled；其余→todo。",
  },
  FRONTMATTER_TITLES_MISMATCH: {
    severity: "warning",
    title: "wf-titles 与 JSON 工作流标题不一致",
    hint: "wf-titles 应逐项等于 wfjson 内 workflows[].title。",
  },
  FRONTMATTER_UPDATED_MISMATCH: {
    severity: "warning",
    title: "wf-updated 与 JSON updatedAt 不一致",
    hint: "wf-updated 建议写 wfjson 中 updatedAt 的日期部分。",
  },
} as const satisfies Record<string, IssueCodeDefinition>;

export type IssueCode = keyof typeof ISSUE_CODES;

/**
 * issue() 用的宽松视图：部分 code 未登记 hint，
 * 统一按 IssueCodeDefinition（hint 可选）读取，避免联合类型把 hint 判成不存在。
 */
const ISSUE_DEFINITIONS: Readonly<Record<IssueCode, IssueCodeDefinition>> = ISSUE_CODES;

const SEVERITY_RANK: Readonly<Record<IssueSeverity, number>> = {
  error: 0,
  warning: 1,
  info: 2,
};

export interface WfIssue {
  code: IssueCode;
  severity: IssueSeverity;
  message: string;
  /** JSON Pointer（RFC6901），如 /workflows/0/root/children/1/status */
  path?: string;
  /** md 文件中的行号（1 基）；无法定位时省略 */
  line?: number;
  hint?: string;
  /** 附加明细（如 anyOf 各候选形式的失败原因） */
  details?: string[];
}

export interface IssueInit {
  path?: string;
  line?: number;
  severity?: IssueSeverity;
  hint?: string;
  details?: string[];
}

/** 创建一条问题（severity / hint 缺省时取登记表的默认值） */
export function issue(code: IssueCode, message: string, init: IssueInit = {}): WfIssue {
  const definition = ISSUE_DEFINITIONS[code];
  const result: WfIssue = {
    code,
    severity: init.severity ?? definition.severity,
    message,
  };
  if (init.path !== undefined) result.path = init.path;
  if (init.line !== undefined) result.line = init.line;
  const hint = init.hint ?? issueHint(code, definition.hint);
  if (hint !== undefined) result.hint = hint;
  if (init.details !== undefined && init.details.length > 0) result.details = init.details;
  return result;
}

/** 排序：错误 → 警告 → 提示；同级按行号、再按 path */
export function sortIssues(issues: readonly WfIssue[]): WfIssue[] {
  return [...issues].sort((a, b) => {
    const bySeverity = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (bySeverity !== 0) return bySeverity;
    const byLine = (a.line ?? Number.MAX_SAFE_INTEGER) - (b.line ?? Number.MAX_SAFE_INTEGER);
    if (byLine !== 0) return byLine;
    return (a.path ?? "").localeCompare(b.path ?? "") || a.code.localeCompare(b.code);
  });
}

export interface IssueCounts {
  error: number;
  warning: number;
  info: number;
  total: number;
}

export function countIssues(issues: readonly WfIssue[]): IssueCounts {
  const counts: IssueCounts = { error: 0, warning: 0, info: 0, total: issues.length };
  for (const item of issues) counts[item.severity] += 1;
  return counts;
}

export function hasErrors(issues: readonly WfIssue[]): boolean {
  return issues.some((item) => item.severity === "error");
}

/** 取指定 code 的所有问题 */
export function issuesWithCode(issues: readonly WfIssue[], code: IssueCode): WfIssue[] {
  return issues.filter((item) => item.code === code);
}

/** 单行格式化：`[错误] CODE · /path · 第 N 行 — message` */
export function formatIssueLine(item: WfIssue): string {
  const position = [item.path, item.line !== undefined ? t("issues.line", { line: item.line }) : undefined]
    .filter((part): part is string => Boolean(part))
    .join(" · ");
  const head = `[${severityLabel(item.severity)}] ${item.code}${position ? ` · ${position}` : ""}`;
  return `${head} — ${item.message}`;
}

export interface FormatIssuesOptions {
  /** 文件路径（仅用于展示） */
  file?: string;
  /** 最多显示多少条（默认 50，其余折叠为一行提示） */
  maxIssues?: number;
  /** 标题行（可选，如 "wfjson 校验 · 某文件"） */
  headline?: string;
}

/** 把问题清单格式化成人类/AI 都能直接读的多行文本 */
export function formatIssues(issues: readonly WfIssue[], options: FormatIssuesOptions = {}): string {
  const maxIssues = options.maxIssues ?? 50;
  const counts = countIssues(issues);
  const lines: string[] = [];
  if (options.headline) lines.push(options.headline);
  if (options.file) lines.push(t("issues.file", { file: options.file }));
  lines.push(t("issues.summary", { errors: counts.error, warnings: counts.warning, infos: counts.info }));
  if (issues.length === 0) {
    lines.push(t("issues.none"));
    return lines.join("\n");
  }
  const shown = issues.slice(0, maxIssues);
  shown.forEach((item, index) => {
    lines.push(`${index + 1}. ${formatIssueLine(item)}`);
    if (item.hint) lines.push(`   → ${item.hint}`);
    for (const detail of item.details ?? []) lines.push(`   · ${detail}`);
  });
  if (issues.length > shown.length) {
    lines.push(t("issues.more", { count: issues.length - shown.length, max: maxIssues }));
  }
  return lines.join("\n");
}
