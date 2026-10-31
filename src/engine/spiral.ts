/**
 * 365 天 emo 小工具的螺旋引擎（Phase 18 ④-A；契约见
 * doc/datacontact/data_ixd_discuss_interact_v0.18.md）。
 *
 * 纯函数、零 Obsidian 依赖、可直接 `node --test`。视图（`views/emoWidget.ts`）只拿这里的
 * 「格号 ↔ 坐标 ↔ 日期」三件套去画，不自己算几何。
 *
 * 几何（20×20 网格，坐标**1 起算**：第 x 行第 y 列）：
 *  - 中心 `(8,8)`~`(13,13)` 是 6×6 的「今日见闻」大块（36 格）；
 *  - 其余 364 格 = 7 环螺旋，第 `i` 格从中心下沿起逆时针外扩，`i` 越大越旧；
 *  - 每环单边步数 `m = 2r + 5`，累计 `cum(r) = 4r(r + 6)` → 28 / 64 / 108 / 160 / 220 / 288 / 364。
 *
 * 为什么用通用公式而不是硬编码文档里那 28 条逐格公式：7 环 × 4 边要写 28 行，
 * 通用公式只有 1 组分支，且 `spiralCell()` 的单测直接拿文档锚点做回归。
 */

import { formatLocalDate } from "./time.ts";

/** 螺旋格总数（中心 6×6 之外的全部格子 = 400 − 36） */
export const SPIRAL_TOTAL = 364;

/** 网格边长（20×20） */
export const SPIRAL_GRID = 20;

/** 中心「今日见闻」块：1 起算的行列起止（含端点）—— 即 `(8,8)`~`(13,13)` */
export const SPIRAL_CENTER_START = 8;
export const SPIRAL_CENTER_END = 13;

/** 环数（7 环刚好铺满 20×20 去掉中心 6×6） */
export const SPIRAL_RINGS = 7;

/** 配色数（红 / 橙 / 绿 / 蓝 / 紫 / 粉） */
export const EMO_COLOR_COUNT = 6;

/** 糖果主题的角度档数（10°…180°，每档 10°） */
export const EMO_ANGLE_COUNT = 18;

/**
 * emo 独立主题（Phase 19 M1 ①）：数组顺序 = 画布上方「灵动岛」按钮的循环顺序。
 * key 与 styles.css 的 `.wf-emo--<theme>` 一一对应，**不进** `[data-wf-theme]`。
 */
export const EMO_THEMES = ["default", "weave", "candy"] as const;

/** 主题 key（`default / weave / candy`） */
export type EmoTheme = (typeof EMO_THEMES)[number];

/** 主题缺省值 */
export const EMO_THEME_DEFAULT: EmoTheme = "default";

/** 主题白名单校验：不认识的值一律回落 `default`（手改 data.json 也不会把画布撑坏） */
export function normalizeEmoTheme(value: unknown): EmoTheme {
  return typeof value === "string" && (EMO_THEMES as readonly string[]).includes(value)
    ? (value as EmoTheme)
    : EMO_THEME_DEFAULT;
}

/** 螺旋里的一格（1 起算的 `x` 行 / `y` 列） */
export interface SpiralPoint {
  x: number;
  y: number;
}

/** 螺旋落位结果（视图按 `cell` 摆格子，按 `ring` 调不透明度） */
export interface SpiralSlot extends SpiralPoint {
  /** 格号（1..364；1 = 昨天，364 = 一年前） */
  index: number;
  /** 环号（1..7） */
  ring: number;
}

/** 带日期的落位（视图画格子的唯一输入） */
export interface SpiralDateSlot extends SpiralSlot {
  /** `YYYY-MM-DD`（本地日期） */
  date: string;
}

/**
 * 第 `ring` 环走完后的累计格数：`4r(r + 6)`。
 * `0` → 0、`1` → 28、`2` → 64、…、`7` → 364；非整数 / 负数按 0 处理。
 */
export function spiralCumulative(ring: number): number {
  if (!Number.isInteger(ring) || ring < 0) return 0;
  return 4 * ring * (ring + 6);
}

/** 格号 → 环号（1..7）；越界 / 非整数返回 undefined */
export function spiralRing(index: number): number | undefined {
  if (!Number.isInteger(index) || index < 1 || index > SPIRAL_TOTAL) return undefined;
  for (let ring = 1; ring <= SPIRAL_RINGS; ring += 1) {
    if (index <= spiralCumulative(ring)) return ring;
  }
  return undefined;
}

/**
 * 格号 → 1 起算坐标。越界 / 非整数返回 undefined。
 *
 * 第 `r` 环：`m = 2r + 5`（单边格数）、`j = i − cum(r−1) − 1`（环内 0 起算序号）、
 * 起点 `(x0, y0) = (9 − r, 13 + r)`（中心下沿偏右一格），四段依次是
 * 下边向右 → 右边向上 → 上边向左 → 左边向下。
 */
export function spiralCell(index: number): SpiralPoint | undefined {
  const ring = spiralRing(index);
  if (ring === undefined) return undefined;
  const side = 2 * ring + 5;
  const offset = index - spiralCumulative(ring - 1) - 1;
  const x0 = 9 - ring;
  const y0 = 13 + ring;
  if (offset < side) return { x: x0 + offset, y: y0 };
  if (offset < 2 * side) return { x: x0 + side - 1, y: y0 - 1 - (offset - side) };
  if (offset < 3 * side) return { x: x0 + side - 2 - (offset - 2 * side), y: y0 - side };
  return { x: x0 - 1, y: y0 - side + 1 + (offset - 3 * side) };
}

/** 全部 364 格（按格号升序；结果缓存，调用方只读） */
const SLOTS: readonly SpiralSlot[] = (() => {
  const list: SpiralSlot[] = [];
  for (let index = 1; index <= SPIRAL_TOTAL; index += 1) {
    const cell = spiralCell(index);
    const ring = spiralRing(index);
    if (cell === undefined || ring === undefined) continue;
    list.push({ index, ring, x: cell.x, y: cell.y });
  }
  return list;
})();

/** 全部 364 格（`index` / `ring` / `x` / `y`） */
export function spiralSlots(): readonly SpiralSlot[] {
  return SLOTS;
}

/**
 * `YYYY-MM-DD` 加减天数（本地日历口径，与 `time.ts` 的 `toDateOnly` 一致 —— 不做 UTC 换算，
 * 也不用 `± n*86400000` 毫秒：夏令时会错位一整天）。
 * 入参不是合法日期时返回 undefined。
 */
export function shiftDate(date: string, days: number): string | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date);
  if (!match || !Number.isInteger(days)) return undefined;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const base = new Date(year, month - 1, day);
  // 造出来的日期被日历「进/借位」过（如 2026-02-30）→ 不是真实日期
  if (base.getFullYear() !== year || base.getMonth() !== month - 1 || base.getDate() !== day) return undefined;
  base.setDate(base.getDate() + days);
  return formatLocalDate(base);
}

/**
 * 364 天的落位：`i` 对应「今天 − i 天」（`i = 1` 是昨天）。
 *
 * `today` 缺省取本地今天；不是合法 `YYYY-MM-DD` 时返回空数组（视图据此只画灰格）。
 */
export function spiralDates(today: string = formatLocalDate()): SpiralDateSlot[] {
  const list: SpiralDateSlot[] = [];
  for (const slot of SLOTS) {
    const date = shiftDate(today, -slot.index);
    if (date === undefined) return [];
    list.push({ ...slot, date });
  }
  return list;
}

/**
 * 某天固定用的颜色下标（0..5）：FNV-1a 32 位散列 `% 6`。
 * 同一日期永远同一色（不随渲染次数 / 顺序变化）；6 色在 364 天里分布基本均匀。
 */
export function emoColorIndex(date: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < date.length; i += 1) {
    hash ^= date.charCodeAt(i);
    // FNV 素数 16777619；`>>> 0` 保证留在 32 位无符号
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash % EMO_COLOR_COUNT;
}

/**
 * 某天固定用的糖果角度下标（0..17）：djb2 32 位散列 `% 18`。
 *
 * 与 `emoColorIndex` **不同源**（djb2 vs FNV-1a）—— 颜色与角度互不相关，
 * 避免「同色必同角度」的规律感。`i` → `(i + 1) * 10°`，即 10°…180°。
 */
export function emoAngleIndex(date: string): number {
  let hash = 5381;
  for (let i = 0; i < date.length; i += 1) {
    // djb2：`hash * 33 + c`（`Math.imul` 防溢出，`>>> 0` 留在 32 位无符号）
    hash = (Math.imul(hash, 33) + date.charCodeAt(i)) >>> 0;
  }
  return hash % EMO_ANGLE_COUNT;
}
