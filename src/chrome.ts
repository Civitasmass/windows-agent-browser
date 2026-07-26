import { constants as fsConstants } from "node:fs";
import {
  access as accessFile,
  mkdir,
  readFile,
  rmdir,
  writeFile,
} from "node:fs/promises";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import path from "node:path";

import { AgentBrowserError, errorMessage } from "./errors.js";
import type { BrowserConfig } from "./types.js";

export interface DevToolsActivePort {
  port: number;
  browserWebSocketPath: string;
}

export interface BrowserVersionInfo {
  Browser?: string;
  "Protocol-Version"?: string;
  "User-Agent"?: string;
  "V8-Version"?: string;
  "WebKit-Version"?: string;
  webSocketDebuggerUrl?: string;
  [key: string]: unknown;
}

interface BrowserProbeBase {
  port: number;
  httpUrl: string;
}

export type BrowserProbe =
  | (BrowserProbeBase & {
      ok: true;
      version: BrowserVersionInfo;
      webSocketDebuggerUrl: string;
    })
  | (BrowserProbeBase & {
      ok: false;
      version?: BrowserVersionInfo;
      webSocketDebuggerUrl?: undefined;
      error: string;
    });

type HealthyBrowserProbe = Extract<BrowserProbe, { ok: true }>;

export interface EnsuredBrowser {
  port: number;
  webSocketDebuggerUrl: string;
  launched: boolean;
  pid?: number;
  executablePath: string;
  profileDir: string;
}

export interface BrowserDoctorInfo {
  executablePath: string;
  executableExists: boolean;
  profileDir: string;
  profileExists: boolean;
  devToolsActivePortFile: string;
  browserPidFile: string;
  launchLockPath: string;
  recordedLaunchPid?: number;
  port?: number;
  browserWebSocketPath?: string;
  healthy: boolean;
  browser?: string;
  protocolVersion?: string;
  webSocketDebuggerUrl?: string;
  error?: string;
}

interface FetchResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

interface SpawnedBrowser {
  pid?: number | undefined;
  unref(): void;
  once(event: "error", listener: (error: Error) => void): unknown;
}

export interface ChromeDependencies {
  access?: (filePath: string, mode?: number) => Promise<void>;
  mkdir?: (
    directoryPath: string,
    options: { recursive: boolean },
  ) => Promise<unknown>;
  rmdir?: (directoryPath: string) => Promise<void>;
  readFile?: (filePath: string, encoding: "utf8") => Promise<string>;
  writeFile?: (
    filePath: string,
    data: string,
    encoding: "utf8",
  ) => Promise<void>;
  fetch?: (url: string, init?: RequestInit) => Promise<FetchResponse>;
  spawn?: (
    executablePath: string,
    args: string[],
    options: {
      detached: true;
      stdio: "ignore";
      windowsHide: false;
    },
  ) => SpawnedBrowser;
  allocatePort?: () => Promise<number>;
  now?: () => number;
  sleep?: (milliseconds: number) => Promise<void>;
}

async function allocateLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.once("error", reject);
    server.listen(
      { host: "127.0.0.1", port: 0, exclusive: true },
      () => {
        const address = server.address();
        if (address === null || typeof address === "string") {
          server.close(() => {
            reject(new Error("Node did not allocate a TCP port."));
          });
          return;
        }
        const port = address.port;
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(port);
        });
      },
    );
  });
}

function dependenciesWithDefaults(
  dependencies: ChromeDependencies,
): Required<ChromeDependencies> {
  return {
    access: dependencies.access ?? accessFile,
    mkdir: dependencies.mkdir ?? mkdir,
    rmdir: dependencies.rmdir ?? rmdir,
    readFile: dependencies.readFile ?? readFile,
    writeFile: dependencies.writeFile ?? writeFile,
    fetch:
      dependencies.fetch ??
      ((url, init) => fetch(url, init) as Promise<FetchResponse>),
    spawn:
      dependencies.spawn ??
      ((executablePath, args, options) =>
        spawn(executablePath, args, options)),
    allocatePort: dependencies.allocatePort ?? allocateLoopbackPort,
    now: dependencies.now ?? Date.now,
    sleep:
      dependencies.sleep ??
      ((milliseconds) =>
        new Promise((resolve) => {
          setTimeout(resolve, milliseconds);
        })),
  };
}

function isMissingFileError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function devToolsActivePortFile(profileDir: string): string {
  return path.join(profileDir, "DevToolsActivePort");
}

function parsePositiveInteger(value: string): number | undefined {
  if (!/^[1-9]\d*$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? parsed : undefined;
}

/**
 * Reads Chrome's DevToolsActivePort marker. Absence means that no debuggable
 * browser has announced itself for this profile; malformed content is surfaced.
 */
export async function readDevToolsActivePort(
  profileDir: string,
  dependencies: ChromeDependencies = {},
): Promise<DevToolsActivePort | undefined> {
  const deps = dependenciesWithDefaults(dependencies);
  let content: string;
  try {
    content = await deps.readFile(devToolsActivePortFile(profileDir), "utf8");
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw new AgentBrowserError(
      "DEVTOOLS_ACTIVE_PORT_READ_FAILED",
      `Could not read DevToolsActivePort: ${errorMessage(error)}`,
      { cause: error },
    );
  }

  const [portLine, webSocketPathLine] = content.split(/\r?\n/u);
  const port = parsePositiveInteger(portLine?.trim() ?? "");
  if (port === undefined || port > 65_535) {
    throw new AgentBrowserError(
      "DEVTOOLS_ACTIVE_PORT_INVALID",
      "DevToolsActivePort does not contain a valid localhost TCP port.",
    );
  }

  const browserWebSocketPath = webSocketPathLine?.trim() ?? "";
  if (
    !browserWebSocketPath.startsWith("/devtools/browser/") ||
    browserWebSocketPath === "/devtools/browser/"
  ) {
    throw new AgentBrowserError(
      "DEVTOOLS_ACTIVE_PORT_INVALID",
      "DevToolsActivePort does not contain a valid browser WebSocket path.",
    );
  }
  return { port, browserWebSocketPath };
}

function isBrowserVersionInfo(value: unknown): value is BrowserVersionInfo {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validBrowserWebSocketUrl(
  value: unknown,
  expectedPort: number,
): value is string {
  if (typeof value !== "string") {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.protocol === "ws:" &&
      url.hostname === "127.0.0.1" &&
      url.port === String(expectedPort) &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      url.pathname.startsWith("/devtools/browser/") &&
      url.pathname !== "/devtools/browser/"
    );
  } catch {
    return false;
  }
}

/**
 * Performs the only browser liveness check used by the launcher. The URL is
 * always constructed from 127.0.0.1 and the validated active port.
 */
export async function probeBrowser(
  port: number,
  timeoutMs: number,
  dependencies: ChromeDependencies = {},
): Promise<BrowserProbe> {
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new AgentBrowserError(
      "DEVTOOLS_PORT_INVALID",
      `Invalid DevTools port: ${port}`,
    );
  }

  const deps = dependenciesWithDefaults(dependencies);
  const httpUrl = `http://127.0.0.1:${port}`;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await deps.fetch(`${httpUrl}/json/version`, {
      signal: controller.signal,
    });
    if (!response.ok) {
      return {
        ok: false,
        port,
        httpUrl,
        error: `HTTP ${response.status} from /json/version`,
      };
    }

    const version = await response.json();
    if (!isBrowserVersionInfo(version)) {
      return {
        ok: false,
        port,
        httpUrl,
        error: "Invalid JSON response from /json/version",
      };
    }

    if (!validBrowserWebSocketUrl(version.webSocketDebuggerUrl, port)) {
      return {
        ok: false,
        port,
        httpUrl,
        version,
        error:
          "/json/version did not return a same-port 127.0.0.1 browser WebSocket URL.",
      };
    }

    return {
      ok: true,
      port,
      httpUrl,
      version,
      webSocketDebuggerUrl: version.webSocketDebuggerUrl,
    };
  } catch (error) {
    return {
      ok: false,
      port,
      httpUrl,
      error: errorMessage(error),
    };
  } finally {
    clearTimeout(timeout);
  }
}

export function chromeLaunchArguments(
  config: BrowserConfig,
  debuggingPort: number,
): string[] {
  if (
    !Number.isInteger(debuggingPort) ||
    debuggingPort < 1 ||
    debuggingPort > 65_535
  ) {
    throw new AgentBrowserError(
      "DEVTOOLS_PORT_INVALID",
      `Invalid DevTools port: ${debuggingPort}`,
    );
  }
  return [
    `--user-data-dir=${config.paths.profileDir}`,
    `--remote-debugging-port=${debuggingPort}`,
    "--remote-debugging-address=127.0.0.1",
    "--no-first-run",
    "--no-default-browser-check",
    // ChromeDriver uses the same testing switch so a fully covered Windows
    // browser keeps rendering and acknowledging automation commands.
    "--disable-backgrounding-occluded-windows",
    "about:blank",
  ];
}

async function probeConfiguredProfile(
  config: BrowserConfig,
  dependencies: ChromeDependencies,
  timeoutMs = Math.min(config.cdpTimeoutMs, 500),
): Promise<
  | {
      activePort: DevToolsActivePort;
      probe: HealthyBrowserProbe;
    }
  | undefined
> {
  let activePort: DevToolsActivePort | undefined;
  try {
    activePort = await readDevToolsActivePort(
      config.paths.profileDir,
      dependencies,
    );
  } catch (error) {
    if (
      !(error instanceof AgentBrowserError) ||
      error.code !== "DEVTOOLS_ACTIVE_PORT_INVALID"
    ) {
      throw error;
    }
    return undefined;
  }
  if (!activePort) {
    return undefined;
  }

  const probe = await probeBrowser(
    activePort.port,
    timeoutMs,
    dependencies,
  );
  if (!probe.ok) {
    return undefined;
  }

  const webSocketUrl = new URL(probe.webSocketDebuggerUrl);
  return webSocketUrl.pathname === activePort.browserWebSocketPath
    ? { activePort, probe }
    : undefined;
}

function launchLockPath(config: BrowserConfig): string {
  // The lock follows the profile rather than AGENT_BROWSER_HOME so two CLI
  // processes cannot bypass it by selecting different state directories for
  // the same user-data directory.
  return path.join(config.paths.profileDir, ".agent-browser-launch.lock");
}

async function tryAcquireLaunchLock(
  config: BrowserConfig,
  dependencies: Required<ChromeDependencies>,
): Promise<boolean> {
  try {
    await dependencies.mkdir(launchLockPath(config), { recursive: false });
    return true;
  } catch (error) {
    if (
      error instanceof Error &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "EEXIST"
    ) {
      return false;
    }
    throw new AgentBrowserError(
      "BROWSER_LAUNCH_LOCK_FAILED",
      `Could not create browser launch lock: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

async function releaseLaunchLock(
  config: BrowserConfig,
  dependencies: Required<ChromeDependencies>,
): Promise<void> {
  try {
    await dependencies.rmdir(launchLockPath(config));
  } catch (error) {
    throw new AgentBrowserError(
      "BROWSER_LAUNCH_LOCK_RELEASE_FAILED",
      `Could not release browser launch lock: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

async function waitForLockedBrowser(
  config: BrowserConfig,
  dependencies: Required<ChromeDependencies>,
): Promise<EnsuredBrowser> {
  const deadline = dependencies.now() + config.launchTimeoutMs;
  do {
    const running = await probeConfiguredProfile(config, dependencies);
    if (running) {
      return {
        port: running.activePort.port,
        webSocketDebuggerUrl: running.probe.webSocketDebuggerUrl,
        launched: false,
        executablePath: config.executablePath,
        profileDir: config.paths.profileDir,
      };
    }
    const remainingMs = deadline - dependencies.now();
    if (remainingMs <= 0) {
      break;
    }
    await dependencies.sleep(Math.min(100, remainingMs));
  } while (dependencies.now() <= deadline);

  throw new AgentBrowserError(
    "BROWSER_LAUNCH_LOCKED",
    `A launch lock was observed at ${launchLockPath(config)}, but no healthy browser appeared within ${config.launchTimeoutMs}ms. Stale locks are never removed automatically; inspect it before manual removal.`,
  );
}

/**
 * Reuses a healthy browser for the dedicated profile or launches one detached.
 * It does not delete or rewrite profile data, even when the active-port marker
 * is stale.
 */
export async function ensureBrowser(
  config: BrowserConfig,
  dependencies: ChromeDependencies = {},
): Promise<EnsuredBrowser> {
  const deps = dependenciesWithDefaults(dependencies);
  const existing = await probeConfiguredProfile(config, deps);
  if (existing) {
    return {
      port: existing.activePort.port,
      webSocketDebuggerUrl: existing.probe.webSocketDebuggerUrl,
      launched: false,
      executablePath: config.executablePath,
      profileDir: config.paths.profileDir,
    };
  }

  try {
    await deps.access(config.executablePath, fsConstants.F_OK);
  } catch (error) {
    throw new AgentBrowserError(
      "BROWSER_EXECUTABLE_NOT_FOUND",
      `Browser executable is not accessible: ${config.executablePath}`,
      { cause: error },
    );
  }

  await deps.mkdir(config.paths.profileDir, { recursive: true });
  await deps.mkdir(config.paths.stateDir, { recursive: true });

  const ownsLaunchLock = await tryAcquireLaunchLock(config, deps);
  if (!ownsLaunchLock) {
    return waitForLockedBrowser(config, deps);
  }

  let browserOperationFailed = false;
  let browserOperationError: unknown;
  try {
    const afterLock = await probeConfiguredProfile(config, deps);
    if (afterLock) {
      return {
        port: afterLock.activePort.port,
        webSocketDebuggerUrl: afterLock.probe.webSocketDebuggerUrl,
        launched: false,
        executablePath: config.executablePath,
        profileDir: config.paths.profileDir,
      };
    }

    let debuggingPort: number;
    try {
      debuggingPort = await deps.allocatePort();
    } catch (error) {
      throw new AgentBrowserError(
        "DEVTOOLS_PORT_ALLOCATION_FAILED",
        `Could not allocate a loopback DevTools port: ${errorMessage(error)}`,
        { cause: error },
      );
    }

    let launchError: Error | undefined;
    const child = deps.spawn(
      config.executablePath,
      chromeLaunchArguments(config, debuggingPort),
      {
        detached: true,
        stdio: "ignore",
        windowsHide: false,
      },
    );
    child.once("error", (error) => {
      launchError = error;
    });
    child.unref();

    const pid = child.pid;
    if (pid !== undefined) {
      // This is the detached process returned by spawn, not a claim about
      // Chrome's eventual long-lived broker process.
      await deps.writeFile(config.paths.browserPidFile, `${pid}\n`, "utf8");
    }

    const deadline = deps.now() + config.launchTimeoutMs;
    do {
      if (launchError) {
        throw new AgentBrowserError(
          "BROWSER_LAUNCH_FAILED",
          `Browser launch failed: ${launchError.message}`,
          { cause: launchError },
        );
      }

      const probe = await probeBrowser(
        debuggingPort,
        Math.min(config.cdpTimeoutMs, 500),
        deps,
      );
      if (probe.ok) {
        const browserWebSocketPath = new URL(
          probe.webSocketDebuggerUrl,
        ).pathname;
        // Chrome only writes DevToolsActivePort when it chooses port 0.
        // Persist the equivalent marker after an explicit-port launch so
        // later processes can validate and reuse this exact endpoint.
        await deps.writeFile(
          devToolsActivePortFile(config.paths.profileDir),
          `${debuggingPort}\n${browserWebSocketPath}\n`,
          "utf8",
        );
        return {
          port: debuggingPort,
          webSocketDebuggerUrl: probe.webSocketDebuggerUrl,
          launched: true,
          ...(pid === undefined ? {} : { pid }),
          executablePath: config.executablePath,
          profileDir: config.paths.profileDir,
        };
      }

      const remainingMs = deadline - deps.now();
      if (remainingMs <= 0) {
        break;
      }
      await deps.sleep(Math.min(100, remainingMs));
    } while (deps.now() <= deadline);

    throw new AgentBrowserError(
      "BROWSER_LAUNCH_TIMEOUT",
      `Browser did not expose /json/version within ${config.launchTimeoutMs}ms. The profile may already be open in a browser without remote debugging.`,
    );
  } catch (error) {
    browserOperationFailed = true;
    browserOperationError = error;
    throw error;
  } finally {
    try {
      await releaseLaunchLock(config, deps);
    } catch (releaseError) {
      if (browserOperationFailed) {
        throw new AgentBrowserError(
          "BROWSER_OPERATION_AND_LOCK_RELEASE_FAILED",
          "The browser operation failed and its launch lock could not be released.",
          {
            cause: new AggregateError([
              browserOperationError,
              releaseError,
            ]),
          },
        );
      }
      throw releaseError;
    }
  }
}

async function pathExists(
  filePath: string,
  dependencies: ChromeDependencies,
): Promise<boolean> {
  const deps = dependenciesWithDefaults(dependencies);
  try {
    await deps.access(filePath, fsConstants.F_OK);
    return true;
  } catch (error) {
    if (isMissingFileError(error)) return false;
    throw new AgentBrowserError(
      "PATH_CHECK_FAILED",
      `Could not inspect ${JSON.stringify(filePath)}: ${errorMessage(error)}`,
      { cause: error },
    );
  }
}

async function readRecordedPid(
  pidFile: string,
  dependencies: ChromeDependencies,
): Promise<number | undefined> {
  const deps = dependenciesWithDefaults(dependencies);
  try {
    const pid = parsePositiveInteger(
      (await deps.readFile(pidFile, "utf8")).trim(),
    );
    return pid;
  } catch (error) {
    if (isMissingFileError(error)) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Returns read-only diagnostics. It never creates directories, launches a
 * process, or changes profile/state files.
 */
export async function doctorBrowser(
  config: BrowserConfig,
  dependencies: ChromeDependencies = {},
): Promise<BrowserDoctorInfo> {
  const executableExists = await pathExists(
    config.executablePath,
    dependencies,
  );
  const profileExists = await pathExists(config.paths.profileDir, dependencies);
  const recordedLaunchPid = await readRecordedPid(
    config.paths.browserPidFile,
    dependencies,
  );
  const base: BrowserDoctorInfo = {
    executablePath: config.executablePath,
    executableExists,
    profileDir: config.paths.profileDir,
    profileExists,
    devToolsActivePortFile: devToolsActivePortFile(config.paths.profileDir),
    browserPidFile: config.paths.browserPidFile,
    launchLockPath: launchLockPath(config),
    ...(recordedLaunchPid === undefined ? {} : { recordedLaunchPid }),
    healthy: false,
  };

  let activePort: DevToolsActivePort | undefined;
  try {
    activePort = await readDevToolsActivePort(
      config.paths.profileDir,
      dependencies,
    );
  } catch (error) {
    return { ...base, error: errorMessage(error) };
  }
  if (!activePort) {
    return base;
  }

  const probe = await probeBrowser(
    activePort.port,
    config.cdpTimeoutMs,
    dependencies,
  );
  const version = probe.version;
  const webSocketPathMatches =
    probe.ok &&
    new URL(probe.webSocketDebuggerUrl).pathname ===
      activePort.browserWebSocketPath;
  const healthy = probe.ok && webSocketPathMatches;
  return {
    ...base,
    port: activePort.port,
    browserWebSocketPath: activePort.browserWebSocketPath,
    healthy,
    ...(typeof version?.Browser === "string"
      ? { browser: version.Browser }
      : {}),
    ...(typeof version?.["Protocol-Version"] === "string"
      ? { protocolVersion: version["Protocol-Version"] }
      : {}),
    ...(healthy
      ? { webSocketDebuggerUrl: probe.webSocketDebuggerUrl }
      : {}),
    ...(!probe.ok
      ? { error: probe.error }
      : !webSocketPathMatches
        ? {
            error:
              "DevToolsActivePort and /json/version identify different browser endpoints.",
          }
        : {}),
  };
}
