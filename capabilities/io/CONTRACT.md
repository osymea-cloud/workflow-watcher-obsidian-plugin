# io · 契约

> 能力域：导入体检 / 合并计划（只认侧车 JSON，与 md 完全解耦）。
> 实现：`workflowwatcher/src/engine/importExport.ts`
> 契约来源：`doc/datacontact/phase26_bound.md` §4、`phase27_bound.md` §5.2

## 做 / 不做

- 做：`inspectImport`（体检：能否读、schema、撞 id）、`planWorkflowImport`（合并计划：合并后的 json 对象）。
- 不做：读文件 / 写文件（含库外绝对路径走 Node `fs`，→ `host`）、弹窗 / 确认（→ `ui`）、
  任何 md 输入输出（笔记正文既不是导入口也不是导出口）。

## 导入不变量（硬）

- I4：节点 id / workflow id 全局唯一 —— 撞了就**整条 workflow 跳过**（不覆盖）；
- I5：合并后仍然无 error（只剩 JSON 结构 / schema 一条来源）；
- 正文：导入**完全不碰 md**（不读源 md、不返回目标 md），`noteAnchor` 随导入剥离。

## 失败语义

`inspectImport` 返回结构化报告（可读 / 不可读 + 原因 + `ok`），不抛错；`planWorkflowImport` 返回 `ImportPlanResult`（`changed` 表示要不要写盘）。

## 依赖

上游 `doc-model` + `parse` + `i18n`；下游 `host`（`vault.process` / 库外 `fs`）/ `ui`（`ImportReportModal` / `ExportDataModal`）。

## 测试

`importExport.test.ts`。

## 改动流程

改合并口径 → 先改 `phase26/27_bound.md`，再改本模块 + 本契约的「不变量」，最后补撞 id / 幂等用例。
