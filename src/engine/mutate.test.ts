/**
 * 变更编排（mutate.ts）单测：安全闸门 → 内存升格 → 三段写回 → 幂等校验。
 * 关注点：坏数据一律拒绝写、失败时文本原样、写回结果可再次通过校验、同输入同时间可复现。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { applyMutation, type DocumentMutator } from "./mutate.ts";
import { applyStatusChange } from "./factory.ts";
import { findNode } from "./tree.ts";
import { DOING_ID, TIME_ARCHIVED_AT, validMarkdown, validMarkdown11, validMarkdown13 } from "./testFixtures.ts";
import type { NodeStatus, WfJsonDocument } from "./types.ts";

const NOW = new Date("2026-10-11T10:30:00+08:00");
const AT = "2026-10-11T10:30:00+08:00";

/** 与视图「标记完成」等价的变更（节点不存在 → 拒绝） */
function completeNode(nodeId: string): DocumentMutator {
  return (document: WfJsonDocument) => {
    const node = findNode(document, nodeId);
    if (!node) return { reject: `节点 ${nodeId} 不存在（可能已被删除）` };
    applyStatusChange(node, "done", { at: AT });
    return { changedNodeIds: [nodeId] };
  };
}

describe("mutate · 成功路径", () => {
  test("1.0 文件标记完成：落盘升格为 1.6 + 三段写回 + 无 error", () => {
    const result = applyMutation(validMarkdown(), completeNode(DOING_ID), { now: NOW });

    assert.equal(result.success, true);
    assert.equal(result.changed, true);
    assert.equal(result.upgraded, true);
    assert.deepEqual(result.changedNodeIds, [DOING_ID]);
    assert.equal(result.analysis.hasError, false);

    // 代码块：升格 + 节点状态齐全
    assert.ok(result.markdown.includes('"schemaVersion": "1.9"'));
    assert.ok(result.markdown.includes(`"${AT}"`));
    assert.ok(result.markdown.includes('"completedAt": "2026-10-11T10:30:00+08:00"'));
    // frontmatter：wf-updated 与 updatedAt 对齐、wf-status 按两步聚合重算（剩余 todo）
    assert.ok(result.markdown.includes("wf-status: todo"));
    assert.ok(result.markdown.includes("wf-updated: 2026-10-11"));
  });

  test("写回结果再跑一次（同输入 + 同基准时间）→ 文本完全一致（幂等/可复现）", () => {
    const first = applyMutation(validMarkdown(), completeNode(DOING_ID), { now: NOW });
    const second = applyMutation(first.markdown, completeNode(DOING_ID), { now: NOW });

    assert.equal(second.success, true);
    assert.equal(second.markdown, first.markdown);
    assert.equal(second.upgraded, false);
  });

  test("1.1 文件：顺带落盘升格为 1.6（upgraded=true）", () => {
    const result = applyMutation(validMarkdown11(), completeNode("nd-uuid-002"), { now: NOW });

    assert.equal(result.success, true);
    assert.equal(result.upgraded, true);
    assert.ok(result.markdown.includes('"schemaVersion": "1.9"'));
    assert.equal(result.analysis.hasError, false);
  });

  test("1.3 文件：顺带落盘升格为 1.6（upgraded=true），文本保留计时与归档字段", () => {
    const result = applyMutation(validMarkdown13(), () => ({ changedNodeIds: [] }), { now: NOW });

    assert.equal(result.success, true);
    assert.equal(result.upgraded, true);
    assert.equal(result.analysis.hasError, false);
    assert.ok(result.markdown.includes('"schemaVersion": "1.9"'));
    assert.ok(result.markdown.includes('"timeEntries"'));
    assert.ok(result.markdown.includes(TIME_ARCHIVED_AT));
  });

  test("mutator 声明 changed=false → 不写回、文本原样", () => {
    const result = applyMutation(validMarkdown(), () => ({ changed: false }), { now: NOW });

    assert.equal(result.success, true);
    assert.equal(result.changed, false);
    assert.equal(result.upgraded, false);
    assert.equal(result.markdown, validMarkdown());
  });
});

describe("mutate · 拒绝路径（失败必须原文返回）", () => {
  test("节点不存在 → reject，文本保持原样", () => {
    const markdown = validMarkdown();
    const result = applyMutation(markdown, completeNode("nd-missing"), { now: NOW });

    assert.equal(result.success, false);
    assert.equal(result.changed, false);
    assert.equal(result.markdown, markdown);
    assert.match(result.reason ?? "", /不存在/);
  });

  test("当前文件有 error → 拒绝写入，并指出错误码", () => {
    const broken = validMarkdown().replace(" ^nd-uuid-003", "");
    const result = applyMutation(broken, completeNode(DOING_ID), { now: NOW });

    assert.equal(result.success, false);
    assert.equal(result.markdown, broken);
    assert.match(result.reason ?? "", /拒绝写入/);
    assert.match(result.reason ?? "", /NOTE_ANCHOR_MISSING_IN_BODY/);
  });

  test("没有 wfjson 代码块 → 拒绝", () => {
    const markdown = "# 只是一篇普通笔记\n";
    const result = applyMutation(markdown, () => undefined, { now: NOW });

    assert.equal(result.success, false);
    assert.equal(result.markdown, markdown);
    assert.match(result.reason ?? "", /没有 wfjson 代码块/);
  });

  test("mutator 抛错 → 拒绝并带上错误信息", () => {
    const markdown = validMarkdown();
    const result = applyMutation(markdown, () => {
      throw new Error("业务炸了");
    }, { now: NOW });

    assert.equal(result.success, false);
    assert.equal(result.markdown, markdown);
    assert.match(result.reason ?? "", /变更函数抛错：业务炸了/);
  });

  test("写回结果不通过校验 → 整笔回滚，且返回的分析是**原文**的", () => {
    const markdown = validMarkdown();
    const result = applyMutation(markdown, (document) => {
      const node = findNode(document, DOING_ID);
      if (node) (node as { status: string }).status = "unknown";
      return undefined;
    }, { now: NOW });

    assert.equal(result.success, false);
    assert.equal(result.markdown, markdown);
    assert.match(result.reason ?? "", /写回结果未通过校验/);
    // 返回的 analysis 描述的是原文（仍是合法数据），不是内存里那份被改坏的数据
    assert.equal(result.analysis.hasError, false);
    const restored: NodeStatus | undefined = result.analysis.document?.workflows[0].root.children[1].status;
    assert.equal(restored, "doing");
  });
});
