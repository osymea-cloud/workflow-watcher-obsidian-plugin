/**
 * 时间字符串工具：wfjson 内的时间一律使用 ISO8601 字符串。
 * - 允许「日期」形式：2026-10-10
 * - 允许「日期时间」形式：2026-10-10T12:00:00+08:00（也接受空格分隔与 Z 时区）
 */

const pad = (value: number, width = 2): string => String(value).padStart(width, "0");

/** JSON Schema 用的「纯日期」正则（字符串形式） */
export const ISO_DATE_PATTERN = "^\\d{4}-\\d{2}-\\d{2}$";

/** JSON Schema 用的「日期时间」正则（字符串形式） */
export const ISO_DATETIME_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,3})?)?(?:Z|[+-]\\d{2}:?\\d{2})?$";

/** JSON Schema 用的「日期或日期时间」正则（字符串形式） */
export const ISO_DATE_OR_DATETIME_PATTERN =
  "^\\d{4}-\\d{2}-\\d{2}(?:[T ]\\d{2}:\\d{2}(?::\\d{2}(?:\\.\\d{1,3})?)?(?:Z|[+-]\\d{2}:?\\d{2})?)?$";

const ISO_DATE_OR_DATETIME_RE = new RegExp(ISO_DATE_OR_DATETIME_PATTERN);
const ISO_PARTS_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2}))?)?/;

const DAYS_IN_MONTH = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function isLeapYear(year: number): boolean {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0;
}

function daysInMonth(year: number, month: number): number {
  if (month === 2 && isLeapYear(year)) return 29;
  return DAYS_IN_MONTH[month - 1] ?? 0;
}

/**
 * 校验字符串是否为合法的 ISO8601 日期/日期时间。
 * 除了格式，还校验「真实存在的日期」：2 月没有 30 日、11 月没有 31 日、月份 1-12、时分 0-59。
 * （Date.parse 的 ISO 解析只检查 01-31，不做月份天数校验，所以这里自己算。）
 */
export function isIsoDateOrDateTime(value: string): boolean {
  if (!ISO_DATE_OR_DATETIME_RE.test(value)) return false;
  const parts = ISO_PARTS_RE.exec(value);
  if (!parts) return false;
  const month = Number(parts[2]);
  const day = Number(parts[3]);
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > daysInMonth(Number(parts[1]), month)) return false;
  if (parts[4] !== undefined) {
    if (Number(parts[4]) > 23 || Number(parts[5]) > 59) return false;
    if (parts[6] !== undefined && Number(parts[6]) > 59) return false;
  }
  const time = Date.parse(value.length === 10 ? `${value}T00:00:00` : value);
  return !Number.isNaN(time);
}

/** 输出本地时区的 ISO8601 日期时间（含时区偏移，如 2026-10-10T12:00:00+08:00） */
export function formatLocalIso(date: Date = new Date()): string {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const abs = Math.abs(offsetMinutes);
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}` +
    `${sign}${pad(Math.floor(abs / 60))}:${pad(abs % 60)}`
  );
}

/** 输出本地时区的日期（YYYY-MM-DD），用于 frontmatter 的 wf-updated */
export function formatLocalDate(date: Date = new Date()): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** 取 ISO8601 字符串的日期部分（YYYY-MM-DD）；无法识别时原样返回 */
export function toDateOnly(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2})/.exec(value);
  return match ? match[1] : value;
}

/** 解析 ISO8601 日期/日期时间（纯日期按本地 00:00:00 解析）；失败返回 undefined */
export function parseIso(value: string): number | undefined {
  const parsed = Date.parse(toDateOnly(value) === value ? `${value}T00:00:00` : value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

/**
 * 两段时间之间的时长（小时，**保留 1 位小数**；Phase 3 契约 §2「hours 精度」）：
 * `Math.round((endAt-startAt)/3600000 * 10) / 10` —— 有意不用 `toFixed(1)`（规避浮点字符串往返）。
 * 任一时间无法解析、或结束早于开始时返回 undefined（调用方据此拒绝写入）。
 */
export function hoursBetween(startAt: string, endAt: string): number | undefined {
  const start = parseIso(startAt);
  const end = parseIso(endAt);
  if (start === undefined || end === undefined) return undefined;
  if (end < start) return undefined;
  return Math.round(((end - start) / 3_600_000) * 10) / 10;
}

/**
 * 毫秒时长 → 正计时器用的 `HH:MM:SS`（小时不截断到 24，如 26:05:09）。
 * 负数（开始时间晚于现在）返回空串 —— 文案分支由视图负责（Phase 3 契约 §7.1）。
 */
export function formatClock(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "";
  const total = Math.floor(ms / 1000);
  const hours = Math.floor(total / 3600);
  const minutes = Math.floor((total % 3600) / 60);
  const seconds = total % 60;
  return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`;
}

/**
 * 取 ISO 串里的**日历日序号**（按 `Date.UTC` 逐日算，不受时区 / 夏令时影响）。
 *
 * 只认 `YYYY-MM-DD` 前缀，且必须是真实存在的日期（2 月 30 日不算）；
 * 无法识别时返回 undefined（调用方据此不渲染那句「已经过 / 距结束」）。
 */
function calendarDayNumber(value: string): number | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(value);
  if (!match) return undefined;
  const dateOnly = `${match[1]}-${match[2]}-${match[3]}`;
  if (!isIsoDateOrDateTime(dateOnly)) return undefined;
  return Math.round(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86_400_000);
}

/**
 * 两个时间串之间的**整天数**（Phase 17：节点卡片上的「已经过 / 距结束」）：
 * 各自只取日期部分，返回 `to` − `from`（可以是负数；同一天 = 0）。
 *
 * 有意按「日历日」算，不用 `Date.parse(to) - Date.parse(from)`：
 * 后者会被时分秒与夏令时带偏（23 小时 ≠ 1 天）。任一时间无法识别返回 undefined。
 */
export function wholeDaysFromTo(fromIso: string, toIso: string): number | undefined {
  const from = calendarDayNumber(fromIso);
  const to = calendarDayNumber(toIso);
  if (from === undefined || to === undefined) return undefined;
  return to - from;
}

/**
 * 小时数 → `XdYh`（v0.7 §⑨-5：节点卡片上的「已完成时间」）。
 *
 *  - `X` = 整天数，`Y` = 剩余小时（保留 1 位小数，去掉无意义的 `.0`）；
 *  - **不足 24 小时省略 `0d`**（`5h` / `5.5h`）；整天时省略 `0h`（`2d`）；
 *  - 负数 / 非有限值返回空串（调用方据此不渲染）。
 */
export function formatWorkDuration(hours: number): string {
  if (!Number.isFinite(hours) || hours < 0) return "";
  const rounded = Math.round(hours * 10) / 10;
  const days = Math.floor(rounded / 24);
  const rest = Math.round((rounded - days * 24) * 10) / 10;
  if (days === 0) return `${rest}h`;
  return rest === 0 ? `${days}d` : `${days}d${rest}h`;
}
