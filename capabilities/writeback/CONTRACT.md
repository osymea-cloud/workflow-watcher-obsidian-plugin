# writeback · 契约

> 能力域：造合法数据 + 把内存文档写回文本 + 内存版本升格。
> 实现：`workflowwatcher/src/engine/{factory,wfjsonWrite,noteSection,upgrade}.ts`
> 唯一事实来源：`doc/datacontact/data_ixd_v09.md` §2 / §5（写回顺序）

## 做 / 不做

- 做：`createNode` / `createWorkflow` / `createDocument` / `createLink` / `createRelation` / `applyStatusChange`；
  `stringifyWfJson` / `upsertWfJsonBlock` / `buildFrontmatterSummary` / `upsertFrontmatterSummary` / `writeBackDocument` / `writeBackNote`；
  `upgradeDocument`（1.0/1.1/1.3/1.6 → 1.9，仅内存）。
- 不做：读盘 / 写盘（→ `host` 的 `vault.process`）、变更合法性（→ `mutate` 的 mutator）、任何 UI。

## 幂等契约（硬）

任何写回之后，结果必须能再次通过 `analyzeMarkdown`；同输入 + 同基准时间可复现。
写回函数失配就返回原文 / 报 issue，**不允许**产出「半对」的文本。

## 写回顺序（硬）

- 侧车 JSON 先、笔记后（`host` 侧执行）；
- 归档：先归档 `.wf.json`、后原文件；
- 每次 `vault.process` 只碰一个文件（Obsidian 事务只覆盖单文件）。

## 版本升格

`upgradeDocument` 只允许「新增 / 拆分字段」，不允许合并字段，必须幂等；
**绝不自动落盘**——落盘推迟到用户下一次主动修改（`applyMutation` 以最新版写回）。

## 失败语义

`upsertWfJsonBlock` 返回 `{ action, text, ... }`（inserted / replaced / unchanged 等），不抛错；
`writeBackDocument` 返回 `WriteBackResult`，调用方按 `ok` 决定是否落盘。

## 依赖

上游 `doc-model` + `parse` + `i18n`；下游 `mutate` / `archive` / `io` / `host`。

## 测试

`factory.test.ts`、`wfjsonWrite.test.ts`、`noteSection.test.ts`、`upgrade.test.ts`。

## 改动流程

新增字段 → 先改 schema 与 `factory` 默认值 → 再改写回 → 再补「写回后仍能 analyze」的测试。
