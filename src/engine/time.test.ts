/**
 * time.ts 单测（v0.7 §⑨-5 的 `formatWorkDuration` + Phase 17 的 `wholeDaysFromTo`）。
 *
 * 其余时间工具（ISO 校验 / `hoursBetween` / `formatClock`）由各自的调用方测试间接覆盖，
 * 这里只钉住「节点卡片上那个 XdYh」与「已经过 / 距结束的整天数」的格式口径。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { formatWorkDuration, wholeDaysFromTo } from "./time.ts";

describe("time · formatWorkDuration（XdYh）", () => {
  test("不足 24 小时省略 0d，保留 1 位小数", () => {
    assert.equal(formatWorkDuration(0), "0h");
    assert.equal(formatWorkDuration(5), "5h");
    assert.equal(formatWorkDuration(5.5), "5.5h");
    assert.equal(formatWorkDuration(23.9), "23.9h");
  });

  test("满一天起用 Xd，剩余小时跟在后面；整天不带 0h", () => {
    assert.equal(formatWorkDuration(24), "1d");
    assert.equal(formatWorkDuration(30.5), "1d6.5h");
    assert.equal(formatWorkDuration(48), "2d");
    assert.equal(formatWorkDuration(49.25), "2d1.3h");
  });

  test("负数 / 非有限值返回空串（调用方据此不渲染）", () => {
    assert.equal(formatWorkDuration(-1), "");
    assert.equal(formatWorkDuration(Number.NaN), "");
    assert.equal(formatWorkDuration(Number.POSITIVE_INFINITY), "");
  });
});

describe("time · wholeDaysFromTo（日历日差）", () => {
  test("同一天 = 0；前后各一天 = ±1（含时分秒差异也不影响）", () => {
    assert.equal(wholeDaysFromTo("2026-10-12", "2026-10-12"), 0);
    assert.equal(wholeDaysFromTo("2026-10-12T23:59:59+08:00", "2026-10-12T00:00:00+08:00"), 0);
    assert.equal(wholeDaysFromTo("2026-10-11", "2026-10-12"), 1);
    assert.equal(wholeDaysFromTo("2026-10-12", "2026-10-11"), -1);
  });

  test("跨月 / 跨年 / 跨闰日按真实日历算", () => {
    assert.equal(wholeDaysFromTo("2026-10-31", "2026-11-01"), 1);
    assert.equal(wholeDaysFromTo("2026-12-31", "2027-01-01"), 1);
    assert.equal(wholeDaysFromTo("2028-02-28", "2028-02-29"), 1, "2028 是闰年");
    assert.equal(wholeDaysFromTo("2027-02-28", "2027-03-01"), 1, "2027 不是闰年");
  });

  test("无法识别的日期 / 不存在的日期 → undefined", () => {
    assert.equal(wholeDaysFromTo("2026-10-12", "不是日期"), undefined);
    assert.equal(wholeDaysFromTo("2026-02-30", "2026-03-01"), undefined, "2 月没有 30 日");
    assert.equal(wholeDaysFromTo("", "2026-10-12"), undefined);
  });
});
