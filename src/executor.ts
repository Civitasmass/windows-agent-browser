import { CdpClient } from "./cdp/client.js";
import { createAgentApi } from "./api.js";
import { ensureBrowser } from "./chrome.js";
import { resolveConfig } from "./config.js";
import { acquireContextLease } from "./lease.js";
import { BrowserRuntime } from "./runtime.js";
import type { BrowserConfig } from "./types.js";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (
  ...args: string[]
) => (...values: unknown[]) => Promise<unknown>;

export async function executeScript(
  code: string,
  options: { config?: BrowserConfig } = {},
): Promise<void> {
  if (!code.trim()) {
    throw new TypeError("Browser script is empty.");
  }
  const config = options.config ?? resolveConfig();
  const lease = await acquireContextLease(config);
  let runtime: BrowserRuntime | undefined;
  try {
    const browser = await ensureBrowser(config);
    const client = new CdpClient({
      defaultTimeoutMs: config.cdpTimeoutMs,
    });
    await client.connect(browser.webSocketDebuggerUrl);
    runtime = new BrowserRuntime(client, config);
    await runtime.initialize();
    const api = createAgentApi(runtime);
    const names = Object.keys(api);
    const values = Object.values(api);
    const script = new AsyncFunction(
      ...names,
      `"use strict";\n${code}\n`,
    );
    await script(...values);
  } finally {
    runtime?.closeConnection();
    await lease.release();
  }
}
