/**
 * 插件入口（Obsidian 侧）。
 *
 * 职责边界：
 *  - 本文件只做「Obsidian ↔ 引擎」的编排（读文件、命令、Notice/弹窗、vault.process）；
 *  - 业务逻辑全部在 src/engine（纯 TypeScript、零 Obsidian 依赖、可 node --test 直接跑）；
 *  - 上层只依赖 src/engine/index.ts，不直接引用引擎内部文件。
 *
 * Phase 1（schema 1.1）提供的能力：
 *  1. 命令「校验当前文件的 wfjson」→ 读当前 md → analyzeMarkdown → Notice + 问题弹窗；
 *  2. `mutateFile()`：通用写回编排（`vault.process` 事务 → 引擎 `applyMutation`：安全闸门 →
 *     1.0→1.1 升格 → 三段写回 → 幂等校验），保证「读 → 改 → 写」原子且不覆盖他人改动；
 *  3. `setNodeStatus()`：改状态（视图右键菜单调用）；
 *  4. `render(dv)`：dataviewjs 视图入口（视图代码在 views/wfView.ts，编译进 main.js）。
 *
 * Phase 2（正在进行块节点右键菜单）在同一套写回链路上加了两层（契约
 * doc/datacontact/data_ixd_phase2_contract.md）：
 *  1. 低层变更方法（契约 §4）：`addChildNode` / `deleteNode` —— 真正写盘，
 *     内存改动全在引擎的 nodeEdits.ts，这里只做「结果 → 结构化返回」的包装；
 *  2. Modal 入口（契约 §7）：`promptAddChild` / `confirmDeleteNode` ——
 *     视图只调这两个，弹窗、就地校验（JSON / Schema / 标题清洗）与「取消 vs 失败」的区分都在本文件。
 *
 * Phase 3（schema 1.3：正计时器 + 近 21 天方块阵）继续复用同一条写回链路（契约
 * doc/datacontact/data_ixd_phase3_contract.md §5）：
 *  1. `startTimer()`：追加一条进行中的计时条目（并发闸门：全文件只允许一个）；
 *  2. `stopTimer(file, nodeId, "record" | "discard")`：结束并记录 / 结束并丢弃；
 *     两个方法的内存改动在引擎的 timerEdits.ts，返回形如 `TimerChangeResult`。
 *
 * Phase 3 视图微调（v0.6，讨论结论见 doc/datacontact/data_ixd_discuss_interact_v0.2.md
 * 《Phase 3 视图调整定稿》）：
 *  1. `WfJsonSettingTab`：插件设置面板，只放「计时器字号」一项，`loadData` / `saveData`
 *     持久化到 Obsidian 的 `data.json`；
 *  2. 启动与设置变更时把字号写进根元素 CSS 变量 `--wf-timer-font-size`
 *     （styles.css 里 `.wf-timer` 读它；用户仍可用 CSS snippet 覆盖同一个变量）。
 *
 * Phase 4（归档：子树浓缩进 `archive/<workflowId>-<nodeId>.md`）继续复用同一条写回链路
 * （契约 doc/datacontact/data_ixd_phase4_contract.md）：
 *  1. `archiveNode(file, node, form)`：`planArchive`（内存里算归档 md 的文本 + `archive` 字段）
 *     → vault 里 `archive/` 建那份 md（已存在就复用：幂等重试）→ `mutateFile` 把原文件里的子树
 *     浓缩成一个带 `archive` 的 done 节点（内存改动在引擎的 archive.ts，**绝不半途改一半**）；
 *  2. Modal 入口（契约 §7）：`promptArchiveNode` —— 收集 概括 / 原理 / 复盘 三段文字后交给上面那个方法，
 *     视图只调这一个（与 Phase 2 的三个入口同形）。
 *
 * v0.7 §⑧ 外置 JSON（契约见 doc/datacontact/data_ixd_discuss_interact_v0.7.md）：
 *  1. 路径镜像：`A/B/笔记.md` → `_wfjson/A/B/笔记.wf.json`（`src/engine/sidecar.ts`）；
 *  2. 读：侧车存在就以外置 JSON 为准（笔记内残留代码块只报 info），否则退回代码块（旧文件兼容）；
 *  3. 写：`mutateFile()` 先 `vault.process` 侧车（`applySidecarMutation`）再 `vault.process` 笔记
 *     （`writeBackNote`：frontmatter + 纪要段）。两步都幂等，中断后重试即可收敛；
 *  4. 迁移只走手动命令（当前文件 / 整个库），**不自动改写用户的笔记**；归档 md 仍内嵌 JSON；
 *  5. `vault.on("rename" / "delete")` 同步侧车（笔记移动 / 删除时侧车一起走）。
 *
 * Phase 15（拖拽改节点顺序）继续复用同一条写回链路：
 *  `moveNode(file, movingId, targetId, position)` —— 内存改动在引擎的 nodeReorder.ts
 *  （before = 插到目标之前、after = 成为目标的子节点并接手它的 children），这里只做结果包装。
 *
 */

import { Modal, Notice, Plugin, PluginSettingTab, Setting, TFile, TFolder, type App, type TAbstractFile } from "obsidian";

import {
  analyzeDocument,
  analyzeMarkdown,
  appendChildNode as appendChildNodeInDocument,
  applyMutation,
  applySidecarMutation,
  applyStatusChange,
  applyWorkflowEdits,
  archiveNode as archiveNodeInDocument,
  ARCHIVE_FOLDER,
  buildWorkflowTemplate,
  checkIntegerInRange,
  collectDescendants,
  editNodeInfo as editNodeInfoInDocument,
  findNode,
  formatAnalyzeResult,
  formatIssues,
  isArchivePathForNode,
  isSidecarPath,
  IMPORTANCE_LABELS,
  URGENCY_LABELS,
  LANG_OPTIONS,
  getLang,
  moveNode as moveNodeInDocument,
  nodeInfoLabel,
  normalizeLang,
  normalizeEmoTheme,
  normalizePlotFolder,
  EMO_THEMES,
  setLang,
  t,
  workflowEditLabel,
  FRONTMATTER_FIELDS,
  NODE_INFO_LABELS,
  NODE_TYPE_SUGGESTIONS,
  parentFolderOf,
  planArchive,
  planSidecarMigration,
  readArchivedWorkflowIdentity,
  removeNode as removeNodeInDocument,
  removeWfJsonBlocks,
  renderArchiveNoteLine,
  sanitizeTitle,
  setFrontmatterField,
  sidecarPathFor,
  startTimerEntry,
  stopTimerEntry,
  WFJSON_FOLDER,
  writeBackNote,
  type AddChildInput,
  type AnalyzeResult,
  type ArchiveFormInput,
  type DocumentMutator,
  type Lang,
  type MutationResult,
  type NodeInfoFieldKey,
  type NodeInfoPatch,
  type NodeStatus,
  type ReorderPosition,
  type StatusChangeOptions,
  type StopTimerMode,
  type WfArchive,
  type WfJsonDocument,
  type WfNode,
  type WfWorkflow,
  type WorkflowEditFieldKey,
  type WorkflowEditPlan,
  type WorkflowPatch,
  type WorkflowState,
} from "./src/engine/index.ts";
import {
  closeWidgetPopup,
  isViewApi,
  renderWorkflowView,
  stopTimerTicker,
  type AddChildNodeResult,
  type ArchiveNodeResult,
  type DeleteNodeResult,
  type ModalEditOutcome,
  type NodeInfoChangeResult,
  type NodeStatusChangeOptions,
  type NodeStatusChangeResult,
  type ReorderResult,
  type TimerChangeResult,
  type WfThemeOption,
  type WfViewHost,
  type WfViewOptions,
  type WorkflowChangeResult,
} from "./views/wfView.ts";

/**
 * 插件设置（Phase 3 视图微调 v0.6；默认值 v0.7 起为 `36px`；Phase 6 增主题）。
 * 存 Obsidian 的 `data.json`（`loadData` / `saveData`）。
 */
interface WfJsonWorkflowSettings {
  /** 正计时器 `HH:MM:SS` 时钟的字号（CSS 长度，如 `36px` / `2.5em`）：写到根元素变量 `--wf-timer-font-size` */
  timerFontSize: string;
  /**
   * 泳道正文区的最大高度（px，Phase 17）：写到根元素变量 `--wf-lane-max-height`。
   * 超出后只在泳道内滚动，栏头固定 —— 每条泳道各一条滚动条。
   * Phase 18 ⑥：设置面板的控件从滑杆换成文本框（`addText` + `normalizeLaneHeight`）。
   */
  laneScrollHeight: number;
  /**
   * 卡片宽度（px，Phase 18 ⑦）：写到根元素变量 `--wf-card-width`。
   * 优先于所有主题 —— styles.css 里两处字面值（`body` 的 220 / magazine 的 240）已删，
   * 未设置时靠 `.wf-card` 上的 `var(--wf-card-width, 200px)` 回落。
   */
  cardWidth: number;
  /**
   * 引导性话语（Phase 18 ③）：渲染区最顶部的大标题。
   * 默认**空串** = 用 i18n 文案（中「下一步是？」/ 英「What's next?」）——
   * 存空串而不是存中文，语言一切换标题才会跟着变；用户填了就原样使用。
   */
  resumePrompt: string;
  /**
   * 365 天见闻 md 的目录（Phase 18 ④-E）：`daily/YYYY-MM-DD.md`。
   * 第一次写入时才建目录（`onload` 不建）。
   */
  dailyFolder: string;
  /**
   * 365 天 emo 小工具的独立主题（Phase 19 M1 ①）：`default / weave / candy`。
   * **与插件主题无关**（视图里挂在 `.wf-emo--<theme>` 上，不进 `[data-wf-theme]`）。
   */
  emoTheme: string;
  /**
   * 365 天 plot 的目录（Phase 19 M3）：`plots/plot-<uuid>.json` + 导出的 `plot-<uuid>.csv`。
   * 第一次写入时才建目录（`onload` 不建）。
   */
  plotFolder: string;
  /** 主题 key（对应 styles.css 的 `[data-wf-theme="…"]`；`default` = 默认主题） */
  theme: string;
  /** 界面 / 校验提示语言（Phase 10 v0.8；缺省 `en`，见 i18n.ts） */
  lang: Lang;
}

const DEFAULT_SETTINGS: WfJsonWorkflowSettings = {
  timerFontSize: "36px",
  // Phase 17：默认 800px —— 与 styles.css 里 `.wf-lane-body` 的 var() 回落值保持一致
  laneScrollHeight: 800,
  // Phase 18 ⑦：默认 200px —— 与 `.wf-card` 的 var(--wf-card-width, 200px) 回落值一致
  cardWidth: 200,
  // Phase 18 ③：空串 = 走 i18n 文案（语言切换时标题跟着变）
  resumePrompt: "",
  // Phase 18 ④-E：见闻 md 的默认目录
  dailyFolder: "daily",
  // Phase 19 M1 ①：emo 独立主题（默认主题）
  emoTheme: "default",
  // Phase 19 M3：plot JSON / CSV 的默认目录
  plotFolder: "plots",
  theme: "default",
  // Phase 10（v0.8）契约 §②：没配过语言的新用户先看到英文
  lang: "en",
};

/** 计时器字号变量名（styles.css 的 `.wf-timer-clock` 读它；CSS snippet 仍可覆盖） */
const TIMER_FONT_SIZE_VARIABLE = "--wf-timer-font-size";

/** 泳道正文区最大高度的变量名（styles.css 的 `.wf-lane-body` 读它；CSS snippet 仍可覆盖） */
const LANE_HEIGHT_VARIABLE = "--wf-lane-max-height";

/** Phase 18 ⑦：卡片宽度的变量名（styles.css 的 `.wf-card` 读它：`var(--wf-card-width, 200px)`） */
const CARD_WIDTH_VARIABLE = "--wf-card-width";

/** Phase 17：泳道高度的取值范围（px）；设置面板的文本框与 `loadSettings` 用同一对边界 */
const LANE_HEIGHT_MIN = 300;
const LANE_HEIGHT_MAX = 3000;

/**
 * 泳道高度校验：非数字 / 越界一律收拾回 700–9999（小数四舍五入）。
 * 与 `normalizeTheme` / `normalizeLang` 同形：手改 `data.json` 也不会把视图撑坏。
 */
function normalizeLaneHeight(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isFinite(parsed)) return DEFAULT_SETTINGS.laneScrollHeight;
  return Math.min(LANE_HEIGHT_MAX, Math.max(LANE_HEIGHT_MIN, Math.round(parsed)));
}

/** Phase 18 ⑦：卡片宽度的取值范围（px）；与 `normalizeCardWidth()` 同一对边界 */
const CARD_WIDTH_MIN = 150;
const CARD_WIDTH_MAX = 400;

/** 卡片宽度校验（与 `normalizeLaneHeight` 同形）：非数字 / 越界 → 收进 150–400 并四舍五入 */
function normalizeCardWidth(value: unknown): number {
  const parsed = typeof value === "number" ? value : Number(value);
  // 空串 `Number("")` 是 0（会落进范围），必须单独挡掉 —— 输入框清空时回到默认值
  if (typeof value === "string" && value.trim().length === 0) return DEFAULT_SETTINGS.cardWidth;
  if (!Number.isFinite(parsed)) return DEFAULT_SETTINGS.cardWidth;
  return Math.min(CARD_WIDTH_MAX, Math.max(CARD_WIDTH_MIN, Math.round(parsed)));
}

/** 引导性话语最长字符数（防手改 `data.json` 塞进超长串把标题撑爆） */
const RESUME_PROMPT_MAX = 40;

/** 引导性话语校验：非字符串 / 空白 → 空串（= 用 i18n 文案）；超长截断 + 去首尾空白 */
function normalizeResumePrompt(value: unknown): string {
  if (typeof value !== "string") return "";
  return value.trim().slice(0, RESUME_PROMPT_MAX);
}

/** 见闻 md 的目录校验：去首尾空白 → 去掉结尾 `/` → 空串回落默认值 */
function normalizeDailyFolder(value: unknown): string {
  if (typeof value !== "string") return DEFAULT_SETTINGS.dailyFolder;
  const trimmed = value.trim().replace(/\/+$/, "");
  return trimmed.length > 0 ? trimmed : DEFAULT_SETTINGS.dailyFolder;
}

/**
 * Phase 6 主题清单（契约见 doc/datacontact/data_ixd_discuss_interact_v0.5.md
 * 《Phase 6 定稿契约》）：`key` 与 styles.css 的 `[data-wf-theme="…"]` 一一对应。
 * 设置面板与视图里的切换入口共用这一份，避免两处清单漂移。
 */
const WF_THEME_KEYS: readonly string[] = [
  "default",
  "tech",
  "nature",
  "magazine",
  "retro",
  "clay",
  // Phase 10（v0.8）：5 + 3
  "web",
  "fresh",
  "shoujo",
];

/**
 * 主题选项（`label` 走 i18n，切换语言后重新取即可）。
 * 模块加载时就调 `t()` 会把语言锁死在 import 时刻，所以这里做成函数而不是常量。
 */
function themeOptions(): WfThemeOption[] {
  return WF_THEME_KEYS.map((key) => ({ key, label: t(`theme.${key}`) }));
}

/** 主题校验：不在清单里的 key 一律回落默认主题 */
function normalizeTheme(theme: unknown): string {
  return typeof theme === "string" && WF_THEME_KEYS.includes(theme)
    ? theme
    : DEFAULT_SETTINGS.theme;
}

export default class WfJsonWorkflowPlugin extends Plugin implements WfViewHost {
  /** 插件设置（Phase 3 视图微调 v0.6）：`onload` 里从 `data.json` 读入 */
  settings: WfJsonWorkflowSettings = { ...DEFAULT_SETTINGS };

  async onload(): Promise<void> {
    await this.loadSettings();
    // Phase 10（v0.8）：语言先落到引擎，后续命令 / 设置 / 视图文案都按它输出
    setLang(this.settings.lang);
    this.applyTimerFontSize();
    // Phase 17：泳道高度同样挂在根元素上（所有笔记 / 所有视图一次性生效）
    this.applyLaneScrollHeight();
    // Phase 18 ⑦：卡片宽度也走根元素变量（设置优先于所有主题）
    this.applyCardWidth();
    this.addSettingTab(new WfJsonSettingTab(this.app, this));

    this.addCommand({
      id: "check-active-file",
      name: t("command.check"),
      checkCallback: (checking: boolean): boolean => {
        const file = this.activeMarkdownFile();
        if (!file) return false;
        if (!checking) void this.checkFile(file);
        return true;
      },
    });

    this.addCommand({
      id: "migrate-active-file-to-sidecar",
      name: t("command.migrate"),
      checkCallback: (checking: boolean): boolean => {
        const file = this.activeMarkdownFile();
        if (!file) return false;
        if (!checking) void this.migrateActiveFileToSidecar();
        return true;
      },
    });

    // Phase 10（v0.8）④：插入工作流模板（frontmatter + 渲染块 + 纪要大标题 + 合法 wfjson）
    this.addCommand({
      id: "insert-workflow-template",
      name: t("command.insertTemplate"),
      editorCallback: (editor) => {
        if (editor.getValue().trim().length === 0) {
          editor.setValue(buildWorkflowTemplate());
          editor.setCursor(editor.lineCount(), 0);
        } else {
          // 已有内容的笔记：只插正文部分（frontmatter 必须留在文件最顶部，不能插到光标处）
          editor.replaceSelection(buildWorkflowTemplate({ includeFrontmatter: false }));
        }
        new Notice(t("command.templateDone"));
      },
    });


    // v0.7 §⑧：笔记移动 / 改名 / 删除时，侧车（镜像路径）跟着走
    this.registerEvent(
      this.app.vault.on("rename", (abstract, oldPath) => {
        void this.syncSidecarOnRename(abstract, oldPath);
      }),
    );
    this.registerEvent(
      this.app.vault.on("delete", (abstract) => {
        void this.syncSidecarOnDelete(abstract);
      }),
    );
  }

  onunload(): void {
    // 清掉正计时器的 tick（Phase 3）：视图模块里的 interval 若不显式清掉会一直跑
    stopTimerTicker();
    // Phase 16：小工具弹窗挂在 document.body 上，禁用 / 卸载插件时一并清掉
    closeWidgetPopup();
  }

  /** 读设置（`data.json`）：缺项 / 类型不对一律回落默认值 */
  async loadSettings(): Promise<void> {
    const stored = (await this.loadData()) as Partial<WfJsonWorkflowSettings> | null;
    const timerFontSize = stored?.timerFontSize;
    this.settings = {
      timerFontSize:
        typeof timerFontSize === "string" && timerFontSize.trim().length > 0
          ? timerFontSize
          : DEFAULT_SETTINGS.timerFontSize,
      laneScrollHeight: normalizeLaneHeight(stored?.laneScrollHeight),
      cardWidth: normalizeCardWidth(stored?.cardWidth),
      resumePrompt: normalizeResumePrompt(stored?.resumePrompt),
      dailyFolder: normalizeDailyFolder(stored?.dailyFolder),
      emoTheme: normalizeEmoTheme(stored?.emoTheme),
      plotFolder: normalizePlotFolder(stored?.plotFolder),
      theme: normalizeTheme(stored?.theme),
      lang: normalizeLang(stored?.lang),
    };
  }

  /** 存设置（Obsidian 的 `saveData` 写 `data.json`） */
  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /**
   * 把当前字号写进根元素 CSS 变量（`onload` 与设置面板变更时都调）。
   * 挂根元素而不是视图容器：dataviewjs 视图每次渲染都会重建 DOM，根元素上的变量对
   * 所有笔记 / 所有视图一次性生效；用户仍可用 CSS snippet 覆盖同一个变量。
   */
  applyTimerFontSize(): void {
    document.documentElement.style.setProperty(TIMER_FONT_SIZE_VARIABLE, this.settings.timerFontSize);
  }

  /**
   * 把泳道正文区的最大高度写进根元素 CSS 变量（Phase 17：`onload` 与设置面板变更时都调）。
   * 与字号同一套理由：挂根元素，所有笔记 / 所有视图一次性生效；用户仍可用 snippet 覆盖。
   */
  applyLaneScrollHeight(): void {
    document.documentElement.style.setProperty(LANE_HEIGHT_VARIABLE, `${this.settings.laneScrollHeight}px`);
  }

  /**
   * 把卡片宽度写进根元素 CSS 变量（Phase 18 ⑦：`onload` 与设置面板变更时都调）。
   * 写根元素 = 所有视图一次性生效；styles.css 里已删掉两处字面值，
   * 因此这里的值（默认 200）是**唯一**权威，snippet 仍可覆盖同一变量。
   */
  applyCardWidth(): void {
    document.documentElement.style.setProperty(CARD_WIDTH_VARIABLE, `${this.settings.cardWidth}px`);
  }

  /**
   * Phase 18 ③：渲染区顶部的引导性话语（视图读这个，不 import 插件设置）。
   * 空串 = 让视图回落到 i18n 的「下一步是？」。
   */
  resumePrompt(): string {
    return this.settings.resumePrompt;
  }

  /** Phase 18 ④-E：365 天见闻 md 的目录（视图拼 `dailyFolder/YYYY-MM-DD.md`） */
  dailyFolder(): string {
    return this.settings.dailyFolder;
  }

  /** Phase 19 M1 ①：365 天 emo 的独立主题（视图挂 `.wf-emo--<theme>`，与插件主题无关） */
  emoTheme(): string {
    return this.settings.emoTheme;
  }

  /** Phase 19 M1 ①：画布上「灵动岛」切换主题 → 落盘（视图只换 class，不重渲染） */
  async setEmoTheme(theme: string): Promise<void> {
    const next = normalizeEmoTheme(theme);
    if (next === this.settings.emoTheme) return;
    this.settings.emoTheme = next;
    await this.saveSettings();
  }

  /** Phase 19 M3：365 天 plot 的目录（视图拼 `plotFolder/plot-<uuid>.json`，导出 CSV 同目录） */
  plotFolder(): string {
    return this.settings.plotFolder;
  }

  /* ---------------------------------------------------------------- *
   * Phase 6 主题 + Phase 9 主题跟随文件：
   *   - 设置面板 = **全局默认主题**（`settings.theme`）；
   *   - 视图容器自己挂 `data-wf-theme`（每文件独立），插件不再改 `<html>`；
   *   - 「状态总览」末尾的切换按钮只写本文件 frontmatter `wf-theme`。
   * ---------------------------------------------------------------- */

  /** 视图切换入口用的主题清单（与设置面板共用同一份；视图只负责渲染） */
  /**
   * 主题清单（视图 / 设置共用）。`label` 按当前语言实时取，
   * 所以切换语言后重画设置面板 / 重渲染视图就能看到新文案。
   */
  get themes(): readonly WfThemeOption[] {
    return themeOptions();
  }

  /** 设置面板当前值（与视图的 `defaultTheme` 同一个来源） */
  get defaultTheme(): string {
    return this.settings.theme;
  }

  /**
   * 设置面板：改**全局默认主题**（只写 `data.json`）。
   * 已打开视图的主题由各自容器决定；重新渲染后未写 `wf-theme` 的文件会跟随新默认值。
   */
  setTheme(theme: string): void {
    const next = normalizeTheme(theme);
    if (next === this.settings.theme) return;
    this.settings.theme = next;
    void this.saveSettings();
  }

  /**
   * 视图切换入口：只写该文件 frontmatter 的 `wf-theme`（Phase 9：主题跟随文件）。
   * 不碰 `settings.theme`，因此不会污染其他笔记 / 全局默认值。
   *
   * v0.7 §⑨-7：走 `vault.process` + 引擎的**逐行** upsert，不用
   * `fileManager.processFrontMatter`（后者用严格 YAML 解析整块 frontmatter，
   * 遇到用户笔记里既有的非严格写法会抛错，把主题这种单键写入一起拖垮）。
   */
  async setFileTheme(file: TFile, theme: string): Promise<void> {
    const next = normalizeTheme(theme);
    await this.app.vault.process(file, (text) =>
      setFrontmatterField(text, FRONTMATTER_FIELDS.theme, next),
    );
  }

  /** 当前激活的 md 文件（未打开或不是 md 时返回 null） */
  private activeMarkdownFile(): TFile | null {
    const file = this.app.workspace.getActiveFile();
    return file && file.extension === "md" ? file : null;
  }

  /**
   * 分析任意 md 文件（只读；供命令、dataviewjs 视图与后续右键菜单复用）。
   */
  async analyzeFile(file: TFile): Promise<AnalyzeResult> {
    const markdown = await this.app.vault.read(file);
    return this.analyzeNoteText(file, markdown);
  }

  /**
   * 分析「已经读到的笔记文本」（避免二次读盘；归档要复制正文时用）。
   * 侧车存在 → 外置 JSON 为准；否则退回笔记内代码块（旧文件完全兼容）。
   */
  private async analyzeNoteText(file: TFile, noteMarkdown: string): Promise<AnalyzeResult> {
    const sidecar = this.findSidecarFile(file);
    if (sidecar === undefined) return analyzeMarkdown(noteMarkdown, { file: file.path });
    return analyzeDocument({
      noteMarkdown,
      jsonText: await this.app.vault.read(sidecar),
      jsonSource: "sidecar",
      jsonFile: sidecar.path,
      file: file.path,
    });
  }

  /**
   * 笔记对应的侧车文件（`_wfjson/…/*.wf.json`；不存在返回 undefined）。
   * 同名目录 / 其它类型一律当作「没有侧车」，不让异常路径影响读写。
   */
  private findSidecarFile(file: TFile): TFile | undefined {
    if (isSidecarPath(file.path)) return undefined;
    const entry = this.app.vault.getAbstractFileByPath(sidecarPathFor(file.path));
    return entry instanceof TFile ? entry : undefined;
  }

  /**
   * 通用变更编排（唯一写盘入口）。
   *
   * 笔记模式（没有侧车）：用 `vault.process(file, fn)` 把「读 → 改 → 写」放进同一事务，
   * 真正的判断逻辑（拒绝坏数据、版本升格、三段写回、写回后幂等校验）都在引擎的 `applyMutation`。
   *
   * 侧车模式（v0.7 §⑧）：先 `vault.process` 侧车（`applySidecarMutation`），再 `vault.process`
   * 笔记（`writeBackNote`：frontmatter + 纪要段）。两步都幂等，中断后重试即可收敛。
   *
   * `now` 可选：传入后引擎的 `document.updatedAt` 与节点 `updatedAt` 用同一个时间戳
   * （Phase 2 的编辑函数需要自己维护节点时间，见 nodeEdits.ts）。
   */
  async mutateFile(file: TFile, mutator: DocumentMutator, now?: Date): Promise<MutationResult> {
    const sidecar = this.findSidecarFile(file);
    if (sidecar === undefined) return this.mutateNoteFile(file, mutator, now);
    return this.mutateSidecarFile(file, sidecar, mutator, now);
  }

  /** 笔记模式写回（JSON 与正文在同一个 md 里） */
  private async mutateNoteFile(file: TFile, mutator: DocumentMutator, now?: Date): Promise<MutationResult> {
    const holder: { mutation?: MutationResult } = {};
    await this.app.vault.process(file, (text) => {
      const mutation = applyMutation(text, mutator, now !== undefined ? { file: file.path, now } : { file: file.path });
      holder.mutation = mutation;
      return mutation.markdown;
    });

    const mutation = holder.mutation;
    if (mutation === undefined) {
      // 防御：`vault.process` 没执行回调时宁可报错，也不假装写成功
      throw new Error(t("reject.processSkipped"));
    }
    return mutation;
  }

  /**
   * 侧车模式写回：外置 JSON 先落盘，再重写笔记里与 JSON 无关的部分。
   *
   * 失败语义：引擎拒绝 / 写回校验失败时 `mutation.success=false`，此时**两个文件都不写**
   * （`vault.process` 回写原文，内容逐字节不变）。
   */
  private async mutateSidecarFile(
    file: TFile,
    sidecar: TFile,
    mutator: DocumentMutator,
    now?: Date,
  ): Promise<MutationResult> {
    const base = now ?? new Date();
    const noteBefore = await this.app.vault.read(file);
    const holder: { mutation?: MutationResult } = {};
    await this.app.vault.process(sidecar, (jsonText) => {
      const mutation = applySidecarMutation(noteBefore, jsonText, mutator, {
        file: file.path,
        jsonFile: sidecar.path,
        now: base,
      });
      holder.mutation = mutation;
      return mutation.jsonText ?? jsonText;
    });

    const mutation = holder.mutation;
    if (mutation === undefined) {
      throw new Error(t("reject.processSkipped"));
    }
    if (!mutation.success || !mutation.changed || mutation.document === undefined) return mutation;

    // 用同一份（已改好的）文档重写笔记：JSON 在侧车里，笔记里只留 frontmatter + 纪要段。
    // 重新读一次最新正文（而不是直接写 planning 时的结果），避免覆盖期间的用户编辑。
    const document = mutation.document;
    const markdown = await this.app.vault.process(file, (text) => {
      // 常态：正文与侧车事务开始前一致 → 直接用引擎算好的结果（含「删除节点的纪要段」与超链接合并）
      if (text === noteBefore) return mutation.markdown;
      // 期间用户改过正文：在最新正文上重写，宁可少删一个段落也不覆盖用户新内容
      return writeBackNote(text, document, { now: base, removedNoteAnchors: mutation.removedAnchors }).markdown;
    });
    return { ...mutation, markdown };
  }

  /**
   * Phase 1 的改状态方法（视图右键「标记为…」调用）：
   *  - 节点不存在 → 结构化拒绝（不写盘）；
   *  - 状态本来就一样 → `changed=false`（不写盘）；
   *  - 其余情况走 `mutateFile`：落盘升格 1.0→1.1、写 status/history/progress/completedAt、
   *    刷新 frontmatter 摘要，并返回写回后的校验问题（供视图提示）。
   */
  async setNodeStatus(
    file: TFile,
    nodeId: string,
    status: NodeStatus,
    options: NodeStatusChangeOptions = {},
  ): Promise<NodeStatusChangeResult> {
    const mutation = await this.mutateFile(file, (document) => {
      const node = findNode(document, nodeId);
      if (!node) return { reject: t("reject.nodeMissing", { id: nodeId }) };
      if (node.status === status) return { changed: false };
      const change: StatusChangeOptions = {};
      if (options.note !== undefined) change.note = options.note;
      if (options.by !== undefined) change.by = options.by;
      applyStatusChange(node, status, change);
      return { changedNodeIds: [nodeId] };
    });

    const result: NodeStatusChangeResult = {
      success: mutation.success,
      file: file.path,
      nodeId,
      status,
      changed: mutation.changed,
      issues: mutation.analysis.issues,
    };
    if (mutation.reason !== undefined) result.reason = mutation.reason;
    return result;
  }

  /* ---------------------------------------------------------------- *
   * Phase 2 低层变更方法（契约 §4；视图的 Modal 入口最终都落到这三个）
   * 三者都走 mutateFile → applyMutation：安全闸门 → 1.0→1.1 升格 →
   * 三段写回 → 幂等校验；`now` 显式传入，保证 document.updatedAt 与节点 updatedAt 一致。
   * ---------------------------------------------------------------- */

  /**
   * 契约 §4.2：在 `parentId` 的 children 末尾追加新节点。
   * 默认值由引擎的 `appendChildNode` 负责（status=todo、progress=0、progress_max=1、startAt=now、id/noteAnchor 自动生成）；
   * 写回时 `writeBackDocument` 会自动补出 `### {title} ^{childId}` 纪要段落。
   * 标题被清洗（含 # / | / [ / ] 等）时通过 `warnings` 回传，由视图转成 Notice。
   */
  async addChildNode(file: TFile, parentId: string, input: AddChildInput): Promise<AddChildNodeResult> {
    const now = new Date();
    const holder: { childId?: string; warnings: string[] } = { warnings: [] };
    const mutation = await this.mutateFile(
      file,
      (document) => {
        const edit = appendChildNodeInDocument(document, parentId, input, now);
        holder.warnings = edit.warnings;
        if (!edit.ok) return { reject: edit.reason ?? t("reject.addChildFailed", { id: parentId }) };
        if (edit.childId !== undefined) holder.childId = edit.childId;
        return { changedNodeIds: edit.changedNodeIds };
      },
      now,
    );

    const result: AddChildNodeResult = {
      success: mutation.success,
      file: file.path,
      nodeId: parentId,
      changed: mutation.changed,
      issues: mutation.analysis.issues,
      changedNodeIds: mutation.changedNodeIds,
    };
    if (mutation.reason !== undefined) result.reason = mutation.reason;
    if (holder.childId !== undefined) result.childId = holder.childId;
    if (holder.warnings.length > 0) result.warnings = holder.warnings;
    return result;
  }

  /**
   * 契约 §4.3：删除本节点（timeEntries/relations 摊平进父节点、children 原位上移、
   * 正文纪要段落按 `removedNoteAnchors` 删掉）。
   * Phase 9：`mergeLinks` 决定被删节点纪要段里的超链接是否合并进父节点（删除弹窗二选一）。
   * 根节点与带 `archive`（1.3）的节点由引擎拒绝——视图侧已置灰，这里只是防御性兜底。
   */
  async deleteNode(file: TFile, nodeId: string, mergeLinks = true): Promise<DeleteNodeResult> {
    const now = new Date();
    const holder: { parentId?: string } = {};
    const mutation = await this.mutateFile(
      file,
      (document) => {
        const edit = removeNodeInDocument(document, nodeId, now, { mergeNoteSection: mergeLinks });
        if (!edit.ok) return { reject: edit.reason ?? t("reject.deleteFailed", { id: nodeId }) };
        if (edit.parentId !== undefined) holder.parentId = edit.parentId;
        return {
          changedNodeIds: edit.changedNodeIds,
          removedNoteAnchors: edit.removedNoteAnchors,
          mergeNoteSections: edit.mergeNoteSections,
        };
      },
      now,
    );

    const result: DeleteNodeResult = {
      success: mutation.success,
      file: file.path,
      nodeId,
      changed: mutation.changed,
      issues: mutation.analysis.issues,
      changedNodeIds: mutation.changedNodeIds,
      mergeLinks,
    };
    if (mutation.reason !== undefined) result.reason = mutation.reason;
    if (holder.parentId !== undefined) result.parentId = holder.parentId;
    return result;
  }

  /**
   * Phase 15：拖拽改节点顺序（契约 §③，只改 `children` 的归属 / 顺序，schema 仍 1.9）。
   *
   * 与 `appendChildNode` / `removeNode` 同一套路：引擎在内存里改好 → `mutateFile` 一次写回。
   * 引擎判「拓扑没变」（拖回原位）时 mutator 返回 `changed: false` → 不写盘、不刷 `updatedAt`。
   */
  async moveNode(
    file: TFile,
    movingId: string,
    targetId: string,
    position: ReorderPosition,
  ): Promise<ReorderResult> {
    const now = new Date();
    const mutation = await this.mutateFile(
      file,
      (document) => {
        const edit = moveNodeInDocument(document, movingId, targetId, position, now);
        if (!edit.ok) {
          const reason = edit.reason ?? t("view.notify.reorderFailed", { reason: t("view.notify.unknownReason") });
          return { reject: reason };
        }
        if (edit.unchanged === true) return { changed: false, changedNodeIds: [] };
        return { changedNodeIds: edit.changedNodeIds };
      },
      now,
    );

    const result: ReorderResult = {
      success: mutation.success,
      file: file.path,
      changed: mutation.changed,
      issues: mutation.analysis.issues,
      changedNodeIds: mutation.changedNodeIds,
    };
    if (mutation.reason !== undefined) result.reason = mutation.reason;
    return result;
  }

  /* ---------------------------------------------------------------- *
   * Phase 3 计时写回（契约 §5）：开始 / 结束并记录 / 结束并丢弃
   * 两个方法都走 mutateFile → applyMutation；节点级 updatedAt 由 timerEdits 维护。
   * ---------------------------------------------------------------- */

  /**
   * 契约 §5.1：「▶️ 开始这个任务」——追加一条进行中的条目。
   * 并发闸门在引擎侧（全文件已有进行中的计时 → 拒绝并指出是哪个节点）。
   */
  async startTimer(file: TFile, nodeId: string): Promise<TimerChangeResult> {
    const now = new Date();
    const holder: { entryIndex?: number } = {};
    const mutation = await this.mutateFile(
      file,
      (document) => {
        const edit = startTimerEntry(document, nodeId, now);
        if (!edit.ok) return { reject: edit.reason ?? t("reject.startTimerFailed", { id: nodeId }) };
        if (edit.entryIndex !== undefined) holder.entryIndex = edit.entryIndex;
        return { changedNodeIds: edit.changedNodeIds };
      },
      now,
    );
    return this.timerResult(mutation, file, nodeId, holder.entryIndex);
  }

  /**
   * 契约 §5.2：「⏹ 结束并记录」= `record`（补 endAt + hours）；「🗑 结束并丢弃」= `discard`（删掉这条）。
   * `record` 时若开始时间失效（endAt < startAt）由引擎拒绝并提示改用「结束并丢弃」。
   */
  async stopTimer(file: TFile, nodeId: string, mode: StopTimerMode): Promise<TimerChangeResult> {
    const now = new Date();
    const holder: { entryIndex?: number } = {};
    const mutation = await this.mutateFile(
      file,
      (document) => {
        const edit = stopTimerEntry(document, nodeId, mode, now);
        if (!edit.ok) {
          const fallback =
      mode === "record"
        ? t("reject.stopRecordFailed", { id: nodeId })
        : t("reject.stopDiscardFailed", { id: nodeId });
          return { reject: edit.reason ?? fallback };
        }
        if (edit.entryIndex !== undefined) holder.entryIndex = edit.entryIndex;
        return { changedNodeIds: edit.changedNodeIds };
      },
      now,
    );
    const result = this.timerResult(mutation, file, nodeId, holder.entryIndex);
    result.mode = mode;
    return result;
  }

  /** 计时动作 → 视图返回（与 setNodeStatus 同形，另带 changedNodeIds / entryIndex） */
  private timerResult(
    mutation: MutationResult,
    file: TFile,
    nodeId: string,
    entryIndex?: number,
  ): TimerChangeResult {
    const result: TimerChangeResult = {
      success: mutation.success,
      file: file.path,
      nodeId,
      changed: mutation.changed,
      issues: mutation.analysis.issues,
      changedNodeIds: mutation.changedNodeIds,
    };
    if (mutation.reason !== undefined) result.reason = mutation.reason;
    if (entryIndex !== undefined) result.entryIndex = entryIndex;
    return result;
  }

  /* ---------------------------------------------------------------- *
   * Phase 5 ② 编辑节点信息（契约「Phase 5 定稿契约」②）
   * 分字段 6 项：summary / type / importance / progress / owner / dueAt；
   * 内存改动在引擎 nodeEdits.editNodeInfo（patch 覆盖 / clear 删除 / 其余不动）。
   * ---------------------------------------------------------------- */

  /**
   * 低层：逐字段改节点信息（`clear` 里的字段被删除，`patch` 里的被覆盖，其余不动）。
   * 一个字都没改 → 引擎给 `unchanged` → 这里 `changed=false`（不写盘）。
   */
  async setNodeInfo(
    file: TFile,
    nodeId: string,
    patch: NodeInfoPatch,
    clear: readonly NodeInfoFieldKey[],
  ): Promise<NodeInfoChangeResult> {
    const now = new Date();
    const mutation = await this.mutateFile(
      file,
      (document) => {
        const edit = editNodeInfoInDocument(document, nodeId, patch, clear, now);
        if (!edit.ok) return { reject: edit.reason ?? t("reject.editFailed", { id: nodeId }) };
        if (edit.unchanged === true) return { changed: false };
        return { changedNodeIds: edit.changedNodeIds };
      },
      now,
    );

    const result: NodeInfoChangeResult = {
      success: mutation.success,
      file: file.path,
      nodeId,
      changed: mutation.changed,
      issues: mutation.analysis.issues,
      changedNodeIds: mutation.changedNodeIds,
    };
    if (mutation.reason !== undefined) result.reason = mutation.reason;
    return result;
  }

  /** 「✏️ 编辑节点信息…」：Modal 分字段表单 → `setNodeInfo` */
  async editNodeInfo(file: TFile, node: WfNode): Promise<ModalEditOutcome<NodeInfoChangeResult>> {
    const save = (patch: NodeInfoPatch, clear: readonly NodeInfoFieldKey[]): Promise<NodeInfoChangeResult> =>
      this.setNodeInfo(file, node.id, patch, clear);
    const outcome = await new NodeInfoModal(this.app, node, save).openAndWait();
    return outcome === undefined ? { cancelled: true } : { cancelled: false, result: outcome };
  }

  /* ---------------------------------------------------------------- *
   * Phase 5 ③ 修改工作流（契约「Phase 5 定稿契约」③）：增删 + 分字段编辑
   * 增删 = 「根节点的增减」（一个 workflow 必有且只有一个 root）；
   * 内存改动与整批预检都在引擎 workflowEdits.ts，这里只做编排。
   * ---------------------------------------------------------------- */

  /**
   * 低层：整批应用工作流改动（**一次写回**）。
   *
   * 引擎 `applyWorkflowEdits` 先整批预检（id 存在性 / 删除护栏 / 字段合法性），
   * 任一条不过 → `reject`，`applyMutation` 直接返回原文（一个字都不落盘）；
   * `structureChanged = true`（有增删）时视图要整块重渲染，否则按 `changedNodeIds` 局部刷新。
   */
  async applyWorkflowPlan(file: TFile, plan: WorkflowEditPlan): Promise<WorkflowChangeResult> {
    const now = new Date();
    const holder: { structureChanged: boolean } = { structureChanged: false };
    const mutation = await this.mutateFile(
      file,
      (document) => {
        const edit = applyWorkflowEdits(document, plan, now);
        holder.structureChanged = edit.structureChanged;
        if (!edit.ok) return { reject: edit.reason ?? t("reject.workflowFailed") };
        if (edit.changedNodeIds.length === 0 && !edit.structureChanged) return { changed: false };
        return { changedNodeIds: edit.changedNodeIds, removedNoteAnchors: edit.removedNoteAnchors };
      },
      now,
    );

    const result: WorkflowChangeResult = {
      success: mutation.success,
      file: file.path,
      changed: mutation.changed,
      issues: mutation.analysis.issues,
      changedNodeIds: mutation.changedNodeIds,
      // 被拒绝 / 无改动时不能说「结构变了」——否则视图会白重渲染一次
      structureChanged: mutation.success && mutation.changed && holder.structureChanged,
    };
    if (mutation.reason !== undefined) result.reason = mutation.reason;
    return result;
  }

  /** 契约 §③ 低层：新增一个工作流（自带新 root，追加到 `workflows[]` 末尾） */
  async addWorkflow(file: TFile, patch: WorkflowPatch): Promise<WorkflowChangeResult> {
    return this.applyWorkflowPlan(file, { additions: [patch] });
  }

  /** 契约 §③ 低层：删除一个工作流（连根带全部节点，以及正文里的纪要段落） */
  async deleteWorkflow(file: TFile, workflowId: string): Promise<WorkflowChangeResult> {
    return this.applyWorkflowPlan(file, { removals: [workflowId] });
  }

  /** 契约 §③ 低层：逐字段改一个工作流（patch 覆盖 / clear 删除 / 其余不动） */
  async setWorkflowInfo(
    file: TFile,
    workflowId: string,
    patch: WorkflowPatch,
    clear: readonly WorkflowEditFieldKey[],
  ): Promise<WorkflowChangeResult> {
    return this.applyWorkflowPlan(file, { edits: [{ id: workflowId, patch, clear }] });
  }

  /**
   * 「⚙️ 修改工作流…」：先只读地读一遍文件拿当前 `workflows[]`（Modal 的初值），
   * 用户保存后把整批改动交给 `applyWorkflowPlan`（一次写回、整批预检）。
   * 读不到可用文档时直接返回结构化失败（不弹一个没有初值的空表单）。
   */
  async editWorkflows(file: TFile): Promise<ModalEditOutcome<WorkflowChangeResult>> {
    const analysis = await this.analyzeFile(file);
    const wfDoc = analysis.latestDocument ?? analysis.document;
    if (!analysis.found || wfDoc === undefined) {
      return {
        cancelled: false,
        result: {
          success: false,
          file: file.path,
          changed: false,
          reason: t("reject.noBlock"),
          issues: analysis.issues,
          changedNodeIds: [],
          structureChanged: false,
        },
      };
    }

    const save = (plan: WorkflowEditPlan): Promise<WorkflowChangeResult> => this.applyWorkflowPlan(file, plan);
    const outcome = await new WorkflowEditorModal(this.app, wfDoc.workflows, save).openAndWait();
    return outcome === undefined ? { cancelled: true } : { cancelled: false, result: outcome };
  }

  /* ---------------------------------------------------------------- *
   * Phase 4 归档写回（契约 §4）：planArchive → 建归档 md → 浓缩本节点
   * 顺序很重要：归档 md 先落盘（在 vault 里），原文件写回在后 —— 反过来一旦
   * 写回失败就会出现「节点已浓缩但归档 md 不存在」的死引用。
   * ---------------------------------------------------------------- */

  /**
   * 契约 §4.1：把 `nodeId` 及其后代浓缩进 `archive/<workflowId>-<nodeId>.md`。
   *
   *  - 先只读地算一遍计划（`planArchive` 内部会再跑一次资格检查：根 / 叶子 / 已归档 /
   *    子树里有非 done 的节点 → 直接拒绝，**一个字节都不写**）；
   *  - 归档 md 用 `vault.create`（不 `createIfAbsent` 覆盖）：路径已存在就**复用它**，
   *    并采用那份文件里记着的 `workflowId`（幂等重试：用户补写过正文也不会被冲掉）；
   *  - 最后 `mutateFile` 把原文件里的子树压成一个带 `archive` 的 done 节点
   *    （`writeBackDocument` 顺带删掉被浓缩后代的正文纪要段落）。
   */
  async archiveNode(file: TFile, node: WfNode, form: ArchiveFormInput = {}): Promise<ArchiveNodeResult> {
    const now = new Date();
    const noteMarkdown = await this.app.vault.read(file);
    const analysis = await this.analyzeNoteText(file, noteMarkdown);
    const wfDoc = analysis.latestDocument ?? analysis.document;
    if (!analysis.found || wfDoc === undefined) {
      return {
        success: false,
        file: file.path,
        nodeId: node.id,
        changed: false,
        reason: t("reject.noBlock"),
        issues: analysis.issues,
        changedNodeIds: [],
      };
    }

    // Phase 9：归档 md 要复制正文纪要
    //   - 笔记模式：本笔记正文（上面已读，避免二次读盘）
    const sourceMarkdown = noteMarkdown;

    const planned = planArchive(wfDoc, node.id, form, now, sourceMarkdown);
    if (!planned.ok || planned.plan === undefined) {
      return {
        success: false,
        file: file.path,
        nodeId: node.id,
        changed: false,
        reason: planned.reason ?? t("reject.cannotArchive", { id: node.id }),
        issues: analysis.issues,
        changedNodeIds: [],
      };
    }
    const plan = planned.plan;

    const archive: WfArchive = { ...plan.archive };
    let archiveFile = plan.file;
    let reusedArchiveFile = false;
    const existing = await this.findArchiveFileForNode(node.id);
    if (existing !== undefined) {
      // 幂等重试：上次已经在磁盘上建好了那份归档 md（可能写回原文件时失败了），照用
      reusedArchiveFile = true;
      archiveFile = existing.path;
      if (existing.workflowId !== undefined) archive.workflowId = existing.workflowId;
    } else {
      await this.createArchiveFile(plan.file, plan.markdown);
    }

    const mutation = await this.mutateFile(
      file,
      (document) => {
        const edit = archiveNodeInDocument(document, node.id, archive, now);
        if (!edit.ok) return { reject: edit.reason ?? t("reject.archiveFailed", { id: node.id }) };
        return {
          changedNodeIds: edit.changedNodeIds,
          removedNoteAnchors: edit.removedNoteAnchors,
          // v0.7 §⑨-2：归档地址写进浓缩节点**自己的**纪要段（JSON 里不再存 `archive.file`）
          mergeNoteSections: [
            { targetNodeId: node.id, lines: [renderArchiveNoteLine(archiveFile, form.summary)] },
          ],
        };
      },
      now,
    );

    const result: ArchiveNodeResult = {
      success: mutation.success,
      file: file.path,
      nodeId: node.id,
      changed: mutation.changed,
      issues: mutation.analysis.issues,
      changedNodeIds: mutation.changedNodeIds,
      archiveFile,
      workflowId: archive.workflowId,
      nodeCount: plan.nodeCount,
      reusedArchiveFile,
    };
    if (mutation.reason !== undefined) result.reason = mutation.reason;
    return result;
  }

  /** 归档目录（没有就建）：幂等重试要扫它，新建归档 md 也落在里面 */
  private async ensureArchiveFolder(): Promise<void> {
    if (this.app.vault.getAbstractFileByPath(ARCHIVE_FOLDER) !== null) return;
    await this.app.vault.createFolder(ARCHIVE_FOLDER);
  }

  /**
   * 幂等重试的锚：`archive/` 里有没有这个节点上次建的归档 md。
   * 先按路径特征找（`archive/<任意 workflowId>-<nodeId>.md`，见 `isArchivePathForNode`），
   * 再读回文件头里的 `originId` 核对 —— 只有 `originId === nodeId` 才认（同名旧文件不算）。
   */
  private async findArchiveFileForNode(nodeId: string): Promise<{ path: string; workflowId?: string } | undefined> {
    await this.ensureArchiveFolder();
    const folder = this.app.vault.getAbstractFileByPath(ARCHIVE_FOLDER) as { children?: unknown[] } | null;
    const children = folder?.children;
    if (!Array.isArray(children)) return undefined;

    for (const child of children) {
      const path = (child as { path?: unknown }).path;
      if (typeof path !== "string" || !isArchivePathForNode(path, nodeId)) continue;
      const markdown = await this.app.vault.read(child as TFile);
      const identity = readArchivedWorkflowIdentity(markdown);
      if (identity.originId !== nodeId) continue;
      const found: { path: string; workflowId?: string } = { path };
      if (identity.workflowId !== undefined) found.workflowId = identity.workflowId;
      return found;
    }
    return undefined;
  }

  /** 建归档 md：路径已存在就沿用（绝不覆盖 —— 用户可能已经补写过正文） */
  private async createArchiveFile(path: string, markdown: string): Promise<void> {
    await this.ensureArchiveFolder();
    if (this.app.vault.getAbstractFileByPath(path) !== null) return;
    await this.app.vault.create(path, markdown);
  }

  /* ---------------------------------------------------------------- *
   * Phase 2 / Phase 4 Modal 入口（契约 §7）：视图只调这几个，弹窗与写盘都在插件侧
   * ---------------------------------------------------------------- */

  /** 「➕ 添加子节点…」：Modal 里填标题 / 重要度 / 标签 → addChildNode */
  async promptAddChild(file: TFile, node: WfNode): Promise<ModalEditOutcome<AddChildNodeResult>> {
    const save = (input: AddChildInput): Promise<AddChildNodeResult> => this.addChildNode(file, node.id, input);
    const outcome = await new NewChildModal(this.app, node, save).openAndWait();
    return outcome === undefined ? { cancelled: true } : { cancelled: false, result: outcome };
  }

  /** 「🗑 删除本节点」：二次确认（二选一）→ deleteNode */
  async confirmDeleteNode(file: TFile, node: WfNode): Promise<ModalEditOutcome<DeleteNodeResult>> {
    const save = (mergeLinks: boolean): Promise<DeleteNodeResult> => this.deleteNode(file, node.id, mergeLinks);
    const outcome = await new ConfirmDeleteModal(this.app, node, save).openAndWait();
    return outcome === undefined ? { cancelled: true } : { cancelled: false, result: outcome };
  }

  /** 「📦 为此及之后归档…」：收集三段文字 → archiveNode（建归档 md + 浓缩本节点） */
  async promptArchiveNode(file: TFile, node: WfNode): Promise<ModalEditOutcome<ArchiveNodeResult>> {
    const save = (form: ArchiveFormInput): Promise<ArchiveNodeResult> => this.archiveNode(file, node, form);
    const outcome = await new ArchiveNodeModal(this.app, node, save).openAndWait();
    return outcome === undefined ? { cancelled: true } : { cancelled: false, result: outcome };
  }

  /**
   * dataviewjs 视图入口：笔记里只写一行
   *
   * ```dataviewjs
   * await app.plugins.plugins["wfjson-workflow"].render(dv);
   * // 也可显式指定本视图主题（优先于 frontmatter wf-theme / 全局默认）：
   * await app.plugins.plugins["wfjson-workflow"].render(dv, { theme: "tech" });
   * ```
   */
  async render(dv: unknown, options: WfViewOptions = {}): Promise<void> {
    if (!isViewApi(dv)) {
      new Notice(t("notice.noDv"));
      return;
    }
    await renderWorkflowView(this, dv, options);
  }

  /** 视图要的提示通道（视图不直接依赖 Obsidian 运行时，便于单测） */
  notify(message: string): void {
    new Notice(message);
  }

  /**
   * Phase 16：视图侧边栏的「⚙️ 插件设置」。
   *
   * Obsidian 没有公开 API，这里走内部对象 `app.setting`（`open()` + `openTabById(id)`，
   * 社区插件的通用写法）。版本差异 / 对象被禁用时**只提示、不抛错** —— 设置页打不开不该影响视图。
   */
  openSettings(): void {
    const setting = (this.app as unknown as {
      setting?: { open?: () => void; openTabById?: (id: string) => void };
    }).setting;
    if (setting?.open === undefined || setting.openTabById === undefined) {
      new Notice(t("notice.settingsOpenFailed"));
      return;
    }
    setting.open();
    setting.openTabById(this.manifest.id);
  }

  /* ---------------------------------------------------------------- *
   * v0.7 §⑧ 外置 JSON：目录同步（rename / delete）与手动迁移
   * ---------------------------------------------------------------- */

  /** 逐级确保目录存在（`vault.createFolder` 不保证递归建父目录） */
  private async ensureFolder(path: string): Promise<void> {
    if (path.length === 0) return;
    let cursor = "";
    for (const segment of path.split("/")) {
      cursor = cursor.length === 0 ? segment : `${cursor}/${segment}`;
      if (this.app.vault.getAbstractFileByPath(cursor) !== null) continue;
      await this.app.vault.createFolder(cursor);
    }
  }

  /**
   * 笔记 / 文件夹改名或移动 → 镜像目录里的侧车跟着走。
   * 目标已存在时**绝不覆盖**（提示用户手工处理），避免两次迁移互相踩。
   */
  private async syncSidecarOnRename(abstract: TAbstractFile, oldPath: string): Promise<void> {
    if (isSidecarPath(oldPath) || isSidecarPath(abstract.path)) return;
    try {
      if (abstract instanceof TFolder) {
        const from = `${WFJSON_FOLDER}/${oldPath}`;
        const to = `${WFJSON_FOLDER}/${abstract.path}`;
        const folder = this.app.vault.getAbstractFileByPath(from);
        if (!(folder instanceof TFolder)) return;
        if (this.app.vault.getAbstractFileByPath(to) !== null) {
          new Notice(t("notice.sidecarExists", { path: to }));
          return;
        }
        await this.ensureFolder(parentFolderOf(to));
        await this.app.fileManager.renameFile(folder, to);
        return;
      }

      if (!(abstract instanceof TFile) || abstract.extension !== "md") return;
      const sidecar = this.app.vault.getAbstractFileByPath(sidecarPathFor(oldPath));
      if (!(sidecar instanceof TFile)) return;
      const target = sidecarPathFor(abstract.path);
      if (this.app.vault.getAbstractFileByPath(target) !== null) {
        new Notice(t("notice.sidecarExists", { path: target }));
        return;
      }
      await this.ensureFolder(parentFolderOf(target));
      await this.app.fileManager.renameFile(sidecar, target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.error(`wfjson：同步外置 JSON 失败（rename ${oldPath} → ${abstract.path}）`, error);
      new Notice(t("notice.renameFailed", { message }));
    }
  }

  /** 删除笔记 / 文件夹 → 侧车一起进回收站（尊重 Obsidian「删除时移到回收站」设置） */
  private async syncSidecarOnDelete(abstract: TAbstractFile): Promise<void> {
    if (isSidecarPath(abstract.path)) return;
    try {
      const target =
        abstract instanceof TFolder
          ? this.app.vault.getAbstractFileByPath(`${WFJSON_FOLDER}/${abstract.path}`)
          : abstract instanceof TFile && abstract.extension === "md"
            ? this.app.vault.getAbstractFileByPath(sidecarPathFor(abstract.path))
            : null;
      if (!(target instanceof TFile) && !(target instanceof TFolder)) return;
      await this.app.fileManager.trashFile(target);
    } catch (error) {
      console.error(`wfjson：删除笔记时同步外置 JSON 失败（${abstract.path}）`, error);
    }
  }

  /** 命令「迁移当前文件到外置 JSON」：只迁移当前激活的 md */
  private async migrateActiveFileToSidecar(): Promise<void> {
    const file = this.activeMarkdownFile();
    if (!file) return;
    const outcome = await this.migrateFileToSidecar(file);
    if (outcome.ok) {
      new Notice(t("notice.migrated", { path: sidecarPathFor(file.path) }));
    } else if (outcome.skipped) {
      new Notice(t("notice.nothingToMigrate"));
    } else {
      new Notice(t("notice.notMigrated", { reason: outcome.reason ?? t("common.unknownReason") }));
    }
  }

  /**
   * 把一个笔记里的 wfjson 代码块搬进 `_wfjson/…`（**先侧车、后笔记**）。
   *
   *  - 侧车已存在：内容相同 → 只清理笔记里的遗留代码块（幂等重试）；内容不同 → 拒绝，绝不覆盖；
   *  - 笔记写回时若发现正文已被改动 → 在新的正文上重写纪要段（不覆盖用户刚写的内容）。
   */
  private async migrateFileToSidecar(file: TFile): Promise<{ ok: boolean; skipped: boolean; reason?: string }> {
    const now = new Date();
    const noteMarkdown = await this.app.vault.read(file);
    const plan = planSidecarMigration(noteMarkdown, file.path, { now });
    if (!plan.success) return { ok: false, skipped: plan.skipped, reason: plan.reason };
    if (plan.document === undefined) return { ok: false, skipped: false, reason: t("reject.planMissingDoc") };

    const existing = this.app.vault.getAbstractFileByPath(plan.sidecarPath);
    if (existing !== null) {
      if (!(existing instanceof TFile)) {
        return { ok: false, skipped: false, reason: t("reject.sidecarOccupied", { path: plan.sidecarPath }) };
      }
      const current = await this.app.vault.read(existing);
      if (current !== plan.jsonText) {
        return { ok: false, skipped: false, reason: t("reject.sidecarDifferent", { path: plan.sidecarPath }) };
      }
    } else {
      await this.ensureFolder(parentFolderOf(plan.sidecarPath));
      await this.app.vault.create(plan.sidecarPath, plan.jsonText);
    }

    const document = plan.document;
    await this.app.vault.process(file, (text) => {
      if (text === noteMarkdown) return plan.noteMarkdown;
      // 计划之后笔记又被改过：在新的正文上重写纪要段，绝不覆盖用户的新内容
      return writeBackNote(removeWfJsonBlocks(text).markdown, document, { now }).markdown;
    });
    return { ok: true, skipped: false };
  }

  private async checkFile(file: TFile): Promise<void> {
    const result = await this.analyzeFile(file);

    if (!result.hasIssue) {
      new Notice(t("notice.checkOk", { path: file.path }));
      return;
    }

    const { error, warning, info } = result.counts;
    new Notice(t("notice.checkResult", { error, warning, info }));
    new AnalyzeResultModal(this.app, result).open();
  }
}

/** 展示分析结果（文本由引擎的 formatAnalyzeResult 生成，含行号与修复提示） */
class AnalyzeResultModal extends Modal {
  private readonly result: AnalyzeResult;

  constructor(app: App, result: AnalyzeResult) {
    super(app);
    this.result = result;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h3", { text: t("dialog.analyze.title") });
    contentEl.createEl("pre", {
      text: formatAnalyzeResult(this.result, { headline: this.result.file ?? t("notice.unnamedFile") }),
      cls: "wfjson-analyze-result",
    });
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/* ------------------------------------------------------------------ *
 * Phase 2 的三个 Modal（契约 §6）
 * ------------------------------------------------------------------ */

/**
 * Modal 基类：把「打开 → 等用户选完 → 拿到结果」包成 Promise。
 *
 * Obsidian 的 `Modal` 只有 `onOpen` / `onClose` 回调，没有返回值，所以这里补一个
 * `openAndWait()`：确认时子类调 `finish(value)` → 关窗并 resolve(value)；
 * 取消 / Esc / 点遮罩关闭 → resolve(undefined)。调用方据此区分「取消」（静默）与「失败」（提示）。
 */
abstract class WfModal<T> extends Modal {
  private resolveOnce: ((value: T | undefined) => void) | null = null;
  private settled = false;

  /** 打开弹窗并等待结果；用户取消时返回 undefined */
  async openAndWait(): Promise<T | undefined> {
    const promise = new Promise<T | undefined>((resolve) => {
      this.resolveOnce = resolve;
    });
    this.open();
    return promise;
  }

  /** 子类在「确认」成功时调用（关窗时不会再被当成取消） */
  protected finish(value: T): void {
    this.settle(value);
    this.close();
  }

  onClose(): void {
    this.settle(undefined);
    this.contentEl.empty();
  }

  private settle(value: T | undefined): void {
    if (this.settled) return;
    this.settled = true;
    const resolve = this.resolveOnce;
    this.resolveOnce = null;
    resolve?.(value);
  }
}

/** Modal 里的一行「标签 + 控件」（样式在 styles.css：.wfjson-field） */
function fieldRow(parent: HTMLElement, label: string, required = false): HTMLElement {
  const row = parent.createDiv({ cls: "wfjson-field" });
  const labelEl = row.createEl("label", { cls: "wfjson-field-label" });
  labelEl.createEl("span", { text: label });
  if (required) labelEl.createEl("span", { text: " *", cls: "wfjson-required" });
  return row;
}

/** 三个日期输入框（年 / 月 / 日），保存时合成 `YYYY-MM-DDT00:00:00` */
interface DueDateInputs {
  year: HTMLInputElement;
  month: HTMLInputElement;
  day: HTMLInputElement;
}

function pad2(value: number): string {
  return `${value}`.padStart(2, "0");
}

/** 「今天 + days 天」的本地日期（`YYYY-MM-DD`；默认截止日 = 一周后） */
function localDateAfter(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`;
}

/** 已有 `dueAt` → `YYYY-MM-DD`；没有时可选给默认值（新增条目用「一周后」） */
function dueDateParts(value: string | undefined, fallback?: string): { y: string; m: string; d: string } {
  const text = (value ?? fallback ?? "").trim().slice(0, 10);
  const [y = "", m = "", d = ""] = text.split("-");
  return { y, m, d };
}

/** 一行「年 / 月 / 日」三文本框（必填星号由调用方在标签上标） */
function dueDateField(parent: HTMLElement, label: string, value: string | undefined, fallback?: string): DueDateInputs {
  const row = fieldRow(parent, label);
  const box = row.createDiv({ cls: "wfjson-date" });
  const parts = dueDateParts(value, fallback);
  const year = box.createEl("input", { type: "text", cls: "wfjson-input wfjson-date-year" });
  year.placeholder = t("field.year");
  year.value = parts.y;
  const month = box.createEl("input", { type: "text", cls: "wfjson-input wfjson-date-month" });
  month.placeholder = t("field.month");
  month.value = parts.m;
  const day = box.createEl("input", { type: "text", cls: "wfjson-input wfjson-date-day" });
  day.placeholder = t("field.day");
  day.value = parts.d;
  return { year, month, day };
}

/**
 * 读「年 / 月 / 日」：全空 = 清空（`{}`）；只填一部分 / 非法日期 → `reason`；
 * 合法 → `YYYY-MM-DDT00:00:00`（与 `checkIsoTimestamp` 的纯日期写法一致）。
 */
function readDueDate(inputs: DueDateInputs | null, label: string): { value?: string; reason?: string } {
  const y = inputs?.year.value.trim() ?? "";
  const m = inputs?.month.value.trim() ?? "";
  const d = inputs?.day.value.trim() ?? "";
  if (y.length === 0 && m.length === 0 && d.length === 0) return {};
  if (y.length === 0 || m.length === 0 || d.length === 0) {
    return { reason: t("error.dateIncomplete", { label }) };
  }
  if (!/^\d{4}$/.test(y)) return { reason: t("error.dateYear", { label, value: y }) };
  if (!/^\d{1,2}$/.test(m) || !/^\d{1,2}$/.test(d)) {
    return { reason: t("error.dateNotNumber", { label, month: m, day: d }) };
  }
  const year = Number(y);
  const month = Number(m);
  const day = Number(d);
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return { reason: t("error.dateInvalid", { label, value: `${y}-${m}-${d}` }) };
  }
  return { value: `${year}-${pad2(month)}-${pad2(day)}T00:00:00` };
}

/**
 * 「➕ 添加子节点」Modal（Phase 9 表单口径）：
 * 标题必填（红 `*`）；进度 / 总量、重要度 / 紧急度、负责人 / 截止日各占一行两列；
 * 截止日 = 年 / 月 / 日 三文本框，新增时默认「今天 + 7 天」。
 * 其余默认值（status=todo、startAt=现在、id / 锚点自动生成）仍由 `appendChildNode` 决定。
 */
class NewChildModal extends WfModal<AddChildNodeResult> {
  private readonly parent: WfNode;
  private readonly save: (input: AddChildInput) => Promise<AddChildNodeResult>;
  private titleInput: HTMLInputElement | null = null;
  private progressInput: HTMLInputElement | null = null;
  private progressMaxInput: HTMLInputElement | null = null;
  private importanceSelect: HTMLSelectElement | null = null;
  private urgencySelect: HTMLSelectElement | null = null;
  private ownerInput: HTMLInputElement | null = null;
  private dueAtInputs: DueDateInputs | null = null;
  private errorEl: HTMLElement | null = null;
  private saveButton: HTMLButtonElement | null = null;

  constructor(app: App, parent: WfNode, save: (input: AddChildInput) => Promise<AddChildNodeResult>) {
    super(app);
    this.parent = parent;
    this.save = save;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("wfjson-modal");
    contentEl.createEl("h3", { text: t("dialog.addChild.title", { title: this.parent.title }) });
    contentEl.createEl("p", {
      cls: "wfjson-modal-hint",
      text: t("dialog.addChild.desc"),
    });

    const titleRow = fieldRow(contentEl, t("field.title"), true);
    const titleInput = titleRow.createEl("input", { type: "text", cls: "wfjson-input" });
    titleInput.placeholder = t("dialog.addChild.titlePlaceholder");
    titleInput.addEventListener("keydown", (event: KeyboardEvent) => {
      if (event.key === "Enter") void this.onConfirm();
    });
    this.titleInput = titleInput;

    const grid = contentEl.createDiv({ cls: "wfjson-workflow-grid" });
    this.progressInput = this.numberField(grid, t("field.progress"), undefined, 0, 999);
    this.progressMaxInput = this.numberField(grid, t("field.progressMax"), undefined, 0, 999);
    this.importanceSelect = this.scaleField(grid, t("field.importance"), undefined, IMPORTANCE_LABELS);
    this.urgencySelect = this.scaleField(grid, t("field.urgency"), undefined, URGENCY_LABELS);
    this.ownerInput = this.textField(grid, t("field.ownerOptional"), "");
    this.dueAtInputs = dueDateField(grid, t("field.dueAtDefault"), undefined, localDateAfter(7));

    this.errorEl = contentEl.createDiv({ cls: "wfjson-modal-error" });

    const footer = contentEl.createDiv({ cls: "wfjson-modal-footer" });
    const cancel = footer.createEl("button", { text: t("common.cancel") });
    cancel.onclick = (): void => this.close();
    const confirm = footer.createEl("button", { text: t("common.add"), cls: "mod-cta" });
    confirm.onclick = (): void => void this.onConfirm();
    this.saveButton = confirm;

    titleInput.focus();
  }

  private numberField(
    parent: HTMLElement,
    label: string,
    value: number | undefined,
    min: number,
    max: number,
  ): HTMLInputElement {
    const row = fieldRow(parent, label);
    const input = row.createEl("input", {
      type: "number",
      cls: "wfjson-input",
      attr: { min: `${min}`, max: `${max}`, step: "1" },
    });
    if (value !== undefined) input.value = `${value}`;
    return input;
  }

  private textField(parent: HTMLElement, label: string, value: string): HTMLInputElement {
    const row = fieldRow(parent, label);
    const input = row.createEl("input", { type: "text", cls: "wfjson-input" });
    input.value = value;
    return input;
  }

  private scaleField(
    parent: HTMLElement,
    label: string,
    value: number | undefined,
    labels: Readonly<Record<number, string>>,
  ): HTMLSelectElement {
    const row = fieldRow(parent, label);
    const select = row.createEl("select", { cls: "wfjson-input" });
    select.createEl("option", { value: "", text: t("common.unset") });
    for (const [key, text] of Object.entries(labels)) {
      select.createEl("option", { value: key, text: `${key} · ${text}` });
    }
    select.value = value === undefined ? "" : `${value}`;
    return select;
  }

  private async onConfirm(): Promise<void> {
    this.setError("");

    const rawTitle = this.titleInput?.value ?? "";
    // 与引擎同一套清洗：空 / 含换行 → 就地拒绝；含 # | [ ] → 放行（提示交给视图 Notice）
    const sanitized = sanitizeTitle(rawTitle);
    if (!sanitized.ok) {
      this.setError(sanitized.reason ?? t("error.invalidTitle"));
      return;
    }

    const input: AddChildInput = { title: rawTitle };
    const progress = readOptionalInt(this.progressInput, t("nodeinfo.progress"), 0, 999);
    if (progress.reason !== undefined) {
      this.setError(progress.reason);
      return;
    }
    if (progress.value !== undefined) input.progress = progress.value;
    const progressMax = readOptionalInt(this.progressMaxInput, t("nodeinfo.progress_max"), 0, 999);
    if (progressMax.reason !== undefined) {
      this.setError(progressMax.reason);
      return;
    }
    if (progressMax.value !== undefined) input.progress_max = progressMax.value;
    const importance = this.importanceSelect?.value ?? "";
    if (importance.length > 0) input.importance = Number(importance);
    const urgency = this.urgencySelect?.value ?? "";
    if (urgency.length > 0) input.urgency = Number(urgency);
    const owner = this.ownerInput?.value.trim() ?? "";
    if (owner.length > 0) input.owner = owner;
    const dueAt = readDueDate(this.dueAtInputs, t("field.dueDate"));
    if (dueAt.reason !== undefined) {
      this.setError(dueAt.reason);
      return;
    }
    if (dueAt.value !== undefined) input.dueAt = dueAt.value;

    const button = this.saveButton;
    if (button) button.disabled = true;
    try {
      const result = await this.save(input);
      if (!result.success) {
        const detail = formatIssues(result.issues, { maxIssues: 8 });
        this.setError(
          t("error.notWritten", {
            reason: result.reason ?? t("common.unknownReason"),
            detail: detail.length > 0 ? `\n${detail}` : "",
          }),
        );
        return;
      }
      this.finish(result);
    } finally {
      if (button) button.disabled = false;
    }
  }

  private setError(message: string): void {
    if (this.errorEl) this.errorEl.setText(message);
  }
}


/**
 * 「🗑 删除本节点」Modal（Phase 9）：不可撤销，所以把「会发生什么」逐条列出来，
 * 并让用户二选一：超链接合并进上级条目（默认）/ 删除超链接。确认后才删除。
 * 计数取自视图传进来的节点；真正的拒绝逻辑仍在引擎里（根节点 / 带 archive 的节点）。
 */
class ConfirmDeleteModal extends WfModal<DeleteNodeResult> {
  private readonly node: WfNode;
  private readonly save: (mergeLinks: boolean) => Promise<DeleteNodeResult>;
  private mergeInput: HTMLInputElement | null = null;
  private errorEl: HTMLElement | null = null;
  private deleteButton: HTMLButtonElement | null = null;

  constructor(app: App, node: WfNode, save: (mergeLinks: boolean) => Promise<DeleteNodeResult>) {
    super(app);
    this.node = node;
    this.save = save;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("wfjson-modal");
    contentEl.addClass("wfjson-modal-danger");
    contentEl.createEl("h3", { text: t("dialog.delete.title") });
    contentEl.createEl("p", { text: t("dialog.delete.desc", { title: this.node.title }) });

    const childCount = this.node.children?.length ?? 0;
    const relationCount = this.node.relations?.length ?? 0;
    const list = contentEl.createEl("ul", { cls: "wfjson-modal-danger-list" });
    list.createEl("li", { text: t("dialog.delete.itemSelf", { id: this.node.id }) });
    if (childCount > 0) list.createEl("li", { text: t("dialog.delete.itemChildren", { count: childCount }) });
    if (relationCount > 0) {
      list.createEl("li", { text: t("dialog.delete.itemRelations", { count: relationCount }) });
    }

    const choice = contentEl.createDiv({ cls: "wfjson-delete-choice" });
    choice.createDiv({ cls: "wfjson-delete-choice-title", text: t("dialog.delete.linksLabel") });
    const mergeRow = choice.createEl("label", { cls: "wfjson-radio" });
    const mergeInput = mergeRow.createEl("input", {
      type: "radio",
      attr: { name: "wf-delete-links", value: "merge" },
    });
    mergeInput.checked = true;
    this.mergeInput = mergeInput;
    mergeRow.createEl("span", { text: t("dialog.delete.mergeLinks") });
    const dropRow = choice.createEl("label", { cls: "wfjson-radio" });
    const dropInput = dropRow.createEl("input", {
      type: "radio",
      attr: { name: "wf-delete-links", value: "drop" },
    });
    dropInput.checked = false;
    dropRow.createEl("span", { text: t("dialog.delete.dropLinks") });

    this.errorEl = contentEl.createDiv({ cls: "wfjson-modal-error" });

    const footer = contentEl.createDiv({ cls: "wfjson-modal-footer" });
    const cancel = footer.createEl("button", { text: t("common.cancel") });
    cancel.onclick = (): void => this.close();
    const remove = footer.createEl("button", { text: t("common.delete"), cls: "mod-warning" });
    remove.onclick = (): void => void this.onConfirm();
    this.deleteButton = remove;
  }

  private async onConfirm(): Promise<void> {
    this.setError("");

    const button = this.deleteButton;
    if (button) button.disabled = true;
    try {
      const result = await this.save(this.mergeInput?.checked !== false);
      if (!result.success) {
        this.setError(t("error.notWritten", { reason: result.reason ?? t("common.unknownReason"), detail: "" }));
        return;
      }
      this.finish(result);
    } finally {
      if (button) button.disabled = false;
    }
  }

  private setError(message: string): void {
    if (this.errorEl) this.errorEl.setText(message);
  }
}


/**
 * 「📦 为此及之后归档」Modal：收集三段文字（概括 / 原理 / 复盘，都选填）再确认。
 *
 * 与「删除」同级的一次性动作，所以先把「会发生什么」摊开：子树会被压成一个带 `archive`
 * 的 done 节点、归档 md 建在 `archive/`（路径确定）、后代的原 id 不会保留（不做追溯）。
 * 计数取自视图传进来的节点；拒绝逻辑（根 / 叶子 / 已归档 / 有未完成后代）仍在引擎里兜底。
 */
class ArchiveNodeModal extends WfModal<ArchiveNodeResult> {
  private readonly node: WfNode;
  private readonly save: (form: ArchiveFormInput) => Promise<ArchiveNodeResult>;
  private summaryInput: HTMLTextAreaElement | null = null;
  private ideaInput: HTMLTextAreaElement | null = null;
  private reviewInput: HTMLTextAreaElement | null = null;
  private errorEl: HTMLElement | null = null;
  private saveButton: HTMLButtonElement | null = null;

  constructor(app: App, node: WfNode, save: (form: ArchiveFormInput) => Promise<ArchiveNodeResult>) {
    super(app);
    this.node = node;
    this.save = save;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("wfjson-modal");
    contentEl.addClass("wfjson-modal-danger");
    contentEl.createEl("h3", { text: t("dialog.archive.title") });
    contentEl.createEl("p", { text: t("dialog.archive.desc", { title: this.node.title }) });

    const descendants = collectDescendants(this.node);
    const unfinished = [this.node, ...collectDescendants(this.node)].filter((item) => item.status !== "done");
    const list = contentEl.createEl("ul", { cls: "wfjson-modal-danger-list" });
    list.createEl("li", {
      text: t("dialog.archive.itemFile", { total: descendants.length + 1, descendants: descendants.length }),
    });
    list.createEl("li", { text: t("dialog.archive.itemLocal") });
    list.createEl("li", { text: t("dialog.archive.itemIds") });
    if (unfinished.length > 0) {
      list.createEl("li", { text: t("dialog.archive.itemUnfinished", { count: unfinished.length }) });
    }

    const hint = contentEl.createDiv({ cls: "wfjson-modal-hint" });
    hint.setText(t("dialog.archive.hint"));

    this.summaryInput = this.textareaRow(contentEl, t("field.outline"), t("dialog.archive.summaryPlaceholder"));
    this.ideaInput = this.textareaRow(contentEl, t("field.idea"), t("dialog.archive.ideaPlaceholder"));
    this.reviewInput = this.textareaRow(contentEl, t("field.review"), t("dialog.archive.reviewPlaceholder"));

    this.errorEl = contentEl.createDiv({ cls: "wfjson-modal-error" });

    const footer = contentEl.createDiv({ cls: "wfjson-modal-footer" });
    const cancel = footer.createEl("button", { text: t("common.cancel") });
    cancel.onclick = (): void => this.close();
    const confirm = footer.createEl("button", { text: t("common.archive"), cls: "mod-warning" });
    confirm.onclick = (): void => void this.onConfirm();
    this.saveButton = confirm;

    this.summaryInput.focus();
  }

  /** 一行「标签 + 多行文本框」（样式在 styles.css：.wfjson-archive-input） */
  private textareaRow(parent: HTMLElement, label: string, placeholder: string): HTMLTextAreaElement {
    const row = fieldRow(parent, label);
    const input = row.createEl("textarea", { cls: "wfjson-archive-input", attr: { rows: "3" } });
    input.placeholder = placeholder;
    return input;
  }

  private async onConfirm(): Promise<void> {
    this.setError("");

    const form: ArchiveFormInput = {};
    const summary = this.summaryInput?.value.trim() ?? "";
    const idea = this.ideaInput?.value.trim() ?? "";
    const review = this.reviewInput?.value.trim() ?? "";
    if (summary.length > 0) form.summary = summary;
    if (idea.length > 0) form.idea = idea;
    if (review.length > 0) form.review = review;

    const button = this.saveButton;
    if (button) button.disabled = true;
    try {
      const result = await this.save(form);
      if (!result.success) {
        const detail = formatIssues(result.issues, { maxIssues: 8 });
        this.setError(
          t("error.notArchived", {
            reason: result.reason ?? t("common.unknownReason"),
            detail: detail.length > 0 ? `\n${detail}` : "",
          }),
        );
        return;
      }
      this.finish(result);
    } finally {
      if (button) button.disabled = false;
    }
  }

  private setError(message: string): void {
    if (this.errorEl) this.errorEl.setText(message);
  }
}


/* ------------------------------------------------------------------ *
 * Phase 5 ② 编辑节点信息 Modal（契约「Phase 5 定稿契约」②）
 * ------------------------------------------------------------------ */

/**
 * 读一个「可空整数」输入框：空 → `value: undefined`（= 清空该字段）；
 * 非法（不是数字 / 不是整数 / 越界）→ `reason`（与引擎同一句中文，Modal 就地显示）。
 */
function readOptionalInt(
  input: HTMLInputElement | null,
  label: string,
  min: number,
  max: number,
): { value?: number; reason?: string } {
  const raw = input?.value.trim() ?? "";
  if (raw.length === 0) return {};
  const value = Number(raw);
  if (!Number.isFinite(value)) return { reason: t("error.numberInvalid", { label, raw }) };
  const reason = checkIntegerInRange(label, value, min, max);
  return reason !== undefined ? { reason } : { value };
}

/**
 * 读一个「可空 1-4 下拉框」：空 → `value: undefined`（= 清空该字段）；
 * 非法（不是数字 / 不是整数 / 越界）→ `reason`（与引擎同一句中文，Modal 就地显示）。
 */
function readOptionalScale(
  select: HTMLSelectElement | null,
  label: string,
  min: number,
  max: number,
): { value?: number; reason?: string } {
  const raw = select?.value.trim() ?? "";
  if (raw.length === 0) return {};
  const value = Number(raw);
  if (!Number.isFinite(value)) return { reason: t("error.numberInvalid", { label, raw }) };
  const reason = checkIntegerInRange(label, value, min, max);
  return reason !== undefined ? { reason } : { value };
}

/**
 * 「✏️ 编辑节点信息」（Phase 7）：**分字段表单**（不手写 JSON）。
 *
 * 保存规则（与引擎 `editNodeInfo` 同一套语义）：
 *  - 非空 → 进 `patch`（覆盖）；空 → 进 `clear`（删除该键；Schema 的 `TEXT` 是 minLength 1，不写空串）；
 *  - `title` 必填（红色 *）；`progress` / `progress_max` 允许 0-999；`importance` / `urgency` 1-4（下拉框显示可读文字）；
 *  - `dueAt` 用日期选择器，写回时自动补 `T00:00:00`；不合法就地报错、**保持打开**；
 *  - 写回被拒（引擎护栏 / 幂等校验 / 节点已被别处删掉）同样保持打开，把原因与 issues 摆出来。
 */
class NodeInfoModal extends WfModal<NodeInfoChangeResult> {
  private readonly node: WfNode;
  private readonly save: (patch: NodeInfoPatch, clear: readonly NodeInfoFieldKey[]) => Promise<NodeInfoChangeResult>;
  private titleInput: HTMLInputElement | null = null;
  private summaryInput: HTMLTextAreaElement | null = null;
  private typeInput: HTMLInputElement | null = null;
  private importanceInput: HTMLSelectElement | null = null;
  private urgencyInput: HTMLSelectElement | null = null;
  private progressInput: HTMLInputElement | null = null;
  private progressMaxInput: HTMLInputElement | null = null;
  private ownerInput: HTMLInputElement | null = null;
  private dueAtInputs: DueDateInputs | null = null;
  private errorEl: HTMLElement | null = null;
  private saveButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    node: WfNode,
    save: (patch: NodeInfoPatch, clear: readonly NodeInfoFieldKey[]) => Promise<NodeInfoChangeResult>,
  ) {
    super(app);
    this.node = node;
    this.save = save;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("wfjson-modal");
    contentEl.createEl("h3", { text: t("dialog.editNode.title", { title: this.node.title }) });
    contentEl.createEl("p", {
      cls: "wfjson-modal-hint",
      text: t("dialog.editNode.desc"),
    });

    // 字段顺序（Phase 9）：title → progress / progress_max → importance / urgency → owner / dueAt
    // → summary → type。必填项用红色 * 标出。
    const titleRow = fieldRow(contentEl, nodeInfoLabel("title"), true);
    titleRow.addClass("wfjson-row-required");
    const titleInput = titleRow.createEl("input", { type: "text", cls: "wfjson-input" });
    titleInput.placeholder = t("dialog.editNode.titlePlaceholder");
    titleInput.value = this.node.title;
    this.titleInput = titleInput;

    const grid = contentEl.createDiv({ cls: "wfjson-workflow-grid" });
    this.progressInput = this.numberField(
      grid,
      `${nodeInfoLabel("progress")}${t("suffix.range0to999")}`,
      this.node.progress,
      0,
      999,
    );
    this.progressMaxInput = this.numberField(
      grid,
      `${nodeInfoLabel("progress_max")}${t("suffix.range0to999")}`,
      this.node.progress_max,
      0,
      999,
    );
    this.importanceInput = this.scaleField(
      grid,
      `${nodeInfoLabel("importance")}${t("suffix.range1to4")}`,
      this.node.importance,
      IMPORTANCE_LABELS,
    );
    this.urgencyInput = this.scaleField(
      grid,
      `${nodeInfoLabel("urgency")}${t("suffix.range1to4")}`,
      this.node.urgency,
      URGENCY_LABELS,
    );
    this.ownerInput = this.textField(grid, `${nodeInfoLabel("owner")}${t("suffix.optional")}`, this.node.owner ?? "");
    this.dueAtInputs = dueDateField(grid, `${nodeInfoLabel("dueAt")}${t("suffix.optional")}`, this.node.dueAt);
    this.dueAtInputs.year.placeholder = t("field.yearDefault");

    const summaryRow = fieldRow(contentEl, `${nodeInfoLabel("summary")}${t("suffix.optional")}`);
    const summaryInput = summaryRow.createEl("textarea", { cls: "wfjson-textarea", attr: { rows: "3" } });
    summaryInput.placeholder = t("dialog.editNode.summaryPlaceholder");
    summaryInput.value = this.node.summary ?? "";
    this.summaryInput = summaryInput;

    const typeRow = fieldRow(contentEl, `${nodeInfoLabel("type")}${t("suffix.optional")}`);
    const typeListId = "wfjson-node-type-options";
    const typeInput = typeRow.createEl("input", { type: "text", cls: "wfjson-input", attr: { list: typeListId } });
    typeInput.placeholder = NODE_TYPE_SUGGESTIONS.slice(0, 3).join(" / ");
    typeInput.value = this.node.type ?? "";
    const datalist = typeRow.createEl("datalist", { attr: { id: typeListId } });
    for (const suggestion of NODE_TYPE_SUGGESTIONS) datalist.createEl("option", { value: suggestion });
    this.typeInput = typeInput;

    this.errorEl = contentEl.createDiv({ cls: "wfjson-modal-error" });

    const footer = contentEl.createDiv({ cls: "wfjson-modal-footer" });
    const cancel = footer.createEl("button", { text: t("common.cancel") });
    cancel.onclick = (): void => this.close();
    const save = footer.createEl("button", { text: t("common.save"), cls: "mod-cta" });
    save.onclick = (): void => void this.onConfirm();
    this.saveButton = save;

    titleInput.focus();
  }

  /** 两列网格里的一行数字输入（可空） */
  private numberField(
    parent: HTMLElement,
    label: string,
    value: number | undefined,
    min: number,
    max: number,
  ): HTMLInputElement {
    const row = fieldRow(parent, label);
    const input = row.createEl("input", {
      type: "number",
      cls: "wfjson-input",
      attr: { min: `${min}`, max: `${max}`, step: "1" },
    });
    if (value !== undefined) input.value = `${value}`;
    return input;
  }

  /** 两列网格里的一行文本输入 */
  private textField(parent: HTMLElement, label: string, value: string): HTMLInputElement {
    const row = fieldRow(parent, label);
    const input = row.createEl("input", { type: "text", cls: "wfjson-input" });
    input.value = value;
    return input;
  }

  /** 1-4 的可读下拉框（未设置 = 空值 → clear） */
  private scaleField(
    parent: HTMLElement,
    label: string,
    value: number | undefined,
    labels: Readonly<Record<number, string>>,
  ): HTMLSelectElement {
    const row = fieldRow(parent, label);
    const select = row.createEl("select", { cls: "wfjson-input" });
    select.createEl("option", { value: "", text: t("common.unset") });
    for (const [key, text] of Object.entries(labels)) {
      select.createEl("option", { value: key, text: `${key} · ${text}` });
    }
    select.value = value === undefined ? "" : `${value}`;
    return select;
  }

  private async onConfirm(): Promise<void> {
    this.setError("");

    const patch: NodeInfoPatch = {};
    const clear: NodeInfoFieldKey[] = [];

    const title = this.titleInput?.value.trim() ?? "";
    if (title.length === 0) {
      this.setError(t("error.titleEmpty"));
      return;
    }
    patch.title = title;

    const summary = this.summaryInput?.value.trim() ?? "";
    if (summary.length > 0) patch.summary = summary;
    else clear.push("summary");
    const type = this.typeInput?.value.trim() ?? "";
    if (type.length > 0) patch.type = type;
    else clear.push("type");
    const owner = this.ownerInput?.value.trim() ?? "";
    if (owner.length > 0) patch.owner = owner;
    else clear.push("owner");

    const dueAt = readDueDate(this.dueAtInputs, nodeInfoLabel("dueAt"));
    if (dueAt.reason !== undefined) {
      this.setError(dueAt.reason);
      return;
    }
    if (dueAt.value !== undefined) patch.dueAt = dueAt.value;
    else clear.push("dueAt");

    const importance = readOptionalScale(this.importanceInput, nodeInfoLabel("importance"), 1, 4);
    if (importance.reason !== undefined) {
      this.setError(importance.reason);
      return;
    }
    if (importance.value !== undefined) patch.importance = importance.value;
    else clear.push("importance");

    const urgency = readOptionalScale(this.urgencyInput, nodeInfoLabel("urgency"), 1, 4);
    if (urgency.reason !== undefined) {
      this.setError(urgency.reason);
      return;
    }
    if (urgency.value !== undefined) patch.urgency = urgency.value;
    else clear.push("urgency");

    const progress = readOptionalInt(this.progressInput, nodeInfoLabel("progress"), 0, 999);
    if (progress.reason !== undefined) {
      this.setError(progress.reason);
      return;
    }
    if (progress.value !== undefined) patch.progress = progress.value;
    else clear.push("progress");

    const progressMax = readOptionalInt(this.progressMaxInput, nodeInfoLabel("progress_max"), 0, 999);
    if (progressMax.reason !== undefined) {
      this.setError(progressMax.reason);
      return;
    }
    if (progressMax.value !== undefined) patch.progress_max = progressMax.value;
    else clear.push("progress_max");

    const button = this.saveButton;
    if (button) button.disabled = true;
    try {
      const result = await this.save(patch, clear);
      if (!result.success) {
        const detail = formatIssues(result.issues, { maxIssues: 8 });
        this.setError(
          t("error.notWritten", {
            reason: result.reason ?? t("common.unknownReason"),
            detail: detail.length > 0 ? `\n${detail}` : "",
          }),
        );
        return;
      }
      this.finish(result);
    } finally {
      if (button) button.disabled = false;
    }
  }

  private setError(message: string): void {
    if (this.errorEl) this.errorEl.setText(message);
  }
}

/* ------------------------------------------------------------------ *
 * Phase 5 ③ 修改工作流 Modal（契约「Phase 5 定稿契约」③）
 * ------------------------------------------------------------------ */

/**
 * 一个工作流表单区里的控件（v1.6 去掉 rootTitle；v0.7 §⑨ 去掉 tags、新增 state；
 * Phase 14 去掉工作流级 `progress` / `progress_max`，只剩根节点那一对）。
 *
 * 字段顺序 = 表单里的 DOM 顺序（Phase 14 定稿）：标题 → 类型 / 状态 →
 * `progress` / `progress_max` → 重要度 / 紧急度 → 负责人 / 截止时间 → 概要。
 */
interface WorkflowEntryControls {
  title: HTMLInputElement;
  type: HTMLInputElement;
  /** v0.7 §⑨-8：进行中（空值）/ 完成 / 取消 */
  state: HTMLSelectElement;
  summary: HTMLTextAreaElement;
}

/** Modal 里的一个条目：已有工作流（有 `id`）或新增条目（无 `id`） */
interface WorkflowEntry {
  /** 已有工作流的 id；新增条目为 undefined（保存时进 `plan.additions`） */
  id?: string;
  /** 原始标题（删除确认语用；用户改了输入框也不影响它） */
  originalTitle: string;
  controls: WorkflowEntryControls;
  section: HTMLDetailsElement;
  summaryEl: HTMLElement;
  confirmEl: HTMLElement;
  /** 用户已就地确认删除（保存时进 `plan.removals`） */
  removed: boolean;
}

/**
 * 「⚙️ 修改工作流…」（Phase 5 ③）：**一次写回整批改动**。
 *
 *  - 每个工作流一个 `<details>` 折叠区，字段顺序（Phase 14 定稿）：
 *    ① 标题（跨两列）② 类型 / 状态 ③ 已完成 / 总量（= 根节点的 `progress` /
 *    `progress_max`）④ 重要度 / 紧急度 ⑤ 负责人 / 截止时间 ⑥ 概要（跨两列）
 *    ⑦ 删除这个工作流（跨两列）；
 *  - 工作流级 `progress` / `progress_max` **不再出现在表单里**（Phase 14）——
 *    保存时既不 patch 也不 clear 这两个键，JSON 里已有的值原样保留；
 *  - 删除是**就地二次确认**（不用 `window.confirm`：那会阻塞渲染，也不能带上下文）；
 *  - 保存时把「删除 + 编辑 + 新增」拼成一个 `WorkflowEditPlan` 交给引擎整批预检；
 *    任一条不合法 → 整批不写、Modal 保持打开并显示原因。
 */
class WorkflowEditorModal extends WfModal<WorkflowChangeResult> {
  private readonly workflows: readonly WfWorkflow[];
  private readonly save: (plan: WorkflowEditPlan) => Promise<WorkflowChangeResult>;
  private readonly entries: WorkflowEntry[] = [];
  private listEl: HTMLElement | null = null;
  private errorEl: HTMLElement | null = null;
  private saveButton: HTMLButtonElement | null = null;

  constructor(
    app: App,
    workflows: readonly WfWorkflow[],
    save: (plan: WorkflowEditPlan) => Promise<WorkflowChangeResult>,
  ) {
    super(app);
    this.workflows = workflows;
    this.save = save;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("wfjson-modal");
    contentEl.createEl("h3", { text: t("dialog.workflows.title") });
    contentEl.createEl("p", {
      cls: "wfjson-modal-hint",
      text: t("dialog.workflows.desc"),
    });

    this.listEl = contentEl.createDiv({ cls: "wfjson-workflow-list" });
    for (const workflow of this.workflows) this.addEntry(workflow);

    const addRow = contentEl.createDiv({ cls: "wfjson-workflow-add" });
    const add = addRow.createEl("button", { text: t("dialog.workflows.add") });
    add.onclick = (): void => this.addEntry(undefined);

    this.errorEl = contentEl.createDiv({ cls: "wfjson-modal-error" });

    const footer = contentEl.createDiv({ cls: "wfjson-modal-footer" });
    const cancel = footer.createEl("button", { text: t("common.cancel") });
    cancel.onclick = (): void => this.close();
    const save = footer.createEl("button", { text: t("common.save"), cls: "mod-cta" });
    save.onclick = (): void => void this.onConfirm();
    this.saveButton = save;
  }

  /** 追加一个工作流表单区（`workflow` 缺省 = 新增条目） */
  private addEntry(workflow: WfWorkflow | undefined): void {
    const listEl = this.listEl;
    if (listEl === null) return;
    const root = workflow?.root;

    const section = listEl.createEl("details", { cls: "wfjson-workflow-entry" });
    section.open = true;
    const summaryEl = section.createEl("summary", {
      text: workflow !== undefined ? ` ${workflow.title}` : t("dialog.workflows.newEntry"),
    });

    const grid = section.createDiv({ cls: "wfjson-workflow-grid" });
    // Phase 14：DOM 顺序 = ① 标题（跨两列）② 类型 / 状态 ③ 已完成 / 总量
    // ④ 重要度 / 紧急度 ⑤ 负责人 / 截止时间 ⑥ 概要（跨两列）⑦ 删除（跨两列，见下）
    const controls: WorkflowEntryControls = {
      title: this.textField(grid, workflowEditLabel("title"), workflow?.title ?? "", true, true),
      type: this.textField(grid, workflowEditLabel("type"), root?.type ?? ""),
      state: this.stateField(grid, workflowEditLabel("state"), workflow?.state),
      summary: this.textareaField(grid, workflowEditLabel("summary"), root?.summary ?? ""),
    };

    // v0.7 §⑨-3：删除入口与就地二次确认放**同一行**（红框包住删除选项区）
    const removeRow = grid.createDiv({ cls: "wfjson-field wfjson-workflow-wide wfjson-workflow-remove" });
    const removeButton = removeRow.createEl("button", { text: t("dialog.workflows.remove") });

    const entry: WorkflowEntry = {
      originalTitle: workflow?.title ?? "",
      controls,
      section,
      summaryEl,
      confirmEl: removeRow.createDiv({ cls: "wfjson-workflow-confirm wfjson-workflow-confirm--hidden" }),
      removed: false,
    };
    if (workflow !== undefined) entry.id = workflow.id;
    this.entries.push(entry);

    // 标题一改就同步 <summary>（一眼看出正在改哪一条）
    controls.title.addEventListener("input", () => this.refreshSummary(entry));
    removeButton.onclick = (): void => this.askRemove(entry);
  }

  /** 就地二次确认：确认后才标记 `removed`（保存时才真正删，取消还能反悔） */
  private askRemove(entry: WorkflowEntry): void {
    const confirm = entry.confirmEl;
    confirm.empty();
    confirm.removeClass("wfjson-workflow-confirm--hidden");
    confirm.createEl("span", {
      text:
        entry.id !== undefined
          ? t("dialog.workflows.confirmDelete", { title: entry.originalTitle })
          : t("dialog.workflows.confirmDiscard"),
    });
    const ok = confirm.createEl("button", { text: t("common.confirmDelete"), cls: "mod-warning" });
    ok.onclick = (): void => {
      entry.removed = true;
      entry.section.addClass("wfjson-workflow-entry--removed");
      confirm.empty();
      confirm.addClass("wfjson-workflow-confirm--hidden");
      this.setError("");
      this.refreshSummary(entry);
    };
    const undo = confirm.createEl("button", { text: t("common.cancel") });
    undo.onclick = (): void => {
      confirm.empty();
      confirm.addClass("wfjson-workflow-confirm--hidden");
    };
  }

  /** `<summary>` 文字：标题 +（保存后新增 / 保存后删除）标记 */
  private refreshSummary(entry: WorkflowEntry): void {
    const typed = entry.controls.title.value.trim();
    const name = typed.length > 0 ? typed : entry.originalTitle.length > 0 ? entry.originalTitle : t("common.untitled");
    if (entry.removed) entry.summaryEl.setText(t("dialog.workflows.markedRemoved", { name }));
    else if (entry.id === undefined) entry.summaryEl.setText(t("dialog.workflows.markedAdded", { name }));
    else entry.summaryEl.setText(` ${name}`);
  }

  /** 单行文本框；`wide = true` 时整行跨两列（Phase 14：工作流标题独占第一行） */
  private textField(
    parent: HTMLElement,
    label: string,
    value: string,
    required = false,
    wide = false,
  ): HTMLInputElement {
    const row = fieldRow(parent, label, required);
    if (wide) row.addClass("wfjson-workflow-wide");
    const input = row.createEl("input", { type: "text", cls: "wfjson-input" });
    input.value = value;
    return input;
  }

  private numberField(
    parent: HTMLElement,
    label: string,
    value: number | undefined,
    min: number,
    max: number,
  ): HTMLInputElement {
    const row = fieldRow(parent, label);
    const input = row.createEl("input", {
      type: "number",
      cls: "wfjson-input",
      attr: { min: `${min}`, max: `${max}`, step: "1" },
    });
    if (value !== undefined) input.value = `${value}`;
    return input;
  }

  /** 1-4 的可读下拉框（未设置 = 空值 → clear） */
  private scaleField(
    parent: HTMLElement,
    label: string,
    value: number | undefined,
    labels: Readonly<Record<number, string>>,
  ): HTMLSelectElement {
    const row = fieldRow(parent, label);
    const select = row.createEl("select", { cls: "wfjson-input" });
    select.createEl("option", { value: "", text: t("common.unset") });
    for (const [key, text] of Object.entries(labels)) {
      select.createEl("option", { value: key, text: `${key} · ${text}` });
    }
    select.value = value === undefined ? "" : `${value}`;
    return select;
  }

  /**
   * 工作流状态下拉（v0.7 §⑨-8）：`进行中` = 空值（保存时删键），
   * `完成` = `archived`，`取消` = `cancelled`。
   */
  private stateField(
    parent: HTMLElement,
    label: string,
    value: WorkflowState | undefined,
  ): HTMLSelectElement {
    const row = fieldRow(parent, label);
    const select = row.createEl("select", { cls: "wfjson-input" });
    select.createEl("option", { value: "", text: t("dialog.workflows.stateActive") });
    select.createEl("option", { value: "archived", text: t("dialog.workflows.stateDone") });
    select.createEl("option", { value: "cancelled", text: t("dialog.workflows.stateCancelled") });
    select.value = value ?? "";
    return select;
  }

  /** 概要占满两列（多行） */
  private textareaField(parent: HTMLElement, label: string, value: string): HTMLTextAreaElement {
    const row = fieldRow(parent, label);
    row.addClass("wfjson-workflow-wide");
    const input = row.createEl("textarea", { cls: "wfjson-textarea", attr: { rows: "2" } });
    input.value = value;
    return input;
  }

  /**
   * 把一个条目读成 `patch` / `clear`（语义与引擎一致：非空 → 覆盖，空 → 删除键）。
   * 非法值返回 `reason`（Modal 就地报错，连请求都不发）。
   */
  private collectEntry(entry: WorkflowEntry): {
    patch: WorkflowPatch;
    clear: WorkflowEditFieldKey[];
    reason?: string;
  } {
    const patch: WorkflowPatch = {};
    const clear: WorkflowEditFieldKey[] = [];
    const controls = entry.controls;

    const title = controls.title.value.trim();
    if (title.length === 0) {
      return { patch, clear, reason: t("error.workflowTitleEmpty") };
    }
    patch.title = title;

    const summary = controls.summary.value.trim();
    if (summary.length > 0) patch.summary = summary;
    else clear.push("summary");
    const type = controls.type.value.trim();
    if (type.length > 0) patch.type = type;
    else clear.push("type");
    /*const owner = controls.owner.value.trim();
    if (owner.length > 0) patch.owner = owner;
    else clear.push("owner");

    const dueAt = readDueDate(controls.dueAt, workflowEditLabel("dueAt"));
    if (dueAt.reason !== undefined) return { patch, clear, reason: dueAt.reason };
    if (dueAt.value !== undefined) patch.dueAt = dueAt.value;
    else clear.push("dueAt");*/

    // v0.7 §⑨-8：工作流状态（空 = 进行中 → 删键；完成 / 取消 → archived / cancelled）
    const state = controls.state.value;
    if (state === "archived" || state === "cancelled") patch.state = state;
    else clear.push("state");

    // Phase 14：工作流级 `progress` / `progress_max` 已从表单移除 —— 这里**不碰**
    // 这两个键（既不 patch 也不 clear），JSON 里已有的值原样保留。
    /*const rootProgress = readOptionalInt(controls.rootProgress, workflowEditLabel("rootProgress"), 0, 999);
    if (rootProgress.reason !== undefined) return { patch, clear, reason: rootProgress.reason };
    if (rootProgress.value !== undefined) patch.rootProgress = rootProgress.value;
    else clear.push("rootProgress");

    const rootProgressMax = readOptionalInt(
      controls.rootProgressMax,
      workflowEditLabel("rootProgressMax"),
      0,
      999,
    );
    if (rootProgressMax.reason !== undefined) return { patch, clear, reason: rootProgressMax.reason };
    if (rootProgressMax.value !== undefined) patch.rootProgressMax = rootProgressMax.value;
    else clear.push("rootProgressMax");

    const importance = readOptionalScale(controls.importance, workflowEditLabel("importance"), 1, 4);
    if (importance.reason !== undefined) return { patch, clear, reason: importance.reason };
    if (importance.value !== undefined) patch.importance = importance.value;
    else clear.push("importance");

    const urgency = readOptionalScale(controls.urgency, workflowEditLabel("urgency"), 1, 4);
    if (urgency.reason !== undefined) return { patch, clear, reason: urgency.reason };
    if (urgency.value !== undefined) patch.urgency = urgency.value;
    else clear.push("urgency");*/

    return { patch, clear };
  }

  private async onConfirm(): Promise<void> {
    this.setError("");
    const plan: WorkflowEditPlan = { edits: [], additions: [], removals: [] };

    for (const entry of this.entries) {
      if (entry.removed) {
        // 已有工作流 → 删除；新增条目被「删除」= 直接丢弃，什么也不提交
        if (entry.id !== undefined) plan.removals?.push(entry.id);
        continue;
      }
      const collected = this.collectEntry(entry);
      if (collected.reason !== undefined) {
        this.setError(
        t("error.withName", {
          name: entry.summaryEl.textContent ?? t("common.workflow"),
          reason: collected.reason,
        }),
      );
        return;
      }
      if (entry.id === undefined) plan.additions?.push(collected.patch);
      else plan.edits?.push({ id: entry.id, patch: collected.patch, clear: collected.clear });
    }

    const button = this.saveButton;
    if (button) button.disabled = true;
    try {
      const result = await this.save(plan);
      if (!result.success) {
        const detail = formatIssues(result.issues, { maxIssues: 8 });
        this.setError(
          t("error.notWritten", {
            reason: result.reason ?? t("common.unknownReason"),
            detail: detail.length > 0 ? `\n${detail}` : "",
          }),
        );
        return;
      }
      this.finish(result);
    } finally {
      if (button) button.disabled = false;
    }
  }

  private setError(message: string): void {
    if (this.errorEl) this.errorEl.setText(message);
  }
}

/**
 * 插件设置面板（Phase 3 视图微调 v0.6 / v0.7；Phase 6 增「主题」）。
 *
 * 两个设置项：① 「主题」写 `<html data-wf-theme="…">`（styles.css 按它切整套 token）；
 * ② 「计时器字号」写根元素 CSS 变量 `--wf-timer-font-size`（styles.css 的 `.wf-timer-clock` 读它）。
 * 值都存 `data.json`（`loadData` / `saveData`）；用户也可以在自己的 CSS snippet 里覆盖同一套变量。
 */
class WfJsonSettingTab extends PluginSettingTab {
  private readonly plugin: WfJsonWorkflowPlugin;

  constructor(app: App, plugin: WfJsonWorkflowPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h3", { text: t("settings.heading") });

    new Setting(containerEl)
      .setName(t("settings.lang.name"))
      .setDesc(t("settings.lang.desc"))
      .addDropdown((dropdown) => {
        for (const option of LANG_OPTIONS) dropdown.addOption(option.key, option.label);
        dropdown.setValue(this.plugin.settings.lang).onChange(async (value) => {
          this.plugin.settings.lang = normalizeLang(value);
          await this.plugin.saveSettings();
          // 立刻生效：命令 / 设置面板 / 下一次视图渲染都按新语言输出（已渲染的块需重绘才切换）
          setLang(this.plugin.settings.lang);
          this.display();
        });
      });

    new Setting(containerEl)
      .setName(t("settings.theme.name"))
      .setDesc(`${t("settings.theme.desc")} ${t("settings.theme.descTail")}`)
      .addDropdown((dropdown) => {
        for (const theme of this.plugin.themes) dropdown.addOption(theme.key, theme.label);
        dropdown
          .setValue(this.plugin.defaultTheme)
          .onChange((value) => this.plugin.setTheme(value));
      });

    new Setting(containerEl)
      .setName(t("settings.timerFontSize.name"))
      .setDesc(t("settings.timerFontSize.desc"))
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.timerFontSize)
          .setValue(this.plugin.settings.timerFontSize)
          .onChange(async (value) => {
            const next = value.trim();
            this.plugin.settings.timerFontSize = next.length > 0 ? next : DEFAULT_SETTINGS.timerFontSize;
            await this.plugin.saveSettings();
            this.plugin.applyTimerFontSize();
          }),
      );

    // Phase 17：泳道正文区最大高度（超出后只在泳道内滚动，栏头固定）
    // Phase 18 ⑥：控件从滑杆换成文本框（滑杆 700~9999 只能拖 100 的整数倍，填精确值太别扭）
    new Setting(containerEl)
      .setName(t("settings.laneHeight.name"))
      .setDesc(t("settings.laneHeight.desc"))
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.laneScrollHeight))
          .setValue(String(this.plugin.settings.laneScrollHeight))
          .onChange(async (value) => {
            this.plugin.settings.laneScrollHeight = normalizeLaneHeight(value);
            await this.plugin.saveSettings();
            this.plugin.applyLaneScrollHeight();
          }),
      );

    // Phase 18 ⑦：卡片宽度（写到根元素 `--wf-card-width`；未设置时 `.wf-card` 回落 200px）
    new Setting(containerEl)
      .setName(t("settings.cardWidth.name"))
      .setDesc(t("settings.cardWidth.desc"))
      .addText((text) =>
        text
          .setPlaceholder(String(DEFAULT_SETTINGS.cardWidth))
          .setValue(String(this.plugin.settings.cardWidth))
          .onChange(async (value) => {
            this.plugin.settings.cardWidth = normalizeCardWidth(value);
            await this.plugin.saveSettings();
            this.plugin.applyCardWidth();
          }),
      );

    // Phase 18 ③：渲染区顶部的大标题（留空 = 用 i18n 的「下一步是？」）
    new Setting(containerEl)
      .setName(t("settings.resumePrompt.name"))
      .setDesc(t("settings.resumePrompt.desc"))
      .addText((text) =>
        text
          .setPlaceholder(t("settings.resumePrompt.placeholder"))
          .setValue(this.plugin.settings.resumePrompt)
          .onChange(async (value) => {
            // 标题在下次渲染 / 局部刷新时读新值 → 这里不必额外触发重画
            this.plugin.settings.resumePrompt = normalizeResumePrompt(value);
            await this.plugin.saveSettings();
          }),
      );

    // Phase 18 ④-E：365 天见闻 md 的目录（第一次写入时才建目录）
    new Setting(containerEl)
      .setName(t("settings.dailyFolder.name"))
      .setDesc(t("settings.dailyFolder.desc"))
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.dailyFolder)
          .setValue(this.plugin.settings.dailyFolder)
          .onChange(async (value) => {
            this.plugin.settings.dailyFolder = normalizeDailyFolder(value);
            await this.plugin.saveSettings();
          }),
      );

    // Phase 19 M1 ①：emo 独立主题（画布上的「灵动岛」按钮也能切，两处共用同一个设置）
    new Setting(containerEl)
      .setName(t("settings.emoTheme.name"))
      .setDesc(t("settings.emoTheme.desc"))
      .addDropdown((dropdown) => {
        for (const key of EMO_THEMES) dropdown.addOption(key, t(`theme.emo.${key}`));
        dropdown.setValue(normalizeEmoTheme(this.plugin.settings.emoTheme)).onChange(async (value) => {
          this.plugin.settings.emoTheme = normalizeEmoTheme(value);
          await this.plugin.saveSettings();
        });
      });

    // Phase 19 M3：365 天 plot 的目录（`plots/plot-<uuid>.json`；第一次写入时才建目录）
    new Setting(containerEl)
      .setName(t("settings.plotFolder.name"))
      .setDesc(t("settings.plotFolder.desc"))
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.plotFolder)
          .setValue(this.plugin.settings.plotFolder)
          .onChange(async (value) => {
            this.plugin.settings.plotFolder = normalizePlotFolder(value);
            await this.plugin.saveSettings();
          }),
      );
  }
}

