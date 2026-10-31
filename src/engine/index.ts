/**
 * wfjson 引擎：纯 TypeScript、零 Obsidian 依赖。
 *
 * 分层（上层只应依赖 index.ts，不要直接引用内部文件）：
 *
 *   types / time / ids / issues      —— 基础定义（状态、时间、id 约定、问题码）
 *   frontmatter / markdownScan       —— 文本层（frontmatter、代码块、行内锚点）
 *   wfjsonSchema / schemaValidator   —— 契约层（JSON Schema 子集 + 校验器）
 *   wfjsonParse                      —— 抽取 + 严格 JSON 解析（BOM/注释/尾逗号）
 *   noteSection                      —— 正文纪要段（Phase 9：超链接唯一来源，`wf-note` 标志对扫读 / 渲染 / 链接解析）
 *   tree / consistency               —— 语义层（遍历、索引、跨字段一致性、状态聚合）
 *   stats / timeStats / upgrade      —— 聚合统计（状态总览口径 / 计时与方块阵）与内存版本升格
 *   quadrant / plot                  —— 小工具的只读聚合（Phase 19：4 象限 / 365 天 plot）
 *   factory / wfjsonWrite            —— 构造与写回（新建节点、回写代码块/摘要/段落）
 *   analyze / mutate                 —— 编排入口（parse → schema → consistency；变更 → 写回 → 幂等校验）
 *   nodeEdits / nodeReorder / timerEdits / workflowEdits —— 变更的内存改动（Phase 2 节点编辑 /
 *     Phase 15 拖拽改节点顺序 / Phase 3 计时三动作 / Phase 5 工作流增删改）
 *
 * 用法：
 *   import { analyzeMarkdown, formatAnalyzeResult, upsertWfJsonBlock } from "./engine/index.ts";
 */

export * from "./types.ts";
export * from "./time.ts";
export * from "./ids.ts";
export * from "./issues.ts";
export * from "./frontmatter.ts";
export * from "./markdownScan.ts";
export * from "./wfjsonSchema.ts";
export * from "./schemaValidator.ts";
export * from "./wfjsonParse.ts";
export * from "./noteSection.ts";
export * from "./tree.ts";
export * from "./consistency.ts";
export * from "./stats.ts";
export * from "./timeStats.ts";
export * from "./upgrade.ts";
export * from "./factory.ts";
export * from "./wfjsonWrite.ts";
export * from "./analyze.ts";
export * from "./mutate.ts";
export * from "./sidecar.ts";
export * from "./nodeEdits.ts";
export * from "./nodeReorder.ts";
export * from "./timerEdits.ts";
export * from "./workflowEdits.ts";
export * from "./archive.ts";
export * from "./template.ts";
export * from "./spiral.ts";
export * from "./quadrant.ts";
export * from "./plot.ts";
export * from "./i18n.ts";
