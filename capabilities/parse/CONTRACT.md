# parse · 契约

> 能力域：把一篇 md 文本变成「可消费的结构化事实 + 问题清单」。
> 实现：`workflowwatcher/src/engine/{frontmatter,markdownScan,wfjsonParse,wfjsonSchema,schemaValidator,analyze}.ts`
> 唯一事实来源：`doc/datacontact/data_ixd_v09.md`（字段规范）、`src/engine/wfjsonSchema.ts`（可执行版本）

## 做 / 不做

- 做：frontmatter 尽力解析、围栏扫描、wfjson 严格 JSON 预扫描、Schema 校验、按层降级的 analyze 编排。
- 不做：一致性语义（→ `doc-model`）、写回（→ `writeback`）、任何 Obsidian API。

## 输入 → 输出

| 符号 | 输入 | 输出 |
|---|---|---|
| `analyzeMarkdown(text, options?)` | md 文本 | `AnalyzeResult`（document? + issues + counts） |
| `analyzeDocument(doc, ...)` | 已解析文档 | `AnalyzeResult`（跳过抽取） |
| `extractWfJsonBlock` / `parseWfJsonText` / `parseWfJsonBlock` | 文本 / 代码块 | 解析结果 + 行列定位的错误 |
| `scanStrictJson` / `locateJsonError` | JSON 文本 | 注释 / 尾逗号 / 语法错误位置 |
| `parseFrontmatter` / `setFrontmatterField(List)` | md 文本 | frontmatter 字段表（含行号） |
| `findWfJsonBlocks` / `findBlockAnchors` / `indexBlockAnchors` | md 文本 | 围栏 / `^anchor` 索引 |
| `validateWfJsonValue` / `coerceDocument` | JSON 值 | 规范化文档 or 校验问题 |

## 分层降级（不静默失败，也不在坏数据上瞎跑）

1. 没有 wfjson 块 → 只报 `NO_WFJSON_BLOCK`（info）；
2. JSON 语法错误 → 只报语法问题（不跑 Schema / 一致性）；
3. Schema 有 error → 报字段级问题，跳过一致性；
4. 结构合法 → 交给 `doc-model` 的一致性检查。

### 严重级口径（Phase 40 收窄）

- **error = 拦**（`hasErrors(schemaIssues)` → 提前返回，`document` 不产出）：`SCHEMA_REQUIRED` / `SCHEMA_TYPE` /
  `SCHEMA_ENUM` / `SCHEMA_CONST` / `SCHEMA_ITEMS` / `SCHEMA_RANGE` / `SCHEMA_LENGTH` / `SCHEMA_PATTERN` /
  `SCHEMA_ANY_OF` / `SCHEMA_VERSION_UNSUPPORTED` —— 坏值进了渲染层会让 `renderCard` / `renderSubtree` 抛错。
- **warning = 不拦**：只有 `SCHEMA_UNKNOWN_FIELD`（「多出来、不在设计内」的字段）。关键字段齐时照常产出
  `document`（看板照常渲染），字段名由视图的「统计 → schema警告」tab 单独列出；写回时未知键原样保留。
- 判定只看 **severity**，不看 code 清单：新增 code 时若想「只提示不拦」，把 `issues.ts` 的 severity 写成
  `warning` 即可（登记表是唯一事实来源）。

## 副作用

无。纯函数、不读盘、不写盘。

## 依赖

- 上游：`doc-model`（类型 / issue 模型）、`i18n`（文案）。
- 下游：`writeback` / `mutate` / `io` / `views` / `host` 全部经由 `analyzeMarkdown` 取事实。

## 测试

`frontmatter.test.ts`、`wfjsonParse.test.ts`、`schemaValidator.test.ts`（`npm.cmd run test`）。

## 改动流程

1. 改字段规范 → 先改 `data_ixd_v09.md`，再改 `wfjsonSchema.ts`，再改本契约 + 测试。
2. 新增 issue 码 → 去 `issues.ts` 登记（属 `doc-model`）。
3. 跑 `npm.cmd run index` + `npm.cmd run test`。
