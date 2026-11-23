/**
 * 一致性检查的单测：id / noteAnchor / 纪要段标志 / status / 时间 / links（已弃用）/ relations / frontmatter。
 *
 * 统一通过 analyzeMarkdown 走完整管线（fixture 本身能过 Schema），
 * 因此 issue 清单里出现的都是「一致性层」的问题。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { aggregateNodeStatus, aggregateStatus, checkConsistency, findDependencyCycles, workflowContribution } from "./consistency.ts";
import { issuesWithCode, type WfIssue } from "./issues.ts";
import { analyzeMarkdown } from "./analyze.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { findBlockAnchors, indexBlockAnchors } from "./markdownScan.ts";
import { flattenNodes } from "./tree.ts";
import {
  DOING_ID,
  ROOT_ID,
  TIME_ROOT_START,
  WF1_ID,
  WF2_ID,
  WF2_ROOT_ID,
  clone,
  leaf,
  validDocument,
  validDocument11,
  validDocument13,
  validMarkdown,
  validMarkdown11,
  validMarkdown13,
  wfjsonBlockOnly,
} from "./testFixtures.ts";
import type { WfJsonDocument, WfNode, WfRelation, WfStatusEvent, WfTimeEntry } from "./types.ts";
import { upsertFrontmatterSummary } from "./wfjsonWrite.ts";

/** 跑完整管线并返回问题清单 */
function run(markdown: string): WfIssue[] {
  return analyzeMarkdown(markdown).issues;
}

/** 改 JSON 后重新生成 md（body/frontmatter 保持与 fixture 一致） */
function withDocument(mutate: (document: WfJsonDocument) => void, bodyEdit?: (markdown: string) => string): string {
  const document = clone(validDocument());
  mutate(document);
  const markdown = validMarkdown(document);
  return bodyEdit ? bodyEdit(markdown) : markdown;
}

/** 直接调一致性层（不走 Schema），用于构造 Schema 之外的数据 */
function checkRaw(document: WfJsonDocument, markdown: string): WfIssue[] {
  const frontmatter = parseFrontmatter(markdown);
  const anchors = indexBlockAnchors(findBlockAnchors(markdown, frontmatter));
  return checkConsistency({ markdown, frontmatter, document, anchors });
}

const codes = (issues: WfIssue[]): string[] => issues.map((item) => item.code);
const rootOf = (document: WfJsonDocument): WfNode => document.workflows[0].root;

/* fixture 的 root 一定带 relations / statusHistory；取出时显式收窄，
   避免「可选字段」在 strict 下被判为 possibly undefined */

function relationsOf(node: WfNode): WfRelation[] {
  assert.ok(node.relations, "fixture 的 root 应带 relations");
  return node.relations;
}

function historyOf(node: WfNode): WfStatusEvent[] {
  assert.ok(node.statusHistory, "fixture 的 root 应带 statusHistory");
  return node.statusHistory;
}

describe("consistency · 基准", () => {
  test("合法样例不产生任何问题", () => {
    assert.deepEqual(run(validMarkdown()), []);
  });

  test("checkConsistency 也可单独调用（同一份数据同样干净）", () => {
    const document = validDocument();
    assert.deepEqual(checkRaw(document, validMarkdown()), []);
  });
});

describe("consistency · id 约定与重复", () => {
  test("前缀不符 → ID_FORMAT（warning）", () => {
    const issues = run(withDocument((doc) => (rootOf(doc).id = "node-uuid-001")));
    const found = issuesWithCode(issues, "ID_FORMAT");
    assert.equal(found.length, 1);
    assert.equal(found[0].severity, "warning");
    assert.equal(found[0].path, "/workflows/0/root/id");
  });

  test("文件 / 工作流 / 节点 id 重复各有专用错误码", () => {
    const duplicateNode = withDocument((doc) => {
      doc.workflows[1].root.id = ROOT_ID;
      doc.workflows[1].root.noteAnchor = `^${ROOT_ID}`;
    });
    assert.equal(issuesWithCode(run(duplicateNode), "DUPLICATE_NODE_ID").length, 1);

    const duplicateWorkflow = withDocument((doc) => (doc.workflows[1].id = WF1_ID));
    assert.equal(issuesWithCode(run(duplicateWorkflow), "DUPLICATE_WORKFLOW_ID").length, 1);

    // Phase 9：link id 已弃用（links 读时忽略），重复也不再报错
    const duplicateLink = withDocument((doc) => {
      rootOf(doc).children[0].links = [{ id: "lk-1", type: "web", target: "https://example.com" }];
    });
    assert.equal(issuesWithCode(run(duplicateLink), "DUPLICATE_LINK_ID").length, 0);
  });

  test("工作流 id 前缀写错也会报 ID_FORMAT", () => {
    const issues = run(withDocument((doc) => (doc.workflows[0].id = "flow-uuid-001")));
    const found = issuesWithCode(issues, "ID_FORMAT");
    assert.equal(found.length, 1);
    assert.equal(found[0].path, "/workflows/0/id");
  });
});

describe("consistency · noteAnchor ↔ 正文锚点（Phase 27 已弃用）", () => {
  test("正文缺锚点 / 锚点重复都不再报问题", () => {
    // 旧格式：标题行带 `^id` 锚点 —— Phase 27 起正文不再绑定节点，这些都只是普通文字
    const missing = withDocument(
      () => undefined,
      (text) => text.replace(" ^nd-uuid-003", ""),
    );
    assert.deepEqual(issuesWithCode(run(missing), "NOTE_ANCHOR_MISSING_IN_BODY"), []);

    const duplicated = withDocument(
      () => undefined,
      (text) => `${text.replace(/\n```wfjson/, "\n### 重复段落 ^nd-uuid-003\n\n```wfjson")}`,
    );
    assert.deepEqual(issuesWithCode(run(duplicated), "NOTE_ANCHOR_DUPLICATED_IN_BODY"), []);
  });

  test("残留锚点 / 不规范锚点 / 锚点与 id 不符都不再报问题", () => {
    const orphan = withDocument(
      () => undefined,
      (text) => text.replace("\n```wfjson", "\n### 残留段落 ^nd-uuid-777\n\n```wfjson"),
    );
    assert.deepEqual(issuesWithCode(run(orphan), "ORPHAN_BLOCK_ANCHOR"), []);

    const notOnHeading = withDocument(
      () => undefined,
      (text) =>
        text.replace("## 方案初稿 ^nd-uuid-004", "## 方案初稿").replace("\n```wfjson", "\n段落文字 ^nd-uuid-004\n\n```wfjson"),
    );
    assert.deepEqual(issuesWithCode(run(notOnHeading), "NOTE_ANCHOR_NOT_ON_HEADING"), []);

    const mismatched = run(withDocument((doc) => (doc.workflows[1].root.id = "nd-uuid-006")));
    assert.deepEqual(issuesWithCode(mismatched, "NOTE_ANCHOR_NOT_MATCHING_ID"), []);
  });

  test("wfjson 代码块里的 `^id` 文本更不会被当成锚点", () => {
    const markdown = withDocument((doc) => (rootOf(doc).title = "调研竞品 ^nd-uuid-999"));
    assert.equal(issuesWithCode(run(markdown), "ORPHAN_BLOCK_ANCHOR").length, 0);
  });
});

describe("consistency · status / progress / statusHistory", () => {
  test("v1.6：status 与 progress 解耦，done + progress=4 不再报错", () => {
    const issues = run(withDocument((doc) => (rootOf(doc).progress = 4)));
    assert.equal(issuesWithCode(issues, "STATUS_PROGRESS_MISMATCH").length, 0);
    assert.equal(issuesWithCode(issues, "PROGRESS_STATUS_CONFLICT").length, 0);
  });

  test("v1.6：progress=5 且 status=doing 只留下 statusHistory 不一致", () => {
    const issues = run(
      withDocument((doc) => {
        rootOf(doc).status = "doing";
        rootOf(doc).statusHistory = [{ from: "todo", to: "doing", at: "2026-10-01T09:30:00+08:00" }];
      }),
    );
    assert.equal(issuesWithCode(issues, "STATUS_PROGRESS_MISMATCH").length, 0);
    assert.equal(issuesWithCode(issues, "PROGRESS_STATUS_CONFLICT").length, 0);
  });

  test("v1.6：progress=0 且 status=doing 合法（不再有 PROGRESS_STATUS_CONFLICT）", () => {
    const issues = run(
      withDocument((doc) => {
        rootOf(doc).progress = 0;
        rootOf(doc).status = "doing";
        rootOf(doc).statusHistory = [{ from: "todo", to: "doing", at: "2026-10-01T09:30:00+08:00" }];
        delete rootOf(doc).completedAt;
      }),
    );
    assert.equal(issuesWithCode(issues, "PROGRESS_STATUS_CONFLICT").length, 0);
    assert.equal(issuesWithCode(issues, "STATUS_PROGRESS_MISMATCH").length, 0);
  });

  test("progress > progress_max → PROGRESS_OVER_MAX（info，不拦写回）", () => {
    const issues = run(
      withDocument((doc) => {
        rootOf(doc).progress = 8;
        rootOf(doc).progress_max = 3;
      }),
    );
    const found = issuesWithCode(issues, "PROGRESS_OVER_MAX");
    assert.equal(found.length, 1);
    assert.equal(found[0].severity, "info");
    assert.equal(found[0].path, "/workflows/0/root/progress");
  });

  test("statusHistory 末条与当前 status 不一致 → STATUS_HISTORY_MISMATCH", () => {
    const issues = run(
      withDocument((doc) => {
        historyOf(rootOf(doc)).push({ from: "done", to: "doing", at: "2026-10-06T09:00:00+08:00" });
      }),
    );
    const found = issuesWithCode(issues, "STATUS_HISTORY_MISMATCH");
    assert.equal(found.length, 1);
    assert.equal(found[0].path, "/workflows/0/root/statusHistory");
  });

  test("done 但缺 completedAt → COMPLETED_AT_MISSING", () => {
    const issues = run(withDocument((doc) => delete rootOf(doc).completedAt));
    const found = issuesWithCode(issues, "COMPLETED_AT_MISSING");
    assert.equal(found.length, 1);
    assert.equal(found[0].path, "/workflows/0/root/completedAt");
  });

  test("v1.6：workflow.progress 小于根节点 progress 不再报 PROGRESS_DECREASED", () => {
    const issues = run(withDocument((doc) => (doc.workflows[0].progress = 2)));
    assert.equal(issuesWithCode(issues, "PROGRESS_DECREASED").length, 0);
  });
});

describe("consistency · 时间字段", () => {
  test("不存在的日期（11 月 31 日）→ TIMESTAMP_INVALID", () => {
    const issues = run(withDocument((doc) => (rootOf(doc).dueAt = "2026-11-31T10:00:00+08:00")));
    const found = issuesWithCode(issues, "TIMESTAMP_INVALID");
    assert.equal(found.length, 1);
    assert.equal(found[0].severity, "error");
    assert.equal(found[0].path, "/workflows/0/root/dueAt");
    assert.equal(issuesWithCode(issues, "TIMESTAMP_ORDER").length, 0);
  });

  test("updatedAt 早于 startAt → TIMESTAMP_ORDER", () => {
    const issues = run(withDocument((doc) => (rootOf(doc).updatedAt = "2026-09-01T10:00:00+08:00")));
    const found = issuesWithCode(issues, "TIMESTAMP_ORDER");
    assert.equal(found.length, 1);
    assert.ok(found[0].message.includes("updatedAt 早于 startAt"));
    assert.equal(found[0].path, "/workflows/0/root");
  });

  test("日期与日期时间混用不会误报顺序问题", () => {
    const issues = run(
      withDocument((doc) => {
        rootOf(doc).startAt = "2026-10-01";
        rootOf(doc).updatedAt = "2026-10-05T10:00:00+08:00";
      }),
    );
    assert.equal(issuesWithCode(issues, "TIMESTAMP_ORDER").length, 0);
    assert.equal(issuesWithCode(issues, "TIMESTAMP_INVALID").length, 0);
  });
});

describe("consistency · links（Phase 9 已弃用）", () => {
  test("links[] 读到即忽略：渲染语法 / 类型不匹配 / 重复 id 都不再报问题", () => {
    const issues = run(
      withDocument((doc) => {
        rootOf(doc).links = [
          { id: "lk-dup", type: "md", target: "[[竞品分析报告]]" },
          { id: "lk-dup", type: "web", target: "example.com" },
          { id: "lk-dup", type: "image", target: "竞品截图" },
        ];
      }),
    );
    assert.deepEqual(issues, []);
  });
});

describe("consistency · 正文纪要段标志（Phase 27 已弃用）", () => {
  const appendLines = (lines: string[]) => (markdown: string) => `${markdown}${lines.join("\n")}\n`;

  test("只有开始 / 只有结束标志都不再报问题", () => {
    // 老文件里残留的 `<!-- wf-note:begin:… -->` 只是普通文本，不再是结构约定
    const beginOnly = run(withDocument(() => undefined, appendLines(["<!-- wf-note:begin:nd-uuid-003 -->"])));
    assert.deepEqual(issuesWithCode(beginOnly, "NOTE_SECTION_UNPAIRED"), []);

    const endOnly = run(withDocument(() => undefined, appendLines(["<!-- wf-note:end:nd-uuid-003 -->"])));
    assert.deepEqual(issuesWithCode(endOnly, "NOTE_SECTION_UNPAIRED"), []);
  });

  test("标志嵌套 / id 不一致 / 成对标志都不再报问题", () => {
    const nested = run(
      withDocument(
        () => undefined,
        appendLines([
          "<!-- wf-note:begin:nd-uuid-003 -->",
          "<!-- wf-note:begin:nd-uuid-002 -->",
          "<!-- wf-note:end:nd-uuid-002 -->",
        ]),
      ),
    );
    assert.deepEqual(issuesWithCode(nested, "NOTE_SECTION_NESTED"), []);

    const mismatched = run(
      withDocument(
        () => undefined,
        appendLines(["<!-- wf-note:begin:nd-uuid-003 -->", "<!-- wf-note:end:nd-uuid-002 -->"]),
      ),
    );
    assert.deepEqual(issuesWithCode(mismatched, "NOTE_SECTION_ID_MISMATCH"), []);

    const paired = run(
      withDocument(
        () => undefined,
        appendLines(["<!-- wf-note:begin:nd-uuid-003 -->", "- [[访谈录音]]", "<!-- wf-note:end:nd-uuid-003 -->"]),
      ),
    );
    assert.deepEqual(issuesWithCode(paired, "NOTE_SECTION_UNPAIRED"), []);
  });
});

describe("consistency · relations（v1.6 已删除）", () => {
  test("字段被无视：自依赖 / 未知目标 / 循环都不再产生问题", () => {
    const issues = run(
      withDocument((doc) => {
        relationsOf(rootOf(doc))[0].target = ROOT_ID;
        rootOf(doc).children[0].relations = [{ target: ROOT_ID, kind: "dependsOn" }];
      }),
    );
    assert.equal(issuesWithCode(issues, "RELATION_SELF_DEPENDENCY").length, 0);
    assert.equal(issuesWithCode(issues, "RELATION_TARGET_UNKNOWN").length, 0);
    assert.equal(issuesWithCode(issues, "RELATION_CYCLE").length, 0);
  });

  test("跨文件引用与 related 目标同样不参与校验", () => {
    const issues = run(
      withDocument((doc) => {
        rootOf(doc).relations = [
          { target: "file-uuid-002#nd-uuid-001", kind: "dependsOn" },
          { target: WF2_ID, kind: "related" },
          { target: WF2_ROOT_ID, kind: "related" },
        ];
      }),
    );
    assert.deepEqual(issues, []);
  });
});

describe("consistency · frontmatter 摘要字段", () => {
  test("缺少 wf-* 字段 → FRONTMATTER_FIELD_MISSING", () => {
    const markdown = withDocument(
      () => undefined,
      (text) => text.replace("wf-tags: [竞品]\n", ""),
    );
    const found = issuesWithCode(run(markdown), "FRONTMATTER_FIELD_MISSING");
    assert.equal(found.length, 1);
    assert.ok(found[0].message.includes("wf-tags"));
    assert.ok((found[0].line ?? 0) > 0);
  });

  test("wf-status 与聚合状态不符 → FRONTMATTER_STATUS_MISMATCH", () => {
    const markdown = withDocument(
      () => undefined,
      (text) => text.replace("wf-status: doing", "wf-status: todo"),
    );
    const found = issuesWithCode(run(markdown), "FRONTMATTER_STATUS_MISMATCH");
    assert.equal(found.length, 1);
    assert.equal(found[0].line, 3);
  });

  test("单节点状态改动会体现在聚合值上（wf-status 失配）", () => {
    const issues = run(
      withDocument((doc) => {
        const target = doc.workflows[0].root.children.find((child) => child.id === DOING_ID);
        assert.ok(target);
        target.status = "done";
        target.progress = 5;
        target.completedAt = "2026-10-06T09:00:00+08:00";
      }),
    );
    assert.deepEqual(codes(issues), ["FRONTMATTER_STATUS_MISMATCH"]);
  });

  test("wf-titles 与 workflows[].title 不符 → FRONTMATTER_TITLES_MISMATCH", () => {
    const markdown = withDocument((doc) => (doc.workflows[1].title = "实现方案（改）"));
    const found = issuesWithCode(run(markdown), "FRONTMATTER_TITLES_MISMATCH");
    assert.equal(found.length, 1);
  });

  test("wf-updated 与 updatedAt 的日期部分不符 → FRONTMATTER_UPDATED_MISMATCH", () => {
    const markdown = withDocument(
      () => undefined,
      (text) => text.replace("wf-updated: 2026-10-10", "wf-updated: 2026-10-11"),
    );
    const found = issuesWithCode(run(markdown), "FRONTMATTER_UPDATED_MISMATCH");
    assert.equal(found.length, 1);
    assert.equal(found[0].line, 5);
  });

  test("M1.6 wf-key ↔ noteKey：写回自动一致，抄来的侧车才报 FRONTMATTER_KEY_MISMATCH", () => {
    const document = clone(validDocument());
    document.noteKey = "3f9a1c2b7d";
    const markdown = withDocument((doc) => (doc.noteKey = "3f9a1c2b7d"));

    // 只有 JSON 有 noteKey、frontmatter 还没写 → 不算错（老文件也是这样）
    assert.deepEqual(issuesWithCode(run(markdown), "FRONTMATTER_KEY_MISMATCH"), []);

    // 写回 frontmatter 后两边一致 → 依旧零问题
    const written = upsertFrontmatterSummary(markdown, document).markdown;
    assert.ok(written.includes("wf-key: 3f9a1c2b7d"));
    assert.deepEqual(issuesWithCode(run(written), "FRONTMATTER_KEY_MISMATCH"), []);

    // 抄来别人的 wf-key → 报 warning，行号指到 wf-key 那一行
    const copied = written.replace("wf-key: 3f9a1c2b7d", "wf-key: 0123456789");
    const found = issuesWithCode(run(copied), "FRONTMATTER_KEY_MISMATCH");
    assert.equal(found.length, 1);
    assert.equal(found[0].severity, "warning");
    assert.ok((found[0].line ?? 0) > 0);
  });

  test("没有 frontmatter 时只报缺字段（正文锚点已不参与）", () => {
    const issues = run(wfjsonBlockOnly());
    assert.equal(issuesWithCode(issues, "FRONTMATTER_FIELD_MISSING").length, 1);
    assert.deepEqual(issuesWithCode(issues, "NOTE_ANCHOR_MISSING_IN_BODY"), []);
  });
});

describe("aggregateNodeStatus / findDependencyCycles", () => {
  test("aggregateNodeStatus 的取值规则（v1.0 单步 / 两步聚合的第一步）", () => {
    assert.equal(aggregateNodeStatus([]), "todo");
    assert.equal(aggregateNodeStatus([leaf("nd-a", "a", { status: "done" })]), "done");
    assert.equal(
      aggregateNodeStatus([leaf("nd-a", "a", { status: "done" }), leaf("nd-b", "b", { status: "doing" })]),
      "doing",
    );
    assert.equal(
      aggregateNodeStatus([leaf("nd-a", "a", { status: "todo" }), leaf("nd-b", "b", { status: "blocked" })]),
      "blocked",
    );
    assert.equal(
      aggregateNodeStatus([leaf("nd-a", "a", { status: "cancelled" }), leaf("nd-b", "b", { status: "done" })]),
      "cancelled",
    );
    assert.equal(aggregateNodeStatus([leaf("nd-a", "a"), leaf("nd-b", "b")]), "todo");
  });

  test("findDependencyCycles：无环时为 []，有环时去重", () => {
    assert.deepEqual(findDependencyCycles(new Map([["a", ["b"]], ["b", ["c"]]])), []);

    const two = findDependencyCycles(new Map([["a", ["b"]], ["b", ["a"]]]));
    assert.equal(two.length, 1);
    assert.deepEqual([...two[0]].sort(), ["a", "b"]);

    const three = findDependencyCycles(new Map([["a", ["b"]], ["b", ["c"]], ["c", ["a"]]]));
    assert.equal(three.length, 1);
    assert.equal(three[0].length, 3);

    // 从环上任意一点开始遍历，同一个环只报一次
    const rotated = findDependencyCycles(new Map([["b", ["c"]], ["c", ["a"]], ["a", ["b"]]]));
    assert.equal(rotated.length, 1);
    assert.equal(rotated[0].length, 3);
  });
});

describe("aggregateStatus · v1.1 两步聚合", () => {
  test("全部 workflow 缺省 state 时退化为 v1.0 单步结果（老数据无需改写 wf-status）", () => {
    const document = validDocument();
    assert.equal(aggregateStatus(document), aggregateNodeStatus(flattenNodes(document)));
    assert.equal(aggregateStatus(document), "doing");
  });

  test("state=archived → 贡献 done（与节点是否做完无关）", () => {
    const document = clone(validDocument());
    document.workflows[1].state = "archived";
    document.workflows[1].root.status = "todo";

    assert.equal(workflowContribution(document.workflows[1]), "done");
    // 另一个 workflow 里有 doing → 文件级仍是 doing
    assert.equal(aggregateStatus(document), "doing");
  });

  test("合并优先级 doing > blocked > todo > cancelled > done", () => {
    const document = clone(validDocument11());
    document.workflows[1].state = "cancelled";
    assert.equal(aggregateStatus(document), "cancelled"); // 另一 workflow 贡献 done

    document.workflows[0].root.children[0].status = "todo";
    assert.equal(aggregateStatus(document), "todo");

    document.workflows[0].root.children[1].status = "blocked";
    assert.equal(aggregateStatus(document), "blocked");

    document.workflows[0].root.status = "doing";
    assert.equal(aggregateStatus(document), "doing");
  });

  test("1.1 样例（1 全 done + 1 archived）走完整管线零问题", () => {
    assert.deepEqual(run(validMarkdown11()), []);
    assert.equal(aggregateStatus(validDocument11()), "done");
  });

  test("wf-status 与两步聚合不一致 → FRONTMATTER_STATUS_MISMATCH", () => {
    const markdown = validMarkdown11().replace("wf-status: done", "wf-status: doing");
    const found = issuesWithCode(run(markdown), "FRONTMATTER_STATUS_MISMATCH");

    assert.equal(found.length, 1);
    assert.match(found[0].message, /按 JSON 聚合应为 done/);
  });
});

describe("consistency · 计时条目（v1.3 的 TIME_* 规则）", () => {
  /** 只保留 TIME_* 一族问题（用 wfjsonBlockOnly 造文本时还会有别的告警，不在此关心） */
  const timeIssues = (issues: WfIssue[]): WfIssue[] => issues.filter((item) => item.code.startsWith("TIME_"));
  const codesOf = (issues: WfIssue[]): string[] => timeIssues(issues).map((item) => item.code);

  /** 改一条计时条目后走完整管线（要求改完仍能过 Schema，否则管线会提前返回） */
  const runWithEntry = (entry: WfTimeEntry, index = 0): WfIssue[] => {
    const document = clone(validDocument13());
    rootOf(document).timeEntries![index] = entry;
    return run(wfjsonBlockOnly(document));
  };

  test("1.3 样例（含计时 + 归档）走完整管线零问题", () => {
    assert.deepEqual(run(validMarkdown13()), []);
    assert.deepEqual(timeIssues(run(validMarkdown13())), []);
  });

  test("进行中的条目（无 endAt / hours）不是问题", () => {
    const document = clone(validDocument13());
    rootOf(document).timeEntries = [{ startAt: TIME_ROOT_START, date: "2026-10-02" }];

    assert.deepEqual(timeIssues(run(wfjsonBlockOnly(document))), []);
  });

  test("endAt 早于 startAt → TIME_ENTRY_ORDER（error，路径带下标）", () => {
    const found = issuesWithCode(
      runWithEntry({ startAt: TIME_ROOT_START, date: "2026-10-02", endAt: "2026-10-02T08:00:00+08:00", hours: 0 }),
      "TIME_ENTRY_ORDER",
    );

    assert.equal(found.length, 1);
    assert.equal(found[0].severity, "error");
    assert.equal(found[0].path, "/workflows/0/root/timeEntries/0/endAt");
  });

  test("date 与 startAt 的日期不一致 → TIME_DATE_MISMATCH（warning）", () => {
    const found = issuesWithCode(
      runWithEntry({ startAt: TIME_ROOT_START, date: "2026-10-03", endAt: "2026-10-02T11:30:00+08:00", hours: 2.5 }),
      "TIME_DATE_MISMATCH",
    );

    assert.equal(found.length, 1);
    assert.equal(found[0].severity, "warning");
    assert.equal(found[0].path, "/workflows/0/root/timeEntries/0/date");
    assert.match(found[0].message, /应为 "2026-10-02"/);
  });

  test("逐条检查：坏的是第 2 条时路径指向 timeEntries/1", () => {
    const document = clone(validDocument13());
    rootOf(document).timeEntries![1].date = "2026-10-09";

    const found = issuesWithCode(run(wfjsonBlockOnly(document)), "TIME_DATE_MISMATCH");

    assert.equal(found.length, 1);
    assert.equal(found[0].path, "/workflows/0/root/timeEntries/1/date");
  });

  test("hours 非法（负数 / NaN）→ TIME_HOURS_RANGE（error，直接查一致性层：这种值过不了 Schema）", () => {
    for (const hours of [-1, Number.NaN]) {
      const document = clone(validDocument13());
      rootOf(document).timeEntries![0].hours = hours;

      const found = issuesWithCode(checkRaw(document, wfjsonBlockOnly(document)), "TIME_HOURS_RANGE");

      assert.equal(found.length, 1, `hours=${hours}`);
      assert.equal(found[0].severity, "error");
      assert.equal(found[0].path, "/workflows/0/root/timeEntries/0/hours");
    }
  });

  test("没有 timeEntries 的节点不产生任何 TIME_* 问题", () => {
    assert.deepEqual(codesOf(run(validMarkdown())), []);
    assert.deepEqual(timeIssues(checkRaw(clone(validDocument()), validMarkdown())), []);
  });
});



