# host · 契约

> 能力域：插件编排 + Obsidian 宿主适配。
> 实现：`workflowwatcher/main.ts`（`WfJsonWorkflowPlugin` + `WfBoardView`，**唯一直接操作宿主的地方**）
> 目标形态：`main.ts`（薄入口）→ `plugin.ts`（编排）→ `adapters/`（宿主薄壳）

## 职责（现在都在 main.ts）

- 生命周期：`onload` 装配（`loadSettings` → `setLang` → CSS 变量 → 设置 tab → 老目录迁移 → 命令 → `registerView` → ribbon → 事件订阅）。
- 宿主读写：`mutateFile()`（`vault.process` 事务）按三种形态分流：md 内联 / md + 侧车 / **纯 `.wf.json`**（Phase 28 归档看板）；
  侧车同步（rename / delete）、备份镜像（create / modify）、反向索引重建。
- 入口：`openMainBoard` / `openArchiveBoard`（归档 = `archive/<wfId>-<nodeId>.wf.json`）/
  `openArchiveBoardByWorkflowId`（Phase 39：节点侧只有 `workflowId` → 扫 `archive/` 认领，找不到的 Notice 带 id）/
  `openNodePanel` / `WfViewHost` 的其余实现。
- 设置持久化与根元素 CSS 变量（`--wf-timer-font-size` / 卡片宽度）；设置面板分四组：全局 / 总览 / 工作流 / 统计。
  - **全局**：语言 + **看板文件目录**（`boardFolder`，Phase 37，默认 `_workflowwatcher`）——
    侧车 / 主看板 / 归档 / 备份的根，`onload` 与设置变更时用 `setBoardFolder()` 写进引擎；
  - **统计**：**图表文件根目录**（`plotRoot`：`board` 默认 / `vault`）+ 图表文件目录（`plotFolder`，相对名，默认 `plots`）。
    有效目录由 `effectivePlotFolder()` 现算：`board` → `<boardFolder>/<plotFolder>`（= `_workflowwatcher/plots`），
    `vault` → `<plotFolder>`；`host.plotFolder()` 只返回这个最终路径，视图零改。
- Phase 37 批量入口（`WfViewHost`）：
  `importJsonPaths(file, paths, "board" | "archive")`（多源累加合并 / 落成归档文件）、
  `boardJsonPaths(file)`（当前看板 + 全部归档的绝对路径）、`pickImportJsonPaths()`（桌面多选）、
  `copyText(text)`、`archiveBoardFiles()`（已归档弹窗的文件清单）。
- Phase 39 归档元数据（`WfViewHost`，**归档文件自己的 `workflow.archive`**）：
  `readArchiveMeta(path)`（弹窗打开时才读 —— 懒加载）、
  `openArchiveMetaEditor(path)`（初值现读、写回走 `mutateFile` 的 `.wf.json` 分支）、
  `setWorkflowArchiveInfo(path, workflowId, form)`（低层；只改三段文字 / 标签）。
- Phase 41 归档标签枚举（`WfViewHost`）：`refreshArchiveTags()` = 重扫 `archive_tag.yaml` 再返回清单
  （读不到 / 解析失败 → 空数组，不抛错）。三个入口都要用它现读，**不许**直接吃 `archiveTags()` 的启动缓存：
  打开「统计 → 已归档」弹窗、打开「编辑归档信息」、开「为此及之后归档 / 归档整个工作流」表单（`panelModalFor` 的 `case "archive"`）。
- Phase 41 打开看板要**真的跳过去**：`openBoardAt()` 在 `setViewState` 之后补一次
  `workspace.setActiveLeaf(leaf, { focus: true })` —— `getLeaf("tab")` 只保证新开页签，不保证抢前台。

## 不做

引擎语义（→ `src/engine`）、表单布局与文案排布（→ `ui`）、渲染（→ `views`）。

## 不变量（硬）

1. **依赖方向**：本层只 `import "./src/engine/index.ts"`；引擎内部文件一律不准直接引。
2. **写盘顺序**：先侧车 JSON、后笔记；**不要**在同一个 `vault.process` 里改两个文件（Obsidian 事务只覆盖单文件）。
3. `registerView` 必须在**任何** `setViewState` 之前（否则 workspace.json 还原布局时找不到视图）。
4. `metadataCache` 落盘后滞后一拍：归档后立刻重画看板时，`writtenFrontmatter` 顶替旧值，`metadataCache.changed` 到达后删除。
5. 写盘前 `rememberViewScroll(file.path)`；整块重渲染按 `file.path` 串行 + last-wins（见 `views`）。
6. 本文件是唯一允许 `node:fs` 的地方（Phase 26 库外导入导出）；移动端无 `fs`，必须转成「读不到」提示。
7. **取消 vs 失败**：表单 resolve `undefined` = 用户取消（静默）；失败必须抛错 / Notice，不许混为一谈。
8. **改看板文件目录（Phase 37）**：整目录 `renameFile`；目标目录已存在 → 只提示、**不合并**、设置保持原值；
   主看板 md / 侧车文件名不变（`MAIN_BOARD_KEY` 是常量），只换所在目录。侧车 / 主看板 / 归档路径一律用
   引擎的 `*Of()` / `mainBoard*()` 现算，**不要**在宿主层拼字符串。
9. **归档元数据只写归档文件（Phase 39）**：`node.archive` 只有 `{ workflowId }`；三段文字 / 时间 / 来源都在
   归档文件自己的 `workflow.archive`。编辑说明 = 改那份 `.wf.json`（`setWorkflowArchiveInfo`），
   **不要**回写原看板的节点；导入成归档时 `archivedAt` = 导入时刻、`from_*` = 导入的那条工作流。

## Phase C 拆分目标（按现有行号切，逐步进行）

| 现状 | 去向 |
|---|---|
| 249–441 设置归一化 / 主题 / 命令名 / 路径 / `errorMessageOf` | `adapters/paths.ts` + `plugin.ts` 杂项 |
| 483–603 `WfBoardView` | `plugin.ts` |
| 603–3420 `WfJsonWorkflowPlugin` | vault 读写 → `adapters/vault.ts`；Notice → `adapters/notice.ts`；命令 / wiring / `WfViewHost` → `plugin.ts` |
| 3421–3626 `WfModal` + `fieldRow` / `wfButton` / 日期 | `adapters/dialog.ts`（基类）+ `ui/form.ts`（控件） |
| 3628–5695 13 个弹窗 | `ui/modals/<tab>.ts` |
| 5696–5847 `WfSidePanel` | `adapters/dialog.ts`（外壳）+ `ui/panel.ts`（tab 装配） |
| 5848–5955 `WfJsonSettingTab` | `adapters/settings.ts` |
| 1–96 头注释 | 迁到 `AGENTS.md` / 本契约，`main.ts` 只留薄入口 |

**顺序**：`adapters/` → `ui/form.ts` + `ui/modals/*` → `plugin.ts` → `main.ts` 收薄。
**每一步都必须**：类名 / 导出签名不变（只改 import）→ `npm run typecheck` + `lint` + `test` + `test:views`（基线 127/36）+ `build`。

## 失败语义

- 读不到 / 写失败：转成 Notice + 结构化返回值，不吞错；
- 用户取消：返回 `undefined`，不提示；
- 侧车与笔记两步之间中断：重跑即收敛（两步都幂等）。

## 测试

无直接单测（宿主层靠 `typecheck` / `lint` / 手工验收）；`WfViewHost` 的签名由 `views/wfView.test.ts` 间接覆盖。

## 改动流程

改命令 / 入口 / 写盘链路 → 先改本契约 → 改实现 → 跑 `AGENTS.md` 的 1~6 步（含 `deploy` 手工验收）。
