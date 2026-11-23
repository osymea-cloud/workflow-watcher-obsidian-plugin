/**
 * 「未分类」伪工作流（unclassified.ts）单测 —— Phase 27 §4.6。
 *
 * 覆盖三件事：
 *  1. `ensureUnclassifiedWorkflow` 幂等（两次调用只产生一条）、不影响真实工作流；
 *  2. `addUnclassifiedNode` 追加到 `root.children` 末尾 + 标题清洗；
 *  3. `attachNodeToUnclassified` 保留子树、原父节点少一个、根节点被拒、重复搬 = unchanged。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { addUnclassifiedNode, attachNodeToUnclassified, ensureUnclassifiedWorkflow } from "./unclassified.ts";
import { CHILD_ID, DOING_ID, ROOT_ID, WF1_ID, clone, leaf, validDocument } from "./testFixtures.ts";
import { countNodes, findNode, findWorkflow, walkWorkflow } from "./tree.ts";
import { UNCLASSIFIED_WORKFLOW_ID } from "./types.ts";

const NOW = new Date("2026-10-12T09:00:00+08:00");

/** 未分类容器的 children id 列表 */
function unclassifiedChildIds(document: ReturnType<typeof validDocument>): string[] {
  const workflow = findWorkflow(document, UNCLASSIFIED_WORKFLOW_ID);
  assert.ok(workflow, "未分类容器应当存在");
  return (workflow.root.children ?? []).map((node) => node.id);
}

describe("unclassified · 容器", () => {
  test("ensureUnclassifiedWorkflow：幂等，且不影响已有工作流", () => {
    const document = validDocument();
    const before = document.workflows.map((workflow) => workflow.id);

    const first = ensureUnclassifiedWorkflow(document, NOW);
    const second = ensureUnclassifiedWorkflow(document, NOW);

    assert.equal(first, second, "两次调用必须拿到同一条 workflow");
    assert.equal(document.workflows.length, before.length + 1);
    assert.deepEqual(
      document.workflows.slice(0, before.length).map((workflow) => workflow.id),
      before,
      "真实工作流一字不动",
    );
    assert.equal(first.id, UNCLASSIFIED_WORKFLOW_ID);
    assert.deepEqual(first.root.children, [], "隐藏 root 初始没有 children");
    assert.equal(first.state, undefined, "不写 state（缺省 = 进行中，但 groupWorkflows 先按 id 分桶）");
  });
});

describe("unclassified · 新建节点", () => {
  test("addUnclassifiedNode：追加到 root.children 末尾 + 标题清洗", () => {
    const document = clone(validDocument());

    const first = addUnclassifiedNode(document, { title: "随手记" }, NOW);
    const second = addUnclassifiedNode(document, { title: "  买咖啡豆  " }, NOW);

    assert.equal(first.ok, true);
    assert.equal(second.ok, true);
    assert.deepEqual(unclassifiedChildIds(document), [first.nodeId, second.nodeId]);

    const node = findNode(document, second.nodeId ?? "");
    assert.ok(node, "新节点应当能在文档里找到");
    assert.equal(node.title, "买咖啡豆", "标题两端空白被清掉");
    assert.equal(node.status, "todo");
    assert.equal(node.progress, 0);
    assert.equal(node.startAt, "2026-10-12T09:00:00+08:00");
  });

  test("addUnclassifiedNode：空标题被拒绝，容器不被创建", () => {
    const document = clone(validDocument());
    const count = document.workflows.length;

    const result = addUnclassifiedNode(document, { title: "   " }, NOW);

    assert.equal(result.ok, false);
    assert.equal(document.workflows.length, count, "拒绝时不写容器");
  });
});

describe("unclassified · 搬入已有节点", () => {
  test("从 wf1 的中间位置搬来：原父节点少一个、未分类末尾多一个、子树保留", () => {
    const document = clone(validDocument());
    // 给中间节点造一个孙节点，用来验证「整棵子树跟着走」
    document.workflows[0].root.children[0].children = [leaf("nd-gc-1", "孙节点")];
    const totalBefore = countNodes(document);

    const result = attachNodeToUnclassified(document, CHILD_ID, NOW);

    assert.equal(result.ok, true);
    assert.equal(result.unchanged, undefined);
    assert.deepEqual(unclassifiedChildIds(document), [CHILD_ID]);
    assert.deepEqual(
      document.workflows[0].root.children.map((node) => node.id),
      [DOING_ID],
      "原父节点少一个兄弟",
    );

    // 整棵子树跟着走：孙节点一个不少
    const moved = findNode(document, CHILD_ID);
    assert.ok(moved);
    assert.deepEqual((moved.children ?? []).map((node) => node.id), ["nd-gc-1"]);
    assert.equal(countNodes(document), totalBefore + 1, "节点数守恒（只多出未分类的隐藏 root）");
  });

  test("搬叶子节点：未分类末尾多一个，兄弟顺序不变", () => {
    const document = clone(validDocument());

    const result = attachNodeToUnclassified(document, DOING_ID, NOW);

    assert.equal(result.ok, true);
    assert.deepEqual(unclassifiedChildIds(document), [DOING_ID]);
    assert.deepEqual(document.workflows[0].root.children.map((node) => node.id), [CHILD_ID]);
  });

  test("搬子树里的非根节点：children 原样保留", () => {
    const document = clone(validDocument());

    const result = attachNodeToUnclassified(document, CHILD_ID, NOW);

    assert.equal(result.ok, true);
    assert.deepEqual(unclassifiedChildIds(document), [CHILD_ID]);
    assert.deepEqual(document.workflows[0].root.children.map((node) => node.id), [DOING_ID]);
  });

  test("搬某条流的 root：ok=false（根节点不能被搬走），文档一字不动", () => {
    const document = clone(validDocument());
    const snapshot = JSON.stringify(document);

    const result = attachNodeToUnclassified(document, ROOT_ID, NOW);

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /根节点/);
    assert.equal(findWorkflow(document, UNCLASSIFIED_WORKFLOW_ID), undefined, "拒绝时也不建容器");
    assert.equal(JSON.stringify(document), snapshot);
  });

  test("重复搬同一节点：unchanged=true，不再写盘", () => {
    const document = clone(validDocument());
    attachNodeToUnclassified(document, CHILD_ID, NOW);

    const again = attachNodeToUnclassified(document, CHILD_ID, NOW);

    assert.equal(again.ok, true);
    assert.equal(again.unchanged, true);
    assert.deepEqual(unclassifiedChildIds(document), [CHILD_ID], "没有被搬两次");
  });

  test("节点不存在：ok=false", () => {
    const document = clone(validDocument());
    const result = attachNodeToUnclassified(document, "nd-nope", NOW);

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /nd-nope/);
  });

  test("搬走后 wf1 仍然可遍历，未分类容器也在 walked 之内", () => {
    const document = clone(validDocument());
    attachNodeToUnclassified(document, CHILD_ID, NOW);

    const workflow = findWorkflow(document, UNCLASSIFIED_WORKFLOW_ID);
    assert.ok(workflow);
    assert.deepEqual(
      walkWorkflow(workflow).map((visit) => visit.node.id),
      [workflow.root.id, CHILD_ID],
      "先序遍历 = 隐藏 root + 搬来的节点",
    );
    assert.equal(findWorkflow(document, WF1_ID)?.root.children.length, 1);
  });
});
