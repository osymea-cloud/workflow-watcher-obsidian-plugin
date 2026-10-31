/**
 * 内存升格（upgrade.ts）+ analyzeMarkdown 只读升格的单测。
 * 关注点：版本改写 + v1.6 迁移（补 progress 默认值 / importance 5→4）、幂等、深拷贝（不污染输入）、
 * 白名单外不猜语义、绝不落盘。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { analyzeMarkdown } from "./analyze.ts";
import { clone, validDocument, validDocument11, validDocument13, validMarkdown, validMarkdown11, validMarkdown13 } from "./testFixtures.ts";
import { SCHEMA_VERSION, SUPPORTED_SCHEMA_VERSIONS } from "./types.ts";
import { upgradeDocument } from "./upgrade.ts";

describe("upgrade · 内存升格", () => {
  test("白名单并列支持 1.0 / 1.1 / 1.3 / 1.6 / 1.9，当前版本为 1.9（跳过 1.2 / 1.4 / 1.5 / 1.7 / 1.8）", () => {
    assert.deepEqual([...SUPPORTED_SCHEMA_VERSIONS], ["1.0", "1.1", "1.3", "1.6", "1.9"]);
    assert.equal(SCHEMA_VERSION, "1.9");
  });

  test("1.0 → 1.9：改写版本 + 补 progress / progress_max 默认值，不新增时间 / 归档字段", () => {
    const document = validDocument();
    const result = upgradeDocument(document);

    assert.equal(result.upgraded, true);
    assert.equal(result.from, "1.0");
    assert.equal(result.document.schemaVersion, "1.9");
    assert.equal("state" in result.document.workflows[0], false);
    assert.equal("originId" in result.document.workflows[0], false);
    assert.equal("timeEntries" in result.document.workflows[0].root, false);
    assert.equal("archive" in result.document.workflows[0].root, false);

    const leaf = result.document.workflows[0].root.children[0];
    assert.equal(leaf.progress, 0);
    assert.equal(leaf.progress_max, 1);
  });

  test("1.1 → 1.9：同样改写版本并补进度默认值（老数据没有计时 / 归档）", () => {
    const document = validDocument11();
    const result = upgradeDocument(document);

    assert.equal(result.upgraded, true);
    assert.equal(result.from, "1.1");
    assert.equal(result.document.schemaVersion, "1.9");
    assert.equal(result.document.workflows[1].state, "archived");
    assert.equal("timeEntries" in result.document.workflows[0].root, false);
  });

  test("1.3 → 1.9：已有 progress 原样保留，缺 progress_max 的补 1", () => {
    const result = upgradeDocument(validDocument13());

    assert.equal(result.from, "1.3");
    assert.equal(result.document.schemaVersion, "1.9");
    for (const workflow of result.document.workflows) {
      assert.equal(typeof workflow.root.progress, "number");
      assert.equal(typeof workflow.root.progress_max, "number");
    }
  });

  test("1.6 → 1.9：只改写版本，links / links_relative_path 原样保留（deprecated 但仍可读）", () => {
    const document = clone(validDocument());
    document.schemaVersion = "1.6";
    document.workflows[0].root.links = [{ id: "lk-1", type: "web", target: "https://example.com" }];
    document.workflows[0].root.links_relative_path = "notes/old.md";

    const result = upgradeDocument(document);

    assert.equal(result.upgraded, true);
    assert.equal(result.from, "1.6");
    assert.equal(result.document.schemaVersion, "1.9");
    assert.equal(result.document.workflows[0].root.links?.[0]?.id, "lk-1");
    assert.equal(result.document.workflows[0].root.links_relative_path, "notes/old.md");
    assert.equal(document.schemaVersion, "1.6", "不改输入对象");
  });

  test("importance / urgency 5 → 4 夹取（越界值收敛到 1-4）", () => {
    const document = clone(validDocument());
    document.workflows[0].root.importance = 5;
    document.workflows[0].root.urgency = 5;
    document.workflows[0].root.children[0].importance = 9;

    const result = upgradeDocument(document);
    assert.equal(result.document.workflows[0].root.importance, 4);
    assert.equal(result.document.workflows[0].root.urgency, 4);
    assert.equal(result.document.workflows[0].root.children[0].importance, 4);
  });

  test("升格产物是新对象：改它不会污染输入", () => {
    const document = validDocument();
    const result = upgradeDocument(document);

    result.document.workflows[0].title = "被改坏";
    assert.equal(document.workflows[0].title, "立项调查");
    assert.equal(document.schemaVersion, "1.0");
  });

  test("幂等：升格结果再升格 = no-op（同一引用，内容一致）", () => {
    const first = upgradeDocument(validDocument());
    const second = upgradeDocument(first.document);

    assert.equal(second.upgraded, false);
    assert.equal(second.from, "1.9");
    assert.equal(second.document, first.document);
    assert.deepEqual(upgradeDocument(second.document).document, first.document);
  });

  test("已是最新版：原样返回（同一引用）", () => {
    const document = upgradeDocument(validDocument13()).document;
    const result = upgradeDocument(document);

    assert.equal(result.upgraded, false);
    assert.equal(result.document, document);
  });

  test("白名单外的版本：不猜语义，原样返回", () => {
    const document = clone(validDocument());
    document.schemaVersion = "9.9";
    const result = upgradeDocument(document);

    assert.equal(result.upgraded, false);
    assert.equal(result.document, document);
    assert.equal(result.document.schemaVersion, "9.9");
  });
});

describe("upgrade · analyzeMarkdown 的只读升格", () => {
  test("1.0 文件：document 保留原版本，latestDocument 升到 1.9，正文/文本不被改写", () => {
    const markdown = validMarkdown();
    const result = analyzeMarkdown(markdown);

    assert.equal(result.document?.schemaVersion, "1.0");
    assert.equal(result.latestDocument?.schemaVersion, "1.9");
    assert.equal(result.latestDocument?.workflows.length, 2);
    assert.equal(result.upgradedFrom, "1.0");
    assert.ok(result.parse.text.includes('"schemaVersion": "1.0"'));
  });

  test("1.1 文件：latestDocument 升到 1.9（未落盘），document 仍是 1.1", () => {
    const result = analyzeMarkdown(validMarkdown11());

    assert.equal(result.document?.schemaVersion, "1.1");
    assert.equal(result.latestDocument?.schemaVersion, "1.9");
    assert.equal(result.upgradedFrom, "1.1");
    assert.ok(result.parse.text.includes('"schemaVersion": "1.1"'));
  });

  test("1.3 文件：latestDocument 升到 1.9（未落盘），document 仍是 1.3", () => {
    const result = analyzeMarkdown(validMarkdown13());

    assert.equal(result.document?.schemaVersion, "1.3");
    assert.equal(result.latestDocument?.schemaVersion, "1.9");
    assert.equal(result.upgradedFrom, "1.3");
  });

  test("结构非法时不提供 document / latestDocument", () => {
    const result = analyzeMarkdown("```wfjson\n{\n}\n```\n");

    assert.equal(result.document, undefined);
    assert.equal(result.latestDocument, undefined);
    assert.equal(result.upgradedFrom, undefined);
  });
});