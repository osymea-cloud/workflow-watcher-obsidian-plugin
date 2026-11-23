# stats · 契约

> 能力域：只读聚合（状态总览 / 计时 / 记录 / 四象限 / 365 天 plot）。
> 实现：`workflowwatcher/src/engine/{stats,timeStats,records,quadrant,plot}.ts`

## 做 / 不做

- 做：从 `WfJsonDocument` 算出视图需要的一切派生数字；plot 的 JSON / CSV 纯处理。
- 不做：改写 wfjson（schema 仍 1.9，plot 是独立 JSON）、读盘写盘、DOM。

## 输入 → 输出

| 符号 | 输入 | 输出 |
|---|---|---|
| `summarizeDocument` / `summarizeWorkflow` / `formatStatusOverview` | document | 状态总览文本与计数 |
| `groupWorkflows` / `isWorkflowSettled` | document | 进行中 / 已完成 / 已取消 / 未分类分桶 |
| `countNodeStatuses` / `emptyStatusCounts` | 节点数组 | `NodeStatusCounts` |
| `aggregateTimeEntries` / `completedHours` | document + now | `TimeAggregate`（activeEntry / dailyStats / hours） |
| `buildHeatmap` / `buildGantt` | aggregate + 窗口结束日 + days | 方块阵 / 甘特行（`now` 只用来回推本地日期；结束日可改） |
| `collectNodeRecords` / `recordDurationMs` / `formatHourSpan` | document | 开始 / 完成记录 |
| `quadrantStats` / `quadrantColor` / `isValidScale` | document | 16 分区 + 颜色口径 |
| `validatePlot` / `sortPoints` / `computeScale` / `projectValue` / `toCsv` / `fromCsv` | plot 文档 / CSV | 校验结果 / 投影 / 往返文本 |

## 口径（硬，别再另立一套）

- 状态总览只统计 `state` 缺省的 workflow；`未分类` 不算一条工作流（隐藏 root 不计数）。
- `hours` 一律 1 位小数；跨零点整段计入开始那天，不拆分。
- 方块阵按**本地日历**逐日回退（禁止 `now - i*86400000`，DST 会错位）。
- 象限：`importance` / `urgency` 必须都是 1–4 的整数，缺任一 / 越界 → 不入统计。

## 失败语义

纯函数、不抛错；坏数据（时间无法解析等）跳过该条，契约 §10.5。

## 依赖

上游 `doc-model` + `i18n`；下游 `views`（`wfView` / `plotWidget` / `quadrantWidget`）、`host`（导出）。

## 测试

`stats.test.ts`、`timeStats.test.ts`、`records.test.ts`、`quadrant.test.ts`、`plot.test.ts`。

## 改动流程

口径变更属于**产品决策**：先在对应 `phase*_bound.md` / `data_smalltools.md` 写清，再改这里 + 断言，最后同步本契约。
