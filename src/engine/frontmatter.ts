/**
 * frontmatter 的「尽力而为」解析。
 *
 * 只服务于插件自身的两类用途（都不参与严格校验）：
 *  1. 跳过 frontmatter 区域，避免把其中的 ^xxx 误判为正文 block 锚点；
 *  2. 读取 wf-* 摘要字段，与 wfjson 内的数据做交叉一致性检查（决策 5）。
 *
 * 只支持常见写法，不实现完整 YAML：
 *  - `wf-status: doing`
 *  - `wf-tags: [立项, 调研]`（内联数组，元素可加引号）
 *  - `wf-titles:` + 后续 `- 立项调查` 块序列
 */

export interface FrontmatterField {
  key: string;
  /** 标量字段为 string；数组字段为 string[] */
  value: string | string[];
  /** 字段所在行号（1 基；块序列取第一项所在行） */
  line: number;
  raw: string;
}

export interface FrontmatterInfo {
  present: boolean;
  /** frontmatter 起始行（含 `---`），无 frontmatter 时为 0 */
  startLine: number;
  /** frontmatter 结束行（含 `---`），无 frontmatter 时为 0 */
  endLine: number;
  fields: FrontmatterField[];
  has(key: string): boolean;
  get(key: string): string | string[] | undefined;
  getString(key: string): string | undefined;
  getArray(key: string): string[] | undefined;
}

function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2) {
    const first = trimmed[0];
    const last = trimmed[trimmed.length - 1];
    if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
      return trimmed.slice(1, -1);
    }
  }
  return trimmed;
}

/** 拆分内联数组 `[a, "b, c"]`（只按引号外层的逗号切分） */
function splitInlineArray(body: string): string[] {
  const items: string[] = [];
  let current = "";
  let quote: string | null = null;
  for (const char of body) {
    if (quote) {
      if (char === quote) quote = null;
      else current += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ",") {
      items.push(current);
      current = "";
      continue;
    }
    current += char;
  }
  items.push(current);
  return items.map((item) => item.trim()).filter((item) => item.length > 0);
}

function parseScalar(raw: string): string | string[] | undefined {
  const value = raw.trim();
  if (value.length === 0) return undefined;
  if (value.startsWith("[") && value.endsWith("]")) {
    return splitInlineArray(value.slice(1, -1)).map(unquote);
  }
  return unquote(value);
}

/** 解析 md 文本的 frontmatter；文件不以 `---` 开头时 present=false */
export function parseFrontmatter(markdown: string): FrontmatterInfo {
  const text = markdown.startsWith("\uFEFF") ? markdown.slice(1) : markdown;
  const lines = text.split(/\r?\n/);
  const fields: FrontmatterField[] = [];
  const index = new Map<string, FrontmatterField>();
  let startLine = 0;
  let endLine = 0;

  if (lines.length > 0 && lines[0].trim() === "---") {
    // 找到结束行
    let closing = -1;
    for (let i = 1; i < lines.length; i += 1) {
      const trimmed = lines[i].trim();
      if (trimmed === "---" || trimmed === "...") {
        closing = i;
        break;
      }
    }
    if (closing !== -1) {
      startLine = 1;
      endLine = closing + 1;
      for (let i = 1; i < closing; i += 1) {
        const line = lines[i];
        const trimmed = line.trim();
        if (trimmed.length === 0 || trimmed.startsWith("#")) continue;
        const separator = line.indexOf(":");
        if (separator === -1) continue;
        const key = line.slice(0, separator).trim();
        if (key.length === 0) continue;
        const raw = line.slice(separator + 1);
        const parsed = parseScalar(raw);
        if (parsed !== undefined) {
          const field: FrontmatterField = { key, value: parsed, line: i + 1, raw: line };
          fields.push(field);
          index.set(key, field);
          continue;
        }
        // 空值 → 尝试读取块序列（后续连续的 `- xxx` 行）
        const sequence: string[] = [];
        let cursor = i + 1;
        while (cursor < closing) {
          const itemMatch = /^\s*-\s*(.+?)\s*$/.exec(lines[cursor]);
          if (!itemMatch) break;
          sequence.push(unquote(itemMatch[1]));
          cursor += 1;
        }
        if (sequence.length > 0) {
          const field: FrontmatterField = { key, value: sequence, line: i + 1, raw: line };
          fields.push(field);
          index.set(key, field);
          i = cursor - 1;
        } else {
          const field: FrontmatterField = { key, value: "", line: i + 1, raw: line };
          fields.push(field);
          index.set(key, field);
        }
      }
    }
  }

  return {
    present: startLine > 0,
    startLine,
    endLine,
    fields,
    has: (key: string) => index.has(key),
    get: (key: string) => index.get(key)?.value,
    getString: (key: string) => {
      const value = index.get(key)?.value;
      if (typeof value === "string") return value;
      if (Array.isArray(value) && value.length > 0) return value[0];
      return undefined;
    },
    getArray: (key: string) => {
      const value = index.get(key)?.value;
      if (Array.isArray(value)) return value;
      if (typeof value === "string" && value.length > 0) return [value];
      return undefined;
    },
  };
}

/** 判断某一行（1 基）是否落在 frontmatter 内 */
export function isInsideFrontmatter(info: FrontmatterInfo, lineNumber: number): boolean {
  return info.present && lineNumber >= info.startLine && lineNumber <= info.endLine;
}

/* ------------------------------------------------------------------ *
 * 逐行写入（v0.7 §⑨-7：`wf-theme` 这类单键写入）
 * ------------------------------------------------------------------ */

/** 正则转义（键名里出现 `-` / `.` 之类不该当元字符） */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 标量行的值：纯字母数字原样写，其余用 JSON 双引号包起来（够用且不破坏行结构） */
function formatScalarValue(value: string): string {
  if (value.length === 0) return "";
  return /^[A-Za-z0-9_./+-]+$/.test(value) ? value : JSON.stringify(value);
}

/**
 * 逐行 upsert 一个 frontmatter 标量字段（**不解析整段 YAML**，容忍其余非严格写法）。
 *
 * 为什么需要它：`app.fileManager.processFrontMatter` 用严格 YAML 解析整块 frontmatter，
 * 遇到用户笔记里既有的非严格写法（例：`wf-tags: [x]` 后紧跟 `- y`）会直接抛错，
 * 导致「主题」这种单键写入被无关字段拖垮。这里只按行找键、只改那一行：
 *
 *  - 有 frontmatter：命中键 → 原地重写（连带删掉原值为空时紧随其后的 `- item` 块序列）；
 *    未命中 → 插到结束行 `---` 之前；
 *  - 没有 frontmatter（或 `---` 没有闭合）→ 在文件头新建一段只含该键的 frontmatter；
 *  - `value === undefined` → 删除该键（连带其块序列子项）；
 *  - 换行风格（`\n` / `\r\n`）与 BOM 原样保留。
 *
 * 只写一行 → 其余字段（含插件不认识的字段、注释、空行）一字不动。
 */
export function setFrontmatterField(markdown: string, key: string, value?: string): string {
  const bom = markdown.startsWith("\uFEFF") ? "\uFEFF" : "";
  const body = bom.length > 0 ? markdown.slice(1) : markdown;
  const eol = body.includes("\r\n") ? "\r\n" : "\n";
  const lines = body.split(/\r?\n/);
  const fieldLine = `${key}: ${formatScalarValue(value ?? "")}`.trimEnd();
  const keyPattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*:`);

  const prependFrontmatter = (): string => {
    const header = ["---", fieldLine, "---"].join(eol);
    return `${bom}${header}${eol}${body}`;
  };
  // 删除时：没有 frontmatter 就没什么可删（正文里的同名行不是本插件的字段）
  if (value === undefined && (lines.length === 0 || lines[0].trim() !== "---")) {
    return `${bom}${body}`;
  }

  if (lines.length === 0 || lines[0].trim() !== "---") return prependFrontmatter();

  let closing = -1;
  for (let i = 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();
    if (trimmed === "---" || trimmed === "...") {
      closing = i;
      break;
    }
  }
  // `---` 没闭合 → 这段不是本插件该动的 frontmatter，按「没有 frontmatter」处理
  if (closing === -1) return value === undefined ? `${bom}${body}` : prependFrontmatter();

  const output: string[] = [];
  let replaced = false;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (!replaced && i > 0 && i < closing && keyPattern.test(line)) {
      replaced = true;
      if (value !== undefined) output.push(fieldLine);
      // 原值写成块序列（`key:` + 后续 `- x`）时，这些子项属于该键，一起处理
      let cursor = i + 1;
      while (cursor < closing && /^\s*-\s+/.test(lines[cursor])) cursor += 1;
      i = cursor - 1;
      continue;
    }
    output.push(line);
  }
  if (!replaced && value !== undefined) output.splice(closing, 0, fieldLine);

  return `${bom}${output.join(eol)}`;
}
