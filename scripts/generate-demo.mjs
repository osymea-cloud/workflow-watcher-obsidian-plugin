/**
 * 生成演示用静态笔记（可随时重跑刷新时间）：
 *  - `demo.md`（中文）与 `demo_en.md`（英文，Phase 21 §13）—— 两份用同一套 spec，
 *    英文版只是把文案过一遍 `scripts/demo-en.mjs` 的对照表，结构与数据完全一致。
 *
 * 为什么不手写 JSON / frontmatter / 纪要段：
 *  - id、`noteAnchor`、frontmatter 摘要、纪要段、wfjson 代码块全部走引擎
 *    （`factory` + `writeBackDocument`），生成结果天然通过 Schema 与一致性检查；
 *  - 时间锚定「运行当天」，重跑一次就把演示数据刷到最近 21 天
 *    （方块阵 / 甘特图窗口就是近 21 天）。
 *
 * 用法：`node scripts/generate-demo.mjs`（默认写到 `<repo>/vault/demo.md` + `demo_en.md`）
 *       `node scripts/generate-demo.mjs vault testvault`（多个库一起写，规则同 scripts/deploy.mjs）
 *
 * 演示覆盖：6 个进行中 + 3 个已完成（state=archived）+ 3 个已取消（state=cancelled）；
 * 其中「vibe coding 日程APP」是一棵深度 10、同层最多 5 的树；四象限 16 分区铺满。
 */

import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  aggregateStatus,
  analyzeMarkdown,
  applyStatusChange,
  createDocument,
  createNode,
  createWorkflow,
  formatAnalyzeResult,
  formatLocalIso,
  quadrantStats,
  renderNoteSection,
  renderYamlValue,
  setLang,
  toDateOnly,
  walkNodes,
  writeBackDocument,
  FRONTMATTER_FIELDS,
  TEMPLATE_RENDER_BLOCK,
  t,
} from "../src/engine/index.ts";
import { DEMO_EN } from "./demo-en.mjs";

/** 生成基准时间：所有相对时间都以它为锚点 */
const NOW = new Date();

/**
 * 当前输出语言（`zh` / `en`）。
 * 引擎的 `t()` 由 `setLang()` 管；这里再存一份是给 `translate()` 用（spec 文案走对照表）。
 */
let currentLang = "zh";

/** 英文版：spec 里的中文文案过一遍对照表；查不到就回落原文（自检会列出未翻译项） */
function translate(text) {
  if (currentLang !== "en") return text;
  return DEMO_EN[text] ?? text;
}

/** 纪要段正文的兜底文案（spec 没写 `c` 的节点用） */
function defaultSectionText(title) {
  return currentLang === "en" ? `${title}: a progress note.` : `${title}：记一笔进展。`;
}

/** `[daysAgo, hour, minute]` → Date（daysAgo 为负 = 未来） */
function at(daysAgo, hour, minute = 0) {
  const date = new Date(NOW);
  date.setDate(date.getDate() - daysAgo);
  date.setHours(hour, minute, 0, 0);
  return date;
}

const iso = (date) => formatLocalIso(date);
const msAt = (daysAgo, hour, minute) => at(daysAgo, hour, minute).getTime();
const round1 = (value) => Math.round(value * 10) / 10;

/** 一条已结束的计时会话（`hours` 按分钟折算，1 位小数） */
function session(daysAgo, hour, minute, minutes) {
  const start = at(daysAgo, hour, minute);
  const end = new Date(start.getTime() + minutes * 60_000);
  const startAt = iso(start);
  return { startAt, endAt: iso(end), hours: round1(minutes / 60), date: toDateOnly(startAt) };
}

/** 一条进行中的计时会话（省略 `endAt` / `hours`，视图显示正计时） */
function openSession(minutesAgo) {
  const start = new Date(NOW.getTime() - minutesAgo * 60_000);
  const startAt = iso(start);
  return { startAt, date: toDateOnly(startAt) };
}

/* ------------------------------------------------------------------ *
 * 构造文档
 * ------------------------------------------------------------------ */

/** 节点 id → 纪要段正文（正文里每个节点都要有一行可读的纪要） */
const sectionContent = new Map();
let workflowSeq = 0;

/**
 * 由紧凑的 spec 递归建树：
 *  - `id` 按 DFS 先序编号（`nd-demo-<wf>-<seq>`），可读且稳定；
 *  - `status` 一律先建成 `todo` 再 `applyStatusChange`，保证 statusHistory 与 completedAt 由引擎生成；
 *  - `startAt / updatedAt / completedAt` 统一按 spec 的日期偏移覆盖，满足「结束不早于开始」。
 */
function buildWorkflow(spec, options = {}) {
  workflowSeq += 1;
  const wfNo = String(workflowSeq).padStart(2, "0");
  let seq = 0;

  const make = (item) => {
    seq += 1;
    const id = `nd-demo-${wfNo}-${String(seq).padStart(2, "0")}`;
    const startMs = msAt(...(item.start ?? [30, 9, 0]));

    const node = createNode({
      id,
      title: translate(item.title),
      summary: item.summary === undefined ? undefined : translate(item.summary),
      progress: item.p ?? 0,
      progress_max: item.pm ?? 1,
      importance: item.imp,
      urgency: item.urg,
      dueAt: item.due ? iso(at(...item.due)) : undefined,
      startAt: iso(new Date(startMs)),
      children: (item.children ?? []).map(make),
    }, NOW);

    // Phase 20：note 卡片（factory 不处理这两个字段，建完再挂）
    if (Array.isArray(item.note)) {
      const noteItems = item.note
        .map((entry) => (typeof entry === "string" ? { text: entry } : { ...entry }))
        .map((entry) => ({ ...entry, text: translate(entry.text) }))
        .filter((entry) => entry.text.trim().length > 0);
      if (noteItems.length > 0) node.note = noteItems;
    }
    if (item.visible === true) node.noteVisible = true;

    const status = item.status ?? "todo";
    const fallbackUpdated = status === "todo" ? startMs : Math.min(msAt(0, 9, 0), NOW.getTime());
    let updatedMs = item.updated
      ? msAt(...item.updated)
      : status === "done" && item.done
        ? msAt(...item.done)
        : fallbackUpdated;

    let doneMs;
    if (status === "done") {
      doneMs = Math.max(msAt(...(item.done ?? [1, 18, 0])), startMs);
      updatedMs = Math.max(updatedMs, doneMs);
    }
    updatedMs = Math.max(updatedMs, startMs);

    if (status !== "todo") applyStatusChange(node, status, { at: iso(new Date(updatedMs)) });
    node.startAt = iso(new Date(startMs));
    node.updatedAt = iso(new Date(updatedMs));
    if (status === "done") node.completedAt = iso(new Date(doneMs));
    else delete node.completedAt;

    const entries = (item.sessions ?? []).map((entry) => session(...entry));
    if (typeof item.open === "number") entries.push(openSession(item.open));
    if (entries.length > 0) node.timeEntries = entries;

    sectionContent.set(id, item.c === undefined ? defaultSectionText(translate(item.title)) : translate(item.c));
    return node;
  };

  const root = make(spec);
  return createWorkflow({
    id: `wf-demo-${wfNo}`,
    title: translate(spec.title),
    root,
    state: options.state,
    progress: spec.wp ?? 0,
    progress_max: spec.wpm ?? 1,
  }, NOW);
}

/* ------------------------------------------------------------------ *
 * 演示数据：6 个进行中 + 3 个已完成（archived）+ 3 个已取消（cancelled）
 *
 * 包在函数里而不是顶层数组：`demo.md` / `demo_en.md` 各要跑一遍（语言不同 → 文案不同），
 * 每次都重新建节点（id 按 DFS 先序编号，两遍结果一致）。函数体是同一份数据，缩进保持原样。
 * ------------------------------------------------------------------ */

function buildAll() {
  return [
  // ── 1. 进行中：主力树（深度 10、同层最多 5） ──────────────────────────
  buildWorkflow({
    title: "vibe coding 日程APP",
    status: "doing",
    p: 5, pm: 12, wp: 5, wpm: 12, imp: 4, urg: 4,
    start: [42, 9, 0],
    c: "从 0 开始做一个自己的日程 App，主线是先把「记录—回顾」闭环跑通。",
    sessions: [[6, 10, 0, 90], [3, 20, 0, 60]],
    note: [
      { text: "先做单机版，云同步放第二期" },
      { text: "每天至少投 1 小时", done: true },
      { text: "周五给同事演示一次", done: false },
    ],
    visible: true,
    children: [
      {
        title: "需求层", status: "done", p: 3, pm: 3, imp: 4, urg: 3,
        start: [40, 9, 0], done: [16, 18, 0],
        sessions: [[19, 9, 30, 120], [18, 14, 0, 90]],
        c: "把「为什么要做」和「做到什么程度」先写死，避免后面反复改。",
        children: [
          {
            title: "为什么现有日程 App 的打卡留存卡在 30%？", status: "done", p: 1, pm: 1, imp: 3, urg: 2,
            start: [39, 10, 0], done: [20, 12, 0],
            summary: "访谈 5 个朋友后，结论是「记录太麻烦」而不是「提醒不够」",
            c: "5 个访谈对象里有 4 个说放弃原因是记录步骤太多。",
          },
          {
            title: "核心功能清单定到 12 项", status: "done", p: 12, pm: 12, imp: 2, urg: 3,
            start: [38, 9, 0], done: [17, 18, 0],
            c: "12 项功能里砍掉 3 个社交类，只留单人闭环。",
          },
          {
            title: "竞品对比表：3 款 App 的 8 个维度", status: "done", p: 8, pm: 8, imp: 2, urg: 1,
            start: [36, 14, 0], done: [15, 20, 0], sessions: [[19, 13, 0, 270]],
            c: "对比表放在本地表格里，暂不进仓库。",
          },
        ],
      },
      {
        title: "数据层", status: "doing", p: 4, pm: 9, imp: 4, urg: 2,
        start: [34, 9, 0], sessions: [[12, 9, 0, 120], [5, 14, 30, 150]],
        c: "数据模型是这次的重点，重复日程最容易返工。",
        children: [
          {
            title: "日程表与任务表怎么拆？", status: "done", p: 1, pm: 1, imp: 4, urg: 3,
            start: [33, 9, 0], done: [13, 18, 0], sessions: [[13, 10, 0, 90]],
            c: "最后按「日程是容器、任务是条目」拆成两张表。",
          },
          {
            title: "重复日程结构", status: "doing", p: 2, pm: 5, imp: 3, urg: 3,
            start: [30, 9, 0], sessions: [[11, 10, 0, 60]],
            c: "规则 + 例外日 + 实例三层，目前卡在例外日的写回。",
            children: [
              {
                title: "按天 / 按周 / 按月的规则怎么存？", status: "done", p: 1, pm: 1, imp: 3, urg: 2,
                start: [29, 9, 0], done: [12, 19, 0],
                c: "用 RRULE 的简化子集，只支持这三种。",
                children: [
                  {
                    title: "例外日怎么记？", status: "done", p: 1, pm: 1, imp: 3, urg: 2,
                    start: [27, 9, 0], done: [11, 18, 0],
                    c: "例外日存成「日期 + 动作」的数组。",
                    children: [
                      {
                        title: "删掉一条实例后规则怎么更新？", status: "doing", p: 1, pm: 3, imp: 3, urg: 3,
                        start: [20, 9, 0],
                        c: "目前只做「跳过这一次」，不反向改规则。",
                        children: [
                          {
                            title: "补实例功能", status: "doing", p: 1, pm: 3, imp: 2, urg: 2,
                            start: [14, 9, 0],
                            c: "补出来的实例要能单独改时间。",
                            children: [
                              {
                                title: "补实例弹窗默认值", status: "todo", p: 0, pm: 3, imp: 2, urg: 2,
                                start: [10, 9, 0], due: [-3, 18, 0],
                                c: "默认带入原实例的时间与标题。",
                                children: [
                                  {
                                    title: "默认时间被用户改了怎么办？", status: "todo", p: 0, pm: 2, imp: 2, urg: 3,
                                    start: [8, 9, 0], due: [-2, 18, 0],
                                    c: "改了就按用户值存，不回头改规则。",
                                    children: [
                                      {
                                        title: "改动后提示「仅此一次 / 全部」怎么措辞？", status: "todo", p: 0, pm: 1, imp: 1, urg: 3,
                                        start: [6, 9, 0], due: [-1, 18, 0],
                                        c: "措辞先按「仅此一次」占位，二期再补「全部」。",
                                      },
                                    ],
                                  },
                                ],
                              },
                            ],
                          },
                        ],
                      },
                    ],
                  },
                ],
              },
            ],
          },
          {
            title: "提醒表怎么设计？", status: "todo", p: 0, pm: 4, imp: 3, urg: 2,
            start: [26, 9, 0], due: [-5, 12, 0],
            c: "提醒先只做本地通知，不接推送。",
          },
          {
            title: "本地存储用 SQLite 还是 JSON？", status: "done", p: 1, pm: 1, imp: 4, urg: 2,
            start: [32, 14, 0], done: [10, 20, 0], sessions: [[10, 11, 0, 60]],
            c: "单机版先用 JSON 文件，量大了再迁 SQLite。",
          },
        ],
      },
      {
        title: "界面层", status: "doing", p: 2, pm: 6, imp: 3, urg: 1,
        start: [28, 9, 0], sessions: [[7, 15, 0, 60]],
        c: "界面先保证「一屏能看到今天要做什么」。",
        children: [
          {
            title: "首页放哪几个卡片？", status: "done", p: 1, pm: 1, imp: 2, urg: 2,
            start: [26, 9, 0], done: [9, 19, 0],
            c: "今天 / 四象限 / 本周进度三块。",
          },
          {
            title: "任务卡片进度条要不要显示数字？", status: "doing", p: 1, pm: 2, imp: 2, urg: 2,
            start: [12, 9, 0],
            c: "先显示「3/5」，看截图里是否太挤。",
          },
          {
            title: "四象限视图放在哪一级入口？", status: "todo", p: 0, pm: 1, imp: 2, urg: 1,
            start: [8, 9, 0],
            c: "暂定首页卡片，不做独立 tab。",
          },
        ],
      },
      {
        title: "开发与联调", status: "todo", p: 5, pm: 12, imp: 4, urg: 1,
        start: [24, 9, 0],
        c: "按页面拆，先登录后列表。",
        children: [
          {
            title: "登录页第 1 版", status: "done", p: 1, pm: 1, imp: 3, urg: 2,
            start: [22, 9, 0], done: [14, 18, 0], sessions: [[14, 9, 30, 150]],
            c: "第 1 版只是能登录，样式后面重做。",
          },
          {
            title: "登录页第 2 版", status: "done", p: 1, pm: 1, imp: 3, urg: 3,
            start: [16, 9, 0], done: [9, 18, 0], sessions: [[9, 14, 0, 120]],
            c: "加了错误提示与加载态。",
          },
          {
            title: "登录页第 3 版", status: "doing", p: 1, pm: 3, imp: 3, urg: 4,
            start: [4, 9, 0], open: 45,
            c: "这一版改版式与动效，正在做。",
          },
          {
            title: "日程列表页", status: "todo", p: 0, pm: 4, imp: 2, urg: 3,
            start: [3, 9, 0], due: [-4, 18, 0],
            c: "列表页等登录页定稿再动。",
          },
          {
            title: "设置页", status: "todo", p: 0, pm: 2, imp: 1, urg: 3,
            start: [3, 9, 0],
            c: "设置页最后做。",
          },
        ],
      },
      {
        title: "测试与发布", status: "todo", p: 0, pm: 3, imp: 1, urg: 1,
        start: [2, 9, 0],
        c: "先内测再谈发布。",
        children: [
          {
            title: "内测包发 10 个人", status: "todo", p: 0, pm: 1, imp: 1, urg: 4,
            start: [2, 9, 0], due: [-7, 12, 0],
            c: "找 10 个愿意每周反馈的人。",
          },
          {
            title: "崩溃率压到 0.5% 以下", status: "todo", p: 0, pm: 1, imp: 2, urg: 4,
            start: [2, 9, 0], sessions: [[4, 21, 0, 45]],
            c: "先接崩溃上报，再谈指标。",
          },
        ],
      },
    ],
  }),

  // ── 2. 进行中：健身 ──────────────────────────────────────────────────
  buildWorkflow({
    title: "健身",
    status: "doing", p: 3, pm: 8, wp: 3, wpm: 8, imp: 4, urg: 3,
    start: [30, 7, 0],
    c: "每周三次力量 + 有氧，先把频率稳住再谈强度。",
    children: [
      {
        title: "每周三次力量训练", status: "doing", p: 2, pm: 3, imp: 4, urg: 3,
        start: [30, 7, 30], sessions: [[6, 7, 30, 60], [2, 7, 30, 60]],
        c: "周一推、周三拉、周五腿。",
        children: [
          {
            title: "周一推（胸肩）", status: "done", p: 1, pm: 1, imp: 3, urg: 2,
            start: [13, 7, 30], done: [6, 8, 30],
            c: "卧推 3 组、肩推 3 组。",
          },
          {
            title: "周三拉（背）", status: "doing", p: 1, pm: 2, imp: 3, urg: 3,
            start: [8, 7, 30],
            c: "引体还差 2 个。",
          },
          {
            title: "周五腿", status: "todo", p: 0, pm: 1, imp: 3, urg: 2,
            start: [6, 7, 30], due: [-2, 7, 30],
            c: "深蹲注意护膝。",
          },
        ],
      },
      {
        title: "体脂降到 18%", status: "doing", p: 1, pm: 4, imp: 4, urg: 3,
        start: [28, 8, 0],
        c: "每月测一次，别天天称。",
        children: [
          {
            title: "每周称重记录", status: "done", p: 4, pm: 4, imp: 2, urg: 2,
            start: [27, 8, 0], done: [5, 8, 0],
            c: "4 周记录都在，趋势向下。",
          },
          {
            title: "饮食记录 30 天", status: "doing", p: 11, pm: 30, imp: 3, urg: 2,
            start: [20, 20, 0],
            c: "目前记了 11 天，晚饭最容易漏。",
          },
        ],
      },
      {
        title: "跑步 5 公里进 30 分钟", status: "todo", p: 0, pm: 1, imp: 1, urg: 2,
        start: [18, 19, 0],
        c: "等力量训练稳定后再加。",
      },
    ],
  }),

  // ── 3. 进行中：整理相册（含 blocked 节点） ───────────────────────────
  buildWorkflow({
    title: "整理手机相册并备份",
    status: "doing", p: 2, pm: 5, wp: 2, wpm: 5, imp: 3, urg: 2,
    start: [25, 21, 0],
    c: "照片太多，先按年份归档，再整体备份一次。",
    children: [
      {
        title: "按年份归档", status: "doing", p: 1, pm: 3, imp: 3, urg: 2,
        start: [25, 21, 0],
        c: "一年一个文件夹，命名统一。",
        children: [
          {
            title: "2024 年照片", status: "done", p: 1, pm: 1, imp: 2, urg: 1,
            start: [24, 21, 0], done: [15, 22, 0],
            c: "2024 已归档 1.2 万张。",
          },
          {
            title: "2025 年照片", status: "doing", p: 1, pm: 2, imp: 3, urg: 2,
            start: [10, 22, 0], sessions: [[5, 22, 0, 60]],
            c: "2025 还剩 8000 张没动。",
          },
          {
            title: "2026 年照片", status: "todo", p: 0, pm: 1, imp: 2, urg: 1,
            start: [4, 22, 0],
            c: "2026 年的先不动，等年底一起。",
          },
        ],
      },
      {
        title: "截图单独归类", status: "todo", p: 0, pm: 1, imp: 2, urg: 1,
        start: [20, 22, 0],
        c: "截图单独放一个文件夹，方便清理。",
      },
      {
        title: "备份到移动硬盘", status: "blocked", p: 0, pm: 1, imp: 3, urg: 3,
        start: [12, 22, 0],
        c: "等移动硬盘到货，预计本周。",
        note: [
          { text: "硬盘型号：2TB 移动固态" },
          { text: "到货后先校验一遍", done: false },
        ],
        visible: true,
      },
      {
        title: "清理重复照片", status: "todo", p: 0, pm: 1, imp: 1, urg: 1,
        start: [8, 22, 0],
        c: "重复照片用工具先筛一遍再删。",
      },
    ],
  }),

  // ── 4. 进行中：周末短途游 ────────────────────────────────────────────
  buildWorkflow({
    title: "规划周末家庭短途游",
    status: "doing", p: 2, pm: 4, wp: 2, wpm: 4, imp: 4, urg: 4,
    start: [12, 20, 0],
    c: "两天一夜，带 5 岁孩子，总预算 1500。",
    children: [
      {
        title: "选目的地", status: "doing", p: 1, pm: 2, imp: 4, urg: 4,
        start: [12, 20, 0], sessions: [[3, 21, 30, 45]],
        c: "候选：郊区温泉 / 湖边民宿 / 农场。",
        children: [
          {
            title: "两天一夜适合带 5 岁孩子的地方有哪些？", status: "done", p: 1, pm: 1, imp: 3, urg: 3,
            start: [11, 20, 0], done: [6, 21, 0],
            c: "列了 6 个，筛到 2 个。",
          },
          {
            title: "下雨天的备选方案是什么？", status: "todo", p: 0, pm: 1, imp: 2, urg: 3,
            start: [5, 20, 0], due: [-3, 20, 0],
            c: "室内乐园作为雨天备选。",
          },
        ],
      },
      {
        title: "订住宿", status: "todo", p: 0, pm: 1, imp: 3, urg: 4,
        start: [9, 20, 0], due: [-3, 12, 0],
        c: "民宿要带厨房，方便孩子吃饭。",
      },
      {
        title: "排行程", status: "doing", p: 1, pm: 3, imp: 3, urg: 3,
        start: [8, 20, 0],
        c: "第一天下午到，第二天上午回。",
      },
      {
        title: "预算 1500 以内", status: "doing", p: 2, pm: 4, imp: 2, urg: 2,
        start: [7, 20, 0],
        c: "住宿 700、餐饮 400、油费 200。",
      },
    ],
  }),

  // ── 5. 进行中：绘画 ──────────────────────────────────────────────────
  buildWorkflow({
    title: "绘画",
    status: "doing", p: 2, pm: 4, wp: 2, wpm: 4, imp: 3, urg: 1,
    start: [35, 20, 0],
    c: "先补基础，再画完整作品。",
    children: [
      {
        title: "透视练习", status: "doing", p: 1, pm: 3, imp: 3, urg: 1,
        start: [35, 20, 0], sessions: [[1, 20, 0, 90]],
        c: "一轮 10 张，画完再评。",
        children: [
          {
            title: "一点透视 10 张", status: "done", p: 1, pm: 1, imp: 2, urg: 1,
            start: [34, 20, 0], done: [12, 21, 0],
            c: "10 张完成，线条还行。",
          },
          {
            title: "两点透视 10 张", status: "doing", p: 4, pm: 10, imp: 3, urg: 1,
            start: [11, 20, 0],
            c: "目前 4 张，透视线还是歪。",
          },
          {
            title: "三点透视 5 张", status: "todo", p: 0, pm: 1, imp: 2, urg: 1,
            start: [6, 20, 0],
            c: "三点透视先放一放。",
          },
        ],
      },
      {
        title: "色彩练习", status: "todo", p: 0, pm: 1, imp: 2, urg: 1,
        start: [20, 20, 0],
        c: "色彩课还没看完。",
      },
      {
        title: "完成一幅完整的场景插画", status: "todo", p: 0, pm: 1, imp: 3, urg: 1,
        start: [18, 20, 0],
        c: "目标年底前完成一幅。",
      },
    ],
  }),

  // ── 6. 进行中：看完 CSAPP 视频 ───────────────────────────────────────
  buildWorkflow({
    title: "看完 CSAPP 视频",
    status: "doing", p: 2, pm: 4, wp: 2, wpm: 4, imp: 3, urg: 1,
    start: [40, 22, 0],
    c: "每周两章，边看边做题。",
    children: [
      {
        title: "第 1 章 计算机系统漫游", status: "done", p: 1, pm: 1, imp: 2, urg: 1,
        start: [40, 22, 0], done: [21, 23, 0],
        c: "第 1 章看完了，纯概念。",
      },
      {
        title: "第 2 章 信息的表示和处理", status: "doing", p: 1, pm: 3, imp: 3, urg: 1,
        start: [20, 22, 0], sessions: [[2, 22, 30, 60]],
        c: "整数表示看完，浮点数还在看。",
        children: [
          {
            title: "整数表示", status: "done", p: 1, pm: 1, imp: 2, urg: 1,
            start: [19, 22, 0], done: [8, 23, 0],
            c: "补码部分看得很慢。",
          },
          {
            title: "浮点数", status: "doing", p: 1, pm: 2, imp: 3, urg: 1,
            start: [7, 22, 0],
            c: "IEEE 754 还在消化。",
          },
          {
            title: "练习题 2.1-2.30", status: "todo", p: 0, pm: 1, imp: 2, urg: 2,
            start: [5, 22, 0],
            c: "题留到周末集中做。",
          },
        ],
      },
      {
        title: "第 3 章 程序的机器级表示", status: "todo", p: 0, pm: 1, imp: 3, urg: 1,
        start: [4, 22, 0],
        c: "第 3 章最厚，慢慢来。",
      },
      {
        title: "做笔记并整理成卡片", status: "todo", p: 0, pm: 1, imp: 2, urg: 1,
        start: [4, 22, 0],
        c: "每章整理 10 张卡片。",
      },
    ],
  }),

  // ── 7. 已完成：学习数据结构（archived，全 done） ─────────────────────
  buildWorkflow({
    title: "学习数据结构",
    status: "done", p: 6, pm: 6, wp: 6, wpm: 6,
    start: [55, 19, 0], done: [18, 22, 0],
    c: "系统过一遍常用数据结构，配合手写实现。",
    children: [
      {
        title: "数组与链表", status: "done", p: 2, pm: 2,
        start: [50, 19, 0], done: [30, 22, 0],
        c: "数组和链表各手写一遍。",
        children: [
          {
            title: "实现动态数组", status: "done", p: 1, pm: 1,
            start: [49, 19, 0], done: [35, 22, 0],
            c: "动态扩容写完了。",
          },
          {
            title: "实现双向链表", status: "done", p: 1, pm: 1,
            start: [45, 19, 0], done: [32, 21, 0],
            c: "双向链表加了哨兵节点。",
          },
        ],
      },
      {
        title: "栈与队列", status: "done", p: 2, pm: 2,
        start: [30, 19, 0], done: [24, 22, 0],
        c: "栈和队列都用链表实现了一遍。",
        children: [
          {
            title: "用栈做括号匹配", status: "done", p: 1, pm: 1,
            start: [28, 19, 0], done: [26, 21, 0],
            c: "括号匹配一次通过。",
          },
          {
            title: "用队列做任务调度", status: "done", p: 1, pm: 1,
            start: [26, 19, 0], done: [24, 21, 0],
            c: "队列版调度很简单。",
          },
        ],
      },
      {
        title: "二叉树", status: "done", p: 2, pm: 2,
        start: [24, 19, 0], done: [18, 22, 0], sessions: [[18, 19, 0, 120]],
        c: "二叉树的遍历全部手写一遍。",
        children: [
          {
            title: "实现前中后序遍历", status: "done", p: 1, pm: 1,
            start: [23, 19, 0], done: [20, 21, 0],
            c: "递归版写完。",
          },
          {
            title: "实现层序遍历", status: "done", p: 1, pm: 1,
            start: [20, 19, 0], done: [18, 21, 0],
            c: "层序遍历用了队列。",
          },
        ],
      },
    ],
  }, { state: "archived" }),

  // ── 8. 已完成：调研新零售产业（archived，调查式提问） ────────────────
  buildWorkflow({
    title: "调研新零售产业",
    status: "done", p: 4, pm: 4, wp: 4, wpm: 4,
    start: [50, 14, 0], done: [16, 18, 0],
    c: "为一次内部汇报做的行业调研。",
    children: [
      {
        title: "新零售的核心成本结构是什么？", status: "done", p: 1, pm: 1,
        start: [48, 14, 0], done: [30, 18, 0],
        c: "租金 + 人力 + 履约，履约占比最高。",
      },
      {
        title: "线上线下融合的三种模式各适合什么品类？", status: "done", p: 1, pm: 1,
        start: [40, 14, 0], done: [26, 18, 0],
        c: "三种模式分别适配生鲜、标品、体验型。",
      },
      {
        title: "为什么很多新零售门店开不到两年就关了？", status: "done", p: 1, pm: 1,
        start: [30, 14, 0], done: [20, 18, 0],
        c: "多数死在履约成本与复购率。",
      },
      {
        title: "输出一份 3000 字调研报告", status: "done", p: 1, pm: 1,
        start: [20, 14, 0], done: [16, 18, 0], sessions: [[16, 14, 0, 180]],
        c: "报告已交给团队，结论三条。",
      },
    ],
  }, { state: "archived" }),

  // ── 9. 已完成：换季衣物整理与捐赠（archived） ───────────────────────
  buildWorkflow({
    title: "换季衣物整理与捐赠",
    status: "done", p: 5, pm: 5, wp: 5, wpm: 5,
    start: [30, 10, 0], done: [15, 18, 0],
    c: "换季一次搞定，顺手清掉闲置。",
    children: [
      {
        title: "夏装收纳", status: "done", p: 2, pm: 2,
        start: [29, 10, 0], done: [20, 18, 0],
        c: "夏装清洗后装箱。",
        children: [
          {
            title: "清洗并装箱", status: "done", p: 1, pm: 1,
            start: [28, 10, 0], done: [22, 18, 0],
            c: "洗了两桶，装了两个箱子。",
          },
          {
            title: "贴标签", status: "done", p: 1, pm: 1,
            start: [22, 10, 0], done: [20, 18, 0],
            c: "标签写清季节与件数。",
          },
        ],
      },
      {
        title: "冬装取出", status: "done", p: 1, pm: 1,
        start: [20, 10, 0], done: [19, 18, 0],
        c: "冬装挂起来，先晒一遍。",
      },
      {
        title: "闲置衣物 20 件捐出", status: "done", p: 2, pm: 2,
        start: [19, 10, 0], done: [15, 18, 0], sessions: [[15, 10, 0, 90]],
        c: "凑了 20 件，送到社区捐赠点。",
        children: [
          {
            title: "联系捐赠点", status: "done", p: 1, pm: 1,
            start: [18, 10, 0], done: [17, 18, 0],
            c: "社区捐赠点周末开门。",
          },
          {
            title: "打包送走", status: "done", p: 1, pm: 1,
            start: [16, 10, 0], done: [15, 18, 0],
            c: "两大包，一次送完。",
          },
        ],
      },
    ],
  }, { state: "archived" }),

  // ── 10. 已取消：看skill ─────────────────────────────────────────────
  buildWorkflow({
    title: "看skill",
    status: "cancelled", p: 1, pm: 3, wp: 1, wpm: 3,
    start: [22, 21, 0], updated: [18, 21, 0],
    c: "想系统看一遍技能文档，后来优先级降下来就停了。",
    children: [
      {
        title: "收集 skill 清单", status: "cancelled", p: 1, pm: 1,
        start: [21, 21, 0], updated: [18, 21, 0],
        c: "列了 12 个，没继续。",
      },
      {
        title: "逐个试用", status: "cancelled", p: 0, pm: 1,
        start: [19, 21, 0], updated: [18, 21, 0],
        c: "试用阶段直接放弃。",
      },
    ],
  }, { state: "cancelled" }),

  // ── 11. 已取消：试做一周早起打卡 ────────────────────────────────────
  buildWorkflow({
    title: "试做一周早起打卡",
    status: "cancelled", p: 1, pm: 2, wp: 1, wpm: 2,
    start: [14, 6, 30], updated: [8, 6, 30],
    c: "试了三天，作息顶不住，先取消。",
    children: [
      {
        title: "连续 7 天 6:30 起床", status: "cancelled", p: 1, pm: 1,
        start: [13, 6, 30], updated: [8, 6, 30], sessions: [[8, 6, 30, 30]],
        c: "只坚持了 3 天。",
      },
      {
        title: "记录起床时间", status: "cancelled", p: 0, pm: 1,
        start: [13, 6, 30], updated: [8, 6, 30],
        c: "记录表没用上。",
      },
    ],
  }, { state: "cancelled" }),

  // ── 12. 已取消：报名周末陶艺体验课 ──────────────────────────────────
  buildWorkflow({
    title: "报名周末陶艺体验课",
    status: "cancelled", p: 0, pm: 2, wp: 0, wpm: 2,
    start: [10, 12, 0], updated: [7, 12, 0],
    c: "时间和家庭安排冲突，先取消。",
    children: [
      {
        title: "查课程时间", status: "cancelled", p: 0, pm: 1,
        start: [9, 12, 0], updated: [7, 12, 0],
        c: "查了两家，时间都不合适。",
      },
      {
        title: "报名缴费", status: "cancelled", p: 0, pm: 1,
        start: [8, 12, 0], updated: [7, 12, 0],
        c: "没走到缴费这一步。",
      },
    ],
  }, { state: "cancelled" }),
  ];
}

/* ------------------------------------------------------------------ *
 * 组装 markdown：frontmatter → dataviewjs → ## 纪要 → 纪要段 → wfjson
 *
 * `lang` 同时决定两件事：引擎自己的文案（`setLang` → 「## 纪要 / ## Notes」）与
 * spec 文案（`translate` → 对照表）。所以中英两份必须各跑一遍完整流水线。
 * ------------------------------------------------------------------ */

function buildMarkdown(lang) {
  currentLang = lang;
  setLang(lang);
  // 每遍从零开始：id 编号、纪要正文都按 DFS 顺序重建（两遍产出的 id 完全一致）
  sectionContent.clear();
  workflowSeq = 0;

  const document = createDocument({ id: "file-demo-01", workflows: buildAll() }, NOW);

  const frontmatter = [
    "---",
    `${FRONTMATTER_FIELDS.tags}: ${renderYamlValue([])}`,
    `${FRONTMATTER_FIELDS.status}: ${renderYamlValue(aggregateStatus(document))}`,
    `${FRONTMATTER_FIELDS.titles}: ${renderYamlValue(document.workflows.map((workflow) => workflow.title))}`,
    `${FRONTMATTER_FIELDS.updated}: ${toDateOnly(formatLocalIso(NOW))}`,
    `${FRONTMATTER_FIELDS.theme}: ${renderYamlValue("default")}`,
    "---",
  ].join("\n");

  const sections = [];
  for (const { node } of walkNodes(document)) {
    const content = sectionContent.get(node.id) ?? defaultSectionText(node.title);
    sections.push(renderNoteSection(node, { content }));
  }

  const base = [
    frontmatter,
    TEMPLATE_RENDER_BLOCK,
    `## ${t("template.heading")}`,
    sections.join("\n\n"),
  ].join("\n\n");

  // 写回一律走引擎：补摘要字段 → 补齐缺失纪要段 → 追加 wfjson 代码块（幂等）
  return writeBackDocument(base, document, { now: NOW }).markdown;
}

/* ------------------------------------------------------------------ *
 * 自检：Schema + 一致性必须 0 error，并打印覆盖情况
 * ------------------------------------------------------------------ */

/** 英文版里漏翻的中文（对照表命中即翻译；没命中的会原样留下，这里揪出来） */
function leftoverCjk(markdown) {
  const hits = new Set();
  for (const match of markdown.matchAll(/[\u4e00-\u9fff][\u4e00-\u9fff\s，。、：？！「」（）]*/g)) {
    hits.add(match[0].trim());
  }
  return [...hits];
}

/** 解析 + 校验；有 error 直接退出（不写半成品） */
function inspect(markdown, fileName) {
  const analysis = analyzeMarkdown(markdown, { file: fileName });
  console.log(formatAnalyzeResult(analysis, { headline: `${fileName} 自检` }));
  if (analysis.hasError || analysis.document === undefined) {
    console.error(`自检失败：${fileName} 存在 error 级问题，未写盘。`);
    process.exit(1);
  }
  return analysis.document;
}

/** 覆盖率报告（两份 demo 数据相同，只有文案不同，所以两遍都会打印一次） */
function report(doc) {
  const quadrant = quadrantStats(doc, NOW);
  const filledPartitions = quadrant.partitions.filter((partition) => partition.nodes.length > 0);

  let maxDepth = 0;
  let maxWidth = 0;
  const walk = (node, depth) => {
    maxDepth = Math.max(maxDepth, depth);
    maxWidth = Math.max(maxWidth, node.children.length);
    for (const child of node.children) walk(child, depth + 1);
  };
  walk(doc.workflows[0].root, 1);

  const active = doc.workflows.filter((workflow) => workflow.state === undefined);
  const archived = doc.workflows.filter((workflow) => workflow.state === "archived");
  const cancelled = doc.workflows.filter((workflow) => workflow.state === "cancelled");

  let totalNodes = 0;
  let noteNodes = 0;
  let timeNodes = 0;
  let openSessions = 0;
  const recordDays = new Set();
  for (const { node } of walkNodes(doc)) {
    totalNodes += 1;
    if (Array.isArray(node.note) && node.note.length > 0) noteNodes += 1;
    if (Array.isArray(node.timeEntries) && node.timeEntries.length > 0) {
      timeNodes += 1;
      for (const entry of node.timeEntries) {
        recordDays.add(entry.date);
        if (entry.endAt === undefined) openSessions += 1;
      }
    }
  }

  console.log("");
  console.log(`工作流：${doc.workflows.length}（进行中 ${active.length} / 已完成 ${archived.length} / 已取消 ${cancelled.length}）`);
  console.log(`节点：${totalNodes}；主力树深度 ${maxDepth}、同层最宽 ${maxWidth}`);
  console.log(`四象限：${quadrant.totalNodes} 个待办/进行中节点，铺满 ${filledPartitions.length}/16 个分区`);
  console.log(`附注：${noteNodes} 个节点带 note 卡片；计时：${timeNodes} 个节点 / ${recordDays.size} 个日期（进行中 ${openSessions} 条）`);
  if (filledPartitions.length < 16) {
    const empty = quadrant.partitions
      .filter((partition) => partition.nodes.length === 0)
      .map((partition) => `urg=${partition.urgency},imp=${partition.importance}`);
    console.log(`未铺满的分区：${empty.join(" / ")}`);
  }
}

/* ------------------------------------------------------------------ *
 * 落盘（库目录解析与 scripts/deploy.mjs 保持一致：仓库根 → 仓库上一级）
 *
 * 两个文件同一套数据：`demo.md`（中文）/ `demo_en.md`（英文，Phase 21 §13）。
 * ------------------------------------------------------------------ */

const SCRIPT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO_ROOT = resolve(SCRIPT_ROOT, "..");

function resolveVaultDir(vault) {
  const direct = resolve(REPO_ROOT, vault);
  if (existsSync(direct)) return direct;
  const sibling = resolve(REPO_ROOT, "..", vault);
  return existsSync(sibling) ? sibling : direct;
}

/** 一份 demo：`demo.md` 走中文，`demo_en.md` 走英文（对照表 + `setLang("en")`） */
const OUTPUTS = [
  { lang: "zh", file: "demo.md" },
  { lang: "en", file: "demo_en.md" },
];

const vaultArgs = process.argv.slice(2);
const vaults = vaultArgs.length > 0 ? vaultArgs : ["vault"];

for (const output of OUTPUTS) {
  const markdown = buildMarkdown(output.lang);
  const doc = inspect(markdown, output.file);
  report(doc);

  if (output.lang === "en") {
    const missing = leftoverCjk(markdown);
    if (missing.length > 0) {
      console.error(`\n英文版还有 ${missing.length} 处没翻译（补进 scripts/demo-en.mjs 再跑）：`);
      for (const text of missing.slice(0, 20)) console.error(`  - ${text}`);
      process.exit(1);
    }
  }

  for (const vault of vaults) {
    const target = join(resolveVaultDir(vault), output.file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, markdown, "utf8");
    console.log(`已写出：${target}`);
  }
}
