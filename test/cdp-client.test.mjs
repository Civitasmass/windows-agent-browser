import assert from "node:assert/strict";
import test from "node:test";

import {
  CdpClient,
  CdpConnectionError,
  CdpProtocolError,
  CdpTimeoutError,
} from "../dist/cdp/client.js";

class FakeWebSocket {
  readyState = 0;
  binaryType = "blob";
  sent = [];
  closeArguments = undefined;
  #listeners = new Map();

  addEventListener(type, listener) {
    let listeners = this.#listeners.get(type);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(type, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(type, listener) {
    this.#listeners.get(type)?.delete(listener);
  }

  send(data) {
    if (this.readyState !== 1) throw new Error("socket is not open");
    this.sent.push(data);
    this.onSend?.(JSON.parse(data));
  }

  close(code = 1000, reason = "") {
    if (this.readyState >= 2) return;
    this.readyState = 2;
    this.closeArguments = [code, reason];
    this.emitClose(code, reason);
  }

  open() {
    this.readyState = 1;
    this.#emit("open", new Event("open"));
  }

  emitMessage(payload) {
    this.#emit(
      "message",
      new MessageEvent("message", {
        data: typeof payload === "string" ? payload : JSON.stringify(payload),
      }),
    );
  }

  emitError() {
    this.#emit("error", new Event("error"));
  }

  emitClose(code = 1006, reason = "") {
    this.readyState = 3;
    this.#emit("close", { type: "close", code, reason });
  }

  listenerCount(type) {
    return this.#listeners.get(type)?.size ?? 0;
  }

  #emit(type, event) {
    for (const listener of [...(this.#listeners.get(type) ?? [])]) {
      listener(event);
    }
  }
}

function clientHarness(options = {}) {
  const sockets = [];
  const client = new CdpClient({
    defaultTimeoutMs: 100,
    connectTimeoutMs: 100,
    ...options,
    webSocketFactory(url) {
      const socket = new FakeWebSocket();
      socket.url = url;
      sockets.push(socket);
      return socket;
    },
  });
  return { client, sockets };
}

async function connectHarness(options) {
  const harness = clientHarness(options);
  const connecting = harness.client.connect("ws://127.0.0.1:9222/devtools/browser/1");
  harness.sockets[0].open();
  await connecting;
  return harness;
}

test("connect is idempotent for one URL and rejects a different endpoint", async () => {
  const { client, sockets } = clientHarness();
  const first = client.connect("ws://127.0.0.1:9222/devtools/browser/1");
  const second = client.connect("ws://127.0.0.1:9222/devtools/browser/1");

  assert.strictEqual(first, second);
  assert.equal(sockets.length, 1);
  assert.equal(sockets[0].binaryType, "arraybuffer");
  sockets[0].open();
  await first;
  await client.connect("ws://127.0.0.1:9222/devtools/browser/1");

  await assert.rejects(
    client.connect("ws://127.0.0.1:9333/devtools/browser/2"),
    (error) =>
      error instanceof CdpConnectionError &&
      error.message.includes("already bound"),
  );
  client.close();
});

test("send uses a flattened sessionId envelope and resolves its result", async () => {
  const { client, sockets } = await connectHarness();
  const socket = sockets[0];
  socket.onSend = (request) => {
    assert.deepEqual(request, {
      id: 1,
      method: "Runtime.evaluate",
      params: { expression: "6 * 7" },
      sessionId: "session-1",
    });
    socket.emitMessage({
      id: request.id,
      result: { result: { type: "number", value: 42 } },
      sessionId: "session-1",
    });
  };

  const result = await client.send(
    "Runtime.evaluate",
    { expression: "6 * 7" },
    "session-1",
  );
  assert.equal(result.result.value, 42);
  client.close();
});

test("send preserves CDP protocol error details", async () => {
  const { client, sockets } = await connectHarness();
  sockets[0].onSend = ({ id }) => {
    sockets[0].emitMessage({
      id,
      error: {
        code: -32000,
        message: "No target with given id",
        data: "target-7",
      },
    });
  };

  await assert.rejects(
    client.send("Target.attachToTarget", { targetId: "target-7" }),
    (error) => {
      assert.ok(error instanceof CdpProtocolError);
      assert.equal(error.code, "CDP_PROTOCOL_ERROR");
      assert.equal(error.cdpCode, -32000);
      assert.equal(error.method, "Target.attachToTarget");
      assert.equal(error.data, "target-7");
      return true;
    },
  );
  client.close();
});

test("send rejects on timeout and ignores a late response", async () => {
  const { client, sockets } = await connectHarness();

  await assert.rejects(
    client.send("Page.navigate", { url: "https://example.test" }, undefined, 10),
    (error) =>
      error instanceof CdpTimeoutError &&
      error.operation === "Page.navigate" &&
      error.timeoutMs === 10,
  );

  sockets[0].emitMessage({ id: 1, result: { late: true } });
  sockets[0].onSend = ({ id }) =>
    sockets[0].emitMessage({ id, result: { ok: true } });
  assert.deepEqual(await client.send("Browser.getVersion"), { ok: true });
  client.close();
});

test("on, once, and waitForEvent preserve flattened session events", async () => {
  const { client, sockets } = await connectHarness();
  const socket = sockets[0];
  const seen = [];
  const unsubscribe = client.on("Runtime.consoleAPICalled", (event) => {
    seen.push(event.params.value);
  });
  let onceCount = 0;
  client.once("Runtime.consoleAPICalled", () => {
    onceCount += 1;
  });

  const waiting = client.waitForEvent("Runtime.consoleAPICalled", {
    sessionId: "wanted",
    predicate: (event) => event.params.value === 2,
  });
  socket.emitMessage({
    method: "Runtime.consoleAPICalled",
    params: { value: 1 },
    sessionId: "other",
  });
  socket.emitMessage({
    method: "Runtime.consoleAPICalled",
    params: { value: 1 },
    sessionId: "wanted",
  });
  socket.emitMessage({
    method: "Runtime.consoleAPICalled",
    params: { value: 2 },
    sessionId: "wanted",
  });

  const event = await waiting;
  assert.equal(event.sessionId, "wanted");
  assert.equal(event.params.value, 2);
  assert.deepEqual(seen, [1, 1, 2]);
  assert.equal(onceCount, 1);

  unsubscribe();
  socket.emitMessage({
    method: "Runtime.consoleAPICalled",
    params: { value: 3 },
  });
  assert.deepEqual(seen, [1, 1, 2]);
  client.close();
});

test("waitForEvent removes its subscription after timeout", async () => {
  const { client, sockets } = await connectHarness();
  const socket = sockets[0];
  let predicateCalls = 0;

  await assert.rejects(
    client.waitForEvent("Page.loadEventFired", {
      timeoutMs: 10,
      predicate: () => {
        predicateCalls += 1;
        return true;
      },
    }),
    (error) =>
      error instanceof CdpTimeoutError &&
      error.operation === "event Page.loadEventFired",
  );
  assert.equal(socket.listenerCount("message"), 1);

  // No stale event listener should run after the timeout.
  socket.emitMessage({
    method: "Page.loadEventFired",
    params: { timestamp: 1 },
  });
  await Promise.resolve();
  assert.equal(predicateCalls, 0);
  client.close();
});

test("close rejects pending commands and event waits and is final", async () => {
  const { client, sockets } = await connectHarness();
  const pending = client.send("Page.captureScreenshot");
  let predicateCalls = 0;
  const waiting = client.waitForEvent("Page.screencastFrame", {
    predicate: () => {
      predicateCalls += 1;
      return true;
    },
  });

  client.close();

  await assert.rejects(pending, CdpConnectionError);
  await assert.rejects(waiting, CdpConnectionError);
  assert.deepEqual(sockets[0].closeArguments, [1000, "Client closed"]);
  await assert.rejects(
    client.connect("ws://127.0.0.1:9222/devtools/browser/1"),
    /closed CDP client/,
  );
  sockets[0].emitMessage({ method: "Page.screencastFrame", params: {} });
  await Promise.resolve();
  assert.equal(predicateCalls, 0);
  assert.equal(client.connected, false);
});

test("unexpected WebSocket close rejects outstanding work", async () => {
  const { client, sockets } = await connectHarness();
  const pending = client.send("Network.getAllCookies");
  const waiting = client.waitForEvent("Network.loadingFinished");

  sockets[0].emitClose(1006, "transport lost");

  await assert.rejects(
    pending,
    (error) =>
      error instanceof CdpConnectionError &&
      error.message.includes("transport lost"),
  );
  await assert.rejects(waiting, CdpConnectionError);
  await assert.rejects(
    client.connect("ws://127.0.0.1:9222/devtools/browser/1"),
    /transport lost/,
  );
  assert.equal(client.connected, false);
});

test("WebSocket error terminates the client and closes the transport", async () => {
  const { client, sockets } = await connectHarness();
  const pending = client.send("Browser.getVersion");

  sockets[0].emitError();

  await assert.rejects(pending, /WebSocket error/);
  assert.equal(client.connected, false);
  assert.deepEqual(sockets[0].closeArguments, [1011, "CDP protocol error"]);
  await assert.rejects(
    client.send("Browser.getVersion"),
    /WebSocket error/,
  );
});

test("waitForEvent rejects before connect instead of leaking a waiter", async () => {
  const { client } = clientHarness();
  await assert.rejects(
    client.waitForEvent("Page.loadEventFired"),
    /before the CDP client is connected/,
  );
});
