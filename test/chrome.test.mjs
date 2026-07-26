import assert from "node:assert/strict";
import test from "node:test";

import {
  findBrowserExecutable,
  resolveConfig,
} from "../dist/config.js";
import {
  chromeLaunchArguments,
  doctorBrowser,
  ensureBrowser,
  probeBrowser,
  readDevToolsActivePort,
} from "../dist/chrome.js";

function missingFile(filePath) {
  return Object.assign(new Error(`ENOENT: ${filePath}`), { code: "ENOENT" });
}

function testConfig(overrides = {}) {
  return {
    executablePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    paths: {
      appDir: "C:\\Users\\alice\\AppData\\Local\\agent-browser",
      profileDir:
        "C:\\Users\\alice\\AppData\\Local\\agent-browser\\profile",
      stateDir: "C:\\Users\\alice\\AppData\\Local\\agent-browser\\state",
      activeTargetFile:
        "C:\\Users\\alice\\AppData\\Local\\agent-browser\\state\\active-target.json",
      refsFile:
        "C:\\Users\\alice\\AppData\\Local\\agent-browser\\state\\refs.json",
      browserPidFile:
        "C:\\Users\\alice\\AppData\\Local\\agent-browser\\state\\browser.pid",
    },
    launchTimeoutMs: 1_000,
    cdpTimeoutMs: 250,
    ...overrides,
  };
}

test("Chrome candidates are preferred over Edge on Windows", () => {
  const chrome =
    "C:\\Users\\alice\\AppData\\Local\\Google\\Chrome\\Application\\chrome.exe";
  const edge =
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe";
  const existing = new Set([edge.toLowerCase(), chrome.toLowerCase()]);

  assert.equal(
    findBrowserExecutable({
      platform: "win32",
      env: {
        PROGRAMFILES: "C:\\Program Files",
        "PROGRAMFILES(X86)": "C:\\Program Files (x86)",
        LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
      },
      fileExists: (candidate) => existing.has(candidate.toLowerCase()),
    }),
    chrome,
  );
});

test("config honors browser, home, and dedicated profile overrides", () => {
  const config = resolveConfig({
    platform: "win32",
    homeDir: "C:\\Users\\alice",
    env: {
      AGENT_BROWSER_CHROME: "D:\\Apps\\Chrome\\chrome.exe",
      AGENT_BROWSER_HOME: "D:\\AgentBrowser",
      AGENT_BROWSER_PROFILE: "E:\\Profiles\\coding-agent",
      AGENT_BROWSER_CONTEXT: "codex",
      LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
    },
    fileExists: (candidate) =>
      candidate === "D:\\Apps\\Chrome\\chrome.exe",
  });

  assert.equal(config.executablePath, "D:\\Apps\\Chrome\\chrome.exe");
  assert.equal(config.paths.appDir, "D:\\AgentBrowser");
  assert.equal(config.paths.profileDir, "E:\\Profiles\\coding-agent");
  assert.equal(config.contextName, "codex");
  assert.equal(config.paths.stateDir, "D:\\AgentBrowser\\state\\codex");
  assert.notEqual(
    config.paths.profileDir,
    "C:\\Users\\alice\\AppData\\Local\\Google\\Chrome\\User Data",
  );
});

test("config rejects normal Chrome and Edge user-data directories", () => {
  for (const profile of [
    "C:\\Users\\alice\\AppData\\Local\\Google\\Chrome\\User Data\\Default",
    "C:\\Users\\alice\\AppData\\Local\\Google\\Chrome SxS\\User Data",
    "C:\\Users\\alice\\AppData\\Local\\Microsoft\\Edge Beta\\User Data\\Profile 1",
  ]) {
    assert.throws(
      () =>
        resolveConfig({
          platform: "win32",
          env: {
            AGENT_BROWSER_CHROME: "D:\\Apps\\Chrome\\chrome.exe",
            AGENT_BROWSER_PROFILE: profile,
            LOCALAPPDATA: "C:\\Users\\alice\\AppData\\Local",
          },
          fileExists: () => true,
        }),
      (error) => error.code === "DEFAULT_BROWSER_PROFILE_REJECTED",
    );
  }
});

test("agent contexts are case-normalized and reject Windows path aliases", () => {
  const base = {
    platform: "win32",
    env: {
      AGENT_BROWSER_CHROME: "D:\\Apps\\Chrome\\chrome.exe",
      AGENT_BROWSER_CONTEXT: "CoDeX.Team-1",
    },
    fileExists: () => true,
  };
  assert.equal(resolveConfig(base).contextName, "codex.team-1");

  for (const context of ["CON", "nul.json", "codex.", "../escape"]) {
    assert.throws(
      () =>
        resolveConfig({
          ...base,
          env: { ...base.env, AGENT_BROWSER_CONTEXT: context },
        }),
      (error) => error.code === "INVALID_AGENT_CONTEXT",
    );
  }
});

test("DevToolsActivePort parser accepts CRLF and validates its port", async () => {
  assert.deepEqual(
    await readDevToolsActivePort("C:\\profile", {
      readFile: async () => "43123\r\n/devtools/browser/abc\r\n",
    }),
    {
      port: 43_123,
      browserWebSocketPath: "/devtools/browser/abc",
    },
  );

  await assert.rejects(
    readDevToolsActivePort("C:\\profile", {
      readFile: async () => "70000\n/devtools/browser/abc\n",
    }),
    (error) => error.code === "DEVTOOLS_ACTIVE_PORT_INVALID",
  );
  await assert.rejects(
    readDevToolsActivePort("C:\\profile", {
      readFile: async () => "43123\n",
    }),
    (error) => error.code === "DEVTOOLS_ACTIVE_PORT_INVALID",
  );
});

test("health probe only requests the loopback /json/version endpoint", async () => {
  let requestedUrl;
  const result = await probeBrowser(43_123, 100, {
    fetch: async (url) => {
      requestedUrl = url;
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Browser: "Chrome/150",
          webSocketDebuggerUrl:
            "ws://127.0.0.1:43123/devtools/browser/abc",
        }),
      };
    },
  });

  assert.equal(requestedUrl, "http://127.0.0.1:43123/json/version");
  assert.equal(result.ok, true);
  assert.equal(
    result.webSocketDebuggerUrl,
    "ws://127.0.0.1:43123/devtools/browser/abc",
  );
});

test("health probe rejects non-loopback or wrong-port WebSocket URLs", async () => {
  for (const webSocketDebuggerUrl of [
    "ws://example.com:43123/devtools/browser/abc",
    "ws://127.0.0.1:49999/devtools/browser/abc",
    "ws://127.0.0.1:43123/devtools/page/abc",
  ]) {
    const result = await probeBrowser(43_123, 100, {
      fetch: async () => ({
        ok: true,
        status: 200,
        json: async () => ({ webSocketDebuggerUrl }),
      }),
    });
    assert.equal(result.ok, false);
  }
});

test("ensureBrowser reuses a healthy dedicated-profile browser", async () => {
  const config = testConfig();
  let spawnCalled = false;
  const result = await ensureBrowser(config, {
    readFile: async (filePath) => {
      if (filePath.endsWith("DevToolsActivePort")) {
        return "43123\n/devtools/browser/abc\n";
      }
      throw missingFile(filePath);
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        Browser: "Chrome/150",
        webSocketDebuggerUrl:
          "ws://127.0.0.1:43123/devtools/browser/abc",
      }),
    }),
    spawn: () => {
      spawnCalled = true;
      throw new Error("must not launch");
    },
  });

  assert.equal(result.launched, false);
  assert.equal(result.port, 43_123);
  assert.equal(spawnCalled, false);
});

test("ensureBrowser launches detached, records PID, and waits for health", async () => {
  const config = testConfig();
  let clock = 0;
  let browserReady = false;
  let launch;
  const writes = [];
  let unrefCalled = false;

  const result = await ensureBrowser(config, {
    access: async () => {},
    mkdir: async () => undefined,
    rmdir: async () => undefined,
    readFile: async (filePath) => {
      if (filePath.endsWith("DevToolsActivePort") && browserReady) {
        return "45555\n/devtools/browser/launched\n";
      }
      throw missingFile(filePath);
    },
    writeFile: async (filePath, data, encoding) => {
      writes.push({ filePath, data, encoding });
    },
    fetch: async () => {
      if (!browserReady) {
        throw new Error("browser is not ready");
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          Browser: "Chrome/150",
          webSocketDebuggerUrl:
            "ws://127.0.0.1:45555/devtools/browser/launched",
        }),
      };
    },
    allocatePort: async () => 45_555,
    spawn: (executablePath, args, options) => {
      launch = { executablePath, args, options };
      return {
        pid: 4242,
        once: () => undefined,
        unref: () => {
          unrefCalled = true;
        },
      };
    },
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
      browserReady = true;
    },
  });

  assert.equal(result.launched, true);
  assert.equal(result.port, 45_555);
  assert.equal(result.pid, 4242);
  assert.equal(unrefCalled, true);
  assert.deepEqual(launch.options, {
    detached: true,
    stdio: "ignore",
    windowsHide: false,
  });
  assert.ok(
    launch.args.includes(`--user-data-dir=${config.paths.profileDir}`),
  );
  assert.ok(launch.args.includes("--remote-debugging-port=45555"));
  assert.equal(launch.args.includes("--remote-debugging-port=0"), false);
  assert.ok(
    launch.args.includes("--remote-debugging-address=127.0.0.1"),
  );
  assert.equal(launch.args.includes("--no-sandbox"), false);
  assert.equal(launch.args.includes("--disable-web-security"), false);
  assert.deepEqual(
    writes.find(({ filePath }) => filePath === config.paths.browserPidFile),
    {
      filePath: config.paths.browserPidFile,
      data: "4242\n",
      encoding: "utf8",
    },
  );
  const endpointWrite = writes.find(({ filePath }) =>
    filePath.endsWith("DevToolsActivePort"),
  );
  assert.ok(endpointWrite);
  assert.deepEqual(endpointWrite, {
    filePath: endpointWrite.filePath,
    data: "45555\n/devtools/browser/launched\n",
    encoding: "utf8",
  });
});

test("a concurrent launcher waits instead of spawning a second Chrome", async () => {
  const config = testConfig();
  let clock = 0;
  let ready = false;
  let spawnCalled = false;

  const result = await ensureBrowser(config, {
    access: async () => {},
    mkdir: async (directoryPath, options) => {
      if (directoryPath.endsWith("launch.lock") && !options.recursive) {
        throw Object.assign(new Error("exists"), { code: "EEXIST" });
      }
    },
    readFile: async (filePath) => {
      if (ready && filePath.endsWith("DevToolsActivePort")) {
        return "46666\n/devtools/browser/concurrent\n";
      }
      throw missingFile(filePath);
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        Browser: "Chrome/150",
        webSocketDebuggerUrl:
          "ws://127.0.0.1:46666/devtools/browser/concurrent",
      }),
    }),
    spawn: () => {
      spawnCalled = true;
      throw new Error("must not spawn");
    },
    now: () => clock,
    sleep: async (milliseconds) => {
      clock += milliseconds;
      ready = true;
    },
  });

  assert.equal(result.launched, false);
  assert.equal(result.port, 46_666);
  assert.equal(spawnCalled, false);
});

test("launch arguments keep normal security and avoid WebDriver signaling", () => {
  const args = chromeLaunchArguments(testConfig(), 43_123);
  assert.equal(
    args.filter(
      (arg) => arg === "--disable-backgrounding-occluded-windows",
    ).length,
    1,
  );
  assert.equal(args.some((arg) => arg.includes("no-sandbox")), false);
  assert.equal(args.some((arg) => arg.includes("disable-web-security")), false);
  assert.equal(args.some((arg) => arg.includes("ignore-certificate")), false);
  assert.equal(args.includes("--remote-debugging-port=43123"), true);
  assert.equal(args.includes("--remote-debugging-port=0"), false);
  assert.equal(args.includes("--enable-automation"), false);
  assert.equal(args.some((arg) => arg.startsWith("--headless")), false);
  assert.equal(
    args.some((arg) => arg.includes("AutomationControlled")),
    false,
  );

  assert.throws(
    () => chromeLaunchArguments(testConfig(), 0),
    (error) => error.code === "DEVTOOLS_PORT_INVALID",
  );
});

test("doctorBrowser is read-only and reports PID plus browser version", async () => {
  const config = testConfig();
  const accessed = [];
  const doctor = await doctorBrowser(config, {
    access: async (filePath) => {
      accessed.push(filePath);
    },
    readFile: async (filePath) => {
      if (filePath.endsWith("DevToolsActivePort")) {
        return "43123\n/devtools/browser/abc\n";
      }
      if (filePath === config.paths.browserPidFile) {
        return "4242\n";
      }
      throw missingFile(filePath);
    },
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        Browser: "Chrome/150",
        "Protocol-Version": "1.3",
        webSocketDebuggerUrl:
          "ws://127.0.0.1:43123/devtools/browser/abc",
      }),
    }),
    mkdir: async () => {
      throw new Error("doctor must not create directories");
    },
    writeFile: async () => {
      throw new Error("doctor must not write files");
    },
    spawn: () => {
      throw new Error("doctor must not launch");
    },
  });

  assert.equal(doctor.executableExists, true);
  assert.equal(doctor.profileExists, true);
  assert.equal(doctor.recordedLaunchPid, 4242);
  assert.equal(doctor.healthy, true);
  assert.equal(doctor.browser, "Chrome/150");
  assert.equal(doctor.protocolVersion, "1.3");
  assert.deepEqual(accessed, [
    config.executablePath,
    config.paths.profileDir,
  ]);
});
