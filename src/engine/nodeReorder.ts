/**
 * 节点顺序调整（Phase 15：视图「修改节点顺序」开关 + 拖拽改拓扑；纯函数、零 Obsidian 依赖）。
 *
 * 定位与 nodeEdits.ts 同层：只回答「内存里的文档该改成什么样」，不写盘、不弹窗。
 * 插件侧一一对应 `main.ts` 的 `moveNode(file, movingId, targetId, position)`，
 * 写盘统一由上层套进 `mutateFile` → `applyMutation`（安全闸门 → 内存升格 → 三段写回 → 幂等校验），
 * 因此这里必须做到「要么把文档改对，要么什么都不动」：校验不过一律 `ok=false` + 原因。
 *
 * 语义（契约 doc/datacontact/data_ixd_discuss_interact_v0.9.md §① +
 * doc/datacontact/data_ixd_discuss_interact_v0.21.md「拖拽规则补充契约」，a = 被拖节点，b = 落点节点）：
 *  - `after`（拖到 b 的下半部分）：a 成为 b 的子节点，并接手 b 原来的全部 children；
 *  - `before`（拖到 b 的上半部分）：a 成为 b 的前一个同级，b 的 children 不动；
 *  - 普通节点（`keepSubtree` 缺省）两条规则共用同一步：先把 a 的 children 提升到 a 原来的位置
 *    （`pa.children.splice(i, 1, ...aChildren)`），所以「把深处节点提上来」永远不会丢子树；
 *  - **折叠节点**（`keepSubtree = true`，Phase 21）：整棵子树跟着 a 走 —— a 保留自己的 children，
 *    a 的原父节点只是少了一个 a（不再把 a 的 children 提升上来）；`after` 时 b 原来的 children
 *    **追加在 a 原有 children 之后**。
 *
 * Phase 27（M1）：**允许跨工作流拖拽**。落点卡片属于哪条 workflow，被拖节点就落到那条 workflow 里
 * （`after` = 成为落点节点的子节点并接手它的 children；`before` = 成为落点节点的同级）。
 * 跨流后「a 的原父节点」与「b 的父节点」可能分属两条 workflow，`touched` / `changedNodeIds`
 * 天然跨流收集 —— 本模块不需要知道「流」这个概念，只按 `children` 改拓扑。
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

/**
 * 拖拽的可选参数（Phase 21；缺省 = Phase 15 的老语义）。
 *
 * `keepSubtree`（折叠节点整块搬运，见契约「多节点串行 / 并行插入」）：
 *  - `after`  → a 保留自己的 children，b 原来的 children **追加在 a 原有 children 之后**；
 *  - `before` → a 保留自己的 children，b 的 children 不动；
 *  - a 的原父节点只「少了一个 a」，**不再**把 a 的 children 提升上来。
 *
 * 视图在 `dragstart` 时按「被拖卡片当时是否折叠」拍快照后传进来 —— 拖拽中途展开 / 收起子树不影响本次结果。
 */
export interface MoveNodeOptions {
  keepSubtree?: boolean;
}

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
 * 把 `movingId` 拖到 `targetId` 的上 / 下半部分（契约 §① / ② + Phase 21 拖拽规则）。
 *
 * 护栏（任一不过 → `ok=false` + 原因，文档一字不动）：
 *  1. a / b 都存在、`a !== b`；
 *  2. a 非根（根节点没有父节点，拖不动）；
 *  3. **跨工作流允许**（Phase 27 M1：删除了 Phase 15 的「不能跨工作流调整节点顺序」闸门）；
 *  4. `before` 时 b 必须非根（根没有同级）→ 即「拖进某条流」只能落在 root 卡片的下半部分；
 *  5. **父子位置置换一律拒绝**（两个方向 × 两种落点）：`pb === a`（a 是 b 的父节点）或
 *     `pa === b`（b 是 a 的父节点）。Phase 21 改动 —— 旧规则只挡「a 是 b 的祖先」，
 *     而 a 的 children 会先被提升，实际挡不住成环；反过来「把 a 拖到它父节点的上半部分」
 *     会让 `a.children` 里出现 a 自己（下标 -1 的 splice），旧实现确实能写出环。
 *     相邻兄弟互换**不禁**（「前后节点不能互换位置」只针对父子）。
 *  6. `keepSubtree` 且 a 是 b 的祖先 → 拒绝（Phase 21：折叠节点的子树不会先被拆散，
 *     拖进自己的子孙会真的成环）。非折叠节点仍允许「把深处节点提到祖先旁边」（children 先摊平）。
 */
export function moveNode(
  document: WfJsonDocument,
  movingId: string,
  targetId: string,
  position: ReorderPosition,
  now: Date = new Date(),
  options: MoveNodeOptions = {},
): NodeReorderResult {
  const keepSubtree = options.keepSubtree === true;
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
  if (position === "before" && pb === undefined) {
    return reject("根节点没有同级节点：请拖到它的下半部分");
  }
  if (pb === a || pa === b) {
    return reject(`不能将子节点与父节点位置置换（「${a.title}」与「${b.title}」是父子关系）`);
  }
  if (keepSubtree && targetVisit.path.some((visitNode) => visitNode.id === movingId)) {
    return reject(`折叠节点不能拖进自己的子树（「${b.title}」在「${a.title}」下面）`);
  }

  const before = JSON.stringify(document);

  // 1) 摘 a：
  //    普通节点 → 把 a 的 children 提升到 a 原来的位置（先展开，再清空 a —— 否则子节点会在树上出现两次）；
  //    折叠节点（keepSubtree）→ 子树整块跟着 a 走，父节点只是少了一个 a。
  const aChildren = childrenOf(a);
  const paChildren = childrenOf(pa);
  const aIndex = paChildren.indexOf(a);
  if (aIndex < 0) return reject(`节点 ${movingId} 不在它的父节点里（数据结构异常，未做改动）`);
  // 防御：before 的落点父节点必须真的持有 b（这一步在**任何改动之前**做，保证 ok=false 时文档一字不动）
  if (position === "before" && childrenOf(pb as WfNode).indexOf(b) < 0) {
    return reject(`节点 ${targetId} 不在它的父节点里（数据结构异常，未做改动）`);
  }
  if (keepSubtree) {
    paChildren.splice(aIndex, 1);
  } else {
    paChildren.splice(aIndex, 1, ...aChildren);
    a.children = [];
  }

  // 2) 重挂
  if (position === "after") {
    // 顺序不能反：先把 b 的原 children 交给 a，再把 a 挂成 b 的唯一子节点
    const bChildren = childrenOf(b);
    // Phase 21：折叠节点保留自己的 children，b 的 children 追加在后面（a 的在先、b 的在后）
    a.children = keepSubtree ? [...aChildren, ...bChildren] : bChildren;
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
