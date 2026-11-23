/**
 * 极简 JSON Schema 校验器（只实现 wfjsonSchema.ts 用到的关键字）。
 *
 * 设计取舍：
 *  - 不引入 ajv 等依赖（插件体积与移动端兼容优先），关键字集合固定、可读、可测；
 *  - 每条错误都带 JSON Pointer 路径 + 中文说明 + 修复提示（x-hint），便于人类与 AI 直接修；
 *  - 类型不符时立即停止该分支的后续校验，避免刷屏式的级联错误。
 */

import { getLang, issueMsg, t } from "./i18n.ts";
import { issue, type WfIssue } from "./issues.ts";
import { isPlainObject } from "./types.ts";

export type JsonSchema = boolean | JsonSchemaObject;

export interface JsonSchemaObject {
  readonly [keyword: string]: unknown;
}

/** 最大递归深度与最大问题条数（防御病态输入） */
const MAX_DEPTH = 128;
const MAX_ISSUES = 500;

const TYPE_LABELS: Readonly<Record<string, string>> = {
  object: "对象",
  array: "数组",
  string: "字符串",
  integer: "整数",
  number: "数字",
  boolean: "布尔值",
  null: "null",
};

const typeLabel = (type: string): string => TYPE_LABELS[type] ?? type;

/** RFC6901 转义 */
export function escapePointer(token: string): string {
  return token.replace(/~/g, "~0").replace(/\//g, "~1");
}

function unescapePointer(token: string): string {
  return token.replace(/~1/g, "/").replace(/~0/g, "~");
}

/** 取值的可读摘要（用于报错） */
export function describeValue(value: unknown, maxLength = 60): string {
  let text: string;
  if (typeof value === "string") text = JSON.stringify(value);
  else if (value === undefined) text = "undefined";
  else if (value === null) text = "null";
  else if (typeof value === "number" || typeof value === "boolean") text = String(value);
  else if (Array.isArray(value)) text = `数组(${value.length} 项)`;
  else if (isPlainObject(value)) text = `对象(${Object.keys(value).length} 个字段)`;
  // 兜底：symbol / bigint / 函数等非 JSON 值 —— 直接 `String(对象)` 只会得到 "[object Object]"
  else if (typeof value === "bigint" || typeof value === "symbol" || typeof value === "function") text = String(value);
  else text = Object.prototype.toString.call(value);
  return text.length > maxLength ? `${text.slice(0, maxLength)}…` : text;
}

/** 实际的 JSON 类型名 */
function actualTypeName(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function matchesType(value: unknown, type: string): boolean {
  switch (type) {
    case "integer":
      return typeof value === "number" && Number.isInteger(value);
    case "number":
      return typeof value === "number";
    case "object":
      return isPlainObject(value);
    case "array":
      return Array.isArray(value);
    case "string":
      return typeof value === "string";
    case "boolean":
      return typeof value === "boolean";
    case "null":
      return value === null;
    default:
      return true;
  }
}

function normalizeTypes(type: unknown): string[] | undefined {
  if (typeof type === "string") return [type];
  if (Array.isArray(type) && type.every((item) => typeof item === "string")) return type;
  return undefined;
}

/** 结构化相等（只处理 JSON 可表示的值） */
export function jsonEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "number") return Number.isNaN(a) && Number.isNaN(b);
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((item, index) => jsonEqual(item, b[index]));
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const keysA = Object.keys(a);
    const keysB = Object.keys(b);
    return keysA.length === keysB.length && keysA.every((key) => jsonEqual(a[key], b[key]));
  }
  return false;
}

/** 解析本地 $ref（只支持 "#" 与 "#/a/b" 形式的 JSON Pointer） */
export function resolveRef(ref: string, root: JsonSchemaObject): JsonSchema | undefined {
  if (ref === "#") return root;
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const rawToken of ref.slice(2).split("/")) {
    const token = unescapePointer(rawToken);
    if (Array.isArray(current)) {
      const index = Number(token);
      if (!Number.isInteger(index) || index < 0 || index >= current.length) return undefined;
      current = current[index];
      continue;
    }
    if (!isPlainObject(current)) return undefined;
    if (!(token in current)) return undefined;
    current = current[token];
  }
  return current as JsonSchema;
}


export interface ValidateOptions {
  /** 根 schema（$ref 的解析基准），缺省为传入的 schema 本身 */
  rootSchema?: JsonSchemaObject;
}

/** 按 schema 校验值，返回全部问题（按遍历顺序） */
export function validateAgainstSchema(
  value: unknown,
  schema: JsonSchema,
  options: ValidateOptions = {},
): WfIssue[] {
  const root = options.rootSchema ?? (schema !== true && schema !== false ? schema : {});
  const issues: WfIssue[] = [];
  validateNode(value, schema, "", root, issues, 0);
  return issues;
}

function validateNode(
  value: unknown,
  schema: JsonSchema,
  path: string,
  root: JsonSchemaObject,
  issues: WfIssue[],
  depth: number,
): void {
  if (issues.length >= MAX_ISSUES) return;
  if (depth > MAX_DEPTH) {
    issues.push(issue("SCHEMA_TYPE", issueMsg("schemaDepth", `校验深度超过上限（${MAX_DEPTH}），请检查是否存在异常嵌套`, { max: MAX_DEPTH }), { path }));
    return;
  }
  if (schema === true) return;
  if (schema === false) {
    issues.push(issue("SCHEMA_CONST", issueMsg("schemaConstNoValue", "该位置不允许出现任何值"), { path }));
    return;
  }

  const node = schema;
  // 双语提示：Schema 里 `x-hint` 是中文原文，`x-hint-en` 是英文；英文模式优先取后者
  const hint =
    getLang() === "en" && typeof node["x-hint-en"] === "string"
      ? node["x-hint-en"]
      : typeof node["x-hint"] === "string"
        ? node["x-hint"]
        : undefined;

  const ref = node["$ref"];
  if (typeof ref === "string") {
    const target = resolveRef(ref, root);
    if (target === undefined) {
      issues.push(issue("SCHEMA_TYPE", issueMsg("schemaRefError", `Schema 内部错误：无法解析 $ref "${ref}"`, { ref }), { path }));
      return;
    }
    validateNode(value, target, path, root, issues, depth + 1);
    return;
  }

  if (Array.isArray(node.anyOf)) {
    const branches = node.anyOf as JsonSchema[];
    const probeFirst = (branch: JsonSchema): WfIssue | undefined => {
      const probe: WfIssue[] = [];
      validateNode(value, branch, path, root, probe, depth + 1);
      return probe[0];
    };
    let satisfied = false;
    for (const branch of branches) {
      if (probeFirst(branch) === undefined) {
        satisfied = true;
        break;
      }
    }
    if (!satisfied) {
      const details = branches.map((branch, index) => {
        const first = probeFirst(branch);
        return t("issue.anyOfForm", {
          index: index + 1,
          message: first ? first.message : t("issue.anyOfUnsatisfied"),
        });
      });
      issues.push(
        issue("SCHEMA_ANY_OF", issueMsg("schemaAnyOf", `不满足以下任一允许形式（实际：${describeValue(value)}）`, {
            actual: describeValue(value),
          }), {
          path,
          hint,
          details,
        }),
      );
    }
    return;
  }

  const types = normalizeTypes(node.type);
  if (types && !types.some((type) => matchesType(value, type))) {
    issues.push(
      issue(
        "SCHEMA_TYPE",
        issueMsg(
          "schemaType",
          `类型应为 ${types.map(typeLabel).join(t("issues.or"))}，实际为 ${typeLabel(actualTypeName(value))}（${describeValue(value)}）`,
          {
            expected: types.map(typeLabel).join(t("issues.or")),
            actual: typeLabel(actualTypeName(value)),
            value: describeValue(value),
          },
        ),
        { path, hint },
      ),
    );
    return;
  }

  if (Array.isArray(node.enum)) {
    const allowed = node.enum as unknown[];
    if (!allowed.some((item) => jsonEqual(item, value))) {
      issues.push(
        issue(
          "SCHEMA_ENUM",
          issueMsg(
            "schemaEnum",
            `取值必须是以下之一：${allowed.map((item) => describeValue(item, 20)).join(" | ")}（实际：${describeValue(value)}）`,
            {
              allowed: allowed.map((item) => describeValue(item, 20)).join(" | "),
              actual: describeValue(value),
            },
          ),
          { path, hint },
        ),
      );
    }
  }

  if ("const" in node && !jsonEqual(node.const, value)) {
    issues.push(
      issue("SCHEMA_CONST", issueMsg(
            "schemaConst",
            `取值必须为 ${describeValue(node.const)}（实际：${describeValue(value)}）`,
            { expected: describeValue(node.const), actual: describeValue(value) },
          ), {
        path,
        hint,
      }),
    );
  }
  if (typeof value === "string") {
    if (typeof node.minLength === "number" && value.length < node.minLength) {
      issues.push(
        issue("SCHEMA_LENGTH", issueMsg("schemaMinLength", `长度至少 ${node.minLength} 个字符（实际 ${value.length}）`, {
            min: node.minLength,
            actual: value.length,
          }), { path, hint }),
      );
    }
    if (typeof node.maxLength === "number" && value.length > node.maxLength) {
      issues.push(
        issue("SCHEMA_LENGTH", issueMsg("schemaMaxLength", `长度最多 ${node.maxLength} 个字符（实际 ${value.length}）`, {
            max: node.maxLength,
            actual: value.length,
          }), { path, hint }),
      );
    }
    if (typeof node.pattern === "string" && !new RegExp(node.pattern).test(value)) {
      issues.push(
        issue("SCHEMA_PATTERN", issueMsg(
            "schemaPattern",
            `格式不符合要求（正则 ${node.pattern}），实际：${describeValue(value)}`,
            { pattern: node.pattern, actual: describeValue(value) },
          ), {
          path,
          hint,
        }),
      );
    }
  }

  if (typeof value === "number") {
    if (typeof node.minimum === "number" && value < node.minimum) {
      issues.push(issue(
          "SCHEMA_RANGE",
          issueMsg("schemaMin", `不能小于 ${node.minimum}（实际 ${value}）`, { min: node.minimum, actual: value }),
          { path, hint },
        ));
    }
    if (typeof node.maximum === "number" && value > node.maximum) {
      issues.push(issue(
          "SCHEMA_RANGE",
          issueMsg("schemaMax", `不能大于 ${node.maximum}（实际 ${value}）`, { max: node.maximum, actual: value }),
          { path, hint },
        ));
    }
  }

  if (Array.isArray(value)) {
    if (typeof node.minItems === "number" && value.length < node.minItems) {
      issues.push(
        issue("SCHEMA_ITEMS", issueMsg("schemaMinItems", `至少需要 ${node.minItems} 个元素（实际 ${value.length}）`, {
            min: node.minItems,
            actual: value.length,
          }), { path, hint }),
      );
    }
    if (typeof node.maxItems === "number" && value.length > node.maxItems) {
      issues.push(
        issue("SCHEMA_ITEMS", issueMsg("schemaMaxItems", `最多允许 ${node.maxItems} 个元素（实际 ${value.length}）`, {
            max: node.maxItems,
            actual: value.length,
          }), { path, hint }),
      );
    }
    if (node.uniqueItems === true) {
      const seen: unknown[] = [];
      for (const item of value) {
        if (seen.some((other) => jsonEqual(other, item))) {
          issues.push(issue(
          "SCHEMA_ITEMS",
          issueMsg("schemaUnique", `元素不能重复：${describeValue(item)}`, { item: describeValue(item) }),
          { path, hint },
        ));
          break;
        }
        seen.push(item);
      }
    }
    if (node.items !== undefined) {
      const itemsSchema = node.items as JsonSchema;
      value.forEach((item, index) => {
        validateNode(item, itemsSchema, `${path}/${index}`, root, issues, depth + 1);
      });
    }
  }

  if (isPlainObject(value)) {
    const properties = isPlainObject(node.properties)
      ? (node.properties as Record<string, JsonSchema>)
      : undefined;
    if (Array.isArray(node.required)) {
      for (const name of node.required as unknown[]) {
        if (typeof name !== "string" || name in value) continue;
        issues.push(
          issue("SCHEMA_REQUIRED", issueMsg("schemaRequired", `缺少必填字段 "${name}"`, { field: name }), { path: `${path}/${escapePointer(name)}` }),
        );
      }
    }
    if (properties) {
      for (const [key, subSchema] of Object.entries(properties)) {
        if (!(key in value)) continue;
        validateNode(value[key], subSchema, `${path}/${escapePointer(key)}`, root, issues, depth + 1);
      }
    }
    const additional = node.additionalProperties;
    if (additional === false) {
      for (const key of Object.keys(value)) {
        if (properties && key in properties) continue;
        issues.push(
          issue("SCHEMA_UNKNOWN_FIELD", issueMsg("schemaUnknownField", `出现未定义的字段 "${key}"`, { field: key }), {
            path: `${path}/${escapePointer(key)}`,
            hint,
          }),
        );
      }
    } else if (additional !== undefined && additional !== true) {
      for (const key of Object.keys(value)) {
        if (properties && key in properties) continue;
        validateNode(value[key], additional as JsonSchema, `${path}/${escapePointer(key)}`, root, issues, depth + 1);
      }
    }
  }
}
