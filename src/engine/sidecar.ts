/**
 * 外置 JSON（侧车）的路径约定与迁移（v0.7 §⑧；Phase 24 M1.6 起**扁平**）。
 *
 * 路径规则：
 *   `A/B/笔记.md`  →  `_workflowwatcher/笔记~3f9a1c2b7d.wf.json`
 *   `笔记.md`      →  `_workflowwatcher/笔记~<key>.wf.json`
 *
 * 为什么扁平：`_workflowwatcher/` 的**第一层**就是全部控制文件，一眼看全，不用点开镜像目录树。
 * 唯一性靠 `<key>`：笔记**完整路径**算出的 10 位十六进制（`noteKeyFor`），
 * 因此同名的两份笔记（不同目录）各有各的侧车，不会互相覆盖。
 * 代价：改名 / 移动会改变 key → 侧车要跟着改名（`main.ts` 的 rename 钩子逐篇处理）。
 *
 * 兼容：M1.6 之前是**镜像路径**（`_workflowwatcher/A/B/笔记.wf.json`）。`legacySidecarPathFor()` 仍算得出，
 * 读盘时作兜底（Phase 25 起插件不再主动搬迁老侧车）。
 *
 * 本模块只做纯函数的事：「路径 ↔ 路径」、迁移计划（`planSidecarMigration`）、
 * 成对拆分（`planSidecarPair`）；真正落盘由 main.ts 用 vault API 完成
 * （引擎不依赖 obsidian，`node --test` 可直接跑）。
 */

import { analyzeDocument, analyzeMarkdown, type AnalyzeResult } from "./analyze.ts";
import { setFrontmatterField } from "./frontmatter.ts";
import { formatLocalIso } from "./time.ts";
import type { WfJsonDocument } from "./types.ts";
import { backupFolderOf, boardFolderOf, FRONTMATTER_FIELDS } from "./types.ts";
import { upgradeDocument } from "./upgrade.ts";
import { removeWfJsonBlocks, stringifyWfJson, writeBackNote } from "./wfjsonWrite.ts";

/** 侧车文件扩展名（`.md` 之外再带一段，便于一眼看出是 wfjson 的 JSON） */
export const SIDECAR_EXTENSION = ".wf.json";

/** 扁平文件名里「笔记名」与「身份键」的分隔符：`笔记~3f9a1c2b7d.wf.json` */
export const SIDECAR_KEY_SEPARATOR = "~";

/** 身份键的十六进制位数（40 bit） */
export const NOTE_KEY_LENGTH = 10;

/** 身份键格式（小写十六进制、固定长度）：schema 的 `noteKey` 与文件名共用 */
export const NOTE_KEY_PATTERN = `^[0-9a-f]{${NOTE_KEY_LENGTH}}$`;

const NOTE_KEY_RE = new RegExp(NOTE_KEY_PATTERN);

const MARKDOWN_EXTENSION = ".md";

/** vault 路径规范化：统一正斜杠、去掉开头的 `./` 与 `/`、压缩重复斜杠 */
export function normalizeVaultPath(path: string): string {
  return path
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "")
    .replace(/\/{2,}/g, "/");
}

/** 是否是外置 JSON 路径（`_workflowwatcher` 目录下的所有文件） */
export function isSidecarPath(path: string): boolean {
  const normalized = normalizeVaultPath(path);
  const folder = boardFolderOf();
  return normalized === folder || normalized.startsWith(`${folder}/`);
}

/**
 * 是否是**备份镜像**路径（`_workflowwatcher/backup/` 本身与其子路径）。
 *
 * 备份写盘会再触发 `vault.on("create"/"modify")`，事件处理第一行就用它早退 —— 否则死循环。
 */
export function isBackupPath(path: string): boolean {
  const normalized = normalizeVaultPath(path);
  const folder = backupFolderOf();
  return normalized === folder || normalized.startsWith(`${folder}/`);
}

/** 备份副本的后缀：不是 `.md` / `.json`，Obsidian 搜索与 `getMarkdownFiles()` 都看不见 */
export const BACKUP_EXTENSION = ".bak";

/**
 * 源文件 → 备份副本路径（不检查文件是否存在）。
 *
 * 规则：全部拍平进 `_workflowwatcher/backup/` 第一层，文件名带 `~<noteKey>`，末尾再补 `.bak`：
 *  - md（主看板 / 归档正文）：补上「按它自己路径算出的 key」→ `main.md` → `backup/main~<key>.md.bak`；
 *    与它的侧车副本**同名同键**，只差后缀 → 一眼看出是一对；
 *    名字里**已经带键**的 md（主看板 `main~<key>.md`）不再补第二个键 → 还是 `backup/main~<key>.md.bak`
 *    （老命名 `main.md` 与新命名落到同一个副本，改名不会把备份劈成两份）；
 *  - 侧车 json：文件名里本来就带 `~<key>`（`sidecarPathFor` 的产物）→ 原样镜像 + `.bak`。
 *
 * key 用 `noteKeyFor(md 完整路径)`，与 `sidecarPathFor` 同一个函数 → md 副本与 json 副本必然对齐。
 * 老镜像侧车（无 key）原样镜像、不补键 —— Phase 25 已弃用的遗留形态，只备份不维护。
 */
export function backupPathFor(sourcePath: string): string {
  const normalized = normalizeVaultPath(sourcePath);
  const file = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (file.toLowerCase().endsWith(MARKDOWN_EXTENSION)) {
    const base = file.slice(0, -MARKDOWN_EXTENSION.length);
    const key = noteKeyFor(normalized);
    // 名字里已经带键（主看板 `main~<key>.md`）→ 不再补第二个，否则副本会变成 `main~K~K.md.bak`
    const stem = base.endsWith(`${SIDECAR_KEY_SEPARATOR}${key}`)
      ? base
      : `${base}${SIDECAR_KEY_SEPARATOR}${key}`;
    return `${backupFolderOf()}/${stem}${MARKDOWN_EXTENSION}${BACKUP_EXTENSION}`;
  }
  return `${backupFolderOf()}/${file}${BACKUP_EXTENSION}`;
}

/**
 * 笔记的**身份键**（Phase 24 M1.6）：笔记完整路径算出的 10 位十六进制。
 *
 * 用途：扁平化后侧车全在 `_workflowwatcher/` 第一层，靠它区分「同名的两份笔记」；
 * 同一个键也写进侧车 JSON（`noteKey`）与笔记 frontmatter（`wf-key`），两边互为凭据。
 *
 * 算法：两路 32 位 FNV-1a（不同种子 / 乘子）拼成 64 位，取前 10 位十六进制。
 *  **不是**密码学哈希也不需要 —— 只有「同名笔记之间」要区分，而文件名里本来就带笔记名，
 *  40 位空间足够（要撞必须「同名 + 同 key」，实际不可能）。
 * 稳定：同一路径在任何平台 / 任何时候算出同一个键（先统一斜杠、NFC、小写，
 * 因为 Windows / macOS 的文件系统不分大小写）。
 *
 * 例外（**幂等**，`_workflowwatcher/` 内）：文件名里已经带键 → **键就是文件名里那个**
 * （`main~3f9a1c2b7d.md` → `3f9a1c2b7d`），不再按路径重算。主看板正是靠这条把 md 与侧车
 * 做成「同名同键、只差扩展名」（见 `mainBoard.ts`）；否则会算出第二个键，两边又对不上。
 */
export function noteKeyFor(notePath: string): string {
  const normalized = normalizeVaultPath(notePath);
  const embedded = embeddedNoteKey(normalized);
  if (embedded !== undefined) return embedded;
  const lowered = normalized.normalize("NFC").toLowerCase();
  let low = 0x811c9dc5; // FNV-1a 32 位偏移基数
  let high = 0x9e3779b9; // 第二路种子（黄金分割常数）
  for (let index = 0; index < lowered.length; index += 1) {
    const code = lowered.charCodeAt(index);
    low = Math.imul(low ^ code, 0x01000193) >>> 0;
    high = Math.imul(high ^ (code + index), 0x85ebca6b) >>> 0;
  }
  const hex = `${high.toString(16).padStart(8, "0")}${low.toString(16).padStart(8, "0")}`;
  return hex.slice(0, NOTE_KEY_LENGTH);
}

/**
 * 文件名里**自带**的身份键：`_workflowwatcher/` 内的文件，stem 以 `~<10 位十六进制>` 结尾时返回它
 * （`_workflowwatcher/main~3f9a1c2b7d.md` → `3f9a1c2b7d`）。
 *
 * 为什么只认 `_workflowwatcher/` 内：那里的文件由插件自己命名（主看板），规则可控；
 * 用户自己的笔记哪怕叫 `笔记~0123456789.md` 也**照旧按完整路径算键** —— 否则两个目录下的
 * 同名笔记会撞到同一个侧车里，那是真丢数据。
 */
function embeddedNoteKey(normalizedPath: string): string | undefined {
  if (!isSidecarPath(normalizedPath)) return undefined;
  const base = stripMarkdownExtension(normalizedPath);
  const name = base.slice(base.lastIndexOf("/") + 1);
  const index = name.lastIndexOf(SIDECAR_KEY_SEPARATOR);
  if (index <= 0) return undefined;
  const key = name.slice(index + 1);
  return NOTE_KEY_RE.test(key) ? key : undefined;
}

/**
 * 笔记路径 → 侧车路径（**扁平**：`_workflowwatcher/<笔记名>~<key>.wf.json`；不检查文件是否存在）。
 *
 * 目录层级不进文件名 —— 这正是「第一层就能看全部控制文件」的意思；
 * 不同目录下的同名笔记靠 `<key>` 区分，不会被对方覆盖。
 *
 * 笔记名里**已经带键**（主看板 `main~<key>.md`）时不再补第二个键：
 * `_workflowwatcher/main~K.md` → `_workflowwatcher/main~K.wf.json`（同名同键、只差扩展名）。
 */
export function sidecarPathFor(notePath: string): string {
  const normalized = normalizeVaultPath(notePath);
  const base = stripMarkdownExtension(normalized);
  const name = base.slice(base.lastIndexOf("/") + 1);
  const key = noteKeyFor(normalized);
  const stem = name.endsWith(`${SIDECAR_KEY_SEPARATOR}${key}`)
    ? name
    : `${name}${SIDECAR_KEY_SEPARATOR}${key}`;
  return `${boardFolderOf()}/${stem}${SIDECAR_EXTENSION}`;
}

/**
 * M1.6 之前的老规则（**镜像路径**）：`A/B/笔记.md` → `_workflowwatcher/A/B/笔记.wf.json`。
 *
 * 只用于读老数据时兜底（老侧车别丢；Phase 25 起插件不再主动搬迁它们）。
 */
export function legacySidecarPathFor(notePath: string): string {
  const normalized = normalizeVaultPath(notePath);
  return `${boardFolderOf()}/${stripMarkdownExtension(normalized)}${SIDECAR_EXTENSION}`;
}

/**
 * 老镜像侧车路径 → 笔记路径（不是侧车路径时返回 undefined）。
 *
 * 扁平名里带的是哈希，**反查不出**笔记路径（那是刻意的：扁平名不编码目录）；
 * 本函数只服务于「搬迁老侧车」，新数据请用 `parseSidecarName`。
 */
export function notePathForSidecar(sidecarPath: string): string | undefined {
  if (!isSidecarPath(sidecarPath)) return undefined;
  const normalized = normalizeVaultPath(sidecarPath);
  const rest = normalized === boardFolderOf() ? "" : normalized.slice(boardFolderOf().length + 1);
  if (!rest.toLowerCase().endsWith(SIDECAR_EXTENSION)) return undefined;
  // 扁平名（`笔记~<key>.wf.json`）里带的是哈希：反查不出笔记路径，宁可回 undefined
  if (parseSidecarName(normalized)?.key !== undefined) return undefined;
  return `${rest.slice(0, -SIDECAR_EXTENSION.length)}${MARKDOWN_EXTENSION}`;
}

/** 侧车文件名拆出来的两部分 */
export interface SidecarName {
  /** 笔记名（不含目录、不含 `.wf.json`） */
  name: string;
  /** 身份键（10 位十六进制）；老镜像路径没有这个键 → undefined */
  key?: string;
}

/**
 * 从侧车**文件名**拆出「笔记名 + 身份键」（`笔记~3f9a1c2b7d.wf.json` → `{name, key}`）。
 *
 * 只看文件名，不看目录：扁平与老镜像两种形态都能拆（老形态没有 key）。
 * 键取**最后一个** `~` 之后的部分 —— 笔记名里本来就可以有 `~`。
 */
export function parseSidecarName(sidecarPath: string): SidecarName | undefined {
  if (!isSidecarPath(sidecarPath)) return undefined;
  const normalized = normalizeVaultPath(sidecarPath);
  const file = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (!file.toLowerCase().endsWith(SIDECAR_EXTENSION)) return undefined;
  const base = file.slice(0, -SIDECAR_EXTENSION.length);
  const index = base.lastIndexOf(SIDECAR_KEY_SEPARATOR);
  if (index <= 0) return { name: base };
  const key = base.slice(index + 1);
  if (!NOTE_KEY_RE.test(key)) return { name: base };
  return { name: base.slice(0, index), key };
}

/** 去掉 `.md`（大小写不敏感）；其它扩展名原样保留 */
function stripMarkdownExtension(path: string): string {
  return path.toLowerCase().endsWith(MARKDOWN_EXTENSION) ? path.slice(0, -MARKDOWN_EXTENSION.length) : path;
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
 * 计算「把笔记里的 wfjson 代码块搬进 `_workflowwatcher/<笔记名>~<key>.wf.json`」的完整结果。
 *
 * 只读纯函数：不写盘、不判断侧车是否已存在（那是插件侧的事）。
 * 安全口径与 `applyMutation` 一致：
 *  1. 没有代码块 → `skipped`（批量迁移时直接跳过）；
 *  2. 当前文件有 error → 拒绝迁移，笔记原文返回；
 *  3. 迁移后用「新笔记 + 新 JSON」再校验，有 error → 整笔放弃（笔记原文返回）。
 *
 * M1.6：迁移时顺手把身份键写进去（JSON 的 `noteKey` + frontmatter 的 `wf-key`），
 * 这样「侧车文件名 / JSON / 笔记」三处从第一次落盘起就是一致的。
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
  document.noteKey = noteKeyFor(notePath);

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

/* ------------------------------------------------------------------ *
 * 成对形态：任意 md（主文件 / 归档文件）拆成「笔记 + 侧车」
 * ------------------------------------------------------------------ */

/**
 * 一份 md 拆成「笔记 + 外置 JSON」的两件产物（Phase 24 M1.5：归档也走成对形态）。
 */
export interface SidecarPairResult {
  /** 侧车路径（`_workflowwatcher/<笔记名>~<key>.wf.json`，扁平：与笔记路径一一对应） */
  sidecarPath: string;
  /** 摘掉 `wfjson` 代码块后的笔记文本（传入文本本来就没有块时原样返回） */
  noteMarkdown: string;
  /** 外置 JSON 文本（两空格缩进 + 结尾换行，与 `writeBackDocument` 写进代码块的口径一致） */
  jsonText: string;
  /** 摘掉了几个代码块（`0` = 传入的已经是成对形态 → 幂等） */
  removedBlocks: number;
}

/**
 * 算「把这份 md 拆成 md + 侧车」的两个产物（**只读纯函数**，不落盘）。
 *
 * 与 `planSidecarMigration` 的分工：
 *  - `planSidecarMigration` 是**用户命令**触发的迁移 —— 要先校验、要升格、要能原样退回；
 *  - 这里是「刚生成 / 可信」的文件（归档 md 由 `planArchive` 造出来，必然合法）只需两步：
 *    摘掉代码块、把文档序列化成侧车文本。
 *
 * 幂等：对已经成对形态的正文再调一次，`noteMarkdown` 逐字节不变、`removedBlocks = 0`
 * （插件层据此实现「重试不重写」）。
 *
 * M1.6：序列化前把身份键钉成 `noteKeyFor(notePath)`（传入的 `document` 不被修改），
 * 因此侧车 JSON 里的 `noteKey` 永远与扁平文件名里的 `<key>` 一致。
 */
export function planSidecarPair(
  notePath: string,
  markdown: string,
  document: WfJsonDocument,
): SidecarPairResult {
  const key = noteKeyFor(notePath);
  const stripped = removeWfJsonBlocks(markdown);
  const keyed: WfJsonDocument = { ...document, noteKey: key };
  return {
    sidecarPath: sidecarPathFor(notePath),
    // 笔记的 frontmatter 也钉上同一个键（`wf-key`），与 JSON 的 `noteKey` 互为凭据
    noteMarkdown: setFrontmatterField(stripped.markdown, FRONTMATTER_FIELDS.key, key),
    jsonText: stringifyWfJson(keyed),
    removedBlocks: stripped.removedLines.length,
  };
}
