/**
 * 测试用的模块解析钩子：把 `import ... from "obsidian"` 指到 `views/obsidianStub.ts`。
 *
 * 为什么不在 `package.json` 里加 `imports` 映射：那只管 `#` 开头的说明符，改不到
 * 裸模块名 `obsidian`；而 `node_modules/obsidian` 是**纯类型包**（`"main": ""`），
 * 纯 Node 加载它会直接报错 —— 于是 `views/wfView.test.ts` 连模块都进不来。
 *
 * 用法（`npm test` 已经带上）：`node --import ./views/obsidianResolve.mjs --test …`
 * 只在测试进程里生效，打包（esbuild 把 `obsidian` 标成 external）完全不受影响。
 */

import { registerHooks } from "node:module";

const STUB_URL = new URL("./obsidianStub.ts", import.meta.url).href;

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === "obsidian") {
      return { url: STUB_URL, shortCircuit: true };
    }
    return nextResolve(specifier, context);
  },
});
