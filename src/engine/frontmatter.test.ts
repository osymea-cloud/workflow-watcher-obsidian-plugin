/**
 * frontmatter.ts 单测（`setFrontmatterField`：v0.7 §⑨-7 的主题单键写入）。
 *
 * 关键口径：**只按行改这一个键**，其余字段（含插件不认识的、非严格 YAML 写法、
 * 注释、空行）一字不动；换行风格与 BOM 原样保留。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseFrontmatter, setFrontmatterField, setFrontmatterFieldList } from "./frontmatter.ts";

describe("frontmatter · setFrontmatterField", () => {
  test("有 frontmatter 且已有该键：原地改这一行，其余不动", () => {
    const before = [
      "---",
      "wf-status: doing",
      "wf-theme: nature",
      "# 注释行",
      "wf-tags: [a, b]",
      "---",
      "",
      "正文",
    ].join("\n");

    const after = setFrontmatterField(before, "wf-theme", "tech");
    assert.equal(after, before.replace("wf-theme: nature", "wf-theme: tech"));
  });

  test("有 frontmatter 但没有该键：插在结束行 `---` 之前", () => {
    const after = setFrontmatterField("---\nwf-status: doing\n---\n正文\n", "wf-theme", "tech");
    assert.equal(after, "---\nwf-status: doing\nwf-theme: tech\n---\n正文\n");
    assert.equal(parseFrontmatter(after).getString("wf-theme"), "tech");
  });

  test("没有 frontmatter：在文件头新建一段只含该键的 frontmatter", () => {
    const after = setFrontmatterField("# 标题\n正文\n", "wf-theme", "tech");
    assert.equal(after, "---\nwf-theme: tech\n---\n# 标题\n正文\n");
  });

  test("容忍非严格写法：`wf-tags: [a]` 后紧跟 `- b` 也不影响写 wf-theme", () => {
    const before = "---\nwf-tags: [a]\n- b\nwf-theme: nature\n---\n";
    assert.equal(
      setFrontmatterField(before, "wf-theme", "tech"),
      "---\nwf-tags: [a]\n- b\nwf-theme: tech\n---\n",
    );
  });

  test("value 为 undefined：删键（原值写成块序列时子项一起删）", () => {
    assert.equal(
      setFrontmatterField("---\nwf-theme: tech\na: 1\n---\n", "wf-theme", undefined),
      "---\na: 1\n---\n",
    );
    assert.equal(
      setFrontmatterField("---\nwf-theme:\n- x\n- y\na: 1\n---\n", "wf-theme", undefined),
      "---\na: 1\n---\n",
    );
    // 没有 frontmatter 时删除是空操作（正文里的同名行不是本插件的字段）
    assert.equal(setFrontmatterField("没有 frontmatter\n", "wf-theme", undefined), "没有 frontmatter\n");
  });

  test("CRLF 与 BOM 原样保留", () => {
    const after = setFrontmatterField("\uFEFF---\r\nwf-theme: nature\r\n---\r\n正文\r\n", "wf-theme", "tech");
    assert.equal(after, "\uFEFF---\r\nwf-theme: tech\r\n---\r\n正文\r\n");
  });

  test("需要引号的值（含空格 / 冒号）自动加双引号，仍能被解析回原值", () => {
    const after = setFrontmatterField("---\na: 1\n---\n", "wf-note", "带 空格: 的值");
    assert.equal(parseFrontmatter(after).getString("wf-note"), "带 空格: 的值");
  });
});

describe("frontmatter · setFrontmatterFieldList（Phase 35 多归属）", () => {
  test("0 项 → 删键（原值写成块序列时子项一起删）", () => {
    assert.equal(
      setFrontmatterFieldList("---\nwf-node:\n- 选书\n- 写书\na: 1\n---\n", "wf-node", []),
      "---\na: 1\n---\n",
    );
    // 没有 frontmatter 时删除是空操作（正文里的同名行不是本插件的字段）
    assert.equal(setFrontmatterFieldList("正文\n", "wf-node", []), "正文\n");
  });

  test("1 项 → 写成标量（老文件的单归属保持零差异）", () => {
    assert.equal(
      setFrontmatterFieldList("---\na: 1\n---\n", "wf-node", ["选书"]),
      "---\na: 1\nwf-node: \"选书\"\n---\n",
    );
    // 原本是多值行 → 压成标量
    assert.equal(
      setFrontmatterFieldList("---\nwf-node: [\"选书\", \"写书\"]\n---\n", "wf-node", ["写书"]),
      "---\nwf-node: \"写书\"\n---\n",
    );
  });

  test("多项 → 内联数组；空串写成 \"\" 占位，解析回来仍按下标对齐", () => {
    const after = setFrontmatterFieldList("---\na: 1\n---\n", "wf-node", ["选书", "", "写书"]);
    assert.equal(after, "---\na: 1\nwf-node: [\"选书\", \"\", \"写书\"]\n---\n");
    assert.deepEqual(parseFrontmatter(after).getArray("wf-node"), ["选书", "", "写书"]);
  });

  test("只改目标键：其余字段 / 注释 / BOM / 换行风格都不动", () => {
    const before = "\uFEFF---\r\n# 注释\r\nwf-node: 选书\r\nwf-workflow: 读书计划\r\n---\r\n正文\r\n";
    assert.equal(
      setFrontmatterFieldList(before, "wf-node", ["选书", "写书"]),
      "\uFEFF---\r\n# 注释\r\nwf-node: [\"选书\", \"写书\"]\r\nwf-workflow: 读书计划\r\n---\r\n正文\r\n",
    );
  });

  test("写进去再解析：每一项与写入值一致（含空格 / 冒号 / 空串）", () => {
    const values = ["普通", "带 空格", "带:冒号", ""];
    const after = setFrontmatterFieldList("---\n---\n", "wf-workflow", values);
    assert.deepEqual(parseFrontmatter(after).getArray("wf-workflow"), values);
  });
});
