# views · 契约

> 能力域：dataviewjs 渲染器与两个小工具。
> 实现：`workflowwatcher/views/{wfView,plotWidget,quadrantWidget}.ts`
> 目标形态：保持独立；只有当「渲染」本身继续膨胀时才按「总览 / 泳道 / 弹窗」再切。

## 小工具清单（`WIDGETS`）

`wfView.ts` 的 `WIDGETS` 是**唯一清单**：导航面板「统计」列的文字按钮、弹窗顶部 tab 都由它派生
（`POPUP_WIDGETS` = 去掉 `action: "openSettings"` 的那一项）。顺序与 `test:views` 的计数断言绑在一起。

- 7 个走弹窗：`gantt21` / `quadrant` / `archive` / `data` / `records` / `plot365` / `schemaWarn`；
- 1 个走宿主：`settings`（`action: "openSettings"`，在「修改」列）。

`schemaWarn`（Phase 40）：只读 `AnalyzeResult.issues` 里 `SCHEMA_UNKNOWN_FIELD` 的那几条，
列「字段名 + JSON Pointer」；空态一条占位文案。它**不写盘、不查盘**，所以新增 tab 不需要动 `WfViewHost`。

## 依赖边界（硬）

1. `views/` **只允许 `import type` 引 obsidian**；运行时能力由 `WfViewHost` 注入（这样视图能在 `node --test` 里跑）。
2. 只读引擎：`import "../src/engine/index.ts"`，不直接引引擎内部文件。
3. **绝不写 vault**：所有写操作都走 host（`setNodeStatus` / `openNodePanel` / `startTimer` / `stopTimer` / `moveNode` / `setNodeCollapsed` / 资料归属查询）。

## `WfViewHost` 是契约（改签名 = 改三个地方）

`wfView.ts` 导出的 `WfViewHost` 接口，必须与 `main.ts` 的实现、`wfView.test.ts` 的桩**同时**改。
已有方法：`analyzeFile` / `setNodeStatus` / `openNodePanel` / `startTimer` / `stopTimer` / `moveNode` /
`setNodeCollapsed` / `linkedFiles` / `openLinkText` 等；返回类型见 `WfPanelResultMap`。

## DOM 不变量（硬，踩过）

- `document` **不是容器**：`createDiv` / `createEl` 是「创建 + append 到接收者」，`document.createDiv()` 会抛
  `HierarchyRequestError`。游离元素一律 `detachedDiv()`；只有右键菜单可以用 `document.body.createDiv`。
- `classList.add` / `addClass` **不接受含空格的 token**，多类名必须自己按空白拆。
- 别把 `WfJsonDocument` 形参命名成 `document`（历史上就是它把小写 `document.createDiv` 的 bug 藏起来）。

## 渲染不变量（硬）

- 整块重渲染按 `file.path` **串行 + last-wins**（`enqueueRender` / `paint`），不能靠 `setTimeout` 缓冲。
- 单轮顺序：先拿分析（写回自带 `analysis`，否则 `analyzeFile`）→ 抓滚动 → 清空 → 重建 → 恢复。
- 滚动是两套：外层滚动宿主（`captureScroll` / `restoreScroll`）+ 每条泳道正文（`captureLaneBodies` / `restoreLaneScroll`）；
  重渲染**复用上一帧 `.wf-lane-body` 元素**，避免 `scrollHeight` 塌到 0。
- 写盘前由 `host` 调 `rememberViewScroll(file.path)` 抢一份位置（Dataview 会先 `innerHTML = ""`）。

## 失败语义

渲染器不抛错给用户：坏数据由引擎 analyze 转成 issue；DOM 缺失降级为提示块，不白屏。

## 测试

- `views/wfView.test.ts`（`npm.cmd run test:views`，必须带 `--import ./views/obsidianResolve.mjs`）；
- `views/plotWidget.test.ts`、`views/quadrantWidget.test.ts`（`npm.cmd run test`）。
- 基线：`test:views` 136 pass / 38 fail（38 条历史债，见 `doc/ai_rules/lint.md` §7.1；其中「② 未定义字段…只在 tab 里列字段名」
  那条自 `wfView.ts` 的 `wf-schema-warn-field` 行被注释起就红着，属既有债，不许再新增）；新增红灯必须当场修。
- 主题（Phase 46）：清单 **9 个 key**（`WF_THEME_KEYS` = `default` / `tech` / `nature` / `magazine` / `retro` / `polka` / `web` / `fresh` / `shoujo`）。
  `resolveViewTheme()` 依次看 `options.theme` → frontmatter `wf-theme` → **`default`**（宿主清单里没有它时仍回落空串）。
  `default` 没有专属样式桶（= `styles.css` 基础样式 + `body` 的 token），挂属性只为让
  `.wf-theme[data-wf-theme]` 这类「带属性即生效」的规则命中；容器 / 浮层 / 弹窗 / 画板**一律挂属性**。
  弹窗侧 `main.ts` 的 `themeOrDefault()` 同一口径（没传 / 非法 → `default`）。
  Phase 44 曾删掉 `default`，导致模板新建的看板（`wf-theme: default`）不挂属性、用户自定义变量
  （例如 `--wf-polka-size`）全部命中不到 → Phase 46 回滚；**不迁移、不改写用户笔记**。
- 连线锚点（Phase 21 / 42 / 43）：`--wf-cell-anchor` 里的 `var(--wf-card-width, 250px)` **必须带回落值**，
  且与 `.wf-card` 的回落值同值。`--wf-card-width` 由宿主写在主窗口 `<html>` 行内样式上，popout 窗口取不到；
  没回落值 → 整串 `calc()` 变 invalid at computed-value time → `.wf-elbow` / 两截横线（`::before` / `::after`）
  的 `margin-left` / `left` / `right` 全退化成 `auto`，**连线整体消失**。
  竖线的 `margin-left` 还要再减 `--wf-cell-lead`（margin 从 padding box 起算，不减就右偏 24px）。
- 连线几何 / 颜色（Phase 43）：`--wf-linkline-card` / `--wf-elbow-height` / `--wf-line-color` 只在 `body{}` 里定义，
  所以它们的每一处使用**都必须带回落值**（`1px` / `19px` / `var(--wf-line-color, var(--wf-card-border, #b9b9b9))`）。
  变量缺失时 `width` / `height` 退化成 `auto`：空 div 在 `display:flex` + `align-items:center` 的 `.wf-cell` 里
  量成 **0×0** 且背景透明，伪元素 `height:auto` 同样为 0 → **竖线 + 两截横线全消失，而卡片 / 泳道 / 主题色正常**
  （DevTools 里像「伪元素没生成」）。涉及 `.wf-elbow`、`.wf-cell--side::before`、`.wf-cell--has-next::after`、
  `.wf-note` + `.wf-note::before`、`.wf-column + .wf-column .wf-lane`。`wfView.test.ts` 有静态断言锁住这几处。
- Phase 41：`WIDGETS` 里的「已归档」页一打开（`openWidgetsPopup` / `selectWidgetTab`）
  就调 `host.refreshArchiveTags()` 现读 `archive_tag.yaml`，回来再重画一次；
  行里的「打开归档看板」= 宿主开看板 + `closeWidgetPopup(file.path)`（弹窗挂在 body 上，不关会盖住新页面）。
- Phase 28：看板文件不止 `.md` —— 归档看板是 `*.wf.json`，`resolveSelfFile` / `isBoardFile` 必须放行；
  21 天方块阵 / 甘特图的窗口结束日由弹窗里的 `<input type="date">` 控制（默认今天；归档看板默认归档日）。

## 改动流程

改 DOM 结构 / 类名 → 同步 `styles.css` + `styles_bound.md`；改 host 接口 → 同步 `main.ts` + 桩；跑 `test` + `test:views` + `build`。
