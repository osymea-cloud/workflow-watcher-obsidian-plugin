/**
 * `spiral.ts` 单测（Phase 18 ④-A）：365 天 emo 画布的几何契约。
 *
 * 锚点是契约里那张「文档公式 vs 通用公式」的表（8 条 + 环边界），
 * 再加两条不变量：`i = 1..364` 的坐标两两不同、且恰好等于「20×20 去掉中心 6×6」。
 */

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  EMO_ANGLE_COUNT,
  EMO_COLOR_COUNT,
  EMO_THEMES,
  SPIRAL_CENTER_END,
  SPIRAL_CENTER_START,
  SPIRAL_GRID,
  SPIRAL_RINGS,
  SPIRAL_TOTAL,
  emoAngleIndex,
  emoColorIndex,
  normalizeEmoTheme,
  shiftDate,
  spiralCell,
  spiralCumulative,
  spiralDates,
  spiralRing,
  spiralSlots,
} from "./spiral.ts";

/** `"x,y"` 便于 Set 去重与断言 */
const key = (cell: { x: number; y: number }): string => `${cell.x},${cell.y}`;

describe("spiral · 文档锚点（8 条逐格公式）", () => {
  const anchors: readonly [number, number, number][] = [
    [1, 8, 14],
    [7, 14, 14],
    [8, 14, 13],
    [14, 14, 7],
    [15, 13, 7],
    [21, 7, 7],
    [22, 7, 8],
    [28, 7, 14],
    [29, 7, 15],
    [37, 15, 15],
    [38, 15, 14],
    [46, 15, 6],
    [47, 14, 6],
    [55, 6, 6],
    [56, 6, 7],
    [64, 6, 15],
  ];

  for (const [index, x, y] of anchors) {
    test(`i = ${index} → (${x}, ${y})`, () => {
      assert.deepEqual(spiralCell(index), { x, y });
    });
  }
});

describe("spiral · 环边界与累计", () => {
  test("cum(r) = 4r(r + 6)：28 / 64 / 108 / 160 / 220 / 288 / 364", () => {
    assert.equal(spiralCumulative(0), 0);
    assert.deepEqual(
      [1, 2, 3, 4, 5, 6, 7].map(spiralCumulative),
      [28, 64, 108, 160, 220, 288, 364],
    );
    assert.equal(spiralCumulative(SPIRAL_RINGS), SPIRAL_TOTAL);
  });

  test("spiralRing 分档：1 / 28 → 环 1，29 / 64 → 环 2，65 / 364 → 环 3 / 环 7", () => {
    assert.equal(spiralRing(1), 1);
    assert.equal(spiralRing(28), 1);
    assert.equal(spiralRing(29), 2);
    assert.equal(spiralRing(64), 2);
    assert.equal(spiralRing(65), 3);
    assert.equal(spiralRing(108), 3);
    assert.equal(spiralRing(364), SPIRAL_RINGS);
  });

  test("越界 / 非整数 → undefined（不抛错）", () => {
    for (const bad of [0, -1, 365, 1.5, Number.NaN]) {
      assert.equal(spiralCell(bad), undefined, `spiralCell(${bad})`);
      assert.equal(spiralRing(bad), undefined, `spiralRing(${bad})`);
    }
  });
});

describe("spiral · 不变量（364 格铺满 20×20 − 中心 6×6）", () => {
  test("i = 1..364 两两不同，全部落在 [1,20] × [1,20]", () => {
    const seen = new Set<string>();
    for (let index = 1; index <= SPIRAL_TOTAL; index += 1) {
      const cell = spiralCell(index);
      assert.ok(cell !== undefined, `i = ${index} 应有坐标`);
      assert.ok(cell.x >= 1 && cell.x <= SPIRAL_GRID, `x 越界：i = ${index} → ${cell.x}`);
      assert.ok(cell.y >= 1 && cell.y <= SPIRAL_GRID, `y 越界：i = ${index} → ${cell.y}`);
      const id = key(cell);
      assert.equal(seen.has(id), false, `坐标重复：${id}（i = ${index}）`);
      seen.add(id);
    }
    assert.equal(seen.size, SPIRAL_TOTAL);
  });

  test("集合恰好等于「20×20 去掉中心 6×6」", () => {
    const expected = new Set<string>();
    for (let x = 1; x <= SPIRAL_GRID; x += 1) {
      for (let y = 1; y <= SPIRAL_GRID; y += 1) {
        const inCenter =
          x >= SPIRAL_CENTER_START && x <= SPIRAL_CENTER_END && y >= SPIRAL_CENTER_START && y <= SPIRAL_CENTER_END;
        if (!inCenter) expected.add(`${x},${y}`);
      }
    }
    assert.equal(expected.size, SPIRAL_GRID * SPIRAL_GRID - (SPIRAL_CENTER_END - SPIRAL_CENTER_START + 1) ** 2);

    const actual = new Set(spiralSlots().map(key));
    const missing = [...expected].filter((id) => !actual.has(id));
    const extra = [...actual].filter((id) => !expected.has(id));
    assert.deepEqual(missing, [], "缺格");
    assert.deepEqual(extra, [], "多格");
  });

  test("spiralSlots() 与逐格调用一致（缓存只读）", () => {
    const slots = spiralSlots();
    assert.equal(slots.length, SPIRAL_TOTAL);
    for (const slot of slots) {
      assert.deepEqual({ x: slot.x, y: slot.y }, spiralCell(slot.index));
      assert.equal(slot.ring, spiralRing(slot.index));
    }
  });
});

describe("spiral · 日期落位与配色", () => {
  test("spiralDates：i = 1 是昨天，i = 364 是一年前；日期两两不同", () => {
    const slots = spiralDates("2026-10-29");
    assert.equal(slots.length, SPIRAL_TOTAL);
    assert.equal(slots[0].index, 1);
    assert.equal(slots[0].date, "2026-10-28", "1 号格 = 昨天");
    assert.equal(slots[SPIRAL_TOTAL - 1].date, shiftDate("2026-10-29", -SPIRAL_TOTAL) ?? "", "最后一格 = 倒数第 364 天");
    const dates = new Set(slots.map((slot) => slot.date));
    assert.equal(dates.size, SPIRAL_TOTAL, "365 天里取 364 天，不重不漏");
    assert.equal(dates.has("2026-10-29"), false, "今天不占格（今天是中心块）");
  });

  test("shiftDate：跨月 / 跨年 / 闰日按本地日历算；非法日期 → undefined", () => {
    assert.equal(shiftDate("2026-10-01", -1), "2026-09-30");
    assert.equal(shiftDate("2026-01-01", -1), "2025-12-31");
    assert.equal(shiftDate("2028-03-01", -1), "2028-02-29", "2028 是闰年");
    assert.equal(shiftDate("2027-03-01", -1), "2027-02-28", "2027 不是闰年");
    assert.equal(shiftDate("2026-02-30", 0), undefined, "2 月没有 30 日");
    assert.equal(shiftDate("不是日期", 0), undefined);
    assert.equal(shiftDate("2026-10-29T09:00:00+08:00", 0), undefined, "只认纯日期");
  });

  test("emoColorIndex：同日期稳定、落在 0..5，且 6 个值都出现", () => {
    const date = "2026-10-29";
    assert.equal(emoColorIndex(date), emoColorIndex(date));
    const seen = new Set<number>();
    for (const slot of spiralDates("2026-10-29")) {
      const color = emoColorIndex(slot.date);
      assert.ok(color >= 0 && color < EMO_COLOR_COUNT, `配色越界：${color}`);
      seen.add(color);
    }
    assert.equal(seen.size, EMO_COLOR_COUNT, "364 天里 6 种颜色都会出现");
  });

  test("emoAngleIndex：同日期稳定、落在 0..17，且 18 个角度都会出现", () => {
    const date = "2026-10-29";
    assert.equal(emoAngleIndex(date), emoAngleIndex(date));
    const seen = new Set<number>();
    for (const slot of spiralDates("2026-10-29")) {
      const angle = emoAngleIndex(slot.date);
      assert.ok(angle >= 0 && angle < EMO_ANGLE_COUNT, `角度越界：${angle}`);
      seen.add(angle);
    }
    assert.equal(seen.size, EMO_ANGLE_COUNT, "364 天里 18 个角度都会出现");
  });

  test("emoAngleIndex 与 emoColorIndex 不同源：同色不一定同角度", () => {
    const pairs = new Set(
      spiralDates("2026-10-29").map((slot) => `${emoColorIndex(slot.date)}:${emoAngleIndex(slot.date)}`),
    );
    assert.ok(pairs.size > EMO_COLOR_COUNT, "颜色 + 角度组合远多于 6 种");
  });
});

describe("spiral · emo 独立主题（Phase 19 M1 ①）", () => {
  test("EMO_THEMES：三套主题、顺序固定（灵动岛循环顺序）", () => {
    assert.deepEqual([...EMO_THEMES], ["default", "weave", "candy"]);
  });

  test("normalizeEmoTheme：白名单回落 default", () => {
    for (const key of EMO_THEMES) assert.equal(normalizeEmoTheme(key), key);
    for (const bad of ["", "tech", "DEFAULT", null, undefined, 42]) {
      assert.equal(normalizeEmoTheme(bad), "default", `非法值 ${String(bad)}`);
    }
    // 补充契约⑨：已删除的「彩窗」主题 —— 旧 data.json 里的值直接回落 default（不需要迁移代码）
    assert.equal(normalizeEmoTheme("stainedGlass"), "default", "已删主题回落默认");
  });
});
