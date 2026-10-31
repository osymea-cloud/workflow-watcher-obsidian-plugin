/**
 * 工厂函数的单测：插件新建出来的数据必须天然通过 Schema（避免「一建就报错」）。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  applyStatusChange,
  createDocument,
  createLink,
  createNode,
  createRelation,
  createWorkflow,
} from "./factory.ts";
import { ID_PATTERN, anchorForNode } from "./ids.ts";
import { coerceDocument, validateWfJsonValue } from "./analyze.ts";
import { SCHEMA_VERSION } from "./types.ts";

const NOW = new Date("2026-10-11T10:30:00+08:00");
const AT = "2026-10-11T10:30:00+08:00";

describe("factory · createNode", () => {
  test("缺省值：id/锚点/状态/进度/子节点/时间", () => {
    const node = createNode("写方案", NOW);
    assert.ok(ID_PATTERN.test(node.id));
    assert.ok(node.id.startsWith("nd-"));
    assert.equal(node.noteAnchor, anchorForNode(node.id));
    assert.equal(node.title, "写方案");
    assert.equal(node.status, "todo");
    // v1.6：progress / progress_max 与 status 解耦，缺省 0 / 1
    assert.equal(node.progress, 0);
    assert.equal(node.progress_max, 1);
    assert.equal(node.collapsed, false);
    assert.deepEqual(node.children, []);
    assert.equal(node.updatedAt, AT);
    // todo 不需要 statusHistory 与 completedAt
    assert.equal(node.statusHistory, undefined);
    assert.equal(node.completedAt, undefined);
  });

  test("doing：progress 保持缺省 0（不再按状态对齐），并补一条初始 statusHistory", () => {
    const node = createNode({ title: "调研", status: "doing" }, NOW);
    assert.equal(node.progress, 0);
    assert.equal(node.progress_max, 1);
    assert.deepEqual(node.statusHistory, [{ from: "todo", to: "doing", at: AT }]);
    assert.equal(node.completedAt, undefined);
  });

  test("done：补 completedAt，但 progress 不再自动变成 5", () => {
    const node = createNode({ title: "收尾", status: "done" }, NOW);
    assert.equal(node.progress, 0);
    assert.equal(node.completedAt, AT);
    assert.equal(node.statusHistory?.[0].to, "done");
  });

  test("可选字段只在显式提供时出现；数组做拷贝", () => {
    const tags = ["竞品"];
    const node = createNode({ title: "t", id: "nd-uuid-900", tags, importance: 4, estimate: 3 }, NOW);
    assert.equal(node.id, "nd-uuid-900");
    assert.equal(node.noteAnchor, "^nd-uuid-900");
    assert.equal(node.importance, 4);
    assert.equal(node.estimate, 3);
    assert.deepEqual(node.tags, tags);
    assert.notEqual(node.tags, tags);
    assert.equal("summary" in node, false);
    assert.equal("owner" in node, false);
    assert.equal("dueAt" in node, false);
  });

  test("noteAnchor 可显式覆盖（导入既有数据时）", () => {
    const node = createNode({ title: "t", id: "nd-uuid-901", noteAnchor: "^nd-uuid-902" }, NOW);
    assert.equal(node.noteAnchor, "^nd-uuid-902");
  });
});

describe("factory · createWorkflow / createDocument", () => {
  test("createWorkflow：自带一个 doing 的根节点，默认与工作流同名", () => {
    const workflow = createWorkflow("立项调查", NOW);
    assert.ok(workflow.id.startsWith("wf-"));
    assert.equal(workflow.title, "立项调查");
    assert.equal(workflow.root.title, "立项调查");
    assert.equal(workflow.root.status, "doing");
    assert.equal(workflow.progress, 0);
    assert.equal(workflow.progress_max, 1);

    const custom = createWorkflow({ title: "方案", rootTitle: "方案总纲", progress: 2 }, NOW);
    // v1.6：workflow.title 是唯一事实来源，rootTitle 不再生效
    assert.equal(custom.root.title, "方案");
    assert.equal(custom.progress, 2);
    assert.equal("state" in custom, false);
    assert.equal("originId" in custom, false);
  });

  test("createWorkflow：state / originId 只在传入时写入（缺省不写键）", () => {
    const archived = createWorkflow({ title: "实现方案（已归档）", state: "archived", originId: "nd-uuid-001" }, NOW);
    assert.equal(archived.state, "archived");
    assert.equal(archived.originId, "nd-uuid-001");

    const cancelled = createWorkflow({ title: "放弃的方案", state: "cancelled" }, NOW);
    assert.equal(cancelled.state, "cancelled");
    assert.equal("originId" in cancelled, false);

    // 归档 workflow 也能整体通过 Schema（state / originId 都为可选字段）
    assert.deepEqual(validateWfJsonValue(createDocument([archived, cancelled], NOW)), []);
  });

  test("createDocument：schemaVersion 固定为当前版本，且整体通过 Schema 校验", () => {
    const document = createDocument([createWorkflow("立项调查", NOW), createWorkflow("实现方案", NOW)], NOW);
    assert.ok(document.id.startsWith("file-"));
    assert.equal(document.schemaVersion, SCHEMA_VERSION);
    assert.equal(document.updatedAt, AT);
    assert.deepEqual(validateWfJsonValue(document), []);
    assert.equal(coerceDocument(document)?.workflows.length, 2);
  });

  test("createDocument 也接受直接传工作流数组", () => {
    const document = createDocument([createWorkflow("A", NOW)], NOW);
    assert.equal(document.workflows.length, 1);
    assert.deepEqual(validateWfJsonValue(document), []);
  });
});

describe("factory · createLink / createRelation", () => {
  test("createLink：只带必填字段，可选字段缺省不出现", () => {
    const link = createLink({ type: "web", target: "https://example.com" });
    assert.ok(link.id.startsWith("lk-"));
    assert.equal(link.type, "web");
    assert.equal("role" in link, false);
    assert.equal("label" in link, false);
  });

  test("createRelation：note 为空串时不写入", () => {
    assert.deepEqual(createRelation("nd-uuid-001", "dependsOn"), { target: "nd-uuid-001", kind: "dependsOn" });
    assert.deepEqual(createRelation("nd-uuid-001", "related", "同属立项"), {
      target: "nd-uuid-001",
      kind: "related",
      note: "同属立项",
    });
  });
});

describe("factory · applyStatusChange", () => {
  test("doing → done：补 completedAt / statusHistory / updatedAt，progress 不动", () => {
    const node = createNode({ title: "t", status: "doing" }, NOW);
    applyStatusChange(node, "done", { at: "2026-10-12T09:00:00+08:00", by: "李四", note: "收工" });
    assert.equal(node.status, "done");
    assert.equal(node.progress, 0);
    assert.equal(node.completedAt, "2026-10-12T09:00:00+08:00");
    assert.equal(node.updatedAt, "2026-10-12T09:00:00+08:00");
    const last = node.statusHistory?.at(-1);
    assert.deepEqual(last, { from: "doing", to: "done", at: "2026-10-12T09:00:00+08:00", by: "李四", note: "收工" });
    assert.equal(node.statusHistory?.at(-1)?.to, node.status);
  });

  test("done → doing 回退：清除 completedAt，progress 保持手动值", () => {
    const node = createNode({ title: "t", status: "done" }, NOW);
    node.progress = 7;
    applyStatusChange(node, "doing", { at: "2026-10-13T09:00:00+08:00" });
    assert.equal(node.status, "doing");
    assert.equal(node.progress, 7);
    assert.equal(node.completedAt, undefined);
    assert.equal(node.statusHistory?.at(-1)?.to, "doing");
  });

  test("同状态调用是 no-op（且不再接受 progress 选项）", () => {
    const node = createNode({ title: "t" }, NOW);
    applyStatusChange(node, "doing", { at: AT });
    const history = node.statusHistory?.length;
    assert.equal(node.progress, 0);
    applyStatusChange(node, "doing", { at: AT });
    assert.equal(node.statusHistory?.length, history);
  });
});
