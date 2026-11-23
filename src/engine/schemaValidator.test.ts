/**
 * Schema 校验器 + Schema 白名单 + 文档收窄的单测。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  describeValue,
  escapePointer,
  jsonEqual,
  resolveRef,
  validateAgainstSchema,
  type JsonSchemaObject,
} from "./schemaValidator.ts";
import { WFJSON_SCHEMA } from "./wfjsonSchema.ts";
import { issuesWithCode, type WfIssue } from "./issues.ts";
import { coerceDocument, analyzeMarkdown, validateWfJsonValue } from "./analyze.ts";
import { clone, validDocument, validDocument11, validDocument13, wfjsonBlockOnly } from "./testFixtures.ts";
import type { WfArchive, WfJsonDocument, WfTimeEntry, WfWorkflowArchive } from "./types.ts";

/** 直接改文档的某个深层字段，返回问题清单 */
function check(mutate: (doc: WfJsonDocument) => void): WfIssue[] {
  const document = clone(validDocument());
  mutate(document);
  return validateWfJsonValue(document);
}

const rootOf = (document: WfJsonDocument): Record<string, unknown> =>
  document.workflows[0].root as unknown as Record<string, unknown>;

describe("validateWfJsonValue · 正常路径", () => {
  test("合法文档没有任何问题", () => {
    assert.deepEqual(validateWfJsonValue(validDocument()), []);
  });

  test("estimate 允许字符串与整数两种形式", () => {
    assert.equal(check((doc) => (rootOf(doc).estimate = "2h")).length, 0);
    assert.equal(check((doc) => (rootOf(doc).estimate = 3)).length, 0);
    assert.equal(check((doc) => (rootOf(doc).estimate = -1)).length, 1);
    assert.equal(check((doc) => (rootOf(doc).estimate = -1))[0].code, "SCHEMA_ANY_OF");
  });

  test("只校验 Schema，不校验业务一致性（done 与 progress 的矛盾这里不报）", () => {
    const issues = check((doc) => (doc.workflows[0].root.status = "done"));
    assert.ok(!issues.some((item) => item.code === "STATUS_PROGRESS_MISMATCH"));
  });
});

describe("validateWfJsonValue · 字段级问题", () => {
  test("schemaVersion 不在白名单 → SCHEMA_VERSION_UNSUPPORTED", () => {
    const issues = check((doc) => (doc.schemaVersion = "2.0"));
    const found = issuesWithCode(issues, "SCHEMA_VERSION_UNSUPPORTED");
    assert.equal(found.length, 1);
    assert.equal(found[0].path, "/schemaVersion");
    assert.equal(found[0].severity, "error");
  });

  test("缺少必填字段 → SCHEMA_REQUIRED，路径指向缺失字段", () => {
    const issues = check((doc) => delete rootOf(doc).status);
    const found = issuesWithCode(issues, "SCHEMA_REQUIRED");
    assert.equal(found.length, 1);
    assert.equal(found[0].path, "/workflows/0/root/status");
  });

  test("未知字段 → SCHEMA_UNKNOWN_FIELD（Phase 40：warning，不拦看板）", () => {
    const issues = check((doc) => (rootOf(doc).prority = 3));
    const found = issuesWithCode(issues, "SCHEMA_UNKNOWN_FIELD");
    assert.equal(found.length, 1);
    assert.equal(found[0].severity, "warning", "未定义字段不再是 error");
    assert.equal(found[0].path, "/workflows/0/root/prority");
    assert.ok(found[0].message.includes("prority"));
  });

  test("M1.6 文件级 noteKey：可选、10 位十六进制，格式不对才报", () => {
    assert.deepEqual(check((doc) => (doc.noteKey = "3f9a1c2b7d")), []);
    assert.deepEqual(validateWfJsonValue(validDocument()), [], "缺省即合法（老数据不需要补）");
    const bad = check((doc) => (doc.noteKey = "3F9A1C2B7D"));
    const found = issuesWithCode(bad, "SCHEMA_PATTERN");
    assert.equal(found.length, 1);
    assert.equal(found[0].path, "/noteKey");
  });

  test("Phase 34 节点级 linkDir：可选字符串；缺省合法，非字符串才报", () => {
    assert.deepEqual(check((doc) => (rootOf(doc).linkDir = "资料/读书计划")), []);
    assert.deepEqual(check((doc) => (rootOf(doc).linkDir = "")), [], "空串也合法（= 没设置过）");
    assert.deepEqual(validateWfJsonValue(validDocument()), [], "缺省即合法（老数据不需要补）");

    const bad = check((doc) => Object.assign(rootOf(doc), { linkDir: 42 }));
    const found = issuesWithCode(bad, "SCHEMA_TYPE");
    assert.equal(found.length, 1);
    assert.equal(found[0].path, "/workflows/0/root/linkDir");
  });

  test("status 非法取值 → SCHEMA_ENUM", () => {
    const issues = check((doc) => (rootOf(doc).status = "finished"));
    const found = issuesWithCode(issues, "SCHEMA_ENUM");
    assert.equal(found.length, 1);
    assert.equal(found[0].path, "/workflows/0/root/status");
  });

  test("数值越界 / 类型不符 → SCHEMA_RANGE 与 SCHEMA_TYPE", () => {
    assert.equal(issuesWithCode(check((doc) => (rootOf(doc).progress = 1000)), "SCHEMA_RANGE").length, 1);
    assert.equal(issuesWithCode(check((doc) => (rootOf(doc).progress_max = -1)), "SCHEMA_RANGE").length, 1);
    assert.equal(issuesWithCode(check((doc) => (rootOf(doc).importance = 0)), "SCHEMA_RANGE").length, 1);
    assert.equal(issuesWithCode(check((doc) => (rootOf(doc).importance = 5)), "SCHEMA_RANGE").length, 1);
    assert.equal(issuesWithCode(check((doc) => (rootOf(doc).importance = 4.5)), "SCHEMA_TYPE").length, 1);
    assert.equal(issuesWithCode(check((doc) => (rootOf(doc).collapsed = "false")), "SCHEMA_TYPE").length, 1);
  });

  test("children 必须是数组 → SCHEMA_TYPE，路径落在字段上", () => {
    const issues = check((doc) => (rootOf(doc).children = null));
    const found = issuesWithCode(issues, "SCHEMA_TYPE");
    assert.equal(found.length, 1);
    assert.equal(found[0].path, "/workflows/0/root/children");
  });

  /* ---- Phase 20：note / noteVisible（$defs/node 新增的两个选填键） ---- */

  test("note 条目数组 + noteVisible：三态合法值都零问题", () => {
    assert.equal(check((doc) => (rootOf(doc).note = [{ text: "先截 3 家的定价页" }])).length, 0);
    assert.equal(
      check((doc) => (rootOf(doc).note = [{ text: "待办", done: false }, { text: "已办", done: true }])).length,
      0,
    );
    assert.equal(check((doc) => (rootOf(doc).note = [])).length, 0, "空数组本身合法（引擎写回时会顺手删键）");
    assert.equal(check((doc) => (rootOf(doc).noteVisible = true)).length, 0);
    assert.equal(check((doc) => (rootOf(doc).noteVisible = false)).length, 0);
    assert.equal(
      check((doc) => {
        rootOf(doc).note = [{ text: "两键同时出现" }];
        rootOf(doc).noteVisible = true;
      }).length,
      0,
    );
  });

  test("note 写成字符串 → SCHEMA_TYPE（Phase 20 修订起只认条目数组）", () => {
    const issues = issuesWithCode(check((doc) => (rootOf(doc).note = "旧格式的多行文本")), "SCHEMA_TYPE");
    assert.equal(issues.length, 1);
    assert.equal(issues[0].path, "/workflows/0/root/note");
  });

  test("noteItem：缺 text / text 空串 / done 非布尔 / 多余键各有专属问题码", () => {
    const missing = issuesWithCode(check((doc) => (rootOf(doc).note = [{}])), "SCHEMA_REQUIRED");
    assert.equal(missing.length, 1);
    assert.equal(missing[0].path, "/workflows/0/root/note/0/text", "路径指到缺的键");

    const blank = issuesWithCode(check((doc) => (rootOf(doc).note = [{ text: "" }])), "SCHEMA_LENGTH");
    assert.equal(blank.length, 1);
    assert.equal(blank[0].path, "/workflows/0/root/note/0/text");

    const wrongDone = issuesWithCode(check((doc) => (rootOf(doc).note = [{ text: "x", done: "yes" }])), "SCHEMA_TYPE");
    assert.equal(wrongDone.length, 1);
    assert.equal(wrongDone[0].path, "/workflows/0/root/note/0/done");

    const extra = issuesWithCode(check((doc) => (rootOf(doc).note = [{ text: "x", kind: "todo" }])), "SCHEMA_UNKNOWN_FIELD");
    assert.equal(extra.length, 1);
    assert.equal(extra[0].path, "/workflows/0/root/note/0/kind");
  });

  test("noteVisible 非布尔 → SCHEMA_TYPE；键名相邻不串味", () => {
    const wrongType = issuesWithCode(check((doc) => (rootOf(doc).noteVisible = "yes")), "SCHEMA_TYPE");
    assert.equal(wrongType.length, 1);
    assert.equal(wrongType[0].path, "/workflows/0/root/noteVisible");

    assert.equal(issuesWithCode(check((doc) => (rootOf(doc).noteVsible = true)), "SCHEMA_UNKNOWN_FIELD").length, 1);
    assert.equal(issuesWithCode(check((doc) => (rootOf(doc).summary = { note: "x" })), "SCHEMA_TYPE").length, 1);
  });

  test("深层嵌套错误带完整 JSON Pointer", () => {
    const issues = check((doc) => {
      const children = rootOf(doc).children as Record<string, unknown>[];
      children[1].status = "unknown";
    });
    const found = issuesWithCode(issues, "SCHEMA_ENUM");
    assert.equal(found[0].path, "/workflows/0/root/children/1/status");
  });

  test("tags 不允许重复 → SCHEMA_ITEMS", () => {
    assert.equal(issuesWithCode(check((doc) => (rootOf(doc).tags = ["a", "a"])), "SCHEMA_ITEMS").length, 1);
  });

  test("noteAnchor 格式不符 → SCHEMA_PATTERN", () => {
    const issues = check((doc) => (rootOf(doc).noteAnchor = "nd-uuid-001"));
    const found = issuesWithCode(issues, "SCHEMA_PATTERN");
    assert.equal(found.length, 1);
    assert.equal(found[0].path, "/workflows/0/root/noteAnchor");
  });

  test("links / relations / statusHistory 的子对象同样校验", () => {
    const issues = check((doc) => {
      const root = rootOf(doc) as unknown as { links: Record<string, unknown>[]; relations: Record<string, unknown>[] };
      root.links[0].type = "pdf";
      root.relations[0].kind = "after";
    });
    const paths = issuesWithCode(issues, "SCHEMA_ENUM").map((item) => item.path);
    assert.deepEqual(paths.sort(), ["/workflows/0/root/links/0/type", "/workflows/0/root/relations/0/kind"]);
  });

  test("空字符串违反 minLength → SCHEMA_LENGTH", () => {
    assert.equal(issuesWithCode(check((doc) => (doc.workflows[0].title = "")), "SCHEMA_LENGTH").length, 1);
  });

  test("非对象内容被拦下（type=object）", () => {
    assert.equal(issuesWithCode(validateWfJsonValue([]), "SCHEMA_TYPE").length, 1);
    assert.equal(issuesWithCode(validateWfJsonValue(null), "SCHEMA_TYPE").length, 1);
  });

  test("超深嵌套不会崩（深度上限保护）", () => {
    const document = clone(validDocument());
    const root = rootOf(document);
    let cursor = root;
    for (let i = 0; i < 200; i += 1) {
      const child = { id: `nd-deep-${i}`, title: `t${i}`, status: "todo", children: [] as unknown[] };
      (cursor.children as unknown[]).push(child);
      cursor = child;
    }
    assert.doesNotThrow(() => validateAgainstSchema(document, WFJSON_SCHEMA));
  });
});


describe("coerceDocument · 结构收窄", () => {
  test("合法文档 → 返回文档对象", () => {
    const document = coerceDocument(validDocument());
    assert.equal(document?.id, "file-uuid-001");
    assert.equal(document?.workflows.length, 2);
  });

  test("结构不完整 → undefined", () => {
    assert.equal(coerceDocument(null), undefined);
    assert.equal(coerceDocument({}), undefined);
    assert.equal(coerceDocument({ schemaVersion: "1.0", id: "file-1" }), undefined);
    const badStatus = clone(validDocument());
    (rootOf(badStatus) as { status: string }).status = "unknown";
    assert.equal(coerceDocument(badStatus), undefined);
    const badChildren = clone(validDocument());
    rootOf(badChildren).children = "oops";
    assert.equal(coerceDocument(badChildren), undefined);
  });
});

describe("Schema v1.1 · workflow.state / workflow.originId", () => {
  test("state 只接受 archived / cancelled（缺省合法，doing 非法）", () => {
    assert.equal(check((doc) => (doc.workflows[0].state = "archived")).length, 0);
    assert.equal(check((doc) => (doc.workflows[0].state = "cancelled")).length, 0);

    const bad = check((doc) => {
      (doc.workflows[0] as { state: string }).state = "doing";
    });
    const found = issuesWithCode(bad, "SCHEMA_ENUM");
    assert.equal(found.length, 1);
    assert.equal(found[0].path, "/workflows/0/state");
    assert.equal(found[0].severity, "error");
  });

  test("originId：字符串合法；空串 / 非字符串报错", () => {
    assert.equal(check((doc) => (doc.workflows[0].originId = "nd-uuid-009")).length, 0);
    assert.equal(issuesWithCode(check((doc) => (doc.workflows[0].originId = "")), "SCHEMA_LENGTH").length, 1);
    const wrongType = check((doc) => {
      (doc.workflows[0] as { originId: unknown }).originId = 9;
    });
    assert.equal(issuesWithCode(wrongType, "SCHEMA_TYPE").length, 1);
  });

  test("1.1 样例与 1.0 老样例都通过 Schema（新字段可选）", () => {
    assert.deepEqual(validateWfJsonValue(validDocument11()), []);
    assert.deepEqual(validateWfJsonValue(validDocument()), []);
  });

  test("originId 不参与 id 前缀校验（跨文件归档引用）", () => {
    assert.equal(issuesWithCode(check((doc) => (doc.workflows[0].originId = "archive-node-7")), "ID_FORMAT").length, 0);
  });
});

describe("schemaValidator · 工具函数", () => {
  test("escapePointer：RFC6901 转义", () => {
    assert.equal(escapePointer("a/b"), "a~1b");
    assert.equal(escapePointer("a~b"), "a~0b");
    assert.equal(escapePointer("普通键"), "普通键");
  });

  test("describeValue：给出可读摘要", () => {
    assert.equal(describeValue("hi"), '"hi"');
    assert.equal(describeValue(undefined), "undefined");
    assert.equal(describeValue(null), "null");
    assert.equal(describeValue([1, 2, 3]), "数组(3 项)");
    assert.equal(describeValue({ a: 1 }), "对象(1 个字段)");
    assert.ok(describeValue("x".repeat(100)).endsWith("…"));
  });

  test("jsonEqual：结构化相等", () => {
    assert.equal(jsonEqual({ a: [1, 2] }, { a: [1, 2] }), true);
    assert.equal(jsonEqual({ a: [1, 2] }, { a: [2, 1] }), false);
    assert.equal(jsonEqual([1], [1, 2]), false);
  });

  test("resolveRef：本地指针解析", () => {
    const root: JsonSchemaObject = WFJSON_SCHEMA;
    assert.equal(resolveRef("#", root), root);
    assert.equal(resolveRef("#/$defs/node", root) !== undefined, true);
    assert.equal(resolveRef("#/$defs/不存在的定义", root), undefined);
  });
});

describe("schemaValidator · v1.3 新增字段（timeEntries / archive）", () => {
  test("1.3 样例（含计时与归档）通过 Schema；1.0 / 1.1 老数据照旧通过", () => {
    assert.deepEqual(validateWfJsonValue(validDocument13()), []);
    assert.deepEqual(validateWfJsonValue(validDocument11()), []);
    assert.deepEqual(validateWfJsonValue(validDocument()), []);
  });

  test("白名单并列支持 1.0 / 1.1 / 1.3 / 1.6；从未发布的 1.2 / 1.4 / 1.5 与未知版本被拒", () => {
    for (const version of ["1.0", "1.1", "1.3", "1.9"]) {
      const document = clone(validDocument13());
      document.schemaVersion = version;
      assert.deepEqual(issuesWithCode(validateWfJsonValue(document), "SCHEMA_VERSION_UNSUPPORTED"), [], version);
    }

    for (const version of ["1.2", "9.9", "1.4", "1.5"]) {
      const document = clone(validDocument13());
      document.schemaVersion = version;
      const found = issuesWithCode(validateWfJsonValue(document), "SCHEMA_VERSION_UNSUPPORTED");
      assert.equal(found.length, 1, version);
      assert.equal(found[0].path, "/schemaVersion");
    }
  });

  test("timeEntry：缺 startAt / date、未知字段、hours 越界、时间格式非法 → 逐条报错", () => {
    const document = clone(validDocument13());
    document.workflows[0].root.timeEntries = [
      { startAt: "2026-10-02T09:00:00+08:00", date: "2026-10-02", note: "多余的键" },
      { startAt: "2026-10-02T09:00:00+08:00" },
      { startAt: "2026-10-02T09:00:00+08:00", date: "2026-10-02", hours: -1 },
      { startAt: "2026-10-02T09:00:00+08:00", date: "2026-10-02", endAt: "昨天" },
      { startAt: "2026-10-02T09:00:00+08:00", date: "2026/10/02" },
    ] as unknown as WfTimeEntry[];

    const issues = validateWfJsonValue(document);
    const codes = issues.map((item) => item.code);

    assert.ok(codes.includes("SCHEMA_UNKNOWN_FIELD"), "多写的键被拒");
    assert.ok(codes.includes("SCHEMA_REQUIRED"), "缺 date 被拒");

describe("schemaValidator · Phase 22 workflow_archive（文件级台账）", () => {
  /** 一份合法台账（挂在 1.3 样例上） */
  const withLedger = (): WfJsonDocument => {
    const document = clone(validDocument13());
    document.workflow_archive = [
      {
        workflowId: document.workflows[0].id,
        title: document.workflows[0].title,
        noteAnchor: "^nd-uuid-001",
        archive: { workflowId: "wf-uuid-301" },
      },
    ];
    return document;
  };

  /** 把台账第一条当一个可随便改的对象（测试要往里塞脏数据） */
  const entryOf = (document: WfJsonDocument): Record<string, unknown> =>
    document.workflow_archive![0] as unknown as Record<string, unknown>;

  test("合法台账通过；缺省（不写这个键）也通过", () => {
    assert.deepEqual(validateWfJsonValue(withLedger()), []);

    const absent = withLedger();
    delete absent.workflow_archive;
    assert.deepEqual(validateWfJsonValue(absent), []);
  });

  test("四键必填：缺 noteAnchor / archive 内部缺必填键 → SCHEMA_REQUIRED", () => {
    const missingAnchor = withLedger();
    delete entryOf(missingAnchor).noteAnchor;
    assert.ok(issuesWithCode(validateWfJsonValue(missingAnchor), "SCHEMA_REQUIRED").length > 0);

    const missingArchiveKeys = withLedger();
    entryOf(missingArchiveKeys).archive = { archivedAt: "2026-10-12 14:30" };
    assert.ok(issuesWithCode(validateWfJsonValue(missingArchiveKeys), "SCHEMA_REQUIRED").length > 0);
  });

  test("多余键 / 锚点格式非法 / archive 不是对象 → 逐条报错", () => {
    const extra = withLedger();
    entryOf(extra).extra = 1;
    assert.ok(issuesWithCode(validateWfJsonValue(extra), "SCHEMA_UNKNOWN_FIELD").length > 0);

    const badAnchor = withLedger();
    entryOf(badAnchor).noteAnchor = "nd-uuid-001";
    assert.ok(issuesWithCode(validateWfJsonValue(badAnchor), "SCHEMA_PATTERN").length > 0);

    const badArchive = withLedger();
    entryOf(badArchive).archive = "not-an-object";
    assert.ok(issuesWithCode(validateWfJsonValue(badArchive), "SCHEMA_TYPE").length > 0);
  });
});

    assert.ok(codes.includes("SCHEMA_RANGE"), "hours=-1 越界");
    assert.ok(codes.includes("SCHEMA_PATTERN"), "endAt / date 格式非法");
    assert.ok(issues.some((item) => item.path === "/workflows/0/root/timeEntries/0/note"));
    assert.ok(issues.some((item) => item.path === "/workflows/0/root/timeEntries/1/date"));
    assert.ok(issues.some((item) => item.path === "/workflows/0/root/timeEntries/2/hours"));
  });

  test("timeEntry：进行中（只写 startAt + date）合法，不写 null 也不算缺字段", () => {
    const document = clone(validDocument13());
    document.workflows[0].root.timeEntries![0] = { startAt: "2026-10-12T09:00:00+08:00", date: "2026-10-12" };

    assert.deepEqual(validateWfJsonValue(document), []);
  });

  test("archive：只剩 workflowId 必填；多余的键被拒（Phase 39）", () => {
    const document = clone(validDocument13());
    document.workflows[1].root.archive = { 额外: 1 } as unknown as WfArchive;

    const issues = validateWfJsonValue(document);
    const codes = issues.map((item) => item.code);

    assert.ok(codes.includes("SCHEMA_REQUIRED"), "缺 workflowId");
    assert.ok(codes.includes("SCHEMA_UNKNOWN_FIELD"), "多余的键");
    assert.ok(
      issues.some((item) => item.path === "/workflows/1/root/archive/workflowId"),
      "缺 workflowId 的路径",
    );
  });

  test("workflow.archive：三键选填（Phase 45）+ 三段文字 / 标签选填；多余的键被拒", () => {
    const document = clone(validDocument13());
    document.workflows[1].archive = {
      archivedAt: "2026-10-12 14:30",
      from_workflow: "立项调查",
      from_node: "调研竞品",
      summary: "收敛",
      tag: ["归档"],
    };
    assert.deepEqual(validateWfJsonValue(document), []);

    // Phase 45：普通工作流只写四条复盘说明（不写 archivedAt / from_*）也合法
    const notesOnly = clone(validDocument13());
    notesOnly.workflows[1].archive = { summary: "只填概括", tag: ["复盘"] };
    assert.deepEqual(validateWfJsonValue(notesOnly), []);

    const empty = clone(validDocument13());
    empty.workflows[1].archive = {};
    assert.deepEqual(validateWfJsonValue(empty), []);

    const extra = clone(validDocument13());
    extra.workflows[1].archive = {
      archivedAt: "2026-10-12 14:30",
      from_workflow: "立项调查",
      from_node: "调研竞品",
      额外: 1,
    } as unknown as WfWorkflowArchive;
    assert.ok(issuesWithCode(validateWfJsonValue(extra), "SCHEMA_UNKNOWN_FIELD").length > 0);
  });

  test("workflow.archive：archivedAt 接受「日期 + 精确到分钟」（空格分隔）", () => {
    const document = clone(validDocument13());
    document.workflows[1].archive = {
      archivedAt: "2026-10-12 14:30",
      from_workflow: "立项调查",
      from_node: "调研竞品",
    };

    assert.deepEqual(validateWfJsonValue(document), []);
  });
});

/* ------------------------------------------------------------------ *
 * Phase 40：校验语义收窄 —— 「关键字段齐 → 照常产出看板数据」
 *
 * 未定义字段（多写 / 拼错 / 旧版遗留）从 error 降为 warning：
 *  - 以前：`hasErrors(schemaIssues)` → analyze 提前返回，document 不产出 → 视图只摊问题；
 *  - 现在：warning 不触发提前返回，文档照常收窄，字段名走「统计 → schema警告」。
 * 反例（缺必填 / 类型错 / 枚举错）必须仍然拦住。
 * ------------------------------------------------------------------ */
describe("Phase 40 · 未定义字段只算警告，不阻断看板", () => {
  test("关键字段齐 + 多一个未定义字段 → 仍产出 document，hasError=false", () => {
    const document = clone(validDocument13());
    rootOf(document).prority = 3;

    const result = analyzeMarkdown(wfjsonBlockOnly(document));

    assert.ok(result.document !== undefined, "关键字段齐 → 文档照常收窄（看板能渲染）");
    assert.equal(result.hasError, false, "未定义字段不该把看板换成错误框");
    assert.equal(result.counts.error, 0);
    const unknown = issuesWithCode(result.issues, "SCHEMA_UNKNOWN_FIELD");
    assert.equal(unknown.length, 1);
    assert.equal(unknown[0].severity, "warning");
    assert.equal(unknown[0].path, "/workflows/0/root/prority");
  });

  test("缺必填字段仍是 error（照样拦住）", () => {
    const document = clone(validDocument13());
    delete rootOf(document).title;

    const result = analyzeMarkdown(wfjsonBlockOnly(document));

    assert.equal(result.hasError, true);
    assert.equal(result.document, undefined, "关键字段不齐 → 不产出文档");
    assert.ok(issuesWithCode(result.issues, "SCHEMA_REQUIRED").length > 0);
  });

  test("坏值仍是 error（未定义字段降级不牵连其它检查）", () => {
    const document = clone(validDocument13());
    rootOf(document).status = 123;

    const result = analyzeMarkdown(wfjsonBlockOnly(document));

    assert.equal(result.hasError, true);
    assert.equal(result.document, undefined, "坏值不能进渲染层");
    const bad = result.issues.filter((item) => item.path === "/workflows/0/root/status");
    assert.ok(bad.some((item) => item.severity === "error"), "status 坏值必须仍是 error（枚举 / 类型）");
  });
});
