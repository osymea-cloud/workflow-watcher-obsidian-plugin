/**
 * 主看板（Phase 25）的文件命名与「多份主看板」判定。
 *
 * 落点是**一对同名同键**的文件，只差扩展名：
 *
 *   `_workflowwatcher/main~3f9a1c2b7d.md`         ← 笔记（Obsidian 里的 md）
 *   `_workflowwatcher/main~3f9a1c2b7d.wf.json`    ← 外置 JSON（数据本体）
 *
 * 为什么 md 文件名也带身份键：
 *  - 与它的侧车**并排放在同一个文件夹里**，名字一模一样 → 用户一眼看出是一对，手删 / 手抄 / 恢复
 *    时不会把两件配错（名字不对就不成对，读盘会退回「md 里没有代码块」的提示而不是读错数据）；
 *  - 与 Phase 25 的备份镜像同一套口径（`backup/main~<key>.md.bak` + `backup/main~<key>.wf.json.bak`）。
 *
 * 键由**基准路径**（不带键的 `_workflowwatcher/main.md`）算出，所以是个常量：
 * 不能拿「带键的文件名」当输入（名字里有键、键又由名字算 → 循环，永远算不出稳定值）。
 *
 * 纯字符串处理，不碰 vault（`node --test` 可直接跑）。
 */

import { noteKeyFor, normalizeVaultPath, SIDECAR_KEY_SEPARATOR, sidecarPathFor } from "./sidecar.ts";
import { boardFolderOf, WFJSON_FOLDER } from "./types.ts";

/** 主看板的名字（不带身份键）：`main` */
export const MAIN_BOARD_STEM = "main";

/*
 * 兼容常量：默认看板目录（`_workflowwatcher`）下的值。
 *
 * 只给「不关心用户改没改目录」的纯函数 / 旧测试用；
 * **业务代码一律用下面的函数**（`mainBoardPath()` 等），否则设置里的目录改了不生效。
 */
export const MAIN_BOARD_BASE_PATH = `${WFJSON_FOLDER}/${MAIN_BOARD_STEM}.md`;
/**
 * 主看板的身份键（10 位十六进制常量）。
 *
 * 同一个键出现在四处：md 文件名、侧车文件名、侧车 JSON 的 `noteKey`、md frontmatter 的 `wf-key`。
 * 前两处由本模块算出，后两处由 `planSidecarPair` / `applySidecarMutation` 用 `noteKeyFor()` 写入 ——
 * 因为 `noteKeyFor()` 对「文件名已带键」的路径返回文件名里那个键（`sidecar.ts` 的幂等规则），
 * 四处必然一致。
 *
 * Phase 37：**键由默认目录的基准路径算出，是个真常量** —— 用户改「看板文件目录」时键不变，
 * 主看板 md / 侧车文件名一个字都不用改（只有所在目录变）。否则改目录等于改 key，四处得同时搬。
 */
export const MAIN_BOARD_KEY = noteKeyFor(MAIN_BOARD_BASE_PATH);
export const MAIN_BOARD_PATH = `${WFJSON_FOLDER}/${MAIN_BOARD_STEM}${SIDECAR_KEY_SEPARATOR}${MAIN_BOARD_KEY}.md`;
export const MAIN_BOARD_SIDECAR_PATH = sidecarPathFor(MAIN_BOARD_PATH);
export const LEGACY_MAIN_BOARD_PATH = MAIN_BOARD_BASE_PATH;

/**
 * 主看板的**基准路径**（**当前**看板目录下、不带身份键）：
 * `<boardFolder>/main.md`。本身不落盘，只用来认「老命名」。
 */
export function mainBoardBasePath(): string {
  return `${boardFolderOf()}/${MAIN_BOARD_STEM}.md`;
}

/** 主看板的身份键（与目录无关的常量，见 `MAIN_BOARD_KEY` 的注释） */
export function mainBoardKey(): string {
  return MAIN_BOARD_KEY;
}

/** 主看板 md 的 vault 相对路径：`<boardFolder>/main~<key>.md`（唯一命令 / ribbon 图标都打开它） */
export function mainBoardPath(): string {
  return `${boardFolderOf()}/${MAIN_BOARD_STEM}${SIDECAR_KEY_SEPARATOR}${MAIN_BOARD_KEY}.md`;
}

/** 主看板侧车的 vault 相对路径：`<boardFolder>/main~<key>.wf.json`（= `sidecarPathFor(mainBoardPath())`） */
export function mainBoardSidecarPath(): string {
  return sidecarPathFor(mainBoardPath());
}

/**
 * 老命名（Phase 25 第一版）：不带键的 `<boardFolder>/main.md`。
 *
 * 只在打开看板时认一次：它的键本来就是 `MAIN_BOARD_KEY`（键由基准路径算出），所以把 md 改名成
 * 带键的那份时**侧车不用动** —— 升级不会丢数据，也不会出现「两份侧车」。
 */
export function legacyMainBoardPath(): string {
  return mainBoardBasePath();
}

/** 是不是主看板的 md（新命名 `main~<key>.md` 与老命名 `main.md` 都算，tab 标题都显示「工作流看板」） */
export function isMainBoardPath(path: string): boolean {
  const normalized = normalizeVaultPath(path);
  return normalized === mainBoardPath() || normalized === legacyMainBoardPath();
}

/**
 * 文件名是不是「主看板」的候选（调用方只管第一层的 `.md`；这里也顺手挡掉非 md）。
 *
 * `main` 之后必须是**结尾或分隔符**：`main.md` / `main~<key>.md`（规范名）/ `main_2.md` /
 * `main-2.md` / `main (2).md`（用户手工复制的副本，Obsidian 的「另存副本」就是 `main 2.md` 这种）。
 * `mainly.md` / `maintenance.md` / `xmain.md` 不算 —— 否则插件会去打开一篇用户自己的笔记。
 */
// `MAIN_BOARD_STEM` 是纯字母，拼进正则安全；分隔符集合取 Obsidian / 系统常见的几种
const MAIN_BOARD_CANDIDATE_RE = new RegExp(`^${MAIN_BOARD_STEM}(?:$|[~_\\-\\s(（+.#])`, "i");

export function isMainBoardCandidate(filePath: string): boolean {
  const normalized = normalizeVaultPath(filePath);
  const name = normalized.slice(normalized.lastIndexOf("/") + 1);
  if (!name.toLowerCase().endsWith(".md")) return false;
  const stem = name.slice(0, name.length - ".md".length);
  return MAIN_BOARD_CANDIDATE_RE.test(stem);
}

/**
 * 从一批路径里筛出主看板候选并**排序**（规范名永远排第一）：
 *  1. `mainBoardPath()`（`main~<key>.md`）—— 插件自己造的那份；
 *  2. `legacyMainBoardPath()`（`main.md`）—— 老命名，随后会被改名成 1；
 *  3. 其余候选按路径字母序 —— 用户手工复制的副本（`main_2.md` …）。
 *
 * 多份时调用方只取第一份并提示一次（`notice.mainBoardDuplicate`）：**不自动删除、不合并** ——
 * 手工复制出来的那几份可能真有用户还没同步过来的内容，删哪份都是猜。
 */
export function rankMainBoardPaths(paths: readonly string[]): string[] {
  const canonical = mainBoardPath();
  const legacy = legacyMainBoardPath();
  const seen = new Set<string>();
  const candidates: string[] = [];
  for (const path of paths) {
    const normalized = normalizeVaultPath(path);
    if (seen.has(normalized) || !isMainBoardCandidate(normalized)) continue;
    seen.add(normalized);
    candidates.push(normalized);
  }
  const rank = (path: string): number => {
    if (path === canonical) return 0;
    if (path === legacy) return 1;
    return 2;
  };
  return candidates.sort((left, right) => rank(left) - rank(right) || left.localeCompare(right));
}
