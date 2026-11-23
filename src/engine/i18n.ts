/**
 * 国际化（i18n）—— Phase 10（v0.8）。
 *
 * 设计取舍：
 *  - **模块级可变状态**（`currentLang`），沿用 `views/wfView.ts` 里模块级状态那一套做法
 *    （Phase 24 起那里已按 `file.path` 分桶）：语言是全局设置，给每个分析 / 渲染函数都加一个
 *    `lang` 参数会污染整条调用链；插件在 `onload` 与设置变更时调一次 `setLang()`，
 *    引擎后续取文案即自动切换。
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
    zh: "… 另有 {count} 条问题未显示",
    en: "… {count} more issue(s) not shown",
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
  /** Phase 24：看板标签页的标题（绑定的笔记被删 / 路径为空时的兜底文案） */
  "view.board.title": { zh: "工作流看板", en: "Workflow board" },
  "view.hint.noFile": {
    zh: "警告 - 没找到要显示的工作流。",
    en: "Warning - No workflow to display. Open a workflow note, or insert the workflow view into a note.",
  },
  /**
   * Phase 24：绑定式看板（ItemView）专属提示。
   * 与 `view.hint.noFile` 分开：看板**不**回退活动文件（`options.strictFile`），
   * 所以「绑定笔记没了」和「Dataview 没给路径」是两种完全不同的处境。
   */
  "view.hint.noBoardFile": {
    zh: "⚠️ 这个看板绑定的笔记已被删除或移走。点左侧 Workflow Watcher 图标重新打开主看板即可。",
    en: "⚠️ The note this board was bound to was deleted or moved. Click the Workflow Watcher icon in the sidebar to reopen the main board.",
  },
  "view.hint.noBlock": {
    zh: "这份笔记里还没有工作流内容。",
    en: "This note has no workflow content yet.",
  },
  "view.hint.blocked": {
    zh: "⛔ 工作流数据有问题，已暂停显示（错误 {error} · 警告 {warning} · 提示 {info}）",
    en: "⛔ The workflow data has problems, so the view is paused ({error} error(s) · {warning} warning(s) · {info} info)",
  },
  "view.overview.active": { zh: "进行中工作流 {count}", en: "Active workflows: {count}" },
  "view.overview.archived": { zh: "已归档 {count}", en: "Archived: {count}" },
  "view.overview.cancelled": { zh: "已取消 {count}", en: "Cancelled: {count}" },
  "view.overview.nodes": { zh: "节点合计 {count}", en: "Nodes total: {count}" },
  "view.theme.label": { zh: "主题", en: "Theme" },
  "view.theme.writeFailed": { zh: "主题没有保存：{reason}", en: "Theme not saved: {reason}" },
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
  /** Phase 28：21 天窗口的结束日（默认今天；归档看板默认归档日） */
  "view.gantt.anchorDate": { zh: "最后一天", en: "Last day" },
  "view.gantt.anchorHint": {
    zh: "21 天窗口的最后一天；归档看板默认是归档时间",
    en: "Last day of the 21-day window; archived boards default to the archive date",
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
  /** 设置面板分组标题：全局 / 总览 / 工作流 / 统计（Phase 28） */
  "settings.group.global": { zh: "全局", en: "Global" },
  "settings.group.overview": { zh: "总览", en: "Overview" },
  "settings.group.workflow": { zh: "工作流", en: "Workflow" },
  "settings.group.stats": { zh: "统计", en: "Stats" },
  "settings.timerFontSize.name": { zh: "计时器字号", en: "Timer font size" },
  "settings.timerFontSize.desc": {
    zh: "节点开始计时后，总览区计时数字的大小。",
    en: "Size of timer number in overview area after node timing starts.",
  },
  "settings.lang.name": { zh: "语言", en: "Language" },
  "settings.lang.desc": {
    zh: "界面文字和提示信息使用的语言。",
    en: "Language used for the interface and messages.",
  },
  /** Phase 18 ③：渲染区顶部的大标题（空串 = 用 i18n 的「下一步是？」） */
  "settings.resumePrompt.name": { zh: "引导性话语", en: "Prompt line" },
  "settings.resumePrompt.desc": {
    zh: "总览区的标题。",
    en: "Title of Overview Area.",
  },
  "settings.resumePrompt.placeholder": { zh: "接下来，想怎么做?", en: "What's next?" },
  /** Phase 18 ⑦：卡片宽度（写到根元素 `--wf-card-width`，优先于所有主题） */
  "settings.cardWidth.name": { zh: "卡片宽度（px）", en: "Card width (px)" },
  "settings.cardWidth.desc": {
    zh: "节点卡片的宽度，可填 150~400，默认 250。",
    en: "Width of a node card — 150–400 px, default 250.",
  },
  /** Phase 20：note 卡片最多显示几条（视图按它 slice `note` 数组，1~10） */
  "settings.noteLines.name": { zh: "note 卡片显示条数", en: "Note card items" },
  "settings.noteLines.desc": {
    zh: "note 卡片最多显示几条内容，可填 1~10；多出来的不会显示，也不会丢失。",
    en: "How many items a note card shows — 1–10. Extra items are hidden, never lost.",
  },
  /* ---- 视图：分组块 / 卡片 / 归档信息 ---- */
  //"view.block.active": { zh: "🧭 工作流：正在进行 {count}   | 🔋 节点：活跃 {active}/{total} 阻塞 {blocked}", en: "🧭 Workflow: In progress {count}   | 🔋 Nodes: Active {active}/{total}, Blocked {blocked}" },
  "view.block.active": { zh: " |  工作流：正在进行 {count}   |  节点：活跃 {active}/{total} 阻塞 {blocked}", en: "|  Workflow: In progress {count}   |  Nodes: Active {active}/{total}, Blocked {blocked}" },
  "view.block.activeEmpty": { zh: "（暂无进行中的工作流）", en: "(No workflow in progress)" },
  "view.block.editWorkflows": { zh: "编辑工作流", en: "Edit workflows" },
  // Phase 15：块尾的「修改节点顺序」开关（排在「修改工作流」之前）
  "view.block.reorderNodes": { zh: "修改节点顺序", en: "Reorder nodes" },
  "view.block.doneFlow": { zh: "已完成", en: "Completed" },
  "view.block.cancelledFlow": { zh: "已取消", en: "Cancelled" },
  /* Phase 25：overview 下拉开关 + 左侧导航条 */
  "view.overview.toggle": { zh: "展开 / 收起总览", en: "Expand / collapse overview" },
  /**
   * Phase 27 M2：「未分类」钉死列。
   *
   * 三处共用：列头标题（也是未分类伪流写入时的 workflow.title）、「+ 新建节点」按钮、列头落点提示。
   */
  "view.unclassified.title": { zh: "未分类", en: "Uncategorized" },
  "view.unclassified.new": { zh: "+", en: "+" },
  "view.unclassified.dropHint": {
    zh: "拖到这里，成为未分类的顶层节点",
    en: "Drop here to make it an uncategorized top-level node",
  },
  "view.nav.item": { zh: "跳到「{title}」", en: "Jump to “{title}”" },
  /* Phase 29：左侧导航下拉面板的两列标题 + 总览开关（按钮文案） */
  "view.nav.stats": { zh: "统计", en: "Statistics" },
  "view.nav.modify": { zh: "编辑", en: "Edit" },
  "view.nav.overview": { zh: "总览", en: "Overview" },
  /* Phase 33：面板「修改」列第 5 个开关 —— 藏 / 放「未分类」那一框（文案 = `未分类：显示 / 隐藏`） */
  "view.nav.unclassifiedShow": { zh: "开", en: "On" },
  "view.nav.unclassifiedHide": { zh: "关", en: "Off" },
  "view.nav.unclassifiedHint": {
    zh: "藏起「未分类」整块（进行中工作流的位置不变）",
    en: "Hide the whole Uncategorized block (in-progress workflows stay put)",
  },
  /* Phase 29：导航面板开关自己的 tooltip（`renderCollapseToggle` 的 `data-label`） */
  "view.nav.panel": { zh: "菜单面板", en: "Menu panel" },
  /* Phase 25 M4：右侧节点操作面板（多选项卡，节点操作统一入口；Phase 36 增至 7 个） */
  "view.panel.title": { zh: "节点操作", en: "Node actions" },
  "view.panel.close": { zh: "关闭", en: "Close" },
  "view.panel.tab.info": { zh: "编辑节点信息", en: "Edit node info" },
  "view.panel.tab.note": { zh: "设置 note 节点", en: "Set note node" },
  "view.panel.tab.child": { zh: "添加子节点", en: "Add child node" },
  "view.panel.tab.workflow": { zh: "编辑工作流", en: "Edit workflows" },
  "view.panel.tab.archive": { zh: "为此及之后归档", en: "Archive from here" },
  "view.panel.tab.delete": { zh: "删除本节点", en: "Delete this node" },
  /* Phase 34：链接文档选项卡 —— 编辑节点链接文档（反向 YAML 归属的列表 + 新建） */
  "view.panel.tab.links": { zh: "编辑节点链接文档", en: "Edit node link docs" },
  "view.linkDocs.title": { zh: "编辑节点链接文档：{title}", en: "Edit node link docs: {title}" },
  "view.linkDocs.desc": {
    zh: "关联：使用工作流/节点的uid匹配仓库中markdown的yaml标签，若yaml id缺省，则匹配工作流/节点名\n相关yaml标签：`wf-workflow`, `wf-node`, `wf-workflow-id`, `wf-node-id`\n自动修改：当修改工作流名/节点名/归档时，插件会自动修改标签\n链接已有文档：给已有markdown文件添加标签\n链接新文档：新建含yaml标签的文档",
    en: "Linking: Match Markdown YAML tags in the repository using the workflow/node UID. If the YAML id is omitted, match by workflow/node name.\nRelevant YAML tags: `wf-workflow`, `wf-node`, `wf-workflow-id`, `wf-node-id`\nAutomatically update: The plugin will automatically update tags when workflow name, node name or archive status is modified.\nLink existing document: Add tags to an existing Markdown file\nLink new document: Create a new document with YAML tags",
  },
  "view.linkDocs.list": { zh: "已关联的文档", en: "Linked documents" },
  "view.linkDocs.refresh": { zh: "刷新", en: "Refresh" },
  "view.linkDocs.empty": { zh: "（还没有关联文档）", en: "(No linked documents yet)" },
  "view.linkDocs.open": { zh: "在新标签页打开", en: "Open in a new tab" },
  "view.linkDocs.name": { zh: "文件名", en: "File name" },
  "view.linkDocs.namePlaceholder": { zh: "留空时用节点名", en: "Defaults to the node title" },
  "view.linkDocs.dir": { zh: "相对路径", en: "Relative path" },
  "view.linkDocs.dirPlaceholder": { zh: "留空时放在库根目录", en: "Leave empty to use the vault root" },
  "view.linkDocs.create": { zh: "新建", en: "New" },
  "view.linkDocs.created": { zh: "已新建：{path}", en: "Created: {path}" },
  /* Phase 35：链接已有文档（已有 md → 增补四键；「选择」走桌面端文件选择器） */
  "view.linkDocs.addAddress": { zh: "链接已有文档", en: "Link existing document" },
  "view.linkDocs.createAddress": { zh: "链接新文档", en: "Link new document" },
  "view.linkDocs.addAddressPlaceholder": {
    zh: "填写或选择文档路径，按回车添加",
    en: "Enter or select a document path, then press Enter",
  },
  "view.linkDocs.choose": { zh: "选择", en: "Choose…" },
  "view.linkDocs.attach": { zh: "添加", en: "Add" },
  "view.linkDocs.attached": { zh: "已关联：{path}", en: "Linked: {path}" },
  "view.linkDocs.alreadyLinked": {
    zh: "已在列表里：{path}（没有重复添加）",
    en: "Already linked: {path} (no duplicate added)",
  },
  "view.linkDocs.emptyPath": {
    zh: "先选一份文档，或填写它的路径",
    en: "Pick a document or enter its path first",
  },
  "view.linkDocs.outsideVault": {
    zh: "不在当前库内：{path}",
    en: "Not inside this vault: {path}",
  },
  "view.linkDocs.notFound": {
    zh: "库里找不到这份文档：{path}",
    en: "No such file in the vault: {path}",
  },
  "view.linkDocs.pickUnsupported": {
    zh: "桌面端才能打开文件选择器，请直接填写路径",
    en: "The file picker works on desktop only — type the path instead",
  },
  "view.linkDocs.pickFailed": {
    zh: "打不开文件选择器：{reason}",
    en: "Could not open the file picker: {reason}",
  },
  "view.linkDocs.invalidName": {
    zh: "文件名不合法，请换一个名字",
    en: "That file name isn't valid — try another one",
  },
  "view.linkDocs.invalidDir": {
    zh: "文件夹名不合法：不能包含 : * ? \" < > | 等字符，也不能是 . 或 ..",
    en: "Invalid folder name: avoid : * ? \" < > |, and don't use . or ..",
  },
  "view.linkDocs.noWorkflow": {
    zh: "找不到这个节点所属的工作流，无法建立关联。",
    en: "Can't find the workflow this node belongs to, so the link can't be saved.",
  },
  "view.linkDocs.synced": {
    zh: "已更新 {count} 份文档的关联",
    en: "Updated the link in {count} document(s)",
  },
  "view.linkDocs.syncFailed": {
    zh: "没能更新 {path} 的关联：{reason}",
    en: "Couldn't update the link in {path}: {reason}",
  },
  "view.notify.linkDocsCreated": {
    zh: "已为「{title}」新建 {count} 份链接文档",
    en: "Created {count} link doc(s) for “{title}”",
  },
  "view.notify.linkDirSaved": {
    zh: "已更新「{title}」的新建相对路径",
    en: "Updated the new-doc folder for “{title}”",
  },
  "view.block.archived": { zh: "已归档看板（{count}）", en: "Archived board ({count})" },
  /* Phase 16：左侧小工具侧边栏 + 弹窗（前 4 个开弹窗，第 5 个直接开插件设置） */
  "view.widget.sidebar": { zh: "小工具", en: "Widgets" },
  "view.widget.gantt21": { zh: "21天甘特图", en: "21-day Gantt" },
  "view.widget.quadrant": { zh: "4象限节点", en: "4-quadrant nodes" },
  "view.widget.plot365": { zh: "365天折线图", en: "365-day plot" },
  "view.widget.settings": { zh: "插件设置", en: "Plugin settings" },
  "view.widget.close": { zh: "关闭", en: "Close" },
  "view.widget.placeholder": {
    zh: "这个位置预留给后续版本：该小工具还没实现。",
    en: "Reserved for a later version: this widget is not implemented yet.",
  },
  "view.widget.emptyArchive": { zh: "还没有归档节点", en: "No archived nodes yet" },
  /* Phase 28：导入/导出 + 开始/完成记录两个小工具 */
  "view.widget.data": { zh: "导入 / 导出看板", en: "Import / Export board" },
  "view.widget.records": { zh: "开始 / 完成日志", en: "Start / Complete log" },
  "view.widget.emptyRecords": {
    zh: "还没有开始或完成的节点",
    en: "No started or completed nodes yet",
  },
  /* Phase 40：schema警告 —— 只列 wfjson 里「多出来、不在设计内」的字段（不阻断看板渲染） */
  "view.widget.schemaWarn": { zh: "schema警告", en: "Schema warnings" },
  "view.schemaWarn.summary": {
    zh: "共 {count} 个未定义字段",
    en: "{count} unknown field(s)",
  },
  "view.schemaWarn.empty": { zh: "没有未定义字段", en: "No unknown fields" },
  "view.schemaWarn.path": { zh: "json：{path}", en: "json: {path}" },
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
  "widget.plot.kind.dateHint": { zh: "日期，如 2026-01-01", en: "a date, e.g. 2026-01-01" },
  "widget.plot.kind.sequenceHint": { zh: "序号，如 1、2、3", en: "a number, e.g. 1, 2, 3" },
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
    zh: "图表文件目录名。365天plot功能数据和导出的 CSV 都存在这个文件夹里（默认 plots）。",
    en: "Chart File Directory Name. Data for the 365-day plot function and exported CSV files are stored in this folder (default: plots).",
  },
  /* Phase 37：看板文件目录 + 图表文件根目录 */
  "settings.boardFolder.name": { zh: "看板文件目录", en: "Board folder" },
  "settings.boardFolder.desc": {
    zh: "默认 _workflowwatcher。改目录会把现有文件夹整体改名过来；目标已存在时不动。",
    en: "default “_workflowwatcher”. Changing it renames the existing folder; if the target already exists nothing is moved.",
  },
  "settings.plotRoot.name": { zh: "图表文件根目录", en: "Plot root" },
  "settings.plotRoot.desc": {
    zh: "图表文件目录放在哪里。看板根目录可在插件设置 > 全局中修改。",
    en: "Where to place the chart file directory. Dashboard root directory can be changed in Plugin Settings > Global.",
  },
  "settings.plotRoot.board": { zh: "看板根目录", en: "Board folder" },
  "settings.plotRoot.vault": { zh: "仓库根目录", en: "Vault root" },

  /* Phase 27 M3：不再「跳到本文件纪要」（纪要段已弃用），提示只讲右键菜单 */
  "view.card.titleTooltip": {
    zh: "左键无动作；右键：资料文档、改状态、计时、编辑节点信息、归档",
    en: "Left click: nothing; right click: linked docs, status, timer, node info, archive",
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
  /* Phase 20：note 卡片左上角的小标签（CSS 里 `text-transform: uppercase` 会把它转成大写） */
  "view.nodeNote.tag": { zh: "note", en: "Note" },
  /* Phase 20 修订：note 方块按钮的读屏文案（视觉上只有一个方框，靠它说明点下去会变成什么） */
  "view.nodeNote.markDone": { zh: "标记为已办", en: "Mark as done" },
  "view.nodeNote.markTodo": { zh: "标记为待办", en: "Mark as todo" },
  "view.archive.file": { zh: "📄 {path}（归档于 {time}）", en: "📄 {path} (archived at {time})" },
  /* Phase 37：已归档弹窗的「全局视角」区块（扫 archive/*.wf.json） */
  "view.archive.filesTitle": { zh: "归档文件（{count}）", en: "Archive files ({count})" },
  "view.archive.filesHint": {
    zh: "磁盘上看板目录/archive 下的全部归档文件",
    en: "Every archive file under the board folder's archive/.",
  },
  /** Phase 39：懒加载读数期间的占位 */
  "view.archive.loading": { zh: "读取归档信息…", en: "Reading archive info…" },
  /** Phase 39：一行归档文件上永远显示的来源 / 时间 */
  "view.archive.fromWorkflow": { zh: "来源：{title}", en: "From: {title}" },
  "view.archive.archivedAt": { zh: "归档于 {time}", en: "Archived {time}" },
  "view.archive.infoEmpty": { zh: "还没有说明（点「编辑归档信息」补上）", en: "No notes yet (use “Edit archive info” to add some)" },
  "view.archive.openFile": { zh: "📄 打开 {path}", en: "📄 Open {path}" },
  /* Phase 22：整条工作流归档的行首角标（独立元素，拼在标题前面） */
  "view.archive.fullWorkflow": { zh: "[完整工作流]", en: "[Full workflow]" },
  "view.archive.infoTitle": { zh: "归档信息", en: "Archive info" },
  "view.archive.summary": { zh: "概括：{text}", en: "Summary: {text}" },
  "view.archive.idea": { zh: "原理 / 启发：{text}", en: "Principle / insight: {text}" },
  "view.archive.review": { zh: "复盘 / 下一步：{text}", en: "Retro / next steps: {text}" },
  /* Phase 38：编辑归档信息（三段文字）的入口按钮 */
  "view.archive.edit": { zh: "编辑", en: "Edit" },
  "view.archive.open": { zh: "打开", en: "Open" },
  "view.archive.tag": { zh: "标签：{text}", en: "Tags: {text}" },
  "view.archive.filter": { zh: "按标签筛选", en: "Filter by tag" },
  "dialog.archive.tag": { zh: "标签", en: "Tags" },
  "dialog.archive.tagHint": { zh: "用逗号分隔；点下方标签卡片可快速加入", en: "Comma-separated; click a tag card below to add it" },

  /* ---- 主题名（与 styles.css 的 [data-wf-theme] 一一对应） ---- */
  "idKind.file": { zh: "文件", en: "file" },
  "idKind.workflow": { zh: "工作流", en: "workflow" },
  "idKind.node": { zh: "节点", en: "node" },
  "idKind.link": { zh: "链接", en: "link" },
  "theme.default": { zh: "默认", en: "Default" },
  "theme.tech": { zh: "科技", en: "Tech" },
  "theme.nature": { zh: "自然", en: "Nature" },
  "theme.magazine": { zh: "杂志", en: "Magazine" },
  "theme.retro": { zh: "复古", en: "Retro" },
  "theme.polka": { zh: "波点", en: "Polka Dot" },
  "theme.web": { zh: "网页", en: "Web" },
  "theme.fresh": { zh: "清新", en: "Fresh" },
  "theme.shoujo": { zh: "少女", en: "Shoujo" },

  /* ---- 视图：右键菜单 / 操作提示 ---- */
  /* Phase 27 M3：右键菜单第一组 = 「资料文件」（反向 YAML 关联） */
  "view.menu.noLinks": { zh: "（该节点暂无资料文件）", en: "(No linked files for this node yet)" },
  /* Phase 34：菜单最多列 5 份资料，其余进「编辑节点链接文档」面板看 */
  "view.menu.moreLinks": {
    zh: "… 另有 {count} 份（在「编辑节点链接文档」里查看）",
    en: "… {count} more (see “Edit node link docs”)",
  },
  "view.menu.editLinkDocs": { zh: "🔗 编辑链接文档", en: "🔗 Edit link docs" },
  "view.link.unsupported": {
    zh: "目前只能关联 Markdown 文件",
    en: "Only Markdown files can be linked for now",
  },
  "view.menu.markAs": { zh: "{icon} 标记为{label}", en: "{icon} Mark as {label} " },
  "view.menu.startTimer": { zh: "⏰ 开始计时", en: "⏰ Start timer" },
  "view.menu.stopRecord": { zh: "⏰ 结束并记录", en: "⏰ Stop and record" },
  "view.menu.stopDiscard": { zh: "⏰ 结束并丢弃", en: "⏰ Stop and discard" },
  "view.menu.otherTimer": {
    zh: "⏰ 正在「{title}」计时（请先结束它）",
    en: "⏰ Timing “{title}” — stop it first",
  },
  "view.menu.editNode": { zh: "⚙️ 编辑节点信息", en: "⚙️ Edit node info" },
  /* Phase 20：note 卡片的正文 + 显示开关（note 卡右键的唯一入口；节点菜单已并入面板 tab） */
  "view.menu.setNodeNote": { zh: "⚙️ 设置 note 节点", en: "⚙️ Set note node" },
  "view.menu.openArchive": { zh: "📦 打开归档文件", en: "📦 Open archive file" },
  "view.menu.archiveFrom": { zh: "📦 为此及之后归档", en: "📦 Archive this node and all below" },
  "view.menu.archiveFromBlocked": {
    zh: "📦 为此及之后归档",
    en: "📦 Archive this node and all below",
  },
  "view.menu.cannotArchive": { zh: "📦 不可归档", en: "📦 Cannot archive" },
  /* Phase 22：根节点只给「归档整个工作流」（根不能再做子树归档） */
  "view.menu.archiveWorkflow": { zh: "📦 归档整个工作流", en: "📦 Archive the whole workflow" },
  "view.menu.archiveWorkflowBlocked": {
    zh: "📦 归档整个工作流",
    en: "📦 Archive the whole workflow",
  },
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
  /**
   * Phase 21 ⑥：开关「开」时按钮上方的拖拽规则说明（`.wf-reorder-help`，CSS `white-space: pre-line`）。
   * 四行示意图照契约原文；最后一行「特别注意」按用户口径写成「父节点与子节点不能互换位置」
   * （相邻兄弟互换不禁，见契约「拖拽规则补充契约」）。
   */
  "view.reorder.help": {
    zh: [
      "A--^X--B/C/D: 将卡片X拖到卡片A下半部分，插入到A的后面，B/C/D的前面",
      "A--B/C/D/^X: 将卡片X拖到卡片B上半部分，插入到A的后面，与B/C/D同层",
      "A--^X.--B/C/D: 将折叠卡片X拖到卡片A下半部分，插入到A的后面，B/C/D的前面，移动X后的所有卡片，注意：B/C/D是X的child",
      "A--B/C/D/^X.: 将折叠卡片X拖到卡片B上半部分，插入到A的后面，与B/C/D同层，移动X后的所有卡片",
      "特别注意：父节点与子节点不能互换位置；根节点不能被拖动",
    ].join("\n"),
    en: [
      "A--^X--B/C/D: drag card X onto the lower half of card A — inserted after A, before B/C/D",
      "A--B/C/D/^X: drag card X onto the upper half of card B — inserted after A, at the same level as B/C/D",
      "A--^X.--B/C/D: drag folded card X onto the lower half of card A — inserted after A, before B/C/D; every card below X moves with it, so B/C/D become X's children",
      "A--B/C/D/^X.: drag folded card X onto the upper half of card B — inserted after A, at the same level as B/C/D; every card below X moves with it",
      "Note: a parent and its own child cannot swap places; a root card cannot be dragged",
    ].join("\n"),
  },
  /** Phase 21 ⑤：折叠态写回 JSON 失败（视图随后会整块重渲染回到 JSON 事实） */
  "view.notify.collapseFailed": {
    zh: "折叠状态未写入：{reason}",
    en: "Collapse state not written: {reason}",
  },
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
  /* ---- Phase 20：note 卡片 ---- */
  "view.notify.nodeNoteUnchanged": {
    zh: "「{title}」的 note 没有变化",
    en: "Note of “{title}” is unchanged",
  },
  "view.notify.nodeNoteUpdated": {
    zh: "已更新「{title}」的 note{suffix}",
    en: "Note updated for “{title}”{suffix}",
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
  /* Phase 27 M3：删除节点不再「合并链接」（纪要段已弃用）——`nodeDeleted` 去掉 `{linkNote}` */
  "view.notify.nodeDeleted": {
    zh: "已删除「{title}」，子节点已上移{suffix}",
    en: "Deleted “{title}” and moved its children up{suffix}",
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
  "view.notify.archiveAppended": {
    zh: "已追加归档「{title}」（追加 {count} 个节点）→ {target}{suffix}",
    en: "Appended to archive “{title}” ({count} node(s) added) → {target}{suffix}",
  },
  "view.notify.cannotArchive": {
    zh: "不能归档「{title}」：{reason}",
    en: "Cannot archive “{title}”: {reason}",
  },
  "view.notify.upgraded": {
    zh: "（已按当前格式显示，文件没有改动）",
    en: " (shown in the current format; the file is unchanged)",
  },
  "view.notify.issuesHint": {
    zh: "（明细见本视图顶部的问题提示）",
    en: "(details: see the issue banner at the top of this view)",
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
  "common.close": { zh: "关闭", en: "Close" },
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
  "field.ownerOptional": { zh: "负责人", en: "Owner" },
  "field.dueAt": { zh: "截止时间", en: "Due" },
  "field.dueAtOptional": { zh: "截止时间", en: "Due" },
  "field.dueAtDefault": { zh: "截止日", en: "Due date" },
  "field.summary": { zh: "概要", en: "Summary" },
  "field.summaryOptional": { zh: "概要", en: "Summary" },
  "field.type": { zh: "类型", en: "Type" },
  "field.typeOptional": { zh: "类型", en: "Type" },
  "field.outline": { zh: "概括", en: "Summary" },
  "field.idea": { zh: "原理 / 启发", en: "Principle / insight" },
  "field.review": { zh: "复盘 / 下一步", en: "Retro / next steps" },
  "field.year": { zh: "年", en: "YYYY" },
  "field.month": { zh: "月", en: "MM" },
  "field.day": { zh: "日", en: "DD" },
  "field.yearDefault": { zh: "年", en: "YYYY" },
  "field.dueDate": { zh: "截止日", en: "Due date" },

  /* ---- 标签后缀（中文用全角括号，英文用半角 + 前置空格） ---- */
  "suffix.range0to999": { zh: "（0-999）", en: " (0-999)" },
  "suffix.range1to4": { zh: "（1-4）", en: " (1-4)" },
  "suffix.optional": { zh: "", en: "" },

  /* ---- 通知（Notice）与内部拒绝原因 ---- */
  "notice.noDv": {
    zh: "wfjson 视图：没有拿到可用的 dataview `dv`，请在 dataviewjs 代码块里调用 render(dv)",
    en: "wfjson view: no usable dataview `dv` — call render(dv) inside a dataviewjs block",
  },
  "notice.sidecarExists": { zh: "外置 JSON 未同步：{path} 已存在", en: "External JSON not synced: {path} already exists" },
  "notice.renameFailed": { zh: "外置 JSON 重命名同步失败：{message}", en: "Failed to rename the external JSON: {message}" },
  /* Phase 16：侧边栏 ⚙️ 打不开设置页（Obsidian 版本差异 / 内部对象不在） */
  "notice.settingsOpenFailed": { zh: "打开插件设置失败", en: "Failed to open plugin settings" },
  /** Phase 24：归档 md 被删 / 被移走后点归档链接（不再回落 `openLinkText`） */
  "notice.archiveMissing": {
    zh: "归档文件不存在（可能已被移动或删除）：{path}",
    en: "Archive file not found (it may have been moved or deleted): {path}",
  },
  /** Phase 39：`node.archive` 只剩 workflowId —— 按 id 扫不到那份归档时提示带上它 */
  "notice.archiveMissingById": {
    zh: "找不到这份归档文件（workflowId：{id}，可能已被移动或删除）",
    en: "Archive file not found (workflowId: {id}; it may have been moved or deleted)",
  },
  /** Phase 24 M1.5：归档侧车写不进去 → 已退回内联 wfjson（功能不受影响，只是不成对） */
  "notice.archivePairFallback": {
    zh: "归档侧车写入失败（{message}）：{path} 已退回内联 wfjson",
    en: "Could not write the archive sidecar ({message}) — {path} fell back to inline wfjson",
  },
  "reject.noBlock": { zh: "未选择节点", en: "No node selected" },
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
  "reject.workflowFailed": { zh: "编辑工作流失败", en: "Failed to edit workflows" },
  "reject.cannotArchive": { zh: "节点 {id} 不能归档", en: "Node {id} cannot be archived" },
  "reject.archiveFailed": { zh: "归档节点 {id} 失败", en: "Failed to archive node {id}" },
  "reject.cannotArchiveWorkflow": { zh: "工作流 {id} 不能归档", en: "Workflow {id} cannot be archived" },
  "reject.archiveWorkflowFailed": { zh: "归档工作流 {id} 失败", en: "Failed to archive workflow {id}" },
  "reject.planMissingDoc": { zh: "迁移计划缺少文档", en: "The migration plan has no document" },

  /* ---- 命令 ---- */
  /**
   * **唯一**的命令（Phase 25 单看板模型）：打开 / 就地创建 `_workflowwatcher/main~<key>.md` 的看板
   * （md 与同名同键的侧车 `main~<key>.wf.json` 成对，命名见 `src/engine/mainBoard.ts`）。
   * 左侧 ribbon 图标走同一个入口（`addRibbonIcon` 的 tooltip 用的也是这条文案）。
   */
  "command.openMainBoard": {
    zh: "打开 workflow watcher 主看板",
    en: "Open workflow watcher main board",
  },
  /**
   * Phase 27 M3：「给当前文件打上工作流 / 节点标签」命令（正向打标签，**不是**迁移命令）。
   * 命令面板文案 = `cmd.tagFile`；Modal 内的标题 / 两个下拉 / 按钮 / 成功提示 = `view.tag.*`。
   */
  "cmd.tagFile": {
    zh: "给当前文件打上工作流 / 节点标签",
    en: "Tag current file with workflow / node",
  },
  "view.tag.title": { zh: "设置资料归属", en: "Set affiliation" },
  "view.tag.workflow": { zh: "工作流", en: "Workflow" },
  "view.tag.node": { zh: "节点", en: "Node" },
  "view.tag.write": { zh: "写入", en: "Write" },
  "view.tag.done": { zh: "已写入 `wf-workflow` / `wf-node`", en: "Wrote `wf-workflow` / `wf-node`" },
  "view.tag.noBoard": { zh: "请先打开一个工作流看板", en: "Open a workflow board first" },
  "view.tag.noFile": {
    zh: "当前没有可打标签的 md（请先切到要标记的资料文件）",
    en: "No markdown file to tag (switch to the material file first)",
  },
  "view.tag.noNode": { zh: "该工作流没有可选节点", en: "This workflow has no selectable nodes" },
  /** 主看板的 md / json 是第一次点命令 / 图标时现造的 */
  "notice.mainBoardCreated": {
    zh: "已创建主看板：{path}",
    en: "Main board created: {path}",
  },
  /**
   * 插件目录里有多份「像主看板」的 md（`main~<key>.md` / 老的 `main.md` / 手工复制的 `main_2.md`）。
   *
   * 只提示、不删不合并：打开的是排在最前的那份（`mainBoard.rankMainBoardPaths`），其余留给用户自己看。
   */
  "notice.mainBoardDuplicate": {
    zh: "发现 {count} 个主看板文件，已打开：{path}（其余请手工合并或删除）",
    en: "Found {count} main board files; opened: {path} (merge or delete the others yourself)",
  },
  /** 老命名 `main.md` → 带键的 `main~<key>.md` 自动改名成功（键不变，侧车原地不动） */
  "notice.mainBoardRenamed": {
    zh: "主看板已改名为带身份键的规范名：{from} → {to}",
    en: "Main board renamed to the keyed canonical name: {from} → {to}",
  },
  /** 插件目录改名（`_wfjson` → `_workflowwatcher`）时的一次性搬家 */
  "notice.folderMigrated": {
    zh: "插件目录已改名：{from} → {to}（里面的外置 JSON 原样保留）",
    en: "Plugin folder renamed: {from} → {to} (external JSON kept as is)",
  },
  "notice.folderConflict": {
    zh: "旧的 {from} 与新的 {to} 同时存在，未自动合并：请手工把前者里的文件移到后者",
    en: "Both the legacy {from} and the new {to} exist; not merged automatically — please move the files yourself",
  },
  /** 主看板开不起来（路径被占 / 建目录失败等） */
  "notice.mainBoardFailed": {
    zh: "主看板打开失败：{message}",
    en: "Failed to open the main board: {message}",
  },
  /** 目标路径被目录 / 别的文件占着（拒绝写盘，用户自己处理） */
  "reject.pathOccupied": {
    zh: "路径被占用（同名文件夹或其它类型）：{path}",
    en: "Path is taken (a folder or another type): {path}",
  },

  /* ---- 工作流模板正文（`buildWorkflowTemplate()` 生成；语言为 en 时模板必须全英文） ---- */
  /** 模板默认工作流名 / 根节点标题 */
  "template.defaultTitle": { zh: "新工作流", en: "New workflow" },
  /** 纪要段落上方的大标题（`## <heading>`） */
  "template.heading": { zh: "纪要", en: "Notes" },
  /**
   * 新纪要段落的占位正文。
   * 引擎靠这个字符串判断「这段正文只是占位符」（`noteSection.ts` 的 `isNotePlaceholder`），
   * 所以**两种语言的写法都必须认得** —— 别把 en 值改成语义不同的句子。
   */
  "template.notePlaceholder": { zh: "（纪要待补充）", en: "(Notes pending)" },

  /* ---- 对话框：添加子节点 ---- */
  "dialog.addChild.title": { zh: "添加子节点：{title}", en: "Add a child node: {title}" },
  "dialog.addChild.desc": {
    zh: "创建一个`未开始`的新节点，根据创建时间生成`已经过：X天`，默认一周后截止\n仅标题为必填项，其他可留空（清空该字段）\n标题：工作流中的子任务\n已完成&总量：转化为进度条，在卡片底部显示\n重要度&紧急度：值越大越重要/紧急；在`统计-4象限节点`中按值展示\n负责人：子任务负责人，暂未开发相关功能\n截止时间：修改后，将同步修改`距结束x天`",
    en: "Create a new `Not started` node. Record creation time to generate `Elapsed: Xd`; due date defaults to one week later.\nOnly the title is required; others may be left blank (to clear the field).\nTitle: Subtask in workflow\nDone & Total: Rendered as a progress bar at the bottom of the card\nImportance & Urgency: Higher values mean higher important/urgency; displayed by value in `Stats - 4-quadrant nodes`\nOwner: Person responsible for the subtask; related features not yet implemented\nDue: When modified, `Left:xd` will update accordingly",
  },
  "dialog.addChild.titlePlaceholder": { zh: "例如：整理访谈录音", en: "e.g. Transcribe the interview" },

  /* ---- 对话框：删除节点 ---- */
  "dialog.delete.title": { zh: "删除本节点：{title}", en: "Delete this node: {title}" },
  "dialog.delete.desc": {
    zh: "此操作不可撤销。",
    en: "This cannot be undone.",
  },
  "dialog.delete.itemSelf": {
    zh: "",
    en: "",
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
  "dialog.archive.title": { zh: "归档（为此及之后）：{title}", en: "Archive (this node and all below): {title}" },
  "dialog.archive.desc": {
    zh: "将其全部后代移动到一个新看板。\n可通过`统计-已归档`打开归档看板\n条件：1. 子树节点均已完成 2. 不是叶节点",
    en: "Move all its descendants to a new board.\nOpen the archived dashboard via `Statistics - Archived`.\nConditions: 1. All nodes in the subtree are completed. 2. Not a leaf node.",
  },
  "dialog.archive.itemFile": {
    zh: "节点 {total} 个：本节点 + {descendants} 个后代",
    en: "{total} node(s): this node + {descendants} descendant(s)",
  },
  "dialog.archive.itemLocal": {
    zh: "本文件里：后代节点删掉",
    en: "In this file: descendant nodes are removed",
  },
  "dialog.archive.itemIds": {
    zh: "当前版本该表单仅在此处修改，归档后如需改动，请修改_workflowwatche/main~xxxx.wf.json中本节点的`archive.summary`,`archive.idea`,`archive.review`值",
    en: "In the current version, this form can only be edited here. To make changes after archiving, modify the `archive.summary`, `archive.idea`, `archive.review` values of this node in _workflowwatche/main~xxxx.wf.json.",
  },
  "dialog.archive.itemUnfinished": {
    zh: "注意：子树里还有 {count} 个未完成节点，归档需要全部已完成",
    en: "Note: The subtree still has {count} unfinished node(s). All nodes must be completed before archiving.",
  },
  "dialog.archive.hint": {
    zh: "",
    en: "",
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
  /* Phase 38：编辑归档信息（只改三段文字） */
  "dialog.archiveInfo.title": { zh: "编辑归档信息：{title}", en: "Edit archive info: {title}" },
  "dialog.archiveInfo.desc": {
    zh: "只改概括 / 原理 / 复盘三段说明；归档时间与归档文件不变。",
    en: "Only the summary / idea / review notes change; the archive time and file stay the same.",
  },
  /* Phase 22：同一个 Modal 的「归档整个工作流」口径（输入框 / 保存逻辑与上面完全复用） */
  "dialog.archiveWorkflow.title": { zh: "归档整个工作流", en: "Archive the whole workflow" },
  "dialog.archiveWorkflow.desc": {
    zh: "把工作流「{title}」整体浓缩成一个归档节点。",
    en: "Condense the whole workflow “{title}” into a single archived node.",
  },
  "dialog.archiveWorkflow.itemLocal": {
    zh: "本文件里：其余节点与其正文纪要段落删掉，根节点压成一个带 archive 的已完成节点，并记一条 workflow_archive 台账",
    en: "In this file: the other nodes and their note sections are removed, the root collapses into a done node carrying `archive`, and one `workflow_archive` ledger entry is recorded",
  },
  "dialog.archiveWorkflow.itemOrigin": {
    zh: "归档 md 里的 workflow 不写 originId（整条流已整体搬过去）",
    en: "The workflow in the archive md carries no originId (the whole workflow moved there)",
  },
  /* ---- 对话框：编辑节点信息 ---- */
  "dialog.editNode.title": { zh: "编辑节点信息：{title}", en: "Edit node info: {title}" },
  "dialog.editNode.desc": {
    zh: "仅标题为必填项，其他可留空（清空该字段）\n标题：工作流中的子任务\n已完成&总量：转化为进度条，在卡片底部显示\n重要度&紧急度：值越大越重要/紧急；在“统计-4象限节点”中按值展示\n负责人：子任务负责人，暂未开发相关功能\n截止时间：修改后，将同步修改“距结束:x天”",
    en: "Only the title is required; others may be left blank (to clear the field).\nTitle: Subtask in workflow\nDone & Total: Rendered as a progress bar at the bottom of the card\nImportance & Urgency: Higher values mean higher important/urgency; displayed by value in “Stats - 4-quadrant nodes”\nOwner: Person responsible for the subtask; related features not yet implemented\nDue: When modified, “Left:xd” will update accordingly",
  },
  "dialog.editNode.titlePlaceholder": { zh: "节点标题（必填）", en: "Node title (required)" },

  /* ---- 对话框：设置 note 节点（Phase 20 修订：条目表格 + 显示开关） ---- */
  "dialog.nodeNote.title": { zh: "设置 note 节点：{title}", en: "Set note node: {title}" },
  "dialog.nodeNote.desc": {
    zh: "每行展示一条备注\n每条备注有三个状态：纯文字/待办/已办；可在看板上切换待办/已办\n在插件设置中`note卡片显示条数`修改卡片的备注数，默认为3\n可点击行末的`▲`修改备注顺序",
    en: "One note per line.\nEach note has three statuses: plain text / todo / done. You can toggle between to-do and done on the board.\nModify the number of notes shown on cards via `note card items` in plugin settings. Default: 3\nClick `▲` at the end of the row to reorder notes.",
  },
  /** 工具行：药丸开关左边的说明文字（OFF / ON 由 `.wfjson-pill-state` 显示） */
  "dialog.nodeNote.add": { zh: "添加", en: "Add" },
  "dialog.nodeNote.colText": { zh: "Note", en: "Note" },
  "dialog.nodeNote.kindText": { zh: "文字", en: "Text" },
  "dialog.nodeNote.kindTodo": { zh: "待办", en: "Todo" },
  "dialog.nodeNote.kindDone": { zh: "已办", en: "Done" },
  "dialog.nodeNote.colPin": { zh: " ", en: " " },
  "dialog.nodeNote.pin": { zh: "▲", en: "▲" },
  "dialog.nodeNote.empty": {
    zh: "暂无",
    en: "None",
  },
  "dialog.nodeNote.textPlaceholder": {
    zh: "例如：补一份竞品截图清单",
    en: "e.g. add a checklist of competitor screenshots here",
  },

  /* ---- 对话框：修改工作流 ---- */
  "dialog.workflows.title": { zh: "编辑工作流", en: "Edit workflows" },
  "dialog.workflows.desc": {
    zh: "上方下拉选一条工作流，右侧「新增工作流」可以再加一条。\n标题：必填；其他可留空（清空 = 删掉该字段）\n状态：进行中 / 完成 / 取消（主看板默认只显示「进行中」）\n概括 / 原理·启发 / 复盘·下一步 / 标签：这条工作流的复盘说明（存在 workflow.archive，看板暂不展示）",
    en: "Pick a workflow above; use “Add workflow” on the right to create one.\nTitle: required; everything else may be left blank (blank = clear that field).\nStatus: active / done / cancelled (the main board shows active workflows by default).\nSummary / Principle·insight / Retro·next steps / Tags: review notes for this workflow (stored in workflow.archive; not shown on the board yet).",
  },
  "dialog.workflows.pick": { zh: "选择工作流", en: "Pick a workflow" },
  "dialog.workflows.notesHint": {
    zh: "以下四条是这条工作流的复盘说明（存进 workflow.archive，看板暂不展示）。",
    en: "These four notes describe this workflow (stored in workflow.archive; not shown on the board yet).",
  },
  "dialog.workflows.undoRemove": { zh: "取消删除", en: "Undo delete" },
  "dialog.workflows.add": { zh: "新增工作流", en: "Add workflow" },
  "dialog.workflows.newEntry": {
    zh: "新工作流（填完点保存才写盘）",
    en: "New workflow (only written after Save)",
  },
  "dialog.workflows.remove": { zh: "🗑 删除这个工作流…", en: "🗑 Delete this workflow…" },
  "dialog.workflows.confirmDelete": {
    zh: "确定删除「{title}」？它的根节点、全部节点都会一起删掉。",
    en: "Delete “{title}”? Its root node, all of its nodes will be removed as well.",
  },
  "dialog.workflows.confirmDiscard": {
    zh: "确定丢弃这个还没保存的新工作流？",
    en: "Discard this unsaved new workflow?",
  },
  "dialog.workflows.markedRemoved": { zh: "{name}（保存后删除）", en: "{name} (deleted after save)" },
  "dialog.workflows.markedAdded": { zh: "{name}（保存后新增）", en: "{name} (added after save)" },
  "dialog.workflows.stateActive": { zh: "进行中", en: "Active" },
  "dialog.workflows.stateDone": { zh: "完成", en: "Done" },
  "dialog.workflows.stateCancelled": { zh: "取消", en: "Cancelled" },

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
  "nodeinfo.type": { zh: "类型", en: "Type" },
  "nodeinfo.importance": { zh: "重要度", en: "Importance" },
  "nodeinfo.urgency": { zh: "紧急度", en: "Urgency" },
  // Phase 14：标签不再区分「工作流 / 根节点」——表单里只剩一对 progress（根节点的）
  "workflowedit.title": { zh: "标题", en: "Title" },
  /** Phase 14：工作流级 progress 已从表单移除，两个 key 只保留给引擎报错 / 旧调用方 */
  "workflowedit.progress": { zh: "工作流已完成", en: "Workflow progress" },
  "workflowedit.progress_max": { zh: "工作流总量", en: "Workflow total" },
  "workflowedit.rootTitle": { zh: "根节点标题", en: "Root node title" },
  "workflowedit.type": { zh: "类型", en: "Type" },
  "workflowedit.importance": { zh: "重要度", en: "Importance" },
  "workflowedit.urgency": { zh: "紧急度", en: "Urgency" },
  "workflowedit.rootProgress": { zh: "已完成", en: "Done" },
  "workflowedit.rootProgressMax": { zh: "总量", en: "Total" },
  "workflowedit.owner": { zh: "负责人", en: "Owner" },
  "workflowedit.dueAt": { zh: "截止时间", en: "Due" },
  "workflowedit.tags": { zh: "根节点标签", en: "Root node tags" },
  "workflowedit.state": { zh: "状态", en: "State" },

  /* ---- Phase 26：导入 / 导出数据（面板） ---- */
  "view.data.toggle": { zh: "导入/导出数据", en: "Import / export" },
  "view.data.title": { zh: "导入 / 导出数据", en: "Import / export" },
  "view.data.jsonPath": { zh: "JSON 路径*", en: "JSON path*" },
  "view.data.import": { zh: "导入", en: "Import" },
  "view.data.export": { zh: "导出当前看板路径", en: "Export board paths" },
  /* Phase 37 / Phase 38：导入 / 导出两段（导入一个清单 + 两个落点；导出只读清单 + 复制） */
  "view.data.sectionImport": { zh: "导入", en: "Import" },
  "view.data.sectionExport": { zh: "导出", en: "Export" },
  "view.data.placeholder": {
    zh: "每行一个 JSON 路径，例如 …/_workflowwatcher/main~<key>.wf.json",
    en: "One JSON path per line, e.g. …/_workflowwatcher/main~<key>.wf.json",
  },
  "view.data.pathsHint": {
    zh: "导入主看板：继续在主看板延用工作流，编辑或记录新的数据\n导入已归档：可在`统计-已归档`中查看工作流，按工作流拆成多个文件",
    en: "Import into board: Continue using the workflow on the main board to edit or log new data.\nImport as archived: View the workflow under `Stats - Archived`; split into multiple files by workflow.",
  },
  "view.data.exportHint": { zh: "只读：用下面的按钮复制。", en: "Read-only: copy it with the buttons below." },
  "view.data.pick": { zh: "选择…", en: "Choose…" },
  "view.data.pickTitle": { zh: "选择要导入的 JSON", en: "Choose JSON to import" },
  "view.data.pickFailed": { zh: "打开文件对话框失败：{reason}", en: "Could not open the file dialog: {reason}" },
  "view.data.importBoard": { zh: "导入主看板", en: "Import into board" },
  "view.data.importArchive": { zh: "导入已归档", en: "Import as archived" },
  "view.data.copyBoard": { zh: "复制看板路径", en: "Copy board path" },
  "view.data.copyAll": { zh: "复制看板及已归档路径", en: "Copy board + archived paths" },

  /* ---- Phase 28：导入/导出收进小工具 + 开始/完成记录 ---- */
  "view.records.completed": { zh: "完成记录（{count}）", en: "Completed ({count})" },
  "view.records.started": { zh: "开始记录（{count}）", en: "Started ({count})" },
  "view.records.duration": { zh: "耗时 {span}", en: "Took {span}" },
  "view.records.links": { zh: "资料 {count}", en: "Files {count}" },
  "view.records.completedAt": { zh: "完成 {time}", en: "Done {time}" },
  "view.records.startedAt": { zh: "开始 {time}", en: "Started {time}" },

  /* ---- Phase 26：导入弹窗（Phase 27 去掉纪要段 / 链接口径） ---- */
  "dialog.import.title": { zh: "导入数据", en: "Import data" },
  "dialog.import.resultTitle": { zh: "导入结果", en: "Import result" },
  "dialog.import.summary": {
    zh: "工作流 {workflows} · 节点 {nodes}",
    en: "Workflows {workflows} · nodes {nodes}",
  },
  "dialog.import.bodyUntouched": {
    zh: "正文不会被修改：只把新工作流追加到 JSON。",
    en: "The note body is not modified: only new workflows are appended to the JSON.",
  },
  "dialog.import.confirm": { zh: "确认导入", en: "Confirm import" },
  "dialog.import.close": { zh: "关闭", en: "Close" },
  "dialog.import.added": { zh: "已追加 {count} 条工作流。", en: "{count} workflow(s) appended." },
  "dialog.import.skipped": {
    zh: "重复已跳过 {count} 条工作流（不覆盖）。",
    en: "{count} workflow(s) skipped as duplicates (not overwritten).",
  },

  /* ---- Phase 26：导出弹窗 ---- */
  "dialog.export.title": { zh: "导出数据", en: "Export data" },
  "dialog.export.hint": {
    zh: "复制下面的绝对路径即可备份 / 迁移。",
    en: "Copy the absolute paths below to back up or migrate.",
  },
  "dialog.export.relativeHint": {
    zh: "取不到库的绝对路径（移动端），下面显示的是库内相对路径。",
    en: "Vault base path unavailable (mobile); relative paths shown.",
  },
  "dialog.export.json": { zh: "数据（JSON）", en: "Data (JSON)" },
  "dialog.export.backupJson": { zh: "备份副本（JSON）", en: "Backup copy (JSON)" },
  "dialog.export.copy": { zh: "复制", en: "Copy" },
  "dialog.export.copied": { zh: "已复制", en: "Copied" },
  "dialog.export.copyFailed": { zh: "复制失败，请手工选择文本。", en: "Copy failed; select the text manually." },

  /* ---- Phase 26：导入 / 导出的提示 ---- */
  "notice.import.added": { zh: "已导入 {count} 条工作流。", en: "Imported {count} workflow(s)." },
  "notice.import.nothing": {
    zh: "没有可导入的新工作流（全部重复，已跳过）。",
    en: "Nothing to import (all duplicates skipped).",
  },
  "notice.import.invalid": { zh: "导入源不可用，详见报告。", en: "Import source rejected; see the report." },
  "notice.import.readFailed": { zh: "读不到 {path}：{reason}", en: "Cannot read {path}: {reason}" },
  "notice.import.writeFailed": { zh: "导入失败：{reason}", en: "Import failed: {reason}" },
  /* Phase 37：批量导入（多行路径） */
  "notice.import.batchNothing": {
    zh: "没有可导入的新工作流（全部重复或源不可用）。",
    en: "Nothing to import (all duplicates or unusable sources).",
  },
  "notice.import.archiveAdded": { zh: "已生成 {count} 个归档文件。", en: "Created {count} archive file(s)." },
  "notice.import.archiveSkipped": { zh: "{count} 个源没有导入（读不到 / 体检不通过）。", en: "{count} source(s) skipped (unreadable or failed inspection)." },

  /* ---- Phase 37：看板文件目录 / 图表文件根目录 ---- */
  "notice.boardFolderMoved": { zh: "看板文件目录已改名：{from} → {to}", en: "Board folder renamed: {from} → {to}" },
  "notice.boardFolderConflict": {
    zh: "目标目录 {path} 已存在，未改看板文件目录（不合并两个文件夹）。",
    en: "Target folder {path} already exists; board folder not changed (folders are never merged).",
  },
  "notice.boardFolderFailed": { zh: "改看板文件目录失败：{reason}", en: "Failed to change the board folder: {reason}" },

} as const satisfies Record<string, Translation>;

type MessageKey = keyof typeof MESSAGES;

/**
 * 取**指定语言**的一条文案并做 `{name}` 插值（`t()` 只认当前语言）。
 *
 * 用途：跨语言判断同一段文字。典型是 `noteSection.ts` 的「这段正文只是占位符」——
 * 中文环境下插入的模板，之后切到英文也仍然只是个占位符，所以两种写法都得认得。
 * 未登记的 key 原样回显（与 `t()` 同口径）。
 */
export function tIn(lang: Lang, key: MessageKey | (string & {}), params?: Record<string, string | number>): string {
  const table = MESSAGES as Record<string, Translation>;
  const entry: Translation | undefined = table[key];
  if (entry === undefined) return key;
  const template = entry[lang];
  if (params === undefined) return template;
  return template.replace(/\{(\w+)\}/g, (whole: string, name: string) => {
    const value = params[name];
    return value === undefined ? whole : String(value);
  });
}

/**
 * 取一条**当前语言**的文案并做 `{name}` 插值。
 * 未登记的 key 原样回显（`t("foo.bar")` → `"foo.bar"`），便于在界面上直接看出漏配。
 */
export function t(key: MessageKey | (string & {}), params?: Record<string, string | number>): string {
  return tIn(currentLang, key, params);
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
  WFJSON_BLOCK_IGNORED: "This note uses an external JSON file (_workflowwatcher/…), so the inline block is ignored — you can delete it by hand.",
  WFJSON_BLOCK_UNCLOSED: "Add the closing fence (it must be at least as long as the opening one).",
  JSON_BOM: "The BOM was ignored; save the file as UTF-8 without BOM to avoid this.",
  JSON_COMMENT_NOT_ALLOWED: "wfjson must be strict JSON (no comments); field docs live in doc/datacontact/data_ixd_v0.md.",
  JSON_TRAILING_COMMA: "Strict JSON forbids a trailing comma after the last item; remove it.",
  JSON_PARSE_ERROR: "Check quotes / commas / brackets; wfjson must be strict JSON.",
  SCHEMA_VERSION_UNSUPPORTED: "Upgrade the plugin, or set schemaVersion back to a supported version.",
  SCHEMA_UNKNOWN_FIELD: "See doc/datacontact/data_ixd_v09.md for the field list; unknown fields do not block the board — check them under Stats → schema warnings.",
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
  FRONTMATTER_KEY_MISMATCH:
    "wf-key / noteKey is the note identity key (the ~<key> in the sidecar file name); a mismatch usually means the sidecar was copied. Delete wf-key, then edit the note once — the plugin recomputes it from the current path.",
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
  "frontmatterKeyMismatch":
    "wf-key={value} does not match the wfjson noteKey={expected} (the sidecar is looked up by note path; copying someone else's sidecar causes this)",
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



