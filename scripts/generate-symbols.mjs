#!/usr/bin/env node
/**
 * 生成 `.agent/symbols.json`（机器可读的符号索引）并校验 `.agent/index.json` 的路径表。
 *
 * 为什么需要：
 *   - `doc/impl_index.md` 是人肉维护的索引，行号会漂移；`.agent/symbols.json` 每次由脚本重生，
 *     给「函数 / 类 / 方法在哪个文件第几行」一个**不会过期**的答案，省掉全仓搜索的 token；
 *   - `.agent/index.json` 是能力域路由表，脚本顺手校验它指向的文件都真实存在，
 *     防止文档与代码各说各话（文档先行，但文档不许撒谎）。
 *
 * 用法（Windows + PowerShell）：
 *   npm.cmd run index
 *   等价：node scripts/generate-symbols.mjs
 *
 * 退出码：0 = 生成 + 校验通过；1 = 有死链 / 未归属文件（终端会列出）。
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import ts from "typescript";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = resolve(scriptDir, "..");
const repoRoot = resolve(pluginRoot, "..");
const agentDir = join(repoRoot, ".agent");
const indexPath = join(agentDir, "index.json");
const symbolsPath = join(agentDir, "symbols.json");

/** 基建文件：不归属单一能力域（引擎 barrel + 共享 fixture） */
const COVERAGE_EXEMPT = new Set([
  "workflowwatcher/src/engine/index.ts",
  "workflowwatcher/src/engine/testFixtures.ts",
]);

/** 绝对路径 → 仓库相对路径（正斜杠，便于跨平台与文档互相引用） */
function toRepoPath(absPath) {
  return relative(repoRoot, absPath).split(sep).join("/");
}

/** 递归收集文件 */
function walk(dir, out) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** 参与符号索引的源文件：插件入口 + 拆分出来的层（ui / adapters）+ 引擎 + 视图（排除测试与 DOM 桩） */
function sourceFiles() {
  const splitLayers = ["ui", "adapters"]
    .map((name) => join(pluginRoot, name))
    .filter((dir) => existsSync(dir))
    .flatMap((dir) => walk(dir, []));
  const files = [join(pluginRoot, "main.ts"), ...splitLayers, ...walk(join(pluginRoot, "src/engine"), []), ...walk(join(pluginRoot, "views"), [])];
  return files
    .filter((file) => file.endsWith(".ts"))
    .filter((file) => !file.endsWith(".test.ts"))
    .filter((file) => !/[\\/](testDomStub|obsidianStub)\.ts$/.test(file))
    .sort();
}

function hasExport(node) {
  return (node.modifiers ?? []).some((modifier) => modifier.kind === ts.SyntaxKind.ExportKeyword);
}

/** 抽取一个文件的顶层符号 + 类成员（只做语法层，不做类型检查，快且够用） */
function symbolsOf(file) {
  const text = readFileSync(file, "utf8");
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const symbols = [];
  const lineOf = (node) => source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
  const add = (name, kind, line, exported, owner) => {
    symbols.push({ name, kind, line, exported, owner: owner ?? null });
  };

  for (const statement of source.statements) {
    if (ts.isFunctionDeclaration(statement) && statement.name) {
      add(statement.name.text, "function", lineOf(statement), hasExport(statement));
    } else if (ts.isClassDeclaration(statement) && statement.name) {
      const className = statement.name.text;
      add(className, "class", lineOf(statement), hasExport(statement));
      for (const member of statement.members) {
        if (!member.name || !ts.isIdentifier(member.name)) continue;
        if (ts.isMethodDeclaration(member)) add(member.name.text, "method", lineOf(member), false, className);
        else if (ts.isPropertyDeclaration(member)) add(member.name.text, "property", lineOf(member), false, className);
      }
    } else if (ts.isInterfaceDeclaration(statement)) {
      add(statement.name.text, "interface", lineOf(statement), hasExport(statement));
    } else if (ts.isTypeAliasDeclaration(statement)) {
      add(statement.name.text, "type", lineOf(statement), hasExport(statement));
    } else if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (ts.isIdentifier(declaration.name)) {
          add(declaration.name.text, "const", lineOf(declaration), hasExport(statement));
        }
      }
    }
  }

  return { path: toRepoPath(file), lines: text.split(/\r?\n/).length, symbols };
}

/** 校验 index.json：所有引用的文件都要存在；引擎/视图源文件都要被某个能力域认领 */
function validateIndex(index) {
  const problems = [];
  const must = (pathValue, label) => {
    if (typeof pathValue !== "string" || pathValue.length === 0) {
      problems.push(`${label}: 缺少路径`);
    } else if (!existsSync(join(repoRoot, pathValue))) {
      problems.push(`${label}: 文件不存在 → ${pathValue}`);
    }
  };

  must(index.constitution, "constitution");
  for (const [name, pathValue] of Object.entries(index.docs ?? {})) {
    if (Array.isArray(pathValue)) pathValue.forEach((item, i) => must(item, `docs.${name}[${i}]`));
    else must(pathValue, `docs.${name}`);
  }

  const claimed = new Set();
  for (const [id, capability] of Object.entries(index.capabilities ?? {})) {
    if (id.startsWith("__")) continue;
    must(capability.contract, `capability ${id}.contract`);
    if (capability.entry) must(capability.entry, `capability ${id}.entry`);
    for (const pathValue of capability.paths ?? []) {
      must(pathValue, `capability ${id}.paths`);
      claimed.add(pathValue);
    }
    for (const pathValue of capability.tests ?? []) must(pathValue, `capability ${id}.tests`);
  }

  for (const file of sourceFiles()) {
    const repoPath = toRepoPath(file);
    // 引擎 barrel（公开 API 出口）与共享 fixture 不对应单一能力域，按基建处理
    if (COVERAGE_EXEMPT.has(repoPath)) continue;
    if (!claimed.has(repoPath)) problems.push(`未归属任何能力域 → ${repoPath}`);
  }

  return problems;
}

function main() {
  mkdirSync(agentDir, { recursive: true });

  // 1) 符号索引
  const files = sourceFiles().map(symbolsOf);
  const inverted = {};
  for (const file of files) {
    for (const symbol of file.symbols) {
      const qualified = symbol.owner ? `${symbol.owner}.${symbol.name}` : symbol.name;
      const where = `${file.path}:${symbol.line}`;
      for (const key of new Set([symbol.name, qualified])) {
        (inverted[key] ??= []).push(where);
      }
    }
  }
  const symbols = {
    schema: 1,
    generatedAt: new Date().toISOString(),
    generator: "workflowwatcher/scripts/generate-symbols.mjs",
    files,
    index: Object.fromEntries(Object.entries(inverted).sort(([a], [b]) => a.localeCompare(b))),
  };
  writeFileSync(symbolsPath, `${JSON.stringify(symbols, null, 2)}\n`, "utf8");

  // 2) 索引表校验
  if (!existsSync(indexPath)) {
    console.error(`[index] 缺少 ${toRepoPath(indexPath)}`);
    process.exitCode = 1;
    return;
  }
  const index = JSON.parse(readFileSync(indexPath, "utf8"));
  const problems = validateIndex(index);

  const totalSymbols = files.reduce((sum, file) => sum + file.symbols.length, 0);
  console.log(`[index] symbols: ${files.length} 个文件 / ${totalSymbols} 个符号 → ${toRepoPath(symbolsPath)}`);
  console.log(`[index] capabilities: ${Object.keys(index.capabilities ?? {}).filter((id) => !id.startsWith("__")).length} 个能力域`);

  if (problems.length > 0) {
    console.error(`[index] 校验失败（${problems.length} 处）：`);
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exitCode = 1;
    return;
  }
  console.log("[index] 校验通过：契约 / 入口 / 测试 / 源文件归属全部对得上");
}

main();

