/**
 * 归档（archive.ts）单测：资格判断 / 归档文件 生成 / 子树浓缩 / 幂等重试辅助。
 *
 * 覆盖五层：
 *  1. 资格（根 / 叶子 / 子树未全 done → 拒绝，理由文案同时给右键菜单用；Phase 36 起
 *     「已归档 + 新子树」允许再次归档，见 §Phase 36）；
 *  2. `planArchive`：只读、归档文件 文本自洽（新 id + originId + 无 state + 数据全保留 + 空壳段落 +
 *     `relations` 重定向）；
 *  3. `archiveNode`：保留 / 删除字段清单、`timeEntries` 累加、`completedAt` 取最晚、拒绝时文档一动不动；
 *  4. 与写回链路配合（`applyMutation`）：产物能再次通过 `analyzeMarkdown`（零 error）、重复归档被拒；
 *  5. 幂等重试辅助（`isArchivePathForNode` / `readArchivedWorkflowIdentity`）。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  ARCHIVE_FOLDER,
  ARCHIVE_TITLE_SUFFIX,
  applyWorkflowArchiveNotes,
  archiveEligibility,
  archiveFileBase,
  archiveFilePathFor,
  archiveNode,
  archiveWorkflow,
  buildWorkflowArchive,
  checkArchiveEligibility,
  collectDescendants,
  editWorkflowArchiveInfo,
  extractArchiveReference,
  formatArchivedAt,
  isArchivePathForNode,
  parseArchiveTagYaml,
  setWorkflowArchiveNotes,
  stringifyArchiveTagYaml,
  planArchive,
  planArchiveAppend,
  planWorkflowArchive,
  readArchiveFileMeta,
  readArchivedWorkflowIdentity,
  renderArchiveNoteLine,
  workflowArchiveEligibility,
  type ArchiveFormInput,
  type ArchivePlan,
  type WorkflowArchivePlan,
} from "./archive.ts";
import { analyzeDocument, analyzeMarkdown } from "./analyze.ts";
import { applyMutation } from "./mutate.ts";
import { CHILD_ID, DOING_ID, ROOT_ID, clone, validDocument13 } from "./testFixtures.ts";
import { formatLocalIso } from "./time.ts";
import { shortIdOf } from "./ids.ts";
import { findNode } from "./tree.ts";
import { SCHEMA_VERSION, type WfArchive, type WfJsonDocument, type WfNode, type WfWorkflow } from "./types.ts";
import { stringifyWfJson, writeBackDocument } from "./wfjsonWrite.ts";

/** 归档产物 = 纯 JSON（Phase 28）；这里把它当「落盘后的 .wf.json 内容」再解析一次 */
function analyzeArchive(plan: { file: string; document: WfJsonDocument }) {
  return analyzeDocument({
    noteMarkdown: "",
    jsonText: stringifyWfJson(plan.document),
    jsonSource: "sidecar",
    file: plan.file,
    checkFrontmatter: false,
  });
}

const NOW = new Date("2026-10-12T14:30:00+08:00");

/** 「深挖三条结论」：v1.1 / v1.3 样例没占用这个节点号 */
const NEST_ID = "nd-uuid-005";

/** 取节点（不存在直接让测试失败） */
function nodeOf(document: WfJsonDocument, id: string): WfNode {
  const node = findNode(document, id);
  assert.ok(node, `节点 ${id} 应当存在`);
  return node;
}

/** 子树里的全部节点（先序，含自身） */
function branch(node: WfNode): WfNode[] {
  return [node, ...(node.children ?? []).flatMap(branch)];
}

/**
 * 在 `validDocument13` 之上造一棵**可归档**子树：
 *   调研竞品（done，根 → 不可归档）
 *     ├─ 整理结论 ^nd-uuid-002（done，**可归档**：自身 2h + 子节点 1.5h，带一整套待删字段）
 *     │    └─ 深挖三条结论 ^nd-uuid-005（done，1.5h，completedAt 比父节点更晚）
 *     └─ 交叉验证 ^nd-uuid-003（done）
 */
function archivableDocument(): WfJsonDocument {
  const document = clone(validDocument13());
  const mid = document.workflows[0].root.children[0];
  mid.importance = 3;
  mid.tags = ["竞品"];
  mid.summary = "把三条结论合成一条";
  mid.type = "decide";
  mid.urgency = 2;
  mid.collapsed = false;
  mid.progress = 5;
  mid.owner = "张三";
  mid.estimate = "3h";
  mid.aliases = ["结论汇总"];
  mid.aiContext = "供 AI 理解的上下文";
  // 一条指向子树内部（归档后重定向到新 id）、一条指向子树外部（归档后写成跨文件引用）
  mid.relations = [
    { target: NEST_ID, kind: "dependsOn" },
    { target: ROOT_ID, kind: "related", note: "与根节点相关" },
  ];
  mid.links = [{ id: "lk-mid", type: "md", target: "竞品分析报告", role: "detail", label: "竞品分析报告" }];
  mid.timeEntries = [
    { startAt: "2026-10-05T10:30:00+08:00", date: "2026-10-05", endAt: "2026-10-05T12:30:00+08:00", hours: 2 },
  ];
  mid.children = [
    {
      id: NEST_ID,
      title: "深挖三条结论",
      status: "done",
      progress: 5,
      startAt: "2026-10-06T09:00:00+08:00",
      updatedAt: "2026-10-06T12:30:00+08:00",
      completedAt: "2026-10-06T12:30:00+08:00",
      noteAnchor: `^${NEST_ID}`,
      children: [],
      statusHistory: [
        { from: "todo", to: "doing", at: "2026-10-06T09:00:00+08:00" },
        { from: "doing", to: "done", at: "2026-10-06T12:30:00+08:00" },
      ],
      timeEntries: [
        { startAt: "2026-10-06T09:00:00+08:00", date: "2026-10-06", endAt: "2026-10-06T10:30:00+08:00", hours: 1.5 },
      ],
    },
  ];
  return document;
}

/** plan 一次（不通过就直接让测试挂） */
function planOf(document: WfJsonDocument, nodeId = CHILD_ID, form: ArchiveFormInput = {}): ArchivePlan {
  const result = planArchive(document, nodeId, form, NOW);
  assert.ok(result.plan, result.reason ?? "应当能归档");
  return result.plan;
}

/** 一份合法的节点侧 `archive` 字段（`archiveNode` 的入参；来源是 `planArchive`） */
function archiveField(extra: Partial<WfArchive> = {}): WfArchive {
  return { workflowId: "wf-stub", ...extra };
}


describe("archive · 归档资格", () => {
  test("根节点 / 叶子 / 子树未全 done → 拒绝；已归档 + 新子树 → 允许（Phase 36）", () => {
    const document = archivableDocument();
    const root = document.workflows[0].root;
    const mid = root.children[0];

    assert.deepEqual(archiveEligibility(root, true), { ok: false, reason: "根节点不能归档" });
    assert.deepEqual(archiveEligibility(root.children[1], false), { ok: false, reason: "叶子节点没有子树" });
    assert.deepEqual(archiveEligibility(mid, false), { ok: true });

    // Phase 36：已归档 + 还有新子树 = 可以再归档（追加）；已归档 + 没子树 = 拒绝
    const archived = clone(mid);
    archived.archive = archiveField();
    assert.deepEqual(archiveEligibility(archived, false), { ok: true });

    const archivedLeaf = clone(archived);
    archivedLeaf.children = [];
    assert.deepEqual(archiveEligibility(archivedLeaf, false), {
      ok: false,
      reason: "已归档，没有新子树可追加",
    });

    const unfinished = clone(mid);
    unfinished.children[0].status = "todo";
    assert.deepEqual(archiveEligibility(unfinished, false), {
      ok: false,
      reason: "子树里「深挖三条结论」还没做完",
    });
  });

  test("checkArchiveEligibility：按 id 查（不存在 / 根 / 中节点）", () => {
    const document = archivableDocument();

    assert.match(checkArchiveEligibility(document, "nd-nope").reason ?? "", /不存在/);

    const root = checkArchiveEligibility(document, ROOT_ID);
    assert.equal(root.isRoot, true);
    assert.equal(root.ok, false);
    assert.equal(root.reason, "根节点不能归档");

    const mid = checkArchiveEligibility(document, CHILD_ID);
    assert.equal(mid.ok, true);
    assert.equal(mid.isRoot, false);
    assert.equal(mid.node, nodeOf(document, CHILD_ID));
  });

  test("collectDescendants：先序、不含自身", () => {
    const document = archivableDocument();
    assert.deepEqual(
      collectDescendants(nodeOf(document, ROOT_ID)).map((node) => node.id),
      [CHILD_ID, NEST_ID, DOING_ID],
    );
    assert.deepEqual(collectDescendants(nodeOf(document, NEST_ID)), []);
  });
});

describe("archive · formatArchivedAt / archiveFilePathFor", () => {
  test("归档时间精确到分钟、补零", () => {
    assert.equal(formatArchivedAt(new Date(2026, 0, 5, 9, 7)), "2026-01-05 09:07");
    assert.equal(formatArchivedAt(NOW), formatArchivedAt(new Date(NOW.getTime())));
    assert.match(formatArchivedAt(NOW), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  test("归档文件名：<工作流名>-<节点名>-<时间戳>-<uid16>.wf.json", () => {
    const date = new Date(2026, 0, 5, 9, 7, 8);
    const base = archiveFileBase("工作流", "节点", CHILD_ID, date);
    assert.match(base, /^工作流-节点-20260105-090708-[0-9a-z]{16}\.wf\.json$/);
    assert.equal(archiveFilePathFor("工作流", "节点", CHILD_ID, date), `${ARCHIVE_FOLDER}/${base}`);
    assert.equal(archiveFileBase("工作/流", "节 点", CHILD_ID, date).startsWith("工作-流-节-点-"), true);
  });
});

describe("archive · planArchive（归档计划，只读）", () => {
  test("路径 / archive 字段 / 表单选填 / 锚点清单", () => {
    const document = archivableDocument();
    const plan = planOf(document, CHILD_ID, { summary: " 三条结论已收敛 ", idea: "先验证再实现", review: "   " });

    assert.equal(plan.nodeId, CHILD_ID);
    assert.equal(plan.nodeTitle, "整理结论");
    assert.equal(plan.workflowId, plan.archive.workflowId, "workflowId 必须与 archive 字段一致");
    assert.deepEqual(plan.archive, { workflowId: plan.workflowId }, "节点侧 archive 只剩 workflowId");
    assert.ok(plan.file.startsWith(`${ARCHIVE_FOLDER}/`), "归档路径在归档目录下");

    // Phase 39：说明文字 / 时间 / 来源都在归档文件自己的 workflow.archive 上
    const workflowArchive = plan.document.workflows[0].archive;
    assert.ok(workflowArchive, "归档文件的 workflow 必须带 archive 元数据");
    assert.equal(workflowArchive.archivedAt, formatArchivedAt(NOW));
    assert.equal(workflowArchive.from_workflow, "立项调查");
    assert.equal(workflowArchive.from_node, "整理结论");
    assert.equal(workflowArchive.summary, "三条结论已收敛");
    assert.equal(workflowArchive.idea, "先验证再实现");
    assert.equal(workflowArchive.review, undefined, "只有空白的选填项必须省略");

    assert.equal(plan.nodeCount, 2);
    assert.deepEqual(plan.removedNoteAnchors, [`^${NEST_ID}`]);
    assert.equal(plan.document.archivedAt, formatLocalIso(NOW), "归档快照自带 archivedAt（归档看板窗口用它）");
  });

  test("不改动传入的文档", () => {
    const document = archivableDocument();
    const before = JSON.stringify(document);
    planArchive(document, CHILD_ID, { summary: "x" }, NOW);
    assert.equal(JSON.stringify(document), before);
  });

  test("归档 JSON 自洽：新 id / originId / 无 state / 数据全保留 / 无正文 / relations 重定向", () => {
    const document = archivableDocument();
    const plan = planOf(document, CHILD_ID, { summary: "三条结论已收敛" });
    const analysis = analyzeArchive(plan);

    assert.equal(analysis.found, true);
    assert.equal(analysis.counts.error, 0);
    assert.equal(analysis.counts.warning, 0, `归档文件 不该有 warning：${JSON.stringify(analysis.issues)}`);
    const archived = analysis.document;
    assert.ok(archived, "归档文件 必须能解析出 wfjson 文档");
    assert.notEqual(archived.id, document.id, "文件级 id 重新生成");
    assert.equal(archived.workflows.length, 1);

    const workflow = archived.workflows[0];
    assert.equal(workflow.id, plan.workflowId);
    assert.equal(workflow.title, `整理结论${ARCHIVE_TITLE_SUFFIX}`);
    assert.equal(workflow.originId, CHILD_ID);
    assert.equal(workflow.state, undefined, "归档文件 自己不带 state（缺省即进行中）");

    // 节点 id 全部重新生成，且两两不重复
    const nodes = branch(workflow.root);
    assert.equal(nodes.length, plan.nodeCount);
    const ids = nodes.map((node) => node.id);
    assert.equal(new Set(ids).size, ids.length);
    for (const id of ids) {
      assert.match(id, /^nd-/);
      assert.notEqual(id, CHILD_ID);
      assert.notEqual(id, NEST_ID);
    }

    // 数据全保留（归档文件 里浓缩节点仍是完整节点）
    const archivedRoot = workflow.root;
    assert.equal(archivedRoot.title, "整理结论");
    assert.equal(archivedRoot.status, "done");
    assert.equal(archivedRoot.importance, 3);
    assert.deepEqual(archivedRoot.tags, ["竞品"]);
    assert.equal(archivedRoot.summary, "把三条结论合成一条");
    assert.equal(archivedRoot.type, "decide");
    assert.equal(archivedRoot.urgency, 2);
    assert.equal(archivedRoot.progress, 5);
    assert.equal(archivedRoot.owner, "张三");
    assert.equal(archivedRoot.estimate, "3h");
    assert.deepEqual(archivedRoot.aliases, ["结论汇总"]);
    assert.equal(archivedRoot.aiContext, "供 AI 理解的上下文");
    // Phase 27：纪要段范式弃用 → 归档文件 不再生成纪要段，`links[]` 也不再迁移（原样留在 JSON 里）
    assert.deepEqual(archivedRoot.links?.map((link) => link.target), ["竞品分析报告"]);
    assert.equal(
      (archivedRoot as { noteAnchor?: string }).noteAnchor,
      undefined,
      "Phase 27：归档副本不再带 noteAnchor",
    );
    assert.equal(archivedRoot.statusHistory?.length, 2);
    assert.equal(archivedRoot.timeEntries?.length, 1);
    assert.equal(archivedRoot.completedAt, "2026-10-06T12:00:00+08:00");
    assert.equal(archivedRoot.archive, undefined, "归档文件 里不再带 archive");

    assert.equal(archivedRoot.children.length, 1);
    const archivedChild = archivedRoot.children[0];
    assert.equal(archivedChild.title, "深挖三条结论");
    assert.equal(archivedChild.status, "done");
    assert.equal(archivedChild.timeEntries?.length, 1);

    // relations 重定向：子树内部 → 新 id；子树外部 → 跨文件引用（否则归档文件 里「目标找不到」）
    assert.deepEqual(archivedRoot.relations?.map((relation) => relation.target), [
      archivedChild.id,
      `${document.id}#${ROOT_ID}`,
    ]);

    // Phase 28：归档产物是**纯 JSON** —— 没有 md、没有纪要段（正文内容一个字节都不复制）
    const jsonText = stringifyWfJson(plan.document);
    assert.equal(/^#{1,6} /m.test(jsonText), false, "归档 JSON 里没有 `### 标题 ^id` 纪要段");
    assert.equal(jsonText.includes("（纪要待补充）"), false);
    assert.equal(jsonText.includes(`^${NEST_ID}`), false);
  });
});

describe("archive · Phase 28 归档只产 JSON", () => {
  test("传了 sourceMarkdown 也不再复制纪要段：产物只有 JSON 文档", () => {
    const document = archivableDocument();
    const mid = nodeOf(document, CHILD_ID);
    const nest = nodeOf(document, NEST_ID);

    const base = writeBackDocument("", document, { now: NOW }).markdown;
    // 手写一份「旧数据」：正文里带成对 wf-note 纪要段（Phase 27 之后写回不再生成）
    const section = (id: string, text: string): string =>
      `\n<!-- wf-note:begin:${id} -->\n${text}\n<!-- wf-note:end:${id} -->\n`;
    const source =
      base +
      section(mid.id, "复盘：三条结论已合并\n- [竞品报告](https://example.com/report)") +
      section(nest.id, "深挖过程记录（含 [[访谈录音]]）");

    const planned = planArchive(document, mid.id, {}, NOW, source);
    assert.equal(planned.ok, true);
    const plan = planned.plan;
    assert.ok(plan, "应当产出归档计划");
    assert.equal("markdown" in plan, false, "ArchivePlan 不再有 markdown 字段");
    assert.equal(analyzeArchive(plan).counts.error, 0, "纯 JSON 归档仍要零 error");

    const jsonText = stringifyWfJson(plan.document);
    assert.equal(jsonText.includes("复盘：三条结论已合并"), false, "不再复制正文");
    assert.equal(jsonText.includes("https://example.com/report"), false, "超链接也不再复制");
    assert.equal(jsonText.includes("深挖过程记录（含 [[访谈录音]]）"), false);
    assert.equal(jsonText.includes(`^${mid.id}`), false);
    assert.equal(jsonText.includes(`^${nest.id}`), false);
  });
});

describe("archive · archiveNode（内存浓缩）", () => {
  test("保留字段 + 清空 children + timeEntries 累加 + completedAt 取最晚", () => {
    const document = archivableDocument();
    const archive = archiveField();
    const result = archiveNode(document, CHILD_ID, archive, NOW);

    assert.equal(result.ok, true);
    assert.deepEqual(result.changedNodeIds, [CHILD_ID]);
    assert.deepEqual(result.removedNoteAnchors, [`^${NEST_ID}`]);
    assert.equal(result.removedNodeCount, 1);

    const mid = nodeOf(document, CHILD_ID);
    assert.deepEqual(mid.children, [], "子树整体消失");
    assert.equal(mid.archive, archive, "archive 字段原样挂上");
    assert.equal(mid.title, "整理结论");
    assert.equal(mid.status, "done");
    assert.equal(mid.importance, 3, "importance 保留");
    assert.deepEqual(mid.tags, ["竞品"], "tags 保留");
    assert.equal(mid.noteAnchor, `^${CHILD_ID}`, "保留自己的锚点（导读仍指向它）");
    assert.equal(mid.startAt, "2026-10-05T10:00:00+08:00");
    assert.equal(mid.updatedAt, formatLocalIso(NOW), "updatedAt = 归档时刻");
    assert.equal(mid.completedAt, "2026-10-06T12:30:00+08:00", "completedAt 取自身与后代里最晚的");

    // 待删字段清单（契约 §5）
    for (const field of [
      "summary",
      "type",
      "urgency",
      "collapsed",
      "progress",
      "owner",
      "estimate",
      "aliases",
      "aiContext",
      "relations",
      "links",
      "statusHistory",
    ] as const) {
      assert.equal(mid[field], undefined, `${field} 应当被删掉`);
    }

    // 计时：自身 2h + 后代 1.5h（先序：自身在前）
    assert.equal(mid.timeEntries?.length, 2);
    assert.deepEqual(
      mid.timeEntries?.map((entry) => entry.hours),
      [2, 1.5],
    );

    // 其他节点不受影响：根节点仍挂着「浓缩节点」与另一条兄弟
    assert.deepEqual(
      nodeOf(document, ROOT_ID).children.map((child) => child.id),
      [CHILD_ID, DOING_ID],
    );
    assert.equal(findNode(document, NEST_ID), undefined, "被删后代在文档里也查不到了");
  });

  test("什么都没有的子树：timeEntries 键不新增", () => {
    const document = archivableDocument();
    const mid = document.workflows[0].root.children[0];
    mid.timeEntries = undefined;
    mid.children[0].timeEntries = undefined;

    assert.equal(archiveNode(document, CHILD_ID, archiveField(), NOW).ok, true);
    const condensed = nodeOf(document, CHILD_ID);
    assert.equal(condensed.timeEntries, undefined);
    assert.equal(condensed.completedAt, "2026-10-06T12:30:00+08:00", "completedAt 仍取最晚");
  });

  test("Phase 20：浓缩节点保留 note / noteVisible（note 是用户手写内容，不在待删清单里）", () => {
    const document = archivableDocument();
    const mid = document.workflows[0].root.children[0];
    const note = [{ text: "先截 3 家的定价页" }, { text: "再补对比表", done: false }];
    mid.note = note;
    mid.noteVisible = true;

    assert.equal(archiveNode(document, CHILD_ID, archiveField(), NOW).ok, true);

    const condensed = nodeOf(document, CHILD_ID);
    assert.deepEqual(condensed.note, note, "note 条目必须跟着浓缩节点留下");
    assert.equal(condensed.noteVisible, true, "开关也要留住，否则重新打开就看不到 note 了");
  });

  test("Phase 34：浓缩节点保留 linkDir（不在待删清单里 → 重新加子节点仍继承目录）", () => {
    const document = archivableDocument();
    const mid = document.workflows[0].root.children[0];
    mid.linkDir = "资料/读书计划";

    assert.equal(archiveNode(document, CHILD_ID, archiveField(), NOW).ok, true);

    const condensed = nodeOf(document, CHILD_ID);
    assert.equal(condensed.linkDir, "资料/读书计划");
  });

  test("拒绝路径：文档一动不动", () => {
    const document = archivableDocument();
    const archive = archiveField();
    const before = JSON.stringify(document);

    for (const [nodeId, reason] of [
      [ROOT_ID, "根节点不能归档"],
      [NEST_ID, "叶子节点没有子树"],
      ["nd-nope", "节点 nd-nope 不存在（可能已被删除）"],
    ] as const) {
      const rejected = archiveNode(document, nodeId, archive, NOW);
      assert.equal(rejected.ok, false, `${nodeId} 应当被拒`);
      assert.equal(rejected.reason, reason);
      assert.deepEqual(rejected.changedNodeIds, []);
      assert.deepEqual(rejected.removedNoteAnchors, []);
      assert.equal(rejected.removedNodeCount, 0);
    }

    // 子树里还有没做完的
    const unfinished = clone(document);
    unfinished.workflows[0].root.children[0].children[0].status = "todo";
    assert.equal(archiveNode(unfinished, CHILD_ID, archive, NOW).reason, "子树里「深挖三条结论」还没做完");

    // 已经归档过的节点：Phase 36 起「有旧归档 + 还有新子树（全 done）」是**可以**再归档的
    // （追加到旧归档文件）；只有「已归档且没有子树」才拒，且给的是更贴切的那条原因。
    const archivedLeaf = clone(document);
    archivedLeaf.workflows[0].root.children[0].archive = archive;
    archivedLeaf.workflows[0].root.children[0].children = [];
    assert.equal(
      archiveNode(archivedLeaf, CHILD_ID, archive, NOW).reason,
      "已归档，没有新子树可追加",
    );

    assert.equal(JSON.stringify(document), before, "所有拒绝路径都不该改动文档");
  });

  test("Phase 36：已归档节点又长出新的全 done 子树 → 允许再次归档", () => {
    const document = archivableDocument();
    const mid = document.workflows[0].root.children[0];
    mid.archive = archiveField({ workflowId: "wf-archive-old" });

    assert.deepEqual(archiveEligibility(mid, false), { ok: true });

    // 浓缩（archive 由调用方沿用旧 workflowId）
    assert.equal(archiveNode(document, CHILD_ID, { ...mid.archive }, NOW).ok, true);
    assert.equal(nodeOf(document, CHILD_ID).archive?.workflowId, "wf-archive-old");
  });
});

describe("archive · 与写回链路配合", () => {
  test("plan → archiveNode → applyMutation：原文浓缩、正文删掉后代段落、零 error", () => {
    const document = archivableDocument();
    const source = writeBackDocument("", document, { now: NOW }).markdown;
    const plan = planOf(document, CHILD_ID, { summary: "三条结论已收敛" });

    // 归档 JSON（已落盘的那份）本身就是一份合法文件
    assert.equal(analyzeArchive(plan).counts.error, 0);

    const mutation = applyMutation(
      source,
      (target) => {
        const edit = archiveNode(target, CHILD_ID, plan.archive, NOW);
        if (!edit.ok) return { reject: edit.reason ?? "归档失败" };
        return { changedNodeIds: edit.changedNodeIds, removedNoteAnchors: edit.removedNoteAnchors };
      },
      { now: NOW },
    );

    assert.equal(mutation.success, true, mutation.reason ?? "写回应当成功");
    assert.equal(mutation.changed, true);
    assert.deepEqual(mutation.changedNodeIds, [CHILD_ID]);

    const after = analyzeMarkdown(mutation.markdown);
    assert.equal(after.counts.error, 0, JSON.stringify(after.issues));
    const written = after.document;
    assert.ok(written, "写回产物仍要能被解析");
    const mid = nodeOf(written, CHILD_ID);
    assert.deepEqual(mid.archive, { workflowId: plan.workflowId }, "Phase 39：节点侧 archive 只剩 workflowId");
    assert.equal(mid.children.length, 0);

    // Phase 27：正文不再有纪要段 —— 写回不新增也不保留任何 block 锚点
    assert.equal(mutation.markdown.includes(`^${CHILD_ID}`), false);
    assert.equal(mutation.markdown.includes(`^${NEST_ID}`), false);

    // 幂等：再归档一次被拒（重复点击 / 重试不会破坏文件）
    const second = applyMutation(
      mutation.markdown,
      (target) => {
        const edit = archiveNode(target, CHILD_ID, plan.archive, NOW);
        if (!edit.ok) return { reject: edit.reason ?? "归档失败" };
        return { changedNodeIds: edit.changedNodeIds };
      },
      { now: NOW },
    );
    assert.equal(second.success, false);
    assert.match(second.reason ?? "", /已归档/);
    assert.equal(second.markdown, mutation.markdown, "拒绝时文件内容原样返回");
  });
});

describe("archive · 归档地址行（v0.7 §⑨-2，Phase 27 起只用于读旧数据）", () => {
  test("renderArchiveNoteLine：有 summary 用全角冒号带上，空 summary 直接省略", () => {
    assert.equal(
      renderArchiveNoteLine("archive/wf-x-nd-y.md", " 三条结论已收敛 "),
      "归档：[[archive/wf-x-nd-y.md]] summary：三条结论已收敛",
    );
    assert.equal(renderArchiveNoteLine("archive/wf-x-nd-y.md"), "归档：[[archive/wf-x-nd-y.md]]");
    assert.equal(renderArchiveNoteLine("archive/wf-x-nd-y.md", "   "), "归档：[[archive/wf-x-nd-y.md]]");
  });

  test("extractArchiveReference：只认「归档：」行，兼容别名 / 锚点 / 半角冒号", () => {
    assert.equal(extractArchiveReference("归档：[[archive/a.md]] summary：x"), "archive/a.md");
    assert.equal(extractArchiveReference("随便一行\n  归档: [[archive/b.md|别名]]"), "archive/b.md");
    assert.equal(extractArchiveReference("归档：[[archive/c.md#^nd-1]]"), "archive/c.md");
    assert.equal(extractArchiveReference("- [链接](https://example.com)"), undefined);
    assert.equal(extractArchiveReference(""), undefined);
  });
});
/* ------------------------------------------------------------------ *
 * Phase 22：整条工作流归档（根节点 → 归档文件 + 文件级 `workflow_archive` 台账）
 * ------------------------------------------------------------------ */

/** 取整条流归档的计划（不通过就直接让测试挂） */
function workflowPlanOf(document: WfJsonDocument, workflowId: string, form: ArchiveFormInput = {}): WorkflowArchivePlan {
  const result = planWorkflowArchive(document, workflowId, form, NOW);
  assert.ok(result.plan, result.reason ?? "整条工作流应当能归档");
  return result.plan;
}

describe("archive · Phase 22 整条工作流归档", () => {
  test("资格：整棵树全 done 才通过；单节点流也通过；已归档且有新子树 → 允许再次归档", () => {
    const document = clone(validDocument13());
    const workflow = document.workflows[0];
    assert.deepEqual(workflowArchiveEligibility(workflow), { ok: true });

    const unfinished = clone(workflow);
    unfinished.root.children[1].status = "doing";
    assert.deepEqual(workflowArchiveEligibility(unfinished), {
      ok: false,
      reason: "子树里「交叉验证」还没做完",
    });

    // Phase 36：已归档 + 子树已清空（没有新东西）→ 拒绝；已归档但还有新子树 → 允许追加
    const archivedEmpty = clone(workflow);
    archivedEmpty.root.archive = archiveField();
    archivedEmpty.root.children = [];
    assert.deepEqual(workflowArchiveEligibility(archivedEmpty), {
      ok: false,
      reason: "已归档，没有新子树可追加",
    });

    const archivedWithNew = clone(workflow);
    archivedWithNew.root.archive = archiveField();
    assert.deepEqual(workflowArchiveEligibility(archivedWithNew), { ok: true });

    // Phase 22 放宽：叶子 / 单节点工作流也能归档（整条流就这一个节点）
    const single: WfWorkflow = {
      id: "wf-uuid-901",
      title: "单节点流",
      root: {
        id: "nd-uuid-901",
        title: "唯一节点",
        status: "done",
        progress: 0,
        startAt: "2026-10-01T09:00:00+08:00",
        completedAt: "2026-10-01T10:00:00+08:00",
        noteAnchor: "^nd-uuid-901",
        children: [],
      },
    };
    assert.deepEqual(workflowArchiveEligibility(single), { ok: true });
  });

  test("planWorkflowArchive：归档 JSON 不写 originId、标题取工作流标题、id 全重映射", () => {
    const document = clone(validDocument13());
    const workflow = document.workflows[0];
    const plan = workflowPlanOf(document, workflow.id, { summary: "整条流收口" });

    assert.equal(plan.sourceWorkflowId, workflow.id);
    assert.equal(plan.workflowTitle, "立项调查");
    assert.equal(plan.rootNodeId, ROOT_ID);
    assert.equal(plan.noteAnchor, `^${ROOT_ID}`);
    assert.equal(plan.nodeCount, 3, "根 + 2 个子节点");
    assert.ok(plan.file.startsWith(`${ARCHIVE_FOLDER}/`), "归档路径在归档目录下");
    assert.equal(plan.file.endsWith(`-${shortIdOf(ROOT_ID)}.wf.json`), true, "文件名以 16 位短 uid 结尾");
    assert.deepEqual(plan.removedNoteAnchors, [`^${CHILD_ID}`, `^${DOING_ID}`], "根节点自己的段落保留");

    const archivedWorkflow = plan.document.workflows[0];
    assert.equal(archivedWorkflow.title, `立项调查${ARCHIVE_TITLE_SUFFIX}`);
    assert.equal("originId" in archivedWorkflow, false, "整条流归档的 workflow 不写 originId");
    assert.equal(archivedWorkflow.root.archive, undefined, "归档 JSON 的根节点不带 archive");
    const jsonText = stringifyWfJson(plan.document);
    assert.equal(jsonText.includes('"originId"'), false);
    assert.equal(analyzeArchive(plan).counts.error, 0);

    // 不做节点追溯：原 id 一个都不留在归档 JSON 里
    for (const id of [ROOT_ID, CHILD_ID, DOING_ID]) {
      assert.equal(jsonText.includes(id), false, `归档 JSON 里不该出现原 id ${id}`);
    }

    // 工作流不存在 → 只给原因，不产出计划
    const missing = planWorkflowArchive(document, "wf-not-exist", {}, NOW);
    assert.equal(missing.ok, false);
    assert.match(missing.reason ?? "", /不存在/);
  });

  test("archiveWorkflow：根节点浓缩 + 文件级 workflow_archive 台账；重复归档被拒", () => {
    const document = clone(validDocument13());
    // 夹具里 workflow 2 的根节点本来就带 `archive`（早期节点级归档的浓缩根），先清掉才能再归档一次
    delete document.workflows[1].root.archive;
    const workflow = document.workflows[0];
    const archive = archiveField({ workflowId: "wf-archive-stub" });

    const edit = archiveWorkflow(document, workflow.id, archive, NOW);
    assert.equal(edit.ok, true, edit.reason);
    assert.deepEqual(edit.changedNodeIds, [ROOT_ID]);
    assert.deepEqual(edit.removedNoteAnchors, [`^${CHILD_ID}`, `^${DOING_ID}`]);
    assert.equal(edit.removedNodeCount, 2);

    const root = nodeOf(document, ROOT_ID);
    assert.equal(root.children.length, 0);
    assert.equal(root.archive?.workflowId, "wf-archive-stub");
    assert.equal(root.completedAt, "2026-10-07T09:00:00+08:00", "completedAt 取子树最晚");
    assert.equal(root.timeEntries?.length, 3, "timeEntries 累加根 + 后代");

    const ledger = document.workflow_archive ?? [];
    assert.equal(ledger.length, 1);
    assert.equal(ledger[0].workflowId, workflow.id);
    assert.equal(ledger[0].title, "立项调查");
    assert.equal(ledger[0].noteAnchor, `^${ROOT_ID}`);
    assert.equal(ledger[0].archive.workflowId, "wf-archive-stub");

    // 幂等：再归档一次被拒，且台账不会多出一条
    const again = archiveWorkflow(document, workflow.id, archive, NOW);
    assert.equal(again.ok, false);
    assert.match(again.reason ?? "", /已归档/);
    assert.equal((document.workflow_archive ?? []).length, 1);

    // 另一条流归档 → 台账并列（一条流一条记录，按归档先后追加）
    const other = archiveWorkflow(document, document.workflows[1].id, archiveField({ workflowId: "wf-archive-2" }), NOW);
    assert.equal(other.ok, true, other.reason);
    assert.deepEqual(
      (document.workflow_archive ?? []).map((item) => item.workflowId),
      [workflow.id, document.workflows[1].id],
    );
  });

  test("Phase 34：整条流归档后根节点保留 linkDir（子节点继承链不断）", () => {
    const document = clone(validDocument13());
    delete document.workflows[1].root.archive;
    document.workflows[0].root.linkDir = "资料/立项调查";

    assert.equal(archiveWorkflow(document, document.workflows[0].id, archiveField(), NOW).ok, true);

    assert.equal(nodeOf(document, ROOT_ID).linkDir, "资料/立项调查");
  });

  test("与写回链路配合：写回后零 error、台账可读回、幂等认领判据 = 没有 originId", () => {
    const document = clone(validDocument13());
    const workflowId = document.workflows[0].id;
    const source = writeBackDocument("", document, { now: NOW }).markdown;
    const planned = planWorkflowArchive(document, workflowId, { summary: "整条流收口" }, NOW);
    assert.ok(planned.plan);
    const plan = planned.plan;

    const mutation = applyMutation(
      source,
      (target) => {
        const edit = archiveWorkflow(target, workflowId, plan.archive, NOW);
        if (!edit.ok) return { reject: edit.reason ?? "归档失败" };
        return {
          changedNodeIds: edit.changedNodeIds,
          removedNoteAnchors: edit.removedNoteAnchors,
        };
      },
      { now: NOW },
    );

    assert.equal(mutation.success, true, mutation.reason ?? "写回应当成功");
    assert.equal(mutation.changed, true);
    const after = analyzeMarkdown(mutation.markdown);
    assert.equal(after.counts.error, 0, JSON.stringify(after.issues));
    const written = after.document;
    assert.ok(written, "写回产物仍要能被解析");
    assert.equal(written.workflow_archive?.length, 1);
    assert.equal(written.workflow_archive?.[0].noteAnchor, plan.noteAnchor);
    assert.equal(nodeOf(written, ROOT_ID).children.length, 0);

    // Phase 27：正文不再挂纪要段 —— 台账里的归档身份在 JSON，正文没有任何块级标题
    assert.equal(mutation.markdown.includes(`^${CHILD_ID}`), false);
    assert.equal(/^#{1,6} /m.test(mutation.markdown), false, "正文不再有 `### 标题 ^id` 纪要段");
    assert.equal(mutation.markdown.includes("归档："), false);

    // 幂等认领：路径仍按 `-<根节点id>.wf.json`，而身份里**没有** originId（= 整条流归档）
    assert.equal(isArchivePathForNode(plan.file, plan.rootNodeId), true);
    const identity = readArchivedWorkflowIdentity("", stringifyWfJson(plan.document));
    assert.equal(identity.originId, undefined, "整条流归档的 JSON 不带 originId（插件据此认领重试文件）");
    assert.equal(identity.workflowId, plan.archiveWorkflowId);
    assert.equal(identity.nodeCount, plan.nodeCount);
  });
});

/* ------------------------------------------------------------------ *
 * Phase 36：重复归档（把新子树追加到旧归档文件 的根节点下）
 * ------------------------------------------------------------------ */

describe("archive · Phase 36 重复归档（追加到旧归档文件）", () => {
  /**
   * 造一对「旧归档文件 + 又长出一条新 done 子树的原文档」：
   *  - `archived` = 上一次归档产物的文档（workflow.id = 旧 workflowId，根下有旧子树）；
   *  - `source`   = 原文档（`整理结论` 带旧 `archive`，children 换成一条新的 done 节点）。
   */
  function appendFixture(): { source: WfJsonDocument; archived: WfJsonDocument; workflowId: string } {
    const source = archivableDocument();
    const mid = source.workflows[0].root.children[0];
    const first = planOf(source, CHILD_ID, { summary: "第一版" });
    mid.archive = { workflowId: first.workflowId };
    mid.children = [
      {
        id: "nd-uuid-006",
        title: "新的一条",
        status: "done",
        progress: 3,
        startAt: "2026-10-11T09:00:00+08:00",
        updatedAt: "2026-10-11T11:00:00+08:00",
        completedAt: "2026-10-11T11:00:00+08:00",
        children: [],
        relations: [{ target: ROOT_ID, kind: "related" }],
      },
    ];
    return { source, archived: first.document, workflowId: first.workflowId };
  }

  test("planArchiveAppend：只重映射新子树、沿用旧 workflowId、archive 以旧值为底", () => {
    const { source, archived, workflowId } = appendFixture();
    const mid = nodeOf(source, CHILD_ID);

    const result = planArchiveAppend(archived, source.id, mid, { review: "第二版复盘" }, NOW);
    assert.equal(result.ok, true, result.reason);
    const plan = result.plan;
    assert.ok(plan);

    assert.equal(plan.rootId, archived.workflows[0].root.id, "追加目标 = 旧归档文件 的根节点");
    assert.equal(plan.appendedNodeCount, 1);
    assert.deepEqual(plan.removedNoteAnchors, ["^nd-uuid-006"]);
    assert.equal(plan.appendedChildren.length, 1);

    const appended = plan.appendedChildren[0];
    assert.equal(appended.title, "新的一条");
    assert.notEqual(appended.id, "nd-uuid-006", "不做节点追溯：id 必须重映射");
    assert.equal(appended.noteAnchor, undefined, "归档副本不再带 noteAnchor");
    assert.deepEqual(
      appended.relations,
      [{ target: `${source.id}#${ROOT_ID}`, kind: "related" }],
      "指向原文件邻居的关系写成跨文件引用",
    );

    // archive：节点侧沿用旧 workflowId；归档文件自己的元数据刷新 archivedAt、保留旧说明
    assert.deepEqual(plan.archive, { workflowId });
    assert.equal(plan.archiveMeta.archivedAt, formatArchivedAt(NOW));
    assert.equal(plan.archiveMeta.from_workflow, "立项调查");
    assert.equal(plan.archiveMeta.from_node, "整理结论");
    assert.equal(plan.archiveMeta.summary, "第一版", "本次没填 summary → 保留旧值");
    assert.equal(plan.archiveMeta.review, "第二版复盘");

    // 合并进旧归档文件 后仍是一份合法文档（旧内容原样保留）
    const merged = clone(archived);
    const beforeIds = merged.workflows[0].root.children.map((child) => child.id);
    merged.workflows[0].root.children = [
      ...merged.workflows[0].root.children,
      ...plan.appendedChildren,
    ];
    assert.deepEqual(
      merged.workflows[0].root.children.slice(0, beforeIds.length).map((child) => child.id),
      beforeIds,
      "旧内容一个字节都不动",
    );
    const analysis = analyzeMarkdown(writeBackDocument("", merged, { now: NOW }).markdown);
    assert.equal(analysis.counts.error, 0, JSON.stringify(analysis.issues));
    assert.equal(analysis.document?.workflows[0].root.children.length, beforeIds.length + 1);
  });

  test("planArchiveAppend：没有旧归档 / 没有新子树 / 归档文件 坏了 → 拒绝", () => {
    const { source, archived } = appendFixture();
    const mid = nodeOf(source, CHILD_ID);

    const noArchive = clone(source);
    delete noArchive.workflows[0].root.children[0].archive;
    assert.equal(
      planArchiveAppend(archived, noArchive.id, nodeOf(noArchive, CHILD_ID), {}, NOW).reason,
      "该节点还没有归档，不能追加",
    );

    const noChildren = clone(source);
    noChildren.workflows[0].root.children[0].children = [];
    assert.equal(
      planArchiveAppend(archived, noChildren.id, nodeOf(noChildren, CHILD_ID), {}, NOW).reason,
      "叶子节点没有子树",
    );

    const broken: WfJsonDocument = { schemaVersion: SCHEMA_VERSION, id: "doc-broken", workflows: [] };
    assert.match(planArchiveAppend(broken, source.id, mid, {}, NOW).reason ?? "", /没有工作流/);
  });

  test("追加 + 浓缩：一个节点始终只有一份归档文件（workflowId 不变）", () => {
    const { source, archived } = appendFixture();
    const mid = nodeOf(source, CHILD_ID);
    const planned = planArchiveAppend(archived, source.id, mid, { review: "第二版复盘" }, NOW);
    assert.ok(planned.plan);
    const plan = planned.plan;

    // 归档文件 侧：追加（模拟插件里 mutateFile 的闭包）
    const nextArchive = clone(archived);
    nextArchive.workflows[0].root.children.push(...plan.appendedChildren);

    // 原文件侧：浓缩
    const edit = archiveNode(source, CHILD_ID, plan.archive, NOW);
    assert.equal(edit.ok, true, edit.reason);
    const condensed = nodeOf(source, CHILD_ID);
    assert.equal(condensed.children.length, 0);
    assert.equal(condensed.archive?.workflowId, archived.workflows[0].id);
    assert.deepEqual(edit.removedNoteAnchors, ["^nd-uuid-006"]);
    assert.equal(nextArchive.workflows[0].root.children.length, 2, "旧子树 + 追加的一条");
  });
});

describe("archive · Phase 27 归档写回不再碰正文", () => {
  test("mergeNoteSections 已失效：归档地址不落正文，成对旧段被清掉，锚点全不写", () => {
    const document = archivableDocument();
    const source = writeBackDocument("", document, { now: NOW }).markdown;
    const plan = planOf(document, CHILD_ID, { summary: "三条结论已收敛" });

    const mutation = applyMutation(
      source,
      (target) => {
        const edit = archiveNode(target, CHILD_ID, plan.archive, NOW);
        if (!edit.ok) return { reject: edit.reason ?? "归档失败" };
        return {
          changedNodeIds: edit.changedNodeIds,
          removedNoteAnchors: edit.removedNoteAnchors,
          mergeNoteSections: [
            { targetNodeId: CHILD_ID, lines: [renderArchiveNoteLine(plan.file, "三条结论已收敛")] },
          ],
        };
      },
      { now: NOW },
    );

    assert.equal(mutation.success, true, mutation.reason ?? "写回应当成功");
    const analysis = analyzeMarkdown(mutation.markdown);
    assert.equal(analysis.counts.error, 0, JSON.stringify(analysis.issues));
    assert.equal(mutation.markdown.includes("归档："), false, "Phase 27：归档地址不再写进正文");
    assert.equal(mutation.markdown.includes("<!-- wf-note:"), false, "不再生成 wf-note 成对段");
    assert.equal(mutation.markdown.includes(`^${CHILD_ID}`), false);
    assert.equal(mutation.markdown.includes(`^${NEST_ID}`), false);
  });
});

describe("archive · 幂等重试辅助", () => {
  test("isArchivePathForNode：只认以 `-<uid16>.wf.json` 结尾的文件名", () => {
    const uid = shortIdOf(CHILD_ID);
    assert.equal(isArchivePathForNode(`archive/工作流-节点-20260105-090708-${uid}.wf.json`, CHILD_ID), true);
    assert.equal(isArchivePathForNode(`工作流-节点-20260105-090708-${uid}.wf.json`, CHILD_ID), true);
    assert.equal(isArchivePathForNode(`archive/工作流-节点-20260105-090708-${shortIdOf(NEST_ID)}.wf.json`, CHILD_ID), false);
    assert.equal(isArchivePathForNode(`archive/wf-x-${CHILD_ID}.wf.json`, CHILD_ID), false);
    assert.equal(isArchivePathForNode(`archive/工作流-节点-20260105-090708-${uid}.md`, CHILD_ID), false);
  });

  test("readArchivedWorkflowIdentity：从纯 JSON 读回 workflowId / originId / 节点数", () => {
    const plan = planOf(archivableDocument(), CHILD_ID, { summary: "收敛" });
    const identity = readArchivedWorkflowIdentity("", stringifyWfJson(plan.document));

    assert.equal(identity.workflowId, plan.workflowId);
    assert.equal(identity.originId, CHILD_ID);
    assert.equal(identity.nodeCount, plan.nodeCount);

    // 不是归档产物（没有 wfjson 块）→ 认不出身份
    assert.deepEqual(readArchivedWorkflowIdentity("# 普通笔记\n\n没有 wfjson 块。\n"), {});
  });

  test("readArchivedWorkflowIdentity：老的内联归档（正文带代码块）仍能读", () => {
    const plan = planOf(archivableDocument(), CHILD_ID, { summary: "收敛" });
    // 老形态兜底：第一参数是 md 文本（内联代码块），不传 jsonText
    const legacyMarkdown = writeBackDocument("", plan.document, { now: NOW }).markdown;
    const identity = readArchivedWorkflowIdentity(legacyMarkdown);
    assert.equal(identity.workflowId, plan.workflowId);
    assert.equal(identity.originId, CHILD_ID);
    assert.equal(identity.nodeCount, plan.nodeCount);
  });
});

describe("archive · editWorkflowArchiveInfo（Phase 39 编辑归档文件元数据）", () => {
  /** 编辑用的「稍后」时间（与归档时间 NOW 不同，便于断言 updatedAt 真的刷新了） */
  const LATER = new Date("2026-10-20T10:00:00+08:00");

  /** 造一份归档文件文档：workflow 的 `workflow.archive` 带旧概括 / 旧原理 / 旧复盘 */
  function archivedDocument(): WfJsonDocument {
    const plan = planOf(archivableDocument(), CHILD_ID, { summary: "旧概括", idea: "旧原理", review: "旧复盘" });
    return plan.document;
  }

  test("三段文字逐段覆盖；archivedAt / from_* 不动；updatedAt 刷新", () => {
    const document = archivedDocument();
    const workflow = document.workflows[0];
    const archive = workflow.archive;
    assert.ok(archive, "归档文件的 workflow 必须带 archive 元数据");
    const archivedAtBefore = archive.archivedAt;
    const fromWorkflowBefore = archive.from_workflow;
    const fromNodeBefore = archive.from_node;

    const result = editWorkflowArchiveInfo(document, workflow.id, { summary: "新概括", idea: "新原理", review: "新复盘" }, LATER);
    assert.equal(result.ok, true);
    assert.equal(result.changed, true);
    assert.equal(result.workflowId, workflow.id);
    assert.equal(archive.summary, "新概括");
    assert.equal(archive.idea, "新原理");
    assert.equal(archive.review, "新复盘");
    assert.equal(archive.archivedAt, archivedAtBefore, "归档时间不动");
    assert.equal(archive.from_workflow, fromWorkflowBefore, "来源工作流不动");
    assert.equal(archive.from_node, fromNodeBefore, "来源节点不动");
    assert.equal(document.updatedAt, formatLocalIso(LATER));
  });

  test("空串 / 纯空白 → 删键（不写空串）", () => {
    const document = archivedDocument();
    const workflow = document.workflows[0];
    const result = editWorkflowArchiveInfo(document, workflow.id, { summary: "   ", idea: "", review: "保留复盘" }, NOW);
    assert.equal(result.ok, true);
    const archive = workflow.archive;
    assert.ok(archive);
    assert.equal("summary" in archive, false);
    assert.equal("idea" in archive, false);
    assert.equal(archive.review, "保留复盘");
  });

  test("与现状一致 → changed=false，不动 updatedAt（调用方可不写盘）", () => {
    const document = archivedDocument();
    const workflow = document.workflows[0];
    const updatedAtBefore = document.updatedAt;
    const result = editWorkflowArchiveInfo(document, workflow.id, { summary: "旧概括", idea: "旧原理", review: "旧复盘" }, LATER);
    assert.equal(result.ok, true);
    assert.equal(result.changed, false);
    assert.equal(document.updatedAt, updatedAtBefore);
  });

  test("workflow 不存在 → ok=false，文档一动不动", () => {
    const document = archivedDocument();
    const before = JSON.stringify(document);
    const result = editWorkflowArchiveInfo(document, "wf-nope", { summary: "x" }, NOW);
    assert.equal(result.ok, false);
    assert.equal(JSON.stringify(document), before);
  });

  test("旧文件没有 workflow.archive → 按标题 / 本次时间补一个", () => {
    const document = clone(validDocument13());
    const workflow = document.workflows[0];
    const edit = editWorkflowArchiveInfo(document, workflow.id, { summary: "补的概括" }, NOW);
    assert.equal(edit.ok, true);
    assert.equal(edit.changed, true);
    assert.equal(workflow.archive?.summary, "补的概括");
    assert.equal(workflow.archive?.from_workflow, workflow.title);
    assert.equal(workflow.archive?.from_node, workflow.root.title);
    assert.equal(workflow.archive?.archivedAt, formatArchivedAt(NOW));
  });

  test("tag 覆盖 / 清空", () => {
    const document = archivedDocument();
    const workflow = document.workflows[0];
    assert.equal(editWorkflowArchiveInfo(document, workflow.id, { tag: ["归档", "复盘"] }, NOW).ok, true);
    assert.deepEqual(workflow.archive?.tag, ["归档", "复盘"]);
    assert.equal(editWorkflowArchiveInfo(document, workflow.id, { tag: [] }, NOW).ok, true);
    assert.equal("tag" in (workflow.archive ?? {}), false);
  });
});

describe("archive · Phase 45 任意工作流写四条复盘说明", () => {
  test("applyWorkflowArchiveNotes：只写四条说明，不合成 archivedAt / from_*", () => {
    const document = clone(validDocument13());
    const workflow = document.workflows[0];
    const changed = applyWorkflowArchiveNotes(workflow, {
      summary: " 收敛 ",
      idea: "",
      review: "下一步：补竞品截图",
      tag: ["竞品", " 竞品 ", ""],
    });

    assert.equal(changed, true);
    assert.deepEqual(workflow.archive, {
      summary: "收敛",
      review: "下一步：补竞品截图",
      tag: ["竞品"],
    });
    assert.equal("archivedAt" in (workflow.archive ?? {}), false);
    assert.equal("from_workflow" in (workflow.archive ?? {}), false);
  });

  test("四条全空：没有事实键时整块删掉；有事实键（真归档）时只删说明", () => {
    const document = clone(validDocument13());
    const workflow = document.workflows[0];

    applyWorkflowArchiveNotes(workflow, { summary: "只有说明" });
    assert.equal(applyWorkflowArchiveNotes(workflow, {}), true);
    assert.equal("archive" in workflow, false, "只剩说明 → workflow.archive 整个删掉");

    workflow.archive = {
      archivedAt: "2026-10-12 14:30",
      from_workflow: "立项调查",
      from_node: "调研竞品",
      summary: "旧说明",
    };
    assert.equal(applyWorkflowArchiveNotes(workflow, {}), true);
    assert.deepEqual(workflow.archive, {
      archivedAt: "2026-10-12 14:30",
      from_workflow: "立项调查",
      from_node: "调研竞品",
    });
  });

  test("与现状一致 → false（调用方不写盘）", () => {
    const document = clone(validDocument13());
    const workflow = document.workflows[0];
    workflow.archive = { summary: "同一份", tag: ["归档"] };

    assert.equal(applyWorkflowArchiveNotes(workflow, { summary: " 同一份 ", tag: ["归档"] }), false);
  });

  test("setWorkflowArchiveNotes：按 id 写 / unchanged / 不存在", () => {
    const document = clone(validDocument13());
    const workflow = document.workflows[0];

    const edit = setWorkflowArchiveNotes(document, workflow.id, { summary: "复盘" }, NOW);
    assert.equal(edit.ok, true);
    assert.equal(edit.changed, true);
    assert.equal(edit.workflowId, workflow.id);
    assert.equal(workflow.archive?.summary, "复盘");
    assert.equal(document.updatedAt, formatLocalIso(NOW));

    const updatedAtBefore = document.updatedAt;
    const again = setWorkflowArchiveNotes(document, workflow.id, { summary: "复盘" }, NOW);
    assert.equal(again.ok, true);
    assert.equal(again.changed, false);
    assert.equal(document.updatedAt, updatedAtBefore, "无变化不刷 updatedAt");

    const before = JSON.stringify(document);
    const missing = setWorkflowArchiveNotes(document, "wf-nope", { summary: "x" }, NOW);
    assert.equal(missing.ok, false);
    assert.equal(JSON.stringify(document), before, "不存在 → 文档一动不动");
  });
});

describe("archive · Phase 39 归档标签 + 短 id", () => {
  test("shortIdOf：去前缀、小写、补零截断到 16 位", () => {
    assert.equal(shortIdOf("nd-uuid-002"), "uuid002000000000");
    assert.equal(shortIdOf("nd-123e4567-e89b-12d3-a456-426614174000"), "123e4567e89b12d3");
  });

  test("parseArchiveTagYaml / stringifyArchiveTagYaml 往返", () => {
    assert.deepEqual(parseArchiveTagYaml("tags:\n  - 竞品\n  - 归档\n  - 竞品\n"), ["竞品", "归档"]);
    assert.deepEqual(parseArchiveTagYaml(stringifyArchiveTagYaml(["归档", "竞品"])), ["归档", "竞品"]);
  });

  test("buildWorkflowArchive：必填三键 + 空串 / 重复标签清理", () => {
    const archive = buildWorkflowArchive(
      { summary: " 收敛 ", idea: "", tag: ["竞品", " 竞品 ", ""] },
      "2026-10-12 14:30",
      "立项调查",
      "整理结论",
    );
    assert.deepEqual(archive, {
      archivedAt: "2026-10-12 14:30",
      from_workflow: "立项调查",
      from_node: "整理结论",
      summary: "收敛",
      tag: ["竞品"],
    });
  });

  test("readArchiveFileMeta：读回归档文件自己的 workflow.archive", () => {
    const plan = planOf(archivableDocument(), CHILD_ID, { summary: "三条结论已收敛", tag: ["归档"] });
    const meta = readArchiveFileMeta(plan.file, stringifyWfJson(plan.document));
    assert.ok(meta);
    assert.equal(meta.path, plan.file);
    assert.equal(meta.workflowId, plan.workflowId);
    assert.equal(meta.fromWorkflow, "立项调查");
    assert.equal(meta.fromNode, "整理结论");
    assert.equal(meta.archivedAt, formatArchivedAt(NOW));
    assert.equal(meta.summary, "三条结论已收敛");
    assert.deepEqual(meta.tag, ["归档"]);
    assert.equal(meta.nodeCount, 2);
    // 认不出 → undefined
    assert.equal(readArchiveFileMeta("x.wf.json", "{ not json"), undefined);
  });
});
