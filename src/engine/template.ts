/**
 * Phase 10（v0.8）：工作流模板。
 *
 * `buildWorkflowTemplate()` 生成一段自洽的最小笔记：
 *  1. frontmatter 摘要字段（`wf-tags / wf-status / wf-titles / wf-updated / wf-theme`，
 *     其中 `wf-theme` 缺省写 `default`，见 `DEFAULT_TEMPLATE_THEME`）；
 *  2. dataviewjs 渲染块（一行调用插件渲染入口）；
 *  3. 一个纪要段落 `### 标题 ^nd-xxx`（与 root 节点的 `noteAnchor` 对应）；
 *  4. 一个**能通过校验**的最小 `wfjson` 代码块（schema 1.9 / 1 个工作流 + 根节点）。
 *
 * 之所以复用 `createDocument / createWorkflow / stringifyWfJson` 而不是手写 JSON：
 * 字段默认值、id 前缀、`updatedAt` 格式都由引擎单点维护，模板不会随 schema 漂移。
 */

import { aggregateStatus } from "./consistency.ts";
import { createDocument, createWorkflow } from "./factory.ts";
import { t } from "./i18n.ts";
import { formatLocalIso, toDateOnly } from "./time.ts";
import { FRONTMATTER_FIELDS, type WfJsonDocument } from "./types.ts";
import { buildWfJsonBlock, renderYamlValue } from "./wfjsonWrite.ts";

/** 插件 id（dataviewjs 里按 id 取实例） */
export const TEMPLATE_PLUGIN_ID = "workflow-watcher";

/**
 * 模板默认工作流名（**中文写法**）。
 *
 * 实际取的是字典 `template.defaultTitle`（`zh` 值），英文环境会生成 `New workflow`；
 * 这个常量留给历史断言 / 调用方对照，不参与渲染。
 */
export const DEFAULT_TEMPLATE_TITLE = "新工作流";

/**
 * 模板缺省主题（Phase 21）：**首帧就是内置的 `default` 主题**。
 *
 * 为什么显式写死：不依赖用户环境 —— 首帧确定是默认主题，
 * 之后仍可在视图里点切换按钮改本文件的主题（主题完全跟随文件，没有全局默认设置）。
 *
 * key 与 `main.ts` 的 `WF_THEME_KEYS` / styles.css 的 `[data-wf-theme="default"]` 对齐。
 */
export const DEFAULT_TEMPLATE_THEME = "default";

export interface WorkflowTemplateOptions {
  /** 工作流名（同时作为根节点标题）；缺省取字典 `template.defaultTitle`（中文 `新工作流` / 英文 `New workflow`） */
  title?: string;
  /** frontmatter `wf-tags`；缺省空数组 */
  tags?: string[];
  /**
   * 写入 frontmatter `wf-theme`；缺省 `DEFAULT_TEMPLATE_THEME`（`"default"`）。
   * 显式传空串 = 不写该键（视图回落默认主题 `default`，Phase 46 起它重新是清单里的合法 key）。
   */
  theme?: string;
  /** 是否带上 frontmatter 段（插入到已有非空笔记时置 false） */
  includeFrontmatter?: boolean;
  /**
   * Phase 24：是否带上 `dataviewjs` 渲染块（默认 `true` = 旧模板，行为不变）。
   *
   * 置 `false` 时正文只留 `## 纪要` + `wfjson` 代码块（frontmatter 一个不少）：给「用看板
   * （ItemView）看这条工作流」的用户用 —— 看板自己就是渲染宿主，笔记里再留一个 dataviewjs
   * 块只会多一份会跳位的内嵌视图。
   */
  includeRenderBlock?: boolean;
  now?: Date;
  document?: WfJsonDocument; // 新增：复用已有文档，避免二次构造
}

/** 渲染块：一行调用插件（dataviewjs 只负责把 dv 交出去） */
export const TEMPLATE_RENDER_BLOCK = ["```dataviewjs", `await app.plugins.plugins["${TEMPLATE_PLUGIN_ID}"].render(dv);`, "```"].join("\n");

/** 由模板选项构造出文档（导出便于单测 / 想自己改 JSON 的调用方） 
 * 会重复调用createWorkflow
 */
export function buildTemplateDocument(options: WorkflowTemplateOptions = {}): WfJsonDocument {
  const now = options.now ?? new Date();
  // 标题跟随语言：中文 `新工作流` / 英文 `New workflow`（用户给了就原样用）
  const title = (options.title ?? "").trim() || t("template.defaultTitle");
  return createDocument([createWorkflow(title, now)], now);
}

/** 模板里的纪要段落（`### 标题 ^nd-xxx` + 占位正文，占位正文跟随语言） */
export function buildTemplateNoteSection(document: WfJsonDocument): string {
  const node = document.workflows[0].root;
  const heading = node.noteAnchor !== undefined ? `### ${node.title} ${node.noteAnchor}` : `### ${node.title}`;
  return [heading, "", t("template.notePlaceholder")].join("\n");
}

/** 生成完整模板（frontmatter 可按需省略） */
export function buildWorkflowTemplate(options: WorkflowTemplateOptions = {}): string {
  const now = options.now ?? new Date();
  const document = options.document ?? buildTemplateDocument({ ...options, now });
  //const document = buildTemplateDocument({ ...options, now });
  const parts: string[] = [];

  if (options.includeFrontmatter !== false) {
    const lines = [
      "---",
      `${FRONTMATTER_FIELDS.tags}: ${renderYamlValue(options.tags ?? [])}`,
      `${FRONTMATTER_FIELDS.status}: ${renderYamlValue(aggregateStatus(document))}`,
      `${FRONTMATTER_FIELDS.titles}: ${renderYamlValue(document.workflows.map((workflow) => workflow.title))}`,
      `${FRONTMATTER_FIELDS.updated}: ${toDateOnly(formatLocalIso(now))}`,
    ];
    // Phase 21：首帧主题 = 默认主题（缺省写 `default`；显式空串才不写该键）
    const theme = options.theme ?? DEFAULT_TEMPLATE_THEME;
    if (theme.length > 0) {
      lines.push(`${FRONTMATTER_FIELDS.theme}: ${renderYamlValue(theme)}`);
    }
    lines.push("---");
    parts.push(lines.join("\n"));
  }

  if (options.includeRenderBlock !== false) parts.push(TEMPLATE_RENDER_BLOCK);
  parts.push(`## ${t("template.heading")}`);
  parts.push(buildTemplateNoteSection(document));
  parts.push(buildWfJsonBlock(document).trimEnd());
  return `${parts.join("\n\n")}\n`;
}
