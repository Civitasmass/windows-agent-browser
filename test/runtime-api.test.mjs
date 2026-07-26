import assert from "node:assert/strict";
import {
  mkdtemp,
  readFile,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { createAgentApi } from "../dist/api.js";
import { AgentBrowserError } from "../dist/errors.js";
import { BrowserRuntime } from "../dist/runtime.js";

function target(targetId, url = `https://${targetId}.example.test/`) {
  return {
    targetId,
    type: "page",
    title: targetId,
    url,
  };
}

async function testConfig(t) {
  const appDir = await mkdtemp(join(tmpdir(), "windows-agent-browser-"));
  t.after(() => rm(appDir, { recursive: true, force: true }));
  const stateDir = join(appDir, "state");
  return {
    executablePath: "C:\\fake\\chrome.exe",
    paths: {
      appDir,
      profileDir: join(appDir, "profile"),
      stateDir,
      activeTargetFile: join(stateDir, "active-target.json"),
      refsFile: join(stateDir, "refs.json"),
      browserPidFile: join(stateDir, "browser.pid"),
    },
    launchTimeoutMs: 1_000,
    cdpTimeoutMs: 250,
  };
}

class FakeCdpClient {
  calls = [];
  closed = false;
  nextTarget = 1;
  evaluateResponse = { result: { value: null } };
  listeners = new Map();

  constructor(targets = []) {
    this.targets = [...targets];
  }

  async send(method, params = {}, sessionId) {
    this.calls.push({ method, params, sessionId });
    switch (method) {
      case "Target.setDiscoverTargets":
      case "Target.activateTarget":
      case "Page.enable":
      case "Page.bringToFront":
      case "Runtime.enable":
      case "DOM.enable":
      case "Page.getFrameTree":
      case "DOM.getDocument":
        return {};
      case "Target.getTargets":
        return { targetInfos: this.targets.map((entry) => ({ ...entry })) };
      case "Target.createTarget": {
        let targetId;
        do {
          targetId = `opened-${this.nextTarget}`;
          this.nextTarget += 1;
        } while (this.targets.some((entry) => entry.targetId === targetId));
        this.targets.push(target(targetId, params.url));
        return { targetId };
      }
      case "Target.attachToTarget":
        return { sessionId: `session-${params.targetId}` };
      case "Target.closeTarget": {
        const index = this.targets.findIndex(
          (entry) => entry.targetId === params.targetId,
        );
        if (index === -1) return { success: false };
        this.targets.splice(index, 1);
        return { success: true };
      }
      case "Page.navigate": {
        const targetId = sessionId?.startsWith("session-")
          ? sessionId.slice("session-".length)
          : undefined;
        const page = this.targets.find(
          (entry) => entry.targetId === targetId,
        );
        if (page) page.url = params.url;
        return { loaderId: `loader-${targetId}` };
      }
      case "Runtime.evaluate":
        return typeof this.evaluateResponse === "function"
          ? this.evaluateResponse(params, sessionId)
          : this.evaluateResponse;
      default:
        throw new Error(`Unexpected CDP method: ${method}`);
    }
  }

  on(method, listener) {
    const listeners = this.listeners.get(method) ?? new Set();
    listeners.add(listener);
    this.listeners.set(method, listeners);
    return () => listeners.delete(listener);
  }

  close() {
    this.closed = true;
  }
}

test("multiple tabs without an explicit active target fail closed", async (t) => {
  const config = await testConfig(t);
  const client = new FakeCdpClient([target("one"), target("two")]);
  const runtime = new BrowserRuntime(client, config);

  await runtime.initialize();
  await assert.rejects(runtime.current(), (error) => {
    assert.ok(error instanceof AgentBrowserError);
    assert.match(error.message, /active|multiple|select|browser\.use/iu);
    return true;
  });

  assert.equal(
    client.calls.some((call) => call.method === "Target.activateTarget"),
    false,
  );
});

test("use persists the active target across runtime instances", async (t) => {
  const config = await testConfig(t);
  const firstClient = new FakeCdpClient([target("one"), target("two")]);
  const first = new BrowserRuntime(firstClient, config);
  await first.initialize();

  assert.deepEqual(await first.use("one"), {
    targetId: "one",
    title: "one",
    url: "https://one.example.test/",
  });
  assert.deepEqual(
    JSON.parse(await readFile(config.paths.activeTargetFile, "utf8")),
    { version: 1, targetId: "one" },
  );
  const activationMethods = firstClient.calls
    .filter((call) =>
      ["Target.activateTarget", "Page.bringToFront"].includes(
        call.method,
      ),
    )
    .map((call) => call.method);
  assert.deepEqual(activationMethods, [
    "Target.activateTarget",
    "Page.bringToFront",
  ]);
  assert.equal(
    firstClient.calls.find(
      (call) => call.method === "Page.bringToFront",
    )?.sessionId,
    "session-one",
  );

  const secondClient = new FakeCdpClient([target("one"), target("two")]);
  const second = new BrowserRuntime(secondClient, config);
  await second.initialize();
  assert.equal((await second.current()).targetId, "one");
  assert.equal(
    secondClient.calls.some(
      (call) => call.method === "Target.activateTarget",
    ),
    false,
  );
});

test("open, use, and close maintain an unambiguous active tab", async (t) => {
  const config = await testConfig(t);
  const client = new FakeCdpClient([target("original")]);
  const runtime = new BrowserRuntime(client, config);
  await runtime.initialize();

  const opened = await runtime.open("https://opened.example.test/", {
    wait: false,
  });
  assert.equal(opened.targetId, "opened-1");
  assert.equal(opened.url, "https://opened.example.test/");
  assert.deepEqual(
    JSON.parse(await readFile(config.paths.activeTargetFile, "utf8")),
    { version: 1, targetId: "opened-1" },
  );
  assert.equal(
    client.calls.filter(
      (call) =>
        call.method === "Target.attachToTarget" &&
        call.params.targetId === "opened-1",
    ).length,
    1,
  );

  assert.equal((await runtime.use("original")).targetId, "original");
  assert.equal(await runtime.close(), "original");
  assert.equal((await runtime.current()).targetId, "opened-1");
  assert.deepEqual(
    JSON.parse(await readFile(config.paths.activeTargetFile, "utf8")),
    { version: 1, targetId: "opened-1" },
  );
});

test("concurrent first page commands share one attached session", async (t) => {
  const config = await testConfig(t);
  const client = new FakeCdpClient([target("only")]);
  const runtime = new BrowserRuntime(client, config);
  await runtime.initialize();
  client.calls.length = 0;

  await Promise.all([
    runtime.sendPage("Page.getFrameTree"),
    runtime.sendPage("DOM.getDocument"),
  ]);

  const attaches = client.calls.filter(
    (call) => call.method === "Target.attachToTarget",
  );
  assert.equal(attaches.length, 1);
  assert.deepEqual(attaches[0].params, {
    targetId: "only",
    flatten: true,
  });
  for (const method of ["Page.enable", "Runtime.enable", "DOM.enable"]) {
    assert.equal(
      client.calls.filter((call) => call.method === method).length,
      1,
      `${method} should only be sent once`,
    );
  }
  const pageCommands = client.calls.filter((call) =>
    ["Page.getFrameTree", "DOM.getDocument"].includes(call.method),
  );
  assert.equal(pageCommands.length, 2);
  assert.deepEqual(
    new Set(pageCommands.map((call) => call.sessionId)),
    new Set(["session-only"]),
  );
});

class FakeApiRuntime {
  calls = [];
  targetId = "target-a";
  url = "https://form.example.test/";
  title = "Form";
  loaderId = "loader-a";
  rootBackendNodeId = 10;
  selectorBackendNodeId = 77;

  constructor(config) {
    this.config = config;
    this.client = {
      send: async (method, params, sessionId) => {
        this.calls.push({ method, params, sessionId });
        return {};
      },
    };
  }

  async context() {
    return {
      targetId: this.targetId,
      sessionId: `session-${this.targetId}`,
      target: {
        targetId: this.targetId,
        title: this.title,
        url: this.url,
      },
    };
  }

  async evaluate(expression) {
    this.calls.push({ method: "runtime.evaluate", expression });
    return {
      url: this.url,
      title: this.title,
      width: 1_280,
      height: 720,
      scrollX: 0,
      scrollY: 0,
      pageWidth: 1_280,
      pageHeight: 1_200,
    };
  }

  async sendPage(method, params = {}) {
    this.calls.push({ method, params });
    switch (method) {
      case "Accessibility.getFullAXTree":
        return {
          nodes: [
            {
              nodeId: "root",
              role: { value: "RootWebArea" },
              name: { value: this.title },
              backendDOMNodeId: this.rootBackendNodeId,
              frameId: "frame-a",
              childIds: ["button"],
            },
            {
              nodeId: "button",
              role: { value: "button" },
              name: { value: "Submit" },
              backendDOMNodeId: 42,
            },
          ],
        };
      case "DOM.getDocument":
        return { root: { backendNodeId: this.rootBackendNodeId } };
      case "Page.getFrameTree":
        return {
          frameTree: {
            frame: { id: "frame-a", loaderId: this.loaderId },
          },
        };
      case "Runtime.evaluate":
        return {
          result: {
            objectId: "object-for-selector",
            type: "object",
          },
        };
      case "DOM.describeNode":
        return { node: { backendNodeId: this.selectorBackendNodeId } };
      case "DOM.scrollIntoViewIfNeeded":
      case "DOM.focus":
      case "DOM.setFileInputFiles":
      case "Emulation.setDeviceMetricsOverride":
      case "Input.dispatchMouseEvent":
      case "Input.dispatchKeyEvent":
      case "Input.insertText":
        return {};
      case "DOM.getBoxModel":
        return {
          model: {
            content: [10, 20, 30, 20, 30, 40, 10, 40],
          },
        };
      default:
        throw new Error(`Unexpected page method: ${method}`);
    }
  }

  async sendBrowser(method, params = {}) {
    this.calls.push({ method, params, browser: true });
    return {};
  }

  async bringToFront() {
    this.calls.push({ method: "Page.bringToFront" });
  }

  async waitForLoadState() {}
}

test("snapshot persists one document identity on its metadata and refs", async (t) => {
  const config = await testConfig(t);
  const runtime = new FakeApiRuntime(config);
  const { page } = createAgentApi(runtime);

  const content = await page.snapshot();
  assert.match(content, /button @1 "Submit"/u);

  const persisted = JSON.parse(
    await readFile(config.paths.refsFile, "utf8"),
  );
  assert.equal(persisted.targetId, "target-a");
  assert.equal(persisted.url, "https://form.example.test/");
  assert.equal(persisted.documentId, "loader-a:backend-node:10");
  assert.equal(persisted.refs.length, 1);
  assert.equal(
    persisted.refs[0].documentId,
    "loader-a:backend-node:10",
  );
});

test("a ref is rejected after the active document changes", async (t) => {
  const config = await testConfig(t);
  const runtime = new FakeApiRuntime(config);
  const { page } = createAgentApi(runtime);
  await page.snapshot();

  runtime.loaderId = "loader-b";
  await assert.rejects(
    page.click("@1"),
    (error) =>
      error instanceof AgentBrowserError &&
      error.code === "STALE_REF_DOCUMENT",
  );
  assert.equal(
    runtime.calls.some((call) => call.method === "DOM.getBoxModel"),
    false,
  );
  assert.equal(
    runtime.calls.some((call) => call.method === "Input.dispatchMouseEvent"),
    false,
  );
});

test("CSS click resolves a node and dispatches events at its box center", async (t) => {
  const config = await testConfig(t);
  const runtime = new FakeApiRuntime(config);
  const { page } = createAgentApi(runtime);

  await page.click("loc=css:#submit");

  const selectorEvaluation = runtime.calls.find(
    (call) => call.method === "Runtime.evaluate",
  );
  assert.match(selectorEvaluation.params.expression, /#submit/u);
  assert.deepEqual(
    runtime.calls.find((call) => call.method === "DOM.describeNode")?.params,
    { objectId: "object-for-selector" },
  );
  const mouse = runtime.calls.filter(
    (call) => call.method === "Input.dispatchMouseEvent",
  );
  assert.ok(
    runtime.calls.findIndex(
      (call) => call.method === "Page.bringToFront",
    ) <
      runtime.calls.findIndex(
        (call) => call.method === "Input.dispatchMouseEvent",
      ),
    "the page must be brought forward before mouse input",
  );
  assert.deepEqual(
    mouse.map((call) => ({
      type: call.params.type,
      x: call.params.x,
      y: call.params.y,
    })),
    [
      { type: "mouseMoved", x: 20, y: 30 },
      { type: "mousePressed", x: 20, y: 30 },
      { type: "mouseReleased", x: 20, y: 30 },
    ],
  );
});

test("navigation-waiting click releases the mouse before awaiting a new document", async (t) => {
  const config = await testConfig(t);
  class NavigationRuntime extends FakeApiRuntime {
    async sendPage(method, params = {}) {
      const result = await super.sendPage(method, params);
      if (
        method === "Input.dispatchMouseEvent" &&
        params.type === "mouseReleased"
      ) {
        this.loaderId = "loader-after-click";
      }
      return result;
    }
  }
  const runtime = new NavigationRuntime(config);
  const { page } = createAgentApi(runtime);

  await page.click([12, 34], {
    waitForNavigation: true,
    timeoutMs: 300,
  });

  assert.deepEqual(
    runtime.calls
      .filter((call) => call.method === "Input.dispatchMouseEvent")
      .map((call) => call.params.type),
    ["mouseMoved", "mousePressed", "mouseReleased"],
  );
  assert.equal(runtime.loaderId, "loader-after-click");
});

test("coordinate clicks reject non-finite values before sending input", async (t) => {
  const config = await testConfig(t);
  const runtime = new FakeApiRuntime(config);
  const { page } = createAgentApi(runtime);

  for (const point of [[Number.NaN, 1], { x: 1, y: Infinity }]) {
    await assert.rejects(
      page.click(point),
      (error) =>
        error instanceof AgentBrowserError &&
        error.code === "INVALID_CLICK_POINT",
    );
  }
  assert.equal(
    runtime.calls.some((call) => call.method === "Input.dispatchMouseEvent"),
    false,
  );
});

test("fill focuses, replaces text, and press emits a Windows key combo", async (t) => {
  const config = await testConfig(t);
  const runtime = new FakeApiRuntime(config);
  const { page } = createAgentApi(runtime);

  await page.fill("#email", "alice@example.test");
  await page.press("Control+Enter");

  assert.deepEqual(
    runtime.calls.find((call) => call.method === "DOM.focus")?.params,
    { backendNodeId: 77 },
  );
  assert.deepEqual(
    runtime.calls
      .filter((call) => call.method === "Input.insertText")
      .map((call) => call.params.text),
    ["alice@example.test"],
  );

  const keys = runtime.calls
    .filter((call) => call.method === "Input.dispatchKeyEvent")
    .map((call) => call.params);
  assert.equal(
    runtime.calls.filter(
      (call) => call.method === "Page.bringToFront",
    ).length,
    2,
    "fill and the separate public press should each foreground once",
  );
  assert.equal(keys.length, 6);
  assert.deepEqual(
    keys.slice(0, 2).map(({ type, key, modifiers, commands }) => ({
      type,
      key,
      modifiers,
      commands,
    })),
    [
      {
        type: "keyDown",
        key: "a",
        modifiers: 2,
        commands: ["selectAll"],
      },
      {
        type: "keyUp",
        key: "a",
        modifiers: 2,
        commands: undefined,
      },
    ],
  );
  assert.deepEqual(
    keys.slice(-2).map(
      ({ type, key, code, modifiers, windowsVirtualKeyCode }) => ({
        type,
        key,
        code,
        modifiers,
        windowsVirtualKeyCode,
      }),
    ),
    [
      {
        type: "keyDown",
        key: "Enter",
        code: "Enter",
        modifiers: 2,
        windowsVirtualKeyCode: 13,
      },
      {
        type: "keyUp",
        key: "Enter",
        code: "Enter",
        modifiers: 2,
        windowsVirtualKeyCode: 13,
      },
    ],
  );
});

test("setInputFiles validates local files and assigns them through CDP", async (t) => {
  const config = await testConfig(t);
  const runtime = new FakeApiRuntime(config);
  const { page } = createAgentApi(runtime);
  const attachment = join(config.paths.appDir, "attachment.txt");
  await writeFile(attachment, "benchmark fixture\n", "utf8");

  await page.setInputFiles("#attachment", attachment);

  assert.deepEqual(
    runtime.calls.find(
      (call) => call.method === "DOM.setFileInputFiles",
    )?.params,
    {
      files: [attachment],
      backendNodeId: 77,
    },
  );
  await assert.rejects(
    page.setInputFiles("#attachment", []),
    (error) =>
      error instanceof AgentBrowserError &&
      error.code === "UPLOAD_FILES_EMPTY",
  );
  await assert.rejects(
    page.setInputFiles("#attachment", 42),
    (error) =>
      error instanceof AgentBrowserError &&
      error.code === "UPLOAD_FILE_INVALID",
  );
  await assert.rejects(
    page.setInputFiles("#attachment", join(config.paths.appDir, "missing.txt")),
    (error) =>
      error instanceof AgentBrowserError &&
      error.code === "UPLOAD_FILE_UNAVAILABLE",
  );
});

test("setViewport applies deterministic device metrics and validates dimensions", async (t) => {
  const config = await testConfig(t);
  const runtime = new FakeApiRuntime(config);
  const { page } = createAgentApi(runtime);

  await page.setViewport({
    width: 390,
    height: 844,
    deviceScaleFactor: 2,
    mobile: true,
  });

  assert.deepEqual(
    runtime.calls.find(
      (call) => call.method === "Emulation.setDeviceMetricsOverride",
    )?.params,
    {
      width: 390,
      height: 844,
      deviceScaleFactor: 2,
      mobile: true,
    },
  );
  await assert.rejects(
    page.setViewport({ width: 0, height: 844 }),
    (error) =>
      error instanceof AgentBrowserError &&
      error.code === "INVALID_VIEWPORT",
  );
});

test("waitForAny polls all known outcomes in one page evaluation", async (t) => {
  const config = await testConfig(t);
  class WaitRuntime extends FakeApiRuntime {
    polls = 0;

    async evaluate(expression) {
      if (expression.includes("const conditions =")) {
        this.calls.push({ method: "runtime.evaluate", expression });
        this.polls += 1;
        return this.polls === 1
          ? null
          : {
              name: "inline-results",
              index: 1,
              url: "https://form.example.test/results",
            };
      }
      return super.evaluate(expression);
    }
  }
  const runtime = new WaitRuntime(config);
  const { page } = createAgentApi(runtime);

  const outcome = await page.waitForAny(
    [
      { name: "redirect", url: /\/search(?:[/?#]|$)/u },
      {
        name: "inline-results",
        selector: "[data-results]",
        state: "visible",
        text: "Complete",
      },
      { name: "error", selector: "[role=alert]" },
    ],
    { timeoutMs: 200, pollMs: 1 },
  );

  assert.deepEqual(outcome, {
    name: "inline-results",
    index: 1,
    url: "https://form.example.test/results",
  });
  assert.equal(runtime.polls, 2);
  const expression = runtime.calls.find(
    (call) =>
      call.method === "runtime.evaluate" &&
      call.expression.includes("const conditions ="),
  ).expression;
  assert.match(expression, /inline-results/u);
  assert.match(expression, /data-results/u);
  assert.match(expression, /regexp/u);

  await assert.rejects(
    page.waitForAny([{ name: "invalid", state: "visible" }]),
    (error) =>
      error instanceof AgentBrowserError &&
      error.code === "WAIT_CONDITION_INVALID",
  );
  await assert.rejects(
    page.waitForAny([{ name: 7, url: "/results" }]),
    (error) =>
      error instanceof AgentBrowserError &&
      error.code === "WAIT_CONDITION_INVALID",
  );
});

test("page JavaScript exceptions surface as a typed evaluation failure", async (t) => {
  const config = await testConfig(t);
  const client = new FakeCdpClient([target("only")]);
  client.evaluateResponse = {
    result: {
      type: "object",
      subtype: "error",
      description: "Error: exploded",
    },
    exceptionDetails: {
      text: "Uncaught",
      exception: { description: "Error: exploded\n    at <anonymous>:1:1" },
    },
  };
  const runtime = new BrowserRuntime(client, config);
  await runtime.initialize();

  await assert.rejects(runtime.evaluate("throw new Error('exploded')"), (error) => {
    assert.ok(error instanceof AgentBrowserError);
    assert.equal(error.code, "PAGE_EVALUATION_FAILED");
    assert.match(error.message, /Error: exploded/u);
    return true;
  });
});
