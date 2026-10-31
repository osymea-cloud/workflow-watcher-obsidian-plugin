/**
 * `obsidian` 模块的测试桩（**只在 `node --test` 里生效**，见 `views/obsidianResolve.mjs`）。
 *
 * 为什么需要它：`views/wfView.ts` 从 `obsidian` 里取了两个**运行时**值
 * （`setIcon` / `MenuItem` 之类），而 `node_modules/obsidian` 是纯类型包
 * （`"main": ""`，没有可加载的 JS），纯 Node 直接 `import` 会解析失败 ——
 * 整个 `views/wfView.test.ts` 连加载都做不到。
 *
 * 桩的口径：
 *  - 只实现视图真正调用到的那几个函数，且**不改变语义**（`setIcon` 往元素里塞图标文字，
 *    与真实环境的「塞 SVG」在单测里等价：断言只关心元素有没有被标记成图标位）；
 *  - 其它导出（`Modal` / `Setting` / `Plugin` …）只被 `main.ts` 用，单测不加载它们，
 *    这里给一个「被调用就抛错」的替身，避免哪天不小心在视图里用上却静默通过。
 */

/** 图标名 → 单测里可见的占位文字（真实环境是内联 SVG） */
const ICON_GLYPH: Record<string, string> = {
  smile: "🙂",
  "bar-chart-2": "📊",
  target: "🎯",
  package: "📦",
  "line-chart": "📈",
  settings: "⚙️",
};

/** Obsidian 的 `setIcon(element, iconId)`：把图标画进元素里 */
export function setIcon(element: HTMLElement, iconId: string): void {
  const glyph = ICON_GLYPH[iconId] ?? "";
  if (typeof (element as unknown as { setText?: (value: string) => void }).setText === "function") {
    (element as unknown as { setText: (value: string) => void }).setText(glyph);
    return;
  }
  element.textContent = glyph;
}

/** `main.ts` 才用到的类：视图里一旦用到就等于「单测环境不支持的 API」，直接报错更安全 */
function unsupported(name: string): never {
  throw new Error(`obsidian.${name} 在 node --test 的桩里没有实现（视图不应该用到它）`);
}

export class Modal {
  constructor() {
    unsupported("Modal");
  }
}

export class Notice {
  constructor() {
    unsupported("Notice");
  }
}

export class Plugin {
  constructor() {
    unsupported("Plugin");
  }
}

export class PluginSettingTab {
  constructor() {
    unsupported("PluginSettingTab");
  }
}

export class Setting {
  constructor() {
    unsupported("Setting");
  }
}

export class FileSystemAdapter {
  constructor() {
    unsupported("FileSystemAdapter");
  }
}

export class MarkdownView {
  constructor() {
    unsupported("MarkdownView");
  }
}
