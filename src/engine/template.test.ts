/**
 * Phase 10（v0.8）：`template.ts` 单测 —— 模板必须是**能被自身校验器判绿**的笔记。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { analyzeMarkdown } from "./analyze.ts";
import { parseFrontmatter } from "./frontmatter.ts";
import { parseWfJsonBlock } from "./wfjsonParse.ts";
import { setLang } from "./i18n.ts";
import { NOTE_PLACEHOLDER } from "./noteSection.ts";
import { SCHEMA_VERSION, type WfJsonDocument } from "./types.ts";
import {
  DEFAULT_TEMPLATE_THEME,
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

  test("buildWorkflowTemplate：纪要段落不再带锚点（Phase 27 起弃用 noteAnchor）", () => {
    const text = buildWorkflowTemplate({ title: "带锚点", now: NOW });
    const node = parseDocument(text).workflows[0].root;
    assert.equal("noteAnchor" in node, false, "模板生成的节点不再写 noteAnchor");
    assert.ok(text.includes("### 带锚点\n"), "正文段落只有标题，没有 ` ^nd-` 锚点");
    assert.equal(/### 带锚点 \^nd-/.test(text), false);
  });

  test("buildWorkflowTemplate：首帧主题 = 默认主题（缺省写 default；显式给了就写传入值；空串不写）", () => {
    assert.equal(DEFAULT_TEMPLATE_THEME, "default");
    assert.equal(
      buildWorkflowTemplate({ now: NOW }).includes(`wf-theme: ${DEFAULT_TEMPLATE_THEME}`),
      true,
      "缺省就把默认主题写进 frontmatter（不跟随全局默认设置）",
    );
    assert.equal(buildWorkflowTemplate({ theme: "shoujo", now: NOW }).includes("wf-theme: shoujo"), true);
    assert.equal(buildWorkflowTemplate({ theme: "", now: NOW }).includes("wf-theme:"), false, "空串 = 不写该键");
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

  test("语言为 en 时模板全英文（标题 / 纪要大标题 / 占位正文都不带中文）", () => {
    setLang("en");
    try {
      const text = buildWorkflowTemplate({ now: NOW });

      assert.equal(/[\u4e00-\u9fff]/.test(text), false, `英文模板里不该有汉字：\n${text}`);
      assert.ok(text.includes("## Notes\n"));
      assert.ok(text.includes("(Notes pending)"));
      assert.equal(parseDocument(text).workflows[0].title, "New workflow");
      // 换成英文文案后仍然是「能过自身校验器」的笔记
      assert.deepEqual(analyzeMarkdown(text).issues, []);
    } finally {
      setLang("zh");
    }
  });

  test("语言为 zh 时模板保持原文案（纪要 / 占位符 / 默认标题不变）", () => {
    setLang("zh");
    const text = buildWorkflowTemplate({ now: NOW });
    assert.ok(text.includes("## 纪要\n"));
    assert.ok(text.includes(NOTE_PLACEHOLDER));
    assert.equal(parseDocument(text).workflows[0].title, DEFAULT_TEMPLATE_TITLE);
  });
});
