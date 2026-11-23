/**
 * 开始 / 完成记录（records.ts）单测：时间线派生口径 + 「精确到小时」的两个格式化。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  collectNodeRecords,
  formatHourSpan,
  formatHourStamp,
  recordDurationMs,
} from "./records.ts";
import { leaf } from "./testFixtures.ts";
import { UNCLASSIFIED_WORKFLOW_ID, type WfJsonDocument } from "./types.ts";

const HOUR = 3_600_000;

/** 造一份覆盖「完成 / 进行中 / 只靠 timeEntries / 未分类」的文档 */
function sampleDocument(): WfJsonDocument {
  return {
    schemaVersion: "1.9",
    id: "file-x",
    updatedAt: "2026-10-12T18:00:00+08:00",
    workflows: [
      {
        id: "wf-1",
        title: "工作流一",
        root: leaf("nd-root", "根", {
          status: "done",
          startAt: "2026-10-12T08:00:00+08:00",
          completedAt: "2026-10-12T09:10:00+08:00",
          children: [
            leaf("nd-a", "任务 A", {
              status: "done",
              startAt: "2026-10-12T10:00:00+08:00",
              completedAt: "2026-10-12T12:30:00+08:00",
            }),
            leaf("nd-b", "任务 B", { status: "doing", startAt: "2026-10-12T11:00:00+08:00" }),
            leaf("nd-c", "任务 C", {
              status: "done",
              timeEntries: [
                {
                  startAt: "2026-10-12T13:00:00+08:00",
                  date: "2026-10-12",
                  endAt: "2026-10-12T15:20:00+08:00",
                  hours: 2.3,
                },
              ],
            }),
          ],
        }),
      },
      {
        id: UNCLASSIFIED_WORKFLOW_ID,
        title: "未分类",
        root: leaf("nd-u-root", "未分类", {
          children: [
            leaf("nd-u1", "未分类任务", {
              status: "done",
              startAt: "2026-10-12T09:00:00+08:00",
              completedAt: "2026-10-12T09:30:00+08:00",
            }),
          ],
        }),
      },
    ],
  };
}

describe("records · formatHourSpan（精确到小时）", () => {
  test("不足 24 小时省略 0d，向下取整（不显示分钟）", () => {
    assert.equal(formatHourSpan(0), "0h");
    assert.equal(formatHourSpan(5 * HOUR), "5h");
    assert.equal(formatHourSpan(5 * HOUR + 59 * 60_000), "5h");
  });

  test("满一天起用 Xd，剩余小时跟在后面；整天不带 0h", () => {
    assert.equal(formatHourSpan(24 * HOUR), "1d");
    assert.equal(formatHourSpan(26 * HOUR), "1d2h");
    assert.equal(formatHourSpan(48 * HOUR), "2d");
  });

  test("undefined / 负数返回空串", () => {
    assert.equal(formatHourSpan(undefined), "");
    assert.equal(formatHourSpan(-1), "");
  });
});

describe("records · formatHourStamp（YYYY-MM-DD HH:00）", () => {
  test("分钟恒为 00（本地时区）", () => {
    const stamp = formatHourStamp(new Date(2026, 9, 12, 14, 37, 25).getTime());
    assert.equal(stamp, "2026-10-12 14:00");
  });

  test("undefined 返回空串", () => {
    assert.equal(formatHourStamp(undefined), "");
  });
});

describe("records · collectNodeRecords", () => {
  test("完成记录按完成时间倒序、开始记录按开始时间倒序", () => {
    const records = collectNodeRecords(sampleDocument());
    assert.deepEqual(
      records.completed.map((record) => record.node.id),
      ["nd-c", "nd-a", "nd-u1", "nd-root"],
    );
    assert.deepEqual(
      records.started.map((record) => record.node.id),
      ["nd-c", "nd-b", "nd-a", "nd-u1", "nd-root"],
    );
  });

  test("未分类伪流的隐藏 root 不进任何一列，children 照常进", () => {
    const records = collectNodeRecords(sampleDocument());
    const allIds = [...records.completed, ...records.started].map((record) => record.node.id);
    assert.ok(!allIds.includes("nd-u-root"), "隐藏 root 不应出现");
    assert.ok(allIds.includes("nd-u1"), "未分类 children 应照常出现");
  });

  test("单节点耗时 = 最晚完成 − 最早开始（精确到小时）", () => {
    const records = collectNodeRecords(sampleDocument());
    const taskC = records.completed.find((record) => record.node.id === "nd-c");
    assert.ok(taskC);
    // 13:00 → 15:20 = 2h20m，向下取整 2h
    assert.equal(formatHourSpan(recordDurationMs(taskC)), "2h");

    const taskB = records.started.find((record) => record.node.id === "nd-b");
    assert.ok(taskB);
    assert.equal(recordDurationMs(taskB), undefined, "没有完成时间就没有耗时");
  });

  test("既开始过也完成的节点同时出现在两列", () => {
    const records = collectNodeRecords(sampleDocument());
    assert.ok(records.completed.some((record) => record.node.id === "nd-a"));
    assert.ok(records.started.some((record) => record.node.id === "nd-a"));
  });

  test("没有开始 / 完成的节点两列都不进", () => {
    const document: WfJsonDocument = {
      schemaVersion: "1.9",
      id: "file-y",
      updatedAt: "2026-10-12T18:00:00+08:00",
      workflows: [{ id: "wf-1", title: "空", root: leaf("nd-only", "只看 todo") }],
    };
    const records = collectNodeRecords(document);
    assert.equal(records.completed.length, 0);
    assert.equal(records.started.length, 0);
  });
});
