/**
 * 变更编排（写回链路的安全闸门，纯函数、零 Obsidian 依赖）。
 *
 * `applyMutation(markdown, mutator)` 的三步（对应 discuss 文档的 `mutateFile` 伪代码）：
 *  1. `analyzeMarkdown(text)`：有 error 或拿不到文档 → **拒绝写回**，文本原样返回并记下 issues；
 *  2. 内存升格到最新 schemaVersion（`upgradeDocument`）+ 统一 `document.updatedAt = now`；
 *  3. `mutator(document)` 改数据 → 写回（`writeBackDocument`：代码块 + frontmatter + 先删后补纪要段落）
 *     → 再 analyze 做**幂等校验**，若写回结果有 error 则整笔回滚（返回原文）。
 *
 * Obsidian 侧只负责把本函数套进 `vault.process(file, fn)`（见 main.ts 的 `mutateFile`），
 * 这样「读 → 改 → 写」在同一事务里完成，不会被其它改动覆盖。
 */

import { analyzeDocument, analyzeMarkdown, type AnalyzeResult } from "./analyze.ts";
import { formatLocalIso } from "./time.ts";
import type { WfJsonDocument } from "./types.ts";
import { upgradeDocument } from "./upgrade.ts";
import { replaceNoteSectionContent } from "./noteSection.ts";
import { noteKeyFor } from "./sidecar.ts";
import { stringifyWfJson, writeBackDocument, writeBackNote, type NoteLinkMerge } from "./wfjsonWrite.ts";

/** mutator 的返回（可选）：拒绝写回 / 声明无改动 / 上报受影响节点 */
export interface MutationOutcome {
  /** 返回非空字符串 = 拒绝写回（内容为原因文案，文本保持原样） */
  reject?: string;
  /** 明确声明「本次没有改动」→ 跳过写回（默认为有改动） */
  changed?: boolean;
  /** 受影响的节点 id（供上层做局部刷新） */
  changedNodeIds?: string[];
  /** 需要从正文删掉的纪要锚点（如删除节点时上报其 `noteAnchor`） */
  removedNoteAnchors?: string[];
  /** 删除节点时把源段落的超链接并进目标段落（Phase 9「合并进上级条目」） */
  mergeNoteSections?: NoteLinkMerge[];
}

/** 就地修改内存中的文档（返回 `MutationOutcome` 可中止写回） */
export type DocumentMutator = (document: WfJsonDocument) => MutationOutcome | void;

export interface MutationOptions {
  /** 文件路径（仅用于报错展示） */
  file?: string;
  /** `updatedAt` / `wf-updated` 的基准时间（默认当前时间） */
  now?: Date;
}

export interface MutationResult {
  /** 是否成功写回（拒绝 / 写回结果有 error 时为 false） */
  success: boolean;
  /** 结果文本（失败时 = 输入文本，保证「拒绝写」不会产生半截修改） */
  markdown: string;
  /** 是否真的改动并写回（false 时文本与输入完全一致） */
  changed: boolean;
  /** 本次是否顺带把旧版（1.0）落盘升格为最新版 */
  upgraded: boolean;
  /** 失败原因（success=false 时给出） */
  reason?: string;
  /** 校验结果：成功时是**写回后**的结果（幂等校验）；失败时是**当前文本**的结果 */
  analysis: AnalyzeResult;
  /** mutator 上报的受影响节点 id */
  changedNodeIds: string[];
  /** 写回时新补的纪要锚点（先序） */
  addedAnchors: string[];
  /** 写回时从正文删掉的纪要锚点（先序） */
  removedAnchors: string[];
  /** 写回时从 `links[]` 迁进正文的节点 id（先序；Phase 9） */
  migratedLinkNodeIds: string[];
  /**
   * 写回后的内存文档（成功时有；侧车模式下供上层在笔记被并发修改时重写纪要段）。
   * 注意：它已被交给 mutator 就地修改过，调用方不要再当成「原文的文档」。
   */
  document?: WfJsonDocument;
  /** 侧车模式：写回后的外置 JSON 文本（笔记模式为 undefined） */
  jsonText?: string;
}

function rejected(markdown: string, analysis: AnalyzeResult, reason: string): MutationResult {
  return {
    success: false,
    markdown,
    changed: false,
    upgraded: false,
    reason,
    analysis,
    changedNodeIds: [],
    addedAnchors: [],
    removedAnchors: [],
    migratedLinkNodeIds: [],
  };
}

/** 变更编排主入口（纯函数：输入文本 → 输出文本 + 结构化结果） */
export function applyMutation(markdown: string, mutator: DocumentMutator, options: MutationOptions = {}): MutationResult {
  const now = options.now ?? new Date();
  const analyzeOptions = options.file !== undefined ? { file: options.file } : {};
  const before = analyzeMarkdown(markdown, analyzeOptions);

  // 1) 安全闸门：坏数据一律拒绝写回（不静默失败，也不在坏数据上继续瞎跑）
  if (!before.found) return rejected(markdown, before, "本文件没有 wfjson 代码块，没什么可改的");
  if (before.hasError || !before.document) {
    const codes = [...new Set(before.issues.filter((item) => item.severity === "error").map((item) => item.code))];
    return rejected(markdown, before, `当前文件存在 error 级问题（${codes.join("、")}），已拒绝写入；请先修复`);
  }

  // 2) 升格到最新版（1.0 → 1.1 只在本次写回时落盘），并统一刷新 updatedAt
  const upgrade = upgradeDocument(before.document);
  const document = upgrade.document;
  document.updatedAt = formatLocalIso(now);

  // 3) 执行变更
  let outcome: MutationOutcome | undefined;
  try {
    outcome = mutator(document) ?? undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return rejected(markdown, before, `变更函数抛错：${reason}`);
  }
  if (outcome?.reject !== undefined) return rejected(markdown, before, outcome.reject);
  if (outcome?.changed === false) {
    return {
      success: true,
      markdown,
      changed: false,
      upgraded: false,
      analysis: before,
      changedNodeIds: [],
      addedAnchors: [],
      removedAnchors: [],
      migratedLinkNodeIds: [],
      document,
    };
  }

  // 4) 写回（代码块 + frontmatter + 先删后补纪要段落）+ 写回后的幂等校验
  const written = writeBackDocument(markdown, document, {
    now,
    removedNoteAnchors: outcome?.removedNoteAnchors,
    mergeNoteSections: outcome?.mergeNoteSections,
  });
  const after = analyzeMarkdown(written.markdown, analyzeOptions);
  if (after.hasError) {
    return rejected(markdown, analyzeMarkdown(markdown, analyzeOptions), "写回结果未通过校验（error 级），已整笔回滚；文本保持原样");
  }

  return {
    success: true,
    markdown: written.markdown,
    changed: true,
    upgraded: upgrade.upgraded,
    analysis: after,
    changedNodeIds: outcome?.changedNodeIds ?? [],
    addedAnchors: written.addedAnchors,
    removedAnchors: written.removedAnchors,
    migratedLinkNodeIds: written.migratedLinkNodeIds,
    document,
  };
}

/* ------------------------------------------------------------------ *
 * 侧车模式（v0.7 §⑧：JSON 在 `_workflowwatcher/…/*.wf.json`）
 * ------------------------------------------------------------------ */

export interface SidecarMutationOptions extends MutationOptions {
  /** 外置 JSON 文件路径（仅用于展示与报错） */
  jsonFile?: string;
}

/**
 * 变更编排的侧车版本：`applyMutation` 的镜像，只是「JSON + 笔记」是两个文件。
 *
 *  - 读：`noteMarkdown` 负责 frontmatter / 纪要段 / 锚点，`jsonText` 负责数据；
 *  - 写：`writeBackNote` **只重写笔记**（frontmatter + 先删后补纪要段），JSON 由调用方
 *    用结果里的 `jsonText` 写回侧车文件；
 *  - 校验：用「新笔记文本 + 新 JSON 文本」再跑一次 `analyzeDocument`，有 error 即整笔回滚
 *    （返回的 `markdown` / `jsonText` 都是输入原文，调用方据此不落盘）。
 *
 * 非原子性：两个文件不可能一次事务写完。插件侧的固定顺序是「先侧车、后笔记」，
 * 且两步都幂等（重复执行结果一致）；中断后重试即可收敛。
 */
export function applySidecarMutation(
  noteMarkdown: string,
  jsonText: string,
  mutator: DocumentMutator,
  options: SidecarMutationOptions = {},
): MutationResult {
  const now = options.now ?? new Date();
  const analyzeInput = {
    noteMarkdown,
    jsonText,
    jsonSource: "sidecar" as const,
    ...(options.file !== undefined ? { file: options.file } : {}),
    ...(options.jsonFile !== undefined ? { jsonFile: options.jsonFile } : {}),
  };
  const before = analyzeDocument(analyzeInput);

  const fail = (reason: string, analysis: AnalyzeResult): MutationResult => ({
    ...rejected(noteMarkdown, analysis, reason),
    jsonText,
  });

  // 1) 安全闸门：外置 JSON 坏了一律拒绝写回（笔记保持原样，侧车也保持原样）
  if (!before.found) return fail("外置 JSON 不存在，没什么可改的", before);
  if (before.hasError || !before.document) {
    const codes = [...new Set(before.issues.filter((item) => item.severity === "error").map((item) => item.code))];
    return fail(`外置 JSON 存在 error 级问题（${codes.join("、")}），已拒绝写入；请先修复`, before);
  }

  // 2) 升格到最新版 + 统一刷新 updatedAt
  const upgrade = upgradeDocument(before.document);
  const document = upgrade.document;
  document.updatedAt = formatLocalIso(now);
  // M1.6：身份键按**当前路径**重算（复制 / 改名后自愈），同时写进 JSON 与 frontmatter 的 wf-key
  if (options.file !== undefined) document.noteKey = noteKeyFor(options.file);

  // 3) 执行变更
  let outcome: MutationOutcome | undefined;
  try {
    outcome = mutator(document) ?? undefined;
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return fail(`变更函数抛错：${reason}`, before);
  }
  if (outcome?.reject !== undefined) return fail(outcome.reject, before);
  if (outcome?.changed === false) {
    return {
      success: true,
      markdown: noteMarkdown,
      jsonText,
      changed: false,
      upgraded: false,
      analysis: before,
      changedNodeIds: [],
      addedAnchors: [],
      removedAnchors: [],
      migratedLinkNodeIds: [],
      document,
    };
  }

  // 4) 只写笔记（frontmatter + 纪要段）+ 生成新 JSON → 用两者再做一次校验
  const written = writeBackNote(noteMarkdown, document, {
    now,
    removedNoteAnchors: outcome?.removedNoteAnchors,
    mergeNoteSections: outcome?.mergeNoteSections,
  });
  const nextJson = stringifyWfJson(document);
  const after = analyzeDocument({ ...analyzeInput, noteMarkdown: written.markdown, jsonText: nextJson });
  if (after.hasError) {
    return fail("写回结果未通过校验（error 级），已整笔回滚；文本保持原样", before);
  }

  return {
    success: true,
    markdown: written.markdown,
    jsonText: nextJson,
    changed: true,
    upgraded: upgrade.upgraded,
    analysis: after,
    changedNodeIds: outcome?.changedNodeIds ?? [],
    addedAnchors: written.addedAnchors,
    removedAnchors: written.removedAnchors,
    migratedLinkNodeIds: written.migratedLinkNodeIds,
    document,
  };
}

/* ------------------------------------------------------------------ *
 * 正文纪要段编辑（Phase 9：超链接管理区）
 * ------------------------------------------------------------------ */

export interface NoteSectionMutationResult {
  success: boolean;
  /** 结果文本（失败时 = 输入文本） */
  markdown: string;
  /** 是否真的改动了文本 */
  changed: boolean;
  /** 失败原因（success = false 时给出） */
  reason?: string;
  /** 写回后的校验结果 */
  analysis: AnalyzeResult;
}

/**
 * 只改正文（不动 JSON）：把某个节点纪要段的内容整段替换。
 *
 * 与 `applyMutation` 共用同一道安全闸门：写前有 error → 拒绝；写后出现 error → 整笔回滚。
 * 用于视图右键「编辑资源列表」（跳转到简单纪要后由 Modal 保存）与手工修订超链接区。
 */
export function applyNoteSectionEdit(
  markdown: string,
  nodeIdOrAnchor: string,
  content: string,
  options: MutationOptions = {},
): NoteSectionMutationResult {
  const analyzeOptions = options.file !== undefined ? { file: options.file } : {};
  const before = analyzeMarkdown(markdown, analyzeOptions);
  if (!before.found) {
    return { success: false, markdown, changed: false, reason: "本文件没有 wfjson 代码块，没什么可改的", analysis: before };
  }
  if (before.hasError || !before.document) {
    const codes = [...new Set(before.issues.filter((item) => item.severity === "error").map((item) => item.code))];
    return {
      success: false,
      markdown,
      changed: false,
      reason: `当前文件存在 error 级问题（${codes.join("、")}），已拒绝写入；请先修复`,
      analysis: before,
    };
  }

  const replaced = replaceNoteSectionContent(markdown, nodeIdOrAnchor, content);
  if (!replaced.found) {
    return {
      success: false,
      markdown,
      changed: false,
      reason: `找不到节点 ${nodeIdOrAnchor} 的纪要段落（需要成对的 wf-note 标志；可先让视图写回一次自动补标志）`,
      analysis: before,
    };
  }
  if (replaced.markdown === markdown) {
    return { success: true, markdown, changed: false, analysis: before };
  }

  const after = analyzeMarkdown(replaced.markdown, analyzeOptions);
  if (after.hasError) {
    return {
      success: false,
      markdown,
      changed: false,
      reason: "写回结果未通过校验（error 级），已整笔回滚；文本保持原样",
      analysis: after,
    };
  }
  return { success: true, markdown: replaced.markdown, changed: true, analysis: after };
}
