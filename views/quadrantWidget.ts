/**
 * 4 象限节点小工具（Phase 19 M2；契约见
 * doc/datacontact/data_ixd_discuss_interact_v0.19.md §M2）。
 *
 * 两块内容（都在 📊 那样的弹窗里，只读）：
 *  - **左侧**：`importance × urgency` 的 16 分区斜俯视图（视线方向约 (-1,-1,3)，
 *    只画 x-y 平面、不画 z 轴；透视 / 旋转全部在 styles.css 的 `.wf-quad-*` 里）；
 *  - **右侧**：点分区后按 `startAt` 正序列出该分区节点，每节点三行
 *    （节点名 / 所属工作流 / 开始距今 + 已记录）。
 *
 * 边界：
 *  - 数据只来自 `quadrantStats()`（引擎纯函数），本文件**不读盘、不写盘**；
 *  - 只挂 class、只建文本元素，不写内联样式（契约「样式只写 styles.css」）；
 *  - 选中态是本次渲染的局部状态：弹窗重画（数据变了 / 换了主题）后回到「未选中」，
 *    与契约「刚打开小工具时无显示内容」一致。
 */

import {
  formatWorkDuration,
  quadrantStats,
  t,
  type QuadrantPartition,
  type WfJsonDocument,
} from "../src/engine/index.ts";

/** 分区标题 / tooltip 共用：`重要 4 · 紧急 3 · 2 个任务` */
function partitionLabel(partition: QuadrantPartition): string {
  return t("widget.quadrant.partition", {
    importance: partition.importance,
    urgency: partition.urgency,
    count: partition.nodes.length,
  });
}

/** 分区 class：象限色 + 空分区（虚线）/ 填充档位（1-5） */
function partitionClasses(partition: QuadrantPartition): string {
  const classes = ["wf-quad-partition", `wf-quad-partition--${partition.quadrant}`];
  if (partition.nodes.length === 0) classes.push("wf-quad-partition--empty");
  else classes.push(`wf-quad-partition--f${partition.fillLevel}`);
  return classes.join(" ");
}

/** 小时数 → `XdYh`（0 也是 `0h`，不显示空串） */
function durationText(hours: number): string {
  const text = formatWorkDuration(hours);
  return text.length === 0 ? "0h" : text;
}

/**
 * 画 4 象限小工具的弹窗内容（可重复调用：局部刷新 / 整块重渲染都会清空 body 后重画）。
 *
 * @param body 弹窗内容区（`.wf-widget-popup-body`）
 * @param document 当前文件的 wfjson 文档（只读）
 * @param now 「开始距今」的对齐时刻（测试注入固定时间）
 */
export function renderQuadrant(body: HTMLElement, document: WfJsonDocument, now: Date = new Date()): void {
  const stats = quadrantStats(document, now);
  const root = body.createDiv({ cls: "wf-quad" });

  // 左侧：斜俯视平面（4×4 = 16 分区，上 = 重要 4，右 = 紧急 4）
  const stage = root.createDiv({ cls: "wf-quad-stage" });
  stage.createDiv({ cls: "wf-quad-axis wf-quad-axis--y", text: t("widget.quadrant.axisY") });
  const plane = stage.createDiv({ cls: "wf-quad-plane" });
  // 平面内的交叉长短轴（补充契约⑤b）：纯装饰 —— 箭头由 styles.css 的 ::after 画，不接事件
  plane.createDiv({ cls: "wf-quad-axis-line wf-quad-axis-line--x" });
  plane.createDiv({ cls: "wf-quad-axis-line wf-quad-axis-line--y" });
  stage.createDiv({ cls: "wf-quad-axis wf-quad-axis--x", text: t("widget.quadrant.axisX") });

  // 右侧：预览（标题 + 列表；未选中时给一行空提示）
  const preview = root.createDiv({ cls: "wf-quad-preview" });
  const previewTitle = preview.createDiv({ cls: "wf-quad-preview-title" });
  const previewList = preview.createDiv({ cls: "wf-quad-list" });

  /** 当前选中格（只在本函数闭包里活着） */
  let selected: HTMLElement | undefined;

  const showPlaceholder = (text: string): void => {
    previewTitle.setText("");
    previewList.empty();
    previewList.createDiv({ cls: "wf-quad-empty", text });
  };

  const select = (partition: QuadrantPartition, cell: HTMLElement): void => {
    if (selected !== undefined) selected.removeClass("wf-quad-partition--selected");
    selected = cell;
    cell.addClass("wf-quad-partition--selected");
    previewTitle.setText(partitionLabel(partition));
    previewList.empty();
    if (partition.nodes.length === 0) {
      previewList.createDiv({ cls: "wf-quad-empty", text: t("widget.quadrant.noNodes") });
      return;
    }
    for (const node of partition.nodes) {
      const item = previewList.createDiv({ cls: "wf-quad-node" });
      item.createDiv({ cls: "wf-quad-node-title", text: node.title });
      item.createDiv({
        cls: "wf-quad-node-workflow",
        text: t("widget.quadrant.workflow", { title: node.workflowTitle }),
      });
      item.createDiv({
        cls: "wf-quad-node-time",
        text: t("widget.quadrant.time", {
          since: durationText(node.startHours),
          recorded: durationText(node.recordedHours),
        }),
      });
    }
  };

  for (const partition of stats.partitions) {
    const cell = plane.createDiv({ cls: partitionClasses(partition) });
    const label = partitionLabel(partition);
    cell.title = label;
    cell.setAttribute("aria-label", label);
    if (partition.nodes.length > 0) {
      cell.createEl("span", { cls: "wf-quad-count", text: String(partition.nodes.length) });
    }
    cell.onclick = () => select(partition, cell);
  }

  showPlaceholder(t("widget.quadrant.empty"));
}
