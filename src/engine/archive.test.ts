/**
 * 归档（archive.ts）单测：资格判断 / 归档 md 生成 / 子树浓缩 / 幂等重试辅助。
 *
 * 覆盖五层：
 *  1. 资格（根 / 叶子 / 已归档 / 子树未全 done → 拒绝，理由文案同时给右键菜单用）；
 *  2. `planArchive`：只读、归档 md 文本自洽（新 id + originId + 无 state + 数据全保留 + 空壳段落 +
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
  archiveEligibility,
  archiveFilePath,
  archiveNode,
  checkArchiveEligibility,
  collectDescendants,
  extractArchiveReference,
  formatArchivedAt,
  isArchivePathForNode,
  planArchive,
  readArchivedWorkflowIdentity,
  renderArchiveNoteLine,
  type ArchiveFormInput,
  type ArchivePlan,
} from "./archive.ts";
import { analyzeMarkdown } from "./analyze.ts";
import { applyMutation } from "./mutate.ts";
import { replaceNoteSectionContent } from "./noteSection.ts";
import { CHILD_ID, DOING_ID, ROOT_ID, clone, validDocument13 } from "./testFixtures.ts";
import { formatLocalIso } from "./time.ts";
import { findNode } from "./tree.ts";
import { SCHEMA_VERSION, type WfArchive, type WfJsonDocument, type WfNode } from "./types.ts";
import { writeBackDocument } from "./wfjsonWrite.ts";

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

/** 一份合法的 `archive` 字段（`archiveNode` 的入参；来源是 `planArchive`） */
function archiveField(extra: Partial<WfArchive> = {}): WfArchive {
  return {
    archivedAt: "2026-10-12 14:30",
    file: `archive/wf-stub-${CHILD_ID}.md`,
    workflowId: "wf-stub",
    schemaVersion: SCHEMA_VERSION,
    ...extra,
  };
}


describe("archive · 归档资格", () => {
  test("根节点 / 叶子 / 已归档 / 子树未全 done → 拒绝（文案同时用于右键菜单置灰）", () => {
    const document = archivableDocument();
    const root = document.workflows[0].root;
    const mid = root.children[0];

    assert.deepEqual(archiveEligibility(root, true), { ok: false, reason: "根节点不能归档" });
    assert.deepEqual(archiveEligibility(root.children[1], false), { ok: false, reason: "叶子节点没有子树" });
    assert.deepEqual(archiveEligibility(mid, false), { ok: true });

    const archived = clone(mid);
    archived.archive = archiveField();
    assert.deepEqual(archiveEligibility(archived, false), { ok: false, reason: "该节点已归档" });

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

describe("archive · formatArchivedAt / archiveFilePath", () => {
  test("归档时间精确到分钟、补零", () => {
    assert.equal(formatArchivedAt(new Date(2026, 0, 5, 9, 7)), "2026-01-05 09:07");
    assert.equal(formatArchivedAt(NOW), formatArchivedAt(new Date(NOW.getTime())));
    assert.match(formatArchivedAt(NOW), /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
  });

  test("归档 md 路径：`archive/<workflowId>-<nodeId>.md`", () => {
    assert.equal(archiveFilePath("wf-x", CHILD_ID), `archive/wf-x-${CHILD_ID}.md`);
    assert.equal(archiveFilePath("wf-x", CHILD_ID).startsWith(`${ARCHIVE_FOLDER}/`), true);
  });
});

describe("archive · planArchive（归档计划，只读）", () => {
  test("路径 / archive 字段 / 表单选填 / 锚点清单", () => {
    const document = archivableDocument();
    const plan = planOf(document, CHILD_ID, { summary: " 三条结论已收敛 ", idea: "先验证再实现", review: "   " });

    assert.equal(plan.nodeId, CHILD_ID);
    assert.equal(plan.nodeTitle, "整理结论");
    assert.equal(plan.workflowId, plan.archive.workflowId, "workflowId 必须与 archive 字段一致");
    assert.equal(plan.file, `archive/${plan.workflowId}-${CHILD_ID}.md`);
    assert.equal(plan.archive.file, undefined, "v0.7 §⑨-2：归档地址不再写进 JSON（改存纪要段）");
    assert.equal(plan.archive.archivedAt, formatArchivedAt(NOW));
    assert.equal(plan.archive.schemaVersion, SCHEMA_VERSION);
    assert.equal(plan.archive.summary, "三条结论已收敛");
    assert.equal(plan.archive.idea, "先验证再实现");
    assert.equal(plan.archive.review, undefined, "只有空白的选填项必须省略");

    assert.equal(plan.nodeCount, 2);
    assert.deepEqual(plan.removedNoteAnchors, [`^${NEST_ID}`]);
  });

  test("不改动传入的文档", () => {
    const document = archivableDocument();
    const before = JSON.stringify(document);
    planArchive(document, CHILD_ID, { summary: "x" }, NOW);
    assert.equal(JSON.stringify(document), before);
  });

  test("归档 md 自洽：新 id / originId / 无 state / 数据全保留 / 空壳段落 / relations 重定向", () => {
    const document = archivableDocument();
    const plan = planOf(document, CHILD_ID, { summary: "三条结论已收敛" });
    const analysis = analyzeMarkdown(plan.markdown, { file: plan.file });

    assert.equal(analysis.found, true);
    assert.equal(analysis.counts.error, 0);
    assert.equal(analysis.counts.warning, 0, `归档 md 不该有 warning：${JSON.stringify(analysis.issues)}`);
    const archived = analysis.document;
    assert.ok(archived, "归档 md 必须能解析出 wfjson 文档");
    assert.notEqual(archived.id, document.id, "文件级 id 重新生成");
    assert.equal(archived.workflows.length, 1);

    const workflow = archived.workflows[0];
    assert.equal(workflow.id, plan.workflowId);
    assert.equal(workflow.title, `整理结论${ARCHIVE_TITLE_SUFFIX}`);
    assert.equal(workflow.originId, CHILD_ID);
    assert.equal(workflow.state, undefined, "归档 md 自己不带 state（缺省即进行中）");

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

    // 数据全保留（归档 md 里浓缩节点仍是完整节点）
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
    // Phase 9：links 已弃用 → 归档 md 里迁进正文纪要段（JSON 不再保留该键）
    assert.equal(archivedRoot.links, undefined, "links 应已迁进正文，归档 JSON 不再保留");
    assert.deepEqual(
      analysis.noteLinks.get(archivedRoot.id)?.map((link) => link.target),
      ["竞品分析报告"],
    );
    assert.equal(archivedRoot.statusHistory?.length, 2);
    assert.equal(archivedRoot.timeEntries?.length, 1);
    assert.equal(archivedRoot.completedAt, "2026-10-06T12:00:00+08:00");
    assert.equal(archivedRoot.archive, undefined, "归档 md 里不再带 archive");

    assert.equal(archivedRoot.children.length, 1);
    const archivedChild = archivedRoot.children[0];
    assert.equal(archivedChild.title, "深挖三条结论");
    assert.equal(archivedChild.status, "done");
    assert.equal(archivedChild.timeEntries?.length, 1);

    // relations 重定向：子树内部 → 新 id；子树外部 → 跨文件引用（否则归档 md 里「目标找不到」）
    assert.deepEqual(archivedRoot.relations?.map((relation) => relation.target), [
      archivedChild.id,
      `${document.id}#${ROOT_ID}`,
    ]);

    // 每个节点都有空壳段落（`### 标题 ^新 id` + 占位文本），原锚点不以节点身份残留
    for (const node of nodes) {
      assert.match(plan.markdown, new RegExp(`### ${node.title} \\^${node.id}`));
    }
    assert.match(plan.markdown, /（纪要待补充）/);
    assert.equal(plan.markdown.includes(`^${NEST_ID}`), false);
    assert.equal(plan.markdown.includes(`^${CHILD_ID}`), false);
  });
});

describe("archive · Phase 9 正文复制", () => {
  test("Phase 9：传入 sourceMarkdown 时把子树正文纪要（文字 + 超链接）复制进归档 md", () => {
    const document = archivableDocument();
    const mid = nodeOf(document, CHILD_ID);
    const nest = nodeOf(document, NEST_ID);

    let source = writeBackDocument("", document, { now: NOW }).markdown;
    const contents: { id: string; text: string }[] = [
      { id: mid.id, text: "复盘：三条结论已合并\n- [竞品报告](https://example.com/report)" },
      { id: nest.id, text: "深挖过程记录（含 [[访谈录音]]）" },
    ];
    for (const item of contents) {
      const replaced = replaceNoteSectionContent(source, item.id, item.text);
      assert.equal(replaced.found, true, `源文应有 ${item.id} 的标志段`);
      source = replaced.markdown;
    }

    const planned = planArchive(document, mid.id, {}, NOW, source);
    assert.equal(planned.ok, true);
    const markdown = planned.plan?.markdown ?? "";
    assert.ok(markdown.includes("复盘：三条结论已合并"), "浓缩节点正文要复制进归档 md");
    assert.ok(markdown.includes("https://example.com/report"), "超链接要一起复制");
    assert.ok(markdown.includes("深挖过程记录（含 [[访谈录音]]）"), "后代正文也要复制");
    assert.equal(markdown.includes(`^${mid.id}`), false, "归档 md 不应保留旧锚点（originId 除外）");
    assert.equal(markdown.includes(`^${nest.id}`), false);
    assert.equal(analyzeMarkdown(markdown).hasError, false, "复制后的归档 md 仍要零 error");
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

    // 已经归档过的节点：先清掉它的 archive 再来
    const already = clone(document);
    already.workflows[0].root.children[0].archive = archive;
    assert.equal(archiveNode(already, CHILD_ID, archive, NOW).reason, "该节点已归档");

    assert.equal(JSON.stringify(document), before, "所有拒绝路径都不该改动文档");
  });
});

describe("archive · 与写回链路配合", () => {
  test("plan → archiveNode → applyMutation：原文浓缩、正文删掉后代段落、零 error", () => {
    const document = archivableDocument();
    const source = writeBackDocument("", document, { now: NOW }).markdown;
    const plan = planOf(document, CHILD_ID, { summary: "三条结论已收敛" });

    // 归档 md（已落盘的那份）本身就是一份合法文件
    assert.equal(analyzeMarkdown(plan.markdown, { file: plan.file }).counts.error, 0);

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
    assert.equal(mid.archive?.file, undefined, "v0.7 §⑨-2：JSON 里不再有 archive.file");
    assert.equal(mid.children.length, 0);

    // 正文：浓缩节点自己的段落保留，被删后代的段落消失
    assert.equal(mutation.markdown.includes(`^${CHILD_ID}`), true);
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

describe("archive · 归档地址行（v0.7 §⑨-2）", () => {
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

  test("mergeNoteSections：归档行落进浓缩节点自己的纪要段，后代段落照删", () => {
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
            {
              targetNodeId: CHILD_ID,
              lines: [renderArchiveNoteLine(plan.file, "三条结论已收敛")],
            },
          ],
        };
      },
      { now: NOW },
    );

    assert.equal(mutation.success, true, mutation.reason ?? "写回应当成功");
    const analysis = analyzeMarkdown(mutation.markdown);
    assert.equal(analysis.counts.error, 0, JSON.stringify(analysis.issues));

    const section = analysis.noteSections.find((item) => item.nodeId === CHILD_ID);
    assert.ok(section, "浓缩节点自己的纪要段必须还在");
    assert.equal(extractArchiveReference(section.content), plan.file);

    // 被浓缩掉的后代段落仍然从正文删除
    assert.equal(mutation.markdown.includes(`^${NEST_ID}`), false);
  });
});

describe("archive · 幂等重试辅助", () => {
  test("isArchivePathForNode：只认 `<workflowId>-<nodeId>.md` / `<nodeId>.md` 的文件名", () => {
    assert.equal(isArchivePathForNode(`archive/wf-x-${CHILD_ID}.md`, CHILD_ID), true);
    assert.equal(isArchivePathForNode(`archive/${CHILD_ID}.md`, CHILD_ID), true);
    assert.equal(isArchivePathForNode(`archive/wf-x-${NEST_ID}.md`, CHILD_ID), false);
    assert.equal(isArchivePathForNode(`archive/${CHILD_ID}-副本.md`, CHILD_ID), false);
    // 只看文件名（调用方负责只在 archive/ 目录下扫）
    assert.equal(isArchivePathForNode(`wf-x-${CHILD_ID}.md`, CHILD_ID), true);
  });

  test("readArchivedWorkflowIdentity：读回 workflowId / originId / 节点数", () => {
    const plan = planOf(archivableDocument(), CHILD_ID, { summary: "收敛" });
    const identity = readArchivedWorkflowIdentity(plan.markdown);

    assert.equal(identity.workflowId, plan.workflowId);
    assert.equal(identity.originId, CHILD_ID);
    assert.equal(identity.nodeCount, plan.nodeCount);

    // 不是归档产物（没有 wfjson 块）→ 认不出身份
    assert.deepEqual(readArchivedWorkflowIdentity("# 普通笔记\n\n没有 wfjson 块。\n"), {});
  });
});


