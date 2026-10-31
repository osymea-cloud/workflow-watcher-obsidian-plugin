/**
 * 计时写回（timerEdits.ts）单测：开始 / 结束并记录 / 结束并丢弃。
 *
 * 覆盖契约 §5 的三步与 §10 的风险控制：并发闸门（文件级单例）、`hours` 精度与 1 位小数、
 * `date` 保持开始日（跨零点不拆）、负值（开始时间失效）拒绝、删空后省略 `timeEntries` 键、
 * 以及「写回后仍能通过 analyzeMarkdown」的幂等性。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { analyzeMarkdown } from "./analyze.ts";
import { applyMutation } from "./mutate.ts";
import { ROOT_ID, clone, validDocument11, validDocument13, validMarkdown11, validMarkdown13 } from "./testFixtures.ts";
import { TIMER_INVALID_START_MESSAGE, startTimerEntry, stopTimerEntry } from "./timerEdits.ts";
import { aggregateTimeEntries } from "./timeStats.ts";
import { findNode } from "./tree.ts";
import type { WfJsonDocument } from "./types.ts";

const NOW = new Date("2026-10-12T09:30:00+08:00");
const AT = "2026-10-12T09:30:00+08:00";

/** 取节点的计时条目（不存在直接让测试失败） */
function entriesOf(document: WfJsonDocument, nodeId: string) {
  const node = findNode(document, nodeId);
  assert.ok(node, `节点 ${nodeId} 应当存在`);
  return node.timeEntries;
}

/** 2026-10-12 这天累计记账的小时数（方块阵口径） */
function aggregateOf(document: WfJsonDocument): number | undefined {
  return aggregateTimeEntries(document).dailyStats.get("2026-10-12")?.totalHours;
}

describe("timerEdits · startTimerEntry（▶️ 开始这个任务）", () => {
  test("追加进行中的条目：只有 startAt / date，刷新节点 updatedAt，上报下标", () => {
    const document = clone(validDocument13());
    const result = startTimerEntry(document, "nd-uuid-002", NOW);

    assert.equal(result.ok, true);
    assert.deepEqual(result.changedNodeIds, ["nd-uuid-002"]);
    assert.equal(result.entryIndex, 0, "该节点还没有任何条目");

    const entries = entriesOf(document, "nd-uuid-002");
    assert.deepEqual(entries, [{ startAt: AT, date: "2026-10-12" }]);
    assert.equal("endAt" in entries![0], false, "进行中不写 endAt（空值省略）");
    assert.equal("hours" in entries![0], false, "进行中不写 hours");
    assert.equal(findNode(document, "nd-uuid-002")?.updatedAt, AT);
  });

  test("并发闸门：已有进行中的计时 → 拒绝并指出是哪个节点", () => {
    const document = clone(validDocument11());
    assert.equal(startTimerEntry(document, ROOT_ID, NOW).ok, true);

    const second = startTimerEntry(document, "nd-uuid-002", NOW);

    assert.equal(second.ok, false);
    assert.deepEqual(second.changedNodeIds, []);
    assert.match(second.reason ?? "", /已有进行中的计时/);
    assert.match(second.reason ?? "", /调研竞品/);
    assert.equal(entriesOf(document, "nd-uuid-002"), undefined, "被拒绝时文档一动不动");
  });

  test("节点不存在 → 拒绝", () => {
    const result = startTimerEntry(clone(validDocument13()), "nd-missing", NOW);

    assert.equal(result.ok, false);
    assert.deepEqual(result.changedNodeIds, []);
    assert.match(result.reason ?? "", /nd-missing/);
  });

  test("写回链路：落盘 + 再 analyze 无 error（进行中条目通过 Schema）", () => {
    const markdown = validMarkdown11();
    const result = applyMutation(
      markdown,
      (document) => {
        const edit = startTimerEntry(document, ROOT_ID, NOW);
        if (!edit.ok) return { reject: edit.reason };
        return { changedNodeIds: edit.changedNodeIds };
      },
      { now: NOW },
    );

    assert.equal(result.success, true);
    assert.equal(result.changed, true);
    assert.equal(result.upgraded, true, "1.1 文件顺带落盘升格为 1.6");
    assert.equal(result.analysis.hasError, false);
    assert.ok(result.markdown.includes('"schemaVersion": "1.9"'));

    const node = findNode(result.analysis.document!, ROOT_ID);
    assert.deepEqual(node?.timeEntries, [{ startAt: AT, date: "2026-10-12" }]);
  });
});

describe("timerEdits · stopTimerEntry record（⏹ 结束并记录）", () => {
  test("补 endAt + hours（1 位小数），date 保持开始日，刷新节点 updatedAt", () => {
    const document = clone(validDocument11());
    const start = new Date("2026-10-12T09:00:00+08:00");
    startTimerEntry(document, ROOT_ID, start);

    const result = stopTimerEntry(document, ROOT_ID, "record", NOW);

    assert.equal(result.ok, true);
    assert.deepEqual(result.changedNodeIds, [ROOT_ID]);
    assert.equal(result.entryIndex, 0);
    assert.deepEqual(entriesOf(document, ROOT_ID), [
      { startAt: "2026-10-12T09:00:00+08:00", date: "2026-10-12", endAt: AT, hours: 0.5 },
    ]);
    assert.equal(findNode(document, ROOT_ID)?.updatedAt, AT);
    assert.equal(aggregateOf(document), 0.5, "0.5h 属于「(0,1]」档");
  });

  test("跨零点：hours 是整段时长，date 仍是开始那天（不拆分、不覆盖）", () => {
    const document = clone(validDocument11());
    startTimerEntry(document, ROOT_ID, new Date("2026-10-11T23:00:00+08:00"));

    stopTimerEntry(document, ROOT_ID, "record", new Date("2026-10-12T01:00:00+08:00"));

    assert.deepEqual(entriesOf(document, ROOT_ID), [
      { startAt: "2026-10-11T23:00:00+08:00", date: "2026-10-11", endAt: "2026-10-12T01:00:00+08:00", hours: 2 },
    ]);
  });

  test("该节点没有进行中的条目 → 拒绝", () => {
    const document = clone(validDocument13());
    const before = JSON.stringify(document);

    const result = stopTimerEntry(document, "nd-uuid-002", "record", NOW);

    assert.equal(result.ok, false);
    assert.deepEqual(result.changedNodeIds, []);
    assert.match(result.reason ?? "", /没有进行中的计时/);
    assert.equal(JSON.stringify(document), before, "被拒绝时文档一动不动");
  });

  test("开始时间失效（endAt 早于 startAt）→ 拒绝并提示改用「结束并丢弃」", () => {
    const document = clone(validDocument11());
    startTimerEntry(document, ROOT_ID, new Date("2026-10-12T23:00:00+08:00"));
    const before = JSON.stringify(document);

    const result = stopTimerEntry(document, ROOT_ID, "record", NOW);

    assert.equal(result.ok, false);
    assert.equal(result.reason, TIMER_INVALID_START_MESSAGE);
    assert.equal(JSON.stringify(document), before);
  });

  test("节点不存在 → 拒绝", () => {
    const result = stopTimerEntry(clone(validDocument11()), "nd-missing", "record", NOW);

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /nd-missing/);
  });
});

describe("timerEdits · stopTimerEntry discard（🗑 结束并丢弃）", () => {
  test("删掉进行中的那条；数组变空 → 省略 timeEntries 键", () => {
    const document = clone(validDocument11());
    startTimerEntry(document, ROOT_ID, new Date("2026-10-12T09:00:00+08:00"));

    const result = stopTimerEntry(document, ROOT_ID, "discard", NOW);

    assert.equal(result.ok, true);
    assert.equal(result.entryIndex, 0);
    assert.equal(findNode(document, ROOT_ID)?.timeEntries, undefined);
    assert.equal("timeEntries" in (findNode(document, ROOT_ID) as object), false);
    assert.equal(findNode(document, ROOT_ID)?.updatedAt, AT);
  });

  test("只删进行中的那条，已完成的历史条目保持不动", () => {
    const document = clone(validDocument13());
    startTimerEntry(document, ROOT_ID, new Date("2026-10-12T09:00:00+08:00"));

    const result = stopTimerEntry(document, ROOT_ID, "discard", NOW);

    assert.equal(result.ok, true);
    assert.equal(result.entryIndex, 2);
    assert.deepEqual(entriesOf(document, ROOT_ID)?.map((entry) => entry.hours), [2.5, 6]);
  });

  test("没有进行中的条目 → 拒绝（不会误删历史）", () => {
    const document = clone(validDocument13());
    const before = JSON.stringify(document);

    const result = stopTimerEntry(document, ROOT_ID, "discard", NOW);

    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(document), before);
  });
});

describe("timerEdits · 写回链路（开始 → 结束 / 丢弃）", () => {
  test("开始 → 结束并记录：1.3 文件落盘时升格为 1.6，条目带 endAt / hours", () => {
    const markdown = validMarkdown13();
    const stopped = applyMutation(
      markdown,
      (document) => {
        const started = startTimerEntry(document, ROOT_ID, new Date("2026-10-12T09:00:00+08:00"));
        if (!started.ok) return { reject: started.reason };
        const ended = stopTimerEntry(document, ROOT_ID, "record", NOW);
        if (!ended.ok) return { reject: ended.reason };
        return { changedNodeIds: ended.changedNodeIds };
      },
      { now: NOW },
    );

    assert.equal(stopped.success, true);
    assert.equal(stopped.upgraded, true, "1.3 文件在本次写回时升到 1.6");
    assert.equal(stopped.analysis.hasError, false);

    const node = findNode(stopped.analysis.document!, ROOT_ID);
    assert.deepEqual(node?.timeEntries?.map((entry) => [entry.date, entry.hours]), [
      ["2026-10-02", 2.5],
      ["2026-10-05", 6],
      ["2026-10-12", 0.5],
    ]);
    assert.equal(analyzeMarkdown(stopped.markdown).hasError, false, "写回结果幂等");
  });

  test("开始 → 结束并丢弃：文本回到「没有进行中条目」的状态（timeEntries 省略）", () => {
    const markdown = validMarkdown11();
    const discarded = applyMutation(
      markdown,
      (document) => {
        const started = startTimerEntry(document, ROOT_ID, new Date("2026-10-12T09:00:00+08:00"));
        if (!started.ok) return { reject: started.reason };
        const dropped = stopTimerEntry(document, ROOT_ID, "discard", NOW);
        if (!dropped.ok) return { reject: dropped.reason };
        return { changedNodeIds: dropped.changedNodeIds };
      },
      { now: NOW },
    );

    assert.equal(discarded.success, true);
    assert.equal(discarded.analysis.hasError, false);
    assert.equal(discarded.markdown.includes('"timeEntries"'), false);
  });
});
