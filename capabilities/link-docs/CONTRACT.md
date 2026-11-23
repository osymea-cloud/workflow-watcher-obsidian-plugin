# link-docs · 契约

> 能力域：反向 YAML 资料归属（资料文件自己声明「我属于哪个节点」）。
> 实现：`workflowwatcher/src/engine/linkAffiliation.ts`
> 契约来源：`doc/datacontact/phase27_bound.md` §5.1 / §5.6

## 归属四键（写在资料文件自己的 frontmatter 上）

```yaml
wf-workflow: 读书计划        # 人读：workflow.title
wf-node: 选书                # 人读：node.title
wf-workflow-id: wf-3f9a1c2b7d   # 可选：workflow.id
wf-node-id: nd-0a1b2c3d4e       # 可选：node.id
```

匹配口径：**id 精确命中即权威**（改名 / 搬库后仍命中）；id 组为空才退到标题匹配。

## 做 / 不做

- 做：`parseAffiliation`（经 `affiliationOf` / `affiliationsOf`）、`buildReverseIndex`、`resolveLinkedFiles`、`nodeRefFor`、
  `collectAffiliatedFiles` / `collectWorkflowFiles` / `collectSubtreeFiles`、`appendAffiliation` / `replaceAffiliationItem`。
- 不做：`metadataCache` 订阅与摊平（→ `host` 的 `rebuildReverseIndex` / `linkedFiles`）、视图渲染。

## 输入形态（硬）

`host` 从 `metadataCache` 摊平成 `AffiliationEntry[]` 喂进来；**只认 `.md`**。
视图渲染同步取结果，本域不发 Promise。

## 失败语义

纯函数；坏 frontmatter 跳过该条，不抛错；索引是只读快照。

## 依赖

上游 `doc-model`（frontmatter 常量）；下游 `views`（🔗 计数 / 实虚线 / 右键资料菜单）、`host`。

## 测试

`linkAffiliation.test.ts`。

## 改动流程

改四键 / 匹配口径 → 先改 `phase27_bound.md` 与 `FRONTMATTER_LINK_FIELDS`，再改本模块与本契约。
