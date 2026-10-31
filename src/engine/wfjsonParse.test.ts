/**
 * wfjson 代码块抽取与严格 JSON 解析的单测（node --test 直接跑 .ts）。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  extractWfJsonBlock,
  lineColumnAt,
  locateJsonError,
  parseWfJsonBlock,
  scanStrictJson,
  textLineAt,
} from "./wfjsonParse.ts";
import { validDocument, wfjsonBlockOnly } from "./testFixtures.ts";
import { issuesWithCode } from "./issues.ts";

const block = (json: string): string => `# 笔记\n\n\`\`\`wfjson\n${json}\n\`\`\`\n`;

describe("parseWfJsonBlock · 代码块定位", () => {
  test("正常块：found=true、能解析、lineBase 指向内容首行", () => {
    const markdown = wfjsonBlockOnly();
    const result = parseWfJsonBlock(markdown);
    assert.equal(result.found, true);
    assert.equal(result.issues.length, 0);
    assert.equal(result.lineBase, 4); // 第 3 行是围栏，第 4 行是 `{`
    assert.equal(result.block?.closed, true);
    assert.deepEqual(result.value, validDocument());
  });

  test("没有 wfjson 代码块：info 级提示且不解析", () => {
    const result = parseWfJsonBlock("# 普通笔记\n\n正文。\n");
    assert.equal(result.found, false);
    assert.equal(result.value, undefined);
    assert.equal(result.lineBase, 1);
    assert.equal(result.issues.length, 1);
    assert.equal(result.issues[0].code, "NO_WFJSON_BLOCK");
    assert.equal(result.issues[0].severity, "info");
  });

  test("多个代码块：报 MULTIPLE_WFJSON_BLOCKS 且用第一个块解析", () => {
    const markdown = `${block('{"a":1}')}\n${block('{"b":2}')}`;
    const result = parseWfJsonBlock(markdown);
    assert.equal(result.found, true);
    assert.deepEqual(result.value, { a: 1 });
    const duplicates = issuesWithCode(result.issues, "MULTIPLE_WFJSON_BLOCKS");
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0].severity, "error");
  });

  test("未闭合：报 WFJSON_BLOCK_UNCLOSED，且原文被当作内容", () => {
    const markdown = "```wfjson\n{ \"a\": 1 }\n";
    const result = parseWfJsonBlock(markdown);
    assert.equal(result.found, true);
    assert.deepEqual(result.value, { a: 1 });
    assert.equal(issuesWithCode(result.issues, "WFJSON_BLOCK_UNCLOSED").length, 1);
  });

  test("extractWfJsonBlock 返回 frontmatter 与 blocks 列表", () => {
    const extraction = extractWfJsonBlock(`${"---\nwf-status: doing\n---\n"}\n${block('{"a":1}')}`);
    assert.equal(extraction.frontmatter.present, true);
    assert.equal(extraction.frontmatter.getString("wf-status"), "doing");
    assert.equal(extraction.blocks.length, 1);
    assert.equal(extraction.block?.lang, "wfjson");
    assert.equal(extraction.issues.length, 0);
  });
});

describe("scanStrictJson · 严格性预扫描", () => {
  test("BOM：warning 且自动剥离", () => {
    const scan = scanStrictJson("\uFEFF{ \"a\": 1 }", 7);
    assert.equal(scan.hadBom, true);
    assert.equal(scan.hasBlockingError, false);
    assert.equal(scan.text, '{ "a": 1 }');
    assert.equal(scan.issues[0].code, "JSON_BOM");
    assert.equal(scan.issues[0].line, 7);
  });

  test("行注释 / 块注释：报行列，且阻断后续解析", () => {
    const scan = scanStrictJson('{\n  // 注释\n  "a": 1\n}', 10);
    assert.equal(scan.hasBlockingError, true);
    const comments = scan.issues.filter((item) => item.code === "JSON_COMMENT_NOT_ALLOWED");
    assert.equal(comments.length, 1);
    assert.equal(comments[0].line, 11); // lineBase + 1

    const blockComment = scanStrictJson('{ /* 说明 */ "a": 1 }', 1);
    assert.equal(issuesWithCode(blockComment.issues, "JSON_COMMENT_NOT_ALLOWED").length, 1);

    // 字符串里的 http:// 不算注释
    const inString = scanStrictJson('{ "a": "https://example.com" }', 1);
    assert.equal(inString.hasBlockingError, false);
    assert.equal(inString.issues.length, 0);
  });

  test("尾随逗号：报出逗号所在行列", () => {
    const scan = scanStrictJson('{\n  "a": 1,\n}', 3);
    assert.equal(scan.hasBlockingError, true);
    const trailing = scan.issues.filter((item) => item.code === "JSON_TRAILING_COMMA");
    assert.equal(trailing.length, 1);
    assert.equal(trailing[0].line, 4);
    assert.equal(trailing[0].severity, "error");
  });

  test("字符串数组 / 字符串值：逗号在字符串前不算尾随逗号（回归）", () => {
    // 侥幸案例：`["a", "b"]` 的最后一个元素是字符串，`]` 前面那个逗号是分隔符
    const stringArray = scanStrictJson('{ "tags": ["示例", "MVP"] }', 1);
    assert.equal(issuesWithCode(stringArray.issues, "JSON_TRAILING_COMMA").length, 0);
    assert.equal(stringArray.hasBlockingError, false);

    // 字符串值：`{"a": 1, "b": "x"}`
    const stringValue = scanStrictJson('{ "a": 1, "b": "x" }', 1);
    assert.equal(stringValue.issues.length, 0);

    // 真·尾随逗号仍然要抓到（数组 / 对象各一）
    const realArray = scanStrictJson('["a","b",]', 1);
    assert.equal(issuesWithCode(realArray.issues, "JSON_TRAILING_COMMA").length, 1);
    const realObject = scanStrictJson('{ "a": "b", }', 1);
    assert.equal(issuesWithCode(realObject.issues, "JSON_TRAILING_COMMA").length, 1);
  });
});


describe("parseWfJsonBlock · 语法错误定位", () => {
  test("缺引号：报 JSON_PARSE_ERROR，带文件行号与原文", () => {
    const result = parseWfJsonBlock(block('{\n  "a": 1,\n  b: 2\n}'));
    assert.equal(result.value, undefined);
    const errors = issuesWithCode(result.issues, "JSON_PARSE_ERROR");
    assert.equal(errors.length, 1);
    assert.equal(errors[0].severity, "error");
    assert.ok((errors[0].line ?? 0) >= 4, `行号应落在代码块内，实际 ${errors[0].line}`);
    assert.ok((errors[0].details ?? []).length > 0);
  });

  test("拖尾逗号：只报精确定位的问题，不再叠加含糊的语法错误", () => {
    const result = parseWfJsonBlock(block('{\n  "a": 1,\n}'));
    assert.equal(result.value, undefined);
    assert.equal(issuesWithCode(result.issues, "JSON_TRAILING_COMMA").length, 1);
    assert.equal(issuesWithCode(result.issues, "JSON_PARSE_ERROR").length, 0);
  });

  test("代码块内容为空：报 JSON_PARSE_ERROR", () => {
    const result = parseWfJsonBlock("# 笔记\n\n```wfjson\n\n```\n");
    assert.equal(result.found, true);
    assert.equal(issuesWithCode(result.issues, "JSON_PARSE_ERROR").length, 1);
  });

  test("合法 JSON 但内容不是对象也能解析（Schema 层再拦）", () => {
    const result = parseWfJsonBlock(block("[]"));
    assert.deepEqual(result.value, []);
    assert.equal(result.issues.length, 0);
  });
});

describe("行/列与错误定位工具", () => {
  test("lineColumnAt：1 基行列", () => {
    const text = "ab\ncde\nf";
    assert.deepEqual(lineColumnAt(text, 0), { line: 1, column: 1 });
    assert.deepEqual(lineColumnAt(text, 3), { line: 2, column: 1 });
    assert.deepEqual(lineColumnAt(text, 5), { line: 2, column: 3 });
    assert.deepEqual(lineColumnAt(text, 99), { line: 3, column: 2 });
  });

  test("textLineAt：1 基取行，越界返回空串", () => {
    assert.equal(textLineAt("a\nb", 2), "b");
    assert.equal(textLineAt("a\nb", 5), "");
  });

  test("locateJsonError：兼容 V8 的两种报错格式", () => {
    assert.deepEqual(locateJsonError("Unexpected token } in JSON at position 12"), { offset: 12 });
    assert.deepEqual(locateJsonError("Unexpected token } in JSON (line 3 column 5)"), {
      line: 3,
      column: 5,
    });
    assert.deepEqual(locateJsonError("没有任何位置信息"), {});
  });
});
