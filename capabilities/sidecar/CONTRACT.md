# sidecar · 契约

> 能力域：外置 JSON 的路径 / 键 / 迁移计划，以及主看板一对文件的命名。
> 实现：`workflowwatcher/src/engine/{sidecar,mainBoard}.ts`

## 路径规则（硬）

```
A/B/笔记.md  →  <boardFolder>/笔记~<key>.wf.json         // 扁平，第一层就是全部控制文件
<key>        =  noteKeyFor(笔记完整路径)                  // 10 位十六进制
<boardFolder> = boardFolderOf()                          // 设置项 boardFolder，默认 _workflowwatcher
```

- 同名不同目录的两份笔记各有各的侧车（靠 key 区分），不会互相覆盖；
- 改名 / 移动会改变 key → 侧车要跟着搬（`planSidecarMigration` 算计划，落盘在 `host`）；
- 老镜像路径 `legacySidecarPathFor` 只作**读**兜底（Phase 25 起不主动搬迁）。

## 可配置目录（Phase 37，硬）

`<boardFolder>` 是**运行时**值：`types.ts` 的 `boardFolderOf()` 读模块级状态，`setBoardFolder()` 写它
（`main.ts` 在 `onload` 与设置变更时各调一次）。引擎里所有路径函数都读 `boardFolderOf()`；
`WFJSON_FOLDER` 只是**出厂默认值**，别在业务代码里直接当路径用。备份目录同理：`backupFolderOf()` = `<boardFolder>/backup`。

## 主看板（硬）

`<boardFolder>/main~<key>.md` + `<boardFolder>/main~<key>.wf.json`：**同名同键、只差扩展名**。
key 由基准路径 `_workflowwatcher/main.md`（**默认目录**，与当前 boardFolder 无关）算出（常量 `MAIN_BOARD_KEY`），
不能拿带键的文件名当输入（否则循环）。键不随 boardFolder 变 → 改目录时文件名一个字都不用改，只换所在目录。

## 做 / 不做

- 做：`sidecarPathFor` / `legacySidecarPathFor` / `notePathForSidecar` / `parseSidecarName` / `planSidecarMigration` / `planSidecarPair` / `isBackupPath` / `backupPathFor`；
  `boardFolderOf` / `setBoardFolder` / `normalizeBoardFolder` / `backupFolderOf`；
  `mainBoardPath` / `mainBoardSidecarPath` / `mainBoardBasePath` / `mainBoardKey` / `isMainBoardCandidate` / `rankMainBoardPaths`。
  （`MAIN_BOARD_PATH` 等常量保留为**默认目录**下的值，只给不关心目录的纯函数 / 老测试用。）
- 不做：`vault.rename` / `vault.trash`（→ `host` 的 rename / delete 钩子）。

## 失败语义

纯字符串函数；非法名返回 `undefined` / 空计划，不抛错。

## 依赖

上游 `doc-model`（`boardFolderOf()`；`WFJSON_FOLDER` 只表示出厂默认值）；下游 `mutate`（noteKey）、`archive`、`host`。

## 测试

`sidecar.test.ts`、`mainBoard.test.ts`。

## 改动流程

改路径规则 = 同时改 `main.ts` 的 rename / delete / backup 钩子与本契约；老路径必须保留读兜底。
