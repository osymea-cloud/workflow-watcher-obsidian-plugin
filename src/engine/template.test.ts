/**
 * Phase 10（v0.8）：`template.ts` 单测 —— 模板必须是**能被自身校验器判绿**的笔记。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { analyzeMarkdown } from "./analyze.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { parseWfJsonBlock } from "./wfjsonParse.ts";
import { SCHEMA_VERSION, type WfJsonDocument } from "./types.ts";
import {
  DEFAULT_TEMPLATE_TITLE,
  TEMPLATE_PLUGIN_ID,
  buildTemplateDocument,
  buildWorkflowTemplate,
} from "./template.ts";

const NOW = new Date("2026-10-21T09:15:00+08:00");

/** 从模板文本里取回 JSON（模板必然带一个 wfjson 块） */
function parseDocument(text: string): WfJsonDocument {
  const value = parseWfJsonBlock(text).value;
  assert.ok(value !== undefined);
  return value as WfJsonDocument;
}

describe("template · 工作流模板", () => {
  test("buildWorkflowTemplate：四段齐全（frontmatter / 渲染块 / 纪要段落 / wfjson 块）", () => {
    const text = buildWorkflowTemplate({ title: "新项目", now: NOW });

    assert.ok(text.startsWith("---\n"));
    assert.ok(text.includes("wf-tags: []\n"));
    assert.ok(text.includes("wf-status: doing\n"));
    assert.ok(text.includes("wf-titles: [新项目]\n"));
    assert.ok(text.includes("wf-updated: 2026-10-21\n"));
    assert.ok(text.includes(`await app.plugins.plugins["${TEMPLATE_PLUGIN_ID}"].render(dv);`));
    assert.ok(text.includes("## 纪要\n"));
    assert.ok(text.includes("```wfjson\n"));
    assert.ok(text.endsWith("\n"));
  });

  test("buildWorkflowTemplate：取到的 JSON 合法，且整体零 issue", () => {
    const text = buildWorkflowTemplate({ now: NOW });
    const document = parseDocument(text);
    assert.equal(document.schemaVersion, SCHEMA_VERSION);
    assert.equal(document.workflows.length, 1);
    assert.equal(document.workflows[0].title, DEFAULT_TEMPLATE_TITLE);
    assert.deepEqual(document.workflows[0].root.children, []);

    const result = analyzeMarkdown(text);
    assert.deepEqual(result.issues, []);
  });

  test("buildWorkflowTemplate：纪要段落的锚点等于 root 的 noteAnchor", () => {
    const text = buildWorkflowTemplate({ title: "带锚点", now: NOW });
    const node = parseDocument(text).workflows[0].root;
    assert.ok(node.noteAnchor !== undefined);
    assert.ok(text.includes(`### 带锚点 ${node.noteAnchor}`));
  });

  test("buildWorkflowTemplate：可选 theme 写进 frontmatter，缺省不写", () => {
    assert.equal(buildWorkflowTemplate({ theme: "shoujo", now: NOW }).includes("wf-theme: shoujo"), true);
    assert.equal(buildWorkflowTemplate({ now: NOW }).includes("wf-theme:"), false);
  });

  test("buildWorkflowTemplate：includeFrontmatter=false 时不带 frontmatter 段", () => {
    const text = buildWorkflowTemplate({ includeFrontmatter: false, now: NOW });
    assert.equal(text.startsWith("---"), false);
    assert.equal(parseFrontmatter(text).present, false);
    assert.ok(text.includes("```wfjson\n"));
  });

  test("buildWorkflowTemplate：每次生成 id 唯一（可重复插入同一份笔记）", () => {
    const first = buildTemplateDocument({ now: NOW });
    const second = buildTemplateDocument({ now: NOW });
    assert.notEqual(first.id, second.id);
    assert.notEqual(first.workflows[0].id, second.workflows[0].id);
  });
});
