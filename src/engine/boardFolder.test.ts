/**
 * Phase 37：可配置的「看板文件目录」（`boardFolder`）。
 *
 * 引擎里所有路径函数都读 `boardFolderOf()`（模块级状态，与 `i18n` 的 `currentLang` 同一套模式），
 * 所以这里先把目录切到 `workflows/` 再断言：侧车 / 备份 / 主看板 / 归档都跟着走。
 * 每个用例收尾都 `setBoardFolder(undefined)` 复位（模块状态会串到别的测试文件）。
 */

import { afterEach, describe, test } from "node:test";
import assert from "node:assert/strict";

import { archiveFilePathFor, archiveFolderOf } from "./archive.ts";
import { MAIN_BOARD_KEY, isMainBoardPath, mainBoardPath, mainBoardSidecarPath } from "./mainBoard.ts";
import { backupPathFor, isBackupPath, isSidecarPath, sidecarPathFor } from "./sidecar.ts";
import { WFJSON_FOLDER, backupFolderOf, boardFolderOf, normalizeBoardFolder, setBoardFolder } from "./types.ts";

afterEach(() => {
  setBoardFolder(undefined);
});

describe("boardFolder · 目录规范化", () => {
  test("默认是出厂值；备份目录跟它走", () => {
    assert.equal(boardFolderOf(), WFJSON_FOLDER);
    assert.equal(backupFolderOf(), `${WFJSON_FOLDER}/backup`);
  });

  test("normalizeBoardFolder：空白 / 反斜杠 / 首尾斜杠都收干净，空串回落默认", () => {
    assert.equal(normalizeBoardFolder("  workflows/notes  "), "workflows/notes");
    assert.equal(normalizeBoardFolder("\\workflows\\\\notes\\"), "workflows/notes");
    assert.equal(normalizeBoardFolder("//workflows//notes//"), "workflows/notes");
    assert.equal(normalizeBoardFolder(""), WFJSON_FOLDER);
    assert.equal(normalizeBoardFolder("   "), WFJSON_FOLDER);
    assert.equal(normalizeBoardFolder(undefined), WFJSON_FOLDER);
    assert.equal(normalizeBoardFolder(42), WFJSON_FOLDER);
  });

  test("setBoardFolder 落的是规范化后的值", () => {
    setBoardFolder("  /workflows/  ");
    assert.equal(boardFolderOf(), "workflows");
  });
});

describe("boardFolder · 路径函数跟着目录走", () => {
  test("侧车 / 备份 / 判断函数都换到新目录", () => {
    setBoardFolder("workflows");
    assert.equal(sidecarPathFor("A/B/笔记.md").startsWith("workflows/"), true);
    assert.equal(sidecarPathFor("A/B/笔记.md").includes("_workflowwatcher"), false);

    const backup = backupPathFor("_workflowwatcher/main~0123456789.md");
    assert.equal(backup.startsWith("workflows/backup/"), true);
    assert.equal(isBackupPath(backup), true);

    assert.equal(isSidecarPath("workflows/main.md"), true);
    assert.equal(isBackupPath("workflows/backup/x.md.bak"), true);
    // 老目录不再算「侧车路径」：新数据一个都不该落回去
    assert.equal(isSidecarPath("_workflowwatcher/main.md"), false);
  });

  test("主看板：文件名不变（键是常量），只换所在目录", () => {
    setBoardFolder("workflows");
    assert.equal(mainBoardPath(), `workflows/main~${MAIN_BOARD_KEY}.md`);
    assert.equal(mainBoardSidecarPath(), `workflows/main~${MAIN_BOARD_KEY}.wf.json`);
    assert.equal(isMainBoardPath(mainBoardPath()), true);
    // 老命名也算主看板（打开时会被改名成带键的那份）
    assert.equal(isMainBoardPath("workflows/main.md"), true);
    // 默认目录下的那份不再算这个看板的主看板
    assert.equal(isMainBoardPath(`_workflowwatcher/main~${MAIN_BOARD_KEY}.md`), false);
  });

  test("归档目录 = <boardFolder>/archive", () => {
    setBoardFolder("workflows");
    assert.equal(archiveFolderOf(), "workflows/archive");
    assert.equal(archiveFilePathFor("wf", "nd", "nd-1", new Date(2026, 0, 5, 9, 7, 8)), "workflows/archive/wf-nd-20260105-090708-1000000000000000.wf.json");
  });
});
