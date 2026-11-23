# archive · 契约

> 能力域：子树浓缩 + 归档 `.wf.json` 生成 + 工作流模板。
> 实现：`workflowwatcher/src/engine/{archive,template}.ts`
> 契约来源：`doc/datacontact/data_ixd_discuss_interact_v0.3.md`、`data_ixd_v09.md` §2.10 / §5

## 做 / 不做

- 做：资格判定（`archiveEligibility` / `workflowArchiveEligibility`）、归档计划（`planArchive` / `planWorkflowArchive`）、
  内存浓缩（`archiveNode` / `archiveWorkflow`）、归档追加（`planArchiveAppend`）、归档路径（`archiveFilePath`）、
  归档身份识别（`readArchivedWorkflowIdentity` / `readArchiveFileMeta`）、
  归档元数据（`buildNodeArchiveRef` / `buildWorkflowArchive` / `editWorkflowArchiveInfo` /
  `applyWorkflowArchiveNotes` / `setWorkflowArchiveNotes`）、模板（`buildWorkflowTemplate`）。
- 做：归档产物是**单文件 JSON**（Phase 28）：`archive/<workflowId>-<nodeId>.wf.json`；
  `planArchive` / `planWorkflowArchive` 只给 `document`（**没有** `markdown`），落盘由 `host` 用 `stringifyWfJson` 一次写完。
- 不做：`vault.create` / `vault.process`、弹窗（→ `host` / `ui`）。

## 两步顺序（硬）

**先建归档 `.wf.json` → 成功后改原文件**；两步都幂等，中途失败可重试收敛。
同一棵子树不允许出现两份归档（`isArchivePathForNode` 只认 `*.wf.json`，负责判重）。

## 归档文件（Phase 28，硬）

- 一个归档 = 一个 `<archiveFolderOf()>/<workflowId>-<nodeId>.wf.json`，**不再生成 md / 侧车成对形态**；
  `<archiveFolderOf()>` = `<boardFolder>/archive`（跟着设置的看板文件目录走，默认 `_workflowwatcher/archive`）；
- 归档文件自带文件级 `archivedAt`（ISO8601，首次归档 / 每次追加都刷新）—— 归档看板的 21 天窗口默认以它结束；
- 归档看板 = 直接解析这个 JSON（`host` 的 `.wf.json` 分支：`noteMarkdown: ""` + `checkFrontmatter: false`）；
  写回走 `mutateFile()` 的 JSON 分支（没有笔记要同步）；
- 老的内联归档（正文里带 wfjson 代码块）仍可读：身份用 `readArchivedWorkflowIdentity(markdown)` 兜底。

## 归档元数据（Phase 39，硬）

**一条归档记录 = 磁盘上那份归档文件**，所以说明文字只写一次：

- 原文档的浓缩节点：`node.archive = { workflowId }`（**只有指针**，没有时间 / 文字 / 路径）；
- 归档文件自己的 `workflow.archive`（`WfWorkflowArchive`）：
  `{ archivedAt?, from_workflow?, from_node?, summary?, idea?, review?, tag? }`；
  `from_*` 是归档那一刻的原工作流 / 原节点标题快照；
  **Phase 45**：三个事实键改为选填 —— 任意工作流都可以只写四条复盘说明（「修改工作流」弹窗），
  此时一个事实键都不写（`archivedAt` / `from_*` 只属于真归档文件）；
- 文件级 `workflow_archive[]` 台账的 `archive` 也是 `{ workflowId }`（与根节点同一个指针）；
- 编辑说明只走 `editWorkflowArchiveInfo(document, workflowId, form, now)` —— 不碰 `archivedAt` / `from_*`；
- 任意工作流写四条说明走 `applyWorkflowArchiveNotes(workflow, form)`（返回是否变了；**不合成事实键**）
  或 `setWorkflowArchiveNotes(document, workflowId, form, now)`（按 id + 刷 `document.updatedAt`）；
  四条全空且没有事实键 → `workflow.archive` 整块删掉，有事实键则只删说明；
  「修改工作流」弹窗把它挂在 `WorkflowPatch.archive` 上，与标题 / 状态同一次写回；
- 重复归档（`planArchiveAppend`）只刷新归档文件的 `archiveMeta.archivedAt`，`from_*` 与未重填的说明保持原值；
- 「已归档」弹窗懒加载：`readArchiveFileMeta(path, jsonText)` 一次读回 workflow id / 标题 / 时间 / 来源 / 三段文字 / 标签；
- 标签枚举（`archive_tag.yaml`，Phase 39 / 41）：**每次打开归档表单 / 已归档弹窗都现读**
  （宿主 `refreshArchiveTags()` → `parseArchiveTagYaml`），候选列表放在标签输入框下方**一行**、
  放不下自动换行（`.wf-tag-picker`；已归档弹窗顶部同款 `.wf-archive-filter`）；
- `node.archive` 没有路径 —— 打开归档看板按 `workflowId` 扫 `archive/*.wf.json` 认领（宿主实现）。

## 资格边界（任一不满足即拒绝，文档一动不动）

- 根节点不能归档（它是泳道入口与定位点）；
- 工作流归档要求整棵树全 done；
- 被拒绝时返回的理由文案**同时**用于右键菜单置灰与写回提示（别写两套）。

## 浓缩口径

浓缩节点只保留 `id / title / status=done / importance / tags / 时间信息（timeEntries 累加 + completedAt 取最晚）/ archive`；
`archive` 只剩 `{ workflowId }`（Phase 39）；`children` 清空；被删后代的旧纪要锚点通过 `removedNoteAnchors` 上报给写回层删除。

## 依赖

上游 `doc-model` + `writeback`；下游 `host`（落盘 / 归档看板）/ `ui`（`ArchiveNodeModal`）。

## 测试

`archive.test.ts`、`template.test.ts`。

## 改动流程

先改资格 / 浓缩口径的契约段落，再改 `planArchive` 与 `archiveNode`，再补「先归档后原文件」的顺序测试。
