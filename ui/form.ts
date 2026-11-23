/**
 * 弹窗表单控件（Phase C 拆分第 1 步：从 `main.ts` 抽出，纯 DOM、零行为变化）。
 *
 * 皮肤契约见 `capabilities/ui/CONTRACT.md`：本文件只产出 8 个角色类名
 * （`.wfjson-field` / `.wfjson-field-label` / `.wfjson-required` / `.wfjson-date*` / `.wfjson-btn`），
 * 样式全部在 `styles.css` 的 S12；**不要**在这里写内联样式或按主题分支。
 *
 * 约定：
 *  - 按钮一律走 `wfButton()`（普通 / 警告 / 强调三套外观只在这一处决定）；
 *  - `fieldRow(parent, "")` = 只借一行的排布、不生成空标签（链接文档的「地址 + 按钮」行）；
 *  - 日期三段只在 `readDueDate()` 里合成 ISO，非法输入返回中文 `reason`，不抛错。
 */

import { t } from "../src/engine/index.ts";

/** Modal 里的一行「标签 + 控件」（样式在 styles.css：.wfjson-field） */
export function fieldRow(parent: HTMLElement, label: string, required = false): HTMLElement {
  const row = parent.createDiv({ cls: "wfjson-field" });
  // 空标题 = 只借这一行的排布（链接文档的「地址 + 按钮」那一行）→ 不生成空标签
  if (label.length === 0) return row;
  const labelEl = row.createEl("label", { cls: "wfjson-field-label" });
  labelEl.createSpan({ text: label });
  if (required) labelEl.createSpan({ text: " *", cls: "wfjson-required" });
  return row;
}

/** 弹窗按钮的三种角色（样式只在 styles.css 的 S12 写一次：普通 / 警告 / 强调） */
export type WfButtonKind = "normal" | "warning" | "cta";

/**
 * 弹窗里的按钮：所有 tab 的底部按钮 + 行内按钮都从这里出，
 * 保证「普通 / 警告 / 强调」三套外观在 7 个 tab 之间完全一致。
 */
export function wfButton(parent: HTMLElement, label: string, kind: WfButtonKind = "normal"): HTMLButtonElement {
  const button = parent.createEl("button", { cls: "wfjson-btn", text: label, attr: { type: "button" } });
  if (kind === "cta") button.addClass("mod-cta");
  if (kind === "warning") button.addClass("mod-warning");
  return button;
}

/** 三个日期输入框（年 / 月 / 日），保存时合成 `YYYY-MM-DDT00:00:00` */
export interface DueDateInputs {
  year: HTMLInputElement;
  month: HTMLInputElement;
  day: HTMLInputElement;
}

function pad2(value: number): string {
  return `${value}`.padStart(2, "0");
}

/** 「今天 + days 天」的本地日期（`YYYY-MM-DD`；默认截止日 = 一周后） */
export function localDateAfter(days: number): string {
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
export function dueDateField(parent: HTMLElement, label: string, value: string | undefined, fallback?: string): DueDateInputs {
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
export function readDueDate(inputs: DueDateInputs | null, label: string): { value?: string; reason?: string } {
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
