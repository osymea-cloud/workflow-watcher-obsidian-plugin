/**
 * 正文纪要段（noteSection.ts）单测：Phase 9 的超链接唯一来源。
 *
 * 覆盖：标志扫描 / 结构问题、链接解析、段落读写、段落渲染、旧段落补标志（幂等）、
 * 每个节点的链接汇总（成对标志优先、旧标题边界兜底）、正文内容汇总（归档复制）。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  NOTE_PLACEHOLDER,
  appendNoteSectionLines,
  checkNoteMarkers,
  collectNoteLinks,
  collectNoteSectionContents,
  extractNoteLinks,
  findNoteSections,
  getNoteSectionContent,
  inferNoteLinkType,
  isNotePlaceholder,
  renderNoteLinkLine,
  renderNoteSection,
  replaceNoteSectionContent,
  wrapNoteSections,
} from "./noteSection.ts";
import { setLang, tIn } from "./i18n.ts";
import { anchorForNode } from "./ids.ts";
import type { WfJsonDocument, WfNode } from "./types.ts";

const NOW = "2026-10-11T10:30:00+08:00";

/** 最小可用的节点（只提供 noteSection 需要的字段） */
function node(id: string, title: string): WfNode {
  return { id, title, status: "todo", children: [], noteAnchor: anchorForNode(id) };
}

/** 只含一个工作流的文档（root + 若干子节点） */
function documentOf(...nodes: WfNode[]): WfJsonDocument {
  const [root, ...children] = nodes;
  assert.ok(root, "至少给一个根节点");
  root.children = children;
  return {
    schemaVersion: "1.9",
    id: "file-uuid-001",
    updatedAt: NOW,
    workflows: [{ id: "wf-uuid-001", title: "工作流", root }],
  };
}

/** 三段带标题的旧格式正文（没有标志） */
function legacyBody(): string {
  return [
    "# 立项调查",
    "",
    "## 调研竞品 ^nd-001",
    "",
    "竞品正文",
    "",
    "### 整理结论 ^nd-002",
    "",
    "结论正文",
    "",
    "### 交叉验证 ^nd-003",
    "",
    "验证正文",
    "",
  ].join("\n");
}

describe("noteSection · 标志扫描（findNoteSections）", () => {
  test("成对标志 → 段落范围、内容与标题行都正确", () => {
    const markdown = [
      "### 采集竞品截图 ^nd-001",
      "<!-- wf-note:begin:nd-001 -->",
      "- [报告](https://example.com)",
      "- [[访谈录音]]",
      "<!-- wf-note:end:nd-001 -->",
      "",
    ].join("\n");

    const sections = findNoteSections(markdown);

    assert.equal(sections.length, 1);
    const [section] = sections;
    assert.ok(section);
    assert.equal(section.nodeId, "nd-001");
    assert.equal(section.headingLine, 1);
    assert.equal(section.beginLine, 2);
    assert.equal(section.endLine, 5);
    assert.equal(section.level, 3);
    assert.equal(section.content, "- [报告](https://example.com)\n- [[访谈录音]]");
  });

  test("跳过围栏代码块与 frontmatter 里的同名注释", () => {
    const markdown = [
      "---",
      "wf-status: todo",
      "---",
      "```md",
      "<!-- wf-note:begin:fake -->",
      "<!-- wf-note:end:fake -->",
      "```",
      "<!-- wf-note:begin:nd-001 -->",
      "内容",
      "<!-- wf-note:end:nd-001 -->",
      "",
    ].join("\n");

    assert.deepEqual(findNoteSections(markdown).map((section) => section.nodeId), ["nd-001"]);
  });

  test("未配对 / 嵌套的段落不算段落（交给 checkNoteMarkers 报错）", () => {
    const markdown = [
      "<!-- wf-note:begin:nd-001 -->",
      "<!-- wf-note:begin:nd-002 -->",
      "<!-- wf-note:end:nd-002 -->",
      "<!-- wf-note:end:nd-001 -->",
      "",
    ].join("\n");

    assert.deepEqual(findNoteSections(markdown), []);
  });
});

describe("noteSection · 结构问题（checkNoteMarkers）", () => {
  test("未配对的 begin / end 都报 unpaired-*", () => {
    const onlyBegin = checkNoteMarkers("<!-- wf-note:begin:nd-001 -->\n");
    assert.equal(onlyBegin.length, 1);
    assert.equal(onlyBegin[0]?.kind, "unpaired-begin");
    assert.equal(onlyBegin[0]?.line, 1);

    const onlyEnd = checkNoteMarkers("正文\n<!-- wf-note:end:nd-001 -->\n");
    assert.equal(onlyEnd.length, 1);
    assert.equal(onlyEnd[0]?.kind, "unpaired-end");
    assert.equal(onlyEnd[0]?.line, 2);
  });

  test("嵌套 → nested（带外层起始行号）", () => {
    const problems = checkNoteMarkers(
      ["<!-- wf-note:begin:nd-001 -->", "<!-- wf-note:begin:nd-002 -->", "<!-- wf-note:end:nd-002 -->"].join("\n"),
    );
    const nested = problems.filter((problem) => problem.kind === "nested");
    assert.equal(nested.length, 1);
    assert.match(nested[0]?.message ?? "", /第 1 行/);
  });

  test("begin / end id 不一致 → mismatch", () => {
    const problems = checkNoteMarkers(
      ["<!-- wf-note:begin:nd-001 -->", "<!-- wf-note:end:nd-002 -->"].join("\n"),
    );
    assert.equal(problems.filter((problem) => problem.kind === "mismatch").length, 1);
  });
});


describe("noteSection · 链接解析（extractNoteLinks）", () => {
  test("md / wiki / 别名 / 图片 / 裸 URL 都能解析，类型按语法推断", () => {
    const links = extractNoteLinks(
      [
        "- [竞品分析报告](https://example.com/report)",
        "- [[访谈录音整理]]",
        "- [[设计稿|第二版设计稿]]",
        "- ![[竞品截图.png]]",
        "见 https://example.com/bare 与 https://example.com/bare",
      ].join("\n"),
    );

    assert.deepEqual(
      links.map((link) => [link.label, link.target, link.type]),
      [
        ["竞品分析报告", "https://example.com/report", "web"],
        ["访谈录音整理", "访谈录音整理", "md"],
        ["第二版设计稿", "设计稿", "md"],
        ["竞品截图.png", "竞品截图.png", "image"],
        ["https://example.com/bare", "https://example.com/bare", "web"],
      ],
    );
  });

  test("同一行多条链接 / 重复原文去重", () => {
    const links = extractNoteLinks("- [[A]] 与 [[B]] 以及 [[A]]");
    assert.deepEqual(links.map((link) => link.target), ["A", "B"]);
  });

  test("inferNoteLinkType：http → web、图片扩展名 / embed → image、其余 → md", () => {
    assert.equal(inferNoteLinkType("https://example.com"), "web");
    assert.equal(inferNoteLinkType("截图.PNG"), "image");
    assert.equal(inferNoteLinkType("任意文件", true), "image");
    assert.equal(inferNoteLinkType("某笔记"), "md");
  });

  test("renderNoteLinkLine：与解析语法一一对应", () => {
    assert.equal(
      renderNoteLinkLine({ type: "web", target: "https://example.com", label: "文档" }),
      "- [文档](https://example.com)",
    );
    assert.equal(renderNoteLinkLine({ type: "md", target: "笔记" }), "- [[笔记]]");
    assert.equal(renderNoteLinkLine({ type: "md", target: "笔记", label: "别名" }), "- [[笔记|别名]]");
    assert.equal(renderNoteLinkLine({ type: "image", target: "截图.png" }), "- ![[截图.png]]");
  });
});

describe("noteSection · 段落读写", () => {
  const section = [
    "### 标题 ^nd-001",
    "<!-- wf-note:begin:nd-001 -->",
    "旧内容",
    "<!-- wf-note:end:nd-001 -->",
    "",
    "尾行",
  ].join("\n");

  test("getNoteSectionContent：按 id / 锚点都能取到；没有成对标志 → undefined", () => {
    assert.equal(getNoteSectionContent(section, "nd-001"), "旧内容");
    assert.equal(getNoteSectionContent(section, "^nd-001"), "旧内容");
    assert.equal(getNoteSectionContent("### 标题 ^nd-001\n正文\n", "nd-001"), undefined);
  });

  test("replaceNoteSectionContent：只换内容，标题 / 标志 / 尾部原样保留", () => {
    const result = replaceNoteSectionContent(section, "nd-001", "- [[新链接]]\n- [官网](https://example.com)\n");
    assert.equal(result.found, true);
    assert.equal(getNoteSectionContent(result.markdown, "nd-001"), "- [[新链接]]\n- [官网](https://example.com)");
    assert.ok(result.markdown.startsWith("### 标题 ^nd-001\n<!-- wf-note:begin:nd-001 -->\n"));
    assert.ok(result.markdown.endsWith("<!-- wf-note:end:nd-001 -->\n\n尾行"));
  });

  test("replaceNoteSectionContent：空内容写一行空行（避免两个标志相邻）", () => {
    const result = replaceNoteSectionContent(section, "nd-001", "");
    assert.equal(getNoteSectionContent(result.markdown, "nd-001"), "");
    assert.ok(result.markdown.includes("<!-- wf-note:begin:nd-001 -->\n\n<!-- wf-note:end:nd-001 -->"));
  });

  test("replaceNoteSectionContent：找不到段落 → found=false 且文本原样", () => {
    const result = replaceNoteSectionContent(section, "nd-missing", "新内容");
    assert.equal(result.found, false);
    assert.equal(result.markdown, section);
  });

  test("replaceNoteSectionContent：CRLF 文件保持 CRLF", () => {
    const crlf = section.replace(/\n/g, "\r\n");
    const result = replaceNoteSectionContent(crlf, "nd-001", "新一\n新二");
    assert.ok(result.markdown.includes("\r\n"));
    assert.equal(/[^\r]\n/.test(result.markdown), false, "不应出现裸 LF");
  });

  test("appendNoteSectionLines：追加在末尾并丢掉占位文本", () => {
    const withPlaceholder = [
      "### 标题 ^nd-001",
      "<!-- wf-note:begin:nd-001 -->",
      NOTE_PLACEHOLDER,
      "<!-- wf-note:end:nd-001 -->",
      "",
    ].join("\n");
    const result = appendNoteSectionLines(withPlaceholder, "nd-001", ["- [[A]]", "- [[B]]"]);
    assert.equal(result.appended, true);
    assert.equal(getNoteSectionContent(result.markdown, "nd-001"), "- [[A]]\n- [[B]]");
  });

  test("appendNoteSectionLines：目标段没有标志对 → appended=false、文本原样", () => {
    const seed = "### 标题 ^nd-001\n正文\n";
    const result = appendNoteSectionLines(seed, "nd-001", ["- [[A]]"]);
    assert.equal(result.appended, false);
    assert.equal(result.markdown, seed);
  });
});

describe("noteSection · 段落渲染（renderNoteSection）", () => {
  test("默认标题层级 3 + 占位文本", () => {
    assert.equal(
      renderNoteSection(node("nd-001", "采集竞品截图")),
      [
        "### 采集竞品截图 ^nd-001",
        "<!-- wf-note:begin:nd-001 -->",
        NOTE_PLACEHOLDER,
        "<!-- wf-note:end:nd-001 -->",
      ].join("\n"),
    );
  });

  test("可指定层级 / 占位 / 内容（层级夹在 1..6）", () => {
    const rendered = renderNoteSection(node("nd-001", "标题"), { level: 9, content: "- [[A]]\n- [[B]]" });
    assert.ok(rendered.startsWith("###### 标题 ^nd-001\n"));
    assert.ok(rendered.includes("- [[A]]\n- [[B]]"));
    assert.equal(rendered.includes(NOTE_PLACEHOLDER), false);
  });
});

describe("noteSection · 旧段落补标志（wrapNoteSections）", () => {
  test("给旧标题段落补标志：不嵌套、保留原文内容、幂等", () => {
    const document = documentOf(node("nd-001", "调研竞品"), node("nd-002", "整理结论"), node("nd-003", "交叉验证"));
    const body = legacyBody();

    const wrapped = wrapNoteSections(body, document);

    assert.deepEqual(wrapped.wrapped, ["nd-001", "nd-002", "nd-003"]);
    assert.deepEqual(checkNoteMarkers(wrapped.markdown), []);
    assert.deepEqual(
      findNoteSections(wrapped.markdown).map((section) => section.nodeId),
      ["nd-001", "nd-002", "nd-003"],
    );
    // 父段只包住自己的正文，子段标志在自己标题之后
    assert.equal(getNoteSectionContent(wrapped.markdown, "nd-001"), "竞品正文");
    assert.equal(getNoteSectionContent(wrapped.markdown, "nd-002"), "结论正文");
    // 幂等：再跑一次文本完全一致
    assert.equal(wrapNoteSections(wrapped.markdown, document).markdown, wrapped.markdown);
  });

  test("已经有成对标志的段落一律不动", () => {
    const document = documentOf(node("nd-001", "标题"));
    const seed = [
      "## 标题 ^nd-001",
      "<!-- wf-note:begin:nd-001 -->",
      "- [[A]]",
      "<!-- wf-note:end:nd-001 -->",
      "",
    ].join("\n");

    const result = wrapNoteSections(seed, document);

    assert.deepEqual(result.wrapped, []);
    assert.equal(result.markdown, seed);
  });

  test("文档里不存在的节点不补标志", () => {
    const document = documentOf(node("nd-001", "标题"));
    const seed = ["### 别的节点 ^nd-999", "", "正文", "", "## 标题 ^nd-001", "", "正文", ""].join("\n");

    const result = wrapNoteSections(seed, document);

    assert.deepEqual(result.wrapped, ["nd-001"]);
    assert.equal(result.markdown.includes("nd-999 -->"), false);
  });
});

describe("noteSection · 链接汇总（collectNoteLinks）", () => {
  test("成对标志段优先，只返回文档里存在的节点", () => {
    const document = documentOf(node("nd-001", "标题"));
    const markdown = [
      "## 标题 ^nd-001",
      "<!-- wf-note:begin:nd-001 -->",
      "- [[A]]",
      "<!-- wf-note:end:nd-001 -->",
      "",
      "## 已删除的节点 ^nd-999",
      "<!-- wf-note:begin:nd-999 -->",
      "- [[B]]",
      "<!-- wf-note:end:nd-999 -->",
      "",
    ].join("\n");

    const links = collectNoteLinks(markdown, document);

    assert.deepEqual([...links.keys()], ["nd-001"]);
    assert.deepEqual(links.get("nd-001")?.map((link) => link.target), ["A"]);
  });

  test("旧格式（没有标志）按标题边界兜底解析", () => {
    const document = documentOf(node("nd-001", "调研竞品"), node("nd-002", "整理结论"));
    const markdown = [
      "## 调研竞品 ^nd-001",
      "- [[旧链接]]",
      "",
      "### 整理结论 ^nd-002",
      "- [官网](https://example.com)",
      "",
    ].join("\n");

    const links = collectNoteLinks(markdown, document);

    assert.deepEqual(links.get("nd-001")?.map((link) => link.target), ["旧链接"]);
    assert.deepEqual(links.get("nd-002")?.map((link) => link.target), ["https://example.com"]);
  });

  test("没有链接的节点也有一项（空数组），视图据此判断实线边框", () => {
    const document = documentOf(node("nd-001", "调研竞品"));
    const markdown = [
      "## 调研竞品 ^nd-001",
      "<!-- wf-note:begin:nd-001 -->",
      "纯文字纪要",
      "<!-- wf-note:end:nd-001 -->",
      "",
    ].join("\n");

    const links = collectNoteLinks(markdown, document);

    assert.deepEqual(links.get("nd-001"), []);
  });
});

describe("noteSection · 正文内容汇总（collectNoteSectionContents）", () => {
  test("成对标志段 + 旧格式兜底，都返回完整文字（含链接）", () => {
    const document = documentOf(node("nd-001", "调研竞品"), node("nd-002", "整理结论"));
    const markdown = [
      "## 调研竞品 ^nd-001",
      "<!-- wf-note:begin:nd-001 -->",
      "第一段文字",
      "- [官网](https://example.com)",
      "<!-- wf-note:end:nd-001 -->",
      "",
      "### 整理结论 ^nd-002",
      "旧格式正文",
      "",
    ].join("\n");

    const contents = collectNoteSectionContents(markdown, document);

    assert.equal(contents.get("nd-001"), "第一段文字\n- [官网](https://example.com)");
    assert.equal(contents.get("nd-002"), "旧格式正文");
  });

  test("占位符不算内容（归档复制时保留归档 md 自己的占位）", () => {
    const document = documentOf(node("nd-001", "标题"));
    const markdown = [
      "## 标题 ^nd-001",
      "<!-- wf-note:begin:nd-001 -->",
      NOTE_PLACEHOLDER,
      "<!-- wf-note:end:nd-001 -->",
      "",
    ].join("\n");

    assert.equal(collectNoteSectionContents(markdown, document).has("nd-001"), false);
  });
});

describe("noteSection · 占位符与语言（Phase 20）", () => {
  test("NOTE_PLACEHOLDER 就是字典里的中文写法（模板与引擎不会漂移）", () => {
    assert.equal(NOTE_PLACEHOLDER, tIn("zh", "template.notePlaceholder"));
    assert.equal(NOTE_PLACEHOLDER, "（纪要待补充）");
    assert.equal(tIn("en", "template.notePlaceholder"), "(Notes pending)");
  });

  test("isNotePlaceholder：中英两种写法都算，与当前语言无关", () => {
    setLang("zh");
    assert.equal(isNotePlaceholder(NOTE_PLACEHOLDER), true);
    assert.equal(isNotePlaceholder("  (Notes pending)  "), true, "英文模板写的占位符也算");
    assert.equal(isNotePlaceholder("真的纪要"), false);
    assert.equal(isNotePlaceholder(""), false, "空串没内容，但不是占位符");

    // 中文环境写下的占位符，切到英文后仍然只是占位符（反之亦然）
    setLang("en");
    assert.equal(isNotePlaceholder(NOTE_PLACEHOLDER), true);
    assert.equal(isNotePlaceholder(tIn("en", "template.notePlaceholder")), true);
    setLang("zh");
  });

  test("英文占位符：不参与归档复制，追加超链接时先被丢掉", () => {
    const english = tIn("en", "template.notePlaceholder");
    const document = documentOf(node("nd-001", "Title"));
    const markdown = [
      "## Title ^nd-001",
      "<!-- wf-note:begin:nd-001 -->",
      english,
      "<!-- wf-note:end:nd-001 -->",
      "",
    ].join("\n");

    assert.equal(collectNoteSectionContents(markdown, document).has("nd-001"), false);

    const appended = appendNoteSectionLines(markdown, "nd-001", ["- [[A]]"]);
    assert.equal(appended.markdown.includes(english), false);
    assert.ok(appended.markdown.includes("- [[A]]"));
  });
});

