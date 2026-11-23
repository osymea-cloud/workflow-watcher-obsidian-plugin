/**
 * Phase 26 / 27：导入引擎单测（`inspectImport` + `planWorkflowImport`）。
 *
 * 契约：`doc/datacontact/phase26_bound.md` §4 / §9①；Phase 27 口径见 `phase27_bound.md` §5.2：
 *  - 体检只看 JSON（正文 / 纪要段 / 链接不参与）；
 *  - 合并只追加 workflow（JSON 内），`noteAnchor` 随导入剥离；导入完全不碰 md。
 *
 * 只测纯函数：不读盘、不写盘、不碰 Obsidian。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { analyzeDocument } from "./analyze.ts";
import { inspectImport, planWorkflowImport } from "./importExport.ts";
import { leaf } from "./testFixtures.ts";
import { stringifyWfJson } from "./wfjsonWrite.ts";
import type { WfJsonDocument } from "./types.ts";

const NOW = new Date("2026-11-02T10:00:00+08:00");

/* ------------------------------------------------------------------ *
 * 夹具
 * ------------------------------------------------------------------ */

/** 目标（当前看板）：1 条工作流 / 2 个节点 */
function targetDocument(): WfJsonDocument {
  const root = leaf("nd-uuid-001", "目标根", { children: [leaf("nd-uuid-002", "目标子")] });
  return {
    schemaVersion: "1.9",
    id: "file-uuid-001",
    updatedAt: "2026-11-01T09:00:00+08:00",
    workflows: [{ id: "wf-uuid-001", title: "目标流", root }],
  };
}

/**
 * 导入源：2 条工作流 / 4 个节点
 *  - `wf-uuid-201` → 根 `nd-uuid-201`（带 3 条 links）、子 `nd-uuid-211`、子 `nd-uuid-212`；
 *  - `wf-uuid-202` → 根 `nd-uuid-202`。
 */
function incomingDocument(): WfJsonDocument {
  const root = leaf("nd-uuid-201", "导入根", {
    children: [leaf("nd-uuid-211", "导入子一"), leaf("nd-uuid-212", "导入子二")],
    links: [
      { id: "lk-1", type: "web", target: "https://example.com", role: "source", label: "官方文档" },
      { id: "lk-2", type: "md", target: "竞品分析报告", role: "detail", label: "竞品分析报告" },
      { id: "lk-3", type: "image", target: "截图.png", role: "detail", label: "截图" },
    ],
  });
  return {
    schemaVersion: "1.9",
    id: "file-uuid-201",
    workflows: [
      { id: "wf-uuid-201", title: "导入流一", root },
      { id: "wf-uuid-202", title: "导入流二", root: leaf("nd-uuid-202", "导入第二条") },
    ],
  };
}

function jsonOf(document: WfJsonDocument): string {
  return stringifyWfJson(document);
}

/* ------------------------------------------------------------------ *
 * inspectImport
 * ------------------------------------------------------------------ */

describe("importExport · inspectImport（导入前体检）", () => {
  test("① 正常源：数量口径齐全、ok=true", () => {
    const inspection = inspectImport({ jsonText: jsonOf(incomingDocument()) });

    assert.equal(inspection.ok, true, `体检应通过：${inspection.errors.join(" / ")}`);
    assert.equal(inspection.workflowCount, 2);
    assert.equal(inspection.nodeCount, 4);
    assert.equal(inspection.schemaVersion, "1.9");
    assert.equal(inspection.document?.workflows.length, 2);
    assert.deepEqual(inspection.errors, []);
  });

  test("② 坏 JSON：ok=false、errors 非空、不给文档", () => {
    const inspection = inspectImport({ jsonText: "{ 这不是 JSON }" });

    assert.equal(inspection.ok, false);
    assert.ok(inspection.errors.length > 0, "应有 error 级问题");
    assert.equal(inspection.document, undefined);
    assert.equal(inspection.workflowCount, 0);
    assert.equal(inspection.nodeCount, 0);
  });

  test("③ 体检是纯 JSON 的：同一份源重复体检，数量 / 提示完全一致", () => {
    const first = inspectImport({ jsonText: jsonOf(incomingDocument()) });
    const again = inspectImport({ jsonText: jsonOf(incomingDocument()) });

    assert.equal(first.ok, true);
    assert.equal(again.ok, true);
    assert.equal(again.workflowCount, first.workflowCount);
    assert.equal(again.nodeCount, first.nodeCount);
    assert.deepEqual(again.warnings, first.warnings, "同一份 JSON 不该产生不同提示");
  });

  test("④ Schema 错（缺 workflows）：ok=false、不给文档", () => {
    const inspection = inspectImport({
      jsonText: JSON.stringify({ schemaVersion: "1.9", id: "file-uuid-901" }),
    });

    assert.equal(inspection.ok, false);
    assert.ok(inspection.errors.length > 0);
    assert.equal(inspection.document, undefined);
  });

  test("⑤ 展示用路径原样带出（只进报告，不参与判断）", () => {
    const inspection = inspectImport({
      jsonText: jsonOf(incomingDocument()),
      jsonPath: "/tmp/源.wf.json",
    });

    assert.equal(inspection.jsonPath, "/tmp/源.wf.json");
    assert.equal(inspection.ok, true);
  });
});

/* ------------------------------------------------------------------ *
 * planWorkflowImport
 * ------------------------------------------------------------------ */

/** 导入后必须仍然全部合法（不变量 I5）；正文固定空串（侧车形态，不参与分析） */
function analyzePlan(document: WfJsonDocument): ReturnType<typeof analyzeDocument> {
  return analyzeDocument({ noteMarkdown: "", jsonText: jsonOf(document), jsonSource: "sidecar" });
}

/** 标准合并：目标 + 导入源 */
function planOf(target: WfJsonDocument = targetDocument()) {
  return planWorkflowImport({ target, incoming: incomingDocument(), now: NOW });
}

describe("importExport · planWorkflowImport（合并计划）", () => {
  test("① 追加：新 workflow 排在末尾、入口不被修改", () => {
    const target = targetDocument();
    const before = target.workflows.length;
    const plan = planOf(target);

    assert.equal(plan.changed, true);
    assert.deepEqual(plan.addedWorkflowIds, ["wf-uuid-201", "wf-uuid-202"]);
    assert.equal(plan.document.workflows.length, before + 2);
    assert.equal(target.workflows.length, before, "target.workflows 必须原样不动");
    assert.equal(plan.document.updatedAt, "2026-11-02T10:00:00+08:00", "updatedAt 用注入的时间基准");
    assert.deepEqual(plan.skippedWorkflows, []);
  });

  test("② 重复 workflow id：整条跳过，不覆盖（口径 1）", () => {
    const target = targetDocument();
    const incoming: WfJsonDocument = {
      ...incomingDocument(),
      workflows: [{ id: "wf-uuid-001", title: "撞车的流", root: leaf("nd-uuid-301", "外来根") }],
    };

    const plan = planWorkflowImport({ target, incoming, now: NOW });

    assert.equal(plan.changed, false);
    assert.deepEqual(plan.addedWorkflowIds, []);
    assert.deepEqual(plan.skippedWorkflows, [
      { id: "wf-uuid-001", title: "撞车的流", reason: "duplicate-workflow" },
    ]);
    assert.deepEqual(plan.document, target, "没变就原样返回（workflows / updatedAt 都不动）");
  });

  test("③ 重复节点 id：整条跳过（reason = duplicate-node）", () => {
    const target = targetDocument();
    const incoming: WfJsonDocument = {
      ...incomingDocument(),
      workflows: [
        {
          id: "wf-uuid-401",
          title: "节点撞车",
          root: leaf("nd-uuid-402", "外来根", { children: [leaf("nd-uuid-002", "和目标重名")] }),
        },
      ],
    };

    const plan = planWorkflowImport({ target, incoming, now: NOW });

    assert.equal(plan.changed, false);
    assert.deepEqual(plan.skippedWorkflows, [
      { id: "wf-uuid-401", title: "节点撞车", reason: "duplicate-node" },
    ]);
    assert.deepEqual(plan.addedWorkflowIds, []);
  });

  test("④ 源内部自己重复：第二条也被跳过", () => {
    const incoming = incomingDocument();
    const duplicated: WfJsonDocument = {
      ...incoming,
      workflows: [incoming.workflows[0], { ...incoming.workflows[0], title: "同一份再导一次" }],
    };

    const plan = planWorkflowImport({
      target: targetDocument(),
      incoming: duplicated,
      now: NOW,
    });

    assert.deepEqual(plan.addedWorkflowIds, ["wf-uuid-201"]);
    assert.equal(plan.skippedWorkflows.length, 1);
    assert.equal(plan.skippedWorkflows[0]?.reason, "duplicate-workflow");
    assert.equal(plan.document.workflows.length, 2);
  });

  test("⑤ 只追加 workflow：新工作流保留完整子树与 links", () => {
    const plan = planOf();

    const added = plan.document.workflows.slice(1);
    assert.deepEqual(
      added.map((workflow) => workflow.id),
      ["wf-uuid-201", "wf-uuid-202"],
    );
    const root = added[0]?.root;
    assert.equal(root?.title, "导入根");
    assert.deepEqual(
      root?.children?.map((node) => node.title),
      ["导入子一", "导入子二"],
    );
    assert.equal(root?.links?.length, 3, "links 原地留在 JSON（不迁进正文）");
  });

  test("⑥ 幂等：同一份结果再并一次 → changed=false、文档不变", () => {
    const first = planOf();
    const second = planWorkflowImport({
      target: first.document,
      incoming: incomingDocument(),
      now: NOW,
    });

    assert.equal(second.changed, false, "全部 id 已存在 → 不写盘");
    assert.deepEqual(second.document, first.document, "文档原样不动");
    assert.equal(second.skippedWorkflows.length, 2);
  });

  test("⑦ 导入剥离 noteAnchor：写错的锚点也不会进目标 JSON", () => {
    const incoming: WfJsonDocument = {
      schemaVersion: "1.9",
      id: "file-uuid-501",
      workflows: [
        {
          id: "wf-uuid-501",
          title: "锚点写错的流",
          root: leaf("nd-uuid-501", "写错的根", { noteAnchor: "^nd-uuid-999" }),
        },
      ],
    };

    const target = targetDocument();
    const plan = planWorkflowImport({ target, incoming, now: NOW });

    const imported = plan.document.workflows[1]?.root;
    assert.equal(imported?.id, "nd-uuid-501");
    assert.equal(imported?.noteAnchor, undefined, "Phase 27：noteAnchor 不再生成 / 不再搬运");
  });

  test("⑧ 深拷贝：改计划里的节点不会污染导入源", () => {
    const incoming = incomingDocument();
    const plan = planWorkflowImport({
      target: targetDocument(),
      incoming,
      now: NOW,
    });

    const cloned = plan.document.workflows[1]?.root;
    assert.notEqual(cloned, incoming.workflows[0].root, "必须是新对象");
    if (cloned !== undefined) cloned.title = "改掉";
    assert.equal(incoming.workflows[0].root.title, "导入根", "源对象不被修改");
    assert.equal(cloned?.children?.[0]?.title, "导入子一", "子树也深拷贝了");
  });

  test("⑨ 落盘闸门：合并结果仍然无 error，链接留在 JSON 的 links[]（I5）", () => {
    const plan = planOf();
    const after = analyzePlan(plan.document);

    assert.equal(after.hasError, false, `导入结果不该有 error：${after.issues.map((item) => item.code).join(",")}`);
    assert.equal(after.document?.workflows.length, 3);
    // Phase 27：超链接原地留在 JSON 的 links[]（不再迁进正文纪要段）
    assert.equal(after.document?.workflows[1]?.root.links?.length, 3, "导入的 links 原样保留");
  });
});
