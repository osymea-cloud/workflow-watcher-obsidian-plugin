/**
 * 反向 YAML 资料归属（linkAffiliation.ts）单测 —— Phase 27 §5.9。
 *
 * 契约要点：
 *  - 四键解析（字符串 / 数组取首项 / 空串当缺省）；
 *  - 只收 `.md`、无归属文件跳过；
 *  - 匹配优先级 **id 精确 → title 兜底**，id 命中时不混入只靠 title 命中的文件；
 *  - 结果按 path 去重 + 字典序稳定排序；
 *  - Phase 35：四键并行的多归属 —— 追加（`appendAffiliation`）/ 只换命中项
 *    （`replaceAffiliationItem`），以及「写回 md → 再解析」的端到端闭环。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  affiliationKey,
  affiliationOf,
  affiliationsOf,
  appendAffiliation,
  buildReverseIndex,
  collectAffiliatedFiles,
  collectSubtreeFiles,
  collectWorkflowFiles,
  emptyReverseIndex,
  linkedFileTitle,
  nodeRefFor,
  replaceAffiliationItem,
  resolveLinkedFiles,
  type AffiliationEntry,
  type AffiliationFieldValues,
} from "./linkAffiliation.ts";
import { planArchive } from "./archive.ts";
import { parseFrontmatter, setFrontmatterFieldList } from "./frontmatter.ts";
import {
  FRONTMATTER_FIELDS,
  SCHEMA_VERSION,
  type WfJsonDocument,
  type WfNode,
  type WfWorkflow,
} from "./types.ts";
import { leaf } from "./testFixtures.ts";

/** 四键齐全的一条 frontmatter */
function record(workflowTitle: string, nodeTitle: string, workflowId?: string, nodeId?: string) {
  return {
    "wf-workflow": workflowTitle,
    "wf-node": nodeTitle,
    ...(workflowId !== undefined ? { "wf-workflow-id": workflowId } : {}),
    ...(nodeId !== undefined ? { "wf-node-id": nodeId } : {}),
  };
}

/** 一条归属（`appendAffiliation` 的入参：键名是引擎的字段名，不是 frontmatter 键） */
function tuple(workflowTitle: string, nodeTitle: string, workflowId?: string, nodeId?: string) {
  return {
    workflowTitle,
    nodeTitle,
    ...(workflowId !== undefined ? { workflowId } : {}),
    ...(nodeId !== undefined ? { nodeId } : {}),
  };
}

describe("linkAffiliation · 解析四键", () => {
  test("四键齐全 → 解析正确", () => {
    assert.deepEqual(affiliationOf(record("读书计划", "选书", "wf-1", "nd-1")), {
      workflowTitle: "读书计划",
      nodeTitle: "选书",
      workflowId: "wf-1",
      nodeId: "nd-1",
    });
  });

  test("数组取首项 + trim；空串当缺省", () => {
    const parsed = affiliationOf({
      "wf-workflow": [" 读书计划 ", "另一个"],
      "wf-node": ["选书"],
      "wf-workflow-id": [],
      "wf-node-id": "   ",
    });
    assert.deepEqual(parsed, { workflowTitle: "读书计划", nodeTitle: "选书" });
  });

  test("缺 wf-node → undefined（不做半条归属）", () => {
    assert.equal(affiliationOf({ "wf-workflow": "读书计划" }), undefined);
    assert.equal(affiliationOf(undefined), undefined);
  });

  test("非字符串类型当缺省（数字 / 布尔 / 对象）", () => {
    assert.equal(affiliationOf({ "wf-workflow": 1, "wf-node": true }), undefined);
  });

  test("linkedFileTitle / affiliationKey：basename 去 .md、title 两边 trim", () => {
    assert.equal(linkedFileTitle("a/b/选书笔记.md"), "选书笔记");
    assert.equal(linkedFileTitle("顶层.MD"), "顶层");
    assert.equal(affiliationKey(" 读书计划 ", " 选书 "), "读书计划::选书");
    // trim 之后相同 → 同一个 key；大小写不同 → 不同 key（中文为主，仍区分大小写）
    assert.equal(affiliationKey("读书计划", "选书 "), affiliationKey("读书计划", "选书"));
    assert.notEqual(affiliationKey("读书计划", "选书"), affiliationKey("读书计划", "选书A"));
  });
});

describe("linkAffiliation · 建索引 / 查节点", () => {
  const entries: AffiliationEntry[] = [
    { path: "资料/选书笔记.md", frontmatter: record("读书计划", "选书", "wf-1", "nd-1") },
    { path: "资料/选书-第二份.md", frontmatter: record("读书计划", "选书", "wf-1", "nd-1") },
    { path: "资料/只有标题.md", frontmatter: record("读书计划", "选书") },
    { path: "资料/只写 id.md", frontmatter: { "wf-node-id": "nd-9" } },
    { path: "资料/没有归属.md", frontmatter: { tags: ["x"] } },
    { path: "资料/图片.png", frontmatter: record("读书计划", "选书", "wf-1", "nd-1") },
  ];

  test("只收 .md；无归属文件跳过；同 nodeId 多文件都收齐", () => {
    const index = buildReverseIndex(entries);

    assert.deepEqual(
      index.all.map((file) => file.path).sort(),
      ["资料/只写 id.md", "资料/只有标题.md", "资料/选书-第二份.md", "资料/选书笔记.md"],
    );
    assert.equal(index.byNodeId.get("nd-1")?.length, 2);
    assert.equal(index.byNodeId.get("nd-9")?.length, 1, "只写 id 的文件也能进索引");
    assert.equal(index.all.find((file) => file.path === "资料/选书笔记.md")?.title, "选书笔记");
  });

  test("id 命中即权威：不混入只靠 title 命中的文件", () => {
    const index = buildReverseIndex(entries);
    const files = resolveLinkedFiles(index, {
      workflowTitle: "读书计划",
      nodeTitle: "选书",
      workflowId: "wf-1",
      nodeId: "nd-1",
    });

    assert.deepEqual(
      files.map((file) => file.path),
      ["资料/选书-第二份.md", "资料/选书笔记.md"],
      "按 path 字典序稳定排序，且不含「只有标题」那份",
    );
  });

  test("nodeId 未命中 → 走 title 兜底", () => {
    const index = buildReverseIndex(entries);
    const files = resolveLinkedFiles(index, {
      workflowTitle: "读书计划",
      nodeTitle: "选书",
      workflowId: "wf-1",
      nodeId: "nd-unknown",
    });

    assert.deepEqual(
      files.map((file) => file.path),
      ["资料/只有标题.md", "资料/选书-第二份.md", "资料/选书笔记.md"],
      "id 没命中时三份都算（title 兜底）",
    );
  });

  test("两者都没有 → []", () => {
    const index = buildReverseIndex(entries);
    assert.deepEqual(
      resolveLinkedFiles(index, { workflowTitle: "别的流", nodeTitle: "别的节点" }),
      [],
    );
    assert.deepEqual(resolveLinkedFiles(emptyReverseIndex(), { workflowTitle: "读书计划", nodeTitle: "选书" }), []);
  });

  test("路径去重：同一个文件声明两次也只出现一次", () => {
    const index = buildReverseIndex([
      { path: "a.md", frontmatter: record("流", "节点", "wf-1", "nd-1") },
      { path: "a.md", frontmatter: record("流", "节点", "wf-1", "nd-1") },
    ]);
    const files = resolveLinkedFiles(index, { workflowTitle: "流", nodeTitle: "节点", nodeId: "nd-1" });
    assert.equal(files.length, 1);
  });
});

describe("linkAffiliation · Phase 34 并集查询（改名 / 归档同步用）", () => {
  const entries: AffiliationEntry[] = [
    { path: "资料/双键.md", frontmatter: record("读书计划", "选书", "wf-1", "nd-1") },
    { path: "资料/只有标题.md", frontmatter: record("读书计划", "选书") },
    { path: "资料/只有id.md", frontmatter: { "wf-node-id": "nd-1" } },
    { path: "资料/别的工作流同名节点.md", frontmatter: record("另一个流", "选书", "wf-2", "nd-2") },
    { path: "资料/同流的另一个节点.md", frontmatter: record("读书计划", "写书", "wf-1", "nd-3") },
  ];

  test("collectAffiliatedFiles：id ∪ 旧标题（去重 + 字典序）", () => {
    const index = buildReverseIndex(entries);
    const files = collectAffiliatedFiles(index, {
      workflowTitle: "读书计划",
      nodeTitle: "选书",
      workflowId: "wf-1",
      nodeId: "nd-1",
    });

    assert.deepEqual(
      files.map((file) => file.path),
      ["资料/双键.md", "资料/只有id.md", "资料/只有标题.md"],
      "只写 id / 只写标题 / 两样都写 —— 三份都要收；别的工作流的同名节点不收",
    );
  });

  test("collectAffiliatedFiles：id 命中即收（手改过标题也不会漏）", () => {
    const index = buildReverseIndex([
      { path: "a.md", frontmatter: record("读书计划", "旧节点名", "wf-1", "nd-1") },
    ]);
    const files = collectAffiliatedFiles(index, {
      workflowTitle: "读书计划",
      nodeTitle: "新节点名",
      workflowId: "wf-1",
      nodeId: "nd-1",
    });
    assert.deepEqual(files.map((file) => file.path), ["a.md"]);
  });

  test("collectWorkflowFiles：按 workflow id / 按标题；空标题不参与", () => {
    const index = buildReverseIndex(entries);

    assert.deepEqual(
      collectWorkflowFiles(index, { workflowTitle: "读书计划", workflowId: "wf-1" }).map((file) => file.path),
      ["资料/双键.md", "资料/只有标题.md", "资料/同流的另一个节点.md"],
      "workflow id 命中（双键 / 同流）+ 标题命中（只有标题）",
    );
    assert.deepEqual(
      collectWorkflowFiles(index, { workflowTitle: " 读书计划 " }).map((file) => file.path),
      ["资料/双键.md", "资料/只有标题.md", "资料/同流的另一个节点.md"],
      "标题两边 trim 后比较；只写 id 的文件没有工作流标题 → 不收",
    );
    assert.deepEqual(collectWorkflowFiles(index, { workflowTitle: "   " }), [], "空标题没有区分度");
    assert.deepEqual(collectWorkflowFiles(emptyReverseIndex(), { workflowTitle: "读书计划" }), []);
  });

  test("collectSubtreeFiles：根 + 全部后代的并集（id ∪ 标题，跨节点去重）", () => {
    const index = buildReverseIndex([
      ...entries,
      { path: "资料/孙节点.md", frontmatter: record("读书计划", "校稿", "wf-1", "nd-5") },
      { path: "资料/孙节点只有id.md", frontmatter: { "wf-node-id": "nd-5" } },
      { path: "资料/别处的校稿.md", frontmatter: record("另一个流", "校稿", "wf-2", "nd-8") },
    ]);
    const workflow: WfWorkflow = { id: "wf-1", title: "读书计划", root: leaf("nd-1", "选书") };
    const root: WfNode = {
      ...leaf("nd-1", "选书"),
      children: [{ ...leaf("nd-3", "写书"), children: [leaf("nd-5", "校稿")] }],
    };

    assert.deepEqual(
      collectSubtreeFiles(index, workflow, root)
        .map((file) => file.path)
        .sort(),
      [
        "资料/双键.md", // 根：id ∪ 标题
        "资料/只有id.md", // 根：只写 id
        "资料/只有标题.md", // 根：只写标题
        "资料/同流的另一个节点.md", // 子节点：id ∪ 标题
        "资料/孙节点.md", // 孙节点：id ∪ 标题
        "资料/孙节点只有id.md", // 孙节点：只写 id
      ].sort(),
      "整棵子树的归属文件都要收（同一份只出现一次）；别的工作流的同名节点（选书 / 校稿）不收",
    );
    assert.deepEqual(collectSubtreeFiles(emptyReverseIndex(), workflow, root), []);
  });
});

/* ------------------------------------------------------------------ *
 * Phase 36：节点级归档的同步闭环
 *
 * 归档 md 里的子树是**副本**（id 全部重新起），所以资料文件在归档看板上只能靠
 * `wf-workflow::wf-node` 兜底命中；`syncArchivedNodes()` 把 `wf-workflow` 换成
 * 「归档 md 的 workflow 标题」正是为了让这条兜底成立 ——
 * 否则卡片上的 🔗 计数会停在 0（菜单里又能找到，因为菜单用并集口径）。
 *
 * 这里按插件侧的顺序跑一遍：归档计划 → 子树收文件 → 只换 `wf-workflow` → 两侧查询。
 * ------------------------------------------------------------------ */
describe("linkAffiliation · 节点归档后两侧看板都查得到（卡片 🔗 计数）", () => {
  test("只换 wf-workflow：归档看板按标题兜底命中，原看板按 id 仍命中", () => {
    const archivedNode: WfNode = {
      ...leaf("nd-2", "写书", { status: "done" }),
      children: [leaf("nd-3", "校稿", { status: "done" })],
    };
    const workflow: WfWorkflow = {
      id: "wf-1",
      title: "读书计划",
      root: { ...leaf("nd-1", "读书计划", { status: "doing" }), children: [archivedNode] },
    };
    const document: WfJsonDocument = {
      schemaVersion: SCHEMA_VERSION,
      id: "file-1",
      updatedAt: "2026-10-12T14:30:00+08:00",
      workflows: [workflow],
    };

    const planned = planArchive(document, archivedNode.id, {}, new Date("2026-10-12T14:30:00+08:00"));
    assert.ok(planned.plan, planned.reason ?? "应当能归档");
    const archiveWorkflow = planned.plan.document.workflows[0];
    assert.equal(archiveWorkflow.title, "写书（已归档）", "归档 md 的 workflow 标题带后缀");
    assert.notEqual(archiveWorkflow.root.id, archivedNode.id, "归档副本是新 id");

    // 资料文件挂在「被归档节点」上：两个看板都该看到它
    const before = buildReverseIndex([
      { path: "资料/写书.md", frontmatter: record("读书计划", "写书", "wf-1", "nd-2") },
    ]);
    assert.deepEqual(
      collectSubtreeFiles(before, workflow, archivedNode).map((file) => file.path),
      ["资料/写书.md"],
      "同步第一步：按 id 把子树里的文件收上来",
    );

    // 同步第二步：只替换命中的 `wf-workflow` 那一项（`syncArchivedNodes` 的 workflowTitle 补丁）
    const patched = replaceAffiliationItem(
      ["读书计划"],
      ["wf-1"],
      { id: workflow.id, title: workflow.title },
      archiveWorkflow.title,
    );
    assert.deepEqual(patched, { changed: true, values: ["写书（已归档）"] }, "id 命中 → 标题换成归档标题");

    const after = buildReverseIndex([
      { path: "资料/写书.md", frontmatter: record(patched.values[0], "写书", "wf-1", "nd-2") },
    ]);

    assert.deepEqual(
      resolveLinkedFiles(after, nodeRefFor(archiveWorkflow, archiveWorkflow.root)).map((file) => file.path),
      ["资料/写书.md"],
      "归档看板：新 id 查不到 → 标题兜底命中（卡片显示 🔗 1，不是 0）",
    );
    assert.deepEqual(
      resolveLinkedFiles(after, nodeRefFor(workflow, archivedNode)).map((file) => file.path),
      ["资料/写书.md"],
      "原看板：浓缩节点 id 没变 → id 命中（`wf-workflow` 改了也不影响）",
    );
  });
});

describe("linkAffiliation · Phase 35 多归属解析（affiliationsOf）", () => {
  test("四键是等长数组 → 按下标配对成多条", () => {
    assert.deepEqual(
      affiliationsOf({
        "wf-workflow": ["流A", "流B"],
        "wf-node": ["节点1", "节点2"],
        "wf-workflow-id": ["wf-1", "wf-2"],
        "wf-node-id": ["nd-1", "nd-2"],
      }),
      [
        { workflowTitle: "流A", nodeTitle: "节点1", workflowId: "wf-1", nodeId: "nd-1" },
        { workflowTitle: "流B", nodeTitle: "节点2", workflowId: "wf-2", nodeId: "nd-2" },
      ],
    );
  });

  test("缺项的键补空串：老文件（只有标题）+ 新追加（带 id）能正确配对", () => {
    const parsed = affiliationsOf({
      "wf-workflow": ["流A", "流B"],
      "wf-node": ["节点1", "节点2"],
      "wf-node-id": ["", "nd-2"],
    });
    assert.deepEqual(parsed, [
      { workflowTitle: "流A", nodeTitle: "节点1" },
      { workflowTitle: "流B", nodeTitle: "节点2", nodeId: "nd-2" },
    ]);
  });

  test("单条老文件（全标量）→ 一条；空数组 / undefined → []", () => {
    assert.deepEqual(affiliationsOf(record("读书计划", "选书", "wf-1", "nd-1")), [
      { workflowTitle: "读书计划", nodeTitle: "选书", workflowId: "wf-1", nodeId: "nd-1" },
    ]);
    assert.deepEqual(affiliationsOf({ "wf-workflow": [], "wf-node": [] }), []);
    assert.deepEqual(affiliationsOf(undefined), []);
  });

  test("只有 id 的一档 → 用 id 兜底成标题（与旧口径一致）", () => {
    assert.deepEqual(affiliationsOf({ "wf-node-id": ["", "nd-9"] }), [
      { workflowTitle: "", nodeTitle: "nd-9", nodeId: "nd-9" },
    ]);
  });

  test("一条文件挂两条归属 → 两个节点各查得到（all 按归属计条数）", () => {
    const index = buildReverseIndex([
      {
        path: "资料/共享.md",
        frontmatter: {
          "wf-workflow": ["流A", "流B"],
          "wf-node": ["节点1", "节点2"],
          "wf-workflow-id": ["wf-1", "wf-2"],
          "wf-node-id": ["nd-1", "nd-2"],
        },
      },
    ]);
    assert.equal(index.all.length, 2);
    const paths = (nodeId: string, workflowTitle: string, nodeTitle: string): string[] =>
      resolveLinkedFiles(index, { workflowTitle, nodeTitle, nodeId }).map((file) => file.path);
    assert.deepEqual(paths("nd-1", "流A", "节点1"), ["资料/共享.md"]);
    assert.deepEqual(paths("nd-2", "流B", "节点2"), ["资料/共享.md"]);
    assert.deepEqual(
      collectAffiliatedFiles(index, { workflowTitle: "流B", nodeTitle: "节点2", nodeId: "nd-2" }).map(
        (file) => file.path,
      ),
      ["资料/共享.md"],
      "同一份文件只出现一次（按 path 去重）",
    );
  });
});

describe("linkAffiliation · Phase 35 追加归属（appendAffiliation）", () => {
  test("空文件 → 写下一条完整四键", () => {
    const appended = appendAffiliation(undefined, tuple("读书计划", "选书", "wf-1", "nd-1"));
    assert.equal(appended.changed, true);
    assert.deepEqual(appended.values, {
      workflowTitle: ["读书计划"],
      nodeTitle: ["选书"],
      workflowId: ["wf-1"],
      nodeId: ["nd-1"],
    });
  });

  test("追加第二条：已有归属原样留在第 0 位", () => {
    const appended = appendAffiliation(
      record("读书计划", "选书", "wf-1", "nd-1"),
      tuple("写书计划", "写书", "wf-9", "nd-9"),
    );
    assert.equal(appended.changed, true);
    assert.deepEqual(appended.values, {
      workflowTitle: ["读书计划", "写书计划"],
      nodeTitle: ["选书", "写书"],
      workflowId: ["wf-1", "wf-9"],
      nodeId: ["nd-1", "nd-9"],
    });
  });

  test("老文件只写标题（没有 id 列）→ 先补空串占位，新 id 不会配错节点", () => {
    const appended = appendAffiliation(
      { "wf-workflow": "读书计划", "wf-node": "选书" },
      tuple("写书计划", "写书", "wf-9", "nd-9"),
    );
    assert.deepEqual(appended.values, {
      workflowTitle: ["读书计划", "写书计划"],
      nodeTitle: ["选书", "写书"],
      workflowId: ["", "wf-9"],
      nodeId: ["", "nd-9"],
    });
  });

  test("幂等：同 nodeId 再追加 → changed=false（改名后标题不同也不重复写）", () => {
    const appended = appendAffiliation(
      {
        "wf-workflow": ["读书计划", "写书计划"],
        "wf-node": ["选书", "写书"],
        "wf-node-id": ["nd-1", "nd-9"],
      },
      tuple("读书计划", "选书（改名后）", "wf-1", "nd-1"),
    );
    assert.equal(appended.changed, false);
    assert.deepEqual(appended.values.nodeTitle, ["选书", "写书"]);
  });

  test("没有 nodeId 时按 nodeTitle 判重", () => {
    const appended = appendAffiliation(
      { "wf-workflow": "读书计划", "wf-node": "选书" },
      { workflowTitle: "读书计划", nodeTitle: "选书" },
    );
    assert.equal(appended.changed, false);
  });

  test("nodeTitle 为空 → 不写（changed=false）", () => {
    assert.equal(appendAffiliation(undefined, { workflowTitle: "流", nodeTitle: "  " }).changed, false);
  });

  test("末尾「四项全空」的占位档先被去掉再追加", () => {
    const appended = appendAffiliation(
      {
        "wf-workflow": ["读书计划", ""],
        "wf-node": ["选书", ""],
        "wf-workflow-id": ["wf-1", ""],
        "wf-node-id": ["nd-1", ""],
      },
      tuple("写书计划", "写书", "wf-9", "nd-9"),
    );
    assert.deepEqual(appended.values.nodeTitle, ["选书", "写书"]);
    assert.deepEqual(appended.values.nodeId, ["nd-1", "nd-9"]);
  });
});

describe("linkAffiliation · Phase 35 只改命中的那一项（replaceAffiliationItem）", () => {
  test("id 权威：同名但 id 不同的项不动", () => {
    const result = replaceAffiliationItem(
      ["选书", "选书"],
      ["nd-1", "nd-2"],
      { id: "nd-1", title: "选书" },
      "选书（新）",
    );
    assert.equal(result.changed, true);
    assert.deepEqual(result.values, ["选书（新）", "选书"]);
  });

  test("id 一个都没命中 → 退回按旧标题匹配，命中项全部替换（老文件只写标题）", () => {
    const result = replaceAffiliationItem(["选书", "选书"], [], { id: "nd-1", title: "选书" }, "挑书");
    assert.deepEqual(result.values, ["挑书", "挑书"]);
  });

  test("id 列与标题列按下标对齐：只改 id 命中的那一项", () => {
    const result = replaceAffiliationItem(
      ["选书", "写书"],
      ["", "nd-2"],
      { id: "nd-2", title: "选书" },
      "写书（新）",
    );
    assert.deepEqual(result.values, ["选书", "写书（新）"], "第 0 位没有 id → 碰不到它");
  });

  test("没有命中 / 值本来就相同 → changed=false（不产生无意义写盘）", () => {
    assert.equal(replaceAffiliationItem(["选书"], ["nd-1"], { id: "nd-9", title: "别的" }, "新").changed, false);
    assert.equal(replaceAffiliationItem(["选书"], ["nd-1"], { id: "nd-1" }, "选书").changed, false);
    assert.equal(replaceAffiliationItem([], [], {}, "新").changed, false);
  });
});

/* ------------------------------------------------------------------ *
 * Phase 35 端到端：把 md 文本走一遍「读当前文本 → 改 → 写回 → 再解析」
 *
 * main.ts 的 `attachLinkDoc` / `applyAffiliationPatch` 就是这两段胶水
 * （先 `parseFrontmatter().getArray()` 取四列，再 `setFrontmatterFieldList` 写回）。
 * 这里按同样顺序跑，锁住「多归属真的能落盘并读回」这件事。
 * ------------------------------------------------------------------ */

const LINK_FIELDS = [
  FRONTMATTER_FIELDS.linkWorkflow,
  FRONTMATTER_FIELDS.linkNode,
  FRONTMATTER_FIELDS.linkWorkflowId,
  FRONTMATTER_FIELDS.linkNodeId,
] as const;

/** md 文本 → frontmatter 记录（四列都取按位置对齐的字符串数组） */
function recordOf(markdown: string): Record<string, unknown> {
  const info = parseFrontmatter(markdown);
  const out: Record<string, unknown> = {};
  for (const key of LINK_FIELDS) out[key] = info.getArray(key);
  return out;
}

/** 四键并行数组 → md 文本（= main.ts 的 `writeAffiliationFields`） */
function writeFields(markdown: string, values: AffiliationFieldValues): string {
  let next = markdown;
  next = setFrontmatterFieldList(next, FRONTMATTER_FIELDS.linkWorkflow, values.workflowTitle);
  next = setFrontmatterFieldList(next, FRONTMATTER_FIELDS.linkNode, values.nodeTitle);
  next = setFrontmatterFieldList(next, FRONTMATTER_FIELDS.linkWorkflowId, values.workflowId);
  next = setFrontmatterFieldList(next, FRONTMATTER_FIELDS.linkNodeId, values.nodeId);
  return next;
}

describe("linkAffiliation · Phase 35 端到端（追加 → 落盘 → 再解析 → 改名）", () => {
  /** 老文件：单归属写成标量 */
  const before =
    "---\nwf-workflow: 读书计划\nwf-node: 选书\nwf-workflow-id: wf-1\nwf-node-id: nd-1\n---\n# 选书笔记\n";

  /** 追加第二条之后的文本（两条归属） */
  function afterAttach(): string {
    const appended = appendAffiliation(recordOf(before), tuple("写书计划", "写书", "wf-9", "nd-9"));
    assert.equal(appended.changed, true);
    return writeFields(before, appended.values);
  }

  test("追加第二条：四键都变内联数组，正文与其余行一字不动", () => {
    assert.equal(
      afterAttach(),
      "---\n" +
        'wf-workflow: ["读书计划", "写书计划"]\n' +
        'wf-node: ["选书", "写书"]\n' +
        "wf-workflow-id: [wf-1, wf-9]\n" +
        "wf-node-id: [nd-1, nd-9]\n" +
        "---\n# 选书笔记\n",
    );
  });

  test("落盘后读回：两条归属按下标配对，顺序不变", () => {
    assert.deepEqual(affiliationsOf(recordOf(afterAttach())), [
      { workflowTitle: "读书计划", nodeTitle: "选书", workflowId: "wf-1", nodeId: "nd-1" },
      { workflowTitle: "写书计划", nodeTitle: "写书", workflowId: "wf-9", nodeId: "nd-9" },
    ]);
  });

  test("改名同步只改命中的那一列：第 0 条原样，第 1 条换掉，再跑一次不写盘", () => {
    const after = afterAttach();
    const info = parseFrontmatter(after);
    const replaced = replaceAffiliationItem(
      info.getArray(FRONTMATTER_FIELDS.linkNode) ?? [],
      info.getArray(FRONTMATTER_FIELDS.linkNodeId) ?? [],
      { id: "nd-9", title: "写书" },
      "写书（改名后）",
    );
    assert.equal(replaced.changed, true);

    const renamed = setFrontmatterFieldList(after, FRONTMATTER_FIELDS.linkNode, replaced.values);
    assert.equal(renamed, after.replace('wf-node: ["选书", "写书"]', 'wf-node: ["选书", "写书（改名后）"]'));
    assert.deepEqual(
      affiliationsOf(recordOf(renamed)).map((affiliation) => affiliation.nodeTitle),
      ["选书", "写书（改名后）"],
    );

    const again = parseFrontmatter(renamed);
    const second = replaceAffiliationItem(
      again.getArray(FRONTMATTER_FIELDS.linkNode) ?? [],
      again.getArray(FRONTMATTER_FIELDS.linkNodeId) ?? [],
      { id: "nd-9", title: "写书（改名后）" },
      "写书（改名后）",
    );
    assert.equal(second.changed, false, "值已经是新标题 → 不产生写盘");
  });
});