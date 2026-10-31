/**
 * 聚合统计（stats.ts）单测：「状态总览」的数字口径（进行中：a/B 阻滞：n）。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  countNodeStatuses,
  emptyStatusCounts,
  formatStatusOverview,
  groupWorkflows,
  isWorkflowSettled,
  summarizeDocument,
  summarizeWorkflow,
} from "./stats.ts";
import { ROOT_ID, WF1_ID, WF2_ID, clone, leaf, validDocument, validDocument11 } from "./testFixtures.ts";

describe("stats · 节点计数", () => {
  test("countNodeStatuses：total 含 done / cancelled", () => {
    const counts = countNodeStatuses([
      leaf("nd-a", "a"),
      leaf("nd-b", "b", { status: "doing" }),
      leaf("nd-c", "c", { status: "blocked" }),
      leaf("nd-d", "d", { status: "done" }),
      leaf("nd-e", "e", { status: "cancelled" }),
    ]);
    assert.deepEqual(counts, { total: 5, todo: 1, doing: 1, blocked: 1, done: 1, cancelled: 1 });
    assert.deepEqual(countNodeStatuses([]), emptyStatusCounts());
  });
});

describe("stats · workflow / 文档汇总", () => {
  test("summarizeWorkflow：节点计数 + 贡献状态 + 是否计入总览", () => {
    const active = summarizeWorkflow(validDocument().workflows[0]);
    assert.equal(active.id, WF1_ID);
    assert.equal(active.active, true);
    assert.equal(active.state, undefined);
    assert.equal(active.total, 3);
    assert.equal(active.doing, 1);
    assert.equal(active.allDone, false);
    assert.equal(active.contribution, "doing");

    const archived = summarizeWorkflow(validDocument11().workflows[1]);
    assert.equal(archived.id, WF2_ID);
    assert.equal(archived.active, false);
    assert.equal(archived.state, "archived");
    assert.equal(archived.originId, ROOT_ID);
    assert.equal(archived.allDone, true);
    assert.equal(archived.contribution, "done");
  });

  test("1.0 文件（全部 workflow 缺省 state）：总览口径 = 全部节点", () => {
    const summary = summarizeDocument(validDocument());

    assert.equal(summary.activeWorkflowCount, 2);
    assert.equal(summary.archivedWorkflowCount, 0);
    assert.equal(summary.cancelledWorkflowCount, 0);
    assert.equal(summary.nodeTotal, 4);
    assert.equal(summary.active.total, 4);
    assert.equal(summary.active.doing, 1);
    assert.equal(summary.active.blocked, 0);
    assert.equal(formatStatusOverview(summary), "进行中：1/4 阻滞：0");
  });

  test("归档 workflow 不计入总览（a/B 只看 state 缺省的 workflow）", () => {
    const summary = summarizeDocument(validDocument11());

    assert.equal(summary.activeWorkflowCount, 1);
    assert.equal(summary.archivedWorkflowCount, 1);
    assert.equal(summary.nodeTotal, 4);
    assert.equal(summary.active.total, 3);
    assert.equal(summary.active.doing, 0);
    assert.equal(summary.active.done, 3);
    assert.equal(formatStatusOverview(summary), "进行中：0/3 阻滞：0");
  });

  test("没有进行中 workflow 时显示 0/0、受阻 0", () => {
    const document = clone(validDocument11());
    document.workflows[0].state = "cancelled";
    const summary = summarizeDocument(document);

    assert.equal(summary.activeWorkflowCount, 0);
    assert.equal(summary.archivedWorkflowCount, 1);
    assert.equal(summary.cancelledWorkflowCount, 1);
    assert.deepEqual(summary.active, emptyStatusCounts());
    assert.equal(formatStatusOverview(summary), "进行中：0/0 阻滞：0");
  });

  test("受阻节点单列提示，但仍算在 B 之内", () => {
    const document = clone(validDocument());
    document.workflows[0].root.children[0].status = "blocked";
    document.workflows[1].root.status = "blocked";
    const summary = summarizeDocument(document);

    assert.equal(summary.active.blocked, 2);
    assert.equal(summary.active.total, 4);
    assert.equal(formatStatusOverview(summary), "进行中：1/4 阻滞：2");
  });

  test("非法 state 按「进行中」处理（不丢数据）", () => {
    const document = clone(validDocument11());
    (document.workflows[1] as { state: string }).state = "doing";
    const summary = summarizeDocument(document);

    assert.equal(summary.archivedWorkflowCount, 0);
    assert.equal(summary.activeWorkflowCount, 2);
    assert.equal(summary.active.total, 4);
  });

  test("groupWorkflows：按 state 分组，保持文档顺序", () => {
    const groups = groupWorkflows(validDocument11());

    assert.deepEqual(groups.active.map((workflow) => workflow.id), [WF1_ID]);
    assert.deepEqual(groups.archived.map((workflow) => workflow.id), [WF2_ID]);
    assert.deepEqual(groups.cancelled, []);
  });

  test("isWorkflowSettled：节点全 done / cancelled 视为已收尾", () => {
    assert.equal(isWorkflowSettled(validDocument11().workflows[0]), true);
    assert.equal(isWorkflowSettled(validDocument11().workflows[1]), true);
    assert.equal(isWorkflowSettled(validDocument().workflows[0]), false);
    assert.equal(isWorkflowSettled(validDocument().workflows[1]), false);
  });
});
