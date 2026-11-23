# i18n · 契约

> 能力域：zh / en 词典与文案出口。
> 实现：`workflowwatcher/src/engine/i18n.ts`

## 做 / 不做

- 做：`t()` / `tIn()`（插值）、`setLang` / `getLang` / `normalizeLang`、状态与严重度标签、issue 标题 / 修复提示、星期与字段名。
- 不做：任何 UI 结构（文案只是字符串）。

## 状态模型（硬）

- **模块级可变状态** `currentLang`：插件在 `onload` 与设置变更时调一次 `setLang()`，之后全引擎自动切换。
  不要给每个分析 / 渲染函数加 `lang` 参数（会污染整条调用链）。
- 默认 `en`：没配过设置的新用户先看到英文。
- `zh` 是原文，`en` 是译文；两边 key 必须一一对应（`MESSAGES` 类型强制 `en` 齐全）。

## 语言中性项（不进字典）

`P1-Low` 之类的 importance / urgency、`3d2h` 格式的时长、用户数据标题。

## 失败语义

查不到的 key **直接回显 key 本身**（便于发现漏配，而不是静默空白）。

## 依赖

上游 `doc-model` 的枚举常量；下游：所有引擎域 + `host` / `views`。

## 测试

`i18n.test.ts`（含 en / zh key 对齐检查）。

## 改动流程

加文案 = 同时加 `zh` 与 `en`；删文案先全仓搜 key；`statusLabel` / `stateLabel` / `issueMsg` 的调用方不需要改。
