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
   * 事件监听（Phase 18）：`wfView` 的间隙滚轮与 `emoWidget` 的拖拽 / 缩放都要挂监听。
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
    const el = new StubElement(tagName);
    if (options.cls !== undefined) el.addClass(...options.cls.split(/\s+/));
    if (options.text !== undefined) el.setText(options.text);
    this.appendChild(el);
    return el;
  }

  createDiv(options: StubElementOptions = {}): StubElement {
    return this.createEl("div", options);
  }

  /** Obsidian 的 `createSpan`（sidebar 的图标位、点表的 x / y 都用它） */
  createSpan(options: StubElementOptions = {}): StubElement {
    return this.createEl("span", options);
  }

  /** 只支持 `.class` 选择器（视图与测试都够用） */
  closest(selector: string): StubElement | null {
    let cursor: StubElement | null = this;
    while (cursor !== null) {
      if (selector.startsWith(".") && cursor.classNames.has(selector.slice(1))) return cursor;
      cursor = cursor.parent;
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
    /** 游离元素工厂（真实 DOM 的标准 API；视图里的 detachedDiv 走这里） */
    createElement: (tagName: string): StubElement => new StubElement(tagName),
    /** SVG 元素工厂（Phase 19 M3：折线 / 圆点 / 刻度都在 SVG 命名空间里建） */
    createElementNS: (_namespace: string, tagName: string): StubElement => new StubElement(tagName),
    addEventListener: (): void => undefined,
  };
  const globals = globalThis as { document?: unknown; window?: unknown; HTMLElement?: unknown };
  globals.document = documentStub;
  globals.window = { innerWidth: 1200, open: (): void => undefined };
  globals.HTMLElement = StubElement;
  return body;
}

/** 桩元素当 HTMLElement 传给视图（视图只用上面那几个方法） */
export function asHtmlElement(element: StubElement): HTMLElement {
  return element as unknown as HTMLElement;
}
