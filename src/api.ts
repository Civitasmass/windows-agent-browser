import { mkdir, stat, writeFile } from "node:fs/promises";
import { dirname, extname, resolve } from "node:path";

import { AgentBrowserError } from "./errors.js";
import { RefStore } from "./refs.js";
import { BrowserRuntime, sleep, type TabInfo } from "./runtime.js";
import { buildSnapshot, type SnapshotRef } from "./snapshot.js";

type EvaluateInput<T, A> = string | ((arg: A) => T | Promise<T>);
type ElementTarget = string | [number, number] | { x: number; y: number };

export interface PageInfo {
  url: string;
  title: string;
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  pageWidth: number;
  pageHeight: number;
}

export interface ScreenshotOptions {
  path?: string;
  fullPage?: boolean;
  format?: "png" | "jpeg" | "webp";
  quality?: number;
}

export interface ViewportOptions {
  width: number;
  height: number;
  deviceScaleFactor?: number;
  mobile?: boolean;
}

export interface WaitForAnyCondition {
  name: string;
  url?: string | RegExp;
  selector?: string;
  text?: string | RegExp;
  state?: "attached" | "visible";
}

export interface WaitForAnyOptions {
  timeoutMs?: number;
  pollMs?: number;
}

export interface WaitForAnyResult {
  name: string;
  index: number;
  url: string;
}

export function createAgentApi(runtime: BrowserRuntime) {
  const refs = new RefStore(runtime.config.paths.refsFile);

  const browser = {
    tabs: () => runtime.tabs(),
    current: () => runtime.current(),
    open: (
      url?: string,
      options?: { wait?: boolean; timeoutMs?: number },
    ) => runtime.open(url, options),
    use: (targetId: string) => runtime.use(targetId),
    close: (targetId?: string) => runtime.close(targetId),
  };

  const page = {
    info: () => pageInfo(runtime),
    goto: (
      url: string,
      options?: { wait?: boolean; timeoutMs?: number },
    ) => goto(runtime, url, options),
    snapshot: (options?: { maxChars?: number }) =>
      snapshot(runtime, refs, options),
    click: (
      target: ElementTarget,
      options?: { waitForNavigation?: boolean; timeoutMs?: number },
    ) => click(runtime, refs, target, options),
    fill: (target: string, value: string) =>
      fill(runtime, refs, target, value),
    type: (
      target: string,
      text: string,
      options?: { delayMs?: number },
    ) => typeText(runtime, refs, target, text, options),
    setInputFiles: (
      target: string,
      files: string | readonly string[],
    ) => setInputFiles(runtime, refs, target, files),
    press: (
      key: string,
      options?: { waitForNavigation?: boolean; timeoutMs?: number },
    ) => press(runtime, key, options),
    evaluate: <T = unknown, A = unknown>(
      input: EvaluateInput<T, A>,
      arg?: A,
    ) => evaluate<T, A>(runtime, input, arg),
    screenshot: (options?: ScreenshotOptions) =>
      screenshot(runtime, options),
    setViewport: (options: ViewportOptions) =>
      setViewport(runtime, options),
    waitForLoadState: (options?: { timeoutMs?: number }) =>
      runtime.waitForLoadState(options?.timeoutMs),
    waitForURL: (
      expected: string | RegExp,
      options?: { timeoutMs?: number },
    ) => waitForURL(runtime, expected, options),
    waitForAny: (
      conditions: readonly WaitForAnyCondition[],
      options?: WaitForAnyOptions,
    ) => waitForAny(runtime, conditions, options),
    waitForTimeout: (ms: number) => sleep(ms),
  };

  const cdp = async <T = Record<string, unknown>>(
    method: string,
    params: Record<string, unknown> = {},
    options: { browser?: boolean; sessionId?: string } = {},
  ): Promise<T> => {
    if (options.sessionId) {
      return runtime.client.send<T>(
        method,
        params,
        options.sessionId,
      );
    }
    return options.browser
      ? runtime.sendBrowser<T>(method, params)
      : runtime.sendPage<T>(method, params);
  };

  return { browser, page, cdp, sleep };
}

async function pageInfo(runtime: BrowserRuntime): Promise<PageInfo> {
  return runtime.evaluate<PageInfo>(`(() => {
    const root = document.documentElement;
    return {
      url: location.href,
      title: document.title,
      width: innerWidth,
      height: innerHeight,
      scrollX,
      scrollY,
      pageWidth: root?.scrollWidth ?? innerWidth,
      pageHeight: root?.scrollHeight ?? innerHeight
    };
  })()`);
}

async function goto(
  runtime: BrowserRuntime,
  url: string,
  options: { wait?: boolean; timeoutMs?: number } = {},
) {
  const navigation = await runtime.sendPage<{
    frameId?: string;
    loaderId?: string;
    errorText?: string;
  }>("Page.navigate", { url });
  if (navigation.errorText) {
    throw new AgentBrowserError(
      "NAVIGATION_FAILED",
      `Navigation failed: ${navigation.errorText}`,
    );
  }
  if (options.wait !== false) {
    await runtime.waitForLoadState(
      options.timeoutMs,
      navigation.loaderId,
    );
  }
  return {
    url: (await pageInfo(runtime)).url,
    loaded: options.wait !== false,
  };
}

async function snapshot(
  runtime: BrowserRuntime,
  refs: RefStore,
  options: { maxChars?: number } = {},
): Promise<string> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const before = await documentDescriptor(runtime);
    const [{ nodes = [] }, info, context] = await Promise.all([
      runtime.sendPage<{ nodes?: Parameters<typeof buildSnapshot>[0] }>(
        "Accessibility.getFullAXTree",
      ),
      pageInfo(runtime),
      runtime.context(),
    ]);
    const after = await documentDescriptor(runtime);
    if (before.documentId !== after.documentId) continue;
    const result = buildSnapshot(nodes, {
      targetId: context.targetId,
      url: info.url,
      title: info.title,
      maxChars: options.maxChars,
      frameId: after.frameId,
      documentId: after.documentId,
      hasChildFrames: after.hasChildFrames,
    });
    await refs.save({
      targetId: context.targetId,
      url: info.url,
      title: info.title,
      documentId: after.documentId,
      refs: result.refs,
    });
    return result.content;
  }
  throw new AgentBrowserError(
    "SNAPSHOT_NAVIGATION_RACE",
    "The page navigated while its snapshot was being built. Wait for the page to settle and take a new snapshot.",
  );
}

async function click(
  runtime: BrowserRuntime,
  refs: RefStore,
  target: ElementTarget,
  options: { waitForNavigation?: boolean; timeoutMs?: number } = {},
): Promise<void> {
  const previousDocument = options.waitForNavigation
    ? await documentIdentity(runtime)
    : undefined;
  const point = Array.isArray(target)
    ? { x: target[0], y: target[1] }
    : typeof target === "object"
      ? target
      : await elementCenter(runtime, refs, target);
  if (
    !Number.isFinite(point.x) ||
    !Number.isFinite(point.y)
  ) {
    throw new AgentBrowserError(
      "INVALID_CLICK_POINT",
      "Click coordinates must be finite numbers.",
    );
  }
  await runtime.bringToFront();
  await runtime.sendPage("Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: point.x,
    y: point.y,
    buttons: 0,
  });
  await sleep(25);
  await runtime.sendPage("Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 1,
    clickCount: 1,
  });
  await sleep(25);
  await runtime.sendPage("Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: point.x,
    y: point.y,
    button: "left",
    buttons: 0,
    clickCount: 1,
  });
  if (previousDocument) {
    await waitForDocumentChange(
      runtime,
      previousDocument,
      options.timeoutMs,
    );
    await runtime.waitForLoadState(options.timeoutMs);
  }
}

async function fill(
  runtime: BrowserRuntime,
  refs: RefStore,
  target: string,
  value: string,
): Promise<void> {
  const node = await resolveElement(runtime, refs, target);
  await runtime.bringToFront();
  await runtime.sendPage("DOM.focus", { backendNodeId: node.backendNodeId });
  await press(runtime, "Control+a", {}, false);
  await press(runtime, "Backspace", {}, false);
  if (value) {
    await runtime.sendPage("Input.insertText", { text: value });
  }
}

async function typeText(
  runtime: BrowserRuntime,
  refs: RefStore,
  target: string,
  text: string,
  options: { delayMs?: number } = {},
): Promise<void> {
  const node = await resolveElement(runtime, refs, target);
  await runtime.bringToFront();
  await runtime.sendPage("DOM.focus", { backendNodeId: node.backendNodeId });
  const delayMs = options.delayMs ?? 0;
  if (delayMs <= 0) {
    await runtime.sendPage("Input.insertText", { text });
    return;
  }
  for (const character of text) {
    await runtime.sendPage("Input.insertText", { text: character });
    await sleep(delayMs);
  }
}

async function setInputFiles(
  runtime: BrowserRuntime,
  refs: RefStore,
  target: string,
  input: string | readonly string[],
): Promise<void> {
  if (typeof input !== "string" && !Array.isArray(input)) {
    throw new AgentBrowserError(
      "UPLOAD_FILE_INVALID",
      "Upload files must be a path string or an array of path strings.",
    );
  }
  const requestedFiles =
    typeof input === "string" ? [input] : [...input];
  if (requestedFiles.length === 0) {
    throw new AgentBrowserError(
      "UPLOAD_FILES_EMPTY",
      "At least one file path is required.",
    );
  }

  const files: string[] = [];
  for (const requestedFile of requestedFiles) {
    if (typeof requestedFile !== "string" || !requestedFile.trim()) {
      throw new AgentBrowserError(
        "UPLOAD_FILE_INVALID",
        "Upload file paths must be non-empty strings.",
      );
    }
    const absolutePath = resolve(requestedFile);
    let fileInfo;
    try {
      fileInfo = await stat(absolutePath);
    } catch (cause) {
      throw new AgentBrowserError(
        "UPLOAD_FILE_UNAVAILABLE",
        `Upload file is not available: ${absolutePath}`,
        { cause },
      );
    }
    if (!fileInfo.isFile()) {
      throw new AgentBrowserError(
        "UPLOAD_FILE_INVALID",
        `Upload path is not a regular file: ${absolutePath}`,
      );
    }
    files.push(absolutePath);
  }

  const node = await resolveElement(runtime, refs, target);
  await runtime.sendPage("DOM.setFileInputFiles", {
    files,
    backendNodeId: node.backendNodeId,
  });
}

async function press(
  runtime: BrowserRuntime,
  combo: string,
  options: { waitForNavigation?: boolean; timeoutMs?: number } = {},
  bringToFront = true,
): Promise<void> {
  const parsed = parseKeyCombo(combo);
  const previousDocument = options.waitForNavigation
    ? await documentIdentity(runtime)
    : undefined;
  if (bringToFront) {
    await runtime.bringToFront();
  }
  const key = keyDefinition(parsed.key);
  const base = {
    key: key.key,
    code: key.code,
    modifiers: parsed.modifiers,
    windowsVirtualKeyCode: key.virtualKeyCode,
    nativeVirtualKeyCode: key.virtualKeyCode,
  };
  await runtime.sendPage("Input.dispatchKeyEvent", {
    type: "keyDown",
    ...base,
    ...(key.text && parsed.modifiers === 0
      ? { text: key.text, unmodifiedText: key.text }
      : {}),
    ...(parsed.modifiers === 2 && parsed.key.toLowerCase() === "a"
      ? { commands: ["selectAll"] }
      : {}),
    ...(parsed.modifiers === 0 && parsed.key === "Backspace"
      ? { commands: ["deleteBackward"] }
      : {}),
  });
  await sleep(25);
  await runtime.sendPage("Input.dispatchKeyEvent", {
    type: "keyUp",
    ...base,
  });
  if (previousDocument) {
    await waitForDocumentChange(
      runtime,
      previousDocument,
      options.timeoutMs,
    );
    await runtime.waitForLoadState(options.timeoutMs);
  }
}

async function evaluate<T, A>(
  runtime: BrowserRuntime,
  input: EvaluateInput<T, A>,
  arg: A | undefined,
): Promise<T> {
  const expression =
    typeof input === "function"
      ? `(${input.toString()})(${serializeArgument(arg)})`
      : input;
  return runtime.evaluate<T>(expression, { awaitPromise: true });
}

async function screenshot(
  runtime: BrowserRuntime,
  options: ScreenshotOptions = {},
): Promise<string> {
  const format =
    options.format ??
    (options.path && extname(options.path).toLowerCase() === ".jpg"
      ? "jpeg"
      : "png");
  let clip:
    | { x: number; y: number; width: number; height: number; scale: number }
    | undefined;
  if (options.fullPage) {
    const metrics = await runtime.sendPage<{
      cssContentSize?: { width: number; height: number };
      contentSize?: { width: number; height: number };
    }>("Page.getLayoutMetrics");
    const size = metrics.cssContentSize ?? metrics.contentSize;
    if (size) {
      clip = {
        x: 0,
        y: 0,
        width: Math.max(1, size.width),
        height: Math.max(1, size.height),
        scale: 1,
      };
    }
  }
  const response = await runtime.sendPage<{ data?: string }>(
    "Page.captureScreenshot",
    {
      format,
      captureBeyondViewport: Boolean(options.fullPage),
      fromSurface: true,
      ...(format !== "png" && options.quality !== undefined
        ? { quality: options.quality }
        : {}),
      ...(clip ? { clip } : {}),
    },
  );
  if (!response.data) {
    throw new AgentBrowserError(
      "SCREENSHOT_FAILED",
      "Chrome returned no screenshot data.",
    );
  }
  if (!options.path) return response.data;
  await mkdir(dirname(options.path), { recursive: true });
  await writeFile(options.path, Buffer.from(response.data, "base64"));
  return options.path;
}

async function setViewport(
  runtime: BrowserRuntime,
  options: ViewportOptions,
): Promise<PageInfo> {
  if (
    !Number.isInteger(options.width) ||
    options.width <= 0 ||
    !Number.isInteger(options.height) ||
    options.height <= 0
  ) {
    throw new AgentBrowserError(
      "INVALID_VIEWPORT",
      "Viewport width and height must be positive integers.",
    );
  }
  const deviceScaleFactor = options.deviceScaleFactor ?? 1;
  if (
    !Number.isFinite(deviceScaleFactor) ||
    deviceScaleFactor <= 0
  ) {
    throw new AgentBrowserError(
      "INVALID_VIEWPORT",
      "Viewport deviceScaleFactor must be a positive finite number.",
    );
  }
  await runtime.sendPage("Emulation.setDeviceMetricsOverride", {
    width: options.width,
    height: options.height,
    deviceScaleFactor,
    mobile: options.mobile ?? false,
  });
  return pageInfo(runtime);
}

async function elementCenter(
  runtime: BrowserRuntime,
  refs: RefStore,
  target: string,
): Promise<{ x: number; y: number }> {
  const node = await resolveElement(runtime, refs, target);
  await runtime.sendPage("DOM.scrollIntoViewIfNeeded", {
    backendNodeId: node.backendNodeId,
  });
  const response = await runtime.sendPage<{
    model?: { content?: number[]; border?: number[] };
  }>("DOM.getBoxModel", { backendNodeId: node.backendNodeId });
  const quad = response.model?.content ?? response.model?.border;
  if (!quad || quad.length < 8) {
    throw new AgentBrowserError(
      "ELEMENT_HAS_NO_BOX",
      `Element has no clickable layout box: ${target}`,
    );
  }
  return {
    x: (quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4,
    y: (quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4,
  };
}

async function resolveElement(
  runtime: BrowserRuntime,
  refs: RefStore,
  target: string,
): Promise<{ backendNodeId: number; ref?: SnapshotRef }> {
  if (target.startsWith("@")) {
    const context = await runtime.context();
    const [info, documentId] = await Promise.all([
      pageInfo(runtime),
      documentIdentity(runtime),
    ]);
    const ref = await refs.resolve(target, {
      targetId: context.targetId,
      url: info.url,
      documentId,
    });
    return { backendNodeId: ref.backendNodeId, ref };
  }
  const selector = target.startsWith("loc=css:")
    ? target.slice("loc=css:".length)
    : target;
  const response = await runtime.sendPage<{
    result?: { objectId?: string; subtype?: string };
    exceptionDetails?: unknown;
  }>("Runtime.evaluate", {
    expression: `document.querySelector(${JSON.stringify(selector)})`,
    returnByValue: false,
    objectGroup: "agent-browser",
  });
  if (response.exceptionDetails) {
    throw new AgentBrowserError(
      "INVALID_SELECTOR",
      `Invalid CSS selector: ${selector}`,
    );
  }
  const objectId = response.result?.objectId;
  if (!objectId || response.result?.subtype === "null") {
    throw new AgentBrowserError(
      "ELEMENT_NOT_FOUND",
      `Element not found: ${selector}`,
    );
  }
  const described = await runtime.sendPage<{
    node?: { backendNodeId?: number };
  }>("DOM.describeNode", { objectId });
  if (!described.node?.backendNodeId) {
    throw new AgentBrowserError(
      "ELEMENT_RESOLUTION_FAILED",
      `Could not resolve element: ${selector}`,
    );
  }
  return { backendNodeId: described.node.backendNodeId };
}

async function documentIdentity(runtime: BrowserRuntime): Promise<string> {
  return (await documentDescriptor(runtime)).documentId;
}

async function documentDescriptor(
  runtime: BrowserRuntime,
): Promise<{
  documentId: string;
  frameId: string;
  hasChildFrames: boolean;
}> {
  const [document, frames] = await Promise.all([
    runtime.sendPage<{ root?: { backendNodeId?: number } }>(
      "DOM.getDocument",
      { depth: 0, pierce: false },
    ),
    runtime.sendPage<{
      frameTree?: FrameTreeLike;
    }>("Page.getFrameTree"),
  ]);
  const backendNodeId = document.root?.backendNodeId;
  if (
    typeof backendNodeId !== "number" ||
    !Number.isInteger(backendNodeId) ||
    backendNodeId <= 0
  ) {
    throw new AgentBrowserError(
      "DOCUMENT_ID_UNAVAILABLE",
      "Chrome did not return the current document backend node id.",
    );
  }
  const frameId = frames.frameTree?.frame?.id;
  if (!frameId) {
    throw new AgentBrowserError(
      "DOCUMENT_ID_UNAVAILABLE",
      "Chrome did not return the current main frame id.",
    );
  }
  const loaderId = frames.frameTree?.frame?.loaderId;
  return {
    documentId: `${loaderId || "no-loader"}:backend-node:${backendNodeId}`,
    frameId,
    hasChildFrames: Boolean(frames.frameTree?.childFrames?.length),
  };
}

interface FrameTreeLike {
  frame?: { id?: string; loaderId?: string };
  childFrames?: FrameTreeLike[];
}

async function waitForDocumentChange(
  runtime: BrowserRuntime,
  previousDocument: string,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      if ((await documentIdentity(runtime)) !== previousDocument) return;
    } catch (error) {
      if (
        !(
          error instanceof AgentBrowserError &&
          (error.code === "DOCUMENT_ID_UNAVAILABLE" ||
            error.code === "CDP_PROTOCOL_ERROR")
        )
      ) {
        throw error;
      }
    }
    await sleep(50);
  }
  throw new AgentBrowserError(
    "NAVIGATION_TIMEOUT",
    `The action did not create a new document within ${timeoutMs}ms.`,
  );
}

async function waitForURL(
  runtime: BrowserRuntime,
  expected: string | RegExp,
  options: { timeoutMs?: number } = {},
): Promise<string> {
  const timeoutMs = options.timeoutMs ?? 20_000;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const current = (await pageInfo(runtime)).url;
      if (expected instanceof RegExp) expected.lastIndex = 0;
      if (
        typeof expected === "string"
          ? current === expected || current.includes(expected)
          : expected.test(current)
      ) {
        return current;
      }
    } catch (error) {
      if (
        !(
          error instanceof AgentBrowserError &&
          error.code === "PAGE_EVALUATION_FAILED" &&
          /execution context|context.*destroyed|cannot find context|navigat/i.test(
            error.message,
          )
        )
      ) {
        throw error;
      }
    }
    await sleep(100);
  }
  throw new AgentBrowserError(
    "URL_WAIT_TIMEOUT",
    `Page URL did not match ${String(expected)} within ${timeoutMs}ms.`,
  );
}

interface SerializedWaitPattern {
  kind: "string" | "regexp";
  value?: string;
  source?: string;
  flags?: string;
}

interface SerializedWaitCondition {
  name: string;
  url?: SerializedWaitPattern;
  selector?: string;
  text?: SerializedWaitPattern;
  state?: "attached" | "visible";
}

async function waitForAny(
  runtime: BrowserRuntime,
  conditions: readonly WaitForAnyCondition[],
  options: WaitForAnyOptions = {},
): Promise<WaitForAnyResult> {
  if (!Array.isArray(conditions)) {
    throw new AgentBrowserError(
      "WAIT_CONDITIONS_INVALID",
      "page.waitForAny conditions must be an array.",
    );
  }
  if (conditions.length === 0) {
    throw new AgentBrowserError(
      "WAIT_CONDITIONS_EMPTY",
      "page.waitForAny requires at least one condition.",
    );
  }
  const timeoutMs = positiveFinite(
    options.timeoutMs ?? 20_000,
    "timeoutMs",
  );
  const pollMs = positiveFinite(options.pollMs ?? 100, "pollMs");
  const names = new Set<string>();
  const serialized = conditions.map((condition) => {
    if (
      !condition ||
      typeof condition !== "object" ||
      typeof condition.name !== "string" ||
      !condition.name.trim()
    ) {
      throw new AgentBrowserError(
        "WAIT_CONDITION_INVALID",
        "Every wait condition requires a non-empty name.",
      );
    }
    if (names.has(condition.name)) {
      throw new AgentBrowserError(
        "WAIT_CONDITION_INVALID",
        `Wait condition names must be unique: ${condition.name}`,
      );
    }
    names.add(condition.name);
    if (
      condition.url === undefined &&
      condition.selector === undefined &&
      condition.text === undefined
    ) {
      throw new AgentBrowserError(
        "WAIT_CONDITION_INVALID",
        `Wait condition "${condition.name}" has no URL, selector, or text test.`,
      );
    }
    if (condition.state !== undefined && condition.selector === undefined) {
      throw new AgentBrowserError(
        "WAIT_CONDITION_INVALID",
        `Wait condition "${condition.name}" uses state without a selector.`,
      );
    }
    const result: SerializedWaitCondition = { name: condition.name };
    if (condition.url !== undefined) {
      result.url = serializeWaitPattern(condition.url, condition.name);
    }
    if (condition.selector !== undefined) {
      if (
        typeof condition.selector !== "string" ||
        !condition.selector
      ) {
        throw new AgentBrowserError(
          "WAIT_CONDITION_INVALID",
          `Wait condition "${condition.name}" has an empty selector.`,
        );
      }
      result.selector = condition.selector;
    }
    if (condition.text !== undefined) {
      result.text = serializeWaitPattern(condition.text, condition.name);
    }
    if (condition.state !== undefined) result.state = condition.state;
    return result;
  });

  const expression = `(() => {
    const conditions = ${JSON.stringify(serialized)};
    const testPattern = (value, pattern) => pattern.kind === "regexp"
      ? new RegExp(pattern.source, pattern.flags).test(value)
      : value === pattern.value || value.includes(pattern.value);
    const isVisible = (element) => {
      const style = getComputedStyle(element);
      const box = element.getBoundingClientRect();
      return style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || "1") !== 0 &&
        box.width > 0 &&
        box.height > 0;
    };
    for (let index = 0; index < conditions.length; index += 1) {
      const condition = conditions[index];
      if (condition.url && !testPattern(location.href, condition.url)) {
        continue;
      }
      const element = condition.selector
        ? document.querySelector(condition.selector)
        : null;
      if (condition.selector && !element) continue;
      if (condition.state === "visible" && !isVisible(element)) continue;
      if (condition.text) {
        const value = element
          ? (element.innerText || element.textContent || "")
          : (document.body?.innerText || document.documentElement?.textContent || "");
        if (!testPattern(value, condition.text)) continue;
      }
      return { name: condition.name, index, url: location.href };
    }
    return null;
  })()`;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const matched = await runtime.evaluate<WaitForAnyResult | null>(
        expression,
      );
      if (matched) return matched;
    } catch (error) {
      if (!isTransientPageEvaluationError(error)) throw error;
    }
    await sleep(Math.min(pollMs, Math.max(1, deadline - Date.now())));
  }
  throw new AgentBrowserError(
    "WAIT_FOR_ANY_TIMEOUT",
    `None of the wait conditions matched within ${timeoutMs}ms: ${[
      ...names,
    ].join(", ")}`,
  );
}

function serializeWaitPattern(
  pattern: string | RegExp,
  conditionName: string,
): SerializedWaitPattern {
  if (typeof pattern === "string") {
    if (!pattern) {
      throw new AgentBrowserError(
        "WAIT_CONDITION_INVALID",
        `Wait condition "${conditionName}" has an empty string pattern.`,
      );
    }
    return { kind: "string", value: pattern };
  }
  if (!(pattern instanceof RegExp)) {
    throw new AgentBrowserError(
      "WAIT_CONDITION_INVALID",
      `Wait condition "${conditionName}" pattern must be a string or regular expression.`,
    );
  }
  return {
    kind: "regexp",
    source: pattern.source,
    flags: pattern.flags,
  };
}

function positiveFinite(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new AgentBrowserError(
      "WAIT_OPTIONS_INVALID",
      `${label} must be a positive finite number.`,
    );
  }
  return value;
}

function isTransientPageEvaluationError(error: unknown): boolean {
  return (
    error instanceof AgentBrowserError &&
    error.code === "PAGE_EVALUATION_FAILED" &&
    /execution context|context.*destroyed|cannot find context|navigat/i.test(
      error.message,
    )
  );
}

function serializeArgument(value: unknown): string {
  if (value === undefined) return "undefined";
  const serialized = JSON.stringify(value);
  if (serialized === undefined) {
    throw new TypeError("page.evaluate argument must be JSON-serializable.");
  }
  return serialized;
}

function parseKeyCombo(combo: string): { key: string; modifiers: number } {
  const parts = combo.split("+");
  const key = parts.pop() || "+";
  let modifiers = 0;
  for (const modifier of parts) {
    if (modifier === "Alt") modifiers |= 1;
    else if (modifier === "Control" || modifier === "ControlOrMeta")
      modifiers |= 2;
    else if (modifier === "Meta") modifiers |= 4;
    else if (modifier === "Shift") modifiers |= 8;
    else
      throw new AgentBrowserError(
        "UNKNOWN_KEY_MODIFIER",
        `Unknown key modifier: ${modifier}`,
      );
  }
  return { key, modifiers };
}

function keyDefinition(key: string): {
  key: string;
  code: string;
  text: string;
  virtualKeyCode: number;
} {
  const special: Record<
    string,
    { code: string; text: string; virtualKeyCode: number }
  > = {
    Enter: { code: "Enter", text: "\r", virtualKeyCode: 13 },
    Tab: { code: "Tab", text: "", virtualKeyCode: 9 },
    Backspace: { code: "Backspace", text: "", virtualKeyCode: 8 },
    Delete: { code: "Delete", text: "", virtualKeyCode: 46 },
    Escape: { code: "Escape", text: "", virtualKeyCode: 27 },
    ArrowLeft: { code: "ArrowLeft", text: "", virtualKeyCode: 37 },
    ArrowUp: { code: "ArrowUp", text: "", virtualKeyCode: 38 },
    ArrowRight: { code: "ArrowRight", text: "", virtualKeyCode: 39 },
    ArrowDown: { code: "ArrowDown", text: "", virtualKeyCode: 40 },
    Home: { code: "Home", text: "", virtualKeyCode: 36 },
    End: { code: "End", text: "", virtualKeyCode: 35 },
    PageUp: { code: "PageUp", text: "", virtualKeyCode: 33 },
    PageDown: { code: "PageDown", text: "", virtualKeyCode: 34 },
    " ": { code: "Space", text: " ", virtualKeyCode: 32 },
  };
  const known = special[key];
  if (known) return { key, ...known };
  if (key.length !== 1) {
    return { key, code: key, text: "", virtualKeyCode: 0 };
  }
  const upper = key.toUpperCase();
  return {
    key,
    code: /[0-9]/.test(key) ? `Digit${key}` : `Key${upper}`,
    text: key,
    virtualKeyCode: upper.codePointAt(0) ?? 0,
  };
}

export type AgentApi = ReturnType<typeof createAgentApi>;
export type { TabInfo };
