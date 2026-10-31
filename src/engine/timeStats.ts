/**
 * 计时聚合（Phase 3，只读）：`aggregateTimeEntries` + 近 `days` 天方块阵的数据（窗口由调用方传：默认 30，视图 Phase 3 v0.6 传 21）。
 *
 * 口径（doc/datacontact/data_ixd_phase3_contract.md §6 / §7.2）：
 *  - `activeEntry`：全文件**最新一条**「有 `startAt` 且无 `endAt`」的条目（**文件级单例**，供正计时器）；
 *  - `dailyStats`：只累加**有 `hours`** 的条目，按 `entry.date` 分组（跨零点整段计入开始那天，不拆分）；
 *  - `hours` / `totalHours` 一律 `Math.round(x*10)/10`（1 位小数，规避浮点尾巴）；
 *  - 方块阵：近 `days` 天（含今天，默认 30）**本地日历**逐日回退（禁用 `now - i*86400000`，DST 会错位）。
 *
 * Phase 5 ①（甘特图；契约见 doc/datacontact/data_ixd_discuss_interact_v0.4.md《Phase 5 定稿契约》）：
 *  - `DailyStat.spans`：与 `dailyStats` **同一遍扫描**顺手算出的槽区间（10 分钟一格，一天 144 格）；
 *  - 只画**已完成**条目（有 `hours`）；跨零点 → 裁到 24:00（完整区间留在 `startAt` / `endAt` 里给悬浮提示）；
 *  - `buildGantt(aggregate, now, days = 21)`：近 N 天**每天一行**（没记录的日期也出行，只是槽为空）。
 *
 * 与 `stats.ts` 同风格：纯函数、不依赖 obsidian、可直接 `node --test`；
 * 坏数据（`startAt` 无法解析等）一律**跳过该条**，不抛错（契约 §10.5）。
 */

import { formatLocalDate, parseIso, toDateOnly } from "./time.ts";
import { walkNodes } from "./tree.ts";
import type { WfJsonDocument, WfNode, WfTimeEntry, WfWorkflow } from "./types.ts";

/** 正在计时的条目（供「状态总览」的正计时器 + 右键「结束并记录 / 丢弃」定位） */
export interface ActiveTimer {
  workflowId: string;
  nodeId: string;
  nodeTitle: string;
  /** 该条目在 `node.timeEntries` 里的下标（写回时用） */
  entryIndex: number;
  startAt: string;
}

/** 某天里某个 workflow 的耗时 */
export interface WorkflowHours {
  workflowId: string;
  title: string;
  hours: number;
}

/** 按 `date` 聚合的一天 */
export interface DailyStat {
  /** YYYY-MM-DD（= `entry.date`） */
  date: string;
  /** 当天条目 `hours` 之和（1 位小数） */
  totalHours: number;
  /** 按 workflow 归并的耗时（保持 `workflows[]` 文档顺序） */
  byWorkflow: WorkflowHours[];
  /** 当天每一条已完成条目在时间轴上的落点（Phase 5 ①：甘特图；按文档顺序） */
  spans: GanttSpan[];
}

/** 只读聚合结果 */
export interface TimeAggregate {
  /** 全文件最新的一条进行中条目；没有进行中的计时时缺省 */
  activeEntry?: ActiveTimer;
  /** date → 当天统计（只含已完成条目；没有记录的日期不会凭空出现） */
  dailyStats: Map<string, DailyStat>;
}

/** 1 位小数（有意不用 toFixed：那是字符串往返，容易带回浮点尾巴） */
function roundHours(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * 聚合文档内的全部计时条目（只读，不改数据）。
 *
 * - 进行中判定：`startAt` 存在且 `endAt` **缺省**（v1.3 约定「空值省略」，不写 `null`）；
 * - 并列（两条 startAt 完全相同）时取**文档靠后**的那条；
 * - 无法解析 `startAt` 的脏数据跳过（计时器不该因为一条坏数据整体消失）；
 * - `date` 缺省时按 `toDateOnly(startAt)` 派生（老数据 / 手写数据兼容）。
 */
export function aggregateTimeEntries(document: WfJsonDocument): TimeAggregate {
  const dailyStats = new Map<string, DailyStat>();
  let active: (ActiveTimer & { startMs: number }) | undefined;
  // Phase 8：甘特图按工作流着色 → 先记下每个 workflow 在文档里的下标（> 6 由视图取模循环）
  const workflowIndexById = new Map<string, number>(
    document.workflows.map((workflow, index) => [workflow.id, index]),
  );

  for (const visit of walkNodes(document)) {
    const { node, workflow } = visit;
    const entries = node.timeEntries ?? [];
    entries.forEach((entry, index) => {
      const startAt = typeof entry.startAt === "string" ? entry.startAt : "";

      // 1) 进行中：有 startAt 且无 endAt → 候选计时器（不计入方块阵）
      if (startAt.length > 0 && entry.endAt === undefined) {
        const startMs = parseIso(startAt);
        if (startMs === undefined) return;
        if (active === undefined || startMs >= active.startMs) {
          active = {
            workflowId: workflow.id,
            nodeId: node.id,
            nodeTitle: node.title,
            entryIndex: index,
            startAt,
            startMs,
          };
        }
        return;
      }

      // 2) 方块阵：只累加有 hours 的条目（进行中 / 脏数据没有 hours）
      const hours = typeof entry.hours === "number" && Number.isFinite(entry.hours) ? roundHours(entry.hours) : undefined;
      if (hours === undefined) return;
      const date = entry.date !== undefined && entry.date.length > 0
        ? entry.date
        : startAt.length > 0
          ? toDateOnly(startAt)
          : "";
      if (date.length === 0) return;

      let stat = dailyStats.get(date);
      if (stat === undefined) {
        stat = { date, totalHours: 0, byWorkflow: [], spans: [] };
        dailyStats.set(date, stat);
      }
      stat.totalHours = roundHours(stat.totalHours + hours);
      const bucket = stat.byWorkflow.find((item) => item.workflowId === workflow.id);
      if (bucket === undefined) stat.byWorkflow.push({ workflowId: workflow.id, title: workflow.title, hours });
      else bucket.hours = roundHours(bucket.hours + hours);

      // 3) 甘特图（Phase 5 ①）：同一遍扫描顺手算槽区间（画不出来的条目只是不画，不影响 hours 累加）
      const span = ganttSpanOf(entry, workflow, node, hours, workflowIndexById.get(workflow.id) ?? 0);
      if (span !== undefined) stat.spans.push(span);
    });
  }

  const aggregate: TimeAggregate = { dailyStats };
  if (active !== undefined) {
    aggregate.activeEntry = {
      workflowId: active.workflowId,
      nodeId: active.nodeId,
      nodeTitle: active.nodeTitle,
      entryIndex: active.entryIndex,
      startAt: active.startAt,
    };
  }
  return aggregate;
}

/**
 * 「已完成时间」合计（Phase 18 ⑧：节点卡片第 3 段的 `done` 分支）。
 *
 * 与视图里那份 `totalHours()`（归档行仍用）的差别只有一处：**只累计有 `endAt` 的会话**。
 * 进行中的那条按 v1.3 约定省略 `endAt`（顺带省略 `hours`），但手写 / 老数据里
 * 可能有「有 hours 却没 endAt」的脏行 —— 那种行不算「已完成」，卡片上不该显示。
 *
 * 一条都凑不出来（空数组 / 全部没 endAt）返回 `undefined`，调用方据此不渲染那一段。
 */
export function completedHours(entries: readonly WfTimeEntry[] | undefined): number | undefined {
  if (entries === undefined || entries.length === 0) return undefined;
  let sum = 0;
  let counted = 0;
  for (const entry of entries) {
    if (typeof entry.endAt !== "string" || entry.endAt.length === 0) continue;
    if (typeof entry.hours !== "number" || !Number.isFinite(entry.hours)) continue;
    sum += entry.hours;
    counted += 1;
  }
  return counted === 0 ? undefined : roundHours(sum);
}

/* ------------------------------------------------------------------ *
 * 近 days 天方块阵（§7.2；窗口由调用方传：默认 30，视图 Phase 3 v0.6 传 21）
 * ------------------------------------------------------------------ */

/** 方块阵档位（固定阈值 → `.wf-heat--l0` … `.wf-heat--l4`） */
export type HeatLevel = 0 | 1 | 2 | 3 | 4;

/** 阈值（档位 → 颜色的映射在 styles.css）：0 / (0,1] / (1,3] / (3,6] / >6 = 最深 */
export function heatLevel(totalHours: number): HeatLevel {
  if (!(totalHours > 0)) return 0;
  if (totalHours <= 1) return 1;
  if (totalHours <= 3) return 2;
  if (totalHours <= 6) return 3;
  return 4;
}

/** 本地星期序号（**0=周一** … 6=周日）；日期串无法解析时按周一处理 */
export function weekdayIndex(date: string): number {
  const ms = parseIso(date);
  if (ms === undefined) return 0;
  return (new Date(ms).getDay() + 6) % 7;
}

/**
 * 近 `days` 天的 date key（含今天，**最旧在前**）。
 * 用本地日历逐日回退（`new Date(y, m, d - i)`），不用 `now - i*86400000`：夏令时切换那两天会错位。
 */
export function recentDateKeys(now: Date = new Date(), days = 30): string[] {
  const keys: string[] = [];
  for (let back = days - 1; back >= 0; back -= 1) {
    keys.push(formatLocalDate(new Date(now.getFullYear(), now.getMonth(), now.getDate() - back)));
  }
  return keys;
}

/** 方块阵的一格（无记录的日期也会给出 `l0` 格子） */
export interface HeatmapCell {
  date: string;
  /** 0=周一 … 6=周日（列内自上而下的行号：周一在顶） */
  weekday: number;
  totalHours: number;
  level: HeatLevel;
  byWorkflow: WorkflowHours[];
}

/** 构造近 `days` 天方块阵（含今天；最旧在最前，视图按 7 天一周切列 → 最新在最右列） */
export function buildHeatmap(aggregate: TimeAggregate, now: Date = new Date(), days = 30): HeatmapCell[] {
  return recentDateKeys(now, days).map((date) => {
    const stat = aggregate.dailyStats.get(date);
    const totalHours = stat?.totalHours ?? 0;
    return {
      date,
      weekday: weekdayIndex(date),
      totalHours,
      level: heatLevel(totalHours),
      byWorkflow: stat?.byWorkflow ?? [],
    };
  });
}

/* ------------------------------------------------------------------ *
 * 甘特图（Phase 5 ①；契约见 data_ixd_discuss_interact_v0.4.md《Phase 5 定稿契约》）
 *
 * 一行 = 一天（近 `days` 天，含今天，最旧在最前），行内是**一条时间线**：10 分钟一格（24h = 144 格），
 * 高亮当天「已计入工作时长」的时段 —— 用来一眼看出自己的作息（几点开工、几点收工、中间断了几段）。
 *
 * 口径：
 *  - 只画**已完成**条目（有 `hours`）：进行中的那条由正计时器块展示，不在这里画半截；
 *  - 槽位 = `[floor(startMin/10), ceil(endMin/10)]`（两端各向外取整，宁可多画 10 分钟不留缝）；
 *  - **跨零点裁到 24:00**：`endMin <= startMin` 时结束按 1440 分钟算（完整区间留在 `startAt` / `endAt`）；
 *  - 脏数据（缺 `endAt` / 解析不了 / 结束早于开始 / 零长）→ **不画**，但它的 `hours` 照样进方块阵。
 * ------------------------------------------------------------------ */

/** 甘特图一格 = 10 分钟 */
export const GANTT_SLOT_MINUTES = 10;

/** 一天 = 24h / 10min = 144 格 */
export const GANTT_SLOTS_PER_DAY = 144;

/** 时间刻度文字的间隔（小时）：格子是 10 分钟，但只有 00 / 02 / … / 22 写数字 */
export const GANTT_TICK_HOURS = 2;

/** 时间轴上的一段高亮（= 一条已完成计时条目） */
export interface GanttSpan {
  /** 起始槽（0 … 143；跨零点时结束已裁到 24:00） */
  start: number;
  /** 覆盖的槽数（≥ 1） */
  slots: number;
  /** 开始时刻在**开始那天**的分钟数（0 … 1439，本地） */
  startMinute: number;
  /** 结束时刻的分钟数（0 … 1439，本地；跨零点时是次日的时间，用于悬浮提示） */
  endMinute: number;
  /** 是否跨过零点（这一段的尾巴被裁掉了，提示里要说清） */
  crossesMidnight: boolean;
  /** 本次时长（小时，1 位小数） */
  hours: number;
  workflowTitle: string;
  nodeTitle: string;
  /**
   * 该条目所属 workflow 在 `document.workflows[]` 里的下标（Phase 8：甘特图按工作流着色）。
   * 视图侧取 `% 6` 映射到主题的 6 种时间色，超过 6 个工作流时循环。
   */
  workflowIndex: number;
  /** 原始时间串（悬浮提示里给完整区间） */
  startAt: string;
  endAt: string;
}

/** 甘特图的一行（= 一天） */
export interface GanttRow {
  /** YYYY-MM-DD */
  date: string;
  /** 0=周一 … 6=周日 */
  weekday: number;
  /** 当天条目 `hours` 之和（1 位小数；与方块阵同口径） */
  totalHours: number;
  /** 当天的高亮段（按文档顺序；没记录时是空数组，但**这一行照样渲染**） */
  spans: GanttSpan[];
}

/** 本地「当天第几分钟」（0-1439） */
function minuteOfDay(ms: number): number {
  const date = new Date(ms);
  return date.getHours() * 60 + date.getMinutes();
}

/**
 * 一条已完成条目 → 甘特图的一段（画不出来时返回 undefined）。
 * 见本节顶部注释的槽位 / 跨零点 / 脏数据口径。
 */
function ganttSpanOf(
  entry: WfTimeEntry,
  workflow: WfWorkflow,
  node: WfNode,
  hours: number,
  workflowIndex: number,
): GanttSpan | undefined {
  const startAt = typeof entry.startAt === "string" ? entry.startAt : "";
  const endAt = typeof entry.endAt === "string" ? entry.endAt : "";
  if (startAt.length === 0 || endAt.length === 0) return undefined;
  const startMs = parseIso(startAt);
  const endMs = parseIso(endAt);
  if (startMs === undefined || endMs === undefined || endMs <= startMs) return undefined;

  const startMinute = minuteOfDay(startMs);
  const endMinute = minuteOfDay(endMs);
  const crossesMidnight = endMinute <= startMinute;
  const clipEnd = crossesMidnight ? GANTT_SLOT_MINUTES * GANTT_SLOTS_PER_DAY : endMinute;
  const start = Math.floor(startMinute / GANTT_SLOT_MINUTES);
  const end = Math.ceil(clipEnd / GANTT_SLOT_MINUTES);
  return {
    start,
    slots: Math.max(end - start, 1),
    startMinute,
    endMinute,
    crossesMidnight,
    hours,
    workflowTitle: workflow.title,
    nodeTitle: node.title,
    workflowIndex,
    startAt,
    endAt,
  };
}

/** 分钟数 → `HH:MM`（甘特图刻度 / 悬浮提示共用；1440 → `24:00`） */
export function formatMinuteOfDay(minute: number): string {
  const clamped = Math.min(Math.max(Math.round(minute), 0), GANTT_SLOT_MINUTES * GANTT_SLOTS_PER_DAY);
  const hour = Math.floor(clamped / 60);
  const rest = clamped % 60;
  return `${hour < 10 ? "0" : ""}${hour}:${rest < 10 ? "0" : ""}${rest}`;
}

/** 时间刻度（小时数）：`00 / 02 / … / 22`（默认每 GANTT_TICK_HOURS 小时一个） */
export function ganttTickHours(stepHours = GANTT_TICK_HOURS): number[] {
  const step = stepHours > 0 ? stepHours : GANTT_TICK_HOURS;
  const ticks: number[] = [];
  for (let hour = 0; hour < 24; hour += step) ticks.push(hour);
  return ticks;
}

/**
 * 构造近 `days` 天甘特图（含今天；**最旧在最前**，与方块阵同一个窗口口径）。
 * 没记录的日期也会出一行（槽为空）—— 「哪几天没干活」本身就是信息。
 */
export function buildGantt(aggregate: TimeAggregate, now: Date = new Date(), days = 21): GanttRow[] {
  return recentDateKeys(now, days).map((date) => {
    const stat = aggregate.dailyStats.get(date);
    return {
      date,
      weekday: weekdayIndex(date),
      totalHours: stat?.totalHours ?? 0,
      spans: stat?.spans ?? [],
    };
  });
}
