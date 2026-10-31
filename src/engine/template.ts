/**
 * Phase 10（v0.8）：工作流模板。
 *
 * `buildWorkflowTemplate()` 生成一段自洽的最小笔记：
 *  1. frontmatter 摘要字段（`wf-tags / wf-status / wf-titles / wf-updated`，可选 `wf-theme`）；
 *  2. dataviewjs 渲染块（一行调用插件渲染入口）；
 *  3. 一个纪要段落 `### 标题 ^nd-xxx`（与 root 节点的 `noteAnchor` 对应）；
 *  4. 一个**能通过校验**的最小 `wfjson` 代码块（schema 1.9 / 1 个工作流 + 根节点）。
 *
 * 之所以复用 `createDocument / createWorkflow / stringifyWfJson` 而不是手写 JSON：
 * 字段默认值、id 前缀、`updatedAt` 格式都由引擎单点维护，模板不会随 schema 漂移。
 */

import { aggregateStatus } from "./consistency.ts";
import { createDocument, createWorkflow } from "./factory.ts";
import { formatLocalIso, toDateOnly } from "./time.ts";
import { FRONTMATTER_FIELDS, type WfJsonDocument } from "./types.ts";
import { DEFAULT_NOTE_PLACEHOLDER, buildWfJsonBlock, renderYamlValue } from "./wfjsonWrite.ts";

/** 插件 id（dataviewjs 里按 id 取实例） */
export const TEMPLATE_PLUGIN_ID = "wfjson-workflow";

/** 模板默认工作流名 */
export const DEFAULT_TEMPLATE_TITLE = "新工作流";

export interface WorkflowTemplateOptions {
  /** 工作流名（同时作为根节点标题）；缺省 `新工作流` */
  title?: string;
  /** frontmatter `wf-tags`；缺省空数组 */
  tags?: string[];
  /** 写入 frontmatter `wf-theme`（缺省不写 → 视图回落全局默认主题） */
  theme?: string;
  /** 是否带上 frontmatter 段（插入到已有非空笔记时置 false） */
  includeFrontmatter?: boolean;
  now?: Date;
}

/** 渲染块：一行调用插件（dataviewjs 只负责把 dv 交出去） */
export const TEMPLATE_RENDER_BLOCK = ["```dataviewjs", `await app.plugins.plugins["${TEMPLATE_PLUGIN_ID}"].render(dv);`, "```"].join("\n");

/** 由模板选项构造出文档（导出便于单测 / 想自己改 JSON 的调用方） */
export function buildTemplateDocument(options: WorkflowTemplateOptions = {}): WfJsonDocument {
  const now = options.now ?? new Date();
  const title = (options.title ?? "").trim() || DEFAULT_TEMPLATE_TITLE;
  return createDocument([createWorkflow(title, now)], now);
}

/** 模板里的纪要段落（`### 标题 ^nd-xxx` + 占位正文） */
export function buildTemplateNoteSection(document: WfJsonDocument): string {
  const node = document.workflows[0].root;
  const heading = node.noteAnchor !== undefined ? `### ${node.title} ${node.noteAnchor}` : `### ${node.title}`;
  return [heading, "", DEFAULT_NOTE_PLACEHOLDER].join("\n");
}

/** 生成完整模板（frontmatter 可按需省略） */
export function buildWorkflowTemplate(options: WorkflowTemplateOptions = {}): string {
  const now = options.now ?? new Date();
  const document = buildTemplateDocument({ ...options, now });
  const parts: string[] = [];

  if (options.includeFrontmatter !== false) {
    const lines = [
      "---",
      `${FRONTMATTER_FIELDS.tags}: ${renderYamlValue(options.tags ?? [])}`,
      `${FRONTMATTER_FIELDS.status}: ${renderYamlValue(aggregateStatus(document))}`,
      `${FRONTMATTER_FIELDS.titles}: ${renderYamlValue(document.workflows.map((workflow) => workflow.title))}`,
      `${FRONTMATTER_FIELDS.updated}: ${toDateOnly(formatLocalIso(now))}`,
    ];
    if (options.theme !== undefined && options.theme.length > 0) {
      lines.push(`${FRONTMATTER_FIELDS.theme}: ${renderYamlValue(options.theme)}`);
    }
    lines.push("---");
    parts.push(lines.join("\n"));
  }

  parts.push(TEMPLATE_RENDER_BLOCK);
  parts.push("## 纪要");
  parts.push(buildTemplateNoteSection(document));
  parts.push(buildWfJsonBlock(document).trimEnd());
  return `${parts.join("\n\n")}\n`;
}
