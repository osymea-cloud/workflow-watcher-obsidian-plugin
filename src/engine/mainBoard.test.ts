/**
 * 主看板命名（Phase 25）单测：`_workflowwatcher/main~<key>.md` + `main~<key>.wf.json`。
 *
 * 关注点（都是纯字符串规则，不碰 vault）：
 *  - md 与它的侧车**同名同键、只差扩展名** → 用户一眼看出是一对；
 *  - 键是**常量**（由基准路径算出），落在 md 名 / json 名 / JSON 的 `noteKey` / frontmatter 的 `wf-key` 四处；
 *  - 键**幂等**：名字里已经带键时 `noteKeyFor` / `sidecarPathFor` / `backupPathFor` 不再补第二个键；
 *  - 老命名 `main.md` 与新命名算出来的是**同一份侧车与同一份备份**（升级不搬数据）；
 *  - 多份「像主看板」的 md → 规范名永远排第一（插件只开第一份 + 提示）；
 *  - 用户自己的笔记（`mainly.md` / `xmain.md` / 别的目录的 `main.md`）不算主看板。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  isMainBoardCandidate,
  isMainBoardPath,
  LEGACY_MAIN_BOARD_PATH,
  MAIN_BOARD_BASE_PATH,
  MAIN_BOARD_KEY,
  MAIN_BOARD_PATH,
  MAIN_BOARD_SIDECAR_PATH,
  MAIN_BOARD_STEM,
  rankMainBoardPaths,
} from "./mainBoard.ts";
import { backupPathFor, noteKeyFor, parseSidecarName, planSidecarPair, sidecarPathFor } from "./sidecar.ts";
import { buildTemplateDocument } from "./template.ts";
import { SCHEMA_VERSION, WFJSON_BACKUP_FOLDER } from "./types.ts";

const KEY_PATTERN = /^[0-9a-f]{10}$/;

describe("mainBoard · 主看板命名（md 与侧车同名同键）", () => {
  test("常量：键是 10 位十六进制、md 名里带同一个键", () => {
    assert.equal(MAIN_BOARD_STEM, "main");
    assert.match(MAIN_BOARD_KEY, KEY_PATTERN);
    // 键由「基准路径」（不带键的 main.md）算出 —— 不能由带键的文件名自己算（那就循环了）
    assert.equal(MAIN_BOARD_KEY, noteKeyFor(MAIN_BOARD_BASE_PATH));
    assert.equal(MAIN_BOARD_PATH, `_workflowwatcher/main~${MAIN_BOARD_KEY}.md`);
    assert.equal(LEGACY_MAIN_BOARD_PATH, "_workflowwatcher/main.md");
    assert.equal(MAIN_BOARD_BASE_PATH, LEGACY_MAIN_BOARD_PATH);
  });

  test("md 与侧车同名同键、只差扩展名；键幂等（不再补第二个键）", () => {
    const stem = `_workflowwatcher/main~${MAIN_BOARD_KEY}`;
    assert.equal(MAIN_BOARD_SIDECAR_PATH, `${stem}.wf.json`);
    // 侧车路径就是 md 路径换扩展名 —— 这正是「一眼看出是一对」的凭据
    assert.equal(sidecarPathFor(MAIN_BOARD_PATH), MAIN_BOARD_SIDECAR_PATH);
    assert.equal(MAIN_BOARD_PATH.slice(0, -".md".length), stem);
    // 幂等：带键的名字再算一次还是同一个键（不会变成 main~K~K2）
    assert.equal(noteKeyFor(MAIN_BOARD_PATH), MAIN_BOARD_KEY);
    assert.equal(parseSidecarName(MAIN_BOARD_SIDECAR_PATH)?.key, MAIN_BOARD_KEY);
    assert.equal(parseSidecarName(MAIN_BOARD_SIDECAR_PATH)?.name, MAIN_BOARD_STEM);
    // 老命名（不带键）算出来的侧车与新命名是**同一份** → 升级改名不搬数据
    assert.equal(sidecarPathFor(LEGACY_MAIN_BOARD_PATH), MAIN_BOARD_SIDECAR_PATH);
    assert.equal(noteKeyFor(LEGACY_MAIN_BOARD_PATH), MAIN_BOARD_KEY);
  });

  test("planSidecarPair：JSON 的 noteKey 与 frontmatter 的 wf-key 都是同一个键", () => {
    const now = new Date("2026-01-01T00:00:00Z");
    const pair = planSidecarPair(MAIN_BOARD_PATH, "（模板）\n", buildTemplateDocument({ now }));
    assert.equal(pair.sidecarPath, MAIN_BOARD_SIDECAR_PATH);
    const json = JSON.parse(pair.jsonText) as { noteKey?: string; schemaVersion?: string };
    assert.equal(json.noteKey, MAIN_BOARD_KEY);
    assert.equal(json.schemaVersion, SCHEMA_VERSION);
    assert.match(pair.noteMarkdown, new RegExp(`wf-key: ${MAIN_BOARD_KEY}`));
  });

  test("备份镜像：md 副本与 json 副本同名同键，老命名与新命名落到同一个副本", () => {
    assert.equal(backupPathFor(MAIN_BOARD_PATH), `${WFJSON_BACKUP_FOLDER}/main~${MAIN_BOARD_KEY}.md.bak`);
    assert.equal(backupPathFor(MAIN_BOARD_PATH), backupPathFor(LEGACY_MAIN_BOARD_PATH));
    assert.equal(backupPathFor(MAIN_BOARD_SIDECAR_PATH), `${WFJSON_BACKUP_FOLDER}/main~${MAIN_BOARD_KEY}.wf.json.bak`);
  });

  test("isMainBoardPath：新老两种命名算，别的不算", () => {
    assert.equal(isMainBoardPath(MAIN_BOARD_PATH), true);
    assert.equal(isMainBoardPath(LEGACY_MAIN_BOARD_PATH), true);
    assert.equal(isMainBoardPath("_workflowwatcher/main_2.md"), false);
    assert.equal(isMainBoardPath("A/main.md"), false);
    assert.equal(isMainBoardPath(MAIN_BOARD_SIDECAR_PATH), false);
    assert.equal(isMainBoardPath(`backup/main~${MAIN_BOARD_KEY}.md.bak`), false);
  });

  test("isMainBoardCandidate：只认 `main` + 分隔符 / 结尾，且必须是 md", () => {
    for (const path of [
      MAIN_BOARD_PATH,
      LEGACY_MAIN_BOARD_PATH,
      "_workflowwatcher/main_2.md",
      "_workflowwatcher/main-2.md",
      "_workflowwatcher/main (2).md",
      "_workflowwatcher/main 2.md",
      "_workflowwatcher/main~0123456789.md",
    ]) {
      assert.equal(isMainBoardCandidate(path), true, path);
    }
    for (const path of [
      "_workflowwatcher/mainly.md", // 前缀撞车
      "_workflowwatcher/maintenance.md",
      "A/xmain.md",
      "_workflowwatcher/main~0123456789.wf.json", // 侧车不是候选
      `backup/main~${MAIN_BOARD_KEY}.md.bak`, // 备份不是候选
      "_workflowwatcher/main2.md", // 没有分隔符 → 是别人的笔记
    ]) {
      assert.equal(isMainBoardCandidate(path), false, path);
    }
  });

  test("rankMainBoardPaths：规范名第一、老命名第二、其余按字母序，去重且剔除无关文件", () => {
    const paths = [
      "_workflowwatcher/main_2.md",
      "_workflowwatcher/other.md",
      "_workflowwatcher/main~0123456789.wf.json",
      LEGACY_MAIN_BOARD_PATH,
      MAIN_BOARD_PATH,
      `backup/main~${MAIN_BOARD_KEY}.md.bak`,
      "_workflowwatcher/main_2.md", // 重复项
    ];
    assert.deepEqual(rankMainBoardPaths(paths), [
      MAIN_BOARD_PATH,
      LEGACY_MAIN_BOARD_PATH,
      "_workflowwatcher/main_2.md",
    ]);
    // 反斜杠 / `./` 也认（Windows 粘贴来的路径）
    assert.deepEqual(rankMainBoardPaths(["_workflowwatcher\\main_2.md", "./_workflowwatcher/main.md"]), [
      LEGACY_MAIN_BOARD_PATH,
      "_workflowwatcher/main_2.md",
    ]);
    // 一份都没有 → 空数组（调用方据此现造模板）
    assert.deepEqual(rankMainBoardPaths([]), []);
    assert.deepEqual(rankMainBoardPaths(["_workflowwatcher/other.md"]), []);
  });
});
