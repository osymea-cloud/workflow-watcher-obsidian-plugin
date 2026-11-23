# mutate · 契约

> 能力域：**所有写操作的唯一入口**（安全闸门 + 内存改动 + 幂等校验）。
> 实现：`workflowwatcher/src/engine/{mutate,nodeEdits,nodeReorder,timerEdits,workflowEdits,unclassified}.ts`

## 做 / 不做

- 做：`applyMutation`（analyze → 有 error 拒绝 → 内存升格 → mutator → 写回 → 再 analyze 幂等校验 → 失败整笔回滚）、
  `applySidecarMutation`、`applyNoteSectionEdit`；节点 / 顺序 / 计时 / 工作流 / 未分类的内存编辑原语。
- 不做：弹窗、`vault.process`、Notice（全在 `host` / `ui`）。

## 输入 → 输出

| 符号 | 输入 | 输出 |
|---|---|---|
| `applyMutation(markdown, mutator, options?)` | 原文 + 纯函数 mutator | `MutationResult{ text, changed, analysis, issues }` |
| `applySidecarMutation(jsonText, mutator, options?)` | 侧车 JSON 文本 | 同上（只碰 JSON） |
| `appendChildNode` / `removeNode` / `editNodeInfo` / `editNodeNote` / `editNodeLinks` | document + 参数 | `{ ok, reason?, changedNodeIds? }` |
| `startTimerEntry` / `stopTimerEntry` | document + 节点 / 模式 | `TimerEditResult`（含并发闸门判定） |
| `addWorkflow` / `removeWorkflow` / `editWorkflow` / `applyWorkflowEdits` | document + patch / plan | `{ ok, reason? }` |
| `ensureUnclassifiedWorkflow` / `addUnclassifiedNode` / `attachNodeToUnclassified` | document + 节点 | `{ ok, ... }` |
| `moveNode` 对应 `nodeReorder` 的导出原语 | document + 目标 / 位置 | `{ ok, reason? }` |

## 每个编辑函数的硬约束（硬）

**要么把文档改对，要么什么都不动**：校验不过返回 `ok=false` + 中文 `reason`，调用方据此 reject，原文保持原样。
受影响节点的 `updatedAt` 由编辑原语维护；`document.updatedAt` 由 `applyMutation` 统一刷新。

Phase 45 字段口径：

- `WorkflowPatch.archive`（`{ summary?, idea?, review?, tag? }`）= 这条工作流 `workflow.archive` 的四条复盘说明，
  由 `applyWorkflowArchiveNotes` 写入；**不合成** `archivedAt` / `from_*`（那是真归档文件才有的事实键）；
- `node.summary` 已废弃：不再出现在 `NodeInfoPatch` / `NODE_INFO_FIELDS`，`editNodeInfo` 不读也不写；
  `createNode` 也不再写它。旧文件里的值照读、不迁移，缩节归档时随 `PRUNED_FIELDS` 删掉。

## 并发闸门

计时：全文件只允许一个「有 startAt、无 endAt」的条目；已有 active 时「开始」必须被拒绝。

## 依赖

上游 `writeback` / `doc-model` / `sidecar`（noteKey）；下游 `host`（`mutateFile` 套进 `vault.process`）。

## 测试

`mutate.test.ts`、`nodeEdits.test.ts`、`nodeReorder.test.ts`、`timerEdits.test.ts`、`workflowEdits.test.ts`、`unclassified.test.ts`。

## 改动流程

新增写操作 = 新 mutator（纯函数）+ 一个编辑原语 + 至少一条「失败时原文不动」的测试；写盘永远复用 `mutateFile`。
