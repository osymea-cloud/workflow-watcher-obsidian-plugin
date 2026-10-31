/**
 * 节点顺序调整（Phase 15：视图「修改节点顺序」开关 + 拖拽改拓扑；纯函数、零 Obsidian 依赖）。
 *
 * 定位与 nodeEdits.ts 同层：只回答「内存里的文档该改成什么样」，不写盘、不弹窗。
 * 插件侧一一对应 `main.ts` 的 `moveNode(file, movingId, targetId, position)`，
 * 写盘统一由上层套进 `mutateFile` → `applyMutation`（安全闸门 → 内存升格 → 三段写回 → 幂等校验），
 * 因此这里必须做到「要么把文档改对，要么什么都不动」：校验不过一律 `ok=false` + 原因。
 *
 * 语义（契约 doc/datacontact/data_ixd_discuss_interact_v0.9.md §①，a = 被拖节点，b = 落点节点）：
 *  - `after`（拖到 b 的下半部分）：a 成为 b 的子节点，并接手 b 原来的全部 children；
 *  - `before`（拖到 b 的上半部分）：a 成为 b 的前一个同级，b 的 children 不动；
 *  - 两条规则共用同一步：先把 a 的 children 提升到 a 原来的位置（`pa.children.splice(i, 1, ...aChildren)`），
 *    所以「把深处节点提上来」永远不会丢子树。
 *
 * 约定：
 *  - **不改 schema**：`WfNode.children` 的数组顺序就是拓扑顺序（仍 1.9）；
 *  - 受影响的 `a` / `pa` / `pb`（`after` 时再加 `b`：它的 children 被整体交出去了）的
 *    `updatedAt` 由本模块显式维护（applyMutation 只刷 document.updatedAt）；
 *  - 与改前字节完全一致（拖回原位）→ `unchanged: true`，不刷 `updatedAt`、上层也不用写盘。
 */

import { formatLocalIso } from "./time.ts";
import { findNodeVisit } from "./tree.ts";
import type { WfJsonDocument, WfNode } from "./types.ts";

/** 落点位置：目标卡片上半 = 插到它之前（同级），下半 = 成为它的子节点 */
export type ReorderPosition = "before" | "after";

/** 调整顺序的返回：`ok=false` 时文档未被改动，只有 `reason` 有意义 */
export interface NodeReorderResult {
  ok: boolean;
  /** ok=false 时的原因（直接给用户看的中文） */
  reason?: string;
  /** 受影响节点 id（a / b / pa / pb，去重；unchanged 时为空） */
  changedNodeIds: string[];
  /** 拓扑没变（与改前字节一致：拖回原位 / 本来就在目标位置） */
  unchanged?: boolean;
}

/** 失败返回（文档一字不动） */
function reject(reason: string): NodeReorderResult {
  return { ok: false, reason, changedNodeIds: [] };
}

/** 取节点的 children 数组（缺省 / 非数组一律当空数组，不原地补键） */
function childrenOf(node: WfNode): WfNode[] {
  return Array.isArray(node.children) ? node.children : [];
}

/**
 * 把 `movingId` 拖到 `targetId` 的上 / 下半部分（契约 §① / ②）。
 *
 * 护栏（任一不过 → `ok=false` + 原因，文档一字不动）：
 *  1. a / b 都存在、`a !== b`；
 *  2. a 非根（根节点没有父节点，拖不动）；
 *  3. a、b 同属一个 workflow（视图一次只渲染一条泳道，引擎侧也拒绝跨流）；
 *  4. a 不是 b 的祖先（否则拖进自己的子树会成环；反过来「b 是 a 的祖先」允许 —— 等于把深处节点提上来）；
 *  5. `before` 时 b 必须非根（根没有同级）。
 */
export function moveNode(
  document: WfJsonDocument,
  movingId: string,
  targetId: string,
  position: ReorderPosition,
  now: Date = new Date(),
): NodeReorderResult {
  const movingVisit = findNodeVisit(document, movingId);
  if (movingVisit === undefined) return reject(`节点 ${movingId} 不存在（可能已被删除）`);
  const targetVisit = findNodeVisit(document, targetId);
  if (targetVisit === undefined) return reject(`节点 ${targetId} 不存在（可能已被删除）`);

  const a = movingVisit.node;
  const b = targetVisit.node;
  const pa = movingVisit.parent;
  const pb = targetVisit.parent;

  if (movingId === targetId) return reject("不能把节点拖到它自己身上");
  if (pa === undefined) return reject(`根节点「${a.title}」不能被拖动`);
  if (movingVisit.workflow.id !== targetVisit.workflow.id) {
    return reject("不能跨工作流调整节点顺序");
  }
  if (targetVisit.path.some((visitNode) => visitNode.id === movingId)) {
    return reject(`不能把节点拖进它自己的子树（「${b.title}」在「${a.title}」下面）`);
  }
  if (position === "before" && pb === undefined) {
    return reject("根节点没有同级节点：请拖到它的下半部分");
  }

  const before = JSON.stringify(document);

  // 1) 摘 a：把 a 的 children 提升到 a 原来的位置（先展开，再清空 a —— 否则子节点会在树上出现两次）
  const aChildren = childrenOf(a);
  const paChildren = childrenOf(pa);
  const aIndex = paChildren.indexOf(a);
  if (aIndex < 0) return reject(`节点 ${movingId} 不在它的父节点里（数据结构异常，未做改动）`);
  // 防御：before 的落点父节点必须真的持有 b（这一步在**任何改动之前**做，保证 ok=false 时文档一字不动）
  if (position === "before" && childrenOf(pb as WfNode).indexOf(b) < 0) {
    return reject(`节点 ${targetId} 不在它的父节点里（数据结构异常，未做改动）`);
  }
  paChildren.splice(aIndex, 1, ...aChildren);
  a.children = [];

  // 2) 重挂
  if (position === "after") {
    // 顺序不能反：先把 b 的原 children 交给 a，再把 a 挂成 b 的唯一子节点
    const bChildren = childrenOf(b);
    a.children = bChildren;
    b.children = [a];
  } else {
    // pb 必存在（前面已拒绝「before + 根」）；若 pa === pb，第 1 步已让下标左移 → 必须**重算** b 的位置
    const ownerChildren = childrenOf(pb as WfNode);
    ownerChildren.splice(ownerChildren.indexOf(b), 0, a);
  }

  // 3) 拖回原位（字节一致）→ 不刷时间戳，也不写盘
  if (JSON.stringify(document) === before) return { ok: true, changedNodeIds: [], unchanged: true };

  // 4) 时间戳：a 换了父节点、pa 少了 a、pb 多了 a（before）或 b 换了 children（after）
  const at = formatLocalIso(now);
  const touched = new Set<WfNode>([a, pa]);
  if (pb !== undefined) touched.add(pb);
  if (position === "after") touched.add(b);
  for (const node of touched) node.updatedAt = at;

  const changedNodeIds = [a.id, b.id];
  if (pb !== undefined) changedNodeIds.push(pb.id);
  changedNodeIds.push(pa.id);
  return { ok: true, changedNodeIds: [...new Set(changedNodeIds)] };
}
