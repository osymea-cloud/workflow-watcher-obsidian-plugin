/**
 * 节点编辑（nodeEdits.ts）单测 + links 就地校验（validateLinksValue）。
 *
 * 覆盖三件事：
 *  1. 编辑函数自身的语义（默认值 / 拒绝路径「文档一动不动」/ 删除时的摊平合并规则）；
 *  2. 与写回链路的配合（applyMutation：写回产物、幂等校验回滚、`removedAnchors`）；
 *  3. Modal 保存前用的 `validateLinksValue`（必须与写回时的 Schema 一致）。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { analyzeMarkdown } from "./analyze.ts";
import { applyMutation } from "./mutate.ts";
import { appendChildNode, editNodeNote, editNodeInfo, editNodeLinks, normalizeNodeLinkDir, removeNode, setNodeCollapsed, setNodeLinkDir, toggleNodeNoteDone, validateNodeInfoPatch } from "./nodeEdits.ts";
import { getNoteSectionContent } from "./noteSection.ts";
import {
  clone,
  CHILD_ID,
  DOING_ID,
  ROOT_ID,
  WF2_ID,
  validDocument,
  validDocument13,
  validMarkdown,
  validMarkdown11,
} from "./testFixtures.ts";
import { findNode } from "./tree.ts";
import type { WfJsonDocument, WfNode } from "./types.ts";
import { validateLinksValue } from "./wfjsonSchema.ts";

const NOW = new Date("2026-10-11T10:30:00+08:00");
const AT = "2026-10-11T10:30:00+08:00";

/** 取节点（不存在直接让测试失败） */
function nodeOf(document: WfJsonDocument, id: string): WfNode {
  const node = findNode(document, id);
  assert.ok(node, `节点 ${id} 应当存在`);
  return node;
}

describe("appendChildNode · 添加子节点", () => {
  test("默认值：status=todo / progress=0 / children=[] / startAt=now / 无 noteAnchor / 无 statusHistory", () => {
    const document = clone(validDocument());
    const result = appendChildNode(document, ROOT_ID, { title: "  新子任务  " }, NOW);

    assert.equal(result.ok, true);
    assert.deepEqual(result.warnings, []);
    const root = nodeOf(document, ROOT_ID);
    assert.equal(root.children.length, 3);
    const child = root.children[2];
    assert.ok(result.childId);
    assert.equal(child.id, result.childId);
    assert.equal(child.title, "新子任务");
    assert.equal(child.status, "todo");
    assert.equal(child.progress, 0);
    assert.deepEqual(child.children, []);
    assert.equal(child.collapsed, false);
    assert.equal(child.startAt, AT);
    assert.equal(child.updatedAt, AT);
    assert.equal("noteAnchor" in child, false, "Phase 27：纪要段已弃用，不再生成 noteAnchor");
    assert.equal(child.statusHistory, undefined);
    assert.equal(child.completedAt, undefined);
    assert.deepEqual(result.changedNodeIds, [ROOT_ID, child.id]);
    assert.equal(root.updatedAt, AT);
  });

  test("importance / tags 透传（空 tags 不写，避免脏字段）", () => {
    const document = clone(validDocument());
    appendChildNode(document, CHILD_ID, { title: "带属性的子节点", importance: 5, tags: ["验证"] }, NOW);
    appendChildNode(document, CHILD_ID, { title: "空标签", tags: [] }, NOW);

    const children = nodeOf(document, CHILD_ID).children;
    assert.equal(children[0].importance, 5);
    assert.deepEqual(children[0].tags, ["验证"]);
    assert.equal(children[1].tags, undefined);
  });

  test("Phase 9：owner / dueAt / progress / progress_max 透传到新节点", () => {
    const document = clone(validDocument());
    appendChildNode(
      document,
      CHILD_ID,
      { title: "带负责人与截止日", owner: "  张三 ", dueAt: "2026-10-30T00:00:00", progress: 2, progress_max: 5 },
      NOW,
    );

    const child = nodeOf(document, CHILD_ID).children.at(-1);
    assert.ok(child);
    assert.equal(child.owner, "张三");
    assert.equal(child.dueAt, "2026-10-30T00:00:00");
    assert.equal(child.progress, 2);
    assert.equal(child.progress_max, 5);
  });

  test("Phase 34：父节点设置过 linkDir → 新子节点继承；父节点没有 → 不写该键", () => {
    const document = clone(validDocument());
    const root = nodeOf(document, ROOT_ID);
    assert.equal("linkDir" in root, false, "样例节点本来没有这个键");

    const plain = appendChildNode(document, ROOT_ID, { title: "无目录的子节点" }, NOW);
    assert.ok(plain.childId);
    assert.equal("linkDir" in nodeOf(document, plain.childId), false, "父节点没设置 → 子节点也不写");

    root.linkDir = "资料/读书计划";
    const inherited = appendChildNode(document, ROOT_ID, { title: "继承目录的子节点" }, NOW);
    assert.ok(inherited.childId);
    assert.equal(nodeOf(document, inherited.childId).linkDir, "资料/读书计划");
  });

  test("标题为空 / 含换行 → ok=false，文档不动", () => {
    const document = clone(validDocument());
    const before = JSON.stringify(document);

    const empty = appendChildNode(document, ROOT_ID, { title: "   " }, NOW);
    const multiline = appendChildNode(document, ROOT_ID, { title: "第一行\n第二行" }, NOW);

    assert.equal(empty.ok, false);
    assert.equal(empty.reason, "标题不能为空");
    assert.equal(multiline.ok, false);
    assert.equal(multiline.reason, "标题不能包含换行符");
    assert.equal(JSON.stringify(document), before);
  });

  test("标题含 # / | / [ / ] → 允许写入但给出提示", () => {
    const document = clone(validDocument());
    const result = appendChildNode(document, ROOT_ID, { title: "任务 #1 [草稿]" }, NOW);

    assert.equal(result.ok, true);
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes("#"));
  });

  test("父节点不存在 → ok=false", () => {
    const document = clone(validDocument());
    const result = appendChildNode(document, "nd-missing", { title: "孤儿" }, NOW);

    assert.equal(result.ok, false);
    assert.ok(result.reason?.includes("nd-missing"));
    assert.deepEqual(result.changedNodeIds, []);
  });

  test("写回链路：新节点落盘 + 正文自动补出纪要段落", () => {
    const markdown = validMarkdown();
    let childId: string | undefined;
    const result = applyMutation(
      markdown,
      (document) => {
        const edit = appendChildNode(document, ROOT_ID, { title: "新子任务" }, NOW);
        if (!edit.ok) return { reject: edit.reason };
        childId = edit.childId;
        return { changedNodeIds: edit.changedNodeIds };
      },
      { now: NOW },
    );

    assert.equal(result.success, true);
    assert.equal(result.analysis.hasError, false);
    assert.ok(childId);
    assert.deepEqual(result.changedNodeIds, [ROOT_ID, childId]);
    assert.equal(result.markdown.includes(`"id": "${childId}"`), true);
    // Phase 27：不再补纪要段（正文原样不动），`addedAnchors` 恒为空
    assert.deepEqual(result.addedAnchors, []);
    assert.equal(result.markdown.includes("### 新子任务"), false, "正文不再补段落");
    assert.ok(result.markdown.includes("### 整理结论 ^nd-uuid-002"), "旧格式标题段原样保留");
  });
});

describe("editNodeLinks · 编辑资源列表", () => {
  test("整表替换 + 刷新 updatedAt + 上报受影响节点", () => {
    const document = clone(validDocument());
    const result = editNodeLinks(document, ROOT_ID, [{ id: "lk-new", type: "web", target: "https://example.org" }], NOW);

    assert.equal(result.ok, true);
    assert.deepEqual(result.changedNodeIds, [ROOT_ID]);
    const root = nodeOf(document, ROOT_ID);
    assert.deepEqual(root.links, [{ id: "lk-new", type: "web", target: "https://example.org" }]);
    assert.equal(root.updatedAt, AT);
    // 其它节点不受影响
    assert.equal(nodeOf(document, CHILD_ID).updatedAt, undefined);
  });

  test("只保留 schema 白名单字段（未知键被丢掉，避免写回被 Schema 拒）", () => {
    const document = clone(validDocument());
    const dirty = { id: "lk-x", type: "md", target: "某笔记", label: "标签", extra: "不该出现" };
    editNodeLinks(document, ROOT_ID, [dirty as never], NOW);

    const link = nodeOf(document, ROOT_ID).links?.[0];
    assert.deepEqual(link, { id: "lk-x", type: "md", target: "某笔记", label: "标签" });
  });

  test("节点不存在 → ok=false，文档不动", () => {
    const document = clone(validDocument());
    const before = JSON.stringify(document);
    const result = editNodeLinks(document, "nd-missing", [], NOW);

    assert.equal(result.ok, false);
    assert.ok(result.reason?.includes("nd-missing"));
    assert.deepEqual(result.changedNodeIds, []);
    assert.equal(JSON.stringify(document), before);
  });

  test("内容与现状一致 → unchanged=true、文档一动不动（避免无意义写盘）", () => {
    const document = clone(validDocument());
    const current = nodeOf(document, ROOT_ID).links ?? [];
    const before = JSON.stringify(document);

    const result = editNodeLinks(document, ROOT_ID, current, NOW);

    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
    assert.deepEqual(result.changedNodeIds, []);
    assert.equal(JSON.stringify(document), before);
  });

  test("写回链路：links[] 不再迁进正文（Phase 27），原样留在 JSON 里", () => {
    const result = applyMutation(
      validMarkdown(),
      (document) => {
        const edit = editNodeLinks(document, CHILD_ID, [{ id: "lk-new", type: "image", target: "截图.png" }], NOW);
        if (!edit.ok) return { reject: edit.reason };
        return { changedNodeIds: edit.changedNodeIds };
      },
      { now: NOW },
    );

    assert.equal(result.success, true);
    assert.equal(result.changed, true);
    assert.deepEqual(result.changedNodeIds, [CHILD_ID]);
    assert.equal(result.analysis.hasError, false);
    // 纪要段范式弃用：链接留在 JSON（`links[]` 仍是 schema 里的字段），正文不动
    assert.ok(result.markdown.includes('"links"'));
    assert.ok(result.markdown.includes("lk-new"));
    assert.equal(result.markdown.includes("- ![[截图.png]]"), false);
    assert.deepEqual(result.migratedLinkNodeIds, []);
  });

  test("写回链路：重复 link id 原样落盘（不再迁进正文 → 不会因迁移失败而回滚）", () => {
    const markdown = validMarkdown();
    const result = applyMutation(
      markdown,
      (document) => {
        const edit = editNodeLinks(
          document,
          ROOT_ID,
          [
            { id: "lk-dup", type: "md", target: "A" },
            { id: "lk-dup", type: "md", target: "B" },
          ],
          NOW,
        );
        if (!edit.ok) return { reject: edit.reason };
        return { changedNodeIds: edit.changedNodeIds };
      },
      { now: NOW },
    );

    assert.equal(result.success, true);
    assert.equal(result.changed, true);
    assert.equal(result.markdown.includes("- [[A]]"), false, "正文不再承载链接");
    assert.equal((result.markdown.match(/"lk-dup"/g) ?? []).length >= 1, true, "链接原样留在 JSON");
  });
});

describe("removeNode · 删除本节点", () => {
  test("摊平规则：links 不上移 / children 原位替换 / relations 上移并过滤 / 不合并正文", () => {
    const document = clone(validDocument());
    const root = nodeOf(document, ROOT_ID);
    const target = nodeOf(document, CHILD_ID);
    const moved = nodeOf(document, DOING_ID);
    root.children = root.children.filter((child) => child.id !== DOING_ID);
    target.children = [moved];
    target.links = [
      { id: "lk-1", type: "md", target: "竞品分析报告" },
      { id: "lk-9", type: "web", target: "https://child.example", label: "子链接" },
    ];
    target.relations = [
      { target: DOING_ID, kind: "dependsOn" }, // 上移到父节点
      { target: ROOT_ID, kind: "related" }, // 上移后会变成「依赖自身」→ 过滤
    ];
    target.completedAt = "2026-10-06T12:00:00+08:00";
    const completedBefore = root.completedAt;

    const result = removeNode(document, CHILD_ID, NOW);

    assert.equal(result.ok, true);
    assert.equal(result.parentId, ROOT_ID);
    assert.deepEqual(result.changedNodeIds, [ROOT_ID, DOING_ID]);
    assert.deepEqual(result.removedNoteAnchors, ["^nd-uuid-002"]);
    assert.equal(findNode(document, CHILD_ID), undefined);
    assert.deepEqual(root.children.map((child) => child.id), [DOING_ID]);
    // Phase 9 / 27：links 不上移、也不再「合并进父段」——`mergeNoteSections` 恒为空数组
    assert.deepEqual(root.links?.map((link) => link.id), ["lk-1", "lk-2", "lk-3"]);
    assert.deepEqual(result.mergeNoteSections, []);
    assert.deepEqual(root.relations, [
      { target: WF2_ID, kind: "related", note: "与实现方案工作流相关" },
      { target: DOING_ID, kind: "dependsOn" },
    ]);
    assert.equal(root.updatedAt, AT);
    assert.equal(root.completedAt, completedBefore);
  });

  test("Phase 9：mergeNoteSection=false → 不合并超链接，只删本段", () => {
    const document = clone(validDocument());
    const target = nodeOf(document, CHILD_ID);
    target.links = [{ id: "lk-1", type: "web", target: "https://child.example" }];

    const result = removeNode(document, CHILD_ID, NOW, { mergeNoteSection: false });

    assert.equal(result.ok, true);
    assert.deepEqual(result.removedNoteAnchors, ["^nd-uuid-002"]);
    assert.deepEqual(result.mergeNoteSections, []);
    assert.equal(findNode(document, CHILD_ID), undefined, "节点仍要删掉");
  });

  test("根节点 → 拒绝", () => {
    const document = clone(validDocument());
    const before = JSON.stringify(document);
    const result = removeNode(document, ROOT_ID, NOW);

    assert.equal(result.ok, false);
    assert.ok(result.reason?.includes("根节点"));
    assert.equal(JSON.stringify(document), before);
  });

  test("带 archive 的浓缩节点 → 拒绝（v1.3）", () => {
    const document = clone(validDocument());
    const target = nodeOf(document, CHILD_ID) as unknown as { archive?: unknown };
    target.archive = { archivedAt: "2026-10-10T12:00:00+08:00" };
    const result = removeNode(document, CHILD_ID, NOW);

    assert.equal(result.ok, false);
    assert.ok(result.reason?.includes("归档来源"));
    assert.ok(findNode(document, CHILD_ID));
  });

  test("节点不存在 → 拒绝", () => {
    const document = clone(validDocument());
    const result = removeNode(document, "nd-missing", NOW);

    assert.equal(result.ok, false);
    assert.deepEqual(result.changedNodeIds, []);
  });

  test("计时条目并入父节点（v1.3：按原顺序附在父节点条目之后）", () => {
    const document = clone(validDocument13());
    const root = nodeOf(document, ROOT_ID);
    assert.deepEqual(root.timeEntries?.map((entry) => entry.hours), [2.5, 6]);

    const result = removeNode(document, DOING_ID, NOW);

    assert.equal(result.ok, true);
    assert.deepEqual(root.timeEntries?.map((entry) => entry.hours), [2.5, 6, 1], "被删节点的条目附在后面，父节点原有的不动");
  });

  test("写回链路：叶子节点删除 → 代码块清掉、旧格式正文段落原样保留（Phase 27 不删无标志段）", () => {
    const document = clone(validDocument());
    nodeOf(document, CHILD_ID).links = [{ id: "lk-x", type: "md", target: "被删节点的资料" }];
    const markdown = validMarkdown(document);
    const result = applyMutation(
      markdown,
      (doc) => {
        const edit = removeNode(doc, CHILD_ID, NOW);
        if (!edit.ok) return { reject: edit.reason };
        return {
          changedNodeIds: edit.changedNodeIds,
          removedNoteAnchors: edit.removedNoteAnchors,
          mergeNoteSections: edit.mergeNoteSections,
        };
      },
      { now: NOW },
    );

    assert.equal(result.success, true);
    assert.equal(result.changed, true);
    assert.equal(result.analysis.hasError, false);
    assert.deepEqual(result.changedNodeIds, [ROOT_ID]);
    // 旧格式「标题边界段」没有机器边界 → 不做清理（契约 §5.3：删了会吃掉用户正文）
    assert.deepEqual(result.removedAnchors, []);
    assert.ok(result.markdown.includes("### 整理结论 ^nd-uuid-002"), "旧格式标题段原样保留");
    assert.equal(result.markdown.includes('"id": "nd-uuid-002"'), false, "JSON 代码块里的节点已删");
    // links[] 随节点一起消失，不再往父节点正文里合并
    assert.equal(result.markdown.includes("被删节点的资料"), false);
    // 兄弟节点原样保留
    assert.ok(result.markdown.includes("### 交叉验证 ^nd-uuid-003"));
  });

  test("写回链路：中间层删除 → 子节点上移且段落不丢", () => {
    const document = clone(validDocument());
    const root = nodeOf(document, ROOT_ID);
    const moved = nodeOf(document, DOING_ID);
    root.children = root.children.filter((child) => child.id !== DOING_ID);
    nodeOf(document, CHILD_ID).children = [moved];
    const markdown = validMarkdown(document);
    assert.equal(analyzeMarkdown(markdown).hasError, false);

    const result = applyMutation(
      markdown,
      (doc) => {
        const edit = removeNode(doc, CHILD_ID, NOW);
        if (!edit.ok) return { reject: edit.reason };
        return {
          changedNodeIds: edit.changedNodeIds,
          removedNoteAnchors: edit.removedNoteAnchors,
          mergeNoteSections: edit.mergeNoteSections,
        };
      },
      { now: NOW },
    );

    assert.equal(result.success, true);
    assert.equal(result.analysis.hasError, false);
    assert.deepEqual(result.changedNodeIds, [ROOT_ID, DOING_ID]);
    assert.deepEqual(result.removedAnchors, [], "旧格式标题段不删（Phase 27 §5.3）");
    assert.ok(result.markdown.includes("### 整理结论 ^nd-uuid-002"), "正文段落原样保留");
    assert.ok(result.markdown.includes("### 交叉验证 ^nd-uuid-003"));
    assert.ok(result.markdown.includes(`"id": "${DOING_ID}"`), "子节点上移进 JSON");
  });
});

describe("validateLinksValue · Modal 保存前的就地校验", () => {
  test("合法数组 / 空数组 → 无问题", () => {
    assert.deepEqual(validateLinksValue([]), []);
    assert.deepEqual(
      validateLinksValue([{ id: "lk-1", type: "web", target: "https://example.com", role: "source", label: "A", reason: "理由" }]),
      [],
    );
  });

  test("未知字段 / 缺必填 / 枚举越界 → 报错并给出 JSON Pointer", () => {
    const issues = validateLinksValue([
      { id: "lk-1", type: "web", target: "https://example.com", extra: 1 },
      { type: "md", target: "某笔记" },
      { id: "lk-3", type: "nope", target: "某笔记" },
    ]);
    const codes = issues.map((item) => item.code);

    assert.ok(codes.includes("SCHEMA_UNKNOWN_FIELD"));
    assert.ok(codes.includes("SCHEMA_REQUIRED"));
    assert.ok(codes.includes("SCHEMA_ENUM"));
    assert.ok(issues.some((item) => item.path === "/0/extra"));
    assert.ok(issues.some((item) => item.path === "/1/id"));
  });

  test("不是数组 → 类型错误", () => {
    const issues = validateLinksValue({ id: "lk-1" });

    assert.equal(issues.length, 1);
    assert.equal(issues[0].code, "SCHEMA_TYPE");
  });
});

/* ------------------------------------------------------------------ *
 * Phase 5 ②：编辑节点信息（editNodeInfo）
 * 语义：patch 覆盖 / clear 删除 / 其余不动；无变化 → unchanged；刷 node.updatedAt。
 * ------------------------------------------------------------------ */

describe("editNodeInfo · 编辑节点信息（Phase 5 ②）", () => {
  test("patch 覆盖字段（文本 trim）、刷新 updatedAt、changedNodeIds 只报该节点", () => {
    const document = clone(validDocument());
    const node = nodeOf(document, DOING_ID);

    const result = editNodeInfo(
      document,
      DOING_ID,
      {
        title: "  交叉验证（补充） ",
        type: "验证",
        importance: 4,
        urgency: 3,
        progress: 7,
        progress_max: 9,
        owner: " 李四 ",
        dueAt: "2026-10-20",
      },
      [],
      NOW,
    );

    assert.equal(result.ok, true);
    assert.equal(result.unchanged, undefined);
    assert.deepEqual(result.changedNodeIds, [DOING_ID]);
    assert.equal(node.title, "交叉验证（补充）");
    assert.equal(node.type, "验证");
    assert.equal(node.importance, 4);
    assert.equal(node.urgency, 3);
    assert.equal(node.progress, 7);
    assert.equal(node.progress_max, 9);
    assert.equal(node.owner, "李四");
    assert.equal(node.dueAt, "2026-10-20");
    assert.equal(node.updatedAt, AT);
  });

  test("空串 patch = 删键（不写空串）；clear 删键；同一字段 patch 赢过 clear", () => {
    const document = clone(validDocument());
    const root = nodeOf(document, ROOT_ID);
    // Phase 45：节点 summary 已废弃 —— 这张表不再碰它（旧值原样保留）
    assert.equal(root.summary, "对比三家竞品的功能与定价");

    editNodeInfo(document, ROOT_ID, { type: "   " }, ["owner"], NOW);

    assert.equal("type" in root, false, "trim 后为空 → 删键（Schema 的 TEXT 是 minLength 1）");
    assert.equal("owner" in root, false);
    assert.equal(root.summary, "对比三家竞品的功能与定价", "废弃字段不再被编辑 / 清除");

    editNodeInfo(document, ROOT_ID, { dueAt: "2026-12-31" }, ["dueAt"], NOW);
    assert.equal(root.dueAt, "2026-12-31", "patch 与 clear 同时出现时 patch 赢");
  });

  test("与现状完全一致 → unchanged=true，updatedAt 不动", () => {
    const document = clone(validDocument());
    const root = nodeOf(document, ROOT_ID);
    const updatedAt = root.updatedAt;

    const result = editNodeInfo(
      document,
      ROOT_ID,
      { importance: root.importance, progress: root.progress, progress_max: root.progress_max, owner: root.owner },
      [],
      NOW,
    );

    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
    assert.deepEqual(result.changedNodeIds, []);
    assert.equal(root.updatedAt, updatedAt, "无实际变化不刷 updatedAt");
  });

  test("非法值（越界 / 非整数 / 日期不存在 / 空标题）→ ok=false + 中文原因，文档一动不动", () => {
    const document = clone(validDocument());
    const before = JSON.stringify(document);

    assert.match(editNodeInfo(document, ROOT_ID, { importance: 0 }, [], NOW).reason ?? "", /重要度必须在 1-4 之间/);
    assert.match(editNodeInfo(document, ROOT_ID, { progress: -1 }, [], NOW).reason ?? "", /已完成必须在 0-999 之间/);
    assert.match(editNodeInfo(document, ROOT_ID, { progress_max: 1000 }, [], NOW).reason ?? "", /总量必须在 0-999 之间/);
    assert.match(editNodeInfo(document, ROOT_ID, { importance: 2.5 }, [], NOW).reason ?? "", /必须是整数/);
    assert.match(editNodeInfo(document, ROOT_ID, { dueAt: "2026-02-30" }, [], NOW).reason ?? "", /ISO8601/);
    assert.match(editNodeInfo(document, ROOT_ID, { title: "   " }, [], NOW).reason ?? "", /标题不能为空/);

    assert.equal(JSON.stringify(document), before);
  });

  test("v1.6：progress 与 status 解耦 —— done 可改 4、doing 可改 0、progress 可大于 progress_max", () => {
    const document = clone(validDocument());

    assert.equal(editNodeInfo(document, ROOT_ID, { progress: 4 }, [], NOW).ok, true);
    assert.equal(editNodeInfo(document, CHILD_ID, { progress: 5 }, [], NOW).ok, true);
    assert.equal(editNodeInfo(document, DOING_ID, { progress: 0 }, [], NOW).ok, true);
    assert.equal(editNodeInfo(document, DOING_ID, { progress: 12, progress_max: 3 }, [], NOW).ok, true);
  });

  test("clear 列表里的 title 会被忽略（必填字段不清空）", () => {
    const document = clone(validDocument());
    const root = nodeOf(document, ROOT_ID);
    const title = root.title;

    const result = editNodeInfo(document, ROOT_ID, {}, ["title"], NOW);
    assert.equal(result.ok, true);
    assert.equal(root.title, title);
  });

  test("节点不存在 → ok=false（不抛错）", () => {
    const document = clone(validDocument());
    const result = editNodeInfo(document, "nd-missing", { owner: "李四" }, [], NOW);

    assert.equal(result.ok, false);
    assert.deepEqual(result.changedNodeIds, []);
    assert.ok(result.reason?.includes("不存在"));
  });

  test("validateNodeInfoPatch：空 patch / 空串 dueAt（= 清空）都不算错", () => {
    assert.equal(validateNodeInfoPatch({}), undefined);
    assert.equal(validateNodeInfoPatch({ dueAt: "   " }), undefined, "空串走 clear 语义，不在这里报错");
    assert.equal(validateNodeInfoPatch({ dueAt: "2026-10-20T18:00:00+08:00" }), undefined);
    assert.match(validateNodeInfoPatch({ progress: -1 }) ?? "", /已完成必须在 0-999 之间/);
  });

  test("写回链路：改字段 → 代码块写回、零 error", () => {
    const result = applyMutation(
      validMarkdown11(),
      (document) => {
        const edit = editNodeInfo(document, ROOT_ID, { type: "资料", owner: "李四" }, [], NOW);
        if (!edit.ok) return { reject: edit.reason };
        return { changedNodeIds: edit.changedNodeIds };
      },
      { now: NOW },
    );

    assert.equal(result.success, true);
    assert.equal(result.changed, true);
    assert.equal(result.analysis.hasError, false);
    assert.deepEqual(result.changedNodeIds, [ROOT_ID]);
    assert.ok(result.markdown.includes("李四"));
  });
});

describe("editNodeNote · note 卡片（Phase 20）", () => {
  test("条目 + visible:true → 逐条 trim、丢空行，写 note / noteVisible，刷新 updatedAt", () => {
    const document = clone(validDocument());
    const node = nodeOf(document, DOING_ID);

    const result = editNodeNote(
      document,
      DOING_ID,
      {
        items: [
          { text: "  先截 3 家的定价页  " },
          { text: "   " },
          { text: "再补对比表", done: false },
          { text: "归档成 md", done: true },
        ],
        visible: true,
      },
      NOW,
    );

    assert.equal(result.ok, true);
    assert.equal(result.unchanged, undefined);
    assert.deepEqual(result.changedNodeIds, [DOING_ID]);
    assert.deepEqual(
      node.note,
      [
        { text: "先截 3 家的定价页" },
        { text: "再补对比表", done: false },
        { text: "归档成 md", done: true },
      ],
      "trim 后空行丢弃，done 三态原样保留",
    );
    assert.equal(node.noteVisible, true);
    assert.equal(node.updatedAt, AT);
  });

  test("visible:false → 只写 note，noteVisible 键不出现（不写 false）", () => {
    const document = clone(validDocument());
    const node = nodeOf(document, ROOT_ID);

    const result = editNodeNote(
      document,
      ROOT_ID,
      { items: [{ text: "等第 4 位受访者确认时间" }], visible: false },
      NOW,
    );

    assert.equal(result.ok, true);
    assert.deepEqual(result.changedNodeIds, [ROOT_ID]);
    assert.deepEqual(node.note, [{ text: "等第 4 位受访者确认时间" }], "文字条目不带 done 键");
    assert.equal("done" in (node.note?.[0] ?? {}), false);
    assert.equal("noteVisible" in node, false, "OFF 即默认值 → 删键");
  });

  test("关掉开关不丢条目：noteVisible 从 true 改 false，note 原样保留", () => {
    const document = clone(validDocument());
    const node = nodeOf(document, CHILD_ID);
    node.note = [{ text: "先看图再写结论", done: false }];
    node.noteVisible = true;

    const result = editNodeNote(
      document,
      CHILD_ID,
      { items: [{ text: "先看图再写结论", done: false }], visible: false },
      NOW,
    );

    assert.equal(result.ok, true);
    assert.equal(result.unchanged, undefined, "开关变了就是改动");
    assert.deepEqual(node.note, [{ text: "先看图再写结论", done: false }], "条目不因关掉开关而丢");
    assert.equal("noteVisible" in node, false);
  });

  test("空条目 / 只剩空白行 → 两键一并删除；本来就没有 → unchanged", () => {
    const document = clone(validDocument());
    const node = nodeOf(document, CHILD_ID);

    // 本来两个键都没有
    const untouched = editNodeNote(document, CHILD_ID, { items: [{ text: "   " }], visible: true }, NOW);
    assert.equal(untouched.ok, true);
    assert.equal(untouched.unchanged, true);
    assert.deepEqual(untouched.changedNodeIds, []);
    assert.equal("note" in node, false);
    assert.equal("noteVisible" in node, false);

    // 有内容 → 清空
    editNodeNote(document, CHILD_ID, { items: [{ text: "待补截图" }], visible: true }, NOW);
    assert.deepEqual(node.note, [{ text: "待补截图" }]);
    const cleared = editNodeNote(document, CHILD_ID, { items: [], visible: true }, NOW);
    assert.equal(cleared.ok, true);
    assert.equal(cleared.unchanged, undefined);
    assert.equal("note" in node, false, "空数组 → 删键（Schema 的 noteItem.text 是 minLength 1）");
    assert.equal("noteVisible" in node, false, "条目没了，开关也不留");
  });

  test("与原值完全相同（首尾空白 / 空行差异不算改）→ unchanged=true，updatedAt 不动", () => {
    const document = clone(validDocument());
    const node = nodeOf(document, ROOT_ID);
    node.note = [{ text: "补一份竞品截图清单" }];
    node.noteVisible = true;
    const updatedAt = node.updatedAt;

    const result = editNodeNote(
      document,
      ROOT_ID,
      { items: [{ text: "  补一份竞品截图清单  " }, { text: "" }], visible: true },
      NOW,
    );

    assert.equal(result.ok, true);
    assert.equal(result.unchanged, true);
    assert.deepEqual(result.changedNodeIds, []);
    assert.equal(node.updatedAt, updatedAt, "无实际变化不刷 updatedAt");
  });

  test("节点不存在 → ok=false + 中文原因，文档一动不动", () => {
    const document = clone(validDocument());
    const before = JSON.stringify(document);

    const result = editNodeNote(document, "nd-nope", { items: [{ text: "x" }], visible: true }, NOW);

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /不存在/);
    assert.deepEqual(result.changedNodeIds, []);
    assert.equal(JSON.stringify(document), before);
  });

  test("根节点同样可以带 note（不因 isRoot 被特殊处理）", () => {
    const document = clone(validDocument());
    const root = nodeOf(document, ROOT_ID);

    assert.equal(editNodeNote(document, ROOT_ID, { items: [{ text: "本次调研的总纲" }], visible: true }, NOW).ok, true);
    assert.deepEqual(root.note, [{ text: "本次调研的总纲" }]);
    assert.equal(root.noteVisible, true);
  });

  test("写回链路：note 落盘为数组，done 只在待办 / 已办时写、零 error", () => {
    const result = applyMutation(
      validMarkdown11(),
      (document) => {
        const edit = editNodeNote(
          document,
          ROOT_ID,
          { items: [{ text: "第一行" }, { text: "第二行", done: false }, { text: "第三行", done: true }], visible: true },
          NOW,
        );
        if (!edit.ok) return { reject: edit.reason };
        if (edit.unchanged === true) return { changed: false };
        return { changedNodeIds: edit.changedNodeIds };
      },
      { now: NOW },
    );

    assert.equal(result.success, true);
    assert.equal(result.changed, true);
    assert.equal(result.analysis.hasError, false);
    assert.deepEqual(result.changedNodeIds, [ROOT_ID]);
    assert.ok(result.markdown.includes('"note": ['), "note 落盘为数组");
    assert.ok(result.markdown.includes('"text": "第一行"'), "文字条目只写 text");
    assert.ok(result.markdown.includes('"done": false'), "待办写 false");
    assert.ok(result.markdown.includes('"done": true'), "已办写 true");
    assert.ok(result.markdown.includes('"noteVisible": true'));
  });
});

describe("toggleNodeNoteDone · note 方框点击（Phase 20 修订）", () => {
  test("待办 → 已办：只翻 done，不动 noteVisible，刷 updatedAt", () => {
    const document = clone(validDocument());
    const node = nodeOf(document, DOING_ID);
    node.note = [{ text: "只写文字" }, { text: "待办一", done: false }];
    node.noteVisible = true;

    const result = toggleNodeNoteDone(document, DOING_ID, 1, NOW);

    assert.equal(result.ok, true);
    assert.deepEqual(result.changedNodeIds, [DOING_ID]);
    assert.deepEqual(node.note, [{ text: "只写文字" }, { text: "待办一", done: true }]);
    assert.equal(node.noteVisible, true, "翻一个待办不该顺手把卡片关掉");
    assert.equal(node.updatedAt, AT);
  });

  test("已办 → 待办：写回 false 而不是删键（删了就成了「文字」）", () => {
    const document = clone(validDocument());
    const node = nodeOf(document, CHILD_ID);
    node.note = [{ text: "已办一", done: true }];

    assert.equal(toggleNodeNoteDone(document, CHILD_ID, 0, NOW).ok, true);
    assert.deepEqual(node.note, [{ text: "已办一", done: false }], "false 必须显式保留");
  });

  test("文字条目（done 缺省）→ ok=false + 原因，文档一动不动", () => {
    const document = clone(validDocument());
    const node = nodeOf(document, ROOT_ID);
    node.note = [{ text: "只是说明" }];
    const before = JSON.stringify(node);

    const result = toggleNodeNoteDone(document, ROOT_ID, 0, NOW);

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /文字/);
    assert.deepEqual(result.changedNodeIds, []);
    assert.equal(JSON.stringify(node), before);
  });

  test("下标越界 / 节点不存在 → ok=false + 原因，文档一动不动", () => {
    const document = clone(validDocument());
    const node = nodeOf(document, ROOT_ID);
    node.note = [{ text: "待办一", done: false }];
    const before = JSON.stringify(document);

    const outOfRange = toggleNodeNoteDone(document, ROOT_ID, 5, NOW);
    assert.equal(outOfRange.ok, false);
    assert.match(outOfRange.reason ?? "", /不存在/);

    const noNode = toggleNodeNoteDone(document, "nd-nope", 0, NOW);
    assert.equal(noNode.ok, false);
    assert.match(noNode.reason ?? "", /不存在/);

    assert.equal(JSON.stringify(document), before, "两条拒绝路径都不改文档");
  });
});


describe("setNodeCollapsed · 折叠三角直接改 JSON（Phase 21 ⑤）", () => {
  test("collapsed 缺省 → 收起：显式写 true，刷 updatedAt", () => {
    const document = clone(validDocument());
    const node = nodeOf(document, CHILD_ID);
    delete node.collapsed;

    const result = setNodeCollapsed(document, CHILD_ID, true, NOW);

    assert.equal(result.ok, true);
    assert.deepEqual(result.changedNodeIds, [CHILD_ID]);
    assert.equal(node.collapsed, true);
    assert.equal(node.updatedAt, AT);
  });

  test("true → 展开：写回 false（显式落盘，不删键 —— 与现有 wfjson 块的形状一致）", () => {
    const document = clone(validDocument());
    const node = nodeOf(document, ROOT_ID);
    node.collapsed = true;

    const result = setNodeCollapsed(document, ROOT_ID, false, NOW);

    assert.equal(result.ok, true);
    assert.equal(node.collapsed, false);
    assert.ok(Object.prototype.hasOwnProperty.call(node, "collapsed"), "键必须留着");
  });

  test("与现状一致（缺省 = false / 已经是 true）→ unchanged，文档一字不动", () => {
    const document = clone(validDocument());
    const node = nodeOf(document, CHILD_ID);
    delete node.collapsed;
    const before = JSON.stringify(document);

    const fromDefault = setNodeCollapsed(document, CHILD_ID, false, NOW);
    assert.equal(fromDefault.ok, true);
    assert.equal(fromDefault.unchanged, true);
    assert.deepEqual(fromDefault.changedNodeIds, []);
    assert.equal(JSON.stringify(document), before, "连 updatedAt 都不刷新");

    node.collapsed = true;
    const alreadyTrue = JSON.stringify(document);
    const repeated = setNodeCollapsed(document, CHILD_ID, true, NOW);
    assert.equal(repeated.unchanged, true);
    assert.equal(JSON.stringify(document), alreadyTrue);
  });

  test("节点不存在 → ok=false + 原因，文档一动不动", () => {
    const document = clone(validDocument());
    const before = JSON.stringify(document);

    const result = setNodeCollapsed(document, "nd-nope", true, NOW);

    assert.equal(result.ok, false);
    assert.match(result.reason ?? "", /不存在/);
    assert.deepEqual(result.changedNodeIds, []);
    assert.equal(JSON.stringify(document), before);
  });
});

describe("setNodeLinkDir · 链接文档的默认目录（Phase 34）", () => {
  test("写目录 + 刷新 updatedAt；两侧斜杠 / 反斜杠被归一", () => {
    const document = clone(validDocument());
    const result = setNodeLinkDir(document, CHILD_ID, "  /资料\\读书计划/  ", NOW);

    assert.equal(result.ok, true);
    assert.deepEqual(result.changedNodeIds, [CHILD_ID]);
    const node = nodeOf(document, CHILD_ID);
    assert.equal(node.linkDir, "资料/读书计划");
    assert.equal(node.updatedAt, AT);
  });

  test("空串 = 删键（不写空串）；与现状一致 → unchanged", () => {
    const document = clone(validDocument());
    const node = nodeOf(document, CHILD_ID);
    node.linkDir = "资料/读书计划";

    const same = setNodeLinkDir(document, CHILD_ID, "资料/读书计划", NOW);
    assert.equal(same.ok, true);
    assert.equal(same.unchanged, true);
    assert.deepEqual(same.changedNodeIds, []);

    const cleared = setNodeLinkDir(document, CHILD_ID, "   ", NOW);
    assert.equal(cleared.ok, true);
    assert.equal("linkDir" in node, false, "空串 = 没设置过 → 删键");
  });

  test("非法目录（. / ..）/ 节点不存在 → ok=false，文档一动不动", () => {
    const document = clone(validDocument());
    const before = JSON.stringify(document);

    for (const raw of ["..", "资料/../秘密", "./资料"]) {
      const result = setNodeLinkDir(document, CHILD_ID, raw, NOW);
      assert.equal(result.ok, false, raw);
      assert.match(result.reason ?? "", /目录不合法/);
    }

    const missing = setNodeLinkDir(document, "nd-nope", "资料", NOW);
    assert.equal(missing.ok, false);
    assert.deepEqual(missing.changedNodeIds, []);
    assert.equal(JSON.stringify(document), before);
  });

  test("normalizeNodeLinkDir：归一 + 拒绝相对段（导出给插件层复用）", () => {
    assert.equal(normalizeNodeLinkDir(""), "");
    assert.equal(normalizeNodeLinkDir("   "), "");
    assert.equal(normalizeNodeLinkDir("/a//b/"), "a/b");
    assert.equal(normalizeNodeLinkDir("a\\b"), "a/b");
    assert.equal(normalizeNodeLinkDir("a/./b"), undefined);
    assert.equal(normalizeNodeLinkDir("../a"), undefined);
    assert.equal(normalizeNodeLinkDir("资料/a:b"), undefined, "文件系统禁用字符也拒绝");
  });
});


