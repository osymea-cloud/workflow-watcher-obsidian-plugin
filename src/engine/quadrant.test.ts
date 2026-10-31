/**
 * `src/engine/quadrant.ts` 单测（Phase 19 M2）。
 *
 * 覆盖契约里的每一条口径：筛选（todo/doing + 两轴都是 1-4 的整数）、
 * 16 分区的配色表、`startAt` 正序（未开始排最后）、填充档位 `min(n,5)`、
 * 开始距今 / 已记录的小时数（含未来时间、进行中的会话、脏数据）。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  QUADRANT_FILL_MAX,
  QUADRANT_PARTITION_COUNT,
  quadrantColor,
  quadrantStats,
  type QuadrantPartition,
} from "./quadrant.ts";
import { leaf } from "./testFixtures.ts";
import type { WfJsonDocument, WfNode } from "./types.ts";

/** 固定「现在」：2026-10-10 12:00（+08:00），便于算 XdYh */
const NOW = new Date("2026-10-10T12:00:00+08:00");

function documentWith(...roots: WfNode[]): WfJsonDocument {
  return {
    schemaVersion: "1.9",
    id: "file-quadrant-001",
    updatedAt: "2026-10-10T12:00:00+08:00",
    workflows: roots.map((root, index) => ({
      id: `wf-quadrant-${index + 1}`,
      title: `工作流 ${index + 1}`,
      root,
    })),
  };
}

/** `leaf()` 默认 todo + children: []；这里只补两轴与额外字段 */
function node(
  id: string,
  title: string,
  importance: number | undefined,
  urgency: number | undefined,
  extra: Partial<WfNode> = {},
): WfNode {
  const options: Partial<WfNode> = { ...extra };
  if (importance !== undefined) options.importance = importance;
  if (urgency !== undefined) options.urgency = urgency;
  return leaf(id, title, options);
}

function partitionOf(document: WfJsonDocument, urgency: number, importance: number): QuadrantPartition {
  const stats = quadrantStats(document, NOW);
  const partition = stats.partitions.find((item) => item.urgency === urgency && item.importance === importance);
  assert.ok(partition, `应有 urgency=${urgency} / importance=${importance} 的分区`);
  return partition;
}

describe("quadrant · quadrantColor（契约配色表）", () => {
  test("重要 3-4 且紧急 3-4 = 红；重要不紧急 = 橙；都不 = 绿；不重要但紧急 = 蓝", () => {
    assert.equal(quadrantColor(4, 4), "red");
    assert.equal(quadrantColor(3, 3), "red");
    assert.equal(quadrantColor(4, 1), "orange");
    assert.equal(quadrantColor(3, 2), "orange");
    assert.equal(quadrantColor(1, 1), "green");
    assert.equal(quadrantColor(2, 2), "green");
    assert.equal(quadrantColor(1, 3), "blue");
    assert.equal(quadrantColor(2, 4), "blue");
  });

  test("任一轴不是 1-4 的整数 → undefined（缺字段 / 越界 / 小数都不算）", () => {
    for (const [importance, urgency] of [
      [0, 4],
      [5, 4],
      [4, 0],
      [4, 5],
      [2.5, 3],
      [3, 1.5],
      [Number.NaN, 4],
      [-1, 2],
      [4, Number.POSITIVE_INFINITY],
    ] as const) {
      assert.equal(quadrantColor(importance, urgency), undefined, `${importance} × ${urgency} 应被拒绝`);
    }
  });
});

describe("quadrant · quadrantStats 分区结构", () => {
  test("恒为 16 个分区，顺序 = importance 4→1（外）× urgency 1→4（内）", () => {
    const stats = quadrantStats(documentWith(node("nd-1", "唯一的节点", 2, 3)), NOW);
    assert.equal(stats.partitions.length, QUADRANT_PARTITION_COUNT);
    assert.deepEqual(
      stats.partitions.map((item) => `${item.importance}-${item.urgency}`).slice(0, 4),
      ["4-1", "4-2", "4-3", "4-4"],
      "第一行是「重要 4」那一排",
    );
    assert.deepEqual(
      stats.partitions.map((item) => `${item.importance}-${item.urgency}`).slice(-4),
      ["1-1", "1-2", "1-3", "1-4"],
      "最后一行是「重要 1」那一排",
    );
  });

  test("四个角的象限色", () => {
    const document = documentWith(node("nd-1", "占位", 1, 1));
    assert.equal(partitionOf(document, 4, 4).quadrant, "red", "右上 = 重要且紧急");
    assert.equal(partitionOf(document, 1, 4).quadrant, "orange", "左上 = 重要不紧急");
    assert.equal(partitionOf(document, 1, 1).quadrant, "green", "左下 = 都不");
    assert.equal(partitionOf(document, 4, 1).quadrant, "blue", "右下 = 不重要但紧急");
  });

  test("空文档 / 空分区：nodes 为空、fillLevel = 0", () => {
    const stats = quadrantStats(documentWith(), NOW);
    assert.equal(stats.totalNodes, 0);
    for (const partition of stats.partitions) {
      assert.deepEqual(partition.nodes, []);
      assert.equal(partition.fillLevel, 0);
    }
  });
});

describe("quadrant · 筛选（缺任一字段不入统计）", () => {
  test("只收 todo / doing，且 importance、urgency 都是 1-4 的整数", () => {
    const root = node("nd-root", "根节点", 4, 4, {
      children: [
        node("nd-todo", "待办", 4, 4),
        node("nd-doing", "进行中", 3, 3, { status: "doing" }),
        node("nd-done", "已完成", 4, 4, { status: "done" }),
        node("nd-blocked", "受阻", 4, 4, { status: "blocked" }),
        node("nd-cancelled", "已取消", 4, 4, { status: "cancelled" }),
        node("nd-no-urgency", "缺紧急度", 4, undefined),
        node("nd-no-importance", "缺重要度", undefined, 4),
        node("nd-out-of-range", "越界", 5, 4),
        node("nd-fraction", "小数", 3.5, 4),
        node("nd-child", "孙节点", 1, 2, { status: "doing" }),
      ],
    });
    const stats = quadrantStats(documentWith(root), NOW);

    assert.equal(stats.totalNodes, 4, "根节点 + 待办 + 进行中 + 孙节点");
    const ids = stats.partitions.flatMap((partition) => partition.nodes.map((item) => item.nodeId));
    assert.deepEqual(ids.sort(), ["nd-child", "nd-doing", "nd-root", "nd-todo"]);
    assert.ok(!ids.includes("nd-done"), "已完成不进小工具");
    assert.ok(!ids.includes("nd-no-urgency"), "缺紧急度不进小工具");
  });

  test("节点带所属工作流标题（多工作流各自记自己的 title）", () => {
    const document: WfJsonDocument = {
      schemaVersion: "1.9",
      id: "file-quadrant-002",
      workflows: [
        { id: "wf-a", title: "工作流 A", root: node("nd-a", "A 的节点", 4, 4) },
        { id: "wf-b", title: "工作流 B", root: node("nd-b", "B 的节点", 2, 1) },
      ],
    };
    const stats = quadrantStats(document, NOW);
    const nodes = stats.partitions.flatMap((partition) => partition.nodes);
    assert.equal(nodes.length, 2);
    assert.deepEqual(
      nodes.map((item) => `${item.workflowTitle}:${item.title}`).sort(),
      ["工作流 A:A 的节点", "工作流 B:B 的节点"],
    );
  });
});

describe("quadrant · 填充档位 = min(分区任务数, 5)", () => {
  test("1~4 个任务各一档，5 个及以上都封顶在 5", () => {
    assert.equal(QUADRANT_FILL_MAX, 5);
    for (const count of [0, 1, 2, 3, 4, 5, 6]) {
      const children = Array.from({ length: count }, (_, index) => node(`nd-${index}`, `任务 ${index}`, 4, 4));
      const document = documentWith(node("nd-root", "根", 4, 4, { children }));
      const partition = partitionOf(document, 4, 4);
      // 根节点自己也在 (4,4) 里 → 分区任务数 = count + 1
      assert.equal(partition.nodes.length, count + 1);
      assert.equal(partition.fillLevel, Math.min(count + 1, 5), `${count + 1} 个任务`);
    }
  });
});

describe("quadrant · 预览行的时间口径", () => {
  test("按 startAt 正序；没有 / 解析不出的排最后（彼此保持文档顺序）", () => {
    const root = node("nd-root", "根", 4, 4, {
      children: [
        node("nd-late", "10-09 开始", 4, 4, { startAt: "2026-10-09T08:00:00+08:00" }),
        node("nd-early", "10-07 开始", 4, 4, { startAt: "2026-10-07T08:00:00+08:00" }),
        node("nd-never", "没开始", 4, 4),
        node("nd-bad", "时间坏掉", 4, 4, { startAt: "不是时间" }),
        node("nd-middle", "10-08 开始", 4, 4, { startAt: "2026-10-08T08:00:00+08:00" }),
      ],
    });
    const partition = partitionOf(documentWith(root), 4, 4);
    assert.deepEqual(
      partition.nodes.map((item) => item.nodeId),
      ["nd-early", "nd-middle", "nd-late", "nd-root", "nd-never", "nd-bad"],
      "有开始时间的正序在前，未开始 / 坏数据在后（彼此保持文档顺序）",
    );
  });

  test("startHours = 开始距今（1 位小数，未来按 0）；recordedHours 只算已结束的会话", () => {
    const root = node("nd-root", "根", 4, 4, {
      startAt: "2026-10-07T09:00:00+08:00",
      timeEntries: [
        { startAt: "2026-10-08T09:00:00+08:00", date: "2026-10-08", endAt: "2026-10-08T10:30:00+08:00", hours: 1.5 },
        { startAt: "2026-10-09T09:00:00+08:00", date: "2026-10-09", endAt: "2026-10-09T10:00:00+08:00", hours: 1 },
        // 进行中的那一条（没有 endAt / hours）不算「已记录」
        { startAt: "2026-10-10T11:00:00+08:00", date: "2026-10-10" },
        // 有 hours 但没有 endAt 的脏数据也不算
        { startAt: "2026-10-10T08:00:00+08:00", date: "2026-10-10", hours: 9 },
      ],
    });
    root.children = [
      node("nd-future", "未来开始", 4, 4, { startAt: "2026-10-20T09:00:00+08:00" }),
      node("nd-empty", "什么记录都没有", 4, 4),
    ];

    const partition = partitionOf(documentWith(root), 4, 4);
    const byId = new Map(partition.nodes.map((item) => [item.nodeId, item]));
    const rootInfo = byId.get("nd-root");
    assert.ok(rootInfo);
    assert.equal(rootInfo.startHours, 75, "10-07 09:00 → 10-10 12:00 = 3d3h = 75h");
    assert.equal(rootInfo.recordedHours, 2.5, "只累加两条已结束会话（1.5 + 1）");

    const futureInfo = byId.get("nd-future");
    assert.ok(futureInfo);
    assert.equal(futureInfo.startHours, 0, "未来时间按 0 算");
    assert.equal(futureInfo.recordedHours, 0);

    const emptyInfo = byId.get("nd-empty");
    assert.ok(emptyInfo);
    assert.equal(emptyInfo.startAt, undefined);
    assert.equal(emptyInfo.startHours, 0);
    assert.equal(emptyInfo.recordedHours, 0);
  });

  test("状态字段原样带出（只可能是 todo / doing）", () => {
    const root = node("nd-root", "根", 4, 4, {
      children: [node("nd-doing", "进行中", 4, 4, { status: "doing" })],
    });
    const partition = partitionOf(documentWith(root), 4, 4);
    assert.deepEqual(
      partition.nodes.map((item) => item.status),
      ["todo", "doing"],
    );
  });
});
