/**
 * 工作流编辑（workflowEdits.ts）单测：新增 / 删除 / 编辑 三个原语 + 整批编排（Modal 保存链路）。
 *
 * 覆盖四件事：
 *  1. `addWorkflow` 的默认值（自带新 root / 追加到末尾 / 标题清洗与提示）；
 *  2. `removeWorkflow` 的摊平与三道护栏（最后一个 / 正在计时 / 含 `archive`）；
 *  3. `editWorkflow` 的逐字段语义（patch 覆盖 / clear 删除 / 其余不动 / 无变化 → unchanged）；
 *  4. `applyWorkflowEdits` 的「先整批预检、再动手」，以及与 `applyMutation` 的写回配合。
 *
 * `now` 用本地构造的 `Date`（`new Date(2026, 9, 11, 10, 30)`），期望值由 `formatLocalIso` 同一套规则
 * 算出，因此断言与运行机器的时区无关。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { applyMutation } from "./mutate.ts";
import {
  CHILD_ID,
  DOING_ID,
  ROOT_ID,
  WF1_ID,
  WF2_ID,
  WF2_ROOT_ID,
  clone,
  validDocument,
  validDocument13,
  validMarkdown11,
} from "./testFixtures.ts";
import { formatLocalIso } from "./time.ts";
import { findNode, findWorkflow } from "./tree.ts";
import { addWorkflow, applyWorkflowEdits, editWorkflow, removeWorkflow } from "./workflowEdits.ts";

const NOW = new Date(2026, 9, 11, 10, 30); // 本地 2026-10-11 10:30
const AT = formatLocalIso(NOW);

describe("addWorkflow · 新增工作流", () => {
  test("追加到末尾、自带新 root（doing / startAt=now / 默认标题=工作流标题）", () => {
    const document = clone(validDocument());
    const result = addWorkflow(document, { title: "  新工作流  " }, NOW);

    assert.equal(result.ok, true);
    assert.equal(result.structureChanged, true);
    assert.deepEqual(result.warnings, []);
    assert.ok(result.workflowId);
    assert.ok(result.rootId);
    assert.deepEqual(result.changedNodeIds, [result.rootId]);

    assert.equal(document.workflows.length, 3);
    const added = document.workflows[2];
    assert.equal(added.id, result.workflowId);
    assert.equal(added.title, "新工作流");
    assert.equal(added.state, undefined, "新建的工作流处于进行中（不写 state）");
    assert.equal(added.root.id, result.rootId);
    assert.equal(added.root.title, "新工作流", "rootTitle 缺省 = 工作流标题");
    assert.equal(added.root.status, "doing");
    assert.equal(added.root.startAt, AT);
    assert.equal(added.root.updatedAt, AT);
    assert.equal(added.root.noteAnchor, `^${result.rootId}`);
    assert.deepEqual(added.root.children, []);
  });

  test("可选字段透传（有值才写）+ 标签清洗 + 标题含 # 给提示", () => {
    const document = clone(validDocument());
    const result = addWorkflow(
      document,
      {
        title: "任务 #7",
        rootTitle: "  起点  ",
        progress: 3,
        summary: "  概要  ",
        type: "执行",
        importance: 4,
        urgency: 2,
        owner: " 张三 ",
        dueAt: "2026-10-31",
        tags: [" A ", "A", "", "B"],
      },
      NOW,
    );

    assert.equal(result.ok, true);
    const warnings = result.warnings ?? [];
    assert.equal(warnings.length, 1, "标题里的 # 只提示、不拦");
    assert.ok(warnings[0].includes("#"));

    const added = document.workflows[2];
    assert.equal(added.title, "任务 #7");
    assert.equal(added.progress, 3);
    assert.equal(added.root.title, "任务 #7", "v1.6：rootTitle 不生效，根节点标题 = workflow.title");
    assert.equal(added.root.summary, "概要");
    assert.equal(added.root.type, "执行");
    assert.equal(added.root.importance, 4);
    assert.equal(added.root.urgency, 2);
    assert.equal(added.root.owner, "张三");
    assert.equal(added.root.dueAt, "2026-10-31");
    assert.deepEqual(added.root.tags, ["A", "B"], "去空白 / 丢空项 / 去重保序");
  });

  test("标题为空 / 含换行 → ok=false，文档一动不动", () => {
    const document = clone(validDocument());
    const before = JSON.stringify(document);

    const empty = addWorkflow(document, { title: "   " }, NOW);
    const multiline = addWorkflow(document, { title: "第一行\n第二行" }, NOW);

    assert.equal(empty.ok, false);
    assert.match(empty.reason ?? "", /^工作流标题不能为空/);
    assert.equal(multiline.ok, false);
    assert.match(multiline.reason ?? "", /换行符/);
    assert.equal(JSON.stringify(document), before);
  });
});

describe("removeWorkflow · 删除工作流（连根带全部后代）", () => {
  test("摘掉整个 workflow，上报全部节点 id 与纪要锚点", () => {
    const document = clone(validDocument());
    const result = removeWorkflow(document, WF1_ID);

    assert.equal(result.ok, true);
    assert.equal(result.structureChanged, true);
    assert.deepEqual(result.changedNodeIds, [ROOT_ID, CHILD_ID, DOING_ID], "先序：根在前、子节点按文档顺序");
    assert.deepEqual(result.removedNoteAnchors, ["^nd-uuid-001", "^nd-uuid-002", "^nd-uuid-003"]);
    assert.deepEqual(document.workflows.map((workflow) => workflow.id), [WF2_ID]);
  });

  test("护栏：最后一个 workflow 不能删", () => {
    const document = clone(validDocument());
    document.workflows.splice(1, 1);

    const result = removeWorkflow(document, WF1_ID);

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /至少要保留一个工作流/);
    assert.equal(document.workflows.length, 1);
  });

  test("护栏：有正在计时的条目 → 拒绝（先结束计时）", () => {
    const document = clone(validDocument13());
    document.workflows[0].root.timeEntries = [
      ...(document.workflows[0].root.timeEntries ?? []),
      { startAt: "2026-10-12T08:00:00+08:00", date: "2026-10-12" },
    ];

    const result = removeWorkflow(document, WF1_ID);

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /正在计时/);
    assert.equal(document.workflows.length, 2, "拒绝时一个字都不写");
  });

  test("护栏：含带 archive 的浓缩节点 → 拒绝（与 removeNode 同一口径）", () => {
    const document = clone(validDocument13());

    const result = removeWorkflow(document, WF2_ID);

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /归档来源/);
    assert.equal(findNode(document, WF2_ROOT_ID) !== undefined, true);
  });

  test("id 不存在 → ok=false（不抛错）", () => {
    const result = removeWorkflow(clone(validDocument()), "wf-missing");

    assert.equal(result.ok, false);
    assert.deepEqual(result.changedNodeIds, []);
    assert.equal(result.structureChanged, false);
  });
});

describe("editWorkflow · 编辑工作流字段", () => {
  test("patch 覆盖 + clear 删键 + 刷 root.updatedAt（trim / 标签清洗）", () => {
    const document = clone(validDocument());
    const result = editWorkflow(
      document,
      WF1_ID,
      {
        title: "  立项调查（改） ",
        rootTitle: "  调研竞品（改） ",
        progress: 5,
        summary: " 新概要 ",
        importance: 4,
        urgency: 1,
        tags: ["x", " x ", "y"],
      },
      ["type", "owner", "dueAt"],
      NOW,
    );

    const workflow = findWorkflow(document, WF1_ID);
    assert.ok(workflow);
    assert.equal(result.ok, true);
    assert.equal(result.structureChanged, false, "只改字段不动结构");
    assert.deepEqual(result.changedNodeIds, [ROOT_ID]);
    assert.equal(workflow.title, "立项调查（改）");
    assert.equal(workflow.progress, 5);
    assert.equal(workflow.root.title, "立项调查（改）", "v1.6：改 workflow.title 强制覆盖根节点标题");
    assert.equal(workflow.root.summary, "新概要");
    assert.equal(workflow.root.importance, 4);
    assert.equal(workflow.root.urgency, 1);
    assert.deepEqual(workflow.root.tags, ["x", "y"]);
    assert.equal("type" in workflow.root, false);
    assert.equal("owner" in workflow.root, false);
    assert.equal("dueAt" in workflow.root, false);
    assert.equal(workflow.root.updatedAt, AT);
  });

  test("无实际改动 → unchanged=true（不刷 updatedAt）", () => {
    const document = clone(validDocument());
    const workflow = findWorkflow(document, WF1_ID);
    assert.ok(workflow);
    const updatedAt = workflow.root.updatedAt;

    const result = editWorkflow(document, WF1_ID, { summary: "对比三家竞品的功能与定价" }, [], NOW);

    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
    assert.deepEqual(result.changedNodeIds, []);
    assert.equal(workflow.root.updatedAt, updatedAt);
  });

  test("必填字段不能 clear、非法值 / 不存在的 id → ok=false，文档一动不动", () => {
    const document = clone(validDocument());
    const before = JSON.stringify(document);

    assert.match(editWorkflow(document, WF1_ID, {}, ["title"], NOW).reason ?? "", /工作流标题不能清空/);
    assert.match(editWorkflow(document, WF1_ID, {}, ["rootTitle"], NOW).reason ?? "", /根节点标题不能清空/);
    assert.match(editWorkflow(document, WF1_ID, { title: "   " }, [], NOW).reason ?? "", /工作流标题不能为空/);
    assert.match(editWorkflow(document, WF1_ID, { progress: 1000 }, [], NOW).reason ?? "", /工作流已完成必须在 0-999 之间/);
    assert.match(editWorkflow(document, WF1_ID, { importance: 0 }, [], NOW).reason ?? "", /根节点重要度必须在 1-4 之间/);
    assert.match(editWorkflow(document, WF1_ID, { dueAt: "2026-02-30" }, [], NOW).reason ?? "", /ISO8601/);
    assert.match(editWorkflow(document, WF1_ID, { progress: 1.5 }, [], NOW).reason ?? "", /工作流已完成必须是整数/);
    assert.match(editWorkflow(document, "wf-missing", { title: "x" }, [], NOW).reason ?? "", /不存在/);

    assert.equal(JSON.stringify(document), before);
  });
});

describe("applyWorkflowEdits · 整批编排（Modal 保存链路）", () => {
  test("先删 → 再改 → 最后加：三份 id 各自归位", () => {
    const document = clone(validDocument());

    const result = applyWorkflowEdits(
      document,
      {
        removals: [WF2_ID],
        edits: [{ id: WF1_ID, patch: { owner: "李四" } }],
        additions: [{ title: "新建的流" }],
      },
      NOW,
    );

    assert.equal(result.ok, true);
    assert.equal(result.structureChanged, true);
    assert.deepEqual(result.removedWorkflowIds, [WF2_ID]);
    assert.deepEqual(result.editedWorkflowIds, [WF1_ID]);
    assert.equal(result.addedWorkflowIds.length, 1);
    assert.deepEqual(result.removedNoteAnchors, ["^nd-uuid-004"]);
    assert.deepEqual(
      document.workflows.map((workflow) => workflow.title),
      ["立项调查", "新建的流"],
      "删除生效、新增追加在末尾",
    );
    assert.equal(findNode(document, ROOT_ID)?.owner, "李四");
  });

  test("只有编辑 → structureChanged=false（视图只局部刷新）", () => {
    const result = applyWorkflowEdits(
      clone(validDocument()),
      { edits: [{ id: WF1_ID, patch: { owner: "李四" } }] },
      NOW,
    );

    assert.equal(result.ok, true);
    assert.equal(result.structureChanged, false);
    assert.deepEqual(result.changedNodeIds, [ROOT_ID]);
  });

  test("一条都没改 → unchanged=true（上层跳过写回）", () => {
    const result = applyWorkflowEdits(
      clone(validDocument()),
      { edits: [{ id: WF1_ID, patch: { summary: "对比三家竞品的功能与定价" } }] },
      NOW,
    );

    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
    assert.deepEqual(result.changedNodeIds, []);
    assert.deepEqual(result.editedWorkflowIds, []);
    assert.equal(result.structureChanged, false);
  });

  test("预检：同一 workflow 既删又改 / id 不存在 / 删光 / 标题空 / 非法值 → 整笔拒绝", () => {
    const document = clone(validDocument());
    const before = JSON.stringify(document);

    assert.match(
      applyWorkflowEdits(document, { removals: [WF2_ID], edits: [{ id: WF2_ID, patch: { owner: "x" } }] }, NOW).reason ?? "",
      /不能同时删除与编辑/,
    );
    assert.match(applyWorkflowEdits(document, { edits: [{ id: "wf-missing" }] }, NOW).reason ?? "", /不存在/);
    assert.match(
      applyWorkflowEdits(document, { removals: [WF1_ID, WF2_ID] }, NOW).reason ?? "",
      /至少要保留一个工作流/,
    );
    assert.match(
      applyWorkflowEdits(document, { additions: [{ title: "   " }] }, NOW).reason ?? "",
      /^新增工作流：工作流标题不能为空/,
    );
    assert.match(
      applyWorkflowEdits(document, { edits: [{ id: WF1_ID, patch: { progress: 1000 } }] }, NOW).reason ?? "",
      /工作流已完成必须在 0-999 之间/,
    );

    assert.equal(JSON.stringify(document), before, "预检不过 → 文档一动不动");
  });

  test("写回链路：删掉一个 workflow → 代码块与正文段落一起清掉、零 error", () => {
    const result = applyMutation(
      validMarkdown11(),
      (document) => {
        const plan = applyWorkflowEdits(document, { removals: [WF2_ID] }, NOW);
        if (!plan.ok) return { reject: plan.reason };
        return { changedNodeIds: plan.changedNodeIds, removedNoteAnchors: plan.removedNoteAnchors };
      },
      { now: NOW },
    );

    assert.equal(result.success, true);
    assert.equal(result.changed, true);
    assert.equal(result.analysis.hasError, false);
    assert.deepEqual(result.removedAnchors, ["^nd-uuid-004"]);
    assert.equal(result.markdown.includes("nd-uuid-004"), false, "代码块里的节点与正文锚点一起消失");
    assert.ok(result.markdown.includes("## 调研竞品 ^nd-uuid-001"), "别的工作流原样保留");
  });

  test("写回链路：新增 workflow → 正文补上根节点纪要段落（新锚点）", () => {
    const holder: { rootId?: string } = {};
    const result = applyMutation(
      validMarkdown11(),
      (document) => {
        const add = addWorkflow(document, { title: "新工作流", rootTitle: "起点" }, NOW);
        if (!add.ok) return { reject: add.reason };
        holder.rootId = add.rootId;
        return { changedNodeIds: add.changedNodeIds };
      },
      { now: NOW },
    );

    assert.equal(result.success, true);
    assert.equal(result.changed, true);
    assert.equal(result.analysis.hasError, false);
    assert.ok(holder.rootId !== undefined);
    assert.deepEqual(result.addedAnchors, [`^${holder.rootId}`]);
    assert.ok(result.markdown.includes(`### 新工作流 ^${holder.rootId}`), "根节点标题行带 block 锚点（v1.6 起 = workflow.title）");
    assert.ok(result.markdown.includes("新工作流"), "新工作流进了 wfjson 代码块");
  });
});

describe("workflow.state（v0.7 §⑨-8：进行中 / 完成 / 取消）", () => {
  test("patch.state = archived / cancelled；clear=state 回到进行中（删键）", () => {
    const document = clone(validDocument());

    assert.equal(editWorkflow(document, WF1_ID, { state: "archived" }, [], NOW).ok, true);
    assert.equal(findWorkflow(document, WF1_ID)?.state, "archived");

    assert.equal(editWorkflow(document, WF1_ID, { state: "cancelled" }, [], NOW).ok, true);
    assert.equal(findWorkflow(document, WF1_ID)?.state, "cancelled");

    assert.equal(editWorkflow(document, WF1_ID, {}, ["state"], NOW).ok, true);
    assert.equal(findWorkflow(document, WF1_ID)?.state, undefined, "进行中 = 省略该键");
  });

  test("状态没变 → unchanged（不刷 root.updatedAt）", () => {
    const document = clone(validDocument());
    const workflow = findWorkflow(document, WF1_ID);
    assert.ok(workflow);
    workflow.state = "archived";
    const before = workflow.root.updatedAt;

    const result = editWorkflow(document, WF1_ID, { state: "archived" }, [], NOW);
    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
    assert.equal(findWorkflow(document, WF1_ID)?.root.updatedAt, before);
  });

  test("新增时可以直接建成 archived；非法状态值被拒（写明合法取值）", () => {
    const document = clone(validDocument());
    const added = addWorkflow(document, { title: "已完成的流", state: "archived" }, NOW);
    assert.equal(added.ok, true);
    assert.equal(findWorkflow(document, added.workflowId ?? "")?.state, "archived");

    const rejected = editWorkflow(clone(validDocument()), WF1_ID, { state: "doing" as never }, [], NOW);
    assert.equal(rejected.ok, false);
    assert.match(rejected.reason ?? "", /archived \/ cancelled/);
  });

  test("整批编排：改 state 也是一次写回（视图据 editedWorkflowIds / layout 搬家）", () => {
    const document = clone(validDocument());
    const result = applyWorkflowEdits(
      document,
      { edits: [{ id: WF1_ID, patch: { state: "archived" } }] },
      NOW,
    );

    assert.equal(result.ok, true);
    assert.equal(result.structureChanged, false);
    assert.deepEqual(result.editedWorkflowIds, [WF1_ID]);
    assert.equal(findWorkflow(document, WF1_ID)?.state, "archived");
  });
});
