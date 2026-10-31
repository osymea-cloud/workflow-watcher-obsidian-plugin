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
import { appendChildNode, editNodeInfo, editNodeLinks, removeNode, validateNodeInfoPatch } from "./nodeEdits.ts";
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
  test("默认值：status=todo / progress=0 / children=[] / startAt=now / 锚点=^id / 无 statusHistory", () => {
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
    assert.equal(child.noteAnchor, `^${child.id}`);
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
    assert.equal(result.markdown.includes(`### 新子任务 ^${childId}`), true);
    assert.deepEqual(result.addedAnchors, [`^${childId}`]);
    // 段落追加在文件末尾（writeBackDocument：先删后补，补的段落一律 append）
    assert.ok(result.markdown.indexOf(`### 新子任务 ^${childId}`) > result.markdown.indexOf("```wfjson"));
    assert.ok(result.markdown.includes("（纪要待补充）"));
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

  test("写回链路：links 已弃用 → 自动迁进正文纪要段并从 JSON 删除", () => {
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
    // 新链接落到正文纪要段（图片语法），JSON 里不再有 links / link id
    assert.ok(result.markdown.includes("- ![[截图.png]]"));
    assert.equal(result.markdown.includes('"links"'), false);
    assert.equal(result.markdown.includes("lk-new"), false);
    assert.ok(result.migratedLinkNodeIds.includes(CHILD_ID));
  });

  test("写回链路：重复 link id 不再拦写回（links 读时忽略）→ 两行都迁进正文", () => {
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
    assert.equal(result.analysis.hasError, false);
    assert.ok(result.markdown.includes("- [[A]]"));
    assert.ok(result.markdown.includes("- [[B]]"));
    assert.equal(result.markdown.includes('"links"'), false);
  });
});

describe("removeNode · 删除本节点", () => {
  test("摊平规则：links 不上移 / children 原位替换 / relations 上移并过滤 / 超链接并入父段", () => {
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
    // Phase 9：links 已弃用 → 不再并进 parent.links，改为上报「合并进父段」
    assert.deepEqual(root.links?.map((link) => link.id), ["lk-1", "lk-2", "lk-3"]);
    assert.deepEqual(result.mergeNoteSections, [
      {
        sourceAnchor: "^nd-uuid-002",
        targetNodeId: ROOT_ID,
        lines: ["- [[竞品分析报告]]", "- [子链接](https://child.example)"],
      },
    ]);
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

  test("写回链路：叶子节点删除 → 代码块与正文段落同时清掉，未迁移的超链接并进父段", () => {
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
    assert.deepEqual(result.removedAnchors, ["^nd-uuid-002"]);
    assert.equal(result.markdown.includes("nd-uuid-002"), false);
    assert.equal(result.markdown.includes("### 整理结论"), false);
    // 超链接没有随段落消失：并进父节点纪要段
    assert.ok(result.markdown.includes("- [[被删节点的资料]]"));
    assert.ok(getNoteSectionContent(result.markdown, ROOT_ID)?.includes("- [[被删节点的资料]]"));
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
    assert.deepEqual(result.removedAnchors, ["^nd-uuid-002"]);
    assert.equal(result.markdown.includes("^nd-uuid-002"), false);
    assert.ok(result.markdown.includes("### 交叉验证 ^nd-uuid-003"));
    assert.ok(result.markdown.includes(`"id": "${DOING_ID}"`));
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
        summary: "  交叉验证的结论  ",
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
    assert.equal(node.summary, "交叉验证的结论");
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
    assert.equal(root.summary, "对比三家竞品的功能与定价");

    editNodeInfo(document, ROOT_ID, { summary: "   " }, ["type", "owner"], NOW);

    assert.equal("summary" in root, false, "trim 后为空 → 删键（Schema 的 TEXT 是 minLength 1）");
    assert.equal("type" in root, false);
    assert.equal("owner" in root, false);

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
      { summary: root.summary, importance: root.importance, progress: 5, progress_max: 5, owner: root.owner },
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
        const edit = editNodeInfo(document, ROOT_ID, { summary: "三家竞品的对比结论（已更新）", owner: "李四" }, [], NOW);
        if (!edit.ok) return { reject: edit.reason };
        return { changedNodeIds: edit.changedNodeIds };
      },
      { now: NOW },
    );

    assert.equal(result.success, true);
    assert.equal(result.changed, true);
    assert.equal(result.analysis.hasError, false);
    assert.deepEqual(result.changedNodeIds, [ROOT_ID]);
    assert.ok(result.markdown.includes("三家竞品的对比结论（已更新）"));
    assert.ok(result.markdown.includes("李四"));
  });
});

