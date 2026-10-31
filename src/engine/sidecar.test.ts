/**
 * 外置 JSON（v0.7 §⑧）单测：路径镜像、严格 JSON 文本解析、侧车分析、
 * 「只写笔记」写回、迁移计划与侧车变更编排。
 *
 * 关注点：
 *  - 路径可推导（重命名/移动时只需要新路径），顶层与嵌套都不丢层级；
 *  - 侧车模式下笔记内遗留代码块只报 info（解析以外置 JSON 为准）；
 *  - 迁移只摘代码块、不改正文；坏数据一律拒绝且原文不动；
 *  - 侧车变更编排与 `applyMutation` 同口径：拒绝/回滚时两个文件都保持原样。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { analyzeDocument, analyzeMarkdown, formatAnalyzeResult } from "./analyze.ts";
import { extractArchiveReference, renderArchiveNoteLine } from "./archive.ts";
import { applyStatusChange } from "./factory.ts";
import { applySidecarMutation } from "./mutate.ts";
import {
  isSidecarPath,
  notePathForSidecar,
  normalizeVaultPath,
  parentFolderOf,
  planSidecarMigration,
  sidecarPathFor,
} from "./sidecar.ts";
import { findNode } from "./tree.ts";
import { SCHEMA_VERSION, type WfJsonDocument } from "./types.ts";
import { DOING_ID, ROOT_ID, validMarkdown } from "./testFixtures.ts";
import { parseWfJsonBlock, parseWfJsonText } from "./wfjsonParse.ts";
import { inspectWfJsonBlocks, removeWfJsonBlocks, writeBackDocument, writeBackNote } from "./wfjsonWrite.ts";

const NOW = new Date("2026-10-11T10:30:00+08:00");
const NOTE_PATH = "A/B/笔记.md";
const SIDECAR_PATH = "_wfjson/A/B/笔记.wf.json";

/** 把样例拆成「笔记正文（无代码块）+ JSON 文本」，等价于迁移后的两个文件 */
function splitFixture(markdown: string = validMarkdown()): { note: string; jsonText: string } {
  return { note: removeWfJsonBlocks(markdown).markdown, jsonText: parseWfJsonBlock(markdown).text };
}

describe("sidecar · 路径镜像", () => {
  test("sidecarPathFor：顶层 / 嵌套 / 非 md / 反斜杠", () => {
    assert.equal(sidecarPathFor("笔记.md"), "_wfjson/笔记.wf.json");
    assert.equal(sidecarPathFor(NOTE_PATH), SIDECAR_PATH);
    assert.equal(sidecarPathFor("a\\b\\c.md"), "_wfjson/a/b/c.wf.json");
    assert.equal(sidecarPathFor("./笔记.md"), "_wfjson/笔记.wf.json");
    // 扩展名不是 md：原样补后缀（不猜测用户意图，但路径仍然可逆）
    assert.equal(sidecarPathFor("附件/data.json"), "_wfjson/附件/data.json.wf.json");
  });

  test("isSidecarPath：只认 `_wfjson` 目录本身与其子路径", () => {
    assert.equal(isSidecarPath("_wfjson"), true);
    assert.equal(isSidecarPath(SIDECAR_PATH), true);
    assert.equal(isSidecarPath("_wfjsonx/a.wf.json"), false);
    assert.equal(isSidecarPath("A/_wfjson/a.wf.json"), false);
    assert.equal(isSidecarPath("A/B/笔记.md"), false);
  });

  test("notePathForSidecar：与 sidecarPathFor 互逆；非侧车路径返回 undefined", () => {
    assert.equal(notePathForSidecar(SIDECAR_PATH), NOTE_PATH);
    assert.equal(notePathForSidecar("_wfjson/笔记.wf.json"), "笔记.md");
    assert.equal(notePathForSidecar("A/B/笔记.md"), undefined);
    assert.equal(notePathForSidecar("_wfjson/笔记.json"), undefined);
  });

  test("parentFolderOf / normalizeVaultPath：逐级建目录用", () => {
    assert.equal(parentFolderOf(SIDECAR_PATH), "_wfjson/A/B");
    assert.equal(parentFolderOf("_wfjson/笔记.wf.json"), "_wfjson");
    assert.equal(parentFolderOf("笔记.md"), "");
    assert.equal(normalizeVaultPath("/A//B\\c.md"), "A/B/c.md");
  });
});

describe("sidecar · parseWfJsonText（严格 JSON 文本）", () => {
  test("合法 JSON：解析出 value，行号基准可指定", () => {
    const result = parseWfJsonText('{\n  "a": 1\n}\n', 7);
    assert.deepEqual(result.value, { a: 1 });
    assert.equal(result.lineBase, 7);
    assert.deepEqual(result.issues, []);
  });

  test("尾随逗号：报精确行列，不交给 JSON.parse 叠加含糊错误", () => {
    const result = parseWfJsonText('{\n  "a": 1,\n}\n');
    assert.equal(result.value, undefined);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].code, "JSON_TRAILING_COMMA");
    assert.equal(result.issues[0].line, 2);
  });

  test("空文本 / BOM：各自报出可执行的提示", () => {
    const empty = parseWfJsonText("  \n");
    assert.equal(empty.value, undefined);
    assert.ok(empty.issues.some((item) => item.code === "JSON_PARSE_ERROR"));

    const bom = parseWfJsonText('\uFEFF{"a": 1}');
    assert.deepEqual(bom.value, { a: 1 });
    assert.ok(bom.issues.some((item) => item.code === "JSON_BOM"));
  });
});

describe("sidecar · analyzeDocument（侧车分析）", () => {
  test("外置 JSON + 笔记正文：零问题，锚点 / 超链接仍从笔记读", () => {
    const { note, jsonText } = splitFixture();
    const result = analyzeDocument({
      noteMarkdown: note,
      jsonText,
      jsonSource: "sidecar",
      jsonFile: SIDECAR_PATH,
      file: NOTE_PATH,
    });

    assert.equal(result.found, true);
    assert.equal(result.jsonSource, "sidecar");
    assert.equal(result.jsonFile, SIDECAR_PATH);
    assert.equal(result.lineBase, 1); // JSON 行号以侧车文件为准
    assert.equal(result.parse.block, undefined);
    assert.equal(result.hasError, false);
    assert.equal(result.hasIssue, false);
    assert.equal(result.document?.workflows.length, 2);
    assert.equal(result.issues.some((item) => item.code === "NO_WFJSON_BLOCK"), false);
    // 正文仍是超链接的唯一来源
    assert.ok((result.noteLinks.get(ROOT_ID)?.length ?? 0) > 0);
  });

  test("笔记里残留代码块：不再参与解析，只报 WFJSON_BLOCK_IGNORED（info）", () => {
    const { jsonText } = splitFixture();
    const result = analyzeDocument({
      noteMarkdown: validMarkdown(),
      jsonText,
      jsonSource: "sidecar",
      jsonFile: SIDECAR_PATH,
      file: NOTE_PATH,
    });

    const ignored = result.issues.filter((item) => item.code === "WFJSON_BLOCK_IGNORED");
    assert.equal(ignored.length, 1);
    assert.equal(ignored[0].severity, "info");
    assert.equal(result.counts.error, 0);
  });

  test("外置 JSON 坏掉：found=true + error（绝不悄悄回退到笔记代码块）", () => {
    const result = analyzeDocument({
      noteMarkdown: validMarkdown(),
      jsonText: '{\n  "schemaVersion": "1.9",\n}\n',
      jsonSource: "sidecar",
      jsonFile: SIDECAR_PATH,
      file: NOTE_PATH,
    });

    assert.equal(result.found, true);
    assert.equal(result.hasError, true);
    assert.equal(result.document, undefined);
    assert.ok(result.issues.some((item) => item.code === "JSON_TRAILING_COMMA"));
    // 展示时把「行号属于哪个文件」写清楚
    assert.ok(formatAnalyzeResult(result).includes(SIDECAR_PATH));
  });

  test("analyzeMarkdown 仍是笔记模式（jsonSource=note）", () => {
    const result = analyzeMarkdown(validMarkdown());
    assert.equal(result.jsonSource, "note");
    assert.equal(result.parse.block !== undefined, true);
  });
});

describe("sidecar · 只写笔记 / 摘掉代码块", () => {
  test("removeWfJsonBlocks：删掉代码块、保留正文、幂等", () => {
    const removed = removeWfJsonBlocks(validMarkdown());

    assert.equal(removed.removedLines.length, 1);
    assert.equal(inspectWfJsonBlocks(removed.markdown).found, false);
    assert.equal(removed.markdown.includes("```wfjson"), false);
    assert.ok(removed.markdown.includes("# 立项调查"));
    assert.ok(removed.markdown.includes("三家竞品的对比结论见 [[竞品分析报告]]。"));

    const again = removeWfJsonBlocks(removed.markdown);
    assert.equal(again.markdown, removed.markdown);
    assert.deepEqual(again.removedLines, []);
  });

  test("removeWfJsonBlocks：CRLF 原样保留，不留下多余空行", () => {
    const crlf = "# T\r\n\r\n```wfjson\r\n{}\r\n```\r\n";
    assert.equal(removeWfJsonBlocks(crlf).markdown, "# T\r\n");
  });

  test("writeBackNote：不写代码块，仍补 frontmatter / 纪要段，且幂等", () => {
    const { note } = splitFixture();
    const document = analyzeMarkdown(validMarkdown()).latestDocument as WfJsonDocument;

    const written = writeBackNote(note, document, { now: NOW });
    assert.equal(inspectWfJsonBlocks(written.markdown).found, false);
    assert.ok(written.markdown.includes("wf-status:"));
    assert.ok(written.markdown.includes("wf-updated: 2026-10-10"));
    assert.ok(written.markdown.includes("wf-note:begin:"));

    const again = writeBackNote(written.markdown, document, { now: NOW });
    assert.equal(again.markdown, written.markdown);
  });

  test("writeBackDocument：仍是「代码块 + 笔记」一体（归档 md 继续走这条）", () => {
    const { note } = splitFixture();
    const document = analyzeMarkdown(validMarkdown()).latestDocument as WfJsonDocument;

    const written = writeBackDocument(note, document, { now: NOW });
    assert.equal(inspectWfJsonBlocks(written.markdown).found, true);
    assert.ok(written.markdown.includes(`"schemaVersion": "${SCHEMA_VERSION}"`));
  });
});

describe("sidecar · planSidecarMigration（迁移计划）", () => {
  test("成功：镜像路径 + 落盘升格 + 笔记不再有代码块 + 侧车分析全绿", () => {
    const plan = planSidecarMigration(validMarkdown(), NOTE_PATH, { now: NOW });

    assert.equal(plan.success, true);
    assert.equal(plan.skipped, false);
    assert.equal(plan.changed, true);
    assert.equal(plan.upgraded, true);
    assert.equal(plan.sidecarPath, SIDECAR_PATH);
    assert.equal(plan.analysis.hasError, false);
    assert.equal(plan.analysis.hasIssue, false);
    assert.equal(plan.analysis.jsonSource, "sidecar");
    assert.equal(inspectWfJsonBlocks(plan.noteMarkdown).found, false);

    const parsed = JSON.parse(plan.jsonText) as WfJsonDocument;
    assert.equal(parsed.schemaVersion, SCHEMA_VERSION);
    assert.equal(parsed.workflows.length, 2);
    // 迁移后 `links[]` 已迁进正文（Phase 9 的写回规则），JSON 里不再有 links
    assert.equal(JSON.stringify(parsed).includes('"links"'), false);
  });

  test("没有 wfjson 代码块 → skipped（批量迁移跳过，不算失败）", () => {
    const plan = planSidecarMigration("# 普通笔记\n", "普通.md", { now: NOW });
    assert.equal(plan.success, false);
    assert.equal(plan.skipped, true);
    assert.equal(plan.noteMarkdown, "# 普通笔记\n");
  });

  test("当前文件有 error → 拒绝迁移，笔记原文一动不动", () => {
    const broken = validMarkdown().replace('"schemaVersion": "1.0"', '"schemaVersion": "1.0",');
    const plan = planSidecarMigration(broken, NOTE_PATH, { now: NOW });

    assert.equal(plan.success, false);
    assert.equal(plan.skipped, false);
    assert.equal(plan.noteMarkdown, broken);
    assert.equal(plan.jsonText, "");
    assert.match(plan.reason ?? "", /error 级/);
  });

  test("迁移结果可幂等重试：再对「已迁移的笔记」跑一次 → skipped", () => {
    const first = planSidecarMigration(validMarkdown(), NOTE_PATH, { now: NOW });
    const second = planSidecarMigration(first.noteMarkdown, NOTE_PATH, { now: NOW });
    assert.equal(second.skipped, true);
    assert.equal(second.noteMarkdown, first.noteMarkdown);
  });
});


describe("sidecar · applySidecarMutation（两个文件的变更编排）", () => {
  const setSummary = (document: WfJsonDocument) => {
    const node = findNode(document, DOING_ID);
    if (!node) return { reject: "节点不存在" };
    node.summary = "外置 JSON 测试";
    return { changedNodeIds: [DOING_ID] };
  };

  test("成功：JSON 里落改动 + 笔记里只有 frontmatter / 纪要段", () => {
    const { note, jsonText } = splitFixture();
    const result = applySidecarMutation(note, jsonText, setSummary, {
      now: NOW,
      file: NOTE_PATH,
      jsonFile: SIDECAR_PATH,
    });

    assert.equal(result.success, true);
    assert.equal(result.changed, true);
    assert.equal(result.upgraded, true);
    assert.ok(result.jsonText?.includes(`"schemaVersion": "${SCHEMA_VERSION}"`));
    assert.ok(result.jsonText?.includes("外置 JSON 测试"));
    assert.equal(result.markdown.includes("```wfjson"), false);
    assert.equal(inspectWfJsonBlocks(result.markdown).found, false);
    assert.equal(result.analysis.counts.error, 0);
    assert.equal(result.analysis.jsonSource, "sidecar");
    assert.equal(result.document !== undefined, true);

    // 同输入 + 同基准时间再跑一次 → 两个文件都逐字节稳定
    const again = applySidecarMutation(result.markdown, result.jsonText as string, setSummary, {
      now: NOW,
      file: NOTE_PATH,
      jsonFile: SIDECAR_PATH,
    });
    assert.equal(again.success, true);
    assert.equal(again.markdown, result.markdown);
    assert.equal(again.jsonText, result.jsonText);
  });

  test("状态变更：JSON 里是 done，frontmatter 摘要同步刷新", () => {
    const { note, jsonText } = splitFixture();
    const result = applySidecarMutation(
      note,
      jsonText,
      (document) => {
        const node = findNode(document, DOING_ID);
        if (!node) return { reject: "节点不存在" };
        applyStatusChange(node, "done", { at: "2026-10-11T10:30:00+08:00" });
        return { changedNodeIds: [DOING_ID] };
      },
      { now: NOW, file: NOTE_PATH, jsonFile: SIDECAR_PATH },
    );

    assert.equal(result.success, true);
    assert.ok(result.jsonText?.includes('"status": "done"'));
    assert.ok(result.markdown.includes("wf-status: todo"));
    assert.equal(result.analysis.hasError, false);
  });

  test("changed=false：两个文件都不动", () => {
    const { note, jsonText } = splitFixture();
    const result = applySidecarMutation(note, jsonText, () => ({ changed: false }), { now: NOW });

    assert.equal(result.success, true);
    assert.equal(result.changed, false);
    assert.equal(result.markdown, note);
    assert.equal(result.jsonText, jsonText);
  });

  test("外置 JSON 有 error：拒绝写回，笔记与 JSON 都保持原样", () => {
    const { note } = splitFixture();
    const broken = '{\n  "schemaVersion": "1.9",\n}\n';
    const result = applySidecarMutation(note, broken, setSummary, { now: NOW });

    assert.equal(result.success, false);
    assert.equal(result.changed, false);
    assert.equal(result.markdown, note);
    assert.equal(result.jsonText, broken);
    assert.match(result.reason ?? "", /error 级/);
  });

  test("写回结果不通过校验 → 整笔回滚（两个文件都返回原文）", () => {
    const { note, jsonText } = splitFixture();
    const result = applySidecarMutation(
      note,
      jsonText,
      (document) => {
        const node = findNode(document, DOING_ID);
        if (!node) return { reject: "节点不存在" };
        (node as { status: string }).status = "unknown";
        return { changedNodeIds: [DOING_ID] };
      },
      { now: NOW },
    );

    assert.equal(result.success, false);
    assert.equal(result.markdown, note);
    assert.equal(result.jsonText, jsonText);
    assert.match(result.reason ?? "", /整笔回滚/);
  });

  test("v0.7 §⑨-2：归档行写进笔记，JSON 里不再有 archive.file", () => {
    const { note, jsonText } = splitFixture();
    const result = applySidecarMutation(
      note,
      jsonText,
      (document) => {
        const node = findNode(document, DOING_ID);
        if (!node) return { reject: "节点不存在" };
        node.archive = {
          archivedAt: "2026-10-11 10:30",
          workflowId: "wf-archived",
          schemaVersion: SCHEMA_VERSION,
        };
        return {
          changedNodeIds: [DOING_ID],
          mergeNoteSections: [
            {
              targetNodeId: DOING_ID,
              lines: [renderArchiveNoteLine("archive/wf-archived-nd-x.md", "收敛")],
            },
          ],
        };
      },
      { now: NOW, file: NOTE_PATH, jsonFile: SIDECAR_PATH },
    );

    assert.equal(result.success, true, result.reason ?? "写回应当成功");
    assert.equal(
      result.markdown.includes("归档：[[archive/wf-archived-nd-x.md]] summary：收敛"),
      true,
      "笔记里要有归档地址行",
    );
    assert.equal(extractArchiveReference(result.markdown), "archive/wf-archived-nd-x.md");
    assert.equal(result.jsonText?.includes('"file"'), false, "JSON 里不再写 archive.file");
    assert.equal(result.analysis.counts.error, 0);
  });
});

