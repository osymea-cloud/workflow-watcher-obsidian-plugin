# 能力域契约（contracts-first）

> 这份目录是 `doc/datacontact/ixd_harness_v0.1.md` 的落地：**先有契约，再改实现**。
> 契约不是设计文档，是「改这个域之前必须知道的边界」——输入、输出、副作用、失败语义、依赖、测试。

## 怎么用

1. 接任务 → 读 `.agent/index.json` 找到能力域（id → 路径 → 契约）。
2. 读对应 `capabilities/<域>/CONTRACT.md`（通常 20~40 行），**不要**先读实现。
3. 需要具体符号位置 → 读 `.agent/symbols.json`（`npm.cmd run index` 生成，不会漂移）。
4. 改实现 → 跑 `AGENTS.md` 的验证闸门 → 若边界变了，**同一次提交里改契约**。

## 目录约定（当前阶段）

**本阶段只落契约，不动代码**：实现仍在 `workflowwatcher/src/engine/*.ts`（扁平）与 `workflowwatcher/main.ts`。
契约里的 `paths` 就是「这个域现在由哪些文件承担」。等 `main.ts` 拆分（Phase C）与引擎按域重组（Phase D）
落地时，`capabilities/<域>/` 再长出 `index.ts`（公开 API）/ `schema.ts`（类型）/ `impl/`（实现），
契约留在原地不动——**契约的路径是稳定的，实现的位置可以搬**。

## 能力域一览

| 域 | 一句话 | 实现（当前） | 契约 |
|---|---|---|---|
| `parse` | md 文本 → frontmatter / 围栏 / 严格 JSON / Schema / analyze | `src/engine/{frontmatter,markdownScan,wfjsonParse,wfjsonSchema,schemaValidator,analyze}.ts` | [parse](parse/CONTRACT.md) |
| `doc-model` | 类型、时间、id、issue、树、一致性 | `src/engine/{types,time,ids,issues,tree,consistency}.ts` | [doc-model](doc-model/CONTRACT.md) |
| `writeback` | 构造、代码块/摘要写回、版本升格 | `src/engine/{factory,wfjsonWrite,noteSection,upgrade}.ts` | [writeback](writeback/CONTRACT.md) |
| `mutate` | 安全闸门 + 节点/顺序/计时/工作流/未分类改动 | `src/engine/{mutate,nodeEdits,nodeReorder,timerEdits,workflowEdits,unclassified}.ts` | [mutate](mutate/CONTRACT.md) |
| `archive` | 子树浓缩 + 归档 `.wf.json` + 模板 | `src/engine/{archive,template}.ts` | [archive](archive/CONTRACT.md) |
| `sidecar` | 侧车路径/noteKey/迁移、主看板命名 | `src/engine/{sidecar,mainBoard}.ts` | [sidecar](sidecar/CONTRACT.md) |
| `link-docs` | 反向 YAML 资料归属 | `src/engine/linkAffiliation.ts` | [link-docs](link-docs/CONTRACT.md) |
| `stats` | 状态总览/计时/记录/象限/plot | `src/engine/{stats,timeStats,records,quadrant,plot}.ts` | [stats](stats/CONTRACT.md) |
| `io` | 导入体检 / 合并计划（只认 JSON） | `src/engine/importExport.ts` | [io](io/CONTRACT.md) |
| `i18n` | zh/en 词典与 `t()` | `src/engine/i18n.ts` | [i18n](i18n/CONTRACT.md) |
| `host` | 插件编排 + 宿主适配（vault/命令/事件/设置） | `main.ts`（WfJsonWorkflowPlugin + WfBoardView） | [host](host/CONTRACT.md) |
| `ui` | 表单/弹窗/右侧面板 | `ui/form.ts` + `main.ts`（弹窗段） | [ui](ui/CONTRACT.md) |
| `views` | dataviewjs 渲染器 + 小工具 | `views/{wfView,plotWidget,quadrantWidget}.ts` | [views](views/CONTRACT.md) |

## 共享测试基建（不属于任何域）

- `src/engine/testFixtures.ts`：引擎 fixture 构造器。
- `views/testDomStub.ts`：与 Obsidian 同构的 DOM 桩（`createDiv` 故意抛错，游离元素走 `createElement`）。
- `views/obsidianStub.ts` + `views/obsidianResolve.mjs`：`test:views` 的运行时解析钩子。

## 拆分路线（状态）

| 阶段 | 内容 | 状态 |
|---|---|---|
| A | `AGENTS.md` + `.agent/index.json` + `host-api.md` + `npm run index` | ✅ 本次 |
| B | 13 份能力域 `CONTRACT.md`（本目录） | ✅ 本次 |
| C | 拆 `main.ts`：`adapters/` + `ui/modals/` + `plugin.ts`（薄入口） | ⏳ 逐域进行 |
| D | 引擎物理迁到 `capabilities/<域>/impl/`（可选，风险最高） | ⏳ 后置 |
| E | `harness/tasks/*.yaml` + 结构化 `check` 输出 | ⏳ 后置 |

> Phase C 的边界、顺序与验证闸门写在 [host](host/CONTRACT.md) 与 [ui](ui/CONTRACT.md) 里。
