/**
 * 4 象限节点（Phase 19 M2；契约见 doc/datacontact/data_ixd_discuss_interact_v0.19.md §M2）。
 *
 * 只读聚合：把当前文件里「还没结束」的节点按 `urgency × importance` 摊到 16 个分区，
 * 供 `views/quadrantWidget.ts` 画「重要-紧急」斜俯视图 + 右侧预览。**不写任何数据**
 * （wfjson schema 不变，视图也不碰 vault）。
 *
 * 口径：
 *  - 数据源 = `walkWorkflow()` 全量节点（含子节点），`status ∈ {todo, doing}`；
 *  - `importance` / `urgency` 必须都是 **1–4 的整数**，缺任一字段 / 越界 / 非整数 → 不入统计；
 *  - 象限配色（契约表为准，不看坐标轴正负号）：
 *      importance 3-4 且 urgency 3-4 → 红（重要且紧急）；
 *      importance 3-4 且 urgency 1-2 → 橙（重要且不紧急）；
 *      importance 1-2 且 urgency 1-2 → 绿（不重要且不紧急）；
 *      importance 1-2 且 urgency 3-4 → 蓝（不重要且紧急）；
 *  - 分区内节点按 `startAt` 正序（**没有 / 解析不出 `startAt` 的排在最后**，彼此保持文档顺序）；
 *  - `startHours` = 开始距今的小时数（1 位小数，未来时间按 0 算）；
 *  - `recordedHours` = `completedHours()` 口径（只累加有 `endAt` 且有 `hours` 的会话），没有就是 0；
 *  - `fillLevel` = `min(节点数, 5)`（0 = 空分区，视图画虚线描边、不填色）。
 *
 * 纯函数、零 Obsidian 依赖、可直接 `node --test`。
 */

import { parseIso } from "./time.ts";
import { completedHours } from "./timeStats.ts";
import { walkNodes } from "./tree.ts";
import type { NodeStatus, WfJsonDocument, WfNode, WfWorkflow } from "./types.ts";

/** 象限主题色（与 styles.css 的 `.wf-quad-partition--<color>` 一一对应） */
export type QuadrantColor = "red" | "orange" | "green" | "blue";

/** 16 分区（urgency 1-4 × importance 1-4） */
export const QUADRANT_PARTITION_COUNT = 16;

/** 填充档位上限：1~4 个任务各一档，5 个及以上都算第 5 档 */
export const QUADRANT_FILL_MAX = 5;

/** 预览里的一行节点（引擎侧就把时间算好，视图只负责格式化 / 拼文案） */
export interface QuadrantNode {
  nodeId: string;
  title: string;
  workflowId: string;
  workflowTitle: string;
  /** 只会有 `todo` / `doing`（其余状态在聚合前就被筛掉） */
  status: NodeStatus;
  /** 原始开始时间（缺省 = 还没开始） */
  startAt?: string;
  /** 开始距今的小时数（1 位小数；没开始 / 解析不出 = 0） */
  startHours: number;
  /** 已记录的小时数（只算已结束的会话，1 位小数；没有 = 0） */
  recordedHours: number;
}

/** 一个分区（x = urgency，y = importance） */
export interface QuadrantPartition {
  /** 1-4（x 轴，越大越紧急） */
  urgency: number;
  /** 1-4（y 轴，越大越重要） */
  importance: number;
  quadrant: QuadrantColor;
  /** 该分区的节点（`startAt` 正序，未开始的在最后） */
  nodes: QuadrantNode[];
  /** 填充档位 0-5（0 = 空分区） */
  fillLevel: number;
}

/** `quadrantStats()` 的结果 */
export interface QuadrantStats {
  /**
   * 恒为 16 项，顺序 = **importance 从 4 到 1（上→下）、urgency 从 1 到 4（左→右）**，
   * 与视图的网格排列一致，直接 `for (const partition of stats.partitions)` 即可。
   */
  partitions: QuadrantPartition[];
  /** 进入统计的节点总数（各分区 `nodes.length` 之和） */
  totalNodes: number;
}

/** 1-4 的整数才参与统计（缺字段 / 越界 / 小数一律不算） */
export function isValidScale(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 4;
}

/**
 * 象限配色（契约表）：
 * 重要 3-4 / 紧急 3-4 = 红；重要 3-4 / 紧急 1-2 = 橙；
 * 不重要 1-2 / 不紧急 1-2 = 绿；不重要 1-2 / 紧急 3-4 = 蓝。
 * 任一轴不是 1-4 的整数 → undefined（调用方据此跳过）。
 */
export function quadrantColor(importance: number, urgency: number): QuadrantColor | undefined {
  if (!isValidScale(importance) || !isValidScale(urgency)) return undefined;
  const important = importance >= 3;
  const urgent = urgency >= 3;
  if (important) return urgent ? "red" : "orange";
  return urgent ? "blue" : "green";
}

/** 1 位小数（与引擎其它聚合同口径，规避浮点尾巴） */
function roundHours(value: number): number {
  return Math.round(value * 10) / 10;
}

/** 开始距今的小时数：解析不出 / 未来时间 → 0 */
function hoursSince(startAt: string | undefined, nowMs: number): number {
  if (startAt === undefined || startAt.length === 0) return 0;
  const startMs = parseIso(startAt);
  if (startMs === undefined) return 0;
  return roundHours(Math.max(0, (nowMs - startMs) / 3_600_000));
}

/** 一个节点 → 预览行（时间一次性算好） */
function nodeInfoOf(node: WfNode, workflow: WfWorkflow, nowMs: number): QuadrantNode {
  const info: QuadrantNode = {
    nodeId: node.id,
    title: node.title,
    workflowId: workflow.id,
    workflowTitle: workflow.title,
    status: node.status,
    startHours: hoursSince(node.startAt, nowMs),
    recordedHours: completedHours(node.timeEntries) ?? 0,
  };
  if (node.startAt !== undefined && node.startAt.length > 0) info.startAt = node.startAt;
  return info;
}

/** `startAt` 正序；没有 / 解析不出的排最后（稳定排序 → 彼此保持文档顺序） */
function compareNodes(a: QuadrantNode, b: QuadrantNode): number {
  const aMs = a.startAt === undefined ? undefined : parseIso(a.startAt);
  const bMs = b.startAt === undefined ? undefined : parseIso(b.startAt);
  if (aMs === undefined && bMs === undefined) return 0;
  if (aMs === undefined) return 1;
  if (bMs === undefined) return -1;
  return aMs - bMs;
}

/**
 * 聚合 16 个分区（只读）。坏数据一律跳过，不抛错：
 * 只要 `importance` / `urgency` 缺一个、或者不是 1-4 的整数，这个节点就不进小工具。
 */
export function quadrantStats(document: WfJsonDocument, now: Date = new Date()): QuadrantStats {
  const buckets = new Map<string, QuadrantPartition>();
  // 顺序即渲染顺序：上（importance 4）→ 下（1），左（urgency 1）→ 右（4）
  for (let importance = 4; importance >= 1; importance -= 1) {
    for (let urgency = 1; urgency <= 4; urgency += 1) {
      const color = quadrantColor(importance, urgency);
      if (color === undefined) continue;
      buckets.set(`${urgency}-${importance}`, {
        urgency,
        importance,
        quadrant: color,
        nodes: [],
        fillLevel: 0,
      });
    }
  }

  const nowMs = now.getTime();
  let totalNodes = 0;
  for (const { node, workflow } of walkNodes(document)) {
    if (node.status !== "todo" && node.status !== "doing") continue;
    const color = quadrantColor(node.importance ?? Number.NaN, node.urgency ?? Number.NaN);
    if (color === undefined) continue;
    const partition = buckets.get(`${node.urgency}-${node.importance}`);
    if (partition === undefined) continue;
    partition.nodes.push(nodeInfoOf(node, workflow, nowMs));
    totalNodes += 1;
  }

  const partitions = [...buckets.values()];
  for (const partition of partitions) {
    partition.nodes.sort(compareNodes);
    partition.fillLevel = Math.min(partition.nodes.length, QUADRANT_FILL_MAX);
  }
  return { partitions, totalNodes };
}
