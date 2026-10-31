/**
 * 计时写回（Phase 3 契约 §5）：开始 / 结束并记录 / 结束并丢弃。
 *
 * 定位与 nodeEdits.ts 一致：本模块只回答「内存里的文档该改成什么样」，不写盘、不弹窗。
 * 与插件层（main.ts 的 WfViewHost 实现）一一对应：
 *   startTimerEntry → startTimer  （「▶️ 开始这个任务」）
 *   stopTimerEntry  → stopTimer   （「⏹ 结束并记录」/「🗑 结束并丢弃」）
 *
 * 写盘统一由上层套进 `mutateFile` → `applyMutation`（安全闸门 → 升格 → 三段写回 → 幂等校验）；
 * 因此这里每个函数都必须「要么把文档改对，要么什么都不动」：
 * 校验不过一律 `ok=false` + 中文原因，调用方据此 reject（文本保持原样）。
 *
 * 约定（契约 §5 / §10）：
 *  - **并发闸门**：全文件只允许一个进行中的条目，已有 active 时「开始」被拒绝；
 *  - 三个动作都刷新 `node.updatedAt`（`document.updatedAt` 由 applyMutation 统一刷新）；
 *  - `hours` 用 `hoursBetween`（1 位小数）；`endAt < startAt`（开始时间失效）→ 拒绝并提示「结束并丢弃」；
 *  - 条目删除后数组变空 → **省略该键**（沿用「空值省略」约定）。
 */

import { timerInvalidStartMessage } from "./i18n.ts";
import { findNode } from "./tree.ts";
import { formatLocalIso, hoursBetween, toDateOnly } from "./time.ts";
import { aggregateTimeEntries } from "./timeStats.ts";
import type { WfJsonDocument, WfTimeEntry } from "./types.ts";

/** 结束计时的两种模式：`record` = 记为一条已完成条目；`discard` = 删掉这条（开始时间失效时用） */
export type StopTimerMode = "record" | "discard";

/** 计时动作的共同返回：`ok=false` 时文档未被改动，只有 `reason` 有意义 */
export interface TimerEditResult {
  ok: boolean;
  /** ok=false 时的原因（直接给用户看的中文） */
  reason?: string;
  /** 受影响的节点 id（供上层做局部刷新） */
  changedNodeIds: string[];
  /** 本次动作涉及的条目下标（ok=true 时给出，便于上层提示） */
  entryIndex?: number;
}

/**
 * 开始时间失效（晚于当前时间）时的中文原文案（v0.8 起仅供兼容 / 单测引用）。
 * 运行时请用 `timerInvalidStartMessage()`：它会按当前语言返回 `en` 文案。
 */
export const TIMER_INVALID_START_MESSAGE = "时间为负值，开始时间失效，请结束并丢弃";

/** 节点内**最新一条进行中**条目的下标（有 `startAt` 且无 `endAt`）；没有则 -1 */
function lastActiveEntryIndex(entries: readonly WfTimeEntry[]): number {
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (typeof entry.startAt === "string" && entry.startAt.length > 0 && entry.endAt === undefined) return index;
  }
  return -1;
}

/**
 * 「▶️ 开始这个任务」：给节点追加一条进行中的条目。
 *
 * 1. 节点不存在 → 拒绝；
 * 2. **并发闸门**：全文件已有进行中的条目 → 拒绝并指出是哪个节点（避免孤儿计时）；
 * 3. 追加 `{ startAt, date }`（进行中省略 `endAt` / `hours`）+ 刷新节点 `updatedAt`。
 */
export function startTimerEntry(document: WfJsonDocument, nodeId: string, now: Date = new Date()): TimerEditResult {
  const node = findNode(document, nodeId);
  if (!node) return { ok: false, reason: `节点 ${nodeId} 不存在（可能已被删除）`, changedNodeIds: [] };

  const running = aggregateTimeEntries(document).activeEntry;
  if (running !== undefined) {
    return {
      ok: false,
      reason: `已有进行中的计时（「${running.nodeTitle}」，开始于 ${running.startAt}），请先结束它再开始新的计时`,
      changedNodeIds: [],
    };
  }

  const startAt = formatLocalIso(now);
  const entries: WfTimeEntry[] = Array.isArray(node.timeEntries) ? node.timeEntries : [];
  entries.push({ startAt, date: toDateOnly(startAt) });
  node.timeEntries = entries;
  node.updatedAt = startAt;
  return { ok: true, changedNodeIds: [nodeId], entryIndex: entries.length - 1 };
}

/**
 * 「⏹ 结束并记录」/「🗑 结束并丢弃」。
 *
 * - `record`：补 `endAt`（= now）与 `hours`（1 位小数）；`date` **保持开始日不覆盖**（跨零点计入开始那天）；
 * - `discard`：删掉这条（数组变空则省略 `timeEntries` 键）；
 * - 该节点没有进行中的条目 → 拒绝；`record` 时若 `endAt < startAt` → 拒绝并提示去「结束并丢弃」。
 */
export function stopTimerEntry(
  document: WfJsonDocument,
  nodeId: string,
  mode: StopTimerMode,
  now: Date = new Date(),
): TimerEditResult {
  const node = findNode(document, nodeId);
  if (!node) return { ok: false, reason: `节点 ${nodeId} 不存在（可能已被删除）`, changedNodeIds: [] };

  const entries: WfTimeEntry[] | undefined = Array.isArray(node.timeEntries) ? node.timeEntries : undefined;
  const index = entries === undefined ? -1 : lastActiveEntryIndex(entries);
  if (entries === undefined || index < 0) {
    return { ok: false, reason: `「${node.title}」没有进行中的计时`, changedNodeIds: [] };
  }
  const entry = entries[index];

  if (mode === "discard") {
    entries.splice(index, 1);
    if (entries.length === 0) delete node.timeEntries;
    node.updatedAt = formatLocalIso(now);
    return { ok: true, changedNodeIds: [nodeId], entryIndex: index };
  }

  const endAt = formatLocalIso(now);
  const hours = hoursBetween(entry.startAt, endAt);
  if (hours === undefined) {
    return { ok: false, reason: timerInvalidStartMessage(), changedNodeIds: [] };
  }
  entry.endAt = endAt;
  entry.hours = hours;
  node.updatedAt = endAt;
  return { ok: true, changedNodeIds: [nodeId], entryIndex: index };
}
