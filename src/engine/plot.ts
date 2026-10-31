/**
 * 365 天 plot 引擎（Phase 19 M3；契约见 doc/datacontact/data_ixd_discuss_interact_v0.19.md §M3）。
 *
 * 一个 plot = `plots/plot-<uuid>.json` 一个文件（**文件名用 id**，改名不动文件）：
 *
 * ```jsonc
 * { "id": "plot-<uuid>", "name": "体重变化", "kind": "date", "unit": "", "points": [ { "x": "2026-01-01", "y": 70.5 } ] }
 * ```
 *
 *  - `kind = "date"` → x 是 `YYYY-MM-DD`（真实存在的日期）；
 *  - `kind = "sequence"` → x 是正整数（1..n）；
 *  - CSV 只承载 points（两列 `x,y`），name / kind / unit 由 UI 填。
 *
 * 本文件全是纯函数、零 Obsidian 依赖、可直接 `node --test`：
 * 校验（`validatePlot`）/ 排序（`sortPoints`）/ 坐标域（`computeScale` + `projectValue`）/
 * CSV 往返（`toCsv` / `fromCsv`）/ 目录与路径（`normalizePlotFolder` / `plotPath`）。
 *
 * 边界：**不碰 wfjson**（schema 仍 1.9）—— plot 是独立 JSON，视图写盘只走 vault 的
 * `create / modify / delete`，与 `mutateFile` 那条链路无关。
 */

import { isIsoDateOrDateTime } from "./time.ts";

/** plot 的默认目录（插件设置 `plotFolder` 的缺省值） */
export const PLOT_FOLDER_DEFAULT = "plots";

/** x 轴类型：日期 / 序号（顺序 = 设置面板里的顺序） */
export const PLOT_KINDS = ["date", "sequence"] as const;

/** x 轴类型 */
export type PlotKind = (typeof PLOT_KINDS)[number];

/** 缺省类型（新建 plot / 读到非法 kind 时的回落值，只用于 UI） */
export const PLOT_KIND_DEFAULT: PlotKind = "date";

/** 一个 plot 最多存多少个点（CSV 导入的护栏：手抖粘进十万行也不至于卡死界面） */
export const PLOT_POINTS_MAX = 2000;

/** id 前缀（与 wfjson 的 `file- / wf- / nd- / lk-` 同一套约定） */
export const PLOT_ID_PREFIX = "plot-";

/**
 * 目录校验：去首尾空白 → 去掉结尾的 `/` → 空串回落 `plots`。
 * 与 `main.ts` 的 `normalizeDailyFolder()` **同口径**（契约 §M3「normalize 同 dailyFolder」）。
 */
export function normalizePlotFolder(value: unknown): string {
  if (typeof value !== "string") return PLOT_FOLDER_DEFAULT;
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : PLOT_FOLDER_DEFAULT;
}

/** 类型白名单校验：不认识的值一律回落 `date` */
export function normalizePlotKind(value: unknown): PlotKind {
  return isPlotKind(value) ? value : PLOT_KIND_DEFAULT;
}

/** 是不是合法的 x 轴类型 */
export function isPlotKind(value: unknown): value is PlotKind {
  return typeof value === "string" && (PLOT_KINDS as readonly string[]).includes(value);
}

/** 一个点的 x：日期是字符串、序号是数字（落盘就按这个类型写） */
export type PlotX = string | number;

/** 一个数据点 */
export interface PlotPoint {
  x: PlotX;
  y: number;
}

/** 一个 plot 文档（= 一个 JSON 文件的正文） */
export interface PlotDocument {
  /** `plot-<uuid>`（与文件名同名；改名不动文件） */
  id: string;
  /** 显示名（可以空：视图回落到「未命名」） */
  name: string;
  kind: PlotKind;
  /** y 轴单位（可以空） */
  unit: string;
  /** 数据点（保持文件里的顺序；画图前过一遍 `sortPoints()`） */
  points: PlotPoint[];
}


/* ------------------------------------------------------------------ *
 * id / 路径
 * ------------------------------------------------------------------ */

const PLOT_ID_RE = /^plot-[A-Za-z0-9][A-Za-z0-9-]*$/;

/** 是不是合法的 plot id（`plot-` + 至少 1 个字母数字） */
export function isPlotId(value: unknown): value is string {
  return typeof value === "string" && PLOT_ID_RE.test(value);
}

/**
 * 新 id：`plot-<uuid>`。
 *
 * 优先用 `crypto.randomUUID()`（桌面端 / 移动端 webview 都有）；老环境退化为
 * `Math.random` 拼出来的 v4 形态 —— 只要唯一即可，不参与任何校验算法。
 */
export function newPlotId(): string {
  const crypto = (globalThis as { crypto?: { randomUUID?: () => string } }).crypto;
  if (typeof crypto?.randomUUID === "function") return `${PLOT_ID_PREFIX}${crypto.randomUUID()}`;
  const hex = "0123456789abcdef";
  let out = "";
  for (let index = 0; index < 36; index += 1) {
    if (index === 8 || index === 13 || index === 18 || index === 23) out += "-";
    else if (index === 14) out += "4";
    else if (index === 19) out += hex[Math.floor(Math.random() * 4) + 8];
    else out += hex[Math.floor(Math.random() * 16)];
  }
  return `${PLOT_ID_PREFIX}${out}`;
}

/** JSON 文件名：`plot-<uuid>.json`（文件名 = id，改 name 不动文件） */
export function plotFileName(id: string): string {
  return `${id}.json`;
}

/** CSV 文件名：`plot-<uuid>.csv`（导出落在同一个目录） */
export function plotCsvName(id: string): string {
  return `${id}.csv`;
}

/** JSON 路径：`<folder>/plot-<uuid>.json` */
export function plotPath(folder: string, id: string): string {
  return `${normalizePlotFolder(folder)}/${plotFileName(id)}`;
}

/** CSV 路径（导出）：`<folder>/plot-<uuid>.csv` */
export function plotCsvPath(folder: string, id: string): string {
  return `${normalizePlotFolder(folder)}/${plotCsvName(id)}`;
}

/** 从路径取 id（`plots/plot-x.json` → `plot-x`）；不是 plot 文件返回 undefined */
export function plotIdFromPath(path: string): string | undefined {
  const name = path.slice(path.lastIndexOf("/") + 1);
  if (!name.endsWith(".json")) return undefined;
  const id = name.slice(0, -".json".length);
  return isPlotId(id) ? id : undefined;
}

/* ------------------------------------------------------------------ *
 * x 的校验 / 归一 / 解析
 * ------------------------------------------------------------------ */

const DATE_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** `date` 的 x 必须是真实存在的 `YYYY-MM-DD`；`sequence` 必须是正整数 */
export function isValidPlotX(kind: PlotKind, x: unknown): x is PlotX {
  if (kind === "sequence") return typeof x === "number" && Number.isInteger(x) && x >= 1;
  return typeof x === "string" && DATE_KEY_RE.test(x) && isIsoDateOrDateTime(x);
}

/**
 * x → 用于排序 / 画图的数值：
 *  - `date` → 日历日序号（`Date.UTC` 逐日算，不受时区 / 夏令时影响）；
 *  - `sequence` → 整数本身。
 *
 * 非法 x 返回 undefined（调用方据此跳过这个点）。
 */
export function plotXValue(kind: PlotKind, x: unknown): number | undefined {
  if (!isValidPlotX(kind, x)) return undefined;
  if (kind === "sequence") return x as number;
  const [year, month, day] = (x as string).split("-").map(Number);
  return Math.round(Date.UTC(year, month - 1, day) / 86_400_000);
}

/**
 * x 的规范写法（去空白），非法返回 undefined。
 * `date` 仍是字符串、`sequence` 仍是数字 —— 落盘类型跟着 kind 走。
 */
export function normalizePlotX(kind: PlotKind, x: unknown): PlotX | undefined {
  if (typeof x === "string" && kind === "date") {
    const trimmed = x.trim();
    return isValidPlotX(kind, trimmed) ? trimmed : undefined;
  }
  return isValidPlotX(kind, x) ? x : undefined;
}

/**
 * UI 输入框的文本 → x（`YYYY-MM-DD` 或正整数）。
 * 空串 / 格式不对 / 不存在的日期一律 undefined（调用方据此提示、不落盘）。
 */
export function parsePlotX(kind: PlotKind, text: string): PlotX | undefined {
  const trimmed = text.trim();
  if (kind === "sequence") {
    if (!/^\d+$/.test(trimmed)) return undefined;
    const value = Number(trimmed);
    return isValidPlotX(kind, value) ? value : undefined;
  }
  return isValidPlotX(kind, trimmed) ? trimmed : undefined;
}

/** y 的输入框文本 → 数字（接受 `70.5` / `-3` / `1e3`；其余 undefined） */
export function parsePlotY(text: string): number | undefined {
  const trimmed = text.trim();
  if (trimmed.length === 0) return undefined;
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : undefined;
}

/* ------------------------------------------------------------------ *
 * 点搜索（补充契约⑥c：空 = 不限 / `A` = 精确 / `A~B` = 闭区间）
 * ------------------------------------------------------------------ */

/** 一次搜索的解析结果 */
export interface PlotSearch {
  /** 下界（含）；`undefined` = 该侧不限 */
  min?: PlotX;
  /** 上界（含）；`undefined` = 该侧不限 */
  max?: PlotX;
  /** 输入不合法（视图提示后**保持上一次的过滤结果**，不拿它去过滤） */
  invalid?: boolean;
}

/**
 * 搜索框文本 → 区间。
 *
 *  - 空串 → `{}`（两边都不限 = 显示全部点）；
 *  - `A` → `{ min: A, max: A }`（精确匹配）；
 *  - `A~B` → 闭区间（两端都算命中）；`A > B` 时**自动交换**（用户写反了不必回头改）；
 *  - 其余（`~` 多于 1 个 / A 或 B 不是合法 x）→ `{ invalid: true }`。
 *
 * x 的合法性完全复用 `parsePlotX()`：date 走真实日历校验（`2026-02-30` 非法）、
 * sequence 必须正整数 —— 与「添加点」的输入口径一致。
 */
export function parsePlotSearch(kind: PlotKind, text: string): PlotSearch {
  const trimmed = text.trim();
  if (trimmed.length === 0) return {};
  const parts = trimmed.split("~");
  if (parts.length > 2) return { invalid: true };
  const first = parsePlotX(kind, parts[0]);
  if (first === undefined) return { invalid: true };
  if (parts.length === 1) return { min: first, max: first };
  const second = parsePlotX(kind, parts[1]);
  if (second === undefined) return { invalid: true };
  // 两个端点都转成可比较的数值再定上下界（date → 日序数，sequence → 整数本身）
  const a = plotXValue(kind, first);
  const b = plotXValue(kind, second);
  if (a === undefined || b === undefined) return { invalid: true };
  return a <= b ? { min: first, max: second } : { min: second, max: first };
}

/**
 * x 是否落在 `[min, max]` 闭区间里（`min` / `max` 为 `undefined` = 该侧不限）。
 *
 * 比较走 `plotXValue()`：`date` 是逐日算出的日序数（等价于 `YYYY-MM-DD` 字典序，
 * 但不受 `Date` 时区影响）、`sequence` 是整数本身 —— 两种 kind 因此共用一套比较。
 * x 本身非法时返回 `false`（脏点不进点表）。
 */
export function plotXInRange(kind: PlotKind, x: unknown, min?: PlotX, max?: PlotX): boolean {
  const value = plotXValue(kind, x);
  if (value === undefined) return false;
  if (min !== undefined) {
    const lower = plotXValue(kind, min);
    if (lower !== undefined && value < lower) return false;
  }
  if (max !== undefined) {
    const upper = plotXValue(kind, max);
    if (upper !== undefined && value > upper) return false;
  }
  return true;
}

/* ------------------------------------------------------------------ *
 * 校验（读盘 / 导入）
 * ------------------------------------------------------------------ */

/** 校验问题的机器可读代码（视图拼文案，测试直接断言） */
export type PlotIssueCode = "notObject" | "id" | "kind" | "points" | "point";

/** 一条校验问题（`index` 只在 `code = "point"` 时出现：第几个点坏了） */
export interface PlotIssue {
  code: PlotIssueCode;
  index?: number;
}

/** `validatePlot()` 的结果：`plot` 缺省 = 不可用（`issues` 里说明原因） */
export interface PlotValidation {
  plot?: PlotDocument;
  issues: PlotIssue[];
}

/** 单个点 → 规范化后的点（x 按 kind 归一，y 必须是有限数字） */
function normalisePoint(kind: PlotKind, value: unknown): PlotPoint | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const x = normalizePlotX(kind, record.x);
  const y = record.y;
  if (x === undefined || typeof y !== "number" || !Number.isFinite(y)) return undefined;
  return { x, y };
}

/**
 * 校验一份 plot JSON（`unknown` = `JSON.parse()` 的结果）。
 *
 * 容错口径（坏数据不进视图，但也不让整份文件报废）：
 *  - 不是对象 / `kind` 不认 / `points` 不是数组 → 返回 `issues`，没有 `plot`；
 *  - `id` 缺失或非法 → 用 `fallbackId`（通常是文件名），都不行才算错；
 *  - 单个点坏掉 → 记一条 `{ code: "point", index }` 并跳过它，其余点照常返回；
 *  - 点数超过 `PLOT_POINTS_MAX` → 多出来的丢掉（不重复刷 issue）；
 *  - `name` / `unit` 缺失 → 空串（视图回落到「未命名」/ 不显示单位）。
 *
 * **不排序**：文件里的顺序原样返回，画图前自己调 `sortPoints()`。
 */
export function validatePlot(value: unknown, fallbackId?: string): PlotValidation {
  const issues: PlotIssue[] = [];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { issues: [{ code: "notObject" }] };
  }
  const record = value as Record<string, unknown>;
  const id = isPlotId(record.id) ? record.id : isPlotId(fallbackId) ? fallbackId : undefined;
  if (id === undefined) issues.push({ code: "id" });

  const kind = record.kind;
  if (!isPlotKind(kind)) issues.push({ code: "kind" });

  const rawPoints = record.points;
  if (!Array.isArray(rawPoints)) issues.push({ code: "points" });

  if (id === undefined || !isPlotKind(kind) || !Array.isArray(rawPoints)) return { issues };

  const points: PlotPoint[] = [];
  rawPoints.forEach((item, index) => {
    const point = normalisePoint(kind, item);
    if (point === undefined) {
      issues.push({ code: "point", index });
      return;
    }
    if (points.length >= PLOT_POINTS_MAX) return;
    points.push(point);
  });

  return {
    plot: {
      id,
      name: typeof record.name === "string" ? record.name.trim() : "",
      kind,
      unit: typeof record.unit === "string" ? record.unit.trim() : "",
      points,
    },
    issues,
  };
}

/** plot → 落盘用的 JSON（2 空格缩进 + 结尾换行，便于 git diff / 手改） */
export function plotToJson(plot: PlotDocument): string {
  const body = {
    id: plot.id,
    name: plot.name,
    kind: plot.kind,
    unit: plot.unit,
    points: plot.points.map((point) => ({ x: point.x, y: point.y })),
  };
  return `${JSON.stringify(body, null, 2)}\n`;
}

/* ------------------------------------------------------------------ *
 * 排序 / 坐标域（画图）
 * ------------------------------------------------------------------ */

/**
 * 按 x 正序（`date` 按日历日、`sequence` 按整数）。
 * 同一 x 的多个点保持原相对顺序（`Array#sort` 稳定）；x 非法的点排在最后。
 */
export function sortPoints(kind: PlotKind, points: readonly PlotPoint[]): PlotPoint[] {
  const decorated = points.map((point, index) => ({ point, index, value: plotXValue(kind, point.x) }));
  decorated.sort((a, b) => {
    if (a.value === undefined && b.value === undefined) return a.index - b.index;
    if (a.value === undefined) return 1;
    if (b.value === undefined) return -1;
    if (a.value !== b.value) return a.value - b.value;
    return a.index - b.index;
  });
  return decorated.map((item) => item.point);
}

/** 一段数值区间（`min` 可能等于 `max`：只有一个点 / y 全相同） */
export interface PlotDomain {
  min: number;
  max: number;
}

/** 画图用的一个点（x / y 已经换算成数值） */
export interface PlotEntry {
  /** 原始点 */
  point: PlotPoint;
  /** x 的数值形式（`date` = 日历日序号） */
  x: number;
  y: number;
}

/** `computeScale()` 的结果 */
export interface PlotScale {
  /** x 正序、x 非法 / y 非有限的点已剔除 */
  entries: PlotEntry[];
  /** x 区间（不做留白：首末点落在绘图区左右边界上） */
  x: PlotDomain;
  /** y 区间（上下各留 5% 空白；单点 / 全等值时间距按值域 10% 或 1 撑开） */
  y: PlotDomain;
}

/** y 轴留白：单点 / 全等值时按 `|值| × 10%`（为 0 时给 1）撑开，否则上下各 5% */
function padDomain(min: number, max: number): PlotDomain {
  if (min === max) {
    const span = Math.abs(min) > 0 ? Math.abs(min) * 0.1 : 1;
    return { min: min - span, max: max + span };
  }
  const pad = (max - min) * 0.05;
  return { min: min - pad, max: max + pad };
}

/**
 * 算坐标域：x 用原始值域（`date` 按日历日 → 时间跨度看得见），y 留 5% 空白。
 * 没有可用点时两个区间都是 `0..1`（视图据此只画空坐标框）。
 */
export function computeScale(kind: PlotKind, points: readonly PlotPoint[]): PlotScale {
  const entries: PlotEntry[] = [];
  for (const point of points) {
    const x = plotXValue(kind, point.x);
    if (x === undefined) continue;
    if (typeof point.y !== "number" || !Number.isFinite(point.y)) continue;
    entries.push({ point, x, y: point.y });
  }
  if (entries.length === 0) {
    return { entries, x: { min: 0, max: 1 }, y: { min: 0, max: 1 } };
  }
  let xMin = entries[0].x;
  let xMax = entries[0].x;
  let yMin = entries[0].y;
  let yMax = entries[0].y;
  for (const entry of entries) {
    if (entry.x < xMin) xMin = entry.x;
    if (entry.x > xMax) xMax = entry.x;
    if (entry.y < yMin) yMin = entry.y;
    if (entry.y > yMax) yMax = entry.y;
  }
  return { entries, x: { min: xMin, max: xMax }, y: padDomain(yMin, yMax) };
}

/**
 * 把一个数值映射到 `[start, end]` 像素区间。
 * 域退化（`min === max`）时落在中点 —— 单点图因此仍然画在中间，不会 NaN。
 */
export function projectValue(value: number, domain: PlotDomain, start: number, end: number): number {
  const span = domain.max - domain.min;
  if (!Number.isFinite(span) || span <= 0) return (start + end) / 2;
  return start + ((value - domain.min) / span) * (end - start);
}


/* ------------------------------------------------------------------ *
 * CSV（两列 x,y；只承载 points）
 * ------------------------------------------------------------------ */

/** 一条 CSV 解析问题（行号 1 起算，便于用户回到文件里改） */
export interface PlotCsvError {
  line: number;
  /** `columns` = 不是两列；`x` / `y` = 值不合法；`limit` = 超过 `PLOT_POINTS_MAX` */
  code: "columns" | "x" | "y" | "limit";
}

/** `fromCsv()` 的结果 */
export interface PlotCsvResult {
  /** 解析出来的点（同一 x 后出现的覆盖前面的；不排序，由调用方排序） */
  points: PlotPoint[];
  errors: PlotCsvError[];
}

/** 表头（两列固定 `x,y`；大小写不敏感、允许引号） */
const CSV_HEADER_RE = /^"?x"?\s*,\s*"?y"?$/i;

/**
 * points → CSV 文本：`x,y` 表头 + 每行一个点（`\n` 结尾；date 原样、sequence 整数）。
 * 只写 points —— name / kind / unit 不进去（导入时由 UI 填）。
 */
export function toCsv(kind: PlotKind, points: readonly PlotPoint[]): string {
  const lines = ["x,y"];
  for (const point of sortPoints(kind, points)) {
    const x = normalizePlotX(kind, point.x);
    if (x === undefined) continue;
    lines.push(`${x},${point.y}`);
  }
  return `${lines.join("\n")}\n`;
}

/**
 * CSV 文本 → points。
 *
 * 容错口径：
 *  - 空行跳过；**首个非空行**如果是 `x,y` 表头就跳过（导出文件因此可以直接导回来）；
 *  - 不是恰好两列 → `columns`；x / y 不合法 → `x` / `y`（都带行号，跳过该行）；
 *  - 同一 x 出现多次 → 后出现的覆盖前面的（一个日期只留一个值，避免折线来回折）；
 *  - 超过 `PLOT_POINTS_MAX` → 记一条 `limit` 并停止。
 */
export function fromCsv(kind: PlotKind, text: string): PlotCsvResult {
  const points: PlotPoint[] = [];
  const errors: PlotCsvError[] = [];
  /** x → points 下标（同一 x 后出现的覆盖前面的） */
  const seen = new Map<string, number>();
  let firstDataLine = true;

  const lines = text.split(/\r?\n/);
  for (let index = 0; index < lines.length; index += 1) {
    const line = index + 1;
    const trimmed = lines[index].trim();
    if (trimmed.length === 0) continue;

    if (firstDataLine) {
      firstDataLine = false;
      if (CSV_HEADER_RE.test(trimmed)) continue;
    }

    if (points.length >= PLOT_POINTS_MAX) {
      errors.push({ line, code: "limit" });
      break;
    }

    const parts = trimmed.split(",");
    if (parts.length !== 2) {
      errors.push({ line, code: "columns" });
      continue;
    }
    const x = parsePlotX(kind, parts[0]);
    if (x === undefined) {
      errors.push({ line, code: "x" });
      continue;
    }
    const y = parsePlotY(parts[1]);
    if (y === undefined) {
      errors.push({ line, code: "y" });
      continue;
    }

    const key = String(x);
    const existing = seen.get(key);
    if (existing !== undefined) {
      points[existing] = { x, y };
      continue;
    }
    seen.set(key, points.length);
    points.push({ x, y });
  }

  return { points, errors };
}
