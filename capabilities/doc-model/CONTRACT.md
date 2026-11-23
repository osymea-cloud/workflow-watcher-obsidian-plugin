# doc-model · 契约

> 能力域：所有域共用的数据模型与语义判定（Schema 1.9）。
> 实现：`workflowwatcher/src/engine/{types,time,ids,issues,tree,consistency}.ts`
> 唯一事实来源：`doc/datacontact/data_ixd_v09.md`

## 做 / 不做

- 做：类型与常量、时间格式、id / anchor 规则、issue 码登记、树遍历、跨字段一致性。
- 不做：文本解析（→ `parse`）、写回（→ `writeback`）、任何表现层。

## 输入 → 输出

| 符号 | 输入 | 输出 |
|---|---|---|
| `types.ts` | — | `WfJsonDocument` / `WfNode` / `WfWorkflow`、状态与标签常量、类型守卫、`progressPercent` |
| `time.ts` | ISO 字符串 / 毫秒 | `parseIso` / `formatLocalIso` / `hoursBetween` / `formatClock` / `wholeDaysFromTo` |
| `ids.ts` | — | `newNodeId` / `anchorForNode` / `ID_PATTERN` / `isNoteAnchor` / `idKindOf` |
| `issues.ts` | 问题构造参数 | `WfIssue` + `ISSUE_CODES` + `formatIssues` / `countIssues` |
| `tree.ts` | document | `walkWorkflow` / `walkSubtree` / `findNode` / `findParentNode` / `indexIds` |
| `consistency.ts` | document + 正文 | `checkConsistency` / `aggregateStatus` / `workflowContribution` |

## 不变量（硬）

1. 引擎零 Obsidian 依赖；只用可擦除语法（无 `enum` / `namespace` / 参数属性）；相对 import 带 `.ts`。
2. issue 码只增不改：新码必须在 `ISSUE_CODES` 登记 severity + 中文标题 + 修复提示。
3. `types.ts` 的 `tags` / `estimate` / `relations` / `links` / `file` 是「旧文件仍要能读」的兼容字段：读到即忽略，新数据不再产生。
4. `PROGRESS_*` / `IMPORTANCE_*` 的范围与默认值以 `types.ts` 为准，别在别处写死数字。

## 失败语义

只报告、不修改数据；`checkConsistency` 返回 `WfIssue[]`，不抛错。坏时间字段跳过该条，不炸整篇。

## 依赖

- 上游：`i18n`（标题 / 提示文案）。
- 下游：其余所有引擎域。

## 测试

`time.test.ts`、`tree.test.ts`、`consistency.test.ts`（`npm.cmd run test`）。

## 改动流程

改字段 / 规则前先改 `data_ixd_v09.md`，再改这里与 `parse`，最后同步本契约的「不变量」。
