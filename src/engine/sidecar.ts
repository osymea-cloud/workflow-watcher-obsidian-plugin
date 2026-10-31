/**
 * 外置 JSON（侧车）的路径约定与迁移（v0.7 §⑧）。
 *
 * 路径镜像：
 *   `A/B/笔记.md`  →  `_wfjson/A/B/笔记.wf.json`
 *   `笔记.md`      →  `_wfjson/笔记.wf.json`
 *
 * 为什么镜像而不是扁平化：重命名 / 移动笔记时侧车路径可**推导**（rename 事件里只需要
 * `sidecarPathFor(新路径)`）；同时同名的两份笔记（不同目录）不会互相覆盖。
 *
 * 本模块只做「路径 ↔ 路径」与「迁移计划」；真正落盘由 main.ts 用 vault API 完成
 * （引擎不依赖 obsidian，`node --test` 可直接跑）。
 */

import { analyzeDocument, analyzeMarkdown, type AnalyzeResult } from "./analyze.ts";
import { formatLocalIso } from "./time.ts";
import type { WfJsonDocument } from "./types.ts";
import { WFJSON_FOLDER } from "./types.ts";
import { upgradeDocument } from "./upgrade.ts";
import { removeWfJsonBlocks, stringifyWfJson, writeBackNote } from "./wfjsonWrite.ts";

/** 侧车文件扩展名（`.md` 之外再带一段，便于一眼看出是 wfjson 的 JSON） */
export const SIDECAR_EXTENSION = ".wf.json";

const MARKDOWN_EXTENSION = ".md";

/** vault 路径规范化：统一正斜杠、去掉开头的 `./` 与 `/`、压缩重复斜杠 */
export function normalizeVaultPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
}

/** 是否是外置 JSON 路径（`_wfjson` 目录下的所有文件） */
export function isSidecarPath(path: string): boolean {
  const normalized = normalizeVaultPath(path);
  return normalized === WFJSON_FOLDER || normalized.startsWith(`${WFJSON_FOLDER}/`);
}

/** 笔记路径 → 侧车路径（不检查文件是否存在） */
export function sidecarPathFor(notePath: string): string {
  const normalized = normalizeVaultPath(notePath);
  const base = normalized.toLowerCase().endsWith(MARKDOWN_EXTENSION)
    ? normalized.slice(0, -MARKDOWN_EXTENSION.length)
    : normalized;
  return `${WFJSON_FOLDER}/${base}${SIDECAR_EXTENSION}`;
}

/** 侧车路径 → 笔记路径（不是侧车路径时返回 undefined；用于「反查」与调试） */
export function notePathForSidecar(sidecarPath: string): string | undefined {
  if (!isSidecarPath(sidecarPath)) return undefined;
  const normalized = normalizeVaultPath(sidecarPath);
  const rest = normalized === WFJSON_FOLDER ? "" : normalized.slice(WFJSON_FOLDER.length + 1);
  if (!rest.toLowerCase().endsWith(SIDECAR_EXTENSION)) return undefined;
  return `${rest.slice(0, -SIDECAR_EXTENSION.length)}${MARKDOWN_EXTENSION}`;
}

/** 路径的父目录（顶层文件返回空串；插件用它逐级建目录） */
export function parentFolderOf(path: string): string {
  const normalized = normalizeVaultPath(path);
  const index = normalized.lastIndexOf("/");
  return index <= 0 ? "" : normalized.slice(0, index);
}

/* ------------------------------------------------------------------ *
 * 迁移：笔记内代码块 → 外置 JSON（手动命令触发，绝不自动改用户的笔记）
 * ------------------------------------------------------------------ */

export interface SidecarMigrationOptions {
  /** `updatedAt` / `wf-updated` 的基准时间（默认当前时间） */
  now?: Date;
}

export interface SidecarMigrationResult {
  /** 迁移计划是否可用（调用方据此决定是否落盘） */
  success: boolean;
  /** 本文件没有 wfjson 代码块（不需要迁移，不算失败） */
  skipped: boolean;
  /** 目标侧车路径（即使失败也给出，便于提示） */
  sidecarPath: string;
  /** 外置 JSON 文本（失败时为空串） */
  jsonText: string;
  /** 去掉代码块并补齐 frontmatter / 纪要段后的笔记文本（失败时为输入原文） */
  noteMarkdown: string;
  /**
   * 迁移后的内存文档（已升格、已迁移 `links[]`）。
   * 调用方在「计划之后笔记又被改动」时，可以用它 `writeBackNote` 再收敛一次。
   */
  document?: WfJsonDocument;
  changed: boolean;
  /** 是否顺带把旧版（1.0 / 1.1 / 1.3 / 1.6）落盘升格为最新版 */
  upgraded: boolean;
  reason?: string;
  /** 迁移后的校验结果（新笔记 + 外置 JSON 一起校验） */
  analysis: AnalyzeResult;
}

/**
 * 计算「把笔记里的 wfjson 代码块搬进 `_wfjson/…/*.wf.json`」的完整结果。
 *
 * 只读纯函数：不写盘、不判断侧车是否已存在（那是插件侧的事）。
 * 安全口径与 `applyMutation` 一致：
 *  1. 没有代码块 → `skipped`（批量迁移时直接跳过）；
 *  2. 当前文件有 error → 拒绝迁移，笔记原文返回；
 *  3. 迁移后用「新笔记 + 新 JSON」再校验，有 error → 整笔放弃（笔记原文返回）。
 */
export function planSidecarMigration(
  markdown: string,
  notePath: string,
  options: SidecarMigrationOptions = {},
): SidecarMigrationResult {
  const now = options.now ?? new Date();
  const sidecarPath = sidecarPathFor(notePath);
  const before = analyzeMarkdown(markdown, { file: notePath });
  const base = {
    sidecarPath,
    jsonText: "",
    noteMarkdown: markdown,
    changed: false,
    upgraded: false,
    analysis: before,
  };

  if (!before.found) {
    return { ...base, success: false, skipped: true, reason: "本文件没有 wfjson 代码块" };
  }
  if (before.hasError || !before.document) {
    const codes = [...new Set(before.issues.filter((item) => item.severity === "error").map((item) => item.code))];
    return {
      ...base,
      success: false,
      skipped: false,
      reason: `当前文件存在 error 级问题（${codes.join("、")}），已拒绝迁移；请先修复`,
    };
  }

  const upgrade = upgradeDocument(before.document);
  const document = upgrade.document;
  document.updatedAt = formatLocalIso(now);

  // 先摘掉代码块，再按文档补齐 frontmatter / 纪要段（writeBackNote 不会把 JSON 写回去）
  const stripped = removeWfJsonBlocks(markdown);
  const note = writeBackNote(stripped.markdown, document, { now });
  const jsonText = stringifyWfJson(document);

  const after = analyzeDocument({
    noteMarkdown: note.markdown,
    jsonText,
    jsonSource: "sidecar",
    jsonFile: sidecarPath,
    file: notePath,
  });
  if (after.hasError) {
    return {
      ...base,
      success: false,
      skipped: false,
      reason: "迁移结果未通过校验（error 级），已放弃；笔记保持原样",
      analysis: after,
    };
  }

  return {
    success: true,
    skipped: false,
    sidecarPath,
    jsonText,
    noteMarkdown: note.markdown,
    document,
    changed: true,
    upgraded: upgrade.upgraded,
    analysis: after,
  };
}
