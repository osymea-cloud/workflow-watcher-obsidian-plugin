/**
 * 国际化（i18n）—— Phase 10（v0.8）。
 *
 * 设计取舍：
 *  - **模块级可变状态**（`currentLang`），沿用 `views/wfView.ts` 里 `activeViewTheme` 的既有惯例：
 *    语言是全局设置，给每个分析 / 渲染函数都加一个 `lang` 参数会污染整条调用链；
 *    插件在 `onload` 与设置变更时调一次 `setLang()`，引擎后续取文案即自动切换。
 *  - **默认 `en`**（契约 §②）：没配过设置的新用户先看到英文。
 *  - `zh` 是原文案，`en` 是译文；两边 key 必须一一对应（`MESSAGES` 的类型会强制 `en` 齐全）。
 *  - 语言中性项**不进字典**：`P1-Low` 之类的 importance/urgency、`3d2h` 格式的时长、用户数据标题。
 *  - 查不到的 key 直接回显 key 本身（便于发现漏配，而不是静默显示空白）。
 */

import type { IssueCode, IssueSeverity } from "./issues.ts";
import type { NodeStatus, WorkflowState } from "./types.ts";

/** 支持的语言（`zh` 中文 / `en` 英文） */
export type Lang = "zh" | "en";

export const LANGS: readonly Lang[] = ["zh", "en"];

/** 设置面板下拉用（label 用各自语言写，方便任何语言下都能认出） */
export const LANG_OPTIONS: readonly { key: Lang; label: string }[] = [
  { key: "zh", label: "中文" },
  { key: "en", label: "English" },
];

/**
 * 当前语言。
 *
 * 注意两个「默认值」是分开的：
 *  - **引擎模块默认 `zh`**：仓库里的单测 / 纯引擎调用（不经过插件 `onload`）看到的仍是原文案，
 *    历史断言的语义不变；
 *  - **用户可见默认 `en`**：插件 `onload` 一定会用 `settings.lang` 覆盖它，而
 *    `DEFAULT_SETTINGS.lang = "en"`（契约 §②）。所以真实用户默认看到英文。
 */
let currentLang: Lang = "zh";

export function setLang(lang: Lang): void {
  currentLang = lang === "zh" ? "zh" : "en";
}

export function getLang(): Lang {
  return currentLang;
}

/** 语言校验：非法值一律回落 `en`（与 `normalizeTheme` 同形） */
export function normalizeLang(lang: unknown): Lang {
  return lang === "zh" ? "zh" : "en";
}

interface Translation {
  zh: string;
  en: string;
}

/**
 * 文案表。`{name}` 是插值占位符（见 `t()`）。
 * 只收录**展示用**的静态文案；动态数据（用户标题、id、路径）永远原样拼接。
 */
const MESSAGES = {
  /* ---- 通用 ---- */
  "severity.error": { zh: "错误", en: "Error" },
  "severity.warning": { zh: "警告", en: "Warning" },
  "severity.info": { zh: "提示", en: "Info" },

  /* ---- 节点状态 ---- */
  "status.todo": { zh: "未开始", en: "Not started" },
  "status.doing": { zh: "进行中", en: "Doing" },
  "status.done": { zh: "已完成", en: "Done" },
  "status.blocked": { zh: "受阻", en: "Blocked" },
  "status.cancelled": { zh: "已取消", en: "Cancelled" },

  /* ---- 工作流状态 ---- */
  "state.active": { zh: "进行中", en: "Active" },
  "state.doing": { zh: "进行中", en: "Active" },
  "state.archived": { zh: "已归档", en: "Archived" },
  "state.cancelled": { zh: "已取消", en: "Cancelled" },

  /* ---- 校验结果格式化（issues.ts） ---- */
  "issues.line": { zh: "第 {line} 行", en: "line {line}" },
  "issues.file": { zh: "文件：{file}", en: "File: {file}" },
  "issues.summary": {
    zh: "结果：错误 {errors} · 警告 {warnings} · 提示 {infos}",
    en: "Result: {errors} error(s) · {warnings} warning(s) · {infos} info",
  },
  "issues.none": { zh: "未发现问题。", en: "No issues found." },
  "issues.more": {
    zh: "… 另有 {count} 条问题未显示（maxIssues={max}）",
    en: "… {count} more issue(s) not shown (maxIssues={max})",
  },

  /* ---- 总览 / 计时 ---- */
  "stats.overview": {
    zh: "进行中：{doing}/{total} 阻滞：{blocked}",
    en: "Active: {doing}/{total} · Blocked: {blocked}",
  },
  "timer.invalidStart": {
    zh: "时间为负值，开始时间失效，请结束并丢弃",
    en: "Negative duration: the start time is invalid — stop and discard this entry",
  },

  /* ---- 视图：提示 / 总览 / 计时 / 热力图 / 甘特图 ---- */
  "view.renderFailed": { zh: "渲染失败", en: "Render failed" },
  "view.hint.noFile": {
    zh: "⚠️ 视图没能定位当前笔记，请在 md 笔记的 dataviewjs 代码块里调用。",
    en: "⚠️ The view could not locate the current note — call it inside a dataviewjs block in a markdown note.",
  },
  "view.hint.noBlock": {
    zh: "本文件没有 wfjson 代码块，未渲染工作流视图。",
    en: "This file has no wfjson block, so no workflow view was rendered.",
  },
  "view.hint.blocked": {
    zh: "⛔ wfjson 存在问题，已停止渲染（错误 {error} ／ 警告 {warning} ／ 提示 {info}）",
    en: "⛔ wfjson has problems; rendering stopped ({error} error(s) / {warning} warning(s) / {info} info)",
  },
  "view.overview.active": { zh: "进行中工作流 {count}", en: "Active workflows: {count}" },
  "view.overview.archived": { zh: "已归档 {count}", en: "Archived: {count}" },
  "view.overview.cancelled": { zh: "已取消 {count}", en: "Cancelled: {count}" },
  "view.overview.nodes": { zh: "节点合计 {count}", en: "Nodes total: {count}" },
  "view.theme.label": { zh: "主题", en: "Theme" },
  "view.theme.writeFailed": { zh: "主题未写入：{reason}", en: "Theme not saved: {reason}" },
  /** Phase 19 M1 ①：365 天 emo 的独立主题（`.wf-emo--<theme>`，不进 [data-wf-theme]） */
  "theme.emo.default": { zh: "默认", en: "Default" },
  "theme.emo.weave": { zh: "织布", en: "Weave" },
  "theme.emo.candy": { zh: "糖果", en: "Candy" },
  /**
   * Phase 18 ③：渲染区最顶部的大标题（引导性话语）。
   * 设置项 `resumePrompt` 为空串时用它 —— 语言一切换标题跟着变；用户填了就原样使用。
   */
  "view.appTitle.default": { zh: "接下来，想怎么做?", en: "What's next?" },
  "view.timer.running": { zh: "正在：{title}", en: "Running: {title}" },
  "view.timer.stopRecord": { zh: "结束并记录", en: "Stop and record" },
  "view.timer.stopDiscard": { zh: "结束并丢弃", en: "Stop and discard" },
  /** Phase 17：没有进行中的计时时给「继续上次」入口（上次 = 全文件 endAt 最大的那条计时） */
  "view.timer.resume": { zh: "上次：{title}", en: "Last: {title}" },
  /**
   * Phase 18 ③：resume 行收成一个按钮 —— 第一段是目标任务，第二段是动作，
   * 视图侧用 ` · ` 把两段拼在**同一个按钮**里。
   * `view.timer.resume` 保留但**不再被视图调用**（历史断言 / 其它调用点不崩）。
   */
  "view.timer.resumeTask": { zh: "上一个任务：{title}", en: "Last task: {title}" },
  "view.timer.resumeAction": { zh: "继续这个任务", en: "Continue this task" },
  "view.heatmap.title": { zh: "近 {days} 天工作时长", en: "Work time in the last {days} days" },
  "view.heatmap.tipDate": { zh: "{date}（周{weekday}）", en: "{date} ({weekday})" },
  "view.heatmap.empty": { zh: "无记录", en: "No records" },
  "view.heatmap.total": { zh: "合计 {hours} 小时", en: "Total {hours} h" },
  /** Phase 11：甘特图可折叠 —— 这里是折叠标题（收起后唯一可见的一行） */
  "view.gantt.title": {
    zh: "近 {days} 天甘特图",
    en: "Gantt chart of the last {days} days",
  },
  /** Phase 11：原标题括号里的说明下沉到折叠体内（展开才显示） */
  "view.gantt.legend": {
    zh: "按工作流着色 · 每 2 小时一条分割线",
    en: "Colored by workflow · a divider every 2 hours",
  },
  "view.gantt.crossMidnight": {
    zh: "跨零点：完整区间 {start} → {end}（这一行只画到 24:00）",
    en: "Crosses midnight: full span {start} → {end} (this row is drawn up to 24:00 only)",
  },
  "view.gantt.prev": { zh: "上一个工作流", en: "Previous workflow" },
  "view.gantt.next": { zh: "下一个工作流", en: "Next workflow" },
  /** Phase 18 ⑤：甘特 tooltip 第 2 行的时长（`XdYh`，由 `formatWorkDuration` 给出） */
  "view.gantt.tipDuration": { zh: "⏱ {duration}", en: "⏱ {duration}" },
  "view.gantt.sameColor": { zh: "与状态总览 / 甘特图同色", en: "Same color as the overview / gantt" },
  "view.weekday.1": { zh: "一", en: "Mon" },
  "view.weekday.2": { zh: "二", en: "Tue" },
  "view.weekday.3": { zh: "三", en: "Wed" },
  "view.weekday.4": { zh: "四", en: "Thu" },
  "view.weekday.5": { zh: "五", en: "Fri" },
  "view.weekday.6": { zh: "六", en: "Sat" },
  "view.weekday.7": { zh: "日", en: "Sun" },

  /* ---- 设置面板 ---- */
  "settings.heading": { zh: "视图外观", en: "Appearance" },
  "settings.timerFontSize.name": { zh: "计时器字号", en: "Timer font size" },
  "settings.timerFontSize.desc": {
    zh: "正计时器 HH:MM:SS 的字号（CSS 长度，如 36px / 2.5em）。",
    en: "Font size of the HH:MM:SS stopwatch (any CSS length, e.g. 36px / 2.5em).",
  },
  /** Phase 17：泳道正文区的最大高度（超出后只在泳道内滚动，栏头不动） */
  "settings.laneHeight.name": { zh: "泳道高度（px）", en: "Lane body height (px)" },
  "settings.laneHeight.desc": {
    zh: "每条泳道正文区的最大高度；超出后只在泳道内滚动（栏头固定），每条泳道各一条滚动条。",
    en: "Max height of each lane body; longer content scrolls inside that lane only (the header stays put), one scrollbar per lane.",
  },
  "settings.theme.name": { zh: "全局默认主题", en: "Default theme" },
  "settings.theme.desc": {
    zh: "视图配色与装饰；单个笔记可用 frontmatter 的 wf-theme 覆盖。",
    en: "Color and decoration of the view; a note can override it with the `wf-theme` frontmatter field.",
  },
  "settings.theme.descTail": {
    zh: "本项只决定「文件没写 wf-theme、render 也没传 options.theme」时的回落值；「状态总览」块末尾的切换按钮只写当前文件的 frontmatter。",
    en: "This only sets the fallback used when the file has no `wf-theme` and render() gets no `options.theme`; the switch at the end of the overview block writes the current file's frontmatter only.",
  },
  "settings.lang.name": { zh: "语言", en: "Language" },
  "settings.lang.desc": {
    zh: "界面与校验提示的语言（默认英文）。",
    en: "Language of the UI and validation messages (default: English).",
  },
  /** Phase 18 ③：渲染区顶部的大标题（空串 = 用 i18n 的「下一步是？」） */
  "settings.resumePrompt.name": { zh: "引导性话语", en: "Prompt line" },
  "settings.resumePrompt.desc": {
    zh: "作为渲染区顶部的大标题显示。",
    en: "Shown as the large title above the view.",
  },
  "settings.resumePrompt.placeholder": { zh: "接下来，想怎么做?", en: "What's next?" },
  /** Phase 18 ⑦：卡片宽度（写到根元素 `--wf-card-width`，优先于所有主题） */
  "settings.cardWidth.name": { zh: "卡片宽度（px）", en: "Card width (px)" },
  "settings.cardWidth.desc": { zh: "150~400，默认 200。", en: "150–400, default 200." },
  /** Phase 18 ④-E：365 天见闻 md 的存放目录 */
  "settings.dailyFolder.name": { zh: "日记文件夹", en: "Daily folder" },
  "settings.dailyFolder.desc": {
    zh: "365 天见闻 md（`YYYY-MM-DD.md`）的存放目录，默认 `daily`。",
    en: "Where the 365-day notes (`YYYY-MM-DD.md`) live; default `daily`.",
  },
  /** Phase 19 M1 ①：emo 独立主题（设置面板下拉 / 画布上「灵动岛」按钮共用） */
  "settings.emoTheme.name": { zh: "emo 主题", en: "Emo theme" },
  "settings.emoTheme.desc": {
    zh: "365 天 emo 小工具的独立主题（默认 / 织布 / 糖果），与插件主题无关。",
    en: "Theme of the 365-day emo widget (Default / Weave / Candy); independent of the plugin theme.",
  },

  /* ---- 视图：分组块 / 卡片 / 归档信息 ---- */
  "view.block.active": { zh: "🧭 工作流：正在进行 {count}   | 🔋 节点：活跃 {active}/{total} 阻塞 {blocked}", en: "🧭 Workflow: In progress {count}   | 🔋 Nodes: Active {active}/{total}, Blocked {blocked}" },
  "view.block.activeEmpty": { zh: "（暂无进行中的工作流）", en: "(No workflow in progress)" },
  "view.block.editWorkflows": { zh: "⚙️ 修改工作流…", en: "⚙️ Edit workflows…" },
  // Phase 15：块尾的「修改节点顺序」开关（排在「修改工作流」之前）
  "view.block.reorderNodes": { zh: "修改节点顺序", en: "Reorder nodes" },
  "view.block.doneFlow": { zh: "📦 已完成流", en: "📦 Completed" },
  "view.block.cancelledFlow": { zh: "🚫 已取消流", en: "🚫 Cancelled" },
  "view.block.archived": { zh: "已归档（{count}）", en: "Archived ({count})" },
  /* Phase 16：左侧小工具侧边栏 + 弹窗（前 5 个开弹窗，第 6 个直接开插件设置） */
  "view.widget.sidebar": { zh: "小工具", en: "Widgets" },
  "view.widget.emo365": { zh: "365天emo", en: "365-day emo" },
  "view.widget.gantt21": { zh: "21天甘特图", en: "21-day Gantt" },
  "view.widget.quadrant": { zh: "4象限节点", en: "4-quadrant nodes" },
  "view.widget.plot365": { zh: "365天plot", en: "365-day plot" },
  "view.widget.settings": { zh: "插件设置", en: "Plugin settings" },
  "view.widget.close": { zh: "关闭", en: "Close" },
  "view.widget.placeholder": {
    zh: "这个位置预留给后续版本：该小工具还没实现。",
    en: "Reserved for a later version: this widget is not implemented yet.",
  },
  "view.widget.emptyArchive": { zh: "还没有归档节点", en: "No archived nodes yet" },
  /* Phase 18 ④：365 天 emo 小工具（配色 / 网格独立，不进 [data-wf-theme]） */
  "widget.emo.today": { zh: "今日见闻", en: "Today" },
  "widget.emo.recorded": { zh: "有记录", en: "Recorded" },
  "widget.emo.empty": { zh: "无记录", en: "No entry" },
  "widget.emo.open": { zh: "打开", en: "Open" },
  "widget.emo.addTitle": { zh: "记录今日见闻", en: "Record today" },
  "widget.emo.sentenceLabel": { zh: "一句话", en: "One sentence" },
  "widget.emo.sentencePlaceholder": { zh: "今天遇到了什么？", en: "What happened today?" },
  "widget.emo.imageLabel": { zh: "图片", en: "Image" },
  "widget.emo.imagePaste": { zh: "粘贴或拖入一张图片", en: "Paste or drop an image" },
  "widget.emo.zoom": { zh: "缩放", en: "Zoom" },
  /* Phase 19 M1：emo 编辑入口（右键菜单 / 拍立得构图上的两个编辑按钮） */
  "widget.emo.edit": { zh: "编辑", en: "Edit" },
  "widget.emo.editImage": { zh: "编辑图片", en: "Edit image" },
  "widget.emo.editText": { zh: "编辑文字", en: "Edit text" },
  /* Phase 19 M2：4 象限节点小工具（左侧 16 分区 + 右侧预览，只读） */
  "widget.quadrant.axisX": { zh: "紧急程度 →", en: "Urgency →" },
  "widget.quadrant.axisY": { zh: "重要程度 ↑", en: "Importance ↑" },
  "widget.quadrant.empty": {
    zh: "点击左侧任一分区查看任务",
    en: "Click a partition on the left to see its tasks",
  },
  "widget.quadrant.noNodes": { zh: "该分区暂无任务", en: "No tasks in this partition" },
  "widget.quadrant.partition": {
    zh: "重要 {importance} · 紧急 {urgency} · {count} 个任务",
    en: "Importance {importance} · Urgency {urgency} · {count} task(s)",
  },
  "widget.quadrant.workflow": { zh: "所属工作流：{title}", en: "Workflow: {title}" },
  "widget.quadrant.time": {
    zh: "开始距今：{since} 已记录：{recorded}",
    en: "Since start: {since} · Logged: {recorded}",
  },
  /* Phase 19 M3：365 天 plot 小工具（plot 列表 + 折线 + 增删点 + CSV 导入导出） */
  "widget.plot.list": { zh: "图表", en: "Plots" },
  "widget.plot.new": { zh: "新建", en: "New" },
  "widget.plot.newTitle": { zh: "新建 plot", en: "New plot" },
  "widget.plot.name": { zh: "名称", en: "Name" },
  "widget.plot.namePlaceholder": { zh: "例如：体重变化", en: "e.g. Weight" },
  "widget.plot.kind": { zh: "类型", en: "Kind" },
  "widget.plot.kind.date": { zh: "日期", en: "Date" },
  "widget.plot.kind.sequence": { zh: "序号", en: "Sequence" },
  "widget.plot.kind.dateHint": { zh: "x = YYYY-MM-DD", en: "x = YYYY-MM-DD" },
  "widget.plot.kind.sequenceHint": { zh: "x = 1, 2, 3…", en: "x = 1, 2, 3…" },
  "widget.plot.unit": { zh: "单位", en: "Unit" },
  "widget.plot.unitPlaceholder": { zh: "例如：kg（可留空）", en: "e.g. kg (optional)" },
  "widget.plot.delete": { zh: "删除", en: "Delete" },
  "widget.plot.empty": { zh: "还没有 plot，点「新建」开始", en: "No plots yet — click “New” to start" },
  "widget.plot.loading": { zh: "读取中…", en: "Loading…" },
  "widget.plot.unselected": { zh: "从左侧选一个 plot", en: "Pick a plot on the left" },
  "widget.plot.emptyPoints": { zh: "还没有数据点", en: "No data points yet" },
  "widget.plot.meta": {
    zh: "{kind} · {count} 个点",
    en: "{kind} · {count} point(s)",
  },
  "widget.plot.metaUnit": {
    zh: "{kind} · {unit} · {count} 个点",
    en: "{kind} · {unit} · {count} point(s)",
  },
  "widget.plot.points": { zh: "数据点（{count}）", en: "Points ({count})" },
  // 补充契约⑥c / ⑦：点搜索（空 = 全部 / `A` = 精确 / `A~B` = 闭区间）
  "widget.plot.search": { zh: "搜索", en: "Search" },
  "widget.plot.searchPlaceholder": {
    zh: "2026-01-01 或 2026-01-01~2026-02-01",
    en: "2026-01-01 or 2026-01-01~2026-02-01",
  },
  "widget.plot.searchCount": { zh: "匹配 {matched} / 共 {total} 条", en: "{matched} of {total} match" },
  "widget.plot.searchInvalid": { zh: "搜索格式不对：{hint}", en: "Invalid search: {hint}" },
  "widget.plot.clearSearch": { zh: "清空", en: "Clear" },
  "widget.plot.addPoint": { zh: "添加点", en: "Add point" },
  "widget.plot.removePoint": { zh: "删除这个点", en: "Remove this point" },
  "widget.plot.invalidX": { zh: "x 不合法：{hint}", en: "Invalid x: {hint}" },
  "widget.plot.invalidY": { zh: "y 必须是数字", en: "y must be a number" },
  "widget.plot.xyTaken": { zh: "该 x 已有点，已覆盖原值", en: "That x already existed — its value was replaced" },
  "widget.plot.import": { zh: "导入 CSV", en: "Import CSV" },
  "widget.plot.export": { zh: "导出 CSV", en: "Export CSV" },
  "widget.plot.exportPath": { zh: "{folder}/<id>.csv", en: "{folder}/<id>.csv" },
  "widget.plot.exported": { zh: "已导出：{path}", en: "Exported: {path}" },
  "widget.plot.imported": { zh: "已导入 {count} 个点", en: "Imported {count} point(s)" },
  "widget.plot.importSkipped": {
    zh: "有 {count} 行没读进来（第 {lines} 行）",
    en: "{count} line(s) skipped (lines {lines})",
  },
  "widget.plot.importEmpty": { zh: "CSV 里没有可用的点", en: "No usable points in that CSV" },
  "widget.plot.needSelection": { zh: "先选一个 plot", en: "Pick a plot first" },
  "widget.plot.readFailed": { zh: "读取失败：{path}", en: "Failed to read: {path}" },
  "widget.plot.created": { zh: "已新建：{name}", en: "Created: {name}" },
  "widget.plot.deleted": { zh: "已删除：{name}", en: "Deleted: {name}" },
  "settings.plotFolder.name": { zh: "图表文件夹", en: "Plot folder" },
  "settings.plotFolder.desc": {
    zh: "365 天 plot 的 JSON（`plot-<uuid>.json`）与导出的 CSV 的存放目录，默认 `plots`。",
    en: "Where plot JSON files (`plot-<uuid>.json`) and exported CSVs live; default `plots`.",
  },

  "view.card.jumpNoteTitle": {
    zh: "跳到本文件的纪要段落（{anchor}）",
    en: "Jump to the note section in this file ({anchor})",
  },
  "view.card.titleTooltip": {
    zh: "左键跳纪要（{anchor}）；右键看资料 / 改状态 / 计时 / 改信息 / 加子节点 / 删除",
    en: "Left click: jump to notes ({anchor}); right click: links / status / timer / info / add child / delete",
  },
  "view.card.importance": { zh: "重要度 {value}", en: "Importance: {value}" },
  "view.card.urgency": { zh: "紧急度 {value}", en: "Urgency: {value}" },
  "view.card.hours": { zh: "用时 {hours}h", en: "Spent {hours}h" },
  "view.card.start": { zh: "开始 {date}", en: "Start {date}" },
  "view.card.completed": { zh: "完成 {date}", en: "Done {date}" },
  "view.card.due": { zh: "截止 {date}", en: "Due {date}" },
  "view.card.progress": { zh: "进度：{progress}/{max}", en: "Progress: {progress}/{max}" },
  "view.card.progressTitle": {
    zh: "进度：{progress}/{max}（{percent}%）",
    en: "Progress: {progress}/{max} ({percent}%)",
  },
  "view.card.worked": { zh: "⏱ 已完成 {duration}", en: "⏱ Logged {duration}" },
  /** Phase 17：卡片第 3 段（时间信息）—— done 只给「已完成时间」，其余给「已经过 / 距结束」 */
  "view.card.elapsed": { zh: "已经过：{days}天", en: "Elapsed: {days}d" },
  "view.card.remain": { zh: "距结束：{days}天", en: "Left: {days}d" },
  /** Phase 18 ⑧：已完成卡片的后两句（`x天完成` = startAt→completedAt，`x天前结束` = completedAt→今天） */
  "view.card.doneIn": { zh: "{days}天完成", en: "Done in {days}d" },
  "view.card.doneAgo": { zh: "{days}天前结束", en: "Ended {days}d ago" },
  /** Phase 17：元信息行固定给出纪要超链接数量（0 也显示） */
  "view.card.links": { zh: "🔗 {count}", en: "🔗 {count}" },
  "view.archive.file": { zh: "📄 {path}（归档于 {time}）", en: "📄 {path} (archived at {time})" },
  "view.archive.infoTitle": { zh: "归档信息", en: "Archive info" },
  "view.archive.summary": { zh: "概括：{text}", en: "Summary: {text}" },
  "view.archive.idea": { zh: "原理 / 启发：{text}", en: "Principle / insight: {text}" },
  "view.archive.review": { zh: "复盘 / 下一步：{text}", en: "Retro / next steps: {text}" },

  /* ---- 主题名（与 styles.css 的 [data-wf-theme] 一一对应） ---- */
  "idKind.file": { zh: "文件", en: "file" },
  "idKind.workflow": { zh: "工作流", en: "workflow" },
  "idKind.node": { zh: "节点", en: "node" },
  "idKind.link": { zh: "链接", en: "link" },
  "theme.default": { zh: "默认主题", en: "Default" },
  "theme.tech": { zh: "科技风", en: "Tech" },
  "theme.nature": { zh: "自然风", en: "Nature" },
  "theme.magazine": { zh: "杂志风", en: "Magazine" },
  "theme.retro": { zh: "复古风", en: "Retro" },
  "theme.clay": { zh: "黏土风", en: "Clay" },
  "theme.web": { zh: "网页风", en: "Web" },
  "theme.fresh": { zh: "清新风", en: "Fresh" },
  "theme.shoujo": { zh: "少女风", en: "Shoujo" },

  /* ---- 视图：右键菜单 / 操作提示 ---- */
  "view.menu.noLinks": { zh: "（该节点暂无纪要超链接）", en: "(No links in this note section yet)" },
  "view.menu.jumpNote": { zh: "🔗 跳到本文件纪要", en: "🔗 Jump to notes in this file" },
  "view.menu.statusGroup": { zh: "── 状态 ──", en: "── Status ──" },
  "view.menu.markAs": { zh: "{icon} 标记为{label}", en: "{icon} Mark as {label}" },
  "view.menu.timerGroup": { zh: "── 计时 ──", en: "── Timer ──" },
  "view.menu.startTimer": { zh: "▶️ 开始这个任务", en: "▶️ Start this task" },
  "view.menu.stopRecord": { zh: "⏹ 结束并记录", en: "⏹ Stop and record" },
  "view.menu.stopDiscard": { zh: "🗑 结束并丢弃", en: "🗑 Stop and discard" },
  "view.menu.otherTimer": {
    zh: "⏱ 正在「{title}」计时（请先结束它）",
    en: "⏱ Timing “{title}” — stop it first",
  },
  "view.menu.structureGroup": { zh: "── 结构 ──", en: "── Structure ──" },
  "view.menu.editNode": { zh: "✏️ 编辑节点信息…", en: "✏️ Edit node info…" },
  "view.menu.addChild": { zh: "➕ 添加子节点…", en: "➕ Add child node…" },
  "view.menu.deleteNode": { zh: "🗑 删除本节点…", en: "🗑 Delete this node…" },
  "view.menu.archiveGroup": { zh: "── 归档 ──", en: "── Archive ──" },
  "view.menu.openArchive": { zh: "📄 打开归档文件（{path}）", en: "📄 Open archive file ({path})" },
  "view.menu.archiveFrom": { zh: "📦 为此及之后归档…", en: "📦 Archive this node and all below…" },
  "view.menu.archiveFromBlocked": {
    zh: "📦 为此及之后归档（{reason}）",
    en: "📦 Archive this node and all below ({reason})",
  },
  "view.menu.cannotArchive": { zh: "不可归档", en: "Cannot archive" },
  "view.notify.unknownReason": { zh: "未知原因", en: "unknown reason" },
  "view.notify.writeFailed": { zh: "wfjson 未写入：{reason}", en: "wfjson not written: {reason}" },
  "view.notify.archiveFailed": { zh: "wfjson 未归档：{reason}", en: "wfjson not archived: {reason}" },
  "view.notify.workflowUnchanged": {
    zh: "工作流没有变化，未改写文件",
    en: "No workflow changes — the file was left untouched",
  },
  "view.notify.workflowUpdated": { zh: "已更新工作流{suffix}", en: "Workflows updated{suffix}" },
  /* ---- Phase 15：拖拽改节点顺序（开关上的状态文字 / 按钮 title / 结果提示） ---- */
  "view.reorder.on": { zh: "开", en: "On" },
  "view.reorder.off": { zh: "关", en: "Off" },
  "view.reorder.hint": {
    zh: "开启后可拖动节点卡片，拖到另一节点上半 / 下半分别插入到其前 / 后",
    en: "When on, drag a node card: drop on the upper half of another node to insert before it, on the lower half to insert after it",
  },
  "view.notify.nodeMoved": { zh: "已调整节点顺序", en: "Node order updated" },
  "view.notify.reorderFailed": { zh: "调整节点顺序失败：{reason}", en: "Failed to reorder nodes: {reason}" },
  "view.notify.statusSame": {
    zh: "「{title}」状态本来就是{status}，未改写文件",
    en: "“{title}” is already {status} — the file was left untouched",
  },
  "view.notify.statusMarked": {
    zh: "已把「{title}」标记为{status}{suffix}",
    en: "Marked “{title}” as {status}{suffix}",
  },
  "view.notify.timerRunning": {
    zh: "「{title}」仍在计时，未改写文件",
    en: "“{title}” is still timing — the file was left untouched",
  },
  "view.notify.timerStarted": { zh: "已开始计时：「{title}」{suffix}", en: "Timer started: “{title}”{suffix}" },
  "view.notify.noTimer": {
    zh: "「{title}」没有进行中的计时，未改写文件",
    en: "“{title}” has no running timer — the file was left untouched",
  },
  "view.notify.stoppedRecord": { zh: "已结束并记录", en: "Stopped and recorded" },
  "view.notify.stoppedDiscard": { zh: "已结束并丢弃", en: "Stopped and discarded" },
  "view.notify.warningCount": { zh: "（{count} 条提示）", en: " ({count} notice(s))" },
  "view.notify.listSep": { zh: "；", en: ", " },
  "view.notify.notesSuffix": { zh: "（{list}）", en: " ({list})" },
  "view.notify.nodeInfoUnchanged": {
    zh: "「{title}」的节点信息没有变化，未改写文件",
    en: "No changes to the node info of “{title}” — the file was left untouched",
  },
  "view.notify.nodeInfoUpdated": {
    zh: "已更新「{title}」的节点信息{suffix}",
    en: "Node info updated for “{title}”{suffix}",
  },
  "view.notify.noNewChild": {
    zh: "「{title}」下没有新增子节点，未改写文件",
    en: "No child node was added under “{title}” — the file was left untouched",
  },
  "view.notify.childAdded": {
    zh: "已在「{title}」下新增子节点{notes}{suffix}",
    en: "Added a child node under “{title}”{notes}{suffix}",
  },
  "view.notify.notDeleted": {
    zh: "「{title}」没有被删除，未改写文件",
    en: "“{title}” was not deleted — the file was left untouched",
  },
  "view.notify.linksMerged": { zh: "（超链接已合并到父节点）", en: " (links merged into the parent node)" },
  "view.notify.linksDropped": { zh: "（超链接随本段删除）", en: " (links removed with this section)" },
  "view.notify.nodeDeleted": {
    zh: "已删除「{title}」，子节点已上移{linkNote}{suffix}",
    en: "Deleted “{title}” and moved its children up{linkNote}{suffix}",
  },
  "view.notify.unchanged": {
    zh: "「{title}」没有变化，未改写文件",
    en: "No changes to “{title}” — the file was left untouched",
  },
  "view.notify.archiveReused": {
    zh: "（沿用上次建的那份归档文件）",
    en: " (reused the archive file created last time)",
  },
  "view.notify.archived": {
    zh: "已归档「{title}」（压缩 {count} 个节点）→ {target}{reused}{suffix}",
    en: "Archived “{title}” ({count} node(s) compressed) → {target}{reused}{suffix}",
  },
  "view.notify.cannotArchive": {
    zh: "不能归档「{title}」：{reason}",
    en: "Cannot archive “{title}”: {reason}",
  },
  "view.notify.upgraded": {
    zh: "（渲染时已在内存中升格 {from} → {to}，未落盘）",
    en: " (upgraded in memory {from} → {to} while rendering; not written to disk)",
  },
  "view.notify.issuesHint": {
    zh: "（命令面板运行「校验当前文件的 wfjson」看明细）",
    en: "(run “Check wfjson in current file” from the command palette for details)",
  },
  "view.notify.noIssues": { zh: "✔ 无问题", en: "✔ No issues" },
  "view.notify.schemaLine": {
    zh: "🔎  错误 {error} ／ 警告 {warning} ／ 提示 {info} {tail}",
    en: "🔎 {error} error(s) / {warning} warning(s) / {info} info {tail}",
  },
/*
  "view.notify.noIssues": { zh: "✔ 无问题", en: "✔ No issues" },
  "view.notify.schemaLine": {
    zh: "🔎 schema {version}{upgraded} ｜ 错误 {error} ／ 警告 {warning} ／ 提示 {info} {tail}",
    en: "🔎 schema {version}{upgraded} | {error} error(s) / {warning} warning(s) / {info} info {tail}",
  },*/

  /* ---- 校验消息的通用片段（配合 issueMsg 使用） ---- */
  "issues.join": { zh: "；", en: "; " },
  "issues.listSep": { zh: "、", en: ", " },
  "issues.or": { zh: " 或 ", en: " or " },
  "issue.order.updated": { zh: "updatedAt 早于 startAt", en: "updatedAt is earlier than startAt" },
  "issue.order.completed": { zh: "completedAt 早于 startAt", en: "completedAt is earlier than startAt" },
  "issue.order.due": { zh: "dueAt 早于 startAt", en: "dueAt is earlier than startAt" },
  "issue.statusSuffix": { zh: "（{label}）", en: " ({label})" },
  "issue.statusIllegal": { zh: "（非法取值）", en: " (invalid value)" },
  "issue.commentKind.block": { zh: "块注释 /* */", en: "Block comment /* */" },
  "issue.commentKind.line": { zh: "行注释 //", en: "Line comment //" },
  "issue.parseErrorWhere": {
    zh: "（第 {line} 行第 {column} 列附近）",
    en: " (near line {line}, column {column})",
  },
  "issue.sourceLine": { zh: "原文：{text}", en: "Source: {text}" },
  "issue.anyOfForm": { zh: "形式 {index}：{message}", en: "Form {index}: {message}" },
  "issue.anyOfUnsatisfied": { zh: "不满足", en: "not satisfied" },
  "issue.blockIgnoredTarget": {
    zh: "（本笔记使用外置 JSON：{path}）",
    en: " (this note uses an external JSON: {path})",
  },
  "issue.blockIgnoredGeneric": { zh: "（本笔记使用外置 JSON）", en: " (this note uses an external JSON)" },

  /* ---- 通用按钮 / 字段名 ---- */
  "common.cancel": { zh: "取消", en: "Cancel" },
  "common.add": { zh: "添加", en: "Add" },
  "common.delete": { zh: "删除", en: "Delete" },
  "common.save": { zh: "保存", en: "Save" },
  "common.archive": { zh: "归档", en: "Archive" },
  "common.confirmDelete": { zh: "确认删除", en: "Confirm delete" },
  "common.unset": { zh: "（未设置）", en: "(not set)" },
  "common.untitled": { zh: "（未命名）", en: "(untitled)" },
  "common.workflow": { zh: "工作流", en: "Workflow" },
  "common.unknownReason": { zh: "未知原因", en: "unknown reason" },
  "field.title": { zh: "标题", en: "Title" },
  "field.progress": { zh: "已完成（0-999）", en: "Done (0-999)" },
  "field.progressMax": { zh: "总量（0-999）", en: "Total (0-999)" },
  "field.importance": { zh: "重要度（1-4）", en: "Importance (1-4)" },
  "field.urgency": { zh: "紧急度（1-4）", en: "Urgency (1-4)" },
  "field.owner": { zh: "负责人", en: "Owner" },
  "field.ownerOptional": { zh: "负责人（可选）", en: "Owner (optional)" },
  "field.dueAt": { zh: "截止时间", en: "Due" },
  "field.dueAtOptional": { zh: "截止时间（可选）", en: "Due (optional)" },
  "field.dueAtDefault": { zh: "截止日（默认一周后）", en: "Due date (default: one week later)" },
  "field.summary": { zh: "概要", en: "Summary" },
  "field.summaryOptional": { zh: "概要（可选）", en: "Summary (optional)" },
  "field.type": { zh: "类型", en: "Type" },
  "field.typeOptional": { zh: "类型（可选）", en: "Type (optional)" },
  "field.outline": { zh: "概括", en: "Summary" },
  "field.idea": { zh: "原理 / 启发", en: "Principle / insight" },
  "field.review": { zh: "复盘 / 下一步", en: "Retro / next steps" },
  "field.year": { zh: "年", en: "YYYY" },
  "field.month": { zh: "月", en: "MM" },
  "field.day": { zh: "日", en: "DD" },
  "field.yearDefault": { zh: "年（默认一周后）", en: "YYYY (default: one week later)" },
  "field.dueDate": { zh: "截止日", en: "Due date" },

  /* ---- 标签后缀（中文用全角括号，英文用半角 + 前置空格） ---- */
  "suffix.range0to999": { zh: "（0-999）", en: " (0-999)" },
  "suffix.range1to4": { zh: "（1-4）", en: " (1-4)" },
  "suffix.optional": { zh: "（可选）", en: " (optional)" },

  /* ---- 通知（Notice）与内部拒绝原因 ---- */
  "notice.noDv": {
    zh: "wfjson 视图：没有拿到可用的 dataview `dv`，请在 dataviewjs 代码块里调用 render(dv)",
    en: "wfjson view: no usable dataview `dv` — call render(dv) inside a dataviewjs block",
  },
  "notice.sidecarExists": { zh: "外置 JSON 未同步：{path} 已存在", en: "External JSON not synced: {path} already exists" },
  "notice.renameFailed": { zh: "外置 JSON 重命名同步失败：{message}", en: "Failed to rename the external JSON: {message}" },
  "notice.migrated": { zh: "已外置 wfjson：{path}", en: "wfjson extracted to: {path}" },
  "notice.nothingToMigrate": {
    zh: "本文件没有 wfjson 代码块，不需要迁移",
    en: "This file has no wfjson block — nothing to migrate",
  },
  "notice.notMigrated": { zh: "未迁移：{reason}", en: "Not migrated: {reason}" },
  "notice.checkOk": { zh: "wfjson 校验通过：{path}", en: "wfjson check passed: {path}" },
  "notice.checkResult": {
    zh: "wfjson 校验：错误 {error} / 警告 {warning} / 提示 {info}",
    en: "wfjson check: {error} error(s) / {warning} warning(s) / {info} info",
  },
  "notice.unnamedFile": { zh: "未命名文件", en: "Untitled file" },
  /* Phase 16：侧边栏 ⚙️ 打不开设置页（Obsidian 版本差异 / 内部对象不在） */
  "notice.settingsOpenFailed": { zh: "打开插件设置失败", en: "Failed to open plugin settings" },
  "reject.noBlock": { zh: "本文件没有可用的 wfjson 代码块", en: "This file has no usable wfjson block" },
  "reject.processSkipped": {
    zh: "mutateFile：vault.process 未执行变更回调（Obsidian API 异常）",
    en: "mutateFile: vault.process did not run the change callback (Obsidian API anomaly)",
  },
  "reject.nodeMissing": {
    zh: "节点 {id} 不存在（可能已被删除）",
    en: "Node {id} does not exist (it may have been deleted)",
  },
  "reject.addChildFailed": {
    zh: "在节点 {id} 下添加子节点失败",
    en: "Failed to add a child node under {id}",
  },
  "reject.deleteFailed": { zh: "删除节点 {id} 失败", en: "Failed to delete node {id}" },
  "reject.startTimerFailed": { zh: "开始计时失败（节点 {id}）", en: "Failed to start the timer (node {id})" },
  "reject.stopRecordFailed": { zh: "结束并记录失败（节点 {id}）", en: "Failed to stop and record (node {id})" },
  "reject.stopDiscardFailed": { zh: "结束并丢弃失败（节点 {id}）", en: "Failed to stop and discard (node {id})" },
  "reject.editFailed": { zh: "编辑节点 {id} 的信息失败", en: "Failed to edit the info of node {id}" },
  "reject.workflowFailed": { zh: "修改工作流失败", en: "Failed to edit workflows" },
  "reject.cannotArchive": { zh: "节点 {id} 不能归档", en: "Node {id} cannot be archived" },
  "reject.archiveFailed": { zh: "归档节点 {id} 失败", en: "Failed to archive node {id}" },
  "reject.planMissingDoc": { zh: "迁移计划缺少文档", en: "The migration plan has no document" },
  "reject.sidecarOccupied": {
    zh: "外置 JSON 路径被占用：{path}",
    en: "The external JSON path is taken: {path}",
  },
  "reject.sidecarDifferent": {
    zh: "外置 JSON 已存在且内容不同：{path}",
    en: "The external JSON already exists with different content: {path}",
  },

  /* ---- 命令 ---- */
  "command.check": { zh: "校验当前文件的 wfjson", en: "Check wfjson in current file" },
  "command.migrate": { zh: "迁移当前文件到外置 JSON（_wfjson）", en: "Migrate current file to external JSON (_wfjson)" },
  "command.insertTemplate": { zh: "插入工作流模板", en: "Insert workflow template" },
  "command.templateDone": { zh: "已插入工作流模板", en: "Workflow template inserted" },

  /* ---- 对话框：添加子节点 ---- */
  "dialog.addChild.title": { zh: "在「{title}」下添加子节点", en: "Add a child node under “{title}”" },
  "dialog.addChild.desc": {
    zh: "新节点默认 status=todo、开始时间=现在；写回时会自动在正文补出「### 标题 ^id」纪要段落。截止日默认一周后，可清空。",
    en: "New nodes default to status=todo with the start time set to now; on write-back a `### Title ^id` note section is added to the body. The due date defaults to one week later and can be cleared.",
  },
  "dialog.addChild.titlePlaceholder": { zh: "例如：整理访谈录音", en: "e.g. Transcribe the interview" },

  /* ---- 对话框：删除节点 ---- */
  "dialog.delete.title": { zh: "删除本节点", en: "Delete this node" },
  "dialog.delete.desc": {
    zh: "确定删除「{title}」？此操作不可撤销。",
    en: "Delete “{title}”? This cannot be undone.",
  },
  "dialog.delete.itemSelf": {
    zh: "删除本节点及其正文纪要段落（^{id}）",
    en: "Delete this node and its note section (^{id})",
  },
  "dialog.delete.itemChildren": {
    zh: "{count} 个子节点上移到本节点原来的位置",
    en: "{count} child node(s) move up to this node's position",
  },
  "dialog.delete.itemRelations": {
    zh: "{count} 条关系合并到父节点（指向本节点 / 父节点的会丢掉）",
    en: "{count} relation(s) merge into the parent (ones pointing at this node / the parent are dropped)",
  },
  "dialog.delete.linksLabel": {
    zh: "本节点纪要段里的超链接：",
    en: "Links inside this node's note section:",
  },
  "dialog.delete.mergeLinks": {
    zh: "超链接合并进上级条目（默认）",
    en: "Merge links into the parent entry (default)",
  },
  "dialog.delete.dropLinks": {
    zh: "删除超链接（父节点纪要段不变）",
    en: "Drop the links (the parent's note section stays as is)",
  },

  /* ---- 对话框：归档 ---- */
  "dialog.archive.title": { zh: "归档（为此及之后）", en: "Archive (this node and all below)" },
  "dialog.archive.desc": {
    zh: "把「{title}」及其全部后代浓缩成一个归档节点。",
    en: "Condense “{title}” and all its descendants into a single archived node.",
  },
  "dialog.archive.itemFile": {
    zh: "在 archive/ 新建归档 md（{total} 个节点：本节点 + {descendants} 个后代）",
    en: "Create an archive md under archive/ ({total} node(s): this node + {descendants} descendant(s))",
  },
  "dialog.archive.itemLocal": {
    zh: "本文件里：后代节点与其正文纪要段落删掉，本节点压成一个带 archive 的已完成节点",
    en: "In this file: descendant nodes and their note sections are removed, and this node collapses into a done node carrying an `archive` field",
  },
  "dialog.archive.itemIds": {
    zh: "归档 md 里的节点会重新生成 id —— 不做节点追溯（原 id 不保存）",
    en: "Nodes in the archive md get fresh ids — no node tracing is kept (the original ids are not stored)",
  },
  "dialog.archive.itemUnfinished": {
    zh: "注意：子树里还有 {count} 个未完成节点，会被引擎拒绝",
    en: "Note: the subtree still has {count} unfinished node(s), which the engine will refuse",
  },
  "dialog.archive.hint": {
    zh: "下面三段都选填，留空就不写进 archive 字段（也可以之后在归档 md 里补）。",
    en: "The next three fields are optional; leave them empty and they are not written into the `archive` field (you can also fill them in the archive md later).",
  },
  "dialog.archive.summaryPlaceholder": {
    zh: "这段工作是什么、最后做到哪一步",
    en: "What this work was and how far it got",
  },
  "dialog.archive.ideaPlaceholder": {
    zh: "底层原理、可复用的经验",
    en: "Underlying principle, reusable lessons",
  },
  "dialog.archive.reviewPlaceholder": {
    zh: "怎么提高效率、接下来做什么",
    en: "How to be faster next time, what comes next",
  },
  /* ---- 对话框：编辑节点信息 ---- */
  "dialog.editNode.title": { zh: "编辑节点信息：{title}", en: "Edit node info: {title}" },
  "dialog.editNode.desc": {
    zh: "只填要改的那几项即可，其余保持原样；留空 = 清空该字段（带 * 的必填项不能清空）。",
    en: "Fill in only the fields you want to change; the rest stay as they are. Empty = clear the field (required fields marked * cannot be cleared).",
  },
  "dialog.editNode.titlePlaceholder": { zh: "节点标题（必填）", en: "Node title (required)" },
  "dialog.editNode.summaryPlaceholder": {
    zh: "这个节点要做什么、做到哪一步",
    en: "What this node is for and how far it got",
  },

  /* ---- 对话框：修改工作流 ---- */
  "dialog.workflows.title": { zh: "修改工作流", en: "Edit workflows" },
  "dialog.workflows.desc": {
    zh: "留空 = 清空该字段",
    en: "Empty = clear the field",
  },
  "dialog.workflows.add": { zh: "➕ 新增工作流", en: "➕ Add workflow" },
  "dialog.workflows.newEntry": {
    zh: "🆕 新工作流（填完点保存才写盘）",
    en: "🆕 New workflow (only written after Save)",
  },
  "dialog.workflows.remove": { zh: "🗑 删除这个工作流…", en: "🗑 Delete this workflow…" },
  "dialog.workflows.confirmDelete": {
    zh: "确定删除「{title}」？它的根节点、全部节点与正文里的纪要段落都会一起删掉。",
    en: "Delete “{title}”? Its root node, all of its nodes and their note sections will be removed as well.",
  },
  "dialog.workflows.confirmDiscard": {
    zh: "确定丢弃这个还没保存的新工作流？",
    en: "Discard this unsaved new workflow?",
  },
  "dialog.workflows.markedRemoved": { zh: "🗑 {name}（保存后删除）", en: "🗑 {name} (deleted after save)" },
  "dialog.workflows.markedAdded": { zh: "🆕 {name}（保存后新增）", en: "🆕 {name} (added after save)" },
  "dialog.workflows.stateActive": { zh: "进行中", en: "Active" },
  "dialog.workflows.stateDone": { zh: "完成", en: "Done" },
  "dialog.workflows.stateCancelled": { zh: "取消", en: "Cancelled" },
  "dialog.analyze.title": { zh: "wfjson 分析结果", en: "wfjson analysis result" },

  /* ---- 表单报错 ---- */
  "error.notWritten": { zh: "未写入：{reason}{detail}", en: "Not written: {reason}{detail}" },
  "error.notArchived": { zh: "未归档：{reason}{detail}", en: "Not archived: {reason}{detail}" },
  "error.invalidTitle": { zh: "标题不合法", en: "Invalid title" },
  "error.titleEmpty": { zh: "标题不能为空", en: "Title cannot be empty" },
  "error.dateIncomplete": {
    zh: "{label}需要同时填写年 / 月 / 日（全部留空 = 清空）",
    en: "{label}: fill in year / month / day together (all empty = clear)",
  },
  "error.dateYear": {
    zh: "{label}的年份必须是 4 位数字（当前「{value}」）",
    en: "{label}: the year must be 4 digits (currently “{value}”)",
  },
  "error.dateNotNumber": {
    zh: "{label}的月 / 日必须是数字（当前「{month}」「{day}」）",
    en: "{label}: the month / day must be numeric (currently “{month}” / “{day}”)",
  },
  "error.dateInvalid": {
    zh: "{label}「{value}」不是有效日期",
    en: "{label}: “{value}” is not a valid date",
  },
  "error.numberInvalid": {
    zh: "{label}必须是数字（当前「{raw}」）",
    en: "{label}: must be a number (currently “{raw}”)",
  },
  "error.workflowTitleEmpty": {
    zh: "标题不能为空（要移除整个工作流请点「删除这个工作流」）",
    en: "The title cannot be empty (to remove a whole workflow, use “Delete this workflow”)",
  },
  "error.withName": { zh: "{name}：{reason}", en: "{name}: {reason}" },

  /* ---- 字段名（NODE_INFO_LABELS / WORKFLOW_EDIT_LABELS 的译文） ---- */
  "nodeinfo.title": { zh: "标题", en: "Title" },
  "nodeinfo.progress": { zh: "已完成", en: "Done" },
  "nodeinfo.progress_max": { zh: "总量", en: "Total" },
  "nodeinfo.owner": { zh: "负责人", en: "Owner" },
  "nodeinfo.dueAt": { zh: "截止时间", en: "Due" },
  "nodeinfo.summary": { zh: "概要", en: "Summary" },
  "nodeinfo.type": { zh: "类型", en: "Type" },
  "nodeinfo.importance": { zh: "重要度", en: "Importance" },
  "nodeinfo.urgency": { zh: "紧急度", en: "Urgency" },
  // Phase 14：标签不再区分「工作流 / 根节点」——表单里只剩一对 progress（根节点的）
  "workflowedit.title": { zh: "标题", en: "Title" },
  /** Phase 14：工作流级 progress 已从表单移除，两个 key 只保留给引擎报错 / 旧调用方 */
  "workflowedit.progress": { zh: "工作流已完成", en: "Workflow progress" },
  "workflowedit.progress_max": { zh: "工作流总量", en: "Workflow total" },
  "workflowedit.rootTitle": { zh: "根节点标题", en: "Root node title" },
  "workflowedit.summary": { zh: "概要", en: "Summary" },
  "workflowedit.type": { zh: "类型", en: "Type" },
  "workflowedit.importance": { zh: "重要度", en: "Importance" },
  "workflowedit.urgency": { zh: "紧急度", en: "Urgency" },
  "workflowedit.rootProgress": { zh: "已完成", en: "Done" },
  "workflowedit.rootProgressMax": { zh: "总量", en: "Total" },
  "workflowedit.owner": { zh: "负责人", en: "Owner" },
  "workflowedit.dueAt": { zh: "截止时间", en: "Due" },
  "workflowedit.tags": { zh: "根节点标签", en: "Root node tags" },
  "workflowedit.state": { zh: "状态", en: "State" },

} as const satisfies Record<string, Translation>;

type MessageKey = keyof typeof MESSAGES;

/**
 * 取一条文案并做 `{name}` 插值。
 * 未登记的 key 原样回显（`t("foo.bar")` → `"foo.bar"`），便于在界面上直接看出漏配。
 */
export function t(key: MessageKey | (string & {}), params?: Record<string, string | number>): string {
  const table = MESSAGES as Record<string, Translation>;
  const entry: Translation | undefined = table[key];
  if (entry === undefined) return key;
  const template = entry[currentLang];
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (whole: string, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** 节点状态的展示文案（`todo` → 待办 / To do） */
export function statusLabel(status: NodeStatus): string {
  return t(`status.${status}`);
}

/** 工作流状态的展示文案（缺省 = 进行中） */
export function stateLabel(state: WorkflowState | undefined): string {
  return t(`state.${state ?? "active"}`);
}

/** 严重级别的展示文案 */
export function severityLabel(severity: IssueSeverity): string {
  return t(`severity.${severity}`);
}

/** 计时器开始时间失效时的提示 */
export function timerInvalidStartMessage(): string {
  return t("timer.invalidStart");
}

/**
 * 校验提示（`hint`）的英文版。
 * `zh` 直接复用 `ISSUE_CODES[].hint`（原文案），只有英文需要单独翻译，
 * 所以这里只维护一张英文表；漏配的 code 自动回落中文 hint（不会出现空白）。
 */
const ISSUE_HINTS_EN: Partial<Record<IssueCode, string>> = {
  NO_WFJSON_BLOCK: "This note has no wfjson block, so it was skipped (one wfjson block per note).",
  MULTIPLE_WFJSON_BLOCKS: "One note may hold only one wfjson block (with a workflows array); merge the extra blocks.",
  WFJSON_BLOCK_IGNORED: "This note uses an external JSON file (_wfjson/…). Run “Migrate current file to external JSON” to clean up the leftover block (idempotent).",
  WFJSON_BLOCK_UNCLOSED: "Add the closing fence (it must be at least as long as the opening one).",
  JSON_BOM: "The BOM was ignored; save the file as UTF-8 without BOM to avoid this.",
  JSON_COMMENT_NOT_ALLOWED: "wfjson must be strict JSON (no comments); field docs live in doc/datacontact/data_ixd_v0.md.",
  JSON_TRAILING_COMMA: "Strict JSON forbids a trailing comma after the last item; remove it.",
  JSON_PARSE_ERROR: "Check quotes / commas / brackets; wfjson must be strict JSON.",
  SCHEMA_VERSION_UNSUPPORTED: "Upgrade the plugin, or set schemaVersion back to a supported version.",
  SCHEMA_UNKNOWN_FIELD: "See doc/datacontact/data_ixd_v0.md for the field list; new fields require a schemaVersion bump.",
  ID_FORMAT: "Prefixes: file- (file) / wf- (workflow) / nd- (node) / lk- (link); prefer ids generated by the plugin.",
  DUPLICATE_NODE_ID: "Node ids must be unique across the file; regenerate the duplicated ids and update their note anchors.",
  DUPLICATE_WORKFLOW_ID: "Workflow ids must be unique across the file.",
  DUPLICATE_LINK_ID: "links[].id must be unique within the file (used by the context menu).",
  NOTE_SECTION_UNPAIRED: "Every `<!-- wf-note:begin:<id> -->` needs an end marker with the same id; add or remove the stray marker.",
  NOTE_SECTION_NESTED: "A new begin marker appeared before the previous end marker; close the previous section first.",
  NOTE_SECTION_ID_MISMATCH: "The begin / end markers must carry the same node id as the heading anchor.",
  NOTE_ANCHOR_MISSING_IN_BODY: "Add a heading with that block anchor in the body, or fix / remove noteAnchor in the JSON.",
  NOTE_ANCHOR_DUPLICATED_IN_BODY: "Block ids must be unique; delete the extra anchor.",
  NOTE_ANCHOR_NOT_ON_HEADING: "Note sections look like `### Title ^nd-xxx`, so the outline and jumps work.",
  NOTE_ANCHOR_NOT_MATCHING_ID: "noteAnchor is expected to be \"^\" + node id, so humans and AI can cross-reference.",
  ORPHAN_BLOCK_ANCHOR: "This anchor is probably left over from a deleted node; delete it or restore the node.",
  STATUS_HISTORY_MISMATCH: "Append the latest status change to statusHistory so its last `to` equals the current status.",
  COMPLETED_AT_MISSING: "With status=done, also fill in completedAt.",
  PROGRESS_OVER_MAX: "progress / progress_max are independent; progress > progress_max is allowed and only reported here.",
  TIMESTAMP_INVALID: "Use a real date (e.g. February has no 30th), format YYYY-MM-DD or ISO8601.",
  TIMESTAMP_ORDER: "Expected order: startAt ≤ updatedAt ≤ completedAt, and dueAt is normally not earlier than startAt.",
  TIME_HOURS_RANGE: "hours must be a finite non-negative number of hours (1 decimal) = Math.round((endAt-startAt)/3600000*10)/10.",
  TIME_ENTRY_ORDER: "timeEntries[].endAt must not be earlier than startAt; discard the entry if the start time is invalid.",
  TIME_DATE_MISMATCH: "date must equal toDateOnly(startAt) (no UTC conversion; a session spanning midnight counts on its start day).",
  LINK_TARGET_NOT_BARE: "Store the bare target only (note name / file name / URL); [[target]] and ![[target]] are assembled by the renderer.",
  LINK_TARGET_TYPE_MISMATCH: "web → http(s) URL; image → common image extension; file → any other local file.",
  RELATION_TARGET_UNKNOWN: "If the target is a node / workflow in this file, check its id; cross-file references are not validated yet.",
  RELATION_SELF_DEPENDENCY: "dependsOn must not point at the node itself.",
  RELATION_CYCLE: "A dependency cycle blocks scheduling; break the loop.",
  FRONTMATTER_FIELD_MISSING: "frontmatter keeps wf-tags / wf-status / wf-titles / wf-updated for cross-file dataview queries.",
  FRONTMATTER_STATUS_MISMATCH: "Aggregation: all done→done; any doing→doing; any blocked→blocked; all cancelled/done→cancelled; otherwise todo.",
  FRONTMATTER_TITLES_MISMATCH: "wf-titles must equal workflows[].title item by item.",
  FRONTMATTER_UPDATED_MISMATCH: "wf-updated should be the date part of the JSON updatedAt.",
};

/**
 * 校验消息的**英文模板**（key 与调用点一一对应）。
 *
 * 中文原文留在调用点上（`issueMsg(key, zh, params)` 的第二个参数）：同一个 code 常有多套措辞
 * （`ID_FORMAT` 就有两种），把中文也搬进字典只会让两处各写一遍。中文模式直接回显调用点那句，
 * 英文模式才用这里的模板 + `{name}` 插值。
 */
const ISSUE_MESSAGES_EN: Readonly<Record<string, string>> = {
  "idFormat.pattern": "id \"{id}\" does not follow the convention (expected {prefix}<uuid>)",
  "idFormat.prefix": "id \"{id}\" has the {prefix} prefix ({actual}), but this field must be {expected}",
  "duplicateId": "id \"{id}\" appears {count} times (ids must be unique across the file)",
  "noteAnchorMissing": "Node {id} has noteAnchor \"{anchor}\", which is not found in the body",
  "noteAnchorDuplicated": "Anchor \"{anchor}\" appears {count} times in the body (lines {lines})",
  "noteAnchorNotHeading": "The line with anchor \"{anchor}\" is not a heading: {raw}",
  "noteAnchorNotMatchingId": "noteAnchor \"{anchor}\" should be \"{expected}\" (\"^\" + node id)",
  "orphanAnchor": "Anchor \"{anchor}\" is not referenced by any node's noteAnchor",
  "progressOverMax": "progress={progress} is greater than progress_max={max}",
  "statusHistoryMismatch": "The last statusHistory entry is \"{last}\", which does not match status=\"{status}\"",
  "completedAtMissing": "Node {id} ({title}) is done but has no completedAt",
  "timestampInvalid": "{field}=\"{value}\" is not a real date/time",
  "hoursRange": "hours={value} is not a finite number or is negative",
  "entryOrder": "endAt=\"{end}\" is earlier than startAt=\"{start}\"",
  "dateMismatch": "date=\"{date}\" should be \"{expected}\" (defined as the date part of startAt)",
  "frontmatterFieldMissing": "Missing summary fields: {fields}",
  "frontmatterStatusMismatch": "wf-status={shown}, but the JSON aggregates to {aggregate} ({label})",
  "frontmatterTitlesMismatch": "wf-titles=[{actual}] does not match workflows[].title=[{expected}]",
  "frontmatterUpdatedMismatch": "wf-updated={value} does not match the wfjson updatedAt (date part {expected})",
  "noteMarkerNested":
    "\"wf-note:begin:{id}\" is nested inside the section opened on line {line} ({parent}); close that section first",
  "noteMarkerUnpairedEnd": "End marker \"wf-note:end:{id}\" has no matching begin marker",
  "noteMarkerMismatch": "The end marker is \"{id}\", but the begin marker on line {line} is \"{parent}\"",
  "noteMarkerUnpairedBegin": "Begin marker \"wf-note:begin:{id}\" has no end marker before the end of the file",
  "schemaDepth": "Validation depth exceeds the limit ({max}); check for unexpected nesting",
  "schemaConstNoValue": "No value is allowed at this position",
  "schemaRefError": "Schema internal error: cannot resolve $ref \"{ref}\"",
  "schemaAnyOf": "Does not match any of the allowed forms (actual: {actual})",
  "schemaType": "Expected type {expected}, got {actual} ({value})",
  "schemaEnum": "Value must be one of: {allowed} (actual: {actual})",
  "schemaConst": "Value must be {expected} (actual: {actual})",
  "schemaMinLength": "At least {min} characters (actual {actual})",
  "schemaMaxLength": "At most {max} characters (actual {actual})",
  "schemaPattern": "Does not match the required format (pattern {pattern}); actual: {actual}",
  "schemaMin": "Must not be less than {min} (actual {actual})",
  "schemaMax": "Must not be greater than {max} (actual {actual})",
  "schemaMinItems": "At least {min} items required (actual {actual})",
  "schemaMaxItems": "At most {max} items allowed (actual {actual})",
  "schemaUnique": "Items must be unique: {item}",
  "schemaRequired": "Missing required field \"{field}\"",
  "schemaUnknownField": "Unknown field \"{field}\"",
  "multipleBlocks": "Line {line} starts wfjson block #{index} (the file has {total} in total)",
  "blockUnclosed": "The wfjson block starting on line {line} has no closing fence",
  "noBlock": "No ```wfjson block found",
  "jsonBom": "The wfjson content starts with a BOM (it was ignored)",
  "commentNotAllowed": "{kind}: {excerpt}",
  "trailingComma": "The comma on line {line}, column {column} is directly followed by \"{char}\"",
  "emptyJson": "The wfjson content is empty",
  "parseError": "JSON parse failed{where}",
  "schemaVersionUnsupported": "schemaVersion=\"{version}\" is not in the supported list [{list}]",
  "blockIgnored": "The wfjson block starting on line {line} is ignored{target}",
};

/** 取校验消息（当前语言）：`zh` 是调用点现算好的中文，英文表漏配时回落到它 */
export function issueMsg(key: string, zh: string, params?: Record<string, string | number>): string {
  if (currentLang === "zh") return zh;
  const template = ISSUE_MESSAGES_EN[key];
  if (template === undefined) return zh;
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (whole: string, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/** 按 code 取 hint（当前语言）；英文表漏配时回落到原文案 */
export function issueHint(code: IssueCode, fallback?: string): string | undefined {
  if (currentLang === "zh") return fallback;
  return ISSUE_HINTS_EN[code] ?? fallback;
}

/**
 * 星期名（`index` 0=周一 … 6=周日，与 `HeatmapCell.weekday` 同口径）。
 * 中文是「一 / 二 / …」（调用方自己补「周」），英文直接是 `Mon` / `Tue`。
 */
export function weekdayName(index: number): string {
  return t(`view.weekday.${index + 1}`);
}

/** id 种类名（`ids.ts` 的 `ID_KIND_LABELS` 译文） */
export function idKindLabel(kind: string): string {
  return t(`idKind.${kind}`);
}

/** `NODE_INFO_LABELS` 的译文（表单标签 / 报错提示共用） */
export function nodeInfoLabel(key: string): string {
  return t(`nodeinfo.${key}`);
}

/** `WORKFLOW_EDIT_LABELS` 的译文（表单标签 / 报错提示共用） */
export function workflowEditLabel(key: string): string {
  return t(`workflowedit.${key}`);
}



