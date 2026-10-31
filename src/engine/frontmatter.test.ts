/**
 * frontmatter.ts 单测（`setFrontmatterField`：v0.7 §⑨-7 的主题单键写入）。
 *
 * 关键口径：**只按行改这一个键**，其余字段（含插件不认识的、非严格 YAML 写法、
 * 注释、空行）一字不动；换行风格与 BOM 原样保留。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { parseFrontmatter, setFrontmatterField } from "./frontmatter.ts";

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
