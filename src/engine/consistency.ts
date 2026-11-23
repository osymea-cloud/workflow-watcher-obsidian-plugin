/**
 * 一致性检查（决策 4：插件维护 + 校验报错，不静默失败）。
 *
 * 覆盖范围（全部登记在 issues.ts 的 ISSUE_CODES 中）：
 *  1. id 约定与前缀、重复检测；
 *  2. node.noteAnchor ↔ 正文 `^blockid`（缺失 / 重复 / 未挂标题 / 与 id 不一致 / 孤立锚点）；
 *  3. status ↔ statusHistory ↔ completedAt 与时间字段（v1.6：progress 已与 status 解耦）；
 *  4. `timeEntries[]`（v1.3：hours 范围、endAt 不早于 startAt、date 与 startAt 一致）；
 *  5. 正文纪要段的标志对（Phase 9：未配对 / 嵌套 / id 不匹配）；
 *  6. frontmatter 摘要字段（wf-status / wf-titles / wf-updated）。
 *
 * v1.6 已退役的规则（不再执行）：`relations[]`（字段已删除，读到即忽略）、
 * status ↔ progress 联动、`workflow.progress` 与根节点 progress 的大小比较。
 *
 * Phase 9 已弃用：`links[]`（超链接唯一来源改为正文纪要段）——读到即忽略，
 * 既不校验 link 级字段，也不再报 DUPLICATE_LINK_ID / LINK_TARGET_*。
 *
 * 只报告问题，不修改数据；修复动作由编辑层（后续模块）负责。
 */

import { idKindLabel, issueMsg, statusLabel, t } from "./i18n.ts";
import { issue, type WfIssue } from "./issues.ts";
import { isIsoDateOrDateTime, parseIso, toDateOnly } from "./time.ts";
import { ANCHOR_MARK, anchorForNode, ID_KIND_LABELS, ID_PATTERN, ID_PREFIX, idKindOf, type IdKind } from "./ids.ts";
import type { FrontmatterInfo } from "./frontmatter.ts";
import type { BlockAnchorRef } from "./markdownScan.ts";
import { checkNoteMarkers } from "./noteSection.ts";
import { flattenSubtree, indexIds, walkWorkflow } from "./tree.ts";
import {
  FRONTMATTER_FIELDS,
  FRONTMATTER_FIELD_NAMES,
  isNodeStatus,
  PROGRESS_MAX,
  PROGRESS_MIN,
  UNCLASSIFIED_WORKFLOW_ID,
  type NodeStatus,
  type WfJsonDocument,
  type WfNode,
  type WfWorkflow,
} from "./types.ts";

export interface ConsistencyInput {
  /** 原始 md 文本 */
  markdown: string;
  frontmatter: FrontmatterInfo;
  document: WfJsonDocument;
  /** 正文锚点索引：anchor（含 ^）→ 出现位置 */
  anchors: Map<string, BlockAnchorRef[]>;
  /**
   * 是否检查 frontmatter 摘要字段（默认 true）。
   * 纯 `.wf.json` 看板（Phase 28 的归档看板）没有笔记 / frontmatter → 传 false。
   */
  checkFrontmatter?: boolean;
}

/** 遍历所有节点，回调带 JSON Pointer 与所属工作流序号 */
export function forEachNode(
  document: WfJsonDocument,
  visit: (node: WfNode, pointer: string, workflowIndex: number) => void,
): void {
  document.workflows.forEach((workflow, workflowIndex) => {
    const step = (node: WfNode, pointer: string): void => {
      visit(node, pointer, workflowIndex);
      const children = Array.isArray(node.children) ? node.children : [];
      children.forEach((child, index) => step(child, `${pointer}/children/${index}`));
    };
    step(workflow.root, `/workflows/${workflowIndex}/root`);
  });
}

function checkIdFormat(id: string, expected: IdKind, pointer: string, issues: WfIssue[]): void {
  if (!ID_PATTERN.test(id)) {
    issues.push(
      issue("ID_FORMAT", issueMsg(
          "idFormat.pattern",
          `id "${id}" 不符合约定（应为 ${ID_PREFIX[expected]}<uuid> 形式）`,
          { id, prefix: ID_PREFIX[expected] },
        ), { path: pointer }),
    );
    return;
  }
  const kind = idKindOf(id);
  if (kind !== undefined && kind !== expected) {
    issues.push(
      issue(
        "ID_FORMAT",
        issueMsg(
          "idFormat.prefix",
          `id "${id}" 的前缀是 ${ID_PREFIX[kind]}（${ID_KIND_LABELS[kind]}），但该字段应为${ID_KIND_LABELS[expected]}`,
          { id, prefix: ID_PREFIX[kind], actual: idKindLabel(kind), expected: idKindLabel(expected) },
        ),
        { path: pointer },
      ),
    );
  }
}

/** 一致性检查主入口 */
export function checkConsistency(input: ConsistencyInput): WfIssue[] {
  const issues: WfIssue[] = [];

  checkIds(input.document, issues);
  checkStatusAndTime(input.document, issues);
  checkTimeEntries(input.document, issues);
  if (input.checkFrontmatter !== false) checkFrontmatterSummary(input, issues);

  return issues;
}

/* ------------------------------------------------------------------ *
 * Phase 27：以下三组「纪要段 / 锚点」检查**不再执行**（函数体留作历史）。
 *
 * 纪要段范式已弃用 —— 资料文件改用反向 YAML 归属（`linkAffiliation.ts`），
 * `NOTE_ANCHOR_*` / `NOTE_SECTION_*` / `ORPHAN_BLOCK_ANCHOR` 三个码也保留声明
 * （旧数据仍可能带），但不再产生新问题。
 * ------------------------------------------------------------------ */

/* ---- 正文纪要段标志对（Phase 9） ---- */

const NOTE_MARKER_CODES = {
  "unpaired-begin": "NOTE_SECTION_UNPAIRED",
  "unpaired-end": "NOTE_SECTION_UNPAIRED",
  nested: "NOTE_SECTION_NESTED",
  mismatch: "NOTE_SECTION_ID_MISMATCH",
} as const;

/**
 * @deprecated Phase 27：正文纪要段范式已弃用 —— 本函数**不再**被 `checkConsistency` 调用。
 * 留作历史 / 旧数据的手工体检（单测仍可直接调用）。
 */
export function checkNoteSections(input: ConsistencyInput, issues: WfIssue[]): void {
  for (const problem of checkNoteMarkers(input.markdown, input.frontmatter)) {
    issues.push(issue(NOTE_MARKER_CODES[problem.kind], problem.message, { line: problem.line }));
  }
}

/* ---- 1. id 约定与重复 ---- */

function checkIds(document: WfJsonDocument, issues: WfIssue[]): void {
  checkIdFormat(document.id, "file", "/id", issues);
  const ids = indexIds(document);

  document.workflows.forEach((workflow, index) => {
    checkIdFormat(workflow.id, "workflow", `/workflows/${index}/id`, issues);
  });
  forEachNode(document, (node, pointer) => {
    checkIdFormat(node.id, "node", `${pointer}/id`, issues);
  });

  for (const [id, occurrences] of ids.duplicated) {
    const kind = idKindOf(id);
    // Phase 9：links[] 已弃用（读时忽略），link id 既不校验格式也不报重复
    if (kind === "link") continue;
    const code = kind === "workflow" ? "DUPLICATE_WORKFLOW_ID" : "DUPLICATE_NODE_ID";
    issues.push(
      issue(code, issueMsg(
          "duplicateId",
          `id "${id}" 出现了 ${occurrences.length} 次（id 必须全局唯一）`,
          { id, count: occurrences.length },
        ), {
        path: kind === "workflow" ? "/workflows" : undefined,
      }),
    );
  }
}

/* ---- 2. noteAnchor ↔ 正文锚点 ---- */

/**
 * @deprecated Phase 27：纪要段 / `noteAnchor` 已弃用 —— 本函数**不再**被 `checkConsistency` 调用。
 * `NOTE_ANCHOR_*` 三个码仍保留声明（旧数据可能仍带），只是不再产生新问题。
 */
export function checkNoteAnchors(
  document: WfJsonDocument,
  anchors: Map<string, BlockAnchorRef[]>,
  issues: WfIssue[],
): void {
  forEachNode(document, (node, pointer) => {
    const anchor = node.noteAnchor;
    if (anchor === undefined) return;
    const locations = anchors.get(anchor);
    const expected = anchorForNode(node.id);
    if (!locations || locations.length === 0) {
      issues.push(
        issue("NOTE_ANCHOR_MISSING_IN_BODY", issueMsg(
            "noteAnchorMissing",
            `节点 ${node.id} 的 noteAnchor "${anchor}" 在正文中找不到`,
            { id: node.id, anchor },
          ), {
          path: `${pointer}/noteAnchor`,
        }),
      );
    } else {
      if (locations.length > 1) {
        issues.push(
          issue(
            "NOTE_ANCHOR_DUPLICATED_IN_BODY",
            issueMsg(
              "noteAnchorDuplicated",
              `锚点 "${anchor}" 在正文出现 ${locations.length} 次（第 ${locations.map((item) => item.line).join(t("issues.listSep"))} 行）`,
              {
                anchor,
                count: locations.length,
                lines: locations.map((item) => item.line).join(t("issues.listSep")),
              },
            ),
            { line: locations[0].line, path: `${pointer}/noteAnchor` },
          ),
        );
      }
      const first = locations[0];
      if (first.heading === undefined) {
        issues.push(
          issue("NOTE_ANCHOR_NOT_ON_HEADING", issueMsg(
            "noteAnchorNotHeading",
            `锚点 "${anchor}" 所在行不是标题行：${first.raw.trim()}`,
            { anchor, raw: first.raw.trim() },
          ), {
            line: first.line,
            path: `${pointer}/noteAnchor`,
          }),
        );
      }
    }
    if (anchor !== expected) {
      issues.push(
        issue("NOTE_ANCHOR_NOT_MATCHING_ID", issueMsg(
            "noteAnchorNotMatchingId",
            `noteAnchor "${anchor}" 应为 "${expected}"（“^” + 节点 id）`,
            { anchor, expected },
          ), {
          path: `${pointer}/noteAnchor`,
        }),
      );
    }
  });
}

/** 正文里带 ^nd- 前缀但没有任何节点引用的锚点（多为删除节点后的残留）
 *
 * @deprecated Phase 27：同 `checkNoteAnchors` —— 不再被 `checkConsistency` 调用。
 */
export function checkOrphanAnchors(
  document: WfJsonDocument,
  anchors: Map<string, BlockAnchorRef[]>,
  issues: WfIssue[],
): void {
  const referenced = new Set<string>();
  forEachNode(document, (node) => {
    if (node.noteAnchor) referenced.add(node.noteAnchor);
  });
  const nodeAnchorPrefix = `${ANCHOR_MARK}${ID_PREFIX.node}`;
  for (const [anchor, locations] of anchors) {
    if (!anchor.startsWith(nodeAnchorPrefix) || referenced.has(anchor)) continue;
    issues.push(
      issue("ORPHAN_BLOCK_ANCHOR", issueMsg("orphanAnchor", `锚点 "${anchor}" 未被任何节点的 noteAnchor 引用`, { anchor }), {
        line: locations[0].line,
      }),
    );
  }
}

/* ---- 3. status / progress / statusHistory / 时间 ---- */

function checkStatusAndTime(document: WfJsonDocument, issues: WfIssue[]): void {
  forEachNode(document, (node, pointer) => {
    const status = node.status;
    const progress = node.progress;
    const progressMax = node.progress_max;

    // v1.6：progress / progress_max 与 status 完全解耦，两条旧规则（STATUS_PROGRESS_MISMATCH /
    // PROGRESS_STATUS_CONFLICT）已废除；范围（0-999 整数）由 Schema 校验，
    // 这里只提示 progress > progress_max（提示级，不拦写回）。
    if (
      typeof progress === "number" &&
      typeof progressMax === "number" &&
      progressMax >= PROGRESS_MIN &&
      progress > progressMax
    ) {
      issues.push(
        issue("PROGRESS_OVER_MAX", issueMsg(
            "progressOverMax",
            `progress=${progress} 大于 progress_max=${progressMax}`,
            { progress, max: progressMax },
          ), {
          path: `${pointer}/progress`,
          hint: `progress / progress_max 相互独立（${PROGRESS_MIN}-${PROGRESS_MAX} 的整数）；此处仅提示，不影响写回。`,
        }),
      );
    }

    // statusHistory 的末条应与当前 status 对齐
    const history = node.statusHistory ?? [];
    if (history.length > 0) {
      const last = history[history.length - 1];
      if (last.to !== status) {
        issues.push(
          issue(
            "STATUS_HISTORY_MISMATCH",
            issueMsg(
              "statusHistoryMismatch",
              `statusHistory 最后一条是 "${last.to}"，与当前 status="${status}" 不一致`,
              { last: last.to, status },
            ),
            { path: `${pointer}/statusHistory` },
          ),
        );
      }
    }
    if (status === "done" && node.completedAt === undefined) {
      issues.push(
        issue("COMPLETED_AT_MISSING", issueMsg(
            "completedAtMissing",
            `节点 ${node.id}（${node.title}）已完成但缺少 completedAt`,
            { id: node.id, title: node.title },
          ), {
          path: `${pointer}/completedAt`,
        }),
      );
    }

    // 时间字段：真实性与先后顺序
    const fields: { key: keyof WfNode; value: string }[] = [];
    for (const key of ["startAt", "updatedAt", "completedAt", "dueAt"] as (keyof WfNode)[]) {
      const value = node[key];
      if (typeof value !== "string" || value.length === 0) continue;
      if (!isIsoDateOrDateTime(value)) {
        issues.push(
          issue("TIMESTAMP_INVALID", issueMsg(
              "timestampInvalid",
              `${String(key)}="${value}" 不是真实存在的日期时间`,
              { field: String(key), value },
            ), {
            path: `${pointer}/${String(key)}`,
          }),
        );
        continue;
      }
      fields.push({ key, value });
    }
    const timeOf = (key: keyof WfNode): number | undefined => {
      const found = fields.find((field) => field.key === key);
      if (!found) return undefined;
      const parsed = Date.parse(toDateOnly(found.value) === found.value ? `${found.value}T00:00:00` : found.value);
      return Number.isNaN(parsed) ? undefined : parsed;
    };
    const start = timeOf("startAt");
    const updated = timeOf("updatedAt");
    const completed = timeOf("completedAt");
    const due = timeOf("dueAt");
    const order: string[] = [];
    if (start !== undefined && updated !== undefined && updated < start) order.push(t("issue.order.updated"));
    if (start !== undefined && completed !== undefined && completed < start) order.push(t("issue.order.completed"));
    if (start !== undefined && due !== undefined && due < start) order.push(t("issue.order.due"));
    if (order.length > 0) {
      issues.push(issue("TIMESTAMP_ORDER", order.join(t("issues.join")), { path: pointer }));
    }
  });
}

/* ---- 3b. 计时条目（v1.3，node.timeEntries） ---- */

/**
 * 计时条目检查（Phase 3 契约 §9）：
 *  1. `hours` 为有限数且 ≥ 0 → 否则 `TIME_HOURS_RANGE`（error）；
 *  2. `endAt` 不早于 `startAt` → 否则 `TIME_ENTRY_ORDER`（error）；
 *  3. `date === toDateOnly(startAt)` → 否则 `TIME_DATE_MISMATCH`（warning）。
 *
 * `timeEntries` 与节点 `status` 正交、**不影响** `wf-status` 聚合；
 * 进行中的条目（无 `endAt` / `hours`）在这里是合法状态，不报问题。
 */
function checkTimeEntries(document: WfJsonDocument, issues: WfIssue[]): void {
  forEachNode(document, (node, pointer) => {
    const entries = node.timeEntries ?? [];
    entries.forEach((entry, index) => {
      const base = `${pointer}/timeEntries/${index}`;
      const startAt = typeof entry.startAt === "string" ? entry.startAt : "";

      if (entry.hours !== undefined && (typeof entry.hours !== "number" || !Number.isFinite(entry.hours) || entry.hours < 0)) {
        issues.push(
          issue("TIME_HOURS_RANGE", issueMsg(
              "hoursRange",
              `hours=${String(entry.hours)} 不是有限数或小于 0`,
              { value: String(entry.hours) },
            ), { path: `${base}/hours` }),
        );
      }

      if (typeof entry.endAt === "string") {
        const start = parseIso(startAt);
        const end = parseIso(entry.endAt);
        if (start !== undefined && end !== undefined && end < start) {
          issues.push(
            issue("TIME_ENTRY_ORDER", issueMsg(
              "entryOrder",
              `endAt="${entry.endAt}" 早于 startAt="${startAt}"`,
              { end: entry.endAt, start: startAt },
            ), { path: `${base}/endAt` }),
          );
        }
      }

      if (entry.date !== undefined && startAt.length > 0 && entry.date !== toDateOnly(startAt)) {
        issues.push(
          issue("TIME_DATE_MISMATCH", issueMsg(
              "dateMismatch",
              `date="${entry.date}" 应为 "${toDateOnly(startAt)}"（约定 = startAt 的日期部分）`,
              { date: entry.date, expected: toDateOnly(startAt) },
            ), {
            path: `${base}/date`,
          }),
        );
      }
    });
  });
}

/* ---- 4. links（Phase 9 已弃用：读到即忽略） ---- */

/**
 * Phase 9：`links[]` 的超链接源已迁到正文纪要段（`noteSection.ts`），
 * 这里不再做任何 target / type / id 校验——旧文件照读不报错，写回时由
 * `migrateLinksToNoteSections` 迁走并删除该键。
 */

/* ---- 5. relations（v1.6 已删除） ---- */

/**
 * v1.6：`relations` 已从 Schema 删除。
 * 老文件里的该键被**无视**（不报错，也不再做自依赖 / 目标解析 / 循环校验）；
 * `findDependencyCycles` 仅作为纯工具保留（供外部分析用），不再由一致性检查调用。
 */

/** 把环旋转到「字典序最小元素打头」，用于去重 */
function cycleSignature(cycle: readonly string[]): string {
  let best = 0;
  for (let i = 1; i < cycle.length; i += 1) {
    if (cycle[i] < cycle[best]) best = i;
  }
  return [...cycle.slice(best), ...cycle.slice(0, best)].join("→");
}

/** 在有向图中找出所有（去重后的）环；edges: 节点 → dependsOn 目标 */
export function findDependencyCycles(edges: Map<string, readonly string[]>): string[][] {
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];

  const visit = (id: string): void => {
    state.set(id, 1);
    stack.push(id);
    for (const next of edges.get(id) ?? []) {
      const nextState = state.get(next);
      if (nextState === 1) {
        const cycle = stack.slice(stack.indexOf(next));
        const signature = cycleSignature(cycle);
        if (!seen.has(signature)) {
          seen.add(signature);
          cycles.push(cycle);
        }
      } else if (nextState === undefined) {
        visit(next);
      }
    }
    stack.pop();
    state.set(id, 2);
  };

  for (const id of edges.keys()) {
    if (!state.has(id)) visit(id);
  }
  return cycles;
}

/* ---- 6. frontmatter 摘要字段（决策 5） ---- */

/** 摘要素字段的行号（用于定位报错） */
function fieldLine(frontmatter: FrontmatterInfo, key: string, fallback: number): number {
  return frontmatter.fields.find((field) => field.key === key)?.line ?? fallback;
}

/**
 * 单步聚合（v1.0 规则，也是 v1.1 两步聚合的**第一步**）：一组节点的贡献状态。
 * 全部 done → done；存在 doing → doing；存在 blocked → blocked；全部 cancelled/done → cancelled；其余 → todo。
 */
export function aggregateNodeStatus(nodes: readonly WfNode[]): NodeStatus {
  if (nodes.length === 0) return "todo";
  if (nodes.every((node) => node.status === "done")) return "done";
  if (nodes.some((node) => node.status === "doing")) return "doing";
  if (nodes.some((node) => node.status === "blocked")) return "blocked";
  if (nodes.every((node) => node.status === "cancelled" || node.status === "done")) return "cancelled";
  return "todo";
}

/**
 * 第一步（v1.1）：单个 workflow 的「贡献状态」。
 *  - `state` 缺省（进行中）→ 该 workflow 全部节点的单步聚合；
 *  - `state = archived`     → `done`；
 *  - `state = cancelled`    → `cancelled`。
 *
 * Phase 27 M2：未分类伪流（`UNCLASSIFIED_WORKFLOW_ID`）的隐藏 root 只是容器 ——
 * 只聚合 `root.children`；一个未分类节点都没有时贡献 `done`（合并优先级最低 = 中性，
 * 不会因为「空容器」把整份文件的 `wf-status` 拉成 todo）。
 */
export function workflowContribution(workflow: WfWorkflow): NodeStatus {
  if (workflow.state === "archived") return "done";
  if (workflow.state === "cancelled") return "cancelled";
  if (workflow.id === UNCLASSIFIED_WORKFLOW_ID) {
    const children = Array.isArray(workflow.root.children) ? workflow.root.children : [];
    if (children.length === 0) return "done";
    return aggregateNodeStatus(flattenSubtree(children, workflow, workflow.root, [workflow.root]));
  }
  return aggregateNodeStatus(walkWorkflow(workflow).map((visit) => visit.node));
}

/** 第二步的合并优先级（v1.1）：`doing > blocked > todo > cancelled > done` */
export const STATUS_PRIORITY: readonly NodeStatus[] = ["doing", "blocked", "todo", "cancelled", "done"];

/**
 * 文件级 `wf-status`（v1.1 两步聚合）：
 *  1. 逐 workflow 算「贡献状态」（`workflowContribution`）；
 *  2. 按 `doing > blocked > todo > cancelled > done` 合并（有 doing→doing；否则有 blocked→blocked；…；否则 done）。
 *
 * 兼容性：全部 workflow 都缺省 `state` 时，本规则退化为 v1.0 的单步结果，
 * 因此 1.0 老数据的 `wf-status` 无需改写（`aggregateNodeStatus(flattenNodes(document))` 与两步结果一致）。
 */
export function aggregateStatus(document: WfJsonDocument): NodeStatus {
  const contributions = document.workflows.map((workflow) => workflowContribution(workflow));
  if (contributions.length === 0) return "todo";
  for (const status of STATUS_PRIORITY) {
    if (contributions.includes(status)) return status;
  }
  return "done";
}

function checkFrontmatterSummary(input: ConsistencyInput, issues: WfIssue[]): void {
  const { frontmatter, document } = input;
  const fallbackLine = frontmatter.present ? frontmatter.endLine : 1;

  // v1.6：`wf-theme` 是可选的前端偏好，不参与强校验；只要求四个聚合字段存在
  const missing = FRONTMATTER_FIELD_NAMES.filter((name) => !frontmatter.has(name));
  if (missing.length > 0) {
    issues.push(
      issue("FRONTMATTER_FIELD_MISSING", issueMsg(
          "frontmatterFieldMissing",
          `缺少摘要字段：${missing.join(t("issues.listSep"))}`,
          { fields: missing.join(t("issues.listSep")) },
        ), { line: fallbackLine }),
    );
  }

  const statusValue = frontmatter.getString(FRONTMATTER_FIELDS.status);
  if (statusValue !== undefined) {
    const aggregate = aggregateStatus(document);
    if (statusValue !== aggregate) {
      const shown = isNodeStatus(statusValue)
        ? `${statusValue}${t("issue.statusSuffix", { label: statusLabel(statusValue) })}`
        : `${statusValue}${t("issue.statusIllegal")}`;
      issues.push(
        issue("FRONTMATTER_STATUS_MISMATCH", issueMsg(
            "frontmatterStatusMismatch",
            `wf-status=${shown}，按 JSON 聚合应为 ${aggregate}（${statusLabel(aggregate)}）`,
            { shown, aggregate, label: statusLabel(aggregate) },
          ), {
          line: fieldLine(frontmatter, FRONTMATTER_FIELDS.status, fallbackLine),
        }),
      );
    }
  }

  const titles = frontmatter.getArray(FRONTMATTER_FIELDS.titles);
  if (titles !== undefined) {
    const expected = document.workflows.map((workflow) => workflow.title);
    const same = titles.length === expected.length && titles.every((title, index) => title === expected[index]);
    if (!same) {
      issues.push(
        issue(
          "FRONTMATTER_TITLES_MISMATCH",
          issueMsg(
            "frontmatterTitlesMismatch",
            `wf-titles=[${titles.join(t("issues.listSep"))}] 与 workflows[].title=[${expected.join(t("issues.listSep"))}] 不一致`,
            {
              actual: titles.join(t("issues.listSep")),
              expected: expected.join(t("issues.listSep")),
            },
          ),
          { line: fieldLine(frontmatter, FRONTMATTER_FIELDS.titles, fallbackLine) },
        ),
      );
    }
  }

  const updated = frontmatter.getString(FRONTMATTER_FIELDS.updated);
  if (updated !== undefined && document.updatedAt !== undefined && updated !== toDateOnly(document.updatedAt)) {
    issues.push(
      issue(
        "FRONTMATTER_UPDATED_MISMATCH",
        issueMsg(
          "frontmatterUpdatedMismatch",
          `wf-updated=${updated} 与 wfjson 的 updatedAt（日期部分 ${toDateOnly(document.updatedAt)}）不一致`,
          { value: updated, expected: toDateOnly(document.updatedAt) },
        ),
        { line: fieldLine(frontmatter, FRONTMATTER_FIELDS.updated, fallbackLine) },
      ),
    );
  }

  // M1.6：`wf-key` 与 JSON 的 `noteKey` 互为凭据（任一方缺省都不算错：老文件还没写过这一版）
  const noteKey = frontmatter.getString(FRONTMATTER_FIELDS.key);
  if (noteKey !== undefined && document.noteKey !== undefined && noteKey !== document.noteKey) {
    issues.push(
      issue(
        "FRONTMATTER_KEY_MISMATCH",
        issueMsg(
          "frontmatterKeyMismatch",
          `wf-key=${noteKey} 与 wfjson 的 noteKey=${document.noteKey} 不一致（侧车是按笔记路径找的，抄别人的侧车会出现这种情况）`,
          { value: noteKey, expected: document.noteKey },
        ),
        { line: fieldLine(frontmatter, FRONTMATTER_FIELDS.key, fallbackLine) },
      ),
    );
  }
}



