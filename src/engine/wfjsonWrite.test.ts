/**
 * 写回（wfjsonWrite）的单测：代码块替换/追加、frontmatter 摘要字段、纪要段落。
 * 关注点：纯文本变换不破坏正文、换行风格沿用原文、写回结果能被 analyze 判为全绿。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  DEFAULT_NOTE_PLACEHOLDER,
  appendNoteSection,
  buildFrontmatterSummary,
  buildWfJsonBlock,
  ensureNoteSections,
  inspectWfJsonBlocks,
  renderYamlScalar,
  renderYamlValue,
  removeNoteSections,
  sanitizeTitle,
  stringifyWfJson,
  upsertFrontmatterSummary,
  upsertWfJsonBlock,
  writeBackDocument,
} from "./wfjsonWrite.ts";
import { analyzeMarkdown } from "./analyze.ts";
import { applyStatusChange, createDocument, createNode, createWorkflow } from "./factory.ts";
import { removeNode } from "./nodeEdits.ts";
import { parseWfJsonBlock } from "./wfjsonParse.ts";
import {
  ARCHIVED_WF_TITLE,
  VALID_BODY,
  VALID_FRONTMATTER,
  clone,
  validDocument,
  validDocument11,
  validMarkdown,
} from "./testFixtures.ts";

const NOW = new Date("2026-10-11T10:30:00+08:00");

/** 取 1 基行号对应的整行文本 */
function lineAt(text: string, line: number): string {
  return text.split(/\r?\n/)[line - 1] ?? "";
}

describe("wfjsonWrite · 代码块", () => {
  test("stringifyWfJson：严格 JSON + 结尾换行，可被 JSON.parse 还原", () => {
    const document = validDocument();
    const json = stringifyWfJson(document);
    assert.ok(json.endsWith("\n"));
    assert.ok(json.includes('\n  "schemaVersion"'));
    assert.deepEqual(JSON.parse(json), document);
    assert.ok(stringifyWfJson(document, { indent: 4 }).includes('\n    "schemaVersion"'));
  });

  test("buildWfJsonBlock：两侧围栏 + 语言标记", () => {
    const block = buildWfJsonBlock(validDocument());
    assert.ok(block.startsWith("```wfjson\n"));
    assert.ok(block.endsWith("\n```\n"));
    const inner = block.slice("```wfjson\n".length, block.length - "\n```\n".length);
    assert.deepEqual(JSON.parse(inner), validDocument());
  });

  test("upsertWfJsonBlock：已有块 → replaced，正文与行号保持不变", () => {
    const document = clone(validDocument());
    document.updatedAt = "2026-10-11T08:00:00+08:00";
    const before = validMarkdown();
    const result = upsertWfJsonBlock(before, document);

    assert.equal(result.action, "replaced");
    assert.ok(result.markdown.includes("## 调研竞品 ^nd-uuid-001"));
    assert.ok(result.markdown.includes(`${VALID_BODY}`));
    assert.equal(lineAt(result.markdown, result.line), "```wfjson");
    assert.deepEqual(parseWfJsonBlock(result.markdown).value, document);
    assert.equal(inspectWfJsonBlocks(result.markdown).lines.length, 1);
  });

  test("upsertWfJsonBlock：没有块 → 追加到文件末尾", () => {
    const seed = `${VALID_FRONTMATTER}${VALID_BODY}`;
    const result = upsertWfJsonBlock(seed, validDocument());

    assert.equal(result.action, "appended");
    assert.ok(result.markdown.startsWith(seed));
    assert.ok(result.markdown.endsWith("```\n"));
    assert.equal(lineAt(result.markdown, result.line), "```wfjson");
    assert.deepEqual(parseWfJsonBlock(result.markdown).value, validDocument());
  });

  test("upsertWfJsonBlock：空文件直接写入一个块", () => {
    const result = upsertWfJsonBlock("", validDocument());
    assert.equal(result.action, "appended");
    assert.equal(result.line, 1);
    assert.ok(result.markdown.startsWith("```wfjson\n"));
  });

  test("upsertWfJsonBlock：CRLF 文件保持 CRLF", () => {
    const crlf = validMarkdown().replace(/\r?\n/g, "\r\n");
    const result = upsertWfJsonBlock(crlf, validDocument());
    const stripped = result.markdown.replace(/\r\n/g, "");
    assert.equal(stripped.includes("\n"), false, "不应出现裸 \\n");
  });

  test("upsertWfJsonBlock：重复写回是幂等的", () => {
    const document = clone(validDocument());
    const once = upsertWfJsonBlock(validMarkdown(), document).markdown;
    const twice = upsertWfJsonBlock(once, document).markdown;
    assert.equal(twice, once);
  });

  test("inspectWfJsonBlocks：定位行号 / 多个块 / 未闭合围栏", () => {
    const single = inspectWfJsonBlocks(validMarkdown());
    assert.equal(single.found, true);
    assert.equal(single.multiple, false);
    assert.equal(single.closed, true);
    assert.ok(lineAt(validMarkdown(), single.line).startsWith("{"));

    const doubled = inspectWfJsonBlocks(`${validMarkdown()}${buildWfJsonBlock(validDocument())}`);
    assert.equal(doubled.multiple, true);
    assert.equal(doubled.lines.length, 2);

    const broken = inspectWfJsonBlocks("```wfjson\n{\n");
    assert.equal(broken.found, true);
    assert.equal(broken.closed, false);
  });
});

describe("wfjsonWrite · frontmatter 摘要字段", () => {
  test("buildFrontmatterSummary：tags 去重、status 聚合、titles 与 updated", () => {
    const document = clone(validDocument());
    document.workflows[1].root.tags = ["竞品", "方案"];
    const summary = buildFrontmatterSummary(document, NOW);
    assert.deepEqual(summary.tags, ["竞品", "方案"]);
    assert.deepEqual(summary.titles, ["立项调查", "实现方案"]);
    assert.equal(summary.status, "doing");
    assert.equal(summary.updated, "2026-10-10");
  });

  test("buildFrontmatterSummary：updatedAt 缺失时回退到传入的 now", () => {
    const document = clone(validDocument());
    delete document.updatedAt;
    assert.equal(buildFrontmatterSummary(document, NOW).updated, "2026-10-11");
  });

  test("upsertFrontmatterSummary：覆盖 wf-* 字段，保留用户自有字段", () => {
    const document = clone(validDocument());
    document.updatedAt = "2026-10-12T09:00:00+08:00";
    const seed = validMarkdown().replace("---\n", "---\ncssclasses: [wf]\n");
    const result = upsertFrontmatterSummary(seed, document, NOW);

    assert.equal(result.action, "updated");
    assert.ok(result.markdown.includes("cssclasses: [wf]"));
    assert.ok(result.markdown.includes("wf-updated: 2026-10-12"));
    assert.equal(result.markdown.includes("wf-updated: 2026-10-10"), false);
    assert.ok(result.markdown.includes("wf-status: doing"));
    assert.equal(lineAt(result.markdown, result.lines["wf-updated"]), "wf-updated: 2026-10-12");
  });

  test("upsertFrontmatterSummary：重复写回是幂等的（不额外增加空行）", () => {
    const document = clone(validDocument());
    const once = upsertFrontmatterSummary(validMarkdown(), document, NOW).markdown;
    const twice = upsertFrontmatterSummary(once, document, NOW).markdown;

    assert.equal(twice, once);
    assert.ok(once.endsWith("```\n"));
  });

  test("upsertFrontmatterSummary：缺字段时补齐，补完的文件全绿", () => {
    const document = clone(validDocument());
    const seed = validMarkdown().replace("wf-tags: [竞品]\n", "title: 立项调查\n");
    const result = upsertFrontmatterSummary(seed, document, NOW);

    assert.equal(result.action, "updated");
    assert.ok(result.markdown.includes("title: 立项调查"));
    assert.ok(result.markdown.includes("wf-tags: [竞品]"));
    const written = upsertWfJsonBlock(result.markdown, document).markdown;
    assert.deepEqual(analyzeMarkdown(written).issues, []);
  });

  test("upsertFrontmatterSummary：清掉历史遗留的块序列子行（v0.8 bug）", () => {
    const document = clone(validDocument());
    // 历史版本把 wf-tags / wf-titles 写成「键行 + 块序列」；只改键行会把子行留成孤儿，
    // 渲染出来像一行「空格」，Obsidian 判 frontmatter 非法。
    const seed = validMarkdown()
      .replace("wf-tags: [竞品]\n", "wf-tags: [竞品]\n  - 竞品\n  - 调研\n")
      .replace("wf-titles: [立项调查, 实现方案]\n", "wf-titles: [立项调查, 实现方案]\n  - 立项调查\n  - 实现方案\n");
    assert.ok(seed.includes("  - 调研"));

    const result = upsertFrontmatterSummary(seed, document, NOW);

    assert.equal(result.action, "updated");
    assert.equal(result.markdown.includes("  - 竞品"), false);
    assert.equal(result.markdown.includes("  - 调研"), false);
    assert.equal(result.markdown.includes("  - 立项调查"), false);
    assert.ok(result.markdown.includes("wf-tags: [竞品]\n"));
    assert.ok(result.markdown.includes("wf-titles: [立项调查, 实现方案]\n"));
    // frontmatter 段里不再有任何块序列子行，且 `---` 收尾正常
    const head = result.markdown.slice(0, result.markdown.indexOf("\n---\n"));
    assert.equal(head.includes("  - "), false);
    assert.equal(lineAt(result.markdown, result.lines["wf-tags"]), "wf-tags: [竞品]");
  });

  test("upsertFrontmatterSummary：清理块序列后重复写回仍幂等，且文件全绿", () => {
    const document = clone(validDocument());
    const seed = validMarkdown().replace("wf-tags: [竞品]\n", "wf-tags:\n  - 竞品\n  - 调研\n");
    const once = upsertFrontmatterSummary(seed, document, NOW).markdown;
    const twice = upsertFrontmatterSummary(once, document, NOW).markdown;

    assert.equal(twice, once);
    assert.ok(once.includes("wf-tags: [竞品]\n"));
    assert.equal(once.includes("  - 调研"), false);
    const written = upsertWfJsonBlock(once, document).markdown;
    assert.deepEqual(analyzeMarkdown(written).issues, []);
  });

  test("upsertFrontmatterSummary：不动用户自有的块序列字段", () => {
    const document = clone(validDocument());
    const seed = validMarkdown().replace("---\n", "---\naliases:\n  - 别名一\n");
    const result = upsertFrontmatterSummary(seed, document, NOW);

    assert.ok(result.markdown.includes("aliases:\n  - 别名一\n"));
    assert.ok(result.markdown.includes("wf-tags: [竞品]\n"));
  });

  test("upsertFrontmatterSummary：无 frontmatter 时在最前面创建一个", () => {
    const document = clone(validDocument());
    const seed = `${VALID_BODY}${buildWfJsonBlock(document)}`;
    const result = upsertFrontmatterSummary(seed, document, NOW);

    assert.equal(result.action, "created");
    assert.ok(result.markdown.startsWith("---\nwf-tags: [竞品]\nwf-status: doing\n"));
    assert.ok(result.markdown.includes(VALID_BODY));
    assert.equal(lineAt(result.markdown, result.lines["wf-titles"]), "wf-titles: [立项调查, 实现方案]");
    assert.deepEqual(analyzeMarkdown(result.markdown).issues, []);
  });

  test("renderYamlScalar / renderYamlValue：必要处加双引号，数组用内联形式", () => {
    assert.equal(renderYamlScalar("立项调查"), "立项调查");
    assert.equal(renderYamlScalar(""), '""');
    assert.equal(renderYamlScalar("a: b"), '"a: b"');
    assert.equal(renderYamlScalar("前后空格 "), '"前后空格 "');
    assert.equal(renderYamlScalar('含"引号'), '"含\\"引号"');
    assert.equal(renderYamlValue(["a", "b"]), "[a, b]");
    assert.equal(renderYamlValue([]), "[]");
    assert.equal(renderYamlValue("todo"), "todo");
  });
});

describe("wfjsonWrite · 纪要段落", () => {
  test("appendNoteSection：追加 `### 标题 ^id` 与占位正文", () => {
    const node = createNode({ title: "补一个纪要", id: "nd-uuid-777" }, NOW);
    const result = appendNoteSection(validMarkdown(), node);

    assert.equal(result.added, true);
    assert.equal(result.anchor, "^nd-uuid-777");
    assert.ok(result.markdown.includes("### 补一个纪要 ^nd-uuid-777"));
    assert.ok(result.markdown.includes(DEFAULT_NOTE_PLACEHOLDER));
    assert.ok(result.markdown.startsWith(VALID_FRONTMATTER));
    assert.ok(result.markdown.includes(VALID_BODY));
  });

  test("appendNoteSection：锚点已存在时原样返回", () => {
    const seed = validMarkdown();
    const node = validDocument().workflows[0].root;
    const result = appendNoteSection(seed, node);

    assert.equal(result.added, false);
    assert.equal(result.anchor, "^nd-uuid-001");
    assert.equal(result.markdown, seed);
  });

  test("appendNoteSection：层级可配置（缺省 3，越界被夹到 1-6）", () => {
    const node = createNode({ title: "T", id: "nd-uuid-778" }, NOW);
    assert.ok(appendNoteSection(validMarkdown(), node, { level: 2 }).markdown.includes("## T ^nd-uuid-778"));
    assert.ok(appendNoteSection(validMarkdown(), node, { level: 9 }).markdown.includes("###### T ^nd-uuid-778"));
    assert.ok(appendNoteSection(validMarkdown(), node, { placeholder: "待写" }).markdown.includes("待写"));
  });

  test("ensureNoteSections：按先序补齐缺失段落，补齐后整体全绿", () => {
    const document = clone(validDocument());
    const seed = `${VALID_FRONTMATTER}${buildWfJsonBlock(document)}`;
    const result = ensureNoteSections(seed, document);

    assert.deepEqual(result.added, ["^nd-uuid-001", "^nd-uuid-002", "^nd-uuid-003", "^nd-uuid-004"]);
    assert.equal(result.markdown.split("\n").filter((line) => line.startsWith("### ")).length, 4);
    assert.deepEqual(analyzeMarkdown(result.markdown).issues, []);
  });

  test("ensureNoteSections：已补齐的文件不会重复追加", () => {
    const document = clone(validDocument());
    const seed = `${VALID_FRONTMATTER}${buildWfJsonBlock(document)}`;
    const once = ensureNoteSections(seed, document).markdown;
    assert.deepEqual(ensureNoteSections(once, document).added, []);
  });
});

describe("wfjsonWrite · 写回后仍可通过一致性检查", () => {
  test("状态回退（done → doing）后写回：进度/时间/frontmatter 全部自洽", () => {
    const document = clone(validDocument());
    const root = document.workflows[0].root;
    applyStatusChange(root, "doing", { at: "2026-10-11T09:00:00+08:00" });
    document.updatedAt = "2026-10-11T09:00:00+08:00";

    let markdown = upsertWfJsonBlock(validMarkdown(document), document).markdown;
    markdown = upsertFrontmatterSummary(markdown, document, NOW).markdown;

    const result = analyzeMarkdown(markdown);
    assert.deepEqual(result.issues, []);
    assert.equal(result.document?.workflows[0].root.status, "doing");
    assert.equal(result.document?.workflows[0].root.progress, 5, "v1.6：状态回退不再改 progress");
    assert.equal(result.document?.workflows[0].root.completedAt, undefined);
  });

  test("工厂新建工作流 → 写回 → 补正文锚点 → 全绿", () => {
    const document = createDocument([createWorkflow("新建工作流", NOW)], NOW);
    let markdown = upsertWfJsonBlock("", document).markdown;
    markdown = ensureNoteSections(markdown, document).markdown;
    markdown = upsertFrontmatterSummary(markdown, document, NOW).markdown;

    const result = analyzeMarkdown(markdown);
    assert.equal(result.found, true);
    assert.deepEqual(result.issues, []);
  });
});

describe("wfjsonWrite · v1.1（state / 两步聚合 / 三段写回）", () => {
  test("buildFrontmatterSummary：归档 workflow 让 wf-status 贡献 done", () => {
    const summary = buildFrontmatterSummary(validDocument11(), NOW);
    assert.equal(summary.status, "done");
    assert.deepEqual(summary.tags, ["竞品", "归档"]);
    assert.deepEqual(summary.titles, ["立项调查", ARCHIVED_WF_TITLE]);
    assert.equal(summary.updated, "2026-10-10");
  });

  test("buildFrontmatterSummary：cancelled 只在没有更「活」的状态时胜出", () => {
    const document = clone(validDocument11());
    document.workflows[1].state = "cancelled";
    assert.equal(buildFrontmatterSummary(document, NOW).status, "cancelled");

    document.workflows[0].root.children[0].status = "todo";
    assert.equal(buildFrontmatterSummary(document, NOW).status, "todo");
  });

  test("writeBackDocument：一次搞定代码块 + 摘要 + 纪要段落，且幂等", () => {
    const document = clone(validDocument());
    document.updatedAt = "2026-10-11T10:30:00+08:00";

    const first = writeBackDocument("# 笔记\n", document, { now: NOW });
    assert.equal(first.action, "appended");
    assert.equal(first.frontmatter, "created");
    assert.deepEqual(first.addedAnchors, ["^nd-uuid-001", "^nd-uuid-002", "^nd-uuid-003", "^nd-uuid-004"]);
    assert.ok(first.markdown.startsWith("---\nwf-tags: [竞品]\n"));
    assert.deepEqual(analyzeMarkdown(first.markdown).issues, []);

    const second = writeBackDocument(first.markdown, document, { now: NOW });
    assert.equal(second.action, "replaced");
    assert.equal(second.frontmatter, "updated");
    assert.deepEqual(second.addedAnchors, []);
    assert.equal(second.markdown, first.markdown);
  });
});
describe("wfjsonWrite · 标题清洗（sanitizeTitle）", () => {
  test("正常标题：去掉首尾空白，无提示", () => {
    const result = sanitizeTitle("  整理结论  ");

    assert.deepEqual(result, { ok: true, title: "整理结论", warnings: [] });
  });

  test("空标题 / 纯空白 → 拒绝（无标题的卡片与锚点都不可读）", () => {
    assert.equal(sanitizeTitle("").ok, false);
    const blank = sanitizeTitle("   ");
    assert.equal(blank.ok, false);
    assert.equal(blank.reason, "标题不能为空");
    assert.equal(blank.title, "");
  });

  test("含换行 → 拒绝（标题行不能被拆成两行）", () => {
    const result = sanitizeTitle("第一行\n第二行");

    assert.equal(result.ok, false);
    assert.equal(result.reason, "标题不能包含换行符");
    assert.deepEqual(result.warnings, []);
  });

  test("# / | / [ / ] → 允许写入但给出提示", () => {
    const result = sanitizeTitle("任务 #1 [草稿]");

    assert.equal(result.ok, true);
    assert.equal(result.title, "任务 #1 [草稿]");
    assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes("改名"));
  });
});

describe("wfjsonWrite · 纪要段落删除（removeNoteSections）", () => {
  test("删除 `### 标题 ^id` 段落：标题、正文、尾部空行一并清掉，兄弟段落原样保留", () => {
    const result = removeNoteSections(validMarkdown(), ["^nd-uuid-002"]);

    assert.deepEqual(result.removed, ["^nd-uuid-002"]);
    assert.deepEqual(result.missing, []);
    assert.equal(result.markdown.includes("### 整理结论"), false);
    assert.ok(result.markdown.includes("## 调研竞品 ^nd-uuid-001"));
    assert.ok(result.markdown.includes("### 交叉验证 ^nd-uuid-003"));
    assert.ok(result.markdown.startsWith(VALID_FRONTMATTER));
    // 只动正文：代码块与 JSON 原样保留
    assert.ok(result.markdown.includes("```wfjson"));
    assert.ok(result.markdown.includes('"noteAnchor": "^nd-uuid-002"'));
  });

  test("锚点行是标题时，其子标题段落一并带走（到「层级 ≤ 本标题」处停止）", () => {
    const markdown = [
      "## 父节点 ^nd-parent",
      "",
      "父正文",
      "",
      "### 待删 ^nd-target",
      "",
      "待删正文",
      "",
      "#### 子标题 ^nd-child",
      "",
      "子正文",
      "",
      "### 兄弟 ^nd-sibling",
      "",
    ].join("\n");

    const result = removeNoteSections(markdown, ["^nd-target"]);

    assert.deepEqual(result.removed, ["^nd-target"]);
    assert.equal(result.markdown.includes("nd-target"), false);
    assert.equal(result.markdown.includes("nd-child"), false);
    assert.ok(result.markdown.includes("## 父节点 ^nd-parent"));
    assert.ok(result.markdown.includes("### 兄弟 ^nd-sibling"));
  });

  test("锚点不在标题行时只删它自己那一行", () => {
    const result = removeNoteSections(["正文开头 ^nd-inline", "保留的下一行", ""].join("\n"), ["^nd-inline"]);

    assert.deepEqual(result.removed, ["^nd-inline"]);
    assert.equal(result.markdown.trim(), "保留的下一行");
  });

  test("锚点不存在 → 文本原样，锚点记入 missing（交给一致性检查报 ORPHAN_BLOCK_ANCHOR）", () => {
    const seed = validMarkdown();
    const result = removeNoteSections(seed, ["^nd-nope"]);

    assert.equal(result.markdown, seed);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.missing, ["^nd-nope"]);
  });

  test("空锚点列表 → 原样返回（不做任何扫描）", () => {
    const seed = validMarkdown();
    const result = removeNoteSections(seed, [""]);

    assert.equal(result.markdown, seed);
    assert.deepEqual(result.removed, []);
    assert.deepEqual(result.missing, []);
  });
});

describe("wfjsonWrite · 删除节点的超链接合并 / 删除（Phase 9）", () => {
  test("merge=true 合并进父段；merge=false 直接删段；两路都无 error", () => {
    const seed = validMarkdown();
    const withLink = clone(validDocument());
    withLink.workflows[0].root.children[0].links = [
      { id: "lk-merge", type: "web", target: "https://example.com/merge", label: "合并链接" },
    ];

    const mergedDoc = clone(withLink);
    const mergedEdit = removeNode(mergedDoc, "nd-uuid-002", NOW);
    const merged = writeBackDocument(seed, mergedDoc, {
      now: NOW,
      removedNoteAnchors: mergedEdit.removedNoteAnchors,
      mergeNoteSections: mergedEdit.mergeNoteSections,
    }).markdown;
    assert.ok(merged.includes("https://example.com/merge"), "父节点纪要段应出现被删节点的链接");
    assert.equal(analyzeMarkdown(merged).hasError, false);

    const droppedDoc = clone(withLink);
    const droppedEdit = removeNode(droppedDoc, "nd-uuid-002", NOW, { mergeNoteSection: false });
    const dropped = writeBackDocument(seed, droppedDoc, {
      now: NOW,
      removedNoteAnchors: droppedEdit.removedNoteAnchors,
      mergeNoteSections: droppedEdit.mergeNoteSections,
    }).markdown;
    assert.equal(dropped.includes("https://example.com/merge"), false, "选择删除时链接不应出现在父段");
    assert.equal(analyzeMarkdown(dropped).hasError, false);
  });
});

