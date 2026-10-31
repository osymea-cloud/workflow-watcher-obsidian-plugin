/**
 * 节点顺序调整（nodeReorder.ts）单测 —— Phase 15 契约 §⑥。
 *
 * 覆盖三件事：
 *  1. `after` / `before` 两条语义（a 的去向、a 的原 children、b 的 children）；
 *  2. 护栏（根不可拖 / before + 根 / 跨 workflow / a === b / a 是 b 的祖先）——拒绝时**文档一字不动**；
 *  3. 边界（pa === pb 时下标重算 / b 是 a 的祖先 / 已在目标位置 / 幂等）与节点数守恒。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { moveNode } from "./nodeReorder.ts";
import { CHILD_ID, clone, DOING_ID, leaf, ROOT_ID, validDocument, WF2_ROOT_ID } from "./testFixtures.ts";
import { countNodes, findNode, walkWorkflow } from "./tree.ts";
import type { WfJsonDocument, WfNode } from "./types.ts";

const NOW = new Date("2026-10-12T09:00:00+08:00");
const AT = "2026-10-12T09:00:00+08:00";

/** 取节点（不存在直接让测试失败） */
function nodeOf(document: WfJsonDocument, id: string): WfNode {
  const node = findNode(document, id);
  assert.ok(node, `节点 ${id} 应当存在`);
  return node;
}

/** 同层 id 列表（便于断言 children 顺序） */
function childIds(node: WfNode): string[] {
  return (node.children ?? []).map((child) => child.id);
}

/** 某个 id 在子树里出现几次（用于「无重复 id」断言） */
function occurrences(node: WfNode, id: string): number {
  let count = node.id === id ? 1 : 0;
  for (const child of node.children ?? []) count += occurrences(child, id);
  return count;
}

/** 样例树：root → [CHILD_ID → nd-deep, DOING_ID]；workflow 2 的根保持不动 */
function documentWithDeepTree(): WfJsonDocument {
  const document = clone(validDocument());
  const child = nodeOf(document, CHILD_ID);
  child.children = [leaf("nd-deep", "深层任务")];
  return document;
}

/** 样例树：root → 三个叶子（A / B / C），用于「同级重排 ↔ unchanged」 */
function documentWithSiblings(): WfJsonDocument {
  const document = clone(validDocument());
  document.workflows[0].root.children = [leaf("nd-a", "A"), leaf("nd-b", "B"), leaf("nd-c", "C")];
  return document;
}
describe("moveNode · after（成为目标节点的子节点，接手它的 children）", () => {
  test("a 的 children 提升回 pa、b 的原 children 全归 a、b.children 恰为 [a]", () => {
    const document = documentWithDeepTree();
    const result = moveNode(document, CHILD_ID, DOING_ID, "after", NOW);

    assert.equal(result.ok, true);
    assert.equal(result.unchanged, undefined);
    const root = nodeOf(document, ROOT_ID);
    const a = nodeOf(document, CHILD_ID);
    const b = nodeOf(document, DOING_ID);

    assert.deepEqual(childIds(root), ["nd-deep", DOING_ID], "a 摘走后它的子节点提升到 a 的原位");
    assert.deepEqual(childIds(b), [CHILD_ID], "b 的唯一子节点是 a");
    assert.deepEqual(childIds(a), [], "b 原来是叶子 → a 接手空 children");
    assert.equal(root.updatedAt, AT, "pa 的 updatedAt 被刷新");
    assert.equal(b.updatedAt, AT, "after 时 b 就是 pb，同样刷新");

    assert.deepEqual([...result.changedNodeIds].sort(), [CHILD_ID, DOING_ID, ROOT_ID].sort());
    assert.equal(countNodes(document), 5, "节点数守恒（2 个 workflow 共 5 个）");
  });

  test("b 有 children 时整体交给 a（先 a.children = b.children，再 b.children = [a]）", () => {
    const document = documentWithDeepTree();
    const result = moveNode(document, DOING_ID, CHILD_ID, "after", NOW);

    assert.equal(result.ok, true);
    const root = nodeOf(document, ROOT_ID);
    const a = nodeOf(document, DOING_ID);
    const b = nodeOf(document, CHILD_ID);

    assert.deepEqual(childIds(root), [CHILD_ID], "a 是叶子 → 摘走后没有子节点需要提升");
    assert.deepEqual(childIds(b), [DOING_ID]);
    assert.deepEqual(childIds(a), ["nd-deep"], "b 原来的子节点整体归 a（不是 [a]）");
  });
});

describe("moveNode · before（成为目标的前一个同级，b 的 children 不变）", () => {
  test("a 插到 pb 里 b 之前；b 的 children 不变；a 的 children 提升回 pa", () => {
    const document = documentWithDeepTree();
    const result = moveNode(document, DOING_ID, CHILD_ID, "before", NOW);

    assert.equal(result.ok, true);
    const root = nodeOf(document, ROOT_ID);
    const a = nodeOf(document, DOING_ID);
    const b = nodeOf(document, CHILD_ID);

    assert.deepEqual(childIds(root), [DOING_ID, CHILD_ID], "a 排在 b 之前");
    assert.deepEqual(childIds(b), ["nd-deep"], "b 的 children 不变");
    assert.deepEqual(childIds(a), []);
    assert.equal(root.updatedAt, AT);
    assert.equal(b.updatedAt, undefined, "before 时 b 的 children 不变 → 不刷它的 updatedAt");
  });

  test("pa === pb 时重算 b 的下标（a 在 b 前面也不会错位）", () => {
    const document = documentWithSiblings();
    const result = moveNode(document, "nd-a", "nd-c", "before", NOW);

    assert.equal(result.ok, true);
    assert.deepEqual(childIds(nodeOf(document, ROOT_ID)), ["nd-b", "nd-a", "nd-c"]);
  });

  test("pa === pb 的 after（a 在 b 后面）→ a 摘走、它的子节点留在原层", () => {
    const document = documentWithSiblings();
    const result = moveNode(document, "nd-a", "nd-c", "after", NOW);

    assert.equal(result.ok, true);
    assert.deepEqual(childIds(nodeOf(document, ROOT_ID)), ["nd-b", "nd-c"], "a 被摘走");
    assert.deepEqual(childIds(nodeOf(document, "nd-c")), ["nd-a"]);

describe("moveNode · 护栏（拒绝时文档一字不动）", () => {
  test("根节点不能被拖动", () => {
    const document = documentWithDeepTree();
    const before = JSON.stringify(document);
    const result = moveNode(document, ROOT_ID, CHILD_ID, "after", NOW);

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /根节点/);
    assert.deepEqual(result.changedNodeIds, []);
    assert.equal(JSON.stringify(document), before);
  });

  test("before + 目标节点是根 → 拒绝（根没有同级）", () => {
    const document = documentWithDeepTree();
    const before = JSON.stringify(document);
    const result = moveNode(document, CHILD_ID, ROOT_ID, "before", NOW);

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /根节点没有同级/);
    assert.equal(JSON.stringify(document), before);
  });

  test("跨 workflow → 拒绝", () => {
    const document = documentWithDeepTree();
    const before = JSON.stringify(document);
    const result = moveNode(document, CHILD_ID, WF2_ROOT_ID, "after", NOW);

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /跨工作流/);
    assert.equal(JSON.stringify(document), before);
  });

  test("a === b → 拒绝", () => {
    const document = documentWithDeepTree();
    const before = JSON.stringify(document);
    const result = moveNode(document, CHILD_ID, CHILD_ID, "after", NOW);

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /自己/);
    assert.equal(JSON.stringify(document), before);
  });

  test("a 是 b 的祖先 → 拒绝（会成环）", () => {
    const document = documentWithDeepTree();
    const before = JSON.stringify(document);
    const result = moveNode(document, CHILD_ID, "nd-deep", "after", NOW);

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /子树/);
    assert.equal(JSON.stringify(document), before);
  });

  test("节点不存在 → 拒绝", () => {
    const document = documentWithDeepTree();
    const before = JSON.stringify(document);
    assert.equal(moveNode(document, "nd-nope", CHILD_ID, "after", NOW).ok, false);
    assert.equal(moveNode(document, CHILD_ID, "nd-nope", "after", NOW).ok, false);
    assert.equal(JSON.stringify(document), before);
  });
});

describe("moveNode · 边界（祖先提升 / unchanged / 幂等）", () => {
  test("b 是 a 的祖先（把深处节点提到根下）→ 允许，仍是树：节点数守恒、id 不重复", () => {
    const document = documentWithDeepTree();
    const result = moveNode(document, "nd-deep", ROOT_ID, "after", NOW);

    assert.equal(result.ok, true);
    const root = nodeOf(document, ROOT_ID);
    assert.deepEqual(childIds(root), ["nd-deep"], "a 成为根的唯一子节点");
    assert.deepEqual(childIds(nodeOf(document, "nd-deep")), [CHILD_ID, DOING_ID], "根原来的子节点整体归 a");
    assert.deepEqual(childIds(nodeOf(document, CHILD_ID)), [], "a 从原父节点里摘走");

    const visits = walkWorkflow(document.workflows[0]);
    assert.equal(visits.length, 4, "workflow 1 仍是 4 个节点");
    assert.equal(countNodes(document), 5);
    for (const visit of visits) assert.equal(occurrences(root, visit.node.id), 1, `id ${visit.node.id} 只出现一次`);
  });

  test("b 是 a 的祖先 + before（提升成祖先的同级）→ 允许", () => {
    const document = documentWithDeepTree();
    const result = moveNode(document, "nd-deep", DOING_ID, "before", NOW);

    assert.equal(result.ok, true);
    assert.deepEqual(childIds(nodeOf(document, ROOT_ID)), [CHILD_ID, "nd-deep", DOING_ID]);
    assert.deepEqual(childIds(nodeOf(document, CHILD_ID)), []);
  });

  test("已在目标位置（a 本来就是 b 的前一个同级）→ unchanged，字节一字不动", () => {
    const document = documentWithSiblings();
    const before = JSON.stringify(document);
    const result = moveNode(document, "nd-b", "nd-c", "before", NOW);

    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
    assert.deepEqual(result.changedNodeIds, []);
    assert.equal(JSON.stringify(document), before, "连 updatedAt 都不刷新");
  });

  test("幂等：同一 after 操作连做两次，第二次 unchanged", () => {
    const document = documentWithSiblings();
    const first = moveNode(document, "nd-b", "nd-a", "after", NOW);
    assert.equal(first.ok, true);
    const afterFirst = JSON.stringify(document);

    const second = moveNode(document, "nd-b", "nd-a", "after", NOW);
    assert.equal(second.ok, true);
    assert.equal(second.unchanged, true);
    assert.equal(JSON.stringify(document), afterFirst);
  });
});

  });
});

