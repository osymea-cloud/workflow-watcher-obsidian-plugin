/**
 * 开始 / 完成记录（Phase 28 M3）。
 *
 * 从 wfjson 派生两份时间线：完成记录（`status === "done"`）与开始记录（有开始时间），
 * 各自按时间倒序。纯只读、不改任何数据；时间 / 耗时**精确到小时**
 * （契约见 `doc/datacontact/phase28_bound.md` §5）。
 *
 * 派生口径：
 *  - `earliestStartMs`  = min(`startAt`, 任一 `timeEntries[].startAt`)；
 *  - `latestCompletionMs` = max(`completedAt`, 任一 `timeEntries[].endAt`)；
 *  - 单节点耗时 = `latestCompletionMs − earliestStartMs`（任一缺失 = 无耗时）。
 */

import { parseIso } from "./time.ts";
import { walkSubtree, walkWorkflow } from "./tree.ts";
import {
  UNCLASSIFIED_WORKFLOW_ID,
  type WfJsonDocument,
  type WfNode,
  type WfWorkflow,
} from "./types.ts";

export interface NodeRecord {
  node: WfNode;
  workflow: WfWorkflow;
  /** 最早开始（毫秒；`startAt` 或任一 `timeEntries[].startAt` 的最早值） */
  earliestStartMs?: number;
  /** 最晚完成（毫秒；`completedAt` 或任一 `timeEntries[].endAt` 的最晚值） */
  latestCompletionMs?: number;
}

export interface NodeRecordSet {
  /** 完成记录：`status === "done"` 且有完成时间，按 `latestCompletionMs` 倒序 */
  completed: NodeRecord[];
  /** 开始记录：有开始时间，按 `earliestStartMs` 倒序 */
  started: NodeRecord[];
}

/** 取一个节点的时间边界（无法解析的时间串一律忽略） */
function boundsOf(node: WfNode): {
  earliestStartMs?: number;
  latestCompletionMs?: number;
} {
  let earliestStartMs: number | undefined;
  let latestCompletionMs: number | undefined;

  const considerStart = (value: string | undefined): void => {
    if (value === undefined) return;
    const ms = parseIso(value);
    if (ms === undefined) return;
    if (earliestStartMs === undefined || ms < earliestStartMs) earliestStartMs = ms;
  };
  const considerEnd = (value: string | undefined): void => {
    if (value === undefined) return;
    const ms = parseIso(value);
    if (ms === undefined) return;
    if (latestCompletionMs === undefined || ms > latestCompletionMs) latestCompletionMs = ms;
  };

  considerStart(node.startAt);
  considerEnd(node.completedAt);
  for (const entry of node.timeEntries ?? []) {
    considerStart(entry.startAt);
    considerEnd(entry.endAt);
  }
  return { earliestStartMs, latestCompletionMs };
}

/**
 * 从 wfjson 派生两份时间线（跳过未分类伪流的隐藏 root；纯只读）。
 *
 * 一个节点可以同时出现在两列（既开始过、也完成了）；隐藏 root 本身不进任何一列。
 */
export function collectNodeRecords(document: WfJsonDocument): NodeRecordSet {
  const records: NodeRecord[] = [];
  for (const workflow of document.workflows) {
    const visits =
      workflow.id === UNCLASSIFIED_WORKFLOW_ID
        ? walkSubtree(Array.isArray(workflow.root.children) ? workflow.root.children : [], workflow)
        : walkWorkflow(workflow);
    for (const visit of visits) {
      records.push({ node: visit.node, workflow, ...boundsOf(visit.node) });
    }
  }

  const completed = records
    .filter((record) => record.node.status === "done" && record.latestCompletionMs !== undefined)
    .sort((a, b) => (b.latestCompletionMs ?? 0) - (a.latestCompletionMs ?? 0));
  const started = records
    .filter((record) => record.earliestStartMs !== undefined)
    .sort((a, b) => (b.earliestStartMs ?? 0) - (a.earliestStartMs ?? 0));
  return { completed, started };
}

/** 单节点耗时（`latestCompletionMs − earliestStartMs`）；任一缺失 / 负数返回 undefined */
export function recordDurationMs(record: NodeRecord): number | undefined {
  if (record.earliestStartMs === undefined || record.latestCompletionMs === undefined) return undefined;
  const span = record.latestCompletionMs - record.earliestStartMs;
  return span >= 0 ? span : undefined;
}

/** 毫秒时间戳 → `YYYY-MM-DD HH:00`（本地时区，精确到小时）；无效值返回空串 */
export function formatHourStamp(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms)) return "";
  const date = new Date(ms);
  const pad = (value: number): string => `${value}`.padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:00`;
}

/** 毫秒时长 → `XdXh` / `Xh`（**向下取整到小时**）；undefined / 负数返回空串 */
export function formatHourSpan(ms: number | undefined): string {
  if (ms === undefined || !Number.isFinite(ms) || ms < 0) return "";
  const totalHours = Math.floor(ms / 3_600_000);
  const days = Math.floor(totalHours / 24);
  const hours = totalHours % 24;
  if (days > 0) return hours > 0 ? `${days}d${hours}h` : `${days}d`;
  return `${hours}h`;
}
