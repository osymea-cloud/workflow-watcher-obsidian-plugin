/**
 * 树遍历与 id 索引的单测。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  countNodes,
  findNode,
  findNodePath,
  findNodeVisit,
  findParentNode,
  findWorkflow,
  flattenNodes,
  indexIds,
  walkNodes,
  walkWorkflow,
} from "./tree.ts";
import { CHILD_ID, DOING_ID, ROOT_ID, WF1_ID, WF2_ROOT_ID, clone, validDocument } from "./testFixtures.ts";

describe("tree · 遍历", () => {
  test("walkWorkflow：先序、带父节点/深度/路径", () => {
    const document = validDocument();
    const visits = walkWorkflow(document.workflows[0]);
    assert.deepEqual(
      visits.map((visit) => visit.node.id),
      [ROOT_ID, CHILD_ID, DOING_ID],
    );
    assert.deepEqual(
      visits.map((visit) => visit.depth),
      [0, 1, 1],
    );
    assert.deepEqual(
      visits.map((visit) => visit.index),
      [0, 0, 1],
    );
    assert.equal(visits[0].parent, undefined);
    assert.equal(visits[1].parent?.id, ROOT_ID);
    assert.deepEqual(
      visits[2].path.map((node) => node.id),
      [ROOT_ID, DOING_ID],
    );
    assert.equal(visits[1].workflow.id, WF1_ID);
  });

  test("walkNodes / flattenNodes / countNodes：覆盖全部工作流", () => {
    const document = validDocument();
    const visits = walkNodes(document);
    assert.deepEqual(
      visits.map((visit) => visit.node.id),
      [ROOT_ID, CHILD_ID, DOING_ID, WF2_ROOT_ID],
    );
    assert.equal(countNodes(document), 4);
    assert.equal(flattenNodes(document).length, 4);
  });
});

describe("tree · 查找", () => {
  test("findNode / findNodeVisit / findNodePath / findParentNode", () => {
    const document = validDocument();
    assert.equal(findNode(document, DOING_ID)?.title, "交叉验证");
    assert.equal(findNode(document, "nd-不存在"), undefined);
    assert.equal(findNodeVisit(document, CHILD_ID)?.depth, 1);
    assert.deepEqual(
      findNodePath(document, DOING_ID).map((node) => node.id),
      [ROOT_ID, DOING_ID],
    );
    assert.deepEqual(findNodePath(document, "nd-不存在"), []);
    assert.equal(findParentNode(document, CHILD_ID)?.id, ROOT_ID);
    assert.equal(findParentNode(document, ROOT_ID), undefined);
  });

  test("findWorkflow：按 id 取工作流", () => {
    const document = validDocument();
    assert.equal(findWorkflow(document, WF1_ID)?.title, "立项调查");
    assert.equal(findWorkflow(document, "wf-不存在"), undefined);
  });
});

describe("tree · id 索引", () => {
  test("正常文档：三类 id 都在索引里，没有重复项", () => {
    const document = validDocument();
    const ids = indexIds(document);
    assert.equal(ids.nodes.size, 4);
    assert.equal(ids.workflows.size, 2);
    assert.equal(ids.links.size, 3);
    assert.equal(ids.duplicated.size, 0);
    assert.equal(ids.nodes.get(ROOT_ID)?.title, "调研竞品");
    assert.deepEqual(ids.links.get("lk-1"), [{ nodeId: ROOT_ID, linkId: "lk-1" }]);
  });

  test("重复 id 会被收集起来", () => {
    const document = clone(validDocument());
    // 重复节点 id
    document.workflows[1].root.id = ROOT_ID;
    document.workflows[1].root.noteAnchor = `^${ROOT_ID}`;
    // 重复链接 id（挂在另一个节点上）
    document.workflows[0].root.children[0].links = [
      { id: "lk-1", type: "web", target: "https://example.com" },
    ];
    // 重复工作流 id
    document.workflows[1].id = WF1_ID;

    const ids = indexIds(document);
    assert.equal(ids.duplicated.has(ROOT_ID), true);
    assert.equal(ids.duplicated.has("lk-1"), true);
    assert.equal(ids.duplicated.has(WF1_ID), true);
    assert.equal(ids.links.get("lk-1")?.length, 2);
  });
});
