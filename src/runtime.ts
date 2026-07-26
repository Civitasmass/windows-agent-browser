import { randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";

import { CdpClient } from "./cdp/client.js";
import { AgentBrowserError } from "./errors.js";
import type {
  AttachedTarget,
  BrowserConfig,
  CdpParams,
  TargetInfo,
} from "./types.js";

const INTERNAL_URL_PREFIXES = [
  "devtools://",
  "chrome://",
  "chrome-search://",
  "chrome-extension://",
  "edge://",
  "edge-extension://",
  "about:srcdoc",
];

export interface TabInfo {
  targetId: string;
  title: string;
  url: string;
}

export interface PageContext extends AttachedTarget {
  target: TabInfo;
}

export class BrowserRuntime {
  readonly client: CdpClient;
  readonly config: BrowserConfig;

  private activeTargetId: string | undefined;
  private readonly sessions = new Map<string, string>();
  private readonly sessionInflight = new Map<string, Promise<string>>();

  constructor(client: CdpClient, config: BrowserConfig) {
    this.client = client;
    this.config = config;
  }

  async initialize(): Promise<void> {
    await mkdir(this.config.paths.stateDir, { recursive: true });
    await this.client.send("Target.setDiscoverTargets", { discover: true });
    this.client.on<{ sessionId?: string; targetId?: string }>(
      "Target.detachedFromTarget",
      (event) => {
        const detachedSession = event.params?.sessionId;
        const detachedTarget = event.params?.targetId;
        for (const [targetId, sessionId] of this.sessions) {
          if (
            sessionId === detachedSession ||
            targetId === detachedTarget
          ) {
            this.sessions.delete(targetId);
          }
        }
      },
    );
    this.client.on<{ targetId?: string }>(
      "Target.targetDestroyed",
      (event) => {
        const targetId = event.params?.targetId;
        if (targetId) {
          this.sessions.delete(targetId);
          this.sessionInflight.delete(targetId);
        }
      },
    );
    this.activeTargetId = await this.readActiveTarget();
    const tabs = await this.tabs();
    if (
      this.activeTargetId &&
      !tabs.some((tab) => tab.targetId === this.activeTargetId)
    ) {
      this.activeTargetId = undefined;
    }
    if (!this.activeTargetId && tabs.length === 1) {
      await this.setActiveTarget(tabs[0]!.targetId);
    } else if (!this.activeTargetId && tabs.length === 0) {
      await this.open("about:blank", { wait: false });
    }
  }

  async tabs(): Promise<TabInfo[]> {
    const result = await this.client.send<{ targetInfos?: TargetInfo[] }>(
      "Target.getTargets",
    );
    return (result.targetInfos ?? [])
      .filter(
        (target) =>
          target.type === "page" &&
          !INTERNAL_URL_PREFIXES.some((prefix) =>
            (target.url || "").startsWith(prefix),
          ),
      )
      .map(tabFromTarget);
  }

  async current(): Promise<TabInfo> {
    const tabs = await this.tabs();
    let tab = tabs.find(
      (candidate) => candidate.targetId === this.activeTargetId,
    );
    if (!tab && tabs.length === 1) {
      tab = tabs[0];
    }
    if (!tab) {
      if (tabs.length > 1) {
        throw new AgentBrowserError(
          "NO_ACTIVE_TARGET",
          `No page is selected for this agent context and ${tabs.length} tabs are open. Call browser.tabs(), then browser.use(targetId) before using page methods.`,
        );
      }
      throw new AgentBrowserError(
        "NO_PAGE_TARGET",
        "No page target is available. Open a tab first.",
      );
    }
    if (tab.targetId !== this.activeTargetId) {
      await this.setActiveTarget(tab.targetId);
    }
    return tab;
  }

  async use(targetId: string): Promise<TabInfo> {
    const tab = (await this.tabs()).find(
      (candidate) => candidate.targetId === targetId,
    );
    if (!tab) {
      throw new AgentBrowserError(
        "TARGET_NOT_FOUND",
        `Page target not found: ${targetId}`,
      );
    }
    await this.client.send("Target.activateTarget", { targetId });
    await this.setActiveTarget(targetId);
    await this.bringToFront();
    return tab;
  }

  async open(
    url = "about:blank",
    options: { wait?: boolean; timeoutMs?: number } = {},
  ): Promise<TabInfo> {
    const result = await this.client.send<{ targetId?: string }>(
      "Target.createTarget",
      { url: "about:blank" },
    );
    if (!result.targetId) {
      throw new AgentBrowserError(
        "TARGET_CREATE_FAILED",
        "Chrome did not return a target id for the new tab.",
      );
    }
    await this.client.send("Target.activateTarget", {
      targetId: result.targetId,
    });
    await this.setActiveTarget(result.targetId);
    await this.context();
    await this.bringToFront();
    if (url !== "about:blank") {
      const navigation = await this.sendPage<{
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
        await this.waitForLoadState(
          options.timeoutMs,
          navigation.loaderId,
        );
      }
    }
    return (
      (await this.tabs()).find(
        (tab) => tab.targetId === result.targetId,
      ) ?? { targetId: result.targetId, title: "", url }
    );
  }

  async close(targetId?: string): Promise<string> {
    const id = targetId ?? (await this.current()).targetId;
    const result = await this.client.send<{ success?: boolean }>(
      "Target.closeTarget",
      { targetId: id },
    );
    if (result.success === false) {
      throw new AgentBrowserError(
        "TARGET_CLOSE_FAILED",
        `Chrome could not close page target: ${id}`,
      );
    }
    this.sessions.delete(id);
    if (this.activeTargetId === id) {
      this.activeTargetId = undefined;
      const deadline = Date.now() + 2_000;
      let remaining = await this.tabs();
      while (
        remaining.some((tab) => tab.targetId === id) &&
        Date.now() < deadline
      ) {
        await sleep(50);
        remaining = await this.tabs();
      }
      if (remaining.length === 1) {
        await this.setActiveTarget(remaining[0]!.targetId);
      }
    }
    return id;
  }

  async context(): Promise<PageContext> {
    const target = await this.current();
    let sessionId = this.sessions.get(target.targetId);
    if (!sessionId) {
      let inflight = this.sessionInflight.get(target.targetId);
      if (!inflight) {
        inflight = this.attachTarget(target.targetId);
        this.sessionInflight.set(target.targetId, inflight);
      }
      sessionId = await inflight;
    }
    return { targetId: target.targetId, sessionId, target };
  }

  async sendPage<T = Record<string, unknown>>(
    method: string,
    params: CdpParams = {},
  ): Promise<T> {
    const { sessionId } = await this.context();
    return this.client.send<T>(method, params, sessionId);
  }

  async sendBrowser<T = Record<string, unknown>>(
    method: string,
    params: CdpParams = {},
  ): Promise<T> {
    return this.client.send<T>(method, params);
  }

  /**
   * Activates the selected page at the Page domain as well as the Target
   * domain. On visible Windows Chrome/Edge this also restores a minimized
   * browser window, which is required before dispatching reliable input.
   */
  async bringToFront(): Promise<void> {
    const { sessionId } = await this.context();
    await this.client.send("Page.bringToFront", {}, sessionId);
  }

  async evaluate<T = unknown>(
    expression: string,
    options: { awaitPromise?: boolean; returnByValue?: boolean } = {},
  ): Promise<T> {
    const response = await this.sendPage<{
      result?: {
        value?: T;
        unserializableValue?: string;
        description?: string;
        subtype?: string;
      };
      exceptionDetails?: {
        text?: string;
        lineNumber?: number;
        columnNumber?: number;
        exception?: { description?: string };
      };
    }>("Runtime.evaluate", {
      expression,
      awaitPromise: options.awaitPromise ?? true,
      returnByValue: options.returnByValue ?? true,
      userGesture: true,
    });
    if (response.exceptionDetails || response.result?.subtype === "error") {
      const details = response.exceptionDetails;
      const message =
        details?.exception?.description ||
        response.result?.description ||
        details?.text ||
        "Unknown page JavaScript error";
      throw new AgentBrowserError(
        "PAGE_EVALUATION_FAILED",
        `Page JavaScript failed: ${message}`,
      );
    }
    if (response.result && "value" in response.result) {
      return response.result.value as T;
    }
    if (response.result?.unserializableValue) {
      return decodeUnserializableValue(
        response.result.unserializableValue,
      ) as T;
    }
    return null as T;
  }

  async waitForLoadState(
    timeoutMs = 20_000,
    expectedLoaderId?: string,
  ): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    let lastState = "unknown";
    let lastLoaderId = "unknown";
    while (Date.now() < deadline) {
      try {
        const frames = await this.sendPage<{
          frameTree?: { frame?: { loaderId?: string } };
        }>("Page.getFrameTree");
        lastLoaderId =
          frames.frameTree?.frame?.loaderId ?? "unknown";
        if (
          expectedLoaderId &&
          lastLoaderId !== expectedLoaderId
        ) {
          await sleep(100);
          continue;
        }
        lastState = await this.evaluate<string>("document.readyState");
        if (lastState === "complete") return;
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
      "PAGE_LOAD_TIMEOUT",
      `Page did not reach the expected loaded document within ${timeoutMs}ms (last loader: ${lastLoaderId}; last readyState: ${lastState}).`,
    );
  }

  closeConnection(): void {
    this.client.close();
  }

  private async setActiveTarget(targetId: string): Promise<void> {
    const temporaryFile = `${this.config.paths.activeTargetFile}.${process.pid}.${randomUUID()}.tmp`;
    try {
      await writeFile(
        temporaryFile,
        `${JSON.stringify({ version: 1, targetId })}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      await rename(temporaryFile, this.config.paths.activeTargetFile);
      this.activeTargetId = targetId;
    } catch (error) {
      try {
        await rm(temporaryFile, { force: true });
      } catch (cleanupError) {
        throw new AgentBrowserError(
          "ACTIVE_TARGET_STATE_WRITE_FAILED",
          `Could not save active target state or remove its temporary file: ${String(cleanupError)}`,
          {
            cause: new AggregateError([error, cleanupError]),
          },
        );
      }
      throw new AgentBrowserError(
        "ACTIVE_TARGET_STATE_WRITE_FAILED",
        `Could not save active target state: ${String(error)}`,
        { cause: error },
      );
    }
  }

  private async readActiveTarget(): Promise<string | undefined> {
    try {
      const parsed = JSON.parse(
        await readFile(this.config.paths.activeTargetFile, "utf8"),
      ) as { version?: number; targetId?: unknown };
      return parsed.version === 1 && typeof parsed.targetId === "string"
        ? parsed.targetId
        : undefined;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw new AgentBrowserError(
        "ACTIVE_TARGET_STATE_INVALID",
        `Could not read active target state: ${String(error)}`,
        { cause: error },
      );
    }
  }

  private async attachTarget(targetId: string): Promise<string> {
    try {
      const attached = await this.client.send<{ sessionId?: string }>(
        "Target.attachToTarget",
        { targetId, flatten: true },
      );
      const sessionId = attached.sessionId;
      if (!sessionId) {
        throw new AgentBrowserError(
          "TARGET_ATTACH_FAILED",
          `Chrome did not return a session for target: ${targetId}`,
        );
      }
      await Promise.all([
        this.client.send("Page.enable", {}, sessionId),
        this.client.send("Runtime.enable", {}, sessionId),
        this.client.send("DOM.enable", {}, sessionId),
      ]);
      this.sessions.set(targetId, sessionId);
      return sessionId;
    } finally {
      this.sessionInflight.delete(targetId);
    }
  }
}

function tabFromTarget(target: TargetInfo): TabInfo {
  return {
    targetId: target.targetId,
    title: target.title || "",
    url: target.url || "",
  };
}

function decodeUnserializableValue(value: string): unknown {
  if (value === "NaN") return Number.NaN;
  if (value === "Infinity") return Number.POSITIVE_INFINITY;
  if (value === "-Infinity") return Number.NEGATIVE_INFINITY;
  if (value === "-0") return -0;
  if (value.endsWith("n")) return BigInt(value.slice(0, -1));
  return value;
}

export function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
