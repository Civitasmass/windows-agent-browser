import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";

import { AgentBrowserError } from "./errors.js";
import type { BrowserConfig, BrowserPaths } from "./types.js";

const DEFAULT_LAUNCH_TIMEOUT_MS = 20_000;
const DEFAULT_CDP_TIMEOUT_MS = 5_000;
const CONTEXT_NAME_PATTERN =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,62}[A-Za-z0-9_-])?$/u;
const WINDOWS_RESERVED_NAME =
  /^(?:CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)/iu;

export interface ConfigDependencies {
  env?: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  homeDir?: string;
  fileExists?: (filePath: string) => boolean;
}

function environmentValue(
  env: Readonly<Record<string, string | undefined>>,
  ...names: string[]
): string | undefined {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) {
      return value;
    }
  }
  return undefined;
}

function pathApi(platform: NodeJS.Platform): path.PlatformPath {
  return platform === "win32" ? path.win32 : path.posix;
}

function uniquePaths(paths: string[], platform: NodeJS.Platform): string[] {
  const seen = new Set<string>();
  return paths.filter((candidate) => {
    const key = platform === "win32" ? candidate.toLowerCase() : candidate;
    if (seen.has(key)) {
      return false;
    }
    seen.add(key);
    return true;
  });
}

/**
 * Returns browser executable candidates in preference order. On Windows all
 * Chrome locations are considered before Edge so Edge remains an explicit
 * compatibility fallback.
 */
export function browserExecutableCandidates(
  dependencies: ConfigDependencies = {},
): string[] {
  const env = dependencies.env ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const paths = pathApi(platform);

  if (platform === "win32") {
    const programFiles = environmentValue(env, "PROGRAMFILES", "ProgramFiles");
    const programFilesX86 = environmentValue(
      env,
      "PROGRAMFILES(X86)",
      "ProgramFiles(x86)",
    );
    const localAppData = environmentValue(env, "LOCALAPPDATA", "LocalAppData");
    const roots = [programFiles, programFilesX86, localAppData].filter(
      (value): value is string => value !== undefined,
    );

    return uniquePaths(
      [
        ...roots.map((root) =>
          paths.join(root, "Google", "Chrome", "Application", "chrome.exe"),
        ),
        ...roots.map((root) =>
          paths.join(root, "Microsoft", "Edge", "Application", "msedge.exe"),
        ),
      ],
      platform,
    );
  }

  if (platform === "darwin") {
    return [
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
      "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
    ];
  }

  return [
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/usr/bin/microsoft-edge",
    "/usr/bin/microsoft-edge-stable",
  ];
}

/**
 * Resolves the configured browser binary without consulting the registry or
 * launching subprocesses. AGENT_BROWSER_CHROME always wins.
 */
export function findBrowserExecutable(
  dependencies: ConfigDependencies = {},
): string {
  const env = dependencies.env ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const fileExists = dependencies.fileExists ?? existsSync;
  const explicit = environmentValue(env, "AGENT_BROWSER_CHROME");

  if (explicit) {
    if (!fileExists(explicit)) {
      throw new AgentBrowserError(
        "BROWSER_EXECUTABLE_NOT_FOUND",
        `AGENT_BROWSER_CHROME does not exist: ${explicit}`,
      );
    }
    return explicit;
  }

  const executablePath = browserExecutableCandidates({
    env,
    platform,
  }).find(fileExists);
  if (executablePath) {
    return executablePath;
  }

  throw new AgentBrowserError(
    "BROWSER_EXECUTABLE_NOT_FOUND",
    "Could not find Google Chrome or Microsoft Edge. Set AGENT_BROWSER_CHROME to the browser executable.",
  );
}

/**
 * Resolves the dedicated agent profile and state paths. These paths never
 * point at Chrome's normal user-data directory unless the user explicitly
 * overrides AGENT_BROWSER_PROFILE.
 */
export function resolveBrowserPaths(
  dependencies: ConfigDependencies = {},
): BrowserPaths {
  const env = dependencies.env ?? process.env;
  const platform = dependencies.platform ?? process.platform;
  const paths = pathApi(platform);
  const homeDir = dependencies.homeDir ?? homedir();
  const localAppData = environmentValue(
    env,
    "LOCALAPPDATA",
    "LocalAppData",
  );
  const defaultAppDir =
    platform === "win32" && localAppData
      ? paths.join(localAppData, "agent-browser")
      : paths.join(homeDir, ".agent-browser");
  const appDir = paths.resolve(
    environmentValue(env, "AGENT_BROWSER_HOME") ?? defaultAppDir,
  );
  const profileDir = paths.resolve(
    environmentValue(env, "AGENT_BROWSER_PROFILE") ??
      paths.join(appDir, "profile"),
  );
  if (platform === "win32" && localAppData) {
    const normalizedProfile = paths.normalize(profileDir).toLowerCase();
    const normalBrowserProfiles = [
      paths.join(localAppData, "Google", "Chrome", "User Data"),
      paths.join(localAppData, "Google", "Chrome Beta", "User Data"),
      paths.join(localAppData, "Google", "Chrome Dev", "User Data"),
      paths.join(localAppData, "Google", "Chrome SxS", "User Data"),
      paths.join(localAppData, "Microsoft", "Edge", "User Data"),
      paths.join(localAppData, "Microsoft", "Edge Beta", "User Data"),
      paths.join(localAppData, "Microsoft", "Edge Dev", "User Data"),
      paths.join(localAppData, "Microsoft", "Edge SxS", "User Data"),
    ].map((candidate) => paths.normalize(candidate).toLowerCase());
    const unsafeProfile = normalBrowserProfiles.find(
      (candidate) =>
        normalizedProfile === candidate ||
        normalizedProfile.startsWith(`${candidate}${paths.sep}`),
    );
    if (unsafeProfile) {
      throw new AgentBrowserError(
        "DEFAULT_BROWSER_PROFILE_REJECTED",
        "The agent browser requires a dedicated profile. AGENT_BROWSER_PROFILE must not point at the normal Chrome or Edge User Data directory.",
      );
    }
  }
  const stateDir = paths.join(
    appDir,
    "state",
    resolveContextName(dependencies),
  );

  return {
    appDir,
    profileDir,
    stateDir,
    activeTargetFile: paths.join(stateDir, "active-target.json"),
    refsFile: paths.join(stateDir, "refs.json"),
    browserPidFile: paths.join(stateDir, "browser.pid"),
  };
}

export function resolveContextName(
  dependencies: ConfigDependencies = {},
): string {
  const env = dependencies.env ?? process.env;
  const contextName =
    environmentValue(env, "AGENT_BROWSER_CONTEXT") ?? "default";
  if (
    !CONTEXT_NAME_PATTERN.test(contextName) ||
    WINDOWS_RESERVED_NAME.test(contextName)
  ) {
    throw new AgentBrowserError(
      "INVALID_AGENT_CONTEXT",
      "AGENT_BROWSER_CONTEXT must be a safe 1-64 character Windows path segment using letters, digits, dots, underscores, or hyphens.",
    );
  }
  return contextName.toLowerCase();
}

export function resolveConfig(
  dependencies: ConfigDependencies = {},
): BrowserConfig {
  return {
    executablePath: findBrowserExecutable(dependencies),
    paths: resolveBrowserPaths(dependencies),
    contextName: resolveContextName(dependencies),
    launchTimeoutMs: DEFAULT_LAUNCH_TIMEOUT_MS,
    cdpTimeoutMs: DEFAULT_CDP_TIMEOUT_MS,
  };
}

export const loadConfig = resolveConfig;
