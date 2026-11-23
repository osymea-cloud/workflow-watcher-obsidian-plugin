# ui · 契约

> 能力域：节点上下文菜单 / 设置用的表单与弹窗。
> 实现：`workflowwatcher/ui/form.ts`（控件，Phase C 第 1 步已拆出）+ `workflowwatcher/main.ts` 的弹窗段（13 个弹窗 + `WfSidePanel` + `WfJsonSettingTab`）
> 目标形态：`ui/form.ts`（控件）+ `ui/modals/*.ts`（一 tab 一文件）+ `ui/panel.ts`（tab 装配）

## 做 / 不做

- 做：`WfModal<T>` 基类（`build(parent)` / `openAndWait()` / `mountInto(parent)` / `finish` / `cancel`）、
  `fieldRow` / `wfButton` / 日期三段、14 个表单类、面板 tab 切换与 dispose。
- 不做：写盘（保存时只调 `host` 给的 async 回调，拿结果）、引擎内部 import（只走 `engine/index.ts`）、渲染（→ `views`）。

## 统一表单皮肤（与 `doc/datacontact/styles_bound.md` §3.1 对齐）

八个角色，样式只在 `styles.css` 的 S12 写一次；TS 侧**类名就是唯一契约**：

| 角色 | 类名 |
|---|---|
| ① 标题 | `.wfjson-modal-title` / `.wf-panel-title` |
| ② 子标题 / 说明 | `.wfjson-modal-subtitle` |
| ③ 字段行列 | `.wfjson-field` / `.wfjson-field-label` / `.wfjson-required` |
| ④ 字段说明 | `.wfjson-field-hint` |
| ⑤ 输入框 / 文本域 | `.wfjson-input` / `.wfjson-textarea` + `.wfjson-date*` |
| ⑥ 普通按钮 | `.wfjson-btn` |
| ⑦ 警告按钮 | `.wfjson-btn.mod-warning` |
| ⑧ 强调按钮 | `.wfjson-btn.mod-cta` |

约束：
- 按钮一律走 `wfButton(parent, label, kind)`，不要手写 `createEl("button")`；
- 危险对话框标题在 `.wf-theme` 作用域里重钉 `--text-error`（否则 9 套主题签名把它盖掉）；
- 主题差异走 `.wf-panel-title` / `--wf-radius-btn` 等变量，**不要**为每套主题复制一份弹窗样式。

## 交互不变量（硬）

- `finish(value)` = 成功；`cancel()` / Esc / 点遮罩 = `undefined`。调用方据此区分「取消静默」与「失败提示」。
- 内嵌模式（`mountInto`）下 `finish` / `cancel` **不碰 Modal 容器**；换 tab / 关面板时 `dispose()` 按取消收尾。
- 就地校验失败 → 错误提示留在表单里，不关窗；写回失败 → 关窗 + Notice（由 `host` 决定文案）。
- 长表单（工作流编辑）：**两种模式都**挂 `wfjson-modal--sticky-footer` —— 独立弹窗靠
  `.modal-content.wfjson-modal--sticky-footer`，内嵌到右侧面板时面板 body 本身就是表单根，
  靠 `.wf-side-panel-body.wfjson-modal.wfjson-modal--sticky-footer`（列表内滚、底部按钮行固定）。
  换 tab / 显示提示时 `WfSidePanel.clearBody()` 会把 `wfjson-modal*` 类摘掉（`empty()` 不删类）。
- 「修改工作流」表单（Phase 45）：顶部一行 `<select>`（每条工作流一个选项 + 右侧「新增工作流」按钮），
  下方只渲染**当前选中那条**的表单（标题 / 状态 / 概括 / 原理·启发 / 复盘·下一步 / 标签）；
  切换下拉先把当前控件值回写草稿、再重渲染（编辑不丢）；删除是就地二次确认（新增草稿 = 直接丢弃）。
  四条说明走 `WorkflowPatch.archive`，保存成功后由 `host` 把本次用到的标签并入 `archive_tag.yaml`。
- 导入 / 导出小工具（Phase 37 重写，Phase 38 收敛成两块）：**导入 = 一个可编辑清单 + 三个按钮**
  （选择… / 导入主看板 / 导入已归档——两个导入按钮面对同一份清单，只换落点）；
  **导出 = 一个只读清单 + 两个复制按钮**。视图只传**路径清单**，读写与剪贴板全在 `host`
  （`importJsonPaths` / `boardJsonPaths` / `copyText` / `pickImportJsonPaths`）。
- 两个清单共用 `.wf-data-list`：宽度占满弹窗、高度固定（两个天然等高）、`resize: none`（拖不动）、
  `white-space: pre` + `overflow-x: auto`（每行不换行，超长路径在列表内横滚）；导出清单是 `readonly`。
- 导出清单只**显示**路径 + 复制，不替用户决定复制到哪；`importData` / `exportData` 是旧的单文件入口，仍保留。

## 拆分顺序（每步只搬代码、不改行为）

1. ✅ `ui/form.ts`：`fieldRow` / `wfButton` / `WfButtonKind` / 日期三段 / `pad2` / `localDateAfter`（2026-11-21 已拆出，零行为变化）。
2. `adapters/dialog.ts`：`WfModal<T>` / `WfMountedForm` / `WfSidePanel` 外壳。
3. `ui/modals/*.ts`：每 tab 一个文件（exportData / importReport / newChild / delete / linkDocs / tag / archive / nodeInfo / nodeNote / workflowEditor）。
4. `ui/panel.ts`：`tabLabel` + tab → 表单 的装配。
5. `main.ts` / `plugin.ts` 只留 import 与调用。

## 测试

`views/wfView.test.ts` 的「节点弹窗统一表单皮肤」describe（静态 CSS 断言：8 角色、主题 token、danger 标题色）。
`test:views` 基线：146 pass / 18 fail（18 条为历史债，不许新增）。

## 改动流程

改表单 = 先确认角色仍落在这 8 个类名内 → 改 `styles.css` S12 + `styles_bound.md` §3.1 → 改 `main.ts` → 跑 `test:views`。
