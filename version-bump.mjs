/**
 * 发版用版本号同步脚本（由 `npm version <x.y.z>` 触发）：
 *  - 把 package.json 的 version 写进 manifest.json；
 *  - 把 { version: minAppVersion } 追加进 versions.json。
 */

import { readFileSync, writeFileSync } from "node:fs";

const targetVersion = process.env.npm_package_version;
if (!targetVersion) {
  console.error("缺少 npm_package_version；请用 `npm.cmd version <x.y.z>` 触发本脚本。");
  process.exit(1);
}

const manifest = JSON.parse(readFileSync("manifest.json", "utf8"));
const minAppVersion = manifest.minAppVersion;
manifest.version = targetVersion;
writeFileSync("manifest.json", `${JSON.stringify(manifest, null, "\t")}\n`);

const versions = JSON.parse(readFileSync("versions.json", "utf8"));
versions[targetVersion] = minAppVersion;
writeFileSync("versions.json", `${JSON.stringify(versions, null, "\t")}\n`);
