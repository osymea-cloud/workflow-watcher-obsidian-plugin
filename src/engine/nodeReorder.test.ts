/**
 * 节点顺序调整（nodeReorder.ts）单测 —— Phase 15 契约 §⑥。
 *
 * 覆盖三件事：
 *  1. `after` / `before` 两条语义（a 的去向、a 的原 children、b 的 children）；
 *  2. 护栏（根不可拖 / before + 根 / a === b / a 是 b 的父节点）——拒绝时**文档一字不动**；
 *  3. 边界（pa === pb 时下标重算 / b 是 a 的祖先 / 已在目标位置 / 幂等）与节点数守恒。
 *
 * Phase 27（M1）：跨工作流拖拽已放开，单独一组用例覆盖（见文件末尾「跨工作流」describe）。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { moveNode } from "./nodeReorder.ts";
import { CHILD_ID, clone, DOING_ID, leaf, ROOT_ID, validDocument, WF1_ID, WF2_ID, WF2_ROOT_ID } from "./testFixtures.ts";
import { countNodes, findNode, findNodeVisit, walkWorkflow } from "./tree.ts";
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

/**
 * 样例树（Phase 27 跨流用例）：wf1 = root → [CHILD_ID → nd-deep, DOING_ID]；
 * wf2 = root → [nd-b1 → nd-b2]（wf2 的根 WF2_ROOT_ID 自己没有父节点，用来测「before + 根」）。
 */
function documentWithTwoFlows(): WfJsonDocument {
  const document = clone(validDocument());
  const child = nodeOf(document, CHILD_ID);
  child.children = [leaf("nd-deep", "深层任务")];
  document.workflows[1].root.children = [leaf("nd-b1", "B1", { children: [leaf("nd-b2", "B2")] })];
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
  });
});

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

  test("跨 workflow + 目标是根 + before → 拒绝（沿用「根没有同级」）", () => {
    const document = documentWithTwoFlows();
    const before = JSON.stringify(document);
    const result = moveNode(document, CHILD_ID, WF2_ROOT_ID, "before", NOW);

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /根节点没有同级/);
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

  test("a 是 b 的父节点（拖子节点到自己身上）→ 拒绝", () => {
    const document = documentWithDeepTree();
    const before = JSON.stringify(document);
    const result = moveNode(document, CHILD_ID, "nd-deep", "after", NOW);

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /父子/);
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

  test("幂等：同一 before 操作连做两次，第二次 unchanged", () => {
    const document = documentWithSiblings();
    const first = moveNode(document, "nd-b", "nd-a", "before", NOW);
    assert.equal(first.ok, true);
    const afterFirst = JSON.stringify(document);

    const second = moveNode(document, "nd-b", "nd-a", "before", NOW);
    assert.equal(second.ok, true);
    assert.equal(second.unchanged, true);
    assert.equal(JSON.stringify(document), afterFirst);
  });
});

/* ------------------------------------------------------------------ *
 * Phase 21：拖拽规则补充契约（doc/datacontact/data_ixd_discuss_interact_v0.21.md）
 *  ① 折叠节点（`keepSubtree`）：整棵子树跟着走，父节点只少一个 a；
 *     `after` 时 b 原来的 children **追加在 a 原有 children 之后**；
 *  ② 父子位置置换（两个方向 × 两种落点）一律拒绝；相邻兄弟互换**不禁**；
 *  ③ 折叠节点不能拖进自己的子孙（子树不会先摊平 → 会成环）；非折叠节点仍可（老语义）。
 * ------------------------------------------------------------------ */

/** 样例树：root → [A(→ A1), B(→ B1, B2)]；用于折叠节点的串行 / 并行插入 */
function documentWithDonorChildren(): WfJsonDocument {
  const document = clone(validDocument());
  document.workflows[0].root.children = [
    { ...leaf("nd-a", "A"), children: [leaf("nd-a1", "A1")] },
    { ...leaf("nd-b", "B"), children: [leaf("nd-b1", "B1"), leaf("nd-b2", "B2")] },
  ];
  return document;
}

/** 样例树：root → [CHILD_ID(→ nd-mid(→ nd-deep)), DOING_ID]；用于「祖先 ≠ 直系父」的判定 */
function documentWithGrandchild(): WfJsonDocument {
  const document = clone(validDocument());
  nodeOf(document, CHILD_ID).children = [
    { ...leaf("nd-mid", "中层"), children: [leaf("nd-deep", "深层任务")] },
  ];
  return document;
}

/** 子树 id（DFS 先序，含自身）—— 断言「整块搬运」用 */
function subtreeIdList(node: WfNode): string[] {
  const ids: string[] = [];
  const walk = (current: WfNode): void => {
    ids.push(current.id);
    for (const child of current.children ?? []) walk(child);
  };
  walk(node);
  return ids;
}



describe("moveNode · Phase 21 折叠节点（keepSubtree）", () => {
  test("after：a 保留自己的 children，b 的追加在后；pa 只少一个 a（不再补 a 的子节点）", () => {
    const document = documentWithDonorChildren();
    const result = moveNode(document, "nd-a", "nd-b", "after", NOW, { keepSubtree: true });

    assert.equal(result.ok, true);
    const root = nodeOf(document, ROOT_ID);
    const a = nodeOf(document, "nd-a");
    const b = nodeOf(document, "nd-b");

    assert.deepEqual(childIds(root), ["nd-b"], "a 摘走后父节点不再补 a 的子节点");
    assert.deepEqual(childIds(b), ["nd-a"], "b 的唯一子节点是 a");
    assert.deepEqual(childIds(a), ["nd-a1", "nd-b1", "nd-b2"], "a 原有 children 在前、b 的追加在后");
    assert.equal(root.updatedAt, AT, "pa 的 updatedAt 被刷新");

    assert.deepEqual([...result.changedNodeIds].sort(), ["nd-a", "nd-b", ROOT_ID].sort());
    assert.equal(countNodes(document), 7, "节点数守恒（wf1 = 6 个 + wf2 根）");
    for (const id of ["nd-a", "nd-a1", "nd-b1", "nd-b2"]) {
      assert.equal(occurrences(root, id), 1, `id ${id} 只出现一次`);
    }
  });

  test("before：a 保留自己的 children，b 的 children 不动", () => {
    const document = documentWithDonorChildren();
    const result = moveNode(document, "nd-b", "nd-a", "before", NOW, { keepSubtree: true });

    assert.equal(result.ok, true);
    const root = nodeOf(document, ROOT_ID);
    assert.deepEqual(childIds(root), ["nd-b", "nd-a"], "a 插到 b 之前（同层），子树整块跟随");
    assert.deepEqual(subtreeIdList(nodeOf(document, "nd-b")), ["nd-b", "nd-b1", "nd-b2"]);
    assert.deepEqual(childIds(nodeOf(document, "nd-a")), ["nd-a1"], "b 的 children 不受影响");
  });

  test("折叠标记原样保留：搬运不动 `collapsed`", () => {
    const document = documentWithDonorChildren();
    nodeOf(document, "nd-a").collapsed = true;

    const result = moveNode(document, "nd-a", "nd-b", "before", NOW, { keepSubtree: true });

    assert.equal(result.ok, true);
    assert.equal(nodeOf(document, "nd-a").collapsed, true);
  });

  test("折叠节点拖进自己的子孙 → 拒绝（子树不会先摊平，会成环）", () => {
    const document = documentWithGrandchild();
    const before = JSON.stringify(document);
    const result = moveNode(document, CHILD_ID, "nd-deep", "after", NOW, { keepSubtree: true });

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /子树/);
    assert.equal(JSON.stringify(document), before, "拒绝时文档一字不动");
  });

  test("同一落点不带 keepSubtree → 老语义（children 摊回原位、a 接手 b 的 children）", () => {
    const document = documentWithGrandchild();
    const result = moveNode(document, CHILD_ID, "nd-deep", "after", NOW);

    assert.equal(result.ok, true);
    const root = nodeOf(document, ROOT_ID);
    assert.deepEqual(childIds(root), ["nd-mid", DOING_ID], "a 的 children 提升到 a 原来的位置");
    assert.deepEqual(childIds(nodeOf(document, "nd-deep")), [CHILD_ID], "a 成为 b 的唯一子节点");
    assert.deepEqual(childIds(nodeOf(document, CHILD_ID)), [], "b 原来是叶子 → a 接手空 children");
    assert.equal(countNodes(document), 6);
    for (const id of [ROOT_ID, CHILD_ID, "nd-mid", "nd-deep", DOING_ID]) {
      assert.equal(occurrences(root, id), 1, `id ${id} 只出现一次（没有成环）`);
    }
  });
});


describe("moveNode · Phase 21 父子位置置换（两个方向 × 两种落点都拒绝）", () => {
  test("子节点拖到父节点上半（before）→ 拒绝（旧实现会把 a 挂成自己的子节点）", () => {
    const document = documentWithGrandchild();
    const before = JSON.stringify(document);
    const result = moveNode(document, "nd-mid", CHILD_ID, "before", NOW);

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /父子/);
    assert.equal(JSON.stringify(document), before);
  });

  test("子节点拖到父节点下半（after）→ 拒绝", () => {
    const document = documentWithGrandchild();
    const before = JSON.stringify(document);
    const result = moveNode(document, "nd-mid", CHILD_ID, "after", NOW);

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /父子/);
    assert.equal(JSON.stringify(document), before);
  });

  test("父节点拖到子节点上半 / 下半 → 都拒绝", () => {
    const document = documentWithGrandchild();
    const before = JSON.stringify(document);
    assert.equal(moveNode(document, CHILD_ID, "nd-mid", "before", NOW).ok, false);
    assert.equal(moveNode(document, CHILD_ID, "nd-mid", "after", NOW).ok, false);
    assert.equal(JSON.stringify(document), before);
  });

  test("折叠节点同样受父子护栏约束（keepSubtree 不豁免）", () => {
    const document = documentWithDonorChildren();
    const before = JSON.stringify(document);
    const result = moveNode(document, "nd-a", "nd-a1", "after", NOW, { keepSubtree: true });

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /父子/);
    assert.equal(JSON.stringify(document), before);
  });

  test("相邻兄弟互换 → 允许（「前后节点不能互换位置」只针对父子）", () => {
    const document = documentWithSiblings();
    const result = moveNode(document, "nd-c", "nd-a", "before", NOW);

    assert.equal(result.ok, true);
    assert.deepEqual(childIds(nodeOf(document, ROOT_ID)), ["nd-c", "nd-a", "nd-b"]);
  });
});


/* ------------------------------------------------------------------ *
 * Phase 27（M1）：跨工作流拖拽
 *
 * 语义完全由「落点卡片属于哪条 workflow」决定：
 *  - `after`  → a 成为 b 的子节点（落在 b 所在的那条 workflow 里），并接手 b 原有的 children；
 *  - `before` → a 成为 b 的同级（父节点 = b 的父节点），b 的 children 不动；
 *  - 目标是某条流的根 + `before` → 仍然拒绝（根没有同级）→ 「拖进某条流」只接 `after`。
 * ------------------------------------------------------------------ */
describe("moveNode · Phase 27 跨工作流", () => {
  test("跨流 after：a 落到 wf2，接手 b 原 children，四条 id 进 changedNodeIds", () => {
    const document = documentWithTwoFlows();
    const result = moveNode(document, CHILD_ID, "nd-b1", "after", NOW);

    assert.equal(result.ok, true);
    assert.equal(result.unchanged, undefined);
    // 归属变了：a 现在属于 wf2
    assert.equal(findNodeVisit(document, CHILD_ID)?.workflow.id, WF2_ID);
    assert.equal(findNodeVisit(document, CHILD_ID)?.parent?.id, "nd-b1");
    // b 的原 children 全归 a；b.children 恰为 [a]
    assert.deepEqual(childIds(nodeOf(document, CHILD_ID)), ["nd-b2"]);
    assert.deepEqual(childIds(nodeOf(document, "nd-b1")), [CHILD_ID]);
    // a 的原子节点被摊平回 wf1 的根（普通节点语义不变）
    assert.deepEqual(childIds(nodeOf(document, ROOT_ID)), ["nd-deep", DOING_ID]);
    // a / b / pa / pb 四条都在
    assert.deepEqual(
      [...result.changedNodeIds].sort(),
      [CHILD_ID, "nd-b1", ROOT_ID, WF2_ROOT_ID].sort(),
    );
    // 时间戳：跨流的 pa 与 pb 都刷新
    assert.equal(nodeOf(document, ROOT_ID).updatedAt, AT);
    assert.equal(nodeOf(document, WF2_ROOT_ID).updatedAt, AT);
  });

  test("跨流 before：a 成为 b 的同级（父节点 = b 的父节点），b 的 children 不动", () => {
    const document = documentWithTwoFlows();
    const result = moveNode(document, CHILD_ID, "nd-b1", "before", NOW);

    assert.equal(result.ok, true);
    assert.equal(findNodeVisit(document, CHILD_ID)?.workflow.id, WF2_ID);
    assert.equal(findNodeVisit(document, CHILD_ID)?.parent?.id, WF2_ROOT_ID);
    assert.deepEqual(childIds(nodeOf(document, WF2_ROOT_ID)), [CHILD_ID, "nd-b1"]);
    // b 的 children 一字不动
    assert.deepEqual(childIds(nodeOf(document, "nd-b1")), ["nd-b2"]);
    // wf1 侧：a 的子节点被摊平回原位
    assert.deepEqual(childIds(nodeOf(document, ROOT_ID)), ["nd-deep", DOING_ID]);
    assert.deepEqual(
      [...result.changedNodeIds].sort(),
      [CHILD_ID, "nd-b1", ROOT_ID, WF2_ROOT_ID].sort(),
    );
  });

  test("跨流 after 拖到某条流的根卡片：成为该根的唯一子节点（接手它原有的 children）", () => {
    const document = documentWithTwoFlows();
    const result = moveNode(document, CHILD_ID, WF2_ROOT_ID, "after", NOW);

    assert.equal(result.ok, true);
    assert.deepEqual(childIds(nodeOf(document, WF2_ROOT_ID)), [CHILD_ID]);
    // wf2 根原来的 children（nd-b1 子树）整体交给 a
    assert.deepEqual(childIds(nodeOf(document, CHILD_ID)), ["nd-b1"]);
    assert.deepEqual(childIds(nodeOf(document, "nd-b1")), ["nd-b2"]);
  });

  test("跨流 + a 是根 → 拒绝（沿用「根不能被拖动」），文档一字不动", () => {
    const document = documentWithTwoFlows();
    const before = JSON.stringify(document);
    const result = moveNode(document, ROOT_ID, "nd-b1", "after", NOW);

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /根节点/);
    assert.equal(JSON.stringify(document), before);
  });

  test("跨流 + keepSubtree：整棵子树跟着走，b 的原 children 追加在其后", () => {
    const document = documentWithTwoFlows();
    const result = moveNode(document, CHILD_ID, "nd-b1", "after", NOW, { keepSubtree: true });

    assert.equal(result.ok, true);
    // a 保留自己的 children，b 的追加在后
    assert.deepEqual(childIds(nodeOf(document, CHILD_ID)), ["nd-deep", "nd-b2"]);
    assert.deepEqual(childIds(nodeOf(document, "nd-b1")), [CHILD_ID]);
    // pa 只少了一个 a（不再把它的 children 提升上来）
    assert.deepEqual(childIds(nodeOf(document, ROOT_ID)), [DOING_ID]);
    assert.equal(findNodeVisit(document, CHILD_ID)?.workflow.id, WF2_ID);
  });

  test("跨流拖回原位（先拖过去再拖回来）→ 第二次 unchanged（字节一致）", () => {
    const document = documentWithTwoFlows();
    // 第一次：wf1 的 CHILD_ID 拖到 wf2 的 nd-b1 之前
    assert.equal(moveNode(document, CHILD_ID, "nd-b1", "before", NOW).ok, true);
    assert.equal(findNodeVisit(document, CHILD_ID)?.workflow.id, WF2_ID);
    // 第二次：再拖回 wf1（插到 DOING_ID 之前）—— 真实改动
    const back = moveNode(document, CHILD_ID, DOING_ID, "before", NOW);
    assert.equal(back.ok, true);
    assert.equal(back.unchanged, undefined);
    assert.equal(findNodeVisit(document, CHILD_ID)?.workflow.id, WF1_ID);
    assert.deepEqual(childIds(nodeOf(document, ROOT_ID)), ["nd-deep", CHILD_ID, DOING_ID]);
    // 第三次：同一落点再来一次 → 已在原位，字节一致 → unchanged
    const again = moveNode(document, CHILD_ID, DOING_ID, "before", NOW);
    assert.equal(again.ok, true);
    assert.equal(again.unchanged, true);
    assert.deepEqual(again.changedNodeIds, []);
    // 全程节点数守恒（摊平 / 提升都不复制节点）
    assert.equal(countNodes(document), countNodes(documentWithTwoFlows()));
  });
});

