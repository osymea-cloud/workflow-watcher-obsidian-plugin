/**
 * 单测共用的样例数据（仅测试使用；不被 index.ts 导出，不会进入插件包）。
 *
 * 这里的样例刻意「全绿」：既通过 Schema 校验，也通过一致性检查，
 * 这样任何一条新增问题都会让测试立刻发现回归。
 */

import type { WfJsonDocument, WfNode } from "./types.ts";

export const FILE_ID = "file-uuid-001";
export const WF1_ID = "wf-uuid-001";
export const WF2_ID = "wf-uuid-002";
export const ROOT_ID = "nd-uuid-001";
export const CHILD_ID = "nd-uuid-002";
export const DOING_ID = "nd-uuid-003";
export const WF2_ROOT_ID = "nd-uuid-004";

/** 叶子节点（children 为 []） */
export function leaf(id: string, title: string, extra: Partial<WfNode> = {}): WfNode {
  return { id, title, status: "todo", progress: 0, noteAnchor: `^${id}`, children: [], ...extra };
}

/** 合法文档：两个工作流，覆盖 links / relations / statusHistory / 时间字段 */
export function validDocument(): WfJsonDocument {
  const root: WfNode = {
    id: ROOT_ID,
    title: "调研竞品",
    summary: "对比三家竞品的功能与定价",
    type: "investigate",
    status: "done",
    importance: 4,
    urgency: 3,
    collapsed: false,
    progress: 5,
    progress_max: 5,
    owner: "张三",
    startAt: "2026-10-01T09:30:00+08:00",
    updatedAt: "2026-10-05T10:00:00+08:00",
    completedAt: "2026-10-05T10:00:00+08:00",
    dueAt: "2026-10-04T18:00:00+08:00",
    estimate: "2h",
    tags: ["竞品"],
    aliases: ["竞争分析"],
    noteAnchor: "^nd-uuid-001",
    links: [
      { id: "lk-1", type: "md", target: "竞品分析报告", role: "detail", label: "竞品分析报告", reason: "详细对比数据" },
      { id: "lk-2", type: "web", target: "https://example.com", role: "source", label: "官方文档", reason: "权威说明" },
      { id: "lk-3", type: "image", target: "竞品截图.png", role: "detail", label: "竞品截图" },
    ],
    relations: [
      { target: CHILD_ID, kind: "dependsOn", note: "先整理结论" },
      { target: WF2_ID, kind: "related", note: "与实现方案工作流相关" },
    ],
    children: [
      leaf(CHILD_ID, "整理结论"),
      leaf(DOING_ID, "交叉验证", { status: "doing", progress: 1 }),
    ],
    statusHistory: [
      { from: "todo", to: "doing", at: "2026-10-01T09:30:00+08:00", by: "张三", note: "开始调研" },
      { from: "doing", to: "done", at: "2026-10-05T10:00:00+08:00", by: "张三", note: "结论已产出" },
    ],
    aiContext: "竞品调研的补充上下文，供 AI 理解节点语义。",
  };

  return {
    schemaVersion: "1.0",
    id: FILE_ID,
    updatedAt: "2026-10-10T12:00:00+08:00",
    workflows: [
      { id: WF1_ID, title: "立项调查", root },
      {
        id: WF2_ID,
        title: "实现方案",
        progress: 0,
        root: leaf(WF2_ROOT_ID, "方案初稿"),
      },
    ],
  };
}

/** 与 validDocument 匹配的 frontmatter（wf-status 为全部节点的聚合值 doing） */
export const VALID_FRONTMATTER = [
  "---",
  "wf-tags: [竞品]",
  "wf-status: doing",
  "wf-titles: [立项调查, 实现方案]",
  "wf-updated: 2026-10-10",
  "---",
  "",
].join("\n");

/** 与 validDocument 匹配的正文（含 4 个纪要段落锚点） */
export const VALID_BODY = [
  "# 立项调查",
  "",
  "## 调研竞品 ^nd-uuid-001",
  "",
  "三家竞品的对比结论见 [[竞品分析报告]]。",
  "",
  "### 整理结论 ^nd-uuid-002",
  "",
  "（纪要待补充）",
  "",
  "### 交叉验证 ^nd-uuid-003",
  "",
  "（纪要待补充）",
  "",
  "# 实现方案",
  "",
  "## 方案初稿 ^nd-uuid-004",
  "",
].join("\n");

/** 只有 wfjson 代码块（无 frontmatter，用于纯解析 / 一致性单测） */
export function wfjsonBlockOnly(document: WfJsonDocument = validDocument()): string {
  return `# 笔记\n\n\`\`\`wfjson\n${JSON.stringify(document, null, 2)}\n\`\`\`\n`;
}

/** frontmatter + 正文 + wfjson 代码块（最接近真实文件的样例） */
export function validMarkdown(document: WfJsonDocument = validDocument()): string {
  return `${VALID_FRONTMATTER}${VALID_BODY}\n\`\`\`wfjson\n${JSON.stringify(document, null, 2)}\n\`\`\`\n`;
}

/** 深拷贝（避免测试相互污染） */
export function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/* ------------------------------------------------------------------ *
 * v1.1 样例：第 2 个 workflow 由归档创建（`state="archived"` + `originId`）。
 * 与 validDocument 一样「全绿」：通过 Schema，且一致性检查零问题。
 * ------------------------------------------------------------------ */

export const ARCHIVE_ROOT_ID = "nd-uuid-004";
export const ARCHIVED_WF_TITLE = "实现方案（已归档）";

/** 已完成叶子（1.1 样例需要显式的时间与状态历史，才能同时满足 done 的一致性规则） */
function doneLeaf(id: string, title: string, startAt: string, completedAt: string, extra: Partial<WfNode> = {}): WfNode {
  return {
    id,
    title,
    status: "done",
    progress: 5,
    progress_max: 5,
    startAt,
    updatedAt: completedAt,
    completedAt,
    noteAnchor: `^${id}`,
    children: [],
    statusHistory: [
      { from: "todo", to: "doing", at: startAt },
      { from: "doing", to: "done", at: completedAt },
    ],
    ...extra,
  };
}

/** 合法文档（schemaVersion = 1.1）：工作流 1 全 done，工作流 2 为归档 workflow */
export function validDocument11(): WfJsonDocument {
  const root = doneLeaf(ROOT_ID, "调研竞品", "2026-10-01T09:30:00+08:00", "2026-10-05T10:00:00+08:00", {
    tags: ["竞品"],
    children: [
      doneLeaf(CHILD_ID, "整理结论", "2026-10-05T10:00:00+08:00", "2026-10-06T12:00:00+08:00"),
      doneLeaf(DOING_ID, "交叉验证", "2026-10-06T13:00:00+08:00", "2026-10-07T09:00:00+08:00"),
    ],
  });
  const archivedRoot = doneLeaf(ARCHIVE_ROOT_ID, "📦 实现方案", "2026-10-06T09:00:00+08:00", "2026-10-08T18:00:00+08:00", {
    importance: 4,
    tags: ["归档"],
  });

  return {
    schemaVersion: "1.1",
    id: FILE_ID,
    updatedAt: "2026-10-10T12:00:00+08:00",
    workflows: [
      { id: WF1_ID, title: "立项调查", root },
      { id: WF2_ID, title: ARCHIVED_WF_TITLE, state: "archived", originId: ROOT_ID, root: archivedRoot },
    ],
  };
}

/** 与 validDocument11 匹配的 frontmatter（两个 workflow 都贡献 done → wf-status = done） */
export const VALID_FRONTMATTER_11 = [
  "---",
  "wf-tags: [竞品, 归档]",
  "wf-status: done",
  `wf-titles: [立项调查, ${ARCHIVED_WF_TITLE}]`,
  "wf-updated: 2026-10-10",
  "---",
  "",
].join("\n");

/** 与 validDocument11 匹配的正文（含 4 个纪要段落锚点） */
export const VALID_BODY_11 = [
  "# 立项调查",
  "",
  "## 调研竞品 ^nd-uuid-001",
  "",
  "三家竞品的对比结论。",
  "",
  "### 整理结论 ^nd-uuid-002",
  "",
  "（纪要待补充）",
  "",
  "### 交叉验证 ^nd-uuid-003",
  "",
  "（纪要待补充）",
  "",
  `# ${ARCHIVED_WF_TITLE}`,
  "",
  "## 📦 实现方案 ^nd-uuid-004",
  "",
  "（归档摘要待补充）",
  "",
].join("\n");

/** frontmatter + 正文 + wfjson 代码块（v1.1 真实文件样例） */
export function validMarkdown11(): string {
  return `${VALID_FRONTMATTER_11}${VALID_BODY_11}\n\`\`\`wfjson\n${JSON.stringify(validDocument11(), null, 2)}\n\`\`\`\n`;
}

/* ------------------------------------------------------------------ *
 * v1.3 样例：在 v1.1 样例之上加「计时条目」（`timeEntries`）与「浓缩归档标记」（`archive`）。
 * 与前面两组一样「全绿」：通过 Schema，且一致性检查零问题（含 TIME_* 三条规则）。
 * ------------------------------------------------------------------ */

export const TIME_ROOT_START = "2026-10-02T09:00:00+08:00";
export const TIME_ROOT_END = "2026-10-02T11:30:00+08:00";
export const TIME_CHILD_START = "2026-10-06T13:00:00+08:00";
export const TIME_ARCHIVED_AT = "2026-10-08 18:30";
/** 归档 md 里的 workflow id（归档时重新生成，与浓缩节点 `archive.workflowId` 一致） */
export const ARCHIVE_WF_ID = "wf-uuid-101";
/** 归档文件路径：确定性路径 `archive/<workflowId>-<nodeId>.wf.json`（nodeId = 浓缩节点 id） */
export const ARCHIVE_FILE = `archive/${ARCHIVE_WF_ID}-${ARCHIVE_ROOT_ID}.wf.json`;

/**
 * 合法文档（schemaVersion = 1.3）：
 *  - 根节点 2 条已完成计时（2026-10-02 共 2.5h、2026-10-05 共 6h）；
 *  - 第 2 个子节点 1 条已完成计时（2026-10-06 共 1h）；
 *  - 归档 workflow 的根节点带 `archive`（Phase 39 定稿：节点侧只有 `{ workflowId }`）。
 */
export function validDocument13(): WfJsonDocument {
  const document = clone(validDocument11());
  document.schemaVersion = "1.3";

  const root = document.workflows[0].root;
  root.timeEntries = [
    { startAt: TIME_ROOT_START, date: "2026-10-02", endAt: TIME_ROOT_END, hours: 2.5 },
    { startAt: "2026-10-05T10:00:00+08:00", date: "2026-10-05", endAt: "2026-10-05T16:00:00+08:00", hours: 6 },
  ];
  const secondChild = root.children[1];
  secondChild.timeEntries = [
    { startAt: TIME_CHILD_START, date: "2026-10-06", endAt: "2026-10-06T14:00:00+08:00", hours: 1 },
  ];

  document.workflows[1].root.archive = {
    workflowId: ARCHIVE_WF_ID,
  };
  return document;
}

/** frontmatter + 正文 + wfjson 代码块（v1.3 真实文件样例：摘要字段与 v1.1 样例一致） */
export function validMarkdown13(): string {
  return `${VALID_FRONTMATTER_11}${VALID_BODY_11}\n\`\`\`wfjson\n${JSON.stringify(validDocument13(), null, 2)}\n\`\`\`\n`;
}
