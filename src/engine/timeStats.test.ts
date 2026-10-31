/**
 * 计时聚合（timeStats.ts）单测：正计时器取值 + 「状态总览」方块阵的窗口 / 档位 / 按 date 聚合。
 *
 * 口径见 doc/datacontact/data_ixd_phase3_contract.md §6 / §7.2；日期用本地构造的 `Date`
 * （`new Date(2026, 9, 12)` = 本地 2026-10-12），因此断言与运行机器的时区无关。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { CHILD_ID, DOING_ID, ROOT_ID, WF1_ID, clone, validDocument11, validDocument13 } from "./testFixtures.ts";
import {
  GANTT_SLOTS_PER_DAY,
  GANTT_SLOT_MINUTES,
  aggregateTimeEntries,
  buildGantt,
  buildHeatmap,
  completedHours,
  formatMinuteOfDay,
  ganttTickHours,
  heatLevel,
  recentDateKeys,
  weekdayIndex,
} from "./timeStats.ts";
import { findNode } from "./tree.ts";
import type { WfJsonDocument, WfTimeEntry } from "./types.ts";

const OCT_12 = new Date(2026, 9, 12); // 本地 2026-10-12（周一）

/** 往节点上塞一条「进行中」的条目（有 startAt、无 endAt） */
function pushActive(document: WfJsonDocument, nodeId: string, startAt: string): void {
  const node = findNode(document, nodeId);
  if (node === undefined) throw new Error(`夹具里没有节点 ${nodeId}`);
  node.timeEntries = [...(node.timeEntries ?? []), { startAt, date: startAt.slice(0, 10) }];
}

describe("timeStats · activeEntry（正计时器取值）", () => {
  test("没有进行中的条目 → activeEntry 缺省", () => {
    assert.equal(aggregateTimeEntries(validDocument13()).activeEntry, undefined);
  });

  test("取「有 startAt 且无 endAt」的最新一条，并带上节点 / 工作流 / 下标", () => {
    const document = validDocument13();
    pushActive(document, ROOT_ID, "2026-10-12T08:00:00+08:00");

    const active = aggregateTimeEntries(document).activeEntry;

    assert.equal(active?.workflowId, WF1_ID);
    assert.equal(active?.nodeId, ROOT_ID);
    assert.equal(active?.nodeTitle, "调研竞品");
    assert.equal(active?.startAt, "2026-10-12T08:00:00+08:00");
    assert.equal(active?.entryIndex, 2, "前两条是已完成的计时");
  });

  test("文件级单例：多处同时进行中时取 startAt 最大的那条（并列取文档靠后）", () => {
    const document = validDocument13();
    pushActive(document, ROOT_ID, "2026-10-12T08:00:00+08:00");
    pushActive(document, CHILD_ID, "2026-10-12T09:30:00+08:00");

    assert.equal(aggregateTimeEntries(document).activeEntry?.nodeId, CHILD_ID);

    pushActive(document, DOING_ID, "2026-10-12T09:30:00+08:00");
    assert.equal(aggregateTimeEntries(document).activeEntry?.nodeId, DOING_ID, "并列时取文档靠后");
  });

  test("脏数据（startAt 无法解析）跳过，不让计时器整体消失", () => {
    const document = clone(validDocument11());
    document.workflows[0].root.timeEntries = [
      { startAt: "不是时间", date: "x" },
      { startAt: "2026-10-12T07:00:00+08:00", date: "2026-10-12" },
    ];

    assert.equal(aggregateTimeEntries(document).activeEntry?.startAt, "2026-10-12T07:00:00+08:00");
  });

  test("进行中的条目不计入方块阵", () => {
    const document = clone(validDocument11());
    pushActive(document, ROOT_ID, "2026-10-12T08:00:00+08:00");

    assert.equal(aggregateTimeEntries(document).dailyStats.has("2026-10-12"), false);
  });
});

describe("timeStats · dailyStats（方块阵口径）", () => {
  test("按 date 聚合 + 按 workflow 归并", () => {
    const aggregate = aggregateTimeEntries(validDocument13());

    const oct2 = aggregate.dailyStats.get("2026-10-02");
    assert.equal(oct2?.totalHours, 2.5);
    assert.deepEqual(oct2?.byWorkflow, [{ workflowId: WF1_ID, title: "立项调查", hours: 2.5 }]);
    assert.equal(aggregate.dailyStats.get("2026-10-05")?.totalHours, 6);
    assert.equal(aggregate.dailyStats.get("2026-10-06")?.totalHours, 1);
    assert.equal(aggregate.dailyStats.size, 3, "没有记录的日期不会凭空出现");
  });

  test("同一天两个 workflow → 合计相加、明细分开", () => {
    const document = clone(validDocument11());
    document.workflows[0].root.timeEntries = [
      { startAt: "2026-10-10T08:00:00+08:00", date: "2026-10-10", endAt: "2026-10-10T09:00:00+08:00", hours: 1 },
    ];
    document.workflows[1].root.timeEntries = [
      { startAt: "2026-10-10T10:00:00+08:00", date: "2026-10-10", endAt: "2026-10-10T10:30:00+08:00", hours: 0.5 },
    ];

    const stat = aggregateTimeEntries(document).dailyStats.get("2026-10-10");

    assert.equal(stat?.totalHours, 1.5);
    assert.deepEqual(
      stat?.byWorkflow.map((item) => [item.title, item.hours]),
      [["立项调查", 1], ["实现方案（已归档）", 0.5]],
    );
  });

  test("date 缺省时按 startAt 的日期部分派生（老数据兼容；跨零点整段计入开始那天）", () => {
    const document = clone(validDocument11());
    document.workflows[0].root.timeEntries = [
      { startAt: "2026-10-09T22:00:00+08:00", endAt: "2026-10-10T01:00:00+08:00", hours: 3 } as unknown as WfTimeEntry,
    ];

    const aggregate = aggregateTimeEntries(document);

    assert.equal(aggregate.dailyStats.has("2026-10-10"), false);
    assert.equal(aggregate.dailyStats.get("2026-10-09")?.totalHours, 3);
  });

  test("累加后仍保留 1 位小数（规避浮点尾巴）", () => {
    const document = clone(validDocument11());
    document.workflows[0].root.timeEntries = [
      { startAt: "2026-10-10T08:00:00+08:00", date: "2026-10-10", endAt: "2026-10-10T08:06:00+08:00", hours: 0.1 },
      { startAt: "2026-10-10T09:00:00+08:00", date: "2026-10-10", endAt: "2026-10-10T09:12:00+08:00", hours: 0.2 },
    ];

    assert.equal(aggregateTimeEntries(document).dailyStats.get("2026-10-10")?.totalHours, 0.3);
  });
});

describe("timeStats · 近 30 天窗口与档位", () => {
  test("recentDateKeys：30 个 key、含今天、最旧在前、逐日连续（跨月）", () => {
    const keys = recentDateKeys(OCT_12, 30);

    assert.equal(keys.length, 30);
    assert.equal(keys[29], "2026-10-12", "最后一个是今天");
    assert.equal(keys[0], "2026-09-13", "最早是今天往前 29 天");
    assert.deepEqual(keys.slice(0, 3), ["2026-09-13", "2026-09-14", "2026-09-15"]);
  });

  test("窗口按本地日历逐日迭代（跨年也对）", () => {
    assert.deepEqual(recentDateKeys(new Date(2026, 0, 3), 5), [
      "2025-12-30",
      "2025-12-31",
      "2026-01-01",
      "2026-01-02",
      "2026-01-03",
    ]);
  });

  test("heatLevel 阈值：0 / (0,1] / (1,3] / (3,6] / >6", () => {
    assert.equal(heatLevel(0), 0);
    assert.equal(heatLevel(0.1), 1);
    assert.equal(heatLevel(1), 1);
    assert.equal(heatLevel(1.5), 2);
    assert.equal(heatLevel(3), 2);
    assert.equal(heatLevel(3.5), 3);
    assert.equal(heatLevel(6), 3);
    assert.equal(heatLevel(6.1), 4);
  });

  test("weekdayIndex：0=周一 … 6=周日（日期串非法按周一兜底）", () => {
    assert.equal(weekdayIndex("2026-10-12"), 0);
    assert.equal(weekdayIndex("2026-10-18"), 6);
    assert.equal(weekdayIndex("不是日期"), 0);
  });

  test("buildHeatmap：30 格、无记录为 l0、命中当天按 hours 分档（tooltip 明细齐全）", () => {
    const cells = buildHeatmap(aggregateTimeEntries(validDocument13()), OCT_12, 30);

    assert.equal(cells.length, 30);
    assert.deepEqual(cells.map((cell) => cell.date), recentDateKeys(OCT_12, 30));
    assert.equal(cells[29].weekday, 0, "今天（2026-10-12）是周一 → 列内第 1 行");

    const byDate = new Map(cells.map((cell) => [cell.date, cell]));
    assert.equal(byDate.get("2026-10-02")?.level, 2, "2.5h ∈ (1,3] → l2");
    assert.equal(byDate.get("2026-10-05")?.level, 3, "6h ∈ (3,6] → l3");
    assert.equal(byDate.get("2026-10-06")?.level, 1, "1h ∈ (0,1] → l1");
    assert.equal(byDate.get("2026-10-12")?.level, 0, "今天没干活 → l0");
    assert.deepEqual(byDate.get("2026-10-06")?.byWorkflow.map((item) => item.title), ["立项调查"]);
  });
});

describe("timeStats · 甘特图（Phase 5 ①）", () => {
  /** 把一组条目挂到根节点上（时间串不带时区 = 本地时间，断言与运行机器的时区无关） */
  function pushEntries(document: WfJsonDocument, entries: WfTimeEntry[]): void {
    const node = findNode(document, ROOT_ID);
    if (node === undefined) throw new Error(`夹具里没有节点 ${ROOT_ID}`);
    node.timeEntries = entries;
  }

  test("一天一行：21 行、最旧在前、没记录的日子也在（槽为空）", () => {
    const document = clone(validDocument11());
    pushEntries(document, [
      { startAt: "2026-10-02T09:00:00", date: "2026-10-02", endAt: "2026-10-02T11:30:00", hours: 2.5 },
    ]);

    const rows = buildGantt(aggregateTimeEntries(document), OCT_12, 21);

    assert.equal(rows.length, 21);
    assert.deepEqual(rows.map((row) => row.date), recentDateKeys(OCT_12, 21));
    assert.equal(rows[20].date, "2026-10-12", "最后一行是今天");

    const oct2 = rows[10];
    assert.equal(oct2.date, "2026-10-02");
    assert.equal(oct2.weekday, 4, "2026-10-02 是周五（0=周一 的第 5 位）");
    assert.equal(oct2.totalHours, 2.5);
    assert.equal(oct2.spans.length, 1);

    assert.equal(rows[0].date, "2026-09-22");
    assert.deepEqual(rows[0].spans, [], "没记录的日子照样出一行，只是没有高亮段");
    assert.equal(rows[0].totalHours, 0);
  });

  test("槽位按 10 分钟两端向外取整，分钟数 / 时长 / 标题齐全", () => {
    const document = clone(validDocument11());
    pushEntries(document, [
      // 09:00 - 11:30 → 第 54 槽起、15 槽长
      { startAt: "2026-10-02T09:00:00", date: "2026-10-02", endAt: "2026-10-02T11:30:00", hours: 2.5 },
      // 09:05 - 09:15 → 起 54、终 56（两端都向外取整，宁可多画一格）
      { startAt: "2026-10-02T09:05:00", date: "2026-10-02", endAt: "2026-10-02T09:15:00", hours: 0.2 },
    ]);

    const row = buildGantt(aggregateTimeEntries(document), OCT_12, 21)[10];

    assert.deepEqual(row.spans.map((span) => [span.start, span.slots]), [[54, 15], [54, 2]]);
    const first = row.spans[0];
    assert.equal(first.startMinute, 540);
    assert.equal(first.endMinute, 690);
    assert.equal(first.crossesMidnight, false);
    assert.equal(first.hours, 2.5);
    assert.equal(first.workflowTitle, "立项调查");
    assert.equal(first.nodeTitle, "调研竞品");
    assert.equal(first.workflowIndex, 0, "Phase 8：workflows[0] → 下标 0（视图侧 6 色循环）");
    assert.equal(first.startAt, "2026-10-02T09:00:00");
    assert.equal(row.totalHours, 2.7);
  });

  test("Phase 8：span 的 workflowIndex 按 workflows[] 文档顺序（第二个工作流 → 1）", () => {
    const document = clone(validDocument11());
    pushEntries(document, [
      { startAt: "2026-10-02T09:00:00", date: "2026-10-02", endAt: "2026-10-02T10:00:00", hours: 1 },
    ]);
    document.workflows[1].root.timeEntries = [
      { startAt: "2026-10-02T13:00:00", date: "2026-10-02", endAt: "2026-10-02T14:00:00", hours: 1 },
    ];

    const row = buildGantt(aggregateTimeEntries(document), OCT_12, 21)[10];

    assert.deepEqual(row.spans.map((span) => span.workflowIndex), [0, 1], "按文档顺序，不按时间排序");
  });


  test("跨零点：这一行只画到 24:00（crossesMidnight + 完整区间留在 startAt / endAt）", () => {
    const document = clone(validDocument11());
    pushEntries(document, [
      { startAt: "2026-10-09T22:00:00", date: "2026-10-09", endAt: "2026-10-10T01:00:00", hours: 3 },
    ]);

    const span = buildGantt(aggregateTimeEntries(document), OCT_12, 21).find((row) => row.date === "2026-10-09")?.spans[0];

    assert.ok(span);
    assert.equal(span.crossesMidnight, true);
    assert.equal(span.start, 132, "22:00 → 第 132 格");
    assert.equal(span.slots, 12, "裁到 24:00 → 只画 12 格");
    assert.equal(span.startMinute, 1320);
    assert.equal(span.endMinute, 60, "结束时刻仍是次日的 01:00（供悬浮提示）");
    assert.equal(span.hours, 3, "时长按完整区间，不因裁剪而变小");
    assert.equal(span.endAt, "2026-10-10T01:00:00");
  });

  test("脏数据（结束早于开始 / 解析不了 / 零长）不画，但 hours 照样进方块阵", () => {
    const document = clone(validDocument11());
    pushEntries(document, [
      { startAt: "2026-10-09T09:00:00", date: "2026-10-09", endAt: "2026-10-09T08:00:00", hours: 1 },
      { startAt: "2026-10-09T10:00:00", date: "2026-10-09", endAt: "不是时间", hours: 0.5 },
      { startAt: "2026-10-09T11:00:00", date: "2026-10-09", endAt: "2026-10-09T11:00:00", hours: 0.2 },
    ]);

    const row = buildGantt(aggregateTimeEntries(document), OCT_12, 21).find((item) => item.date === "2026-10-09");

    assert.equal(row?.spans.length, 0, "画不出区间的条目只是不画");
    assert.equal(row?.totalHours, 1.7, "时长仍按 hours 累加（与方块阵同口径）");
  });

  test("刻度与常量：10 分钟一格 / 144 格 / 每 2 小时一个刻度 / HH:MM 补零", () => {
    assert.equal(GANTT_SLOT_MINUTES, 10);
    assert.equal(GANTT_SLOTS_PER_DAY, 144);
    assert.deepEqual(ganttTickHours(), [0, 2, 4, 6, 8, 10, 12, 14, 16, 18, 20, 22]);
    assert.deepEqual(ganttTickHours(4), [0, 4, 8, 12, 16, 20]);
    assert.deepEqual(ganttTickHours(0), ganttTickHours(), "非法步长回落到默认值");

    assert.equal(formatMinuteOfDay(0), "00:00");
    assert.equal(formatMinuteOfDay(545), "09:05");
    assert.equal(formatMinuteOfDay(1439), "23:59");
    assert.equal(formatMinuteOfDay(1440), "24:00");
    assert.equal(formatMinuteOfDay(-5), "00:00", "越界钳到 0");
    assert.equal(formatMinuteOfDay(2000), "24:00", "越界钳到 1440");
  });
});

describe("timeStats · completedHours（Phase 18 ⑧ 卡片上的「已完成时间」）", () => {
  test("只累计有 endAt 的会话（进行中 / 脏行不算）", () => {
    const entries: WfTimeEntry[] = [
      { startAt: "2026-10-10T09:00:00+08:00", date: "2026-10-10", endAt: "2026-10-10T12:00:00+08:00", hours: 3 },
      // 进行中：按 v1.3 约定省略 endAt / hours
      { startAt: "2026-10-12T09:00:00+08:00", date: "2026-10-12" },
      // 脏行：有 hours 却没有 endAt（手写的）→ 不算「已完成」
      { startAt: "2026-10-11T09:00:00+08:00", date: "2026-10-11", hours: 9 },
    ];
    assert.equal(completedHours(entries), 3);
  });

  test("endAt 是空串 / 非字符串 → 跳过；hours 不是数字也跳过", () => {
    const dirty = [
      { startAt: "2026-10-10T09:00:00+08:00", date: "2026-10-10", endAt: "", hours: 2 },
      { startAt: "2026-10-10T09:00:00+08:00", date: "2026-10-10", endAt: 123 as unknown as string, hours: 2 },
      { startAt: "2026-10-10T09:00:00+08:00", date: "2026-10-10", endAt: "2026-10-10T10:00:00+08:00" },
    ] as WfTimeEntry[];
    assert.equal(completedHours(dirty), undefined);
  });

  test("合计保留 1 位小数；没有一条能算 → undefined（调用方据此不渲染）", () => {
    const entries: WfTimeEntry[] = [
      { startAt: "2026-10-10T09:00:00+08:00", date: "2026-10-10", endAt: "2026-10-10T9:20:00+08:00", hours: 0.3 },
      { startAt: "2026-10-10T10:00:00+08:00", date: "2026-10-10", endAt: "2026-10-10T10:20:00+08:00", hours: 0.3 },
    ];
    assert.equal(completedHours(entries), 0.6);
    assert.equal(completedHours([]), undefined);
    assert.equal(completedHours(undefined), undefined);
  });
});

