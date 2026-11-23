/**
 * 外置 JSON（v0.7 §⑧；Phase 24 M1.6 扁平化）单测：路径规则与身份键、严格 JSON 文本解析、
 * 侧车分析、「只写笔记」写回、迁移计划与侧车变更编排。
 *
 * 关注点：
 *  - 路径**扁平**：侧车全在 `_workflowwatcher/` 第一层，靠 `~<noteKey>` 区分同名笔记；
 *    key 由完整路径算出（改名 / 移动会变，交给 rename 钩子）；
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
  backupPathFor,
  isBackupPath,
  isSidecarPath,
  legacySidecarPathFor,
  noteKeyFor,
  notePathForSidecar,
  normalizeVaultPath,
  parentFolderOf,
  parseSidecarName,
  planSidecarMigration,
  planSidecarPair,
  sidecarPathFor,
} from "./sidecar.ts";
import { findNode } from "./tree.ts";
import { SCHEMA_VERSION, WFJSON_BACKUP_FOLDER, type WfJsonDocument } from "./types.ts";
import { DOING_ID, ROOT_ID, validMarkdown } from "./testFixtures.ts";
import { parseWfJsonBlock, parseWfJsonText } from "./wfjsonParse.ts";
import {
  inspectWfJsonBlocks,
  removeWfJsonBlocks,
  stringifyWfJson,
  writeBackDocument,
  writeBackNote,
} from "./wfjsonWrite.ts";

const NOW = new Date("2026-10-11T10:30:00+08:00");
const NOTE_PATH = "A/B/笔记.md";
const NOTE_KEY = noteKeyFor(NOTE_PATH);
/** 扁平侧车路径（M1.6 起的唯一形态） */
const SIDECAR_PATH = `_workflowwatcher/笔记~${NOTE_KEY}.wf.json`;
/** M1.6 之前的镜像路径（只读兼容 / 搬迁命令用） */
const LEGACY_SIDECAR_PATH = "_workflowwatcher/A/B/笔记.wf.json";

/** 把样例拆成「笔记正文（无代码块）+ JSON 文本」，等价于迁移后的两个文件 */
function splitFixture(markdown: string = validMarkdown()): { note: string; jsonText: string } {
  return { note: removeWfJsonBlocks(markdown).markdown, jsonText: parseWfJsonBlock(markdown).text };
}

describe("sidecar · 路径与身份键（扁平化）", () => {
  test("noteKeyFor：10 位十六进制、同路径稳定、不同路径不同", () => {
    assert.match(noteKeyFor(NOTE_PATH), /^[0-9a-f]{10}$/);
    assert.equal(noteKeyFor(NOTE_PATH), NOTE_KEY);
    // 斜杠方向 / `./` / 大小写 / Unicode 形态都不影响
    assert.equal(noteKeyFor("a\\b\\笔记.md"), noteKeyFor("A/B/笔记.md"));
    assert.equal(noteKeyFor("./A/B/笔记.md"), NOTE_KEY);
    assert.notEqual(noteKeyFor("A/B/笔记.md"), noteKeyFor("A/C/笔记.md"));
  });

  test("sidecarPathFor：扁平（全在第一层）、同名笔记不撞车", () => {
    assert.equal(sidecarPathFor(NOTE_PATH), SIDECAR_PATH);
    assert.equal(sidecarPathFor("笔记.md"), `_workflowwatcher/笔记~${noteKeyFor("笔记.md")}.wf.json`);
    assert.equal(sidecarPathFor("a\\b\\c.md"), `_workflowwatcher/c~${noteKeyFor("a/b/c.md")}.wf.json`);
    // 扩展名不是 md：原样补后缀（笔记名带上扩展名，仍然在第一层）
    assert.equal(sidecarPathFor("附件/data.json"), `_workflowwatcher/data.json~${noteKeyFor("附件/data.json")}.wf.json`);
    // 关键：不同目录下的同名笔记各有各的侧车
    assert.notEqual(sidecarPathFor("A/笔记.md"), sidecarPathFor("B/笔记.md"));
    // 任何侧车都在第一层（没有镜像子目录）
    for (const path of [NOTE_PATH, "笔记.md", "deep/a/b/c.md", "附件/data.json"]) {
      assert.equal(parentFolderOf(sidecarPathFor(path)), "_workflowwatcher");
    }
  });

  test("legacySidecarPathFor：老镜像规则仍可算（读兜底 / 搬迁用）", () => {
    assert.equal(legacySidecarPathFor(NOTE_PATH), LEGACY_SIDECAR_PATH);
    assert.equal(legacySidecarPathFor("笔记.md"), "_workflowwatcher/笔记.wf.json");
    assert.equal(parentFolderOf(legacySidecarPathFor(NOTE_PATH)), "_workflowwatcher/A/B");
  });

  test("isSidecarPath：只认 `_workflowwatcher` 目录本身与其子路径", () => {
    assert.equal(isSidecarPath("_workflowwatcher"), true);
    assert.equal(isSidecarPath(SIDECAR_PATH), true);
    assert.equal(isSidecarPath(LEGACY_SIDECAR_PATH), true);
    assert.equal(isSidecarPath("_workflowwatcherx/a.wf.json"), false);
    assert.equal(isSidecarPath("A/_workflowwatcher/a.wf.json"), false);
    assert.equal(isSidecarPath("A/B/笔记.md"), false);
  });

  test("backupPathFor / isBackupPath：md 补身份键与侧车同键成对，json 原样，全落 backup/ 且 .bak 不命中索引", () => {
    // md：补上「按自己路径算出的键」→ 与它的侧车副本同名同键、只差后缀
    const mainNote = "_workflowwatcher/main.md";
    assert.equal(backupPathFor(mainNote), `${WFJSON_BACKUP_FOLDER}/main~${noteKeyFor(mainNote)}.md.bak`);
    const archiveNote = "archive/wf-1-nd-2.md";
    assert.equal(
      backupPathFor(archiveNote),
      `${WFJSON_BACKUP_FOLDER}/wf-1-nd-2~${noteKeyFor(archiveNote)}.md.bak`,
    );
    // 配对凭据：md 副本里的 key 就是侧车文件名里的 key
    assert.equal(parseSidecarName(sidecarPathFor(archiveNote))?.key, noteKeyFor(archiveNote));
    // 侧车 json：文件名里本来就带 `~<key>`，原样镜像 + `.bak`
    assert.equal(backupPathFor(SIDECAR_PATH), `${WFJSON_BACKUP_FOLDER}/笔记~${NOTE_KEY}.wf.json.bak`);

    for (const source of [mainNote, archiveNote, SIDECAR_PATH]) {
      const backup = backupPathFor(source);
      assert.equal(parentFolderOf(backup), WFJSON_BACKUP_FOLDER);
      assert.equal(isBackupPath(backup), true);
      // `.bak` 不会被当成侧车、也不会被 `getMarkdownFiles()` 收录
      assert.equal(parseSidecarName(backup), undefined);
      assert.equal(backup.toLowerCase().endsWith(".md"), false);
      assert.equal(backup.toLowerCase().endsWith(".wf.json"), false);
    }

    assert.equal(isBackupPath(WFJSON_BACKUP_FOLDER), true);
    assert.equal(isBackupPath(`${WFJSON_BACKUP_FOLDER}/nested/x.md.bak`), true);
    assert.equal(isBackupPath("_workflowwatcher"), false);
    assert.equal(isBackupPath(SIDECAR_PATH), false);
    assert.equal(isBackupPath("_workflowwatcher/backupx/a.md.bak"), false);
  });

  test("文件名自带键（`_workflowwatcher/` 内）：键幂等、侧车不补第二个键；用户笔记照旧按路径算", () => {
    // 主看板式命名：`main~<key>.md` 的键就是文件名里那个，侧车同名同键、只差扩展名
    const keyed = `_workflowwatcher/main~${NOTE_KEY}.md`;
    assert.equal(noteKeyFor(keyed), NOTE_KEY);
    assert.equal(sidecarPathFor(keyed), `_workflowwatcher/main~${NOTE_KEY}.wf.json`);
    // 备份副本也不会变成 `main~K~K.md.bak`
    assert.equal(backupPathFor(keyed), `${WFJSON_BACKUP_FOLDER}/main~${NOTE_KEY}.md.bak`);
    // 尾巴不像键（长度 / 非十六进制）→ 照旧按完整路径算
    assert.match(noteKeyFor("_workflowwatcher/main~abc.md"), /^[0-9a-f]{10}$/);
    assert.notEqual(noteKeyFor("_workflowwatcher/main~abc.md"), "abc");
    // 用户笔记哪怕名字尾巴像键，键仍按完整路径算（否则不同目录的同名笔记会撞进同一份侧车）
    assert.notEqual(noteKeyFor(`A/笔记~${NOTE_KEY}.md`), NOTE_KEY);
    assert.notEqual(
      sidecarPathFor(`A/笔记~${NOTE_KEY}.md`),
      sidecarPathFor(`B/笔记~${NOTE_KEY}.md`),
    );
  });

  test("parseSidecarName：扁平名拆出「笔记名 + key」，老镜像名只有笔记名", () => {
    assert.deepEqual(parseSidecarName(SIDECAR_PATH), { name: "笔记", key: NOTE_KEY });
    assert.deepEqual(parseSidecarName(LEGACY_SIDECAR_PATH), { name: "笔记" });
    assert.deepEqual(parseSidecarName(`_workflowwatcher/a~b~${NOTE_KEY}.wf.json`), { name: "a~b", key: NOTE_KEY });
    // 名字里本来就有 `~` 时不被误拆
    assert.deepEqual(parseSidecarName("_workflowwatcher/a~b.wf.json"), { name: "a~b" });
    assert.equal(parseSidecarName("_workflowwatcher/a.json"), undefined);
    assert.equal(parseSidecarName("A/B/笔记.md"), undefined);
  });

  test("notePathForSidecar：只对老镜像路径可逆（扁平名带哈希，反查不出笔记路径）", () => {
    assert.equal(notePathForSidecar(LEGACY_SIDECAR_PATH), NOTE_PATH);
    assert.equal(notePathForSidecar("_workflowwatcher/笔记.wf.json"), "笔记.md");
    assert.equal(notePathForSidecar(SIDECAR_PATH), undefined);
    assert.equal(notePathForSidecar("A/B/笔记.md"), undefined);
    assert.equal(notePathForSidecar("_workflowwatcher/笔记.json"), undefined);
  });

  test("parentFolderOf / normalizeVaultPath：逐级建目录用", () => {
    assert.equal(parentFolderOf(LEGACY_SIDECAR_PATH), "_workflowwatcher/A/B");
    assert.equal(parentFolderOf(SIDECAR_PATH), "_workflowwatcher");
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
    // Phase 27：超链接只从 JSON 的 links[] 读，正文不再解析纪要段
    assert.deepEqual(result.document?.workflows[0].root.links?.map((link) => link.target), [
      "竞品分析报告",
      "https://example.com",
      "竞品截图.png",
    ]);
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

  test("writeBackNote：不写代码块 / 不写纪要段，只补 frontmatter，且幂等", () => {
    const { note } = splitFixture();
    const document = analyzeMarkdown(validMarkdown()).latestDocument as WfJsonDocument;

    const written = writeBackNote(note, document, { now: NOW });
    assert.equal(inspectWfJsonBlocks(written.markdown).found, false);
    assert.ok(written.markdown.includes("wf-status:"));
    assert.ok(written.markdown.includes("wf-updated: 2026-10-10"));
    // Phase 27：纪要段范式弃用 —— 写回不再生成任何成对段
    assert.equal(written.markdown.includes("wf-note:begin:"), false);
    assert.equal(written.markdown.includes("（纪要待补充）"), true, "旧正文原样保留（插件不删人写内容）");

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
  test("成功：扁平侧车 + 落盘升格 + 笔记不再有代码块 + 身份键两处齐备", () => {
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
    // M1.6：身份键同时进 JSON 与 frontmatter
    assert.equal(parsed.noteKey, NOTE_KEY);
    assert.ok(plan.noteMarkdown.includes(`wf-key: ${NOTE_KEY}`));
    // Phase 27：links[] 原地留在 JSON 里（不再迁进正文纪要段）
    assert.equal(JSON.stringify(parsed).includes('"links"'), true);
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

  test("M1.6：写回按当前路径钉身份键（JSON 的 noteKey + frontmatter 的 wf-key）", () => {
    const { note, jsonText } = splitFixture();
    const result = applySidecarMutation(note, jsonText, setSummary, {
      now: NOW,
      file: NOTE_PATH,
      jsonFile: SIDECAR_PATH,
    });

    assert.equal(result.success, true);
    assert.equal((JSON.parse(result.jsonText as string) as WfJsonDocument).noteKey, NOTE_KEY);
    assert.ok(result.markdown.includes(`wf-key: ${NOTE_KEY}`));
    // 再跑一次（同一路径）→ 逐字节不变：key 是幂等的
    const again = applySidecarMutation(result.markdown, result.jsonText as string, setSummary, {
      now: NOW,
      file: NOTE_PATH,
      jsonFile: SIDECAR_PATH,
    });
    assert.equal(again.jsonText, result.jsonText);
    assert.equal(again.markdown, result.markdown);
    // 换一个路径（= 改名 / 移动）→ key 跟着变，绝不沿用旧值
    const moved = applySidecarMutation(result.markdown, result.jsonText as string, setSummary, {
      now: NOW,
      file: "A/B/笔记-改名.md",
      jsonFile: SIDECAR_PATH,
    });
    assert.equal(
      (JSON.parse(moved.jsonText as string) as WfJsonDocument).noteKey,
      noteKeyFor("A/B/笔记-改名.md"),
    );
    assert.ok(moved.markdown.includes(`wf-key: ${noteKeyFor("A/B/笔记-改名.md")}`));
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

  test("Phase 27：归档写回不往笔记里写归档行，JSON 里也不写 archive.file", () => {
    const { note, jsonText } = splitFixture();
    const result = applySidecarMutation(
      note,
      jsonText,
      (document) => {
        const node = findNode(document, DOING_ID);
        if (!node) return { reject: "节点不存在" };
        node.archive = { workflowId: "wf-archived" };
        return {
          changedNodeIds: [DOING_ID],
          // 旧调用方还会传 mergeNoteSections —— Phase 27 起被忽略
          mergeNoteSections: [
            { targetNodeId: DOING_ID, lines: [renderArchiveNoteLine("archive/wf-archived-nd-x.md", "收敛")] },
          ],
        };
      },
      { now: NOW, file: NOTE_PATH, jsonFile: SIDECAR_PATH },
    );

    assert.equal(result.success, true, result.reason ?? "写回应当成功");
    assert.equal(result.markdown.includes("归档："), false, "笔记正文不再出现归档地址行");
    assert.equal(extractArchiveReference(result.markdown), undefined);
    assert.equal(result.jsonText?.includes('"file"'), false, "JSON 里不再写 archive.file");
    const parsed = JSON.parse(result.jsonText) as WfJsonDocument;
    assert.equal(findNode(parsed, DOING_ID)?.archive?.workflowId, "wf-archived", "归档身份挂在 archive.workflowId");
    assert.equal(result.analysis.counts.error, 0);
  });
});


describe("sidecar · planSidecarPair（成对形态：md + 侧车）", () => {
  test("拆成「无代码块的 md + 规范化 JSON」，侧车是第一层的扁平名", () => {
    const markdown = validMarkdown();
    const document = analyzeMarkdown(markdown).latestDocument as WfJsonDocument;
    const archivePath = "archive/wf-1-nd-2.md";

    const pair = planSidecarPair(archivePath, markdown, document);

    assert.equal(pair.sidecarPath, sidecarPathFor(archivePath));
    assert.equal(parentFolderOf(pair.sidecarPath), "_workflowwatcher");
    assert.equal(pair.removedBlocks, 1);
    assert.equal(inspectWfJsonBlocks(pair.noteMarkdown).found, false);
    // 正文该留的都留着：frontmatter 摘要 + 正文纪要段
    assert.ok(pair.noteMarkdown.includes("wf-status:"));
    assert.ok(pair.noteMarkdown.includes("# 立项调查"));
    // M1.6：JSON 里钉上身份键，但传入的文档本身不被改（纯函数）
    assert.equal(pair.jsonText, stringifyWfJson({ ...document, noteKey: noteKeyFor(archivePath) }));
    assert.equal(document.noteKey, undefined);
    // 笔记 frontmatter 也带上同一个键（归档 md 与主文件同构）
    assert.ok(pair.noteMarkdown.includes(`wf-key: ${noteKeyFor(archivePath)}`));
  });

  test("已经是成对形态 → removedBlocks = 0，noteMarkdown 逐字节不变（幂等）", () => {
    const document = analyzeMarkdown(validMarkdown()).latestDocument as WfJsonDocument;
    const first = planSidecarPair("archive/a.md", validMarkdown(), document);
    const again = planSidecarPair("archive/a.md", first.noteMarkdown, document);

    assert.equal(again.removedBlocks, 0);
    assert.equal(again.noteMarkdown, first.noteMarkdown);
    assert.equal(again.jsonText, first.jsonText);
  });

  test("拆出来的两件产物能被侧车模式读回（零 issue）", () => {
    const document = analyzeMarkdown(validMarkdown()).latestDocument as WfJsonDocument;
    const pair = planSidecarPair("archive/a.md", validMarkdown(), document);

    const analysis = analyzeDocument({
      noteMarkdown: pair.noteMarkdown,
      jsonText: pair.jsonText,
      jsonSource: "sidecar",
      jsonFile: pair.sidecarPath,
      file: "archive/a.md",
    });

    assert.equal(analysis.hasIssue, false, JSON.stringify(analysis.issues));
    assert.equal(analysis.jsonSource, "sidecar");
    assert.equal(analysis.document?.workflows.length, 2);
  });
});

