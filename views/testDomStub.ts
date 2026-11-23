/**
 * 视图单测用的最小 DOM 桩。
 *
 * 为什么需要它：`views/wfView.ts` 只用 Obsidian 给 `HTMLElement` / `Document` 打的那几个扩展
 * （`createEl` / `createDiv` / `empty` / `setText` / `addClass` / `classList`），
 * 桩出这几样就能在纯 Node 里跑视图（`node --test`，与引擎单测同一套工具链）。
 *
 * 本文件只被 `views/wfView.test.ts` 引用；打包入口是 main.ts，不会进 main.js。
 *
 * 忠实度要求：Obsidian 的 `createEl` / `createDiv` 是「创建 + append 到接收者」，
 * 所以 `document.createDiv()` 会往 document 根节点 append 并抛
 * `HierarchyRequestError: Only one element on document allowed`。
 * 桩必须同样抛错 —— 否则「把 document 当容器」这类 bug 在单测里会静默通过（真实 vault 里必崩）。
 * 需要游离元素时用 `document.createElement(...)`（视图里封装成 `detachedDiv()`）。
 */

export interface StubElementOptions {
  cls?: string;
  text?: string;
}

/**
 * 桩里的 `style`：普通对象（视图写 `style.left = "…"`）+ 真实 DOM 的三个方法（不枚举）。
 * `Object.keys(style)` 因此仍只列出「真的写过的样式」，与真实 DOM 的断言口径一致。
 */
function createStubStyle(): Record<string, string> {
  const style: Record<string, string> = {};
  const define = (name: string, value: unknown): void => {
    Object.defineProperty(style, name, { value, enumerable: false, configurable: true, writable: true });
  };
  define("setProperty", (name: string, value: string): void => {
    style[name] = value;
  });
  define("removeProperty", (name: string): void => {
    delete style[name];
  });
  define("getPropertyValue", (name: string): string => style[name] ?? "");
  return style;
}

/** 桩用的鼠标事件（视图只用得到这四个） */
export interface StubMouseEvent {
  preventDefault: () => void;
  stopPropagation: () => void;
  clientX: number;
  clientY: number;
}

export type StubHandler = (event: StubMouseEvent) => void;
/**
 * 单测专用：给**新造**的、带某个 class 的元素预设 `scrollHeight`。
 *
 * 真实浏览器里 `scrollHeight` 由内容高度算出来，桩里没有布局、恒为 0 ——
 * 「泳道正文滚到底（`scrollTop = scrollHeight`）」这类断言会退化成 0 = 0，
 * 于是 `.wf-lane-body` 的滚动位置测不出东西。注册过的 class 才生效，
 * 没注册的一律还是 0（与加这个开关之前一字不差），用例收尾记得 `clearScrollHeightPresets()`。
 */
const scrollHeightPresets = new Map<string, number>();

/** 见 `scrollHeightPresets`（Phase 22：泳道滚动位置的回归用例要用） */
export function presetScrollHeight(cls: string, height: number): void {
  scrollHeightPresets.set(cls, height);
}

/** 清掉 `presetScrollHeight()` 注册的预设（用例收尾调用，别影响后面的用例） */
export function clearScrollHeightPresets(): void {
  scrollHeightPresets.clear();
}

/**
 * 建一个**游离**桩元素（不 append）。
 *
 * 两处共用：`StubElement.createEl/createDiv/createSpan`（建完再 append 到接收者）与
 * 全局 `createDiv()`（Obsidian DOM 增强层的同名全局函数，返回游离元素）。
 */
function createStubElement(tagName: string, options: StubElementOptions = {}): StubElement {
  const el = new StubElement(tagName);
  if (options.cls !== undefined) el.addClass(...options.cls.split(/\s+/));
  if (options.text !== undefined) el.setText(options.text);
  for (const [cls, height] of scrollHeightPresets) {
    if (el.hasClass(cls)) el.scrollHeight = height;
  }
  return el;
}



export class StubElement {
  readonly tagName: string;
  children: StubElement[] = [];
  parent: StubElement | null = null;
  text = "";
  title = "";
  onclick: StubHandler | null = null;
  oncontextmenu: StubHandler | null = null;
  /** 方块阵悬浮详情（Phase 3）用这两只手柄；真实 DOM 上就是 onmouseenter / onmouseleave */
  onmouseenter: StubHandler | null = null;
  onmouseleave: StubHandler | null = null;
  /** `<details>`（Phase 11：甘特图折叠）—— 真实 DOM 的 HTMLDetailsElement.open 默认 false */
  open = false;
  /** 按钮的禁用态（Phase 19 M3：没选中 plot 时工具条按钮禁用）；真实 DOM 默认 false */
  disabled = false;
  /** 只读态（Phase 38：导出清单能选中 / 能复制、不能改）；真实 DOM 默认 false */
  readOnly = false;
  /** 文本类控件的当前值（Phase 26：导入 / 导出面板的路径输入框）；真实 DOM 默认空串 */
  value = "";
  /** 输入框占位符（Phase 26）；真实 DOM 默认空串 */
  placeholder = "";
  /** `input` 事件手柄（Phase 26：桩里由测试赋值 + 手动调用，模拟用户在框里打字） */
  oninput: (() => void) | null = null;
  /** `<input type="date">` 选完日期（Phase 28：甘特 / 方块阵的窗口结束日） */
  onchange: (() => void) | null = null;
  /** `<details>` 的 toggle 手柄：真实 DOM 程序化改 open 会派发事件，桩里由测试手动触发 */
  ontoggle: (() => void) | null = null;
  /** 原生拖拽（Phase 15）：`draggable` 属性 + 五个 `drag*` 手柄（桩里由测试手动触发） */
  draggable = false;
  ondragstart: StubHandler | null = null;
  ondragover: StubHandler | null = null;
  ondragleave: StubHandler | null = null;
  ondrop: StubHandler | null = null;
  ondragend: StubHandler | null = null;
  /** 屏幕矩形（Phase 15：`resolveDrop` 读 top / height；测试里按需设置 top / height） */
  readonly rect = { left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0 };
  /**
   * 内联样式：既是 `Record<string, string>`（视图写 `style.left = "…"`），
   * 也带真实 DOM 的 `setProperty` / `removeProperty` / `getPropertyValue`
   * （不可枚举，`Object.keys` 断言口径与真实 DOM 一致）。
   */
  readonly style: Record<string, string> = createStubStyle();
  /** 元素属性（Phase 9：视图容器挂 data-wf-theme） */
  readonly attributes: Record<string, string> = {};
  /** 滚动相关（Phase 9：滚动恢复在桩里也应是 number，避免 captureScroll 回落异常） */
  scrollTop = 0;
  scrollHeight = 0;
  clientHeight = 0;
  /** Phase 18：横向滚动（间隙滚轮横滚的单测要读 / 写它们） */
  scrollLeft = 0;
  scrollWidth = 0;
  clientWidth = 0;
  /** Phase 25：导航条跳转 / 高亮要用 `offsetLeft` / `offsetWidth`（桩里没有布局，由测试按需赋值） */
  offsetLeft = 0;
  offsetWidth = 0;
  /** 单测专用：记录 `scrollTo()` 的调用参数（真实 DOM 的平滑滚动在桩里不实现动画） */
  readonly scrollCalls: { left?: number; top?: number; behavior?: string }[] = [];

  private readonly classNames = new Set<string>();

  /** 单测专用：事件监听表（`dispatch()` 派发时按顺序调用） */
  private readonly listeners = new Map<string, { handler: (event: unknown) => void; options?: unknown }[]>();

  constructor(tagName: string) {
    this.tagName = tagName;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
    // 与真实 DOM 对齐：写 `class` 属性等价于整体替换 classList（SVG 元素只能用这条路挂类）
    if (name === "class") {
      for (const cls of [...this.classNames]) this.classNames.delete(cls);
      for (const cls of value.split(/\s+/)) {
        if (cls.length > 0) this.classNames.add(cls);
      }
    }
  }

  getAttribute(name: string): string | null {
    return this.attributes[name] ?? null;
  }

  /** 与真实 DOM 对齐：删属性（Phase 21：开关原位切「关」时摘掉 `data-node-id`） */
  removeAttribute(name: string): void {
    delete this.attributes[name];
    if (name === "class") this.classNames.clear();
  }

  /**
   * 与真实 DOM 对齐：`element.dataset` 是映射到 `data-*` 属性的活视图
   * （`el.dataset.context = "active"` 等价于 `el.setAttribute("data-context", "active")`，
   *  `getAttribute("data-context")` 能读回同一个值）。camelCase 键 ↔ kebab-case 属性名。
   * 只实现 get / set / has / delete 四条最常用的 trap（桩用不到枚举 `Object.keys(dataset)`）。
   */
  get dataset(): Record<string, string> {
    const attributes = this.attributes;
    const toAttr = (key: string): string => "data-" + key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`);
    const store: Record<string, string> = {};
    return new Proxy(store, {
      get: (_target, key: string | symbol): string | undefined => attributes[toAttr(String(key))],
      set: (_target, key: string | symbol, value: string): boolean => {
        attributes[toAttr(String(key))] = String(value);
        return true;
      },
      has: (_target, key: string | symbol): boolean => toAttr(String(key)) in attributes,
      deleteProperty: (_target, key: string | symbol): boolean => {
        delete attributes[toAttr(String(key))];
        return true;
      },
    });
  }

  getBoundingClientRect(): { left: number; top: number; right: number; bottom: number; width: number; height: number } {
    return this.rect;
  }

  get classList(): {
    add: (...names: string[]) => void;
    contains: (name: string) => boolean;
    toggle: (name: string, force?: boolean) => boolean;
  } {
    return {
      add: (...names: string[]): void => {
        names.forEach((name) => this.classNames.add(name));
      },
      contains: (name: string): boolean => this.classNames.has(name),
      toggle: (name: string, force?: boolean): boolean => {
        // 与真实 DOM 对齐：第二个参数存在时按它来（`toggle(cls, false)` = 强制移除）
        const next = force ?? !this.classNames.has(name);
        if (next) this.classNames.add(name);
        else this.classNames.delete(name);
        return next;
      },
    };
  }

  addClass(...names: string[]): this {
    names.forEach((name) => this.classNames.add(name));
    return this;
  }

  /** 与真实 DOM 对齐：移除类名（不存在时什么都不做） */
  removeClass(...names: string[]): this {
    names.forEach((name) => this.classNames.delete(name));
    return this;
  }

  /** Obsidian 的 `hasClass`（桩里等价于 `classList.contains`） */
  hasClass(name: string): boolean {
    return this.classNames.has(name);
  }

  /**
   * 事件监听（Phase 18）：`wfView` 的间隙滚轮 / 拖拽都要挂监听。
   * 真实 DOM 的第三个参数（`{ passive: false }`）桩里只记录、不解释；
   * 派发由测试调 `dispatch()`（真实 DOM 没有这个方法，专供单测）。
   */
  addEventListener(name: string, handler: (event: unknown) => void, options?: unknown): void {
    const list = this.listeners.get(name) ?? [];
    list.push({ handler, options });
    this.listeners.set(name, list);
  }

  removeEventListener(name: string, handler: (event: unknown) => void): void {
    const list = this.listeners.get(name);
    if (list === undefined) return;
    this.listeners.set(
      name,
      list.filter((item) => item.handler !== handler),
    );
  }

  /** 单测专用：按名字派发事件给所有监听者（返回是否有监听者被调用） */
  dispatch(name: string, event: unknown): boolean {
    const list = this.listeners.get(name) ?? [];
    for (const item of list) item.handler(event);
    return list.length > 0;
  }

  /**
   * 真实 DOM 的同名方法（Phase 25：导航条跳转用 `scrollTo({ left, behavior })`）。
   * 桩里不做平滑动画 —— 直接把 `left` / `top` 落到 `scrollLeft` / `scrollTop`，
   * 同时把参数记进 `scrollCalls`，用例可以断言「滚到哪」而不依赖动画时序。
   */
  scrollTo(options: { left?: number; top?: number; behavior?: string }): void {
    this.scrollCalls.push({ ...options });
    if (options.left !== undefined) this.scrollLeft = options.left;
    if (options.top !== undefined) this.scrollTop = options.top;
  }

  /** 单测专用：某类事件的监听数量 / 是否用了 `{ passive: false }` */
  listenerCount(name: string): number {
    return this.listeners.get(name)?.length ?? 0;
  }

  listenerOptions(name: string): unknown[] {
    return (this.listeners.get(name) ?? []).map((item) => item.options);
  }

  setText(value: string): void {
    this.text = value;
  }

  /** 与真实 DOM 对齐：读 = 整棵子树的文本；写 = 先清空子元素再放这段文字 */
  get textContent(): string {
    return this.allText;
  }

  set textContent(value: string) {
    this.empty();
    this.text = value;
  }

  empty(): void {
    // 与真实 DOM 对齐：被清掉的子元素不再有父级（视图靠 parentElement 判断句柄是否作废）
    for (const child of this.children) child.parent = null;
    this.children = [];
  }

  appendChild(child: StubElement): StubElement {
    child.parent = this;
    this.children.push(child);
    return child;
  }

  /** 与真实 DOM 对齐：父元素（游离 / 已 remove 的元素为 null，视图用它判断句柄是否作废） */
  get parentElement(): StubElement | null {
    return this.parent;
  }

  remove(): void {
    if (this.parent) this.parent.children = this.parent.children.filter((item) => item !== this);
    this.parent = null;
  }

  /** 与真实 DOM 对齐：用新元素在父级里原地替换自己（没有父级时什么都不做） */
  replaceWith(next: StubElement): void {
    const parent = this.parent;
    if (parent === null) return;
    const index = parent.children.indexOf(this);
    if (index < 0) return;
    next.parent = parent;
    parent.children[index] = next;
    this.parent = null;
  }

  createEl(tagName: string, options: StubElementOptions = {}): StubElement {
    return this.make(tagName, options);
  }

  createDiv(options: StubElementOptions = {}): StubElement {
    return this.make("div", options);
  }

  /** Obsidian 的 `createSpan`（sidebar 的图标位、点表的 x / y 都用它） */
  createSpan(options: StubElementOptions = {}): StubElement {
    return this.make("span", options);
  }

  /**
   * `createEl` / `createDiv` / `createSpan` 的共同实现：建元素 + append 到自身。
   *
   * 三个公开方法只负责「决定 tagName」，**不要**写成互相调用 —— `createDiv(){ return this.createEl("div") }`
   * 这种形状会被 `obsidianmd/prefer-create-el` 反向建议成 `this.createDiv(...)`，照改就是无限递归。
   */
  private make(tagName: string, options: StubElementOptions): StubElement {
    const el = createStubElement(tagName, options);
    this.appendChild(el);
    return el;
  }

  /** 只支持 `.class` 选择器（视图与测试都够用） */
  closest(selector: string): StubElement | null {
    const matches = (el: StubElement): boolean => selector.startsWith(".") && el.classNames.has(selector.slice(1));
    if (matches(this)) return this;
    for (let cursor = this.parent; cursor !== null; cursor = cursor.parent) {
      if (matches(cursor)) return cursor;
    }
    return null;
  }

  /** 后代（含自身）中匹配 `.class` 的元素 */
  query(selector: string): StubElement[] {
    const found: StubElement[] = [];
    const walk = (el: StubElement): void => {
      if (selector.startsWith(".") && el.classNames.has(selector.slice(1))) found.push(el);
      el.children.forEach(walk);
    };
    walk(this);
    return found;
  }

  /**
   * 真实 DOM 的同名方法（Phase 22：整块重渲染前按类名抄泳道正文的滚动位置）。
   * 与 `query` 同一套实现，只是签名跟真实 DOM 对齐 —— 视图里写的是标准 `querySelectorAll`。
   */
  querySelectorAll(selector: string): StubElement[] {
    return this.query(selector);
  }

  /**
   * 真实 DOM 的同名方法（单数）：第一个**后代**匹配，没有就 `null`。
   *
   * Phase 33：导航栏搬进「进行中」块后，首次渲染就会走到 `columnsOf()` 之后的
   * `element.querySelector(".wf-active-scroll")`（原来那时块还没造出来，走不到这里）。
   * 桩缺这个方法时视图会抛 `… .querySelector is not a function`（`lint.md` §7.1 第 1 类红灯）。
   * 与真实 DOM 对齐的细节：**不含自身**（`query` 含），同 `closest` 之外的标准语义。
   */
  querySelector(selector: string): StubElement | null {
    return this.query(selector).find((el) => el !== this) ?? null;
  }

  /** 整棵子树的文本（便于 `assert.match`） */
  get allText(): string {
    let text = this.text;
    for (const child of this.children) text += child.allText;
    return text;
  }
}

/** 安装 globalThis 上的 DOM 桩（document / window / HTMLElement），返回 body */
export function installDomStub(): StubElement {
  const body = new StubElement("body");
  // 模仿 Obsidian 的 enhance.js：在 document 上 createEl/createDiv = 往 document 根节点 append
  // → 真实环境必然抛 HierarchyRequestError（document 已经有 <html> 这个根元素了）
  const notAContainer = (): never => {
    throw new Error("Only one element on document allowed.");
  };
  const documentStub = {
    body,
    createEl: notAContainer,
    createDiv: notAContainer,
    /** 标准 DOM 工厂（桩内部建游离元素、测试直接造元素都用它；视图的 `detachedDiv()` 走全局 `createDiv()`） */
    createElement: (tagName: string): StubElement => new StubElement(tagName),
    /** SVG 元素工厂（Phase 19 M3：折线 / 圆点 / 刻度都在 SVG 命名空间里建） */
    createElementNS: (_namespace: string, tagName: string): StubElement => new StubElement(tagName),
    addEventListener: (): void => undefined,
  };
  // 这一句**只能**用 `globalThis`：桩要做的事就是往全局装 `document` / `window` / 定时器 / 全局 `createDiv`，
  // 而 `window` 正是它的产物（此刻还不存在）。`obsidianmd/no-global-this` 的 `--fix`（换成 `window`）会把桩打断，
  // 所以这是 `doc/ai_rules/lint.md` §6 基线里唯一被保留的那条 warning。
  const globals = globalThis as {
    document?: unknown;
    window?: unknown;
    HTMLElement?: unknown;
    createDiv?: unknown;
    setTimeout?: (handler: () => void, timeout?: number) => unknown;
    clearTimeout?: (handle: unknown) => void;
    setInterval?: (handler: () => void, timeout?: number) => unknown;
    clearInterval?: (handle: unknown) => void;
  };
  globals.document = documentStub;
  // `window` 上的定时器：视图按 `obsidianmd/prefer-window-timers` 改成 `window.setTimeout` /
  // `window.setInterval` 之后，桩里必须同构（Node 里没有真的 window，不同构就直接 undefined 崩）。
  // 这里直接转发 Node 的全局定时器 —— 是桩的实现本体，不能再写 `window.setTimeout`（自己调自己）。
  globals.window = {
    innerWidth: 1200,
    open: (): void => undefined,
    setTimeout: globals.setTimeout,
    clearTimeout: globals.clearTimeout,
    setInterval: globals.setInterval,
    clearInterval: globals.clearInterval,
    /**
     * Phase 25：导航条的滚动高亮用 rAF 节流。桩里**同步执行**回调 ——
     * 真实 rAF 是异步的，但用例要断言「滚动后高亮变了」而不想等动画帧，同步等价且更稳。
     */
    requestAnimationFrame: (handler: (time: number) => void): number => {
      handler(0);
      return 0;
    },
  };
  // Obsidian 的 DOM 增强层**还有一组全局**同名函数：`createDiv()` / `createEl(tag)` / `createSpan()`
  // —— 它们返回的是**游离**元素（与 `document.createDiv` 的「创建 + append 到 document」
  // 完全是两回事，后者见上面的 notAContainer）。`views/wfView.ts` 的 `detachedDiv()`
  // 就靠全局 `createDiv()` 造游离卡片，桩里必须补一个，否则单测里 `createDiv is not defined`。
  globals.createDiv = (options: StubElementOptions = {}): StubElement => createStubElement("div", options);
  globals.HTMLElement = StubElement;
  return body;
}

/** 桩元素当 HTMLElement 传给视图（视图只用上面那几个方法） */
export function asHtmlElement(element: StubElement): HTMLElement {
  return element as unknown as HTMLElement;
}
