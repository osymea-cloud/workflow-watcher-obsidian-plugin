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
import { coerceDocument, validateWfJsonValue } from "./analyze.ts";
import { clone, validDocument, validDocument11, validDocument13 } from "./testFixtures.ts";
import type { WfArchive, WfJsonDocument, WfTimeEntry } from "./types.ts";

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

  test("未知字段 → SCHEMA_UNKNOWN_FIELD", () => {
    const issues = check((doc) => (rootOf(doc).prority = 3));
    const found = issuesWithCode(issues, "SCHEMA_UNKNOWN_FIELD");
    assert.equal(found.length, 1);
    assert.equal(found[0].path, "/workflows/0/root/prority");
    assert.ok(found[0].message.includes("prority"));
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

  test("深层嵌套错误带完整 JSON Pointer", () => {
    const issues = check((doc) => {
      const children = rootOf(doc).children as Record<string, unknown>[];
      (children[1] as Record<string, unknown>).status = "unknown";
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
      cursor = child as unknown as Record<string, unknown>;
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

  test("archive：archivedAt / workflowId / schemaVersion 必填，file 已弃用（v0.7 §⑨-2）", () => {
    const document = clone(validDocument13());
    document.workflows[1].root.archive = { summary: "只有摘要", 额外: 1 } as unknown as WfArchive;

    const issues = validateWfJsonValue(document);
    const codes = issues.map((item) => item.code);

    assert.ok(codes.includes("SCHEMA_REQUIRED"), "缺必填字段");
    assert.ok(codes.includes("SCHEMA_UNKNOWN_FIELD"), "多余的键");
    for (const key of ["archivedAt", "workflowId", "schemaVersion"]) {
      assert.ok(
        issues.some((item) => item.path === `/workflows/1/root/archive/${key}`),
        `缺 ${key} 的路径`,
      );
    }
    // file 不在 required 里：缺了不算错
    assert.equal(
      issues.some((item) => item.path === "/workflows/1/root/archive/file" && item.code === "SCHEMA_REQUIRED"),
      false,
      "archive.file 已弃用，缺它不该报 SCHEMA_REQUIRED",
    );
  });

  test("archive：旧文件里的 file 仍然合法（只读兼容）", () => {
    const document = clone(validDocument13());
    document.workflows[1].root.archive = {
      archivedAt: "2026-10-12 14:30",
      file: "archive/wf-old-nd-old.md",
      workflowId: "wf-old",
      schemaVersion: "1.9",
    } as WfArchive;

    assert.deepEqual(validateWfJsonValue(document), []);
  });

  test("archive：archivedAt 接受定稿格式「日期 + 精确到分钟」（空格分隔）", () => {
    const document = clone(validDocument13());
    document.workflows[1].root.archive!.archivedAt = "2026-10-12 14:30";

    assert.deepEqual(validateWfJsonValue(document), []);
  });
});
