/**
 * wfjson Schema v1.9 —— 以 JSON Schema（draft 2020-12 的子集）表达。
 *
 * 为什么用 JSON Schema 而不是手写一堆 if：
 *  - 决策 1 要求「可做 JSON Schema 校验」，本文件既供插件内部校验器使用，
 *    也可原样导出给外部工具 / AI 当契约使用（单一事实来源，避免文档与代码漂移）；
 *  - 校验器只实现本文件用到的关键字（见 schemaValidator.ts），零第三方依赖。
 *
 * 支持的关键字：$ref / type / enum / const / required / properties /
 * additionalProperties / items / minItems / uniqueItems / minimum / maximum /
 * minLength / maxLength / pattern / anyOf，以及本插件自定义的 x-hint（报错提示文案）。
 *
 * 版本策略：一份 Schema 覆盖白名单内的全部版本（1.0 / 1.1 / 1.3 / 1.6 / 1.9）——
 * 历次新增字段（`workflow.state` / `originId`、`node.timeEntries` / `archive`、
 * `progress_max`、`links` / `links_relative_path`）都是**可选**字段，因此老数据照样通过。
 *
 * v1.9 的特殊处理：
 *  - `links` / `links_relative_path` 已**弃用**（超链接唯一来源改为正文纪要段）：
 *    为让白名单内的旧文件（`additionalProperties:false`）继续通过校验，这里仍保留声明，
 *    但引擎一律忽略、不再写回；
 *  - `estimate` / `tags` / `relations` / `link.reason` 同样保留声明、引擎忽略。
 *
 * Phase 20 / Phase 22 都是**可选字段**（`node.note` / `noteVisible`、文件级 `workflow_archive`），
 * 老数据缺省即「没有」，语义与 1.9 完全一致 —— 与 Phase 20 一样**不升 schemaVersion**，
 * 只扩 Schema 的 `properties` / `$defs`。
 *
 * Phase 24 M1.6 同理：文件级 `noteKey`（笔记身份键，10 位十六进制）是可选字段，
 * 老数据缺省不影响任何语义（侧车文件名里的 `~<key>` 才是权威来源，写回时自愈）。
 *
 * 字段规范文档：doc/datacontact/data_ixd_v09.md
 */

import type { JsonSchemaObject } from "./schemaValidator.ts";
import { validateAgainstSchema } from "./schemaValidator.ts";
import { type WfIssue } from "./issues.ts";
import { NOTE_ANCHOR_PATTERN } from "./ids.ts";
import { ISO_DATE_OR_DATETIME_PATTERN, ISO_DATE_PATTERN } from "./time.ts";
import {
  IMPORTANCE_MAX,
  IMPORTANCE_MIN,
  LINK_ROLES,
  LINK_TYPES,
  NODE_STATUSES,
  PROGRESS_MAX,
  PROGRESS_MIN,
  RELATION_KINDS,
  WORKFLOW_STATES,
} from "./types.ts";

const TEXT = { type: "string", minLength: 1 } as const;
const TIMESTAMP = {
  type: "string",
  pattern: ISO_DATE_OR_DATETIME_PATTERN,
  "x-hint": "ISO8601 时间，如 2026-10-10T12:00:00+08:00（也允许 2026-10-10）",
  "x-hint-en": "ISO8601 timestamp, e.g. 2026-10-10T12:00:00+08:00 (a plain 2026-10-10 is also allowed)",
} as const;
const DATE_ONLY = {
  type: "string",
  pattern: ISO_DATE_PATTERN,
  "x-hint": "纯日期 YYYY-MM-DD（= toDateOnly(startAt)，不做 UTC 换算）",
  "x-hint-en": "Date only, YYYY-MM-DD (= toDateOnly(startAt), no UTC conversion)",
} as const;

export const WFJSON_SCHEMA: JsonSchemaObject = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://github.com/watcher-obsidian-plug/wfjson-schema-1.9.json",
  title: "wfjson v1.9",
  description:
    "工作流笔记的数据块格式：一个文件一个 wfjson 代码块，内含多个工作流（向后兼容 1.0 / 1.1 / 1.3 / 1.6 / 1.9）。",
  type: "object",
  required: ["schemaVersion", "id", "workflows"],
  additionalProperties: false,
  properties: {
    schemaVersion: {
      type: "string",
      minLength: 1,
      "x-hint": "当前版本为 \"1.9\"；白名单并列支持 \"1.0\" / \"1.1\" / \"1.3\" / \"1.6\" / \"1.9\"（从未发布的 \"1.2\" / \"1.4\" / \"1.5\" / \"1.7\" / \"1.8\" 不受支持）", "x-hint-en": "Current version is \"1.9\"; the whitelist also accepts \"1.0\" / \"1.1\" / \"1.3\" / \"1.6\" / \"1.9\" (the never-released \"1.2\" / \"1.4\" / \"1.5\" / \"1.7\" / \"1.8\" are unsupported)",
    },
    id: { ...TEXT, "x-hint": "文件级稳定 id，推荐 file-<uuid>", "x-hint-en": "Stable file-level id; file-<uuid> recommended" },
    updatedAt: { ...TIMESTAMP, "x-hint": "文件最后更新时间，frontmatter 的 wf-updated 取其日期部分", "x-hint-en": "Last update of the file; the frontmatter wf-updated takes its date part" },
    noteKey: {
      type: "string",
      pattern: "^[0-9a-f]{10}$",
      "x-hint":
        "Phase 24 M1.6：笔记身份键（10 位十六进制）= 侧车文件名里的 `~<key>`，也写进笔记 frontmatter 的 wf-key。由笔记路径算出，插件每次写回都会按当前路径重算；缺省 = 还没写过这一版",
      "x-hint-en":
        "Phase 24 M1.6: note identity key (10 hex chars) — the `~<key>` in the sidecar file name, also written to the frontmatter wf-key. Derived from the note path and refreshed on every write-back; absent = not written yet",
    },
    workflows: {
      type: "array",
      minItems: 1,
      items: { $ref: "#/$defs/workflow" },
      "x-hint": "一个文件可承载多个工作流；每个工作流一棵树",
      "x-hint-en": "One file can hold several workflows; each workflow is a single tree",
    },
    workflow_archive: {
      type: "array",
      items: { $ref: "#/$defs/workflowArchiveEntry" },
      "x-hint":
        "Phase 22：整条工作流归档的台账（一条工作流一条记录）。只有「归档整个工作流」会写，节点级归档不写；缺省 = 本文没有整条流归档过",
      "x-hint-en":
        "Phase 22: ledger of whole-workflow archives (one entry per workflow). Written only by “archive the whole workflow”; node-level archives leave it untouched",
    },
    archivedAt: {
      ...TIMESTAMP,
      "x-hint":
        "Phase 28：归档快照的归档时间（只有归档文件会写；归档看板的 21 天窗口默认以它为结束日）",
      "x-hint-en":
        "Phase 28: archive time of this snapshot (only archive files carry it; archived boards use it as the default end of the 21-day window)",
    },
  },
  $defs: {
    /**
     * Phase 22：整条工作流归档的一条台账。
     *
     * 四个字段都必填：`workflowId` / `title` 认人（哪条流），`noteAnchor` 认位置（本文正文里的浓缩根节点），
     * `archive` 与根节点的 `archive` 同值（时间 / 归档文件 的 workflowId / 三段文字）。
     */
    workflowArchiveEntry: {
      type: "object",
      required: ["workflowId", "title", "noteAnchor", "archive"],
      additionalProperties: false,
      "x-hint": "整条工作流归档的台账条目（Phase 22）：workflowId / title / noteAnchor / archive 都必填",
      "x-hint-en": "Whole-workflow archive ledger entry (Phase 22): workflowId / title / noteAnchor / archive are all required",
      properties: {
        workflowId: {
          ...TEXT,
          "x-hint": "被整体归档的原工作流 id（它仍留在 workflows[] 里，只是根节点变成浓缩节点）",
          "x-hint-en": "Id of the original workflow that was archived (it stays in workflows[]; only its root became the condensed node)",
        },
        title: {
          ...TEXT,
          "x-hint": "原工作流标题（浓缩后 workflows[].title 不变，这里留一份快照便于阅读）",
          "x-hint-en": "Title of the original workflow (a snapshot for readability; workflows[].title does not change)",
        },
        noteAnchor: {
          type: "string",
          pattern: NOTE_ANCHOR_PATTERN,
          "x-hint": "浓缩根节点在正文里的纪要锚点（= 根节点的 noteAnchor，形如 ^nd-xxx）",
          "x-hint-en": "Note anchor of the condensed root inside this note (= the root's noteAnchor, e.g. ^nd-xxx)",
        },
        archive: { $ref: "#/$defs/archive" },
      },
    },
    /**
     * Phase 20：note 卡片里的一条（文字 / 待办）。
     *
     * 三态落在 `done` 上：**缺省 = 文字 / false = 待办 / true = 已办**。
     * `additionalProperties: false` 保证不会有人往里塞 `kind` / `checked` 之类的别名。
     */
    noteItem: {
      type: "object",
      required: ["text"],
      additionalProperties: false,
      properties: {
        text: {
          ...TEXT,
          "x-hint": "Phase 20：note 的一条正文（一行；空串 / 全空白会在写回前被丢弃）",
          "x-hint-en": "Phase 20: one note line (empty / blank lines are dropped before write-back)",
        },
        done: {
          type: "boolean",
          "x-hint": "Phase 20：缺省 = 文字；false = 待办；true = 已办",
          "x-hint-en": "Phase 20: absent = plain text; false = todo; true = done",
        },
      },
    },
    workflow: {
      type: "object",
      required: ["id", "title", "root"],
      additionalProperties: false,
      properties: {
        id: { ...TEXT, "x-hint": "工作流稳定 id，推荐 wf-<uuid>", "x-hint-en": "Stable workflow id; wf-<uuid> recommended" },
        title: TEXT,
        state: {
          enum: [...WORKFLOW_STATES],
          "x-hint":
            "工作流级人工状态（v1.1）：archived=已归档 / cancelled=已取消；缺省即进行中（省略该键，\"doing\" 不是合法取值）", "x-hint-en":
            "Manual workflow state (v1.1): archived / cancelled; absent means active (omit the key, \"doing\" is not a valid value)",
        },
        originId: {
          ...TEXT,
          "x-hint":
            "归档来源（v1.1）：由归档创建时 = 原文档浓缩节点的 id；非归档创建时省略该键（仅作引用，不做 id 前缀/唯一性校验）",
          "x-hint-en":
            "Archive origin (v1.1): when the workflow was created by archiving, the id of the condensed node in the source note; otherwise omit the key (reference only, no id prefix / uniqueness check)",
        },
        progress: {
          type: "integer",
          minimum: PROGRESS_MIN,
          maximum: PROGRESS_MAX,
          "x-hint": "工作流级进度概览（v1.6：0-999 的整数，缺省 0；与根节点 progress 相互独立）",
          "x-hint-en": "Workflow-level progress overview (v1.6: integer 0-999, default 0; independent of the root node's progress)",
        },
        progress_max: {
          type: "integer",
          minimum: PROGRESS_MIN,
          maximum: PROGRESS_MAX,
          "x-hint": "工作流级进度总量（v1.6：0-999 的整数，缺省 1）",
          "x-hint-en": "Workflow-level progress total (v1.6: integer 0-999, default 1)",
        },
        archive: { $ref: "#/$defs/workflowArchive" },
        root: { $ref: "#/$defs/node" },
      },
    },
    node: {
      type: "object",
      required: ["id", "title", "status", "children"],
      additionalProperties: false,
      properties: {
        id: { ...TEXT, "x-hint": "节点稳定 id，推荐 nd-<uuid>", "x-hint-en": "Stable node id; nd-<uuid> recommended" },
        title: TEXT,
        /**
         * @deprecated Phase 45 废弃：节点说明文字改为工作流级 `workflow.archive` 的四条复盘说明。
         * 保留声明只为让旧文件继续通过（引擎忽略、不再写回；卡片不再展示）。
         */
        summary: {
          ...TEXT,
          "x-hint": "已弃用（Phase 45）：节点概要；引擎读时忽略、不再写回，说明改填工作流的 archive 四条说明",
          "x-hint-en":
            "Deprecated (Phase 45): node summary; ignored when reading and no longer written back — use the workflow archive notes instead",
        },
        /**
         * Phase 20：note 卡片的条目集合（文字 / 待办，每条一行）。
         * 与正文纪要段的 `noteAnchor` 无关；空数组会连同 `noteVisible` 一起被删键。
         */
        note: {
          type: "array",
          items: { $ref: "#/$defs/noteItem" },
          "x-hint": "Phase 20：note 卡片的条目集合（每条一行；done 缺省 = 文字 / false = 待办 / true = 已办）",
          "x-hint-en":
            "Phase 20: note card items (one per line; done absent = text / false = todo / true = done)",
        },
        /** Phase 20：note 卡片是否显示（缺省 false = OFF；OFF 时不写该键，文本仍保留） */
        noteVisible: {
          type: "boolean",
          "x-hint": "Phase 20：note 卡片是否显示（缺省 false = OFF）",
          "x-hint-en": "Phase 20: show the note card (default false = OFF)",
        },
        type: { type: "string", "x-hint": "节点类型：决策 / 调查 / 执行 / 验证 / 资料 …（自由字符串）", "x-hint-en": "Node type: decision / research / execution / verification / reference … (free-form string)" },
        status: { enum: [...NODE_STATUSES] },
        importance: {
          type: "integer",
          minimum: IMPORTANCE_MIN,
          maximum: IMPORTANCE_MAX,
          "x-hint": "重要程度（v1.6：1-4；1=低 / 2=中低 / 3=中高 / 4=高；4 在视图里以黑体强调）",
          "x-hint-en": "Importance (v1.6: 1-4; 1=low / 2=medium-low / 3=medium-high / 4=high; 4 is bolded in the view)",
        },
        urgency: {
          type: "integer",
          minimum: IMPORTANCE_MIN,
          maximum: IMPORTANCE_MAX,
          "x-hint": "紧急程度（v1.6：1-4；1=低 / 2=中低 / 3=中高 / 4=高）",
          "x-hint-en": "Urgency (v1.6: 1-4; 1=low / 2=medium-low / 3=medium-high / 4=high)",
        },
        collapsed: { type: "boolean" },
        progress: {
          type: "integer",
          minimum: PROGRESS_MIN,
          maximum: PROGRESS_MAX,
          "x-hint": "已完成量（v1.6：0-999 的整数，缺省 0；与 status 解耦，progress 可大于 progress_max）",
          "x-hint-en": "Completed amount (v1.6: integer 0-999, default 0; decoupled from status, progress may exceed progress_max)",
        },
        progress_max: {
          type: "integer",
          minimum: PROGRESS_MIN,
          maximum: PROGRESS_MAX,
          "x-hint": "总量（v1.6：0-999 的整数，缺省 1；视图以「进度：a/b」展示）",
          "x-hint-en": "Total amount (v1.6: integer 0-999, default 1; shown in the view as \"Progress: a/b\")",
        },
        owner: TEXT,
        startAt: TIMESTAMP,
        updatedAt: TIMESTAMP,
        completedAt: TIMESTAMP,
        dueAt: TIMESTAMP,
        /** @deprecated v1.6 删除：保留声明只为让旧文件继续通过（引擎忽略、不再写回） */
        estimate: {
          anyOf: [TEXT, { type: "integer", minimum: 0 }],
          "x-hint": "已弃用（v1.6 删除）：预计耗时；引擎忽略该键，不报错",
          "x-hint-en": "Deprecated (removed in v1.6): estimated effort; the engine ignores this key without reporting it",
        },
        /** @deprecated v1.6 删除：保留声明只为让旧文件继续通过（引擎忽略、不再写回） */
        tags: {
          type: "array",
          items: TEXT,
          uniqueItems: true,
          "x-hint": "已弃用（v1.6 删除）：引擎忽略该键，不报错",
          "x-hint-en": "Deprecated (removed in v1.6): the engine ignores this key without reporting it",
        },
        aliases: { type: "array", items: TEXT, uniqueItems: true },
        /** @deprecated Phase 9 弃用：超链接唯一来源改为正文纪要段（引擎忽略、不再写回） */
        links_relative_path: {
          type: "string",
          "x-hint": "已弃用（Phase 9）：正文纪要改用「标题 + 锚点 + wf-note 标志段」定位；引擎忽略该键、不报错",
          "x-hint-en": "Deprecated (Phase 9): note sections are located by heading + anchor + wf-note markers; the engine ignores this key without reporting it",
        },
        noteAnchor: {
          type: "string",
          pattern: NOTE_ANCHOR_PATTERN,
          "x-hint": "同文件纪要的 block id，约定为 \"^\" + 节点 id，例如 ^nd-uuid-001", "x-hint-en": "Block id of the note section in this file; by convention \"^\" + node id, e.g. ^nd-uuid-001",
        },
        /** @deprecated Phase 9：超链接唯一来源改为正文纪要段（旧文件照读；写回时迁移并删除该键） */
        links: {
          type: "array",
          items: { $ref: "#/$defs/link" },
          "x-hint": "已弃用（Phase 9）：超链接改存正文纪要段；引擎读时忽略，写回时迁进正文",
          "x-hint-en": "Deprecated (Phase 9): links now live in the note section; ignored when reading and migrated into the body on write-back",
        },
        /** @deprecated v1.6 删除：保留声明只为让旧文件继续通过（引擎忽略、不再写回） */
        relations: {
          type: "array",
          items: { $ref: "#/$defs/relation" },
          "x-hint": "已弃用（v1.6 删除）：引擎忽略该键、不报错，也不再做依赖/循环校验",
          "x-hint-en": "Deprecated (removed in v1.6): the engine ignores this key without reporting it and no longer checks dependencies / cycles",
        },
        children: { type: "array", items: { $ref: "#/$defs/node" } },
        statusHistory: { type: "array", items: { $ref: "#/$defs/statusEvent" } },
        timeEntries: {
          type: "array",
          items: { $ref: "#/$defs/timeEntry" },
          "x-hint": "计时会话（v1.3）：每次「开始这个任务」追加一条，进行中的那条省略 endAt / hours",
          "x-hint-en": "Timing sessions (v1.3): one entry per \"Start this task\"; the running entry omits endAt / hours",
        },
        archive: { $ref: "#/$defs/archive" },
        aiContext: TEXT,
        /**
         * Phase 34：新建链接文档的默认目录（vault 相对路径；缺省 / 空串 = 没设置过）。
         *
         * 与四个 `wf-*` frontmatter 键无关（那些在资料文件上）；这里只是「下次新建放哪」的偏好，
         * 新建子节点时由引擎继承父节点的值。可选字段 → 不升 schemaVersion。
         */
        linkDir: {
          type: "string",
          "x-hint": "新建链接文档的默认目录（vault 相对路径；缺省 / 空串 = 没设置过，回落第一份已匹配文档的目录或库根）",
          "x-hint-en":
            "Default folder for new link docs (vault-relative; missing / empty = not set, falls back to the first matched doc's folder or the vault root)",
        },
      },
    },
    link: {
      type: "object",
      required: ["id", "type", "target"],
      additionalProperties: false,
      properties: {
        id: { ...TEXT, "x-hint": "链接稳定 id，推荐 lk-<uuid>", "x-hint-en": "Stable link id; lk-<uuid> recommended" },
        type: { enum: [...LINK_TYPES] },
        target: {
          ...TEXT,
          "x-hint": "裸目标（笔记名/文件名/URL），不带 [[ ]]、![[ ]]、!",
          "x-hint-en": "Bare target (note name / file name / URL), without [[ ]], ![[ ]] or !",
        },
        role: { enum: [...LINK_ROLES] },
        label: TEXT,
        /** @deprecated v1.6 删除（引擎忽略、不再写回） */
        reason: { type: "string", "x-hint": "已弃用（v1.6 删除）：引擎忽略该键，不报错", "x-hint-en": "Deprecated (removed in v1.6): the engine ignores this key without reporting it" },
      },
    },
    relation: {
      type: "object",
      required: ["target", "kind"],
      additionalProperties: false,
      properties: {
        target: { ...TEXT, "x-hint": "目标节点/工作流的 id（允许跨文件引用）", "x-hint-en": "Id of the target node / workflow (cross-file references allowed)" },
        kind: { enum: [...RELATION_KINDS] },
        note: { type: "string" },
      },
    },
    statusEvent: {
      type: "object",
      required: ["from", "to", "at"],
      additionalProperties: false,
      properties: {
        from: { enum: [...NODE_STATUSES] },
        to: { enum: [...NODE_STATUSES] },
        at: TIMESTAMP,
        by: TEXT,
        note: { type: "string" },
      },
    },
    /** v1.3：一条计时会话（进行中省略 endAt / hours，不写 null） */
    timeEntry: {
      type: "object",
      required: ["startAt", "date"],
      additionalProperties: false,
      properties: {
        startAt: { ...TIMESTAMP, "x-hint": "计时开始时间（≈ formatLocalIso(now)）", "x-hint-en": "Timer start time (≈ formatLocalIso(now))" },
        date: DATE_ONLY,
        endAt: { ...TIMESTAMP, "x-hint": "结束时间；进行中省略该键（不写 null）", "x-hint-en": "End time; omit this key while running (do not write null)" },
        hours: {
          type: "number",
          minimum: 0,
          "x-hint": "本次时长（小时，1 位小数）= Math.round((endAt-startAt)/3600000*10)/10；进行中省略",
          "x-hint-en": "Duration in hours, 1 decimal = Math.round((endAt-startAt)/3600000*10)/10; omitted while running",
        },
      },
    },
    /**
     * v1.3：浓缩归档标记（**Phase 39 定稿：只剩一个指针**）。
     *
     * 挂在原文档的浓缩节点（`status=done`）上，指向归档文件里的 `workflow.id`。
     * 三段文字 / 归档时间 / 来源（原工作流名 + 原节点名）都在归档文件自己的
     * `workflow.archive`（见 `$defs.workflowArchive`）。
     */
    archive: {
      type: "object",
      required: ["workflowId"],
      additionalProperties: false,
      "x-hint":
        "浓缩归档标记（v1.3，Phase 39 定稿）：只有 workflowId（= 归档文件里的 workflow.id）；说明文字在归档文件自己的 workflow.archive 上",
      "x-hint-en":
        "Condensed archive marker (v1.3, Phase 39): only workflowId (= the workflow.id inside the archive file); the notes live in that file's own workflow.archive",
      properties: {
        workflowId: {
          ...TEXT,
          "x-hint": "归档文件里的 workflow id（视图「打开归档看板」/ 幂等认领靠它在 archive/ 里定位那份 .wf.json）",
          "x-hint-en":
            "Workflow id inside the archive file (used by “Open archived board” and idempotent retries to locate that .wf.json under archive/)",
        },
      },
    },
    /**
     * Phase 39：归档元数据（`workflow.archive`）。
     *
     * Phase 45：三个事实键（`archivedAt` / `from_workflow` / `from_node`）改为**选填** ——
     * 「修改工作流」弹窗允许任意工作流只写 summary / idea / review / tag 四条复盘说明。
     * 归档文件仍会写全三个事实键；普通工作流填说明时一个都不写。
     */
    workflowArchive: {
      type: "object",
      additionalProperties: false,
      "x-hint":
        "归档元数据（Phase 39/45）：archivedAt / from_workflow / from_node 只在真归档时写；summary / idea / review / tag 任意工作流都可选填",
      "x-hint-en":
        "Archive metadata (Phase 39/45): archivedAt / from_workflow / from_node only on real archives; summary / idea / review / tag are optional on any workflow",
      properties: {
        archivedAt: {
          ...TIMESTAMP,
          "x-hint": "归档时间（日期 + 精确到分钟，如 2026-10-12 14:30）",
          "x-hint-en": "Archive time (date + minutes, e.g. 2026-10-12 14:30)",
        },
        from_workflow: {
          ...TEXT,
          "x-hint": "来源工作流标题（归档发生的那条流）",
          "x-hint-en": "Source workflow title (the workflow the archive was taken from)",
        },
        from_node: {
          ...TEXT,
          "x-hint": "来源节点标题（被浓缩的节点 / 整条流归档时的根节点）",
          "x-hint-en": "Source node title (the condensed node / the root when a whole workflow was archived)",
        },
        summary: { ...TEXT, "x-hint": "概括（归档表单选填）", "x-hint-en": "Summary (optional in the archive form)" },
        idea: { ...TEXT, "x-hint": "底层原理 / 启发（归档表单选填）", "x-hint-en": "Underlying principle / insight (optional in the archive form)" },
        review: { ...TEXT, "x-hint": "怎么提高效率 / 接下来做什么（归档表单选填）", "x-hint-en": "How to be faster / what comes next (optional in the archive form)" },
        tag: {
          type: "array",
          items: TEXT,
          uniqueItems: true,
          "x-hint": "归档标签（Phase 39：枚举来自 archive_tag.yaml，可多选）",
          "x-hint-en": "Archive tags (Phase 39: enumerated in archive_tag.yaml, multi-select)",
        },
      },
    },
  },
};

/**
 * 「一个节点的 links 数组」的独立 Schema。
 *
 * 为什么单独抽出来：ResourceModal（编辑资源列表）需要在**保存前**就地校验用户手写的 JSON，
 * 校验规则必须与写回时用的同一份定义（否则会出现「Modal 放过、写回被拒」的割裂体验）。
 * 这里直接引用 `#/$defs/link`，保证与 `node.links` 完全一致。
 */
export const LINKS_ARRAY_SCHEMA: JsonSchemaObject = {
  type: "array",
  items: { $ref: "#/$defs/link" },
};

/** 校验一个「links 数组」值（Modal 保存前调用）：返回 Schema 问题，空数组即通过 */
export function validateLinksValue(value: unknown): WfIssue[] {
  return validateAgainstSchema(value, LINKS_ARRAY_SCHEMA, { rootSchema: WFJSON_SCHEMA });
}
