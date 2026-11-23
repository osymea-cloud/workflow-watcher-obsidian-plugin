/**
 * 把构建产物部署到 vault（默认 testvault + vault）。
 *
 *   node scripts/deploy.mjs                       → 部署到 testvault 与 vault
 *   node scripts/deploy.mjs testvault             → 只部署到指定库（相对仓库根）
 *   node scripts/deploy.mjs "D:\notes\我的库"      → 部署到仓库外的库（绝对路径也可）
 *   node scripts/deploy.mjs --enable testvault    → 顺便在 community-plugins.json 里启用插件
 *
 * 复制内容：main.js / manifest.json（存在 styles.css 时一并复制）
 * 目标目录：<vault>/.obsidian/plugins/<manifest.id>/
 *
 * 只复制文件**不会**让插件生效：Obsidian 的「已启用社区插件」清单是
 * `<vault>/.obsidian/community-plugins.json`（数组，元素是 manifest id）。
 * 侧边栏图标 / 命令都挂在 `onload()` 上，所以没启用就看不到「打开工作流看板」。
 * 新库要么在 设置 → 第三方插件 里手动开启一次，要么加 `--enable` 让脚本写清单。
 */

import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));

const DEFAULT_VAULTS = ["testvault", "vault"];
const KNOWN_FLAGS = new Set(["--enable"]);

const argv = process.argv.slice(2);
const unknownFlags = argv.filter((arg) => arg.startsWith("--") && !KNOWN_FLAGS.has(arg));
if (unknownFlags.length > 0) {
  console.error(`未知参数：${unknownFlags.join(" ")}（可用：--enable）`);
  process.exit(1);
}
/** `--enable`：部署后把插件 id 写进 <vault>/.obsidian/community-plugins.json */
const enable = argv.includes("--enable");
const vaults = argv.filter((arg) => !arg.startsWith("--"));
const targets = vaults.length > 0 ? vaults : DEFAULT_VAULTS;

/** manifest.json 必带；main.js 由 npm run build 生成；styles.css 可选 */
const FILES = ["main.js", "manifest.json", "styles.css"];

/**
 * 解析库目录：先在仓库根下找（`testvault` → `<repo>/testvault`），找不到再在**仓库的上一级**找
 * （本仓库的库就放在 `../testvault`）—— 否则 `npm run deploy` 的默认值永远「找不到目录」，
 * 测试库会一直跑旧产物（id / 代码都对不上）。
 * 传绝对路径时 `resolve` 原样返回，行为不变。
 */
function resolveVaultDir(vault) {
  const direct = resolve(root, vault);
  if (existsSync(direct)) return direct;
  const sibling = resolve(root, "..", vault);
  return existsSync(sibling) ? sibling : direct;
}

/**
 * 把插件 id 写进 `<vault>/.obsidian/community-plugins.json`（Obsidian 的「已启用社区插件」清单）。
 *
 * 保留清单里已有的条目与顺序，只追加缺的那一个（重复执行是空操作）；
 * 文件不存在就建一个；文件坏掉时**不动它**（让用户在 Obsidian 设置里手动开，别把别人的插件清单写废）。
 *
 * @returns {boolean} 是否已处于「清单里有这个 id」的状态
 */
function enablePlugin(vault, vaultDir) {
  const communityFile = join(vaultDir, ".obsidian", "community-plugins.json");
  let list = [];
  if (existsSync(communityFile)) {
    try {
      const parsed = JSON.parse(readFileSync(communityFile, "utf8"));
      if (!Array.isArray(parsed)) throw new Error("not an array");
      list = parsed.filter((item) => typeof item === "string");
    } catch {
      console.error(
        `${vault}: community-plugins.json 不是字符串数组，未改动（请在 Obsidian 设置 → 第三方插件 里手动启用 ${manifest.id}）`,
      );
      return false;
    }
  }
  if (list.includes(manifest.id)) {
    console.log(`${vault}: ${manifest.id} 已在 community-plugins.json 里（已是启用状态）`);
    return true;
  }
  mkdirSync(dirname(communityFile), { recursive: true });
  list.push(manifest.id);
  writeFileSync(communityFile, `${JSON.stringify(list, null, 2)}\n`, "utf8");
  console.log(
    `${vault}: 已在 community-plugins.json 中启用 ${manifest.id}（若 Obsidian 已打开：设置里关掉再打开该插件，或重启应用）`,
  );
  return true;
}

let failed = false;

for (const vault of targets) {
  const vaultDir = resolveVaultDir(vault);
  if (!existsSync(vaultDir)) {
    console.error(`跳过 ${vault}：找不到目录 ${vaultDir}（也试过 ${resolve(root, "..", vault)}）`);
    failed = true;
    continue;
  }

  const pluginDir = join(vaultDir, ".obsidian", "plugins", manifest.id);
  mkdirSync(pluginDir, { recursive: true });

  for (const file of FILES) {
    const from = join(root, file);
    if (!existsSync(from)) {
      if (file === "styles.css") {
        console.log(`${vault}: 跳过 styles.css（可选，未提供）`);
        continue;
      }
      console.error(`${vault}: 缺少 ${file}，请先运行 npm.cmd run build`);
      failed = true;
      continue;
    }
    cpSync(from, join(pluginDir, file));
    console.log(`${vault}: ${file} → ${pluginDir}`);
  }

  if (enable && !enablePlugin(vault, vaultDir)) failed = true;
}

process.exit(failed ? 1 : 0);
