/**
 * 365 天 plot 小工具（Phase 19 M3；契约见 doc/datacontact/data_ixd_discuss_interact_v0.19.md §M3）。
 *
 * 三栏内容（侧边栏 📈 弹窗里，可写 —— 但**只碰 `plotFolder/`**，补充契约⑥b）：
 *  - **左栏**：plot 列表 + 工具条（新建 / 导入 CSV / 导出 CSV / 删除）+ 新建表单；
 *  - **中栏**：选中 plot 的标题 + SVG 折线（`computeScale` + `projectValue` 换算坐标）；
 *  - **右栏**：点搜索框 + 数据点表（逐个删）+ 一行「添加点」输入。
 *
 * 存储（契约 §M3「方案 A」）：一个 plot = `plotFolder/plot-<uuid>.json`
 * （**文件名用 id**，改 name 不动文件），导出 CSV = 同目录 `plot-<uuid>.csv`。
 *
 * 边界：
 *  - 与 wfjson 无关（schema 仍 1.9）：写盘只走 vault 的 `create / modify / delete`，
 *    不走 `mutateFile`；本文件也不读当前笔记；
 *  - 样式全在 styles.css 的 `.wf-plot-*`，视图只挂 class + 写 SVG 坐标属性；
 *  - 列表 / 选中态 / 新建表单都是本次渲染的局部状态：**打开即选中第一张**（补充契约⑥a），
 *    写完盘保持当前选中，只有空目录才显示「从左侧选一个 plot」。
 */

import type { App } from "obsidian";

import {
  PLOT_KIND_DEFAULT,
  PLOT_KINDS,
  computeScale,
  formatLocalDate,
  fromCsv,
  isPlotId,
  newPlotId,
  normalizePlotFolder,
  parsePlotSearch,
  parsePlotX,
  parsePlotY,
  plotCsvPath,
  plotPath,
  plotToJson,
  plotXInRange,
  projectValue,
  sortPoints,
  t,
  toCsv,
  validatePlot,
  type PlotDocument,
  type PlotPoint,
  type PlotScale,
  type PlotSearch,
  type PlotValidation,
} from "../src/engine/index.ts";

/* ------------------------------------------------------------------ *
 * 宿主契约（`WfViewHost` 结构性满足它；单测里给最小替身）
 * ------------------------------------------------------------------ */

/** 这个模块要用到的宿主能力（视图那边传 `ctx.host` + `ctx.refresh`） */
export interface PlotHost {
  app: App;
  /** plot JSON / CSV 的目录（插件设置 `plotFolder`，默认 `plots`） */
  plotFolder(): string;
  /** 失败提示（插件侧实现为 Notice） */
  notify(message: string): void;
}

/* ------------------------------------------------------------------ *
 * SVG 画布常量（尺寸由 styles.css 的 `.wf-plot-svg` 决定，这里只算坐标）
 * ------------------------------------------------------------------ */

export const PLOT_VIEW_WIDTH = 640;
export const PLOT_VIEW_HEIGHT = 300;

/** 绘图区内边距（左留给 y 轴刻度，下留给 x 轴标签） */
const PLOT_PAD_TOP = 18;
const PLOT_PAD_RIGHT = 16;
const PLOT_PAD_BOTTOM = 26;
const PLOT_PAD_LEFT = 44;

const SVG_NS = "http://www.w3.org/2000/svg";

/* ------------------------------------------------------------------ *
 * 纯函数（可单测）：点的增删合并 / 文案
 * ------------------------------------------------------------------ */

/** 列表里的一行（`file` = vault 里的句柄，测试里是普通对象） */
export interface PlotFileInfo {
  /** `plot-<uuid>.json` */
  path: string;
  /** 文件名里的 id */
  id: string;
  /** 真实环境是 TFile */
  file: unknown;
}

/** 类型文案（列表 / 表单共用） */
export function kindLabel(kind: PlotDocument["kind"]): string {
  return t(`widget.plot.kind.${kind}`);
}

/** x 的输入提示（如 2026-01-01 / 1、2、3） */
export function kindHint(kind: PlotDocument["kind"]): string {
  return t(`widget.plot.kind.${kind}Hint`);
}

/** 显示名：没填 name 的 plot 用「（未命名）」 */
export function plotLabel(plot: PlotDocument): string {
  return plot.name.length > 0 ? plot.name : t("common.untitled");
}

/** 列表 / 标题下的副标题：`日期 · kg · 3 个点` */
export function plotMeta(plot: PlotDocument): string {
  const params = { kind: kindLabel(plot.kind), unit: plot.unit, count: plot.points.length };
  return plot.unit.length > 0 ? t("widget.plot.metaUnit", params) : t("widget.plot.meta", params);
}

/** y 的展示（有单位就带上） */
function valueLabel(plot: PlotDocument, y: number): string {
  return plot.unit.length > 0 ? `${y} ${plot.unit}` : String(y);
}

/**
 * 加一个点：同 x 的点**覆盖**原值（一个日期只留一个值，与 CSV 导入同一口径）。
 * 返回新 plot（不改入参）+ 是否发生了覆盖。
 */
export function withPoint(plot: PlotDocument, point: PlotPoint): { plot: PlotDocument; replaced: boolean } {
  const index = plot.points.findIndex((item) => String(item.x) === String(point.x));
  if (index < 0) {
    return { plot: { ...plot, points: sortPoints(plot.kind, [...plot.points, point]) }, replaced: false };
  }
  const points = plot.points.slice();
  points[index] = point;
  return { plot: { ...plot, points: sortPoints(plot.kind, points) }, replaced: true };
}

/** 删一个点（按 x + y 精确匹配；找不到就原样返回） */
export function withoutPoint(plot: PlotDocument, point: PlotPoint): PlotDocument {
  const index = plot.points.findIndex((item) => String(item.x) === String(point.x) && item.y === point.y);
  if (index < 0) return plot;
  const points = plot.points.slice();
  points.splice(index, 1);
  return { ...plot, points };
}

/** 导入结果（视图据此拼「导入 n 个点 / 跳过 m 行」的提示） */
export interface PlotImport {
  plot: PlotDocument;
  /** CSV 里读出来的点数（去重后） */
  imported: number;
  /** 被覆盖的已有 x 的个数 */
  replaced: number;
  /** 逐行错误（行号 + 代码） */
  errors: { line: number; code: string }[];
}

/**
 * CSV 文本 → 合并进现有 plot（纯函数，不落盘）。
 * 同一 x 以 CSV 为准（覆盖原值），其余原点保留。
 */
export function mergeCsv(plot: PlotDocument, text: string): PlotImport {
  const parsed = fromCsv(plot.kind, text);
  let next = plot;
  let replaced = 0;
  for (const point of parsed.points) {
    const result = withPoint(next, point);
    if (result.replaced) replaced += 1;
    next = result.plot;
  }
  return { plot: next, imported: parsed.points.length, replaced, errors: parsed.errors };
}

/* ------------------------------------------------------------------ *
 * vault 读写（只碰 `plotFolder/`）
 * ------------------------------------------------------------------ */

/** 结构化的「文件」：真实环境是 `TFile`，单测里是普通对象 */
interface PlotFileHandle {
  path: string;
}

function asFile(value: unknown): PlotFileHandle | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const probe = value as { path?: unknown };
  return typeof probe.path === "string" ? { path: probe.path } : undefined;
}

/**
 * 取路径对应的**原始句柄**（真实环境是 `TFile`）。
 * `vault.read / modify / delete` 只认这个句柄，不能传归一化后的 `{ path }` 拷贝；
 * 不是文件（目录 / 不存在）时返回 undefined。
 */
function handleAt(host: PlotHost, path: string): unknown {
  const value = host.app.vault.getAbstractFileByPath(path);
  return asFile(value) === undefined ? undefined : value;
}

/** 目录是否存在 → 不存在就逐级建（第一次写入时才调，`onload` 不建目录） */
async function ensureFolder(host: PlotHost, folder: string): Promise<void> {
  const vault = host.app.vault;
  const segments = normalizePlotFolder(folder).split("/").filter((item) => item.length > 0);
  let prefix = "";
  for (const segment of segments) {
    prefix = prefix.length === 0 ? segment : `${prefix}/${segment}`;
    if (vault.getAbstractFileByPath(prefix) !== null) continue;
    await vault.createFolder(prefix);
  }
}

/** 目录下直接子级的 `plot-<id>.json`（嵌套子目录不读） */
export function plotFiles(host: PlotHost): PlotFileInfo[] {
  const folder = normalizePlotFolder(host.plotFolder());
  const prefix = `${folder}/`;
  const found: PlotFileInfo[] = [];
  for (const item of host.app.vault.getFiles()) {
    const file = asFile(item);
    if (file === undefined || !file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length);
    if (rest.includes("/") || !rest.endsWith(".json")) continue;
    const id = rest.slice(0, -".json".length);
    // `notes.json` 这类同目录的其它 JSON 不是 plot 文件（文件名必须是 `plot-<id>`）
    if (!isPlotId(id)) continue;
    found.push({ path: file.path, id, file: item });
  }
  found.sort((a, b) => a.id.localeCompare(b.id));
  return found;
}

/**
 * 读一个 plot 文件。文件坏了（JSON 不合法 / 缺字段）返回 `undefined`，
 * 不影响其它 plot（坏文件留在盘上，用户可以去手改）。
 */
export async function readPlot(host: PlotHost, info: PlotFileInfo): Promise<PlotValidation | undefined> {
  const handle = info.file ?? handleAt(host, info.path);
  if (asFile(handle) === undefined) return undefined;
  try {
    const text = await host.app.vault.read(handle as Parameters<typeof host.app.vault.read>[0]);
    return validatePlot(JSON.parse(text) as unknown, info.id);
  } catch {
    return undefined;
  }
}

/** 写一个 plot（存在就 `modify`，不存在就 `create`；目录顺手建好） */
export async function writePlot(host: PlotHost, plot: PlotDocument): Promise<void> {
  const folder = normalizePlotFolder(host.plotFolder());
  await ensureFolder(host, folder);
  const path = plotPath(folder, plot.id);
  const existing = handleAt(host, path);
  const json = plotToJson(plot);
  if (existing === undefined) {
    await host.app.vault.create(path, json);
    return;
  }
  await host.app.vault.modify(existing as unknown as Parameters<typeof host.app.vault.modify>[0], json);
}

/** 删一个 plot（文件不在就当已删：幂等） */
export async function removePlot(host: PlotHost, plot: PlotDocument): Promise<void> {
  const existing = handleAt(host, plotPath(host.plotFolder(), plot.id));
  if (existing === undefined) return;
  await host.app.vault.delete(existing as unknown as Parameters<typeof host.app.vault.delete>[0]);
}

/**
 * 导出 CSV 到 `<plotFolder>/plot-<id>.csv`，返回写入路径。
 * 存在就覆盖（导出是幂等的：同样的点永远得到同样的文件）。
 */
export async function exportCsv(host: PlotHost, plot: PlotDocument): Promise<string> {
  const folder = normalizePlotFolder(host.plotFolder());
  await ensureFolder(host, folder);
  const path = plotCsvPath(folder, plot.id);
  const text = toCsv(plot.kind, plot.points);
  const existing = handleAt(host, path);
  if (existing === undefined) {
    await host.app.vault.create(path, text);
  } else {
    await host.app.vault.modify(existing as unknown as Parameters<typeof host.app.vault.modify>[0], text);
  }
  return path;
}


/* ------------------------------------------------------------------ *
 * SVG 折线
 * ------------------------------------------------------------------ */

/** 建一个 SVG 元素并挂到父级（HTML 的 `createEl` 建不出 SVG 命名空间的元素） */
function svgElement(parent: Element, tag: string, attributes: Record<string, string> = {}): Element {
  const element = document.createElementNS(SVG_NS, tag);
  for (const [name, value] of Object.entries(attributes)) {
    // SVG 里没有 `cls` 这种 Obsidian 糖：`cls` 统一写成标准的 `class`
    element.setAttribute(name === "cls" ? "class" : name, value);
  }
  parent.appendChild(element);
  return element;
}

/** 刻度文案：最多 2 位小数，去掉没意义的 `.0` */
function formatNumber(value: number): string {
  return String(Math.round(value * 100) / 100);
}

/** 绘图区（折线 / 圆点 / 刻度共用同一组边界） */
export interface PlotBox {
  left: number;
  right: number;
  top: number;
  bottom: number;
}

export const PLOT_BOX: PlotBox = {
  left: PLOT_PAD_LEFT,
  right: PLOT_VIEW_WIDTH - PLOT_PAD_RIGHT,
  top: PLOT_PAD_TOP,
  bottom: PLOT_VIEW_HEIGHT - PLOT_PAD_BOTTOM,
};

/** 数据点 → 屏幕坐标（y 轴向下，所以 y 从 bottom 映射到 top） */
export function pointPixel(entry: { x: number; y: number }, scale: PlotScale): { cx: number; cy: number } {
  return {
    cx: projectValue(entry.x, scale.x, PLOT_BOX.left, PLOT_BOX.right),
    cy: projectValue(entry.y, scale.y, PLOT_BOX.bottom, PLOT_BOX.top),
  };
}

/**
 * 画折线：y 轴三档刻度（min / mid / max）+ 首末两点的 x 标签 + 折线 + 圆点。
 * 没有可用点时只画坐标框（「还没有数据点」的提示由调用方另外给）。
 */
export function renderChart(container: HTMLElement, plot: PlotDocument): void {
  const scale = computeScale(plot.kind, plot.points);
  const svg = svgElement(container, "svg", {
    cls: "wf-plot-svg",
    viewBox: `0 0 ${PLOT_VIEW_WIDTH} ${PLOT_VIEW_HEIGHT}`,
    role: "img",
    "aria-label": plotLabel(plot),
  });

  // y 轴三档刻度线 + 数值标签
  for (const value of [scale.y.min, (scale.y.min + scale.y.max) / 2, scale.y.max]) {
    const cy = projectValue(value, scale.y, PLOT_BOX.bottom, PLOT_BOX.top);
    svgElement(svg, "line", {
      cls: "wf-plot-grid",
      x1: String(PLOT_BOX.left),
      x2: String(PLOT_BOX.right),
      y1: String(cy),
      y2: String(cy),
    });
    const label = svgElement(svg, "text", {
      cls: "wf-plot-tick",
      x: String(PLOT_BOX.left - 6),
      y: String(cy + 4),
      "text-anchor": "end",
    });
    label.textContent = formatNumber(value);
  }

  // x 轴 + y 轴
  svgElement(svg, "line", {
    cls: "wf-plot-axis-line",
    x1: String(PLOT_BOX.left),
    x2: String(PLOT_BOX.right),
    y1: String(PLOT_BOX.bottom),
    y2: String(PLOT_BOX.bottom),
  });
  svgElement(svg, "line", {
    cls: "wf-plot-axis-line",
    x1: String(PLOT_BOX.left),
    x2: String(PLOT_BOX.left),
    y1: String(PLOT_BOX.top),
    y2: String(PLOT_BOX.bottom),
  });

  if (scale.entries.length === 0) return;

  const pixels = scale.entries.map((entry) => ({ entry, ...pointPixel(entry, scale) }));
  if (pixels.length > 1) {
    svgElement(svg, "polyline", {
      cls: "wf-plot-line",
      points: pixels.map((pixel) => `${pixel.cx},${pixel.cy}`).join(" "),
    });
  }
  for (const pixel of pixels) {
    svgElement(svg, "circle", {
      cls: "wf-plot-dot",
      cx: String(pixel.cx),
      cy: String(pixel.cy),
      r: "3.5",
    });
  }

  // x 标签只标首末两点（点多时挤在一起没意义）
  const first = pixels[0];
  const last = pixels[pixels.length - 1];
  for (const [pixel, anchor] of [
    [first, "start"],
    [last, "end"],
  ] as const) {
    const label = svgElement(svg, "text", {
      cls: "wf-plot-tick",
      x: String(pixel.cx),
      y: String(PLOT_BOX.bottom + 16),
      "text-anchor": anchor,
    });
    label.textContent = String(pixel.entry.point.x);
  }
}

/* ------------------------------------------------------------------ *
 * 交互：导入 CSV（导出 / 增删点各自是一两行，直接在事件里调上面的 IO）
 * ------------------------------------------------------------------ */

/**
 * CSV 文本 → 合并进 plot 并落盘（视图的「导入 CSV」与单测共用这一条）。
 *
 * 提示口径：一行都没读进来 → 只说「没有可用的点」；有点读进来 → 说「已导入 n 个点」，
 * 坏行再多也只列前 5 个行号（长提示没人看）。
 * 返回合并后的 plot；没导入任何点返回 undefined。
 */
export async function importCsvText(host: PlotHost, plot: PlotDocument, text: string): Promise<PlotDocument | undefined> {
  const merged = mergeCsv(plot, text);
  if (merged.imported === 0) {
    host.notify(t("widget.plot.importEmpty"));
    return undefined;
  }
  await writePlot(host, merged.plot);
  let message = t("widget.plot.imported", { count: merged.imported });
  if (merged.errors.length > 0) {
    const lines = merged.errors.slice(0, 5).map((item) => item.line).join(", ");
    message += ` · ${t("widget.plot.importSkipped", { count: merged.errors.length, lines })}`;
  }
  host.notify(message);
  return merged.plot;
}

/* ------------------------------------------------------------------ *
 * 视图入口
 * ------------------------------------------------------------------ */

/**
 * 画 365 天 plot 小工具的弹窗内容（可重复调用：局部刷新 / 整块重渲染都会清空 body 后重画）。
 *
 * @param body 弹窗内容区（`.wf-widget-popup-body`）
 * @param host 宿主能力（vault + `plotFolder()` + `notify()`）
 * @param refresh 与其它小工具同形的回调；**本模块不动 wfjson**，所以只是占位
 */
export function renderPlot(body: HTMLElement, host: PlotHost, refresh: () => void): void {
  void refresh;

  const root = body.createDiv({ cls: "wf-plot" });
  const sidebar = root.createDiv({ cls: "wf-plot-sidebar" });
  const toolbar = sidebar.createDiv({ cls: "wf-plot-toolbar" });
  sidebar.createDiv({ cls: "wf-plot-list-title", text: t("widget.plot.list") });
  const listEl = sidebar.createDiv({ cls: "wf-plot-list" });
  const mainEl = root.createDiv({ cls: "wf-plot-main" });

  const newButton = toolbar.createEl("button", { cls: "wf-plot-btn", text: t("widget.plot.new") });
  const importButton = toolbar.createEl("button", { cls: "wf-plot-btn", text: t("widget.plot.import") });
  const exportButton = toolbar.createEl("button", { cls: "wf-plot-btn", text: t("widget.plot.export") });
  exportButton.title = t("widget.plot.exportPath", { folder: normalizePlotFolder(host.plotFolder()) });
  const deleteButton = toolbar.createEl("button", {
    cls: "wf-plot-btn wf-plot-btn--danger",
    text: t("widget.plot.delete"),
  });
  // 隐藏的文件选择框（点「导入 CSV」时由它弹系统框；不参与布局）
  const picker = sidebar.createEl("input", { cls: "wf-plot-file" });
  picker.setAttribute("type", "file");
  picker.setAttribute("accept", ".csv,text/csv");

  /** 目录里的 plot（按 name 排序） */
  let plots: PlotDocument[] = [];
  let selectedId: string | undefined;
  let creating = false;
  /** 「删除」按第二下才真删：第一下把按钮换成「确认删除」 */
  let pendingDeleteId: string | undefined;
  let loaded = false;
  /**
   * 第三栏（搜索 + 点表 + 添加行）—— 只在选中 plot 时存在：
   * 未选中 / 新建表单时整栏移除，不留一道空的分隔线（补充契约⑥b）。
   */
  let pointsEl: HTMLElement | undefined;
  /** 点搜索框里的文本（跨 `paint()` 保留；弹窗整块重画才清空） */
  let searchText = "";

  /** 取第三栏容器（没有就建；每次重画先清空 —— 顺序自然是 sidebar / main / points） */
  const pointsColumn = (): HTMLElement => {
    if (pointsEl === undefined) pointsEl = root.createDiv({ cls: "wf-plot-points" });
    pointsEl.empty();
    return pointsEl;
  };

  /** 弹窗关掉 / 重画后，异步回填不再往旧 DOM 里写 */
  const alive = (): boolean => root.parentElement !== null;
  const selected = (): PlotDocument | undefined => plots.find((plot) => plot.id === selectedId);
  const fail = (error: unknown): void => host.notify(error instanceof Error ? error.message : String(error));

  /** 新建表单（右侧整块换成表单；保存后回到该 plot） */
  const renderCreateForm = (): void => {
    const form = mainEl.createDiv({ cls: "wf-plot-form" });
    form.createDiv({ cls: "wf-plot-form-title", text: t("widget.plot.newTitle") });

    form.createDiv({ cls: "wf-plot-form-label", text: t("widget.plot.name") });
    const nameInput = form.createEl("input", { cls: "wf-plot-input" });
    nameInput.setAttribute("placeholder", t("widget.plot.namePlaceholder"));

    form.createDiv({ cls: "wf-plot-form-label", text: t("widget.plot.kind") });
    const kinds = form.createDiv({ cls: "wf-plot-kinds" });
    const hint = form.createDiv({ cls: "wf-plot-form-hint" });
    let kind = PLOT_KIND_DEFAULT;
    const syncKinds = (): void => {
      for (const { option, button } of kindButtons) {
        button.removeClass("wf-plot-kind--active");
        if (option === kind) button.addClass("wf-plot-kind--active");
      }
      hint.setText(kindHint(kind));
    };
    const kindButtons = PLOT_KINDS.map((option) => {
      const button = kinds.createEl("button", { cls: "wf-plot-kind", text: kindLabel(option) });
      button.onclick = () => {
        kind = option;
        syncKinds();
      };
      return { option, button };
    });
    syncKinds();

    form.createDiv({ cls: "wf-plot-form-label", text: t("widget.plot.unit") });
    const unitInput = form.createEl("input", { cls: "wf-plot-input" });
    unitInput.setAttribute("placeholder", t("widget.plot.unitPlaceholder"));

    const actions = form.createDiv({ cls: "wf-plot-form-actions" });
    const cancel = actions.createEl("button", { cls: "wf-plot-btn", text: t("common.cancel") });
    cancel.onclick = () => {
      creating = false;
      paint();
    };
    const save = actions.createEl("button", { cls: "wf-plot-btn wf-plot-btn--primary", text: t("common.save") });
    save.onclick = () => {
      void (async () => {
        save.disabled = true;
        const plot: PlotDocument = {
          id: newPlotId(),
          name: nameInput.value.trim(),
          kind,
          unit: unitInput.value.trim(),
          points: [],
        };
        try {
          await writePlot(host, plot);
          selectedId = plot.id;
          creating = false;
          host.notify(t("widget.plot.created", { name: plotLabel(plot) }));
          await load();
        } catch (error) {
          // 失败不半途落盘：提示 + 允许重试（表单不关，用户写的字不丢）
          fail(error);
          save.disabled = false;
        }
      })();
    };
  };

  /** 重画左侧列表 + 右侧内容（首帧 / 选中变化 / 写完盘都走这里） */
  const paint = (): void => {
    const plot = selected();
    // 工具条：没有选中时只有「新建」可用；删除要先按两下
    exportButton.disabled = plot === undefined;
    importButton.disabled = plot === undefined;
    deleteButton.disabled = plot === undefined;
    const armed = plot !== undefined && pendingDeleteId === plot.id;
    deleteButton.setText(armed ? t("common.confirmDelete") : t("widget.plot.delete"));
    deleteButton.removeClass("wf-plot-btn--armed");
    if (armed) deleteButton.addClass("wf-plot-btn--armed");

    listEl.empty();
    if (!loaded) {
      listEl.createDiv({ cls: "wf-plot-empty", text: t("widget.plot.loading") });
    } else if (plots.length === 0) {
      listEl.createDiv({ cls: "wf-plot-empty", text: t("widget.plot.empty") });
    } else {
      for (const item of plots) {
        const active = item.id === selectedId;
        const row = listEl.createDiv({ cls: active ? "wf-plot-item wf-plot-item--active" : "wf-plot-item" });
        row.createDiv({ cls: "wf-plot-item-name", text: plotLabel(item) });
        row.createDiv({ cls: "wf-plot-item-meta", text: plotMeta(item) });
        row.title = plotLabel(item);
        row.onclick = () => {
          selectedId = item.id;
          creating = false;
          pendingDeleteId = undefined;
          paint();
        };
      }
    }

    // 第三栏跟着选中态进退（未选中 / 新建表单里没有它）
    if (creating || plot === undefined) {
      pointsEl?.remove();
      pointsEl = undefined;
    }

    mainEl.empty();
    if (creating) {
      renderCreateForm();
      return;
    }
    if (plot === undefined) {
      mainEl.createDiv({ cls: "wf-plot-placeholder", text: t("widget.plot.unselected") });
      return;
    }

    // 标题 + 折线
    const head = mainEl.createDiv({ cls: "wf-plot-head" });
    head.createDiv({ cls: "wf-plot-title", text: plotLabel(plot) });
    head.createDiv({ cls: "wf-plot-meta", text: plotMeta(plot) });
    const chart = mainEl.createDiv({ cls: "wf-plot-chart" });
    renderChart(chart, plot);
    if (plot.points.length === 0) {
      chart.createDiv({ cls: "wf-plot-empty", text: t("widget.plot.emptyPoints") });
    }

    // 第三栏：搜索 + 数据点（按 x 正序；逐个可删）
    const points = pointsColumn();
    points.createDiv({ cls: "wf-plot-points-title", text: t("widget.plot.points", { count: plot.points.length }) });

    // 补充契约⑥c：搜索只过滤点表，SVG 始终画全部点（避免「图没变但数据像变了」）
    const searchBar = points.createDiv({ cls: "wf-plot-search" });
    const searchInput = searchBar.createEl("input", { cls: "wf-plot-input wf-plot-search-input" });
    searchInput.setAttribute("placeholder", t("widget.plot.searchPlaceholder"));
    searchInput.setAttribute("aria-label", t("widget.plot.search"));
    searchInput.value = searchText;
    const searchButton = searchBar.createEl("button", { cls: "wf-plot-btn", text: t("widget.plot.search") });
    const clearButton = searchBar.createEl("button", { cls: "wf-plot-btn", text: t("widget.plot.clearSearch") });
    const searchInfo = searchBar.createDiv({ cls: "wf-plot-search-info" });

    const rows = points.createDiv({ cls: "wf-plot-points-rows" });
    /**
     * 按当前搜索文本过滤（每次重画现算：切换 plot 后 kind 变了，旧文本按新 kind 重新解析，
     * 解析不了就当没搜索 —— 不会拿上一次 kind 的区间去筛另一类 x）。
     */
    const renderRows = (): void => {
      const parsed = parsePlotSearch(plot.kind, searchText);
      const range: PlotSearch = parsed.invalid === true ? {} : parsed;
      const all = sortPoints(plot.kind, plot.points);
      const matched = all.filter((point) => plotXInRange(plot.kind, point.x, range.min, range.max));

      rows.empty();
      for (const point of matched) {
        const row = rows.createDiv({ cls: "wf-plot-point" });
        row.createSpan({ cls: "wf-plot-point-x", text: String(point.x) });
        row.createSpan({ cls: "wf-plot-point-y", text: valueLabel(plot, point.y) });
        const remove = row.createEl("button", { cls: "wf-plot-point-remove", text: "×" });
        remove.title = t("widget.plot.removePoint");
        remove.setAttribute("aria-label", t("widget.plot.removePoint"));
        remove.onclick = () => {
          void (async () => {
            try {
              await writePlot(host, withoutPoint(plot, point));
              await load();
            } catch (error) {
              fail(error);
            }
          })();
        };
      }

      // 命中数文案：有过滤（min / max 至少一边）才显示，全量时留空
      const filtered = range.min !== undefined || range.max !== undefined;
      searchInfo.setText(
        filtered ? t("widget.plot.searchCount", { matched: matched.length, total: all.length }) : "",
      );
    };

    /** 应用搜索框：空 = 全部；非法 = 提示并**保持上一次的过滤结果** */
    const applySearch = (): void => {
      const text = (searchInput.value ?? "").trim();
      if (text.length === 0) {
        searchText = "";
        renderRows();
        return;
      }
      const parsed = parsePlotSearch(plot.kind, text);
      if (parsed.invalid === true) {
        host.notify(t("widget.plot.searchInvalid", { hint: kindHint(plot.kind) }));
        return;
      }
      searchText = text;
      renderRows();
    };

    searchButton.onclick = applySearch;
    clearButton.onclick = () => {
      searchInput.value = "";
      searchText = "";
      renderRows();
    };
    // 回车 = 点「搜索」（输入法组字期间的回车不算：isComposing）
    searchInput.addEventListener("keydown", (event: unknown) => {
      const key = event as { key?: string; isComposing?: boolean; preventDefault?: () => void };
      if (key.isComposing === true || key.key !== "Enter") return;
      key.preventDefault?.();
      applySearch();
    });
    renderRows();

    // 添加点：x / y 两个输入 + 一个按钮（格式按 kind 提示）
    const add = points.createDiv({ cls: "wf-plot-add" });
    const xInput = add.createEl("input", { cls: "wf-plot-input wf-plot-input--x" });
    xInput.setAttribute("placeholder", kindHint(plot.kind));
    // 补充契约⑥d：date 类预填今天；sequence 留空（占位符仍是格式提示）
    xInput.value = plot.kind === "date" ? formatLocalDate() : "";
    const yInput = add.createEl("input", { cls: "wf-plot-input wf-plot-input--y" });
    yInput.setAttribute("placeholder", plot.unit.length > 0 ? `y (${plot.unit})` : "y");
    const addButton = add.createEl("button", {
      cls: "wf-plot-btn wf-plot-btn--primary",
      text: t("widget.plot.addPoint"),
    });
    addButton.onclick = () => {
      void (async () => {
        const x = parsePlotX(plot.kind, xInput.value);
        if (x === undefined) {
          host.notify(t("widget.plot.invalidX", { hint: kindHint(plot.kind) }));
          return;
        }
        const y = parsePlotY(yInput.value);
        if (y === undefined) {
          host.notify(t("widget.plot.invalidY"));
          return;
        }
        const next = withPoint(plot, { x, y });
        if (next.replaced) host.notify(t("widget.plot.xyTaken"));
        try {
          await writePlot(host, next.plot);
          await load();
        } catch (error) {
          fail(error);
        }
      })();
    };
  };


  /**
   * 重扫目录（写完盘 / 首次打开都走这里）；单份文件坏了只提示，不影响其它 plot。
   *
   * 并行读：每份 plot 都是独立的 `vault.read + JSON.parse`，串行 `await` 会让首帧延迟
   * 按文件数线性累加（打开弹窗要等全部读完才 `paint`）。`Promise.all` 一次性发出去，
   * 顺序由末尾的 `sort` 决定，与读完的先后无关；坏文件仍按各自路径单独提示。
   */
  const load = async (): Promise<void> => {
    const files = plotFiles(host);
    const results = await Promise.all(files.map((info) => readPlot(host, info)));
    const next: PlotDocument[] = [];
    for (let index = 0; index < results.length; index += 1) {
      const result = results[index];
      if (result === undefined || result.plot === undefined) {
        host.notify(t("widget.plot.readFailed", { path: files[index].path }));
        continue;
      }
      next.push(result.plot);
    }
    if (!alive()) return;
    plots = next.sort((a, b) => plotLabel(a).localeCompare(plotLabel(b)) || a.id.localeCompare(b.id));
    if (selectedId !== undefined && !plots.some((plot) => plot.id === selectedId)) selectedId = undefined;
    // 补充契约⑥a：打开就有内容 —— 没选中（首帧 / 删掉当前那张）就选第一张，只有空目录才留占位
    if (selectedId === undefined && plots.length > 0) selectedId = plots[0].id;
    loaded = true;
    paint();
  };

  newButton.onclick = () => {
    creating = true;
    pendingDeleteId = undefined;
    paint();
  };

  importButton.onclick = () => {
    const plot = selected();
    if (plot === undefined) {
      host.notify(t("widget.plot.needSelection"));
      return;
    }
    (picker as unknown as { click?: () => void }).click?.();
  };

  picker.onchange = () => {
    const plot = selected();
    const files = (picker as unknown as { files?: ArrayLike<{ text?: () => Promise<string> }> }).files;
    if (plot === undefined || files === undefined || files.length === 0) return;
    const file = files[0];
    void (async () => {
      if (typeof file.text !== "function") return;
      try {
        const text = await file.text();
        await importCsvText(host, plot, text);
        await load();
      } catch (error) {
        fail(error);
      }
    })();
  };

  exportButton.onclick = () => {
    const plot = selected();
    if (plot === undefined) return;
    void (async () => {
      try {
        const path = await exportCsv(host, plot);
        host.notify(t("widget.plot.exported", { path }));
      } catch (error) {
        fail(error);
      }
    })();
  };

  deleteButton.onclick = () => {
    const plot = selected();
    if (plot === undefined) return;
    // 第一下只是「确认」：按钮换成「确认删除」，再点才真删（不弹 Modal，与其它小工具一致）
    if (pendingDeleteId !== plot.id) {
      pendingDeleteId = plot.id;
      paint();
      return;
    }
    pendingDeleteId = undefined;
    selectedId = undefined;
    void (async () => {
      try {
        await removePlot(host, plot);
        host.notify(t("widget.plot.deleted", { name: plotLabel(plot) }));
        await load();
      } catch (error) {
        fail(error);
      }
    })();
  };

  void load();
}

