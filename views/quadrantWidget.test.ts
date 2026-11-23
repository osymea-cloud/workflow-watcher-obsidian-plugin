/**
 * `views/quadrantWidget.ts` 单测（Phase 19 M2）：16 分区结构 / 象限配色 /
 * 空分区虚线 / 点分区 → 右侧预览三行文案 / 重画后回到未选中。
 *
 * 纯 Node：DOM 用 `views/testDomStub.ts` 桩，数据走引擎真实的 `quadrantStats()`
 * （这里只断言视图把引擎算好的东西**摆对了**，时间口径本身在 `src/engine/quadrant.test.ts`）。
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, test } from "node:test";

import { setLang, type WfJsonDocument, type WfNode } from "../src/engine/index.ts";
import { leaf } from "../src/engine/testFixtures.ts";
import { renderQuadrant } from "./quadrantWidget.ts";
import { asHtmlElement, installDomStub, StubElement, type StubMouseEvent } from "./testDomStub.ts";

const body = installDomStub();
setLang("zh");

/** 固定「现在」：2026-10-10 12:00（+08:00） */
const NOW = new Date("2026-10-10T12:00:00+08:00");

function clickEvent(): StubMouseEvent {
  return { preventDefault: () => undefined, stopPropagation: () => undefined, clientX: 0, clientY: 0 };
}

function documentWith(...roots: WfNode[]): WfJsonDocument {
  return {
    schemaVersion: "1.9",
    id: "file-quadrant-view",
    updatedAt: "2026-10-10T12:00:00+08:00",
    workflows: roots.map((root, index) => ({
      id: `wf-view-${index + 1}`,
      title: `工作流 ${index + 1}`,
      root,
    })),
  };
}

/** `leaf()` 默认 todo + children: []；这里只补两轴与额外字段 */
function node(
  id: string,
  title: string,
  importance: number | undefined,
  urgency: number | undefined,
  extra: Partial<WfNode> = {},
): WfNode {
  const options: Partial<WfNode> = { ...extra };
  if (importance !== undefined) options.importance = importance;
  if (urgency !== undefined) options.urgency = urgency;
  return leaf(id, title, options);
}

/** 每次重画都清空 host（wfView 的 `body.empty()` 语义） */
function render(document: WfJsonDocument): StubElement {
  body.empty();
  const host = body.createDiv();
  renderQuadrant(asHtmlElement(host), document, NOW);
  return host;
}

/** 16 分区的顺序 = importance 4→1（外）× urgency 1→4（内） */
function cellOf(host: StubElement, urgency: number, importance: number): StubElement {
  const cells = host.query(".wf-quad-partition");
  assert.equal(cells.length, 16, "恒为 16 个分区");
  const cell = cells[(4 - importance) * 4 + (urgency - 1)];
  assert.ok(cell, `应有 urgency=${urgency} / importance=${importance} 的格子`);
  return cell;
}

describe("quadrantWidget · 结构", () => {
  test("左侧 16 分区 + 两条坐标轴 + 平面内两条轴线；右侧预览初始只有一行提示", () => {
    const host = render(documentWith(node("nd-1", "唯一的任务", 2, 3)));
    assert.equal(host.query(".wf-quad").length, 1);
    assert.equal(host.query(".wf-quad-plane").length, 1);
    assert.equal(host.query(".wf-quad-partition").length, 16);
    // 补充契约⑤b：平面内的交叉长短轴（纯装饰，两个空 div，文案仍在平面外）
    assert.equal(host.query(".wf-quad-axis-line").length, 2, "x / y 各一条");
    assert.equal(host.query(".wf-quad-axis-line--x").length, 1);
    assert.equal(host.query(".wf-quad-axis-line--y").length, 1);
    assert.equal(host.query(".wf-quad-axis-line--x")[0].text, "", "轴线不带文案");
    assert.deepEqual(
      host.query(".wf-quad-axis").map((item) => item.text),
      ["重要程度 ↑", "紧急程度 →"],
      "y 轴在上、x 轴在右下",
    );
    const empty = host.query(".wf-quad-empty");
    assert.equal(empty.length, 1);
    assert.equal(empty[0].text, "点击左侧任一分区查看任务");
    assert.equal(host.query(".wf-quad-node").length, 0, "未选中时没有节点列表");
    assert.equal(host.query(".wf-quad-preview-title")[0].text, "");
  });
});

describe("quadrantWidget · 象限配色 / 空分区 / 填充档位", () => {
  test("四角配色按契约表格；空分区虚线、不显示「0」", () => {
    const host = render(documentWith(node("nd-root", "重要且紧急", 4, 4)));

    const topRight = cellOf(host, 4, 4);
    assert.ok(topRight.classList.contains("wf-quad-partition--red"), "右上 = 重要且紧急 = 红");
    assert.ok(topRight.classList.contains("wf-quad-partition--f1"), "1 个任务 = 第 1 档");
    assert.ok(!topRight.classList.contains("wf-quad-partition--empty"));
    assert.equal(topRight.query(".wf-quad-count")[0].text, "1", "非空分区显示任务数");
    assert.equal(topRight.title, "重要 4 · 紧急 4 · 1 个任务");
    assert.equal(topRight.getAttribute("aria-label"), topRight.title, "aria-label 与 tooltip 同文案");

    const topLeft = cellOf(host, 1, 4);
    assert.ok(topLeft.classList.contains("wf-quad-partition--orange"), "左上 = 重要不紧急 = 橙");
    assert.ok(topLeft.classList.contains("wf-quad-partition--empty"), "空分区挂虚线类");
    assert.equal(topLeft.query(".wf-quad-count").length, 0);
    assert.equal(topLeft.title, "重要 4 · 紧急 1 · 0 个任务");

    assert.ok(cellOf(host, 1, 1).classList.contains("wf-quad-partition--green"), "左下 = 绿");
    assert.ok(cellOf(host, 4, 1).classList.contains("wf-quad-partition--blue"), "右下 = 蓝");
  });

  test("填充档位：1~4 个任务各一档，5 个及以上封顶 --f5", () => {
    const children = Array.from({ length: 6 }, (_, index) => node(`nd-${index}`, `任务 ${index}`, 4, 4));
    const host = render(documentWith(node("nd-root", "根", 4, 4, { children })));
    const cell = cellOf(host, 4, 4);
    assert.ok(cell.classList.contains("wf-quad-partition--f5"), "7 个任务也只在第 5 档");
    assert.equal(cell.query(".wf-quad-count")[0].text, "7");
  });
});

describe("quadrantWidget · 点分区 → 右侧预览", () => {
  test("有任务的分区：标题 + 每节点三行（名 / 工作流 / 开始距今 + 已记录），并挂选中类", () => {
    const host = render(
      documentWith(
        node("nd-root", "根", 4, 4, {
          startAt: "2026-10-07T09:00:00+08:00",
          timeEntries: [
            { startAt: "2026-10-08T09:00:00+08:00", date: "2026-10-08", endAt: "2026-10-08T11:00:00+08:00", hours: 2 },
          ],
        }),
      ),
    );

    const cell = cellOf(host, 4, 4);
    cell.onclick?.(clickEvent());

    assert.ok(cell.classList.contains("wf-quad-partition--selected"), "选中态挂在分区上");
    assert.equal(host.query(".wf-quad-preview-title")[0].text, "重要 4 · 紧急 4 · 1 个任务");
    assert.equal(host.query(".wf-quad-empty").length, 0, "有内容时不再显示提示行");

    const item = host.query(".wf-quad-node")[0];
    assert.ok(item, "应渲染一个节点");
    assert.equal(item.query(".wf-quad-node-title")[0].text, "根");
    assert.equal(item.query(".wf-quad-node-workflow")[0].text, "所属工作流：工作流 1");
    assert.equal(item.query(".wf-quad-node-time")[0].text, "开始距今：3d3h 已记录：2h");
  });

  test("多个任务按 startAt 正序；点另一个分区会取消上一个的选中", () => {
    const host = render(
      documentWith(
        node("nd-root", "根", 4, 4, {
          children: [
            node("nd-late", "后开始", 4, 4, { startAt: "2026-10-09T08:00:00+08:00" }),
            node("nd-early", "先开始", 4, 4, { startAt: "2026-10-07T08:00:00+08:00" }),
            node("nd-blue", "另一个象限", 1, 4),
          ],
        }),
      ),
    );

    const red = cellOf(host, 4, 4);
    red.onclick?.(clickEvent());
    assert.deepEqual(
      host.query(".wf-quad-node-title").map((item) => item.text),
      ["先开始", "后开始", "根"],
      "有开始时间的正序在前，没开始的在最后",
    );

    const blue = cellOf(host, 4, 1);
    blue.onclick?.(clickEvent());
    assert.ok(blue.classList.contains("wf-quad-partition--selected"));
    assert.ok(!red.classList.contains("wf-quad-partition--selected"), "上一个分区要取消选中");
    assert.equal(host.query(".wf-quad-preview-title")[0].text, "重要 1 · 紧急 4 · 1 个任务");
    assert.deepEqual(
      host.query(".wf-quad-node-title").map((item) => item.text),
      ["另一个象限"],
      "列表整体换成新分区的节点",
    );
  });

  test("空分区：标题照旧显示「0 个任务」，列表位置给一行「该分区暂无任务」", () => {
    const host = render(documentWith(node("nd-root", "根", 4, 4)));
    const cell = cellOf(host, 1, 1);
    cell.onclick?.(clickEvent());

    assert.equal(host.query(".wf-quad-preview-title")[0].text, "重要 1 · 紧急 1 · 0 个任务");
    const empty = host.query(".wf-quad-empty");
    assert.equal(empty.length, 1);
    assert.equal(empty[0].text, "该分区暂无任务");
    assert.equal(host.query(".wf-quad-node").length, 0);
  });

  test("重画（清空后重新 render）回到未选中：没有选中类，预览回到提示行", () => {
    const document = documentWith(node("nd-root", "根", 4, 4));
    const first = render(document);
    cellOf(first, 4, 4).onclick?.(clickEvent());
    assert.equal(first.query(".wf-quad-node").length, 1);

    const second = render(document);
    assert.equal(second.query(".wf-quad-partition--selected").length, 0);
    assert.equal(second.query(".wf-quad-node").length, 0);
    assert.equal(second.query(".wf-quad-empty")[0].text, "点击左侧任一分区查看任务");
  });
});

describe("quadrantWidget · Phase 21 第 5 档斜纹（styles.css 静态断言）", () => {
  /** 取某条规则的声明块（注释里也会提到这些选择器，先剥掉注释再找） */
  const blockOf = (selector: string): string => {
    const css = readFileSync(new URL("../styles.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const start = css.indexOf(`${selector} {`);
    assert.notEqual(start, -1, `styles.css 缺少「${selector}」`);
    return css.slice(start, css.indexOf("}", start));
  };

  test("5 个及以上任务的档位再叠一层与描边同色的斜纹（4 / 5 档肉眼可分）", () => {
    const block = blockOf(".wf-quad-partition--f5::after");
    assert.match(block, /repeating-linear-gradient\(\s*45deg/, "斜纹用 45° 重复渐变");
    assert.match(
      block,
      /rgb\(var\(--wf-quad-rgb\) \/ 0\.\d+\)/,
      "斜纹颜色取该象限的描边色（--wf-quad-rgb），不引入新变量",
    );
    assert.match(block, /inset:\s*0/, "铺满分区");
    assert.match(block, /border-radius:\s*inherit/, "跟着分区的圆角（描边内侧不露直角）");
    assert.match(block, /pointer-events:\s*none/, "纯装饰：分区照样可点");
  });

  test("斜纹不遮数字：.wf-quad-count 用 z-index 压在上面", () => {
    const block = blockOf(".wf-quad-count");
    assert.match(block, /position:\s*relative/, "先建立层叠上下文");
    assert.match(block, /z-index:\s*1/, "数字在斜纹之上");
  });
});
