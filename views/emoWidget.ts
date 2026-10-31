/**
 * 365 天 emo 小工具（Phase 18 ④ 起；Phase 19 M1 重构；契约见
 * doc/datacontact/data_ixd_discuss_interact_v0.19.md）。
 *
 * 四块职责都在这一个文件里：
 *  - **画布**（§③）：左侧 🙂 弹窗铺满整个界面，20×20 螺旋网格可拖拽平移 /
 *    `Ctrl + wheel` 缩放（10%~600%）/ 双击复位；
 *  - **主题**（§①）：`default / weave / candy` 三套独立配色，画布上方
 *    「灵动岛」按钮循环切换（只换根元素 class + 落盘，**不重渲染**）；
 *  - **拍立得**（§⑥）：右键「打开」看只读概览，「编辑」在拍立得构图上编辑图片 / 文字；
 *  - **存储**（§⑧）：见闻写进 `dailyFolder/YYYY-MM-DD.md`，图片写 `YYYY-MM-DD.<ext>`。
 *
 * 为什么单独一个文件：这一块是唯一「不随插件主题、自有配色、还要读写 vault」的小工具。
 * 放进 `views/wfView.ts` 会把那个文件顶到 3000 行；这里的对外面只有：
 * `renderEmo365()` / `closeEmoFloats()` / `openPolaroid()` / `openEditor()` / `saveDailyRecord()`。
 *
 * 边界：图片以外的多媒体既不预览也不存储；样式全部写在 styles.css 的 `.wf-emo-*` /
 * `.wf-widget-popup--emo` 里，不进 `[data-wf-theme]`；格子的颜色 / 角度由日期派生
 * （`emoColorIndex` / `emoAngleIndex`），md 里只存「一句话 + 一张图」。
 */

import type { App, TAbstractFile } from "obsidian";

import {
  EMO_THEMES,
  emoAngleIndex,
  emoColorIndex,
  formatLocalDate,
  normalizeEmoTheme,
  spiralDates,
  t,
  type EmoTheme,
} from "../src/engine/index.ts";

/* ------------------------------------------------------------------ *
 * 宿主契约（`WfViewHost` 结构性满足它；单测里给最小替身）
 * ------------------------------------------------------------------ */

/** 这个模块要用到的宿主能力（视图那边传 `ctx.host` + `ctx.refresh`） */
export interface EmoHost {
  app: App;
  /** 见闻 md 的目录（插件设置 `dailyFolder`，默认 `daily`） */
  dailyFolder(): string;
  /** 失败提示（插件侧实现为 Notice） */
  notify(message: string): void;
  /** Phase 19 M1 ①：emo 独立主题（`default / weave / candy`） */
  emoTheme(): string;
  /** Phase 19 M1 ①：灵动岛切换主题后落盘（视图只换 class，不重渲染） */
  setEmoTheme(theme: string): Promise<void>;
}

/** 一天的记录（读出来的形态；`image` 只在 md 里真有图片链接时出现） */
export interface EmoRecord {
  date: string;
  /** 一句话（md 正文里第一段非图片文字；没有就是空串） */
  sentence: string;
  /** 图片：文件名 + 可直接塞进 `<img src>` 的资源路径 */
  image?: { name: string; url: string };
}

/** 待写入的图片（`bytes` 原样落盘；`ext` 缺省 `png`） */
export interface EmoImage {
  bytes: ArrayBuffer;
  ext?: string;
}

/* ------------------------------------------------------------------ *
 * 常量（与 styles.css 的 `.wf-emo-*` 对齐）
 * ------------------------------------------------------------------ */

/** 单格边长（px）：必须与 styles.css 的 `--wf-emo-cell` 默认值一致（算内容尺寸用） */
export const EMO_CELL_PX = 18;

/** 网格边长（20 × 20 —— 中心 6×6 是今日见闻，其余 364 格各管一天） */
export const EMO_GRID = 20;

/** 缩放上下限与步长（Phase 19 M1 ④ + 补充契约①：`0.1 ~ 8` = 10%~800%，每次 ×1.1） */
export const EMO_ZOOM_MIN = 0.1;
export const EMO_ZOOM_MAX = 8;

/** 打开小工具时的固定缩放（补充契约①：首帧就是 600%，随后居中 —— 不再按视口自适应） */
export const EMO_ZOOM_START = 6;
const EMO_ZOOM_STEP = 1.1;

/** 一句话最多 200 字（输入框 `maxlength` 与保存前截断同一口径） */
export const EMO_SENTENCE_MAX = 200;

/* ------------------------------------------------------------------ *
 * 纯函数（可单测）：夹取平移 / 缩放步进 / 百分比文案 / md 正文
 * ------------------------------------------------------------------ */

export interface EmoSize {
  width: number;
  height: number;
}

export interface EmoPan {
  x: number;
  y: number;
}

/**
 * 平移夹取（§B）：内容比视口大 → 内容矩形始终**覆盖**视口（`x ∈ [vw − cw, 0]`）；
 * 内容比视口小 → 居中。视口还没量出来（0 / 非有限）时归零，避免首帧写出荒唐数字。
 */
export function clampPan(viewport: EmoSize, content: EmoSize, pan: EmoPan): EmoPan {
  const axis = (view: number, size: number, value: number): number => {
    if (!Number.isFinite(view) || !Number.isFinite(size) || view <= 0 || size <= 0) return 0;
    if (size <= view) return (view - size) / 2;
    const limit = view - size;
    const safe = Number.isFinite(value) ? value : 0;
    return Math.min(0, Math.max(limit, safe));
  };
  return { x: axis(viewport.width, content.width, pan.x), y: axis(viewport.height, content.height, pan.y) };
}

/** 缩放步进（`direction > 0` = 放大）；夹在 0.1~8（10%~800%），保留 2 位小数避免浮点尾巴 */
export function zoomStep(scale: number, direction: number): number {
  const base = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const next = direction > 0 ? base * EMO_ZOOM_STEP : base / EMO_ZOOM_STEP;
  const clamped = Math.min(EMO_ZOOM_MAX, Math.max(EMO_ZOOM_MIN, next));
  return Math.round(clamped * 100) / 100;
}

/** 右下角的百分比文案（`100%` / `121%`） */
export function zoomLabel(scale: number): string {
  return `${Math.round(scale * 100)}%`;
}

/** 去掉 frontmatter 块（`---` … `---`）；没有就是原样返回 */
function stripFrontmatter(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return text;
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") return lines.slice(index + 1).join("\n");
  }
  return text;
}

/** 取出 frontmatter 那段原文（含首尾 `---`）；没有就是空串 —— 就地替换正文时要原样留住 */
function frontmatterOf(text: string): string {
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return "";
  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index].trim() === "---") return lines.slice(0, index + 1).join("\n");
  }
  return "";
}

/**
 * 解析一天的 md：图片链接（`![[…]]`）+ 一句话（第一段非图片文字）。
 * 跳过 frontmatter / 标题行；图片按「第一张」算（一天只放一张）。
 */
export function parseDailyNote(text: string): { sentence: string; imageName?: string } {
  const body = stripFrontmatter(text);
  let imageName: string | undefined;
  const lines: string[] = [];
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const image = /^!\[\[([^\]|]+)(?:\|[^\]]*)?\]\]$/.exec(line);
    if (image !== null) {
      imageName ??= image[1].trim();
      continue;
    }
    if (line.startsWith("#")) continue;
    lines.push(line);
  }
  return imageName === undefined ? { sentence: lines[0] ?? "" } : { sentence: lines[0] ?? "", imageName };
}

/** md 正文：一句话 + 空行 + `![[日期.png]]`（两段都空 → 空串） */
export function buildDailyBody(sentence: string, imageName?: string): string {
  const parts: string[] = [];
  const text = sentence.trim();
  if (text.length > 0) parts.push(text);
  if (imageName !== undefined && imageName.length > 0) parts.push(`![[${imageName}]]`);
  return parts.length === 0 ? "" : `${parts.join("\n\n")}\n`;
}

/** 就地替换正文但保留旧 frontmatter（§E-3） */
export function mergeDailyBody(oldText: string, body: string): string {
  const front = frontmatterOf(oldText);
  return front.length === 0 ? body : `${front}\n${body}`;
}

/* ------------------------------------------------------------------ *
 * 存储（§E）：目录 / 图片 / md 三件套
 *
 * 只用 vault 的公开方法（`getFiles` / `create` / `modify` / `read` / `createBinary` /
 * `modifyBinary` / `createFolder` / `delete`）。单测给的是同形状的假 vault，
 * 因此这里做**鸭子判断**（`path` + `extension`），不 `instanceof TFile`。
 * ------------------------------------------------------------------ */

/** 结构化的「文件」：真实环境是 `TFile`，单测里是普通对象 */
interface EmoFile {
  path: string;
  extension?: string;
}

function asFile(value: unknown): EmoFile | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const probe = value as { path?: unknown; extension?: unknown };
  return typeof probe.path === "string" ? { path: probe.path, extension: probe.extension as string | undefined } : undefined;
}

/** 目录归一化（与插件侧 `normalizeDailyFolder` 同口径）：去空白 / 去结尾 `/` / 空串回落 `daily` */
export function normalizeFolder(value: string): string {
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : "daily";
}

/** `daily/2026-10-29.md` */
export function dailyNotePath(folder: string, date: string): string {
  return `${normalizeFolder(folder)}/${date}.md`;
}

/** 图片扩展名归一化：只留 `[a-z0-9]`（小写），空 / 怪字符回落 `png` */
function normalizeExt(ext: string | undefined): string {
  const clean = (ext ?? "").trim().replace(/^\./, "").toLowerCase();
  return /^[a-z0-9]{1,8}$/.test(clean) ? clean : "png";
}


/** 目录是否存在 → 不存在就建（第一次写入时才调，`onload` 不建目录） */
async function ensureFolder(host: EmoHost, folder: string): Promise<void> {
  const vault = host.app.vault;
  const adapter = vault.adapter as { exists?: (path: string) => Promise<boolean> } | undefined;
  if (typeof adapter?.exists === "function") {
    try {
      if (await adapter.exists(folder)) return;
    } catch {
      // 适配器不支持 → 落回 getAbstractFileByPath
    }
  }
  if (vault.getAbstractFileByPath(folder) !== null) return;
  await vault.createFolder(folder);
}

/** 某目录下一共有记录的日期集合（`dailyFolder` 下直接子级的 `YYYY-MM-DD.md`） */
export function recordedDates(host: EmoHost): Set<string> {
  const folder = normalizeFolder(host.dailyFolder());
  const prefix = `${folder}/`;
  const dates = new Set<string>();
  for (const item of host.app.vault.getFiles()) {
    const file = asFile(item);
    if (file === undefined || !file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length);
    if (rest.includes("/")) continue;
    const match = /^(\d{4}-\d{2}-\d{2})\.md$/.exec(rest);
    if (match !== null) dates.add(match[1]);
  }
  return dates;
}

/** 当天已经存在的图片文件（换扩展名时要把旧图删掉） */
function existingImages(host: EmoHost, date: string): EmoFile[] {
  const folder = normalizeFolder(host.dailyFolder());
  const prefix = `${folder}/${date}.`;
  const found: EmoFile[] = [];
  for (const item of host.app.vault.getFiles()) {
    const file = asFile(item);
    if (file === undefined || !file.path.startsWith(prefix)) continue;
    if (file.path.slice(prefix.length).includes("/")) continue;
    if (file.path.endsWith(".md")) continue;
    found.push(file);
  }
  return found;
}

/** 图片的可显示地址（真实环境走 `vault.getResourcePath`；拿不到就不给 `<img>`） */
function imageUrl(host: EmoHost, path: string): string | undefined {
  const vault = host.app.vault as { getResourcePath?: (file: unknown) => string };
  if (typeof vault.getResourcePath !== "function") return undefined;
  const file = host.app.vault.getAbstractFileByPath(path);
  if (file === null) return undefined;
  try {
    return vault.getResourcePath(file);
  } catch {
    return undefined;
  }
}

/**
 * 某目录下每个日期已有的图片（`dailyFolder/YYYY-MM-DD.<ext>` → 可直接塞进 `<img src>` 的地址）。
 *
 * Phase 19 M1 ①：默认主题的格子里要显示照片缩略图。这里只列文件名 + `getResourcePath`，
 * **不读 md 正文** —— 有图的格子不必再读盘（无图但有记录的格子才异步读一句话）。
 */
function dayImages(host: EmoHost): Map<string, string> {
  const folder = normalizeFolder(host.dailyFolder());
  const prefix = `${folder}/`;
  const found = new Map<string, string>();
  for (const item of host.app.vault.getFiles()) {
    const file = asFile(item);
    if (file === undefined || !file.path.startsWith(prefix)) continue;
    const rest = file.path.slice(prefix.length);
    if (rest.includes("/")) continue;
    const match = /^(\d{4}-\d{2}-\d{2})\.([a-z0-9]+)$/i.exec(rest);
    if (match === null || match[2].toLowerCase() === "md") continue;
    if (found.has(match[1])) continue;
    const url = imageUrl(host, file.path);
    if (url !== undefined) found.set(match[1], url);
  }
  return found;
}

/**
 * 读一天的记录：md 不存在 → `undefined`（= 无记录）。
 * 图片链接里的文件名按 `<dailyFolder>/<name>` 解析（一天一张，名字不带时间戳）。
 */
export async function readDailyRecord(host: EmoHost, date: string): Promise<EmoRecord | undefined> {
  const folder = normalizeFolder(host.dailyFolder());
  const file = asFile(host.app.vault.getAbstractFileByPath(dailyNotePath(folder, date)));
  if (file === undefined) return undefined;
  const text = await host.app.vault.read(file as unknown as Parameters<typeof host.app.vault.read>[0]);
  const parsed = parseDailyNote(text);
  const record: EmoRecord = { date, sentence: parsed.sentence };
  if (parsed.imageName !== undefined) {
    const name = parsed.imageName.replace(/^.*\//, "");
    record.image = { name, url: imageUrl(host, `${folder}/${name}`) ?? "" };
  }
  return record;
}

/**
 * 保存一天的记录（§⑧，**一次性**：任一步失败都不半途落盘）。
 *
 * 顺序固定（单测按调用顺序断言）：建目录 → 写图片（有的话）→ 删同名旧图 → 写 md。
 * md 已存在 → 读出旧内容、就地替换正文（frontmatter 保留）后 `vault.modify`；不存在 → `vault.create`。
 *
 * `keepImage`（Phase 19 M1 ⑦）：只改文字时把**已有的**图片链接原样写回 md ——
 * 不重新落盘二进制，也不删旧图；`image` 同时给了就以新图为准。
 */
export async function saveDailyRecord(
  host: EmoHost,
  date: string,
  input: { sentence: string; image?: EmoImage; keepImage?: string },
): Promise<EmoRecord> {
  const folder = normalizeFolder(host.dailyFolder());
  const vault = host.app.vault;
  const sentence = input.sentence.trim().slice(0, EMO_SENTENCE_MAX);

  // 1) 目录
  await ensureFolder(host, folder);

  // 2) 图片：一天一张，同名覆盖；扩展名变了顺手删旧图
  let imageName: string | undefined;
  if (input.image !== undefined) {
    imageName = `${date}.${normalizeExt(input.image.ext)}`;
    const path = `${folder}/${imageName}`;
    const existing = asFile(vault.getAbstractFileByPath(path));
    if (existing === undefined) {
      await vault.createBinary(path, input.image.bytes);
    } else {
      await vault.modifyBinary(existing as unknown as Parameters<typeof vault.modifyBinary>[0], input.image.bytes);
    }
    for (const stale of existingImages(host, date)) {
      if (stale.path === path) continue;
      await vault.delete(stale as unknown as Parameters<typeof vault.delete>[0]);
    }
  } else if (input.keepImage !== undefined && input.keepImage.length > 0) {
    // 只改文字：沿用 md 里那一条图片链接（文件名按「天」存，不带路径）
    imageName = input.keepImage.replace(/^.*\//, "");
  }

  // 3) md：正文 = 一句话 + 空行 + 图片链接；旧文件保留 frontmatter
  const notePath = dailyNotePath(folder, date);
  const noteFile = asFile(vault.getAbstractFileByPath(notePath));
  if (noteFile === undefined) {
    await vault.create(notePath, buildDailyBody(sentence, imageName));
  } else {
    const old = await vault.read(noteFile as unknown as Parameters<typeof vault.read>[0]);
    await vault.modify(noteFile as unknown as Parameters<typeof vault.modify>[0], mergeDailyBody(old, buildDailyBody(sentence, imageName)));
  }

  const record: EmoRecord = { date, sentence };
  if (imageName !== undefined) record.image = { name: imageName, url: imageUrl(host, `${folder}/${imageName}`) ?? "" };
  return record;
}

/* ------------------------------------------------------------------ *
 * 浮层（拍立得 / 输入弹窗 / 右键菜单）：同一时刻各最多一个，关弹窗 / 卸载时统一清掉
 * ------------------------------------------------------------------ */

let polaroidEl: HTMLElement | null = null;
let editorEl: HTMLElement | null = null;
let menuEl: HTMLElement | null = null;

/** 清掉 emo 的全部浮层（`closeWidgetPopup()` / 插件 `onunload` 会调） */
export function closeEmoFloats(): void {
  for (const element of [polaroidEl, editorEl, menuEl]) {
    if (element !== null) element.remove();
  }
  polaroidEl = null;
  editorEl = null;
  menuEl = null;
}

/** 浮层的公共外壳：`div.<cls>`（挂 body + 固定定位，层级在 styles.css 里定） */
function floatDiv(cls: string): HTMLElement {
  const element = document.body.createDiv({ cls });
  return element;
}

/** 关闭按钮（「×」）：位置 / 外观在 styles.css；`title` / `aria-label` 走 i18n */
function closeButton(parent: HTMLElement, onClick: () => void): HTMLElement {
  const button = parent.createEl("button", { cls: "wf-emo-close", text: "×" });
  button.title = t("view.widget.close");
  button.setAttribute("aria-label", t("view.widget.close"));
  button.onclick = onClick;
  return button;
}

/* ------------------------------------------------------------------ *
 * 拍立得（§⑥）：只读概览 / 编辑入口
 * ------------------------------------------------------------------ */

/** 拍立得的打开方式（缺省 = 只读概览） */
export interface EmoPolaroidOptions {
  /** `true` = 编辑模式（右键菜单「编辑」）：图片区 / 文字区各加一个编辑入口 */
  edit?: boolean;
  /** 保存成功后通知视图重扫目录（网格重新着色 + 今日见闻预览换新） */
  refresh?: () => void;
}

/**
 * 打开某天的拍立得（悬浮窗，`z-index: 10001` —— 高于弹窗 9998）。
 * 三态：有图有文 → 图片区图 + 文字区文；无图有文 → 两块都是文；都无 → 空。
 * 单击外部**不关闭**，只有「×」关闭；不提供「打开原 md」。
 *
 * Phase 19 M1 ⑥⑦：`options.edit === true` 时是「编辑」入口 —— 图片区加「编辑图片」
 * （选本机照片 / 拖入 / 粘贴，替换旧图并删旧文件），文字区加「编辑文字」
 * （文本框里改一段话）。两者都复用 `saveDailyRecord()`；**所有 365 天都可编辑**，
 * 往日无记录 = 新建当天记录。
 */
export async function openPolaroid(host: EmoHost, date: string, options: EmoPolaroidOptions = {}): Promise<void> {
  if (polaroidEl !== null) {
    polaroidEl.remove();
    polaroidEl = null;
  }
  const element = floatDiv("wf-emo-polaroid");
  polaroidEl = element;
  const close = (): void => {
    element.remove();
    if (polaroidEl === element) polaroidEl = null;
  };
  const head = element.createDiv({ cls: "wf-emo-polaroid-head" });
  head.createDiv({ cls: "wf-emo-polaroid-date", text: date });
  closeButton(head, close);
  const photo = element.createDiv({ cls: "wf-emo-polaroid-photo" });
  const caption = element.createDiv({ cls: "wf-emo-polaroid-caption" });

  let record: EmoRecord | undefined;
  try {
    record = await readDailyRecord(host, date);
  } catch (error) {
    host.notify(error instanceof Error ? error.message : String(error));
  }
  // 等待读盘的这一小会儿用户可能已经关掉 / 换了一天 → 句柄作废就不再往里写
  if (polaroidEl !== element) return;

  const sentence = record?.sentence ?? "";
  if (record?.image !== undefined && record.image.url.length > 0) {
    const img = photo.createEl("img", { cls: "wf-emo-polaroid-img" });
    img.setAttribute("src", record.image.url);
    img.setAttribute("alt", date);
  } else if (sentence.length > 0) {
    // 无图时图片区也放文字（§⑥ 三态的第二条）
    photo.createDiv({ cls: "wf-emo-polaroid-text", text: sentence });
  } else {
    photo.addClass("wf-emo-polaroid-photo--empty");
  }
  caption.createDiv({ cls: "wf-emo-polaroid-text", text: sentence });

  if (options.edit !== true) return;

  element.addClass("wf-emo-polaroid--edit");

  /** 保存后重开同一张拍立得（保持编辑模式），并让网格 / 今日见闻跟着刷新 */
  const reload = (): void => {
    options.refresh?.();
    void openPolaroid(host, date, options);
  };

  /** 编辑图片：替换旧图（扩展名不同时 `saveDailyRecord` 会顺手删旧文件），文字原样保留 */
  const saveImage = async (
    file: { name?: string; arrayBuffer?: () => Promise<ArrayBuffer> } | undefined,
  ): Promise<void> => {
    if (file === undefined || typeof file.arrayBuffer !== "function") return;
    try {
      const bytes = await file.arrayBuffer();
      const ext = extOf(file.name);
      await saveDailyRecord(host, date, { sentence, image: ext === undefined ? { bytes } : { bytes, ext } });
      reload();
    } catch (error) {
      host.notify(error instanceof Error ? error.message : String(error));
    }
  };

  // 隐藏的文件选择框：点「编辑图片」时由它弹系统框（不参与布局）
  const picker = element.createEl("input", { cls: "wf-emo-file" });
  picker.setAttribute("type", "file");
  picker.setAttribute("accept", "image/*");
  picker.onchange = () => {
    const files = (picker as unknown as { files?: ArrayLike<{ name?: string; arrayBuffer?(): Promise<ArrayBuffer> }> }).files;
    if (files !== undefined && files.length > 0) void saveImage(files[0]);
  };

  const editImage = photo.createEl("button", {
    cls: "wf-emo-polaroid-edit wf-emo-polaroid-edit--image",
    text: t("widget.emo.editImage"),
  });
  editImage.onclick = () => {
    (picker as unknown as { click?: () => void }).click?.();
  };

  // 拖入 / 粘贴也收一张（与输入弹窗同一套）
  photo.addEventListener("dragover", (event: unknown) => {
    (event as { preventDefault?: () => void }).preventDefault?.();
  });
  photo.addEventListener("drop", (event: unknown) => {
    (event as { preventDefault?: () => void }).preventDefault?.();
    const files = (event as {
      dataTransfer?: { files?: ArrayLike<{ name?: string; arrayBuffer?(): Promise<ArrayBuffer> }> };
    }).dataTransfer?.files;
    if (files !== undefined && files.length > 0) void saveImage(files[0]);
  });

  const editText = caption.createEl("button", {
    cls: "wf-emo-polaroid-edit wf-emo-polaroid-edit--text",
    text: t("widget.emo.editText"),
  });
  editText.onclick = () => {
    caption.empty();
    // 正在改文字 → 先别让「编辑图片」把旧句子写回去（保存 / 取消后重新打开即恢复）
    editImage.disabled = true;
    const box = caption.createEl("textarea", { cls: "wf-emo-editor-text" });
    box.setAttribute("maxlength", String(EMO_SENTENCE_MAX));
    box.setAttribute("placeholder", t("widget.emo.sentencePlaceholder"));
    box.value = sentence;
    const actions = caption.createDiv({ cls: "wf-emo-polaroid-actions" });
    const cancel = actions.createEl("button", { cls: "wf-emo-btn", text: t("common.cancel") });
    cancel.onclick = reload;
    const save = actions.createEl("button", { cls: "wf-emo-btn wf-emo-btn--primary", text: t("common.save") });
    save.onclick = () => {
      void (async () => {
        save.disabled = true;
        try {
          // 只改文字：`keepImage` 把已有图片链接原样写回 md（不删旧图）
          await saveDailyRecord(host, date, { sentence: box.value, keepImage: record?.image?.name });
          reload();
        } catch (error) {
          // 失败提示 + 允许重试（弹窗不关，用户写的字不丢）
          host.notify(error instanceof Error ? error.message : String(error));
          save.disabled = false;
        }
      })();
    };
  };
}

/* ------------------------------------------------------------------ *
 * 右键菜单（§⑤）：日期标签 + 打开 + 编辑
 * ------------------------------------------------------------------ */

/** 菜单选项：`recorded` 决定有没有「打开」（往日无记录只有「编辑」） */
export interface EmoCellMenuOptions {
  recorded: boolean;
  refresh: () => void;
}

/**
 * 一格 / 中心块的右键菜单（点空白处收起 —— 用一层透明背板兜住）。
 *
 * 三项：`MM-DD`（不可点日期标签）+ 打开 + 编辑。
 * 今日见闻 / 往日有记录 → 打开 + 编辑；**往日无记录 → 仅编辑**（= 新建当天记录）。
 */
function openCellMenu(
  event: { preventDefault(): void; stopPropagation(): void; clientX: number; clientY: number },
  host: EmoHost,
  date: string,
  options: EmoCellMenuOptions,
): void {
  if (menuEl !== null) closeEmoFloats();
  const backdrop = floatDiv("wf-emo-menu-backdrop");
  menuEl = backdrop;
  const dismiss = (): void => {
    backdrop.remove();
    if (menuEl === backdrop) menuEl = null;
  };
  backdrop.onclick = dismiss;
  const menu = backdrop.createDiv({ cls: "wf-emo-menu" });
  menu.style.left = `${event.clientX}px`;
  menu.style.top = `${event.clientY}px`;

  // 第一项：日期标签（`YYYY-MM-DD` → `MM-DD`），不可点
  menu.createDiv({ cls: "wf-emo-menu-date", text: date.slice(5) });

  if (options.recorded) {
    const open = menu.createEl("button", { cls: "wf-emo-menu-item", text: t("widget.emo.open") });
    open.onclick = () => {
      dismiss();
      void openPolaroid(host, date, { refresh: options.refresh });
    };
  }
  const edit = menu.createEl("button", { cls: "wf-emo-menu-item", text: t("widget.emo.edit") });
  edit.onclick = () => {
    dismiss();
    void openPolaroid(host, date, { edit: true, refresh: options.refresh });
  };
}




/* ------------------------------------------------------------------ *
 * 输入弹窗（§E）：一句话 + 图片，保存是一次性的
 * ------------------------------------------------------------------ */

/** 从文件名取扩展名（`a.PNG` → `png`）；取不到就给 undefined（保存时回落 `png`） */
function extOf(name: string | undefined): string | undefined {
  if (name === undefined) return undefined;
  const dot = name.lastIndexOf(".");
  return dot < 0 ? undefined : name.slice(dot + 1);
}

/** 打开「记录今日见闻」输入弹窗（`z-index: 10002`，挂 body） */
export function openEditor(host: EmoHost, date: string, refresh: () => void): void {
  if (editorEl !== null) {
    editorEl.remove();
    editorEl = null;
  }
  const element = floatDiv("wf-emo-editor");
  editorEl = element;
  const close = (): void => {
    element.remove();
    if (editorEl === element) editorEl = null;
  };

  const head = element.createDiv({ cls: "wf-emo-editor-head" });
  const title = head.createDiv({ cls: "wf-emo-editor-title", text: `${t("widget.emo.addTitle")} · ${date}` });
  closeButton(head, close);

  element.createDiv({ cls: "wf-emo-editor-label", text: t("widget.emo.sentenceLabel") });
  const textarea = element.createEl("textarea", { cls: "wf-emo-editor-text" });
  textarea.setAttribute("maxlength", String(EMO_SENTENCE_MAX));
  textarea.setAttribute("placeholder", t("widget.emo.sentencePlaceholder"));

  element.createDiv({ cls: "wf-emo-editor-label", text: t("widget.emo.imageLabel") });
  const drop = element.createDiv({ cls: "wf-emo-drop", text: t("widget.emo.imagePaste") });
  drop.setAttribute("tabindex", "0");
  // 隐藏的文件选择框（点击粘贴区时由它弹系统框；不参与布局）
  const picker = element.createEl("input", { cls: "wf-emo-file" });
  picker.setAttribute("type", "file");
  picker.setAttribute("accept", "image/*");
  picker.onchange = () => {
    const files = (picker as unknown as { files?: ArrayLike<{ name?: string; arrayBuffer?(): Promise<ArrayBuffer> }> }).files;
    if (files !== undefined && files.length > 0) void takeFile(files[0]);
  };

  /** 当前选中的图片（保存时才落盘；没选就是 undefined） */
  let image: EmoImage | undefined;
  /** 这一天原有的记录（Phase 19 M1 ⑦：往日格子也能编辑 —— 回填 + 保留没动过的那一半） */
  let current: EmoRecord | undefined;

  // 异步回填：弹窗先出来，读到旧记录再补文字 / 图片名（句柄作废就不写）
  void readDailyRecord(host, date)
    .then((record) => {
      if (record === undefined) return;
      current = record;
      if (element.parentElement === null) return;
      title.setText(`${t("widget.emo.edit")} · ${date}`);
      if (textarea.value.length === 0) textarea.value = record.sentence;
      if (record.image !== undefined) {
        drop.setText(record.image.name);
        drop.addClass("wf-emo-drop--picked");
      }
    })
    .catch(() => undefined);

  const takeFile = async (file: { name?: string; arrayBuffer?: () => Promise<ArrayBuffer> } | undefined): Promise<void> => {
    if (file === undefined || typeof file.arrayBuffer !== "function") return;
    try {
      const bytes = await file.arrayBuffer();
      const ext = extOf(file.name);
      image = ext === undefined ? { bytes } : { bytes, ext };
      drop.setText(file.name ?? t("widget.emo.imageLabel"));
      drop.addClass("wf-emo-drop--picked");
    } catch (error) {
      host.notify(error instanceof Error ? error.message : String(error));
    }
  };

  // 粘贴：`clipboardData.files[0]`（截图直接 Ctrl+V）；拖入 / 点击选文件同样收一张
  drop.addEventListener("paste", (event: unknown) => {
    const files = (event as { clipboardData?: { files?: ArrayLike<{ name?: string; arrayBuffer?(): Promise<ArrayBuffer> }> } })
      .clipboardData?.files;
    if (files !== undefined && files.length > 0) void takeFile(files[0]);
  });
  drop.addEventListener("dragover", (event: unknown) => {
    (event as { preventDefault?: () => void }).preventDefault?.();
  });
  drop.addEventListener("drop", (event: unknown) => {
    (event as { preventDefault?: () => void }).preventDefault?.();
    const files = (event as { dataTransfer?: { files?: ArrayLike<{ name?: string; arrayBuffer?(): Promise<ArrayBuffer> }> } })
      .dataTransfer?.files;
    if (files !== undefined && files.length > 0) void takeFile(files[0]);
  });
  drop.onclick = () => {
    // 点击粘贴区 = 打开系统文件选择框（Obsidian 桌面端拖拽之外的第二条路）
    (picker as unknown as { click?: () => void }).click?.();
  };

  const actions = element.createDiv({ cls: "wf-emo-editor-actions" });
  const cancel = actions.createEl("button", { cls: "wf-emo-btn", text: t("common.cancel") });
  cancel.onclick = close;
  const save = actions.createEl("button", { cls: "wf-emo-btn wf-emo-btn--primary", text: t("common.save") });
  save.onclick = () => {
    void (async () => {
      save.disabled = true;
      try {
        await saveDailyRecord(host, date, {
          sentence: textarea.value,
          image,
          // 没选新图 → 原样保留已有图片链接（只改文字不会把图弄丢）
          keepImage: image === undefined ? current?.image?.name : undefined,
        });
        close();
        // 重扫目录 → 网格重新着色 + 今日见闻预览换新
        refresh();
      } catch (error) {
        // 任一步失败都不半途落盘：提示 + 允许重试（弹窗不关，用户写的字不丢）
        host.notify(error instanceof Error ? error.message : String(error));
        save.disabled = false;
      }
    })();
  };
}

/* ------------------------------------------------------------------ *
 * 今日见闻预览（§B 末条）：有图给图，没图给文字，都没有给淡色大字
 * ------------------------------------------------------------------ */

async function loadTodayPreview(host: EmoHost, date: string, block: HTMLElement): Promise<void> {
  let record: EmoRecord | undefined;
  try {
    record = await readDailyRecord(host, date);
  } catch {
    return; // 读盘失败就保持首帧的占位（「今日见闻」四个字已经在了）
  }
  // 等待期间弹窗可能已被关掉 / 重画 → 句柄作废就不再往里写
  if (block.parentElement === null) return;
  block.empty();
  if (record?.image !== undefined && record.image.url.length > 0) {
    const img = block.createEl("img", { cls: "wf-emo-today-img" });
    img.setAttribute("src", record.image.url);
    img.setAttribute("alt", date);
    return;
  }
  if (record !== undefined && record.sentence.length > 0) {
    block.createDiv({ cls: "wf-emo-today-text", text: record.sentence });
    return;
  }
  block.createDiv({ cls: "wf-emo-today-empty", text: t("widget.emo.today") });
}

/**
 * 无图格子的正文（Phase 19 M1 ①：默认主题「无图 → 文字前半截断」）。
 *
 * 364 格全读 md 不划算，所以只读「有记录但没有图片」的那些；逐个 await，
 * 句柄作废（弹窗已关 / 已重画）就立刻停 —— 不把剩余文件继续读下去。
 */
async function hydrateCellTexts(
  host: EmoHost,
  pending: readonly { date: string; cell: HTMLElement }[],
): Promise<void> {
  for (const item of pending) {
    let record: EmoRecord | undefined;
    try {
      record = await readDailyRecord(host, item.date);
    } catch {
      continue; // 单天读盘失败不影响其它格子
    }
    if (item.cell.parentElement === null) return;
    if (record === undefined || record.sentence.length === 0) continue;
    item.cell.createDiv({ cls: "wf-emo-cell-text", text: record.sentence });
  }
}

/* ------------------------------------------------------------------ *
 * 画布（§B）：20×20 螺旋网格 + 拖拽平移 / Ctrl+滚轮缩放 / 双击复位
 * ------------------------------------------------------------------ */

/**
 * 渲染 365 天画布（侧边栏 🙂 弹窗的内容）。
 *
 * DOM：`.wf-emo` > `.wf-emo-canvas`（视口）> `.wf-emo-plane`（网格；`translate() scale()`）
 * + `.wf-emo-zoom`（右下角百分比）。364 格按 `spiralDates()` 的 1 起算坐标落位，
 * 中心 `(8,8)`~`(13,13)` 那 6×6 留给「今日见闻」。
 *
 * 唯一的内联样式是 `grid-row/column`（数据驱动的占位）与 `transform`（拖拽 / 缩放的结果）——
 * 与甘特图高亮段的 `left/width` 同一口径，其余外观一律 styles.css。
 */
export function renderEmo365(body: HTMLElement, host: EmoHost, refresh: () => void): void {
  // Phase 19 M1 ①：emo 独立主题 —— 根元素挂 `.wf-emo--<theme>`，样式全在 styles.css
  const theme = normalizeEmoTheme(host.emoTheme());
  const root = body.createDiv({ cls: `wf-emo wf-emo--${theme}` });

  // 灵动岛：固定在界面顶部（不进 transform plane），循环切换 3 个主题；只换 class + 落盘
  const chip = root.createEl("button", { cls: "wf-emo-theme", text: t(`theme.emo.${theme}`) });
  chip.title = t("settings.emoTheme.name");
  let active: EmoTheme = theme;
  chip.onclick = () => {
    const index = (EMO_THEMES as readonly string[]).indexOf(active);
    const next = EMO_THEMES[(index + 1) % EMO_THEMES.length];
    root.removeClass(`wf-emo--${active}`);
    root.addClass(`wf-emo--${next}`);
    chip.setText(t(`theme.emo.${next}`));
    active = next;
    void host.setEmoTheme(next).catch((error: unknown) => {
      host.notify(error instanceof Error ? error.message : String(error));
    });
  };

  const canvas = root.createDiv({ cls: "wf-emo-canvas" });
  const plane = canvas.createDiv({ cls: "wf-emo-plane" });
  const zoom = root.createDiv({ cls: "wf-emo-zoom" });
  zoom.title = t("widget.emo.zoom");

  const today = formatLocalDate();
  const recorded = recordedDates(host);
  const images = dayImages(host);

  // 中心块（今日见闻）：6×6 大块，左键开输入弹窗、右键开菜单
  const todayBlock = plane.createDiv({ cls: "wf-emo-today" });
  todayBlock.setAttribute("data-date", today);
  todayBlock.title = t("widget.emo.today");
  todayBlock.createDiv({ cls: "wf-emo-today-empty", text: t("widget.emo.today") });
  todayBlock.onclick = () => openEditor(host, today, refresh);
  todayBlock.oncontextmenu = (event) => {
    event.preventDefault();
    event.stopPropagation();
    openCellMenu(event, host, today, { recorded: true, refresh });
  };
  void loadTodayPreview(host, today, todayBlock);

  /** 无图但有记录的格子：首帧先着色，正文异步读进来再挂（不阻塞打开） */
  const textPending: { date: string; cell: HTMLElement }[] = [];

  for (const slot of spiralDates(today)) {
    const has = recorded.has(slot.date);
    // 环 3~7 额外挂 --r3…--r7（styles.css 里逐档降不透明度）；环 1~2 保持不透明、不挂类
    const ringClass = slot.ring >= 3 ? ` wf-emo-cell--r${slot.ring}` : "";
    const extra = has ? ` wf-emo-cell--recorded wf-emo-cell--c${emoColorIndex(slot.date) + 1}` : " wf-emo-cell--empty";
    // 糖果角度（10°…180°）：与颜色不同源；所有主题都挂类，只有 candy 读 `--wf-emo-angle`
    const angleClass = ` wf-emo-cell--a${emoAngleIndex(slot.date) + 1}`;
    const cell = plane.createDiv({ cls: `wf-emo-cell${ringClass}${extra}${angleClass}` });
    cell.setAttribute("data-date", slot.date);
    // CSS 网格线也是 1 起算：第 x 行占线 x ~ x+1
    cell.style.gridRow = `${slot.x} / ${slot.x + 1}`;
    cell.style.gridColumn = `${slot.y} / ${slot.y + 1}`;
    cell.title = `${slot.date} · ${has ? t("widget.emo.recorded") : t("widget.emo.empty")}`;
    cell.onclick = () => void openPolaroid(host, slot.date, { refresh });
    cell.oncontextmenu = (event) => {
      event.preventDefault();
      event.stopPropagation();
      openCellMenu(event, host, slot.date, { recorded: has, refresh });
    };
    if (!has) continue;
    // 默认主题的内容：有图 → 缩略图；无图 → 一句话（其余主题用 CSS 隐藏内容、只留纹理）
    const image = images.get(slot.date);
    if (image !== undefined) {
      const img = cell.createEl("img", { cls: "wf-emo-cell-img" });
      img.setAttribute("src", image);
      img.setAttribute("alt", slot.date);
    } else {
      textPending.push({ date: slot.date, cell });
    }
  }
  void hydrateCellTexts(host, textPending);

  /* ---- 平移 / 缩放 ---- */

  let scale = EMO_ZOOM_START;
  let pan: EmoPan = { x: 0, y: 0 };
  /**
   * 内容尺寸（已乘缩放）。真实环境读 `offsetWidth` —— 它含网格间距与 padding，
   * 与 `clampPan()` 的「内容矩形」口径完全一致；`offsetWidth` **不受 transform 影响**，
   * 所以这里自己乘 `scale`。DOM 桩里量不出布局（恒 0）→ 回落到常量。
   */
  const contentSize = (): EmoSize => {
    const probe = plane as unknown as { offsetWidth?: number; offsetHeight?: number };
    const width = probe.offsetWidth ?? 0;
    const height = probe.offsetHeight ?? 0;
    if (width > 0 && height > 0) return { width: width * scale, height: height * scale };
    const side = EMO_GRID * EMO_CELL_PX * scale;
    return { width: side, height: side };
  };
  const viewportSize = (): EmoSize => {
    const probe = canvas as unknown as { clientWidth?: number; clientHeight?: number };
    return { width: probe.clientWidth ?? 0, height: probe.clientHeight ?? 0 };
  };
  const paint = (): void => {
    plane.style.transform = `translate(${pan.x}px, ${pan.y}px) scale(${scale})`;
    zoom.setText(zoomLabel(scale));
  };
  /** 对准画布中心（打开时 / 双击复位都走这里） */
  const center = (): void => {
    const view = viewportSize();
    const content = contentSize();
    pan = clampPan(view, content, { x: (view.width - content.width) / 2, y: (view.height - content.height) / 2 });
  };
  /**
   * 首帧：固定 `EMO_ZOOM_START`（600%，补充契约①）再对准画布中心。
   * **不读视口 / 内容尺寸** —— 原 `fit()` 会按视口一路顶到上限，导致不同窗口大小看到不同缩放。
   */
  const initialView = (): void => {
    scale = EMO_ZOOM_START;
    center();
  };

  let dragging = false;
  let startX = 0;
  let startY = 0;
  let originX = 0;
  let originY = 0;

  canvas.addEventListener("pointerdown", (event: unknown) => {
    const pointer = event as { button?: number; clientX?: number; clientY?: number; pointerId?: number };
    if (typeof pointer.button === "number" && pointer.button !== 0) return;
    dragging = true;
    startX = pointer.clientX ?? 0;
    startY = pointer.clientY ?? 0;
    originX = pan.x;
    originY = pan.y;
    canvas.addClass("wf-emo-canvas--dragging");
    const capture = canvas as unknown as { setPointerCapture?: (id: number) => void };
    if (typeof capture.setPointerCapture === "function" && typeof pointer.pointerId === "number") {
      capture.setPointerCapture(pointer.pointerId);
    }
  });
  canvas.addEventListener("pointermove", (event: unknown) => {
    if (!dragging) return;
    const pointer = event as { clientX?: number; clientY?: number };
    pan = clampPan(viewportSize(), contentSize(), {
      x: originX + ((pointer.clientX ?? 0) - startX),
      y: originY + ((pointer.clientY ?? 0) - startY),
    });
    paint();
  });
  const stopDrag = (): void => {
    if (!dragging) return;
    dragging = false;
    canvas.removeClass("wf-emo-canvas--dragging");
  };
  canvas.addEventListener("pointerup", stopDrag);
  canvas.addEventListener("pointercancel", stopDrag);

  // Ctrl + 滚轮 = 缩放（不带 Ctrl 的滚轮不拦：保持页面滚动）
  canvas.addEventListener(
    "wheel",
    (event: unknown) => {
      const wheel = event as { ctrlKey?: boolean; deltaY?: number; preventDefault?: () => void };
      if (wheel.ctrlKey !== true) return;
      wheel.preventDefault?.();
      scale = zoomStep(scale, (wheel.deltaY ?? 0) < 0 ? 1 : -1);
      pan = clampPan(viewportSize(), contentSize(), pan);
      paint();
    },
    { passive: false },
  );

  // 双击复位：缩放回 1 且重新对准中心
  canvas.addEventListener("dblclick", () => {
    scale = 1;
    center();
    paint();
  });

  // 视口尺寸变了重新夹一次平移（DOM 桩 / 不支持时跳过）
  const Observer = (globalThis as { ResizeObserver?: new (callback: () => void) => { observe(target: unknown): void } })
    .ResizeObserver;
  if (typeof Observer === "function") {
    new Observer(() => {
      pan = clampPan(viewportSize(), contentSize(), pan);
      paint();
    }).observe(canvas);
  }

  initialView();
  paint();
}
