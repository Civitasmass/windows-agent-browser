import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import {
  acquireContextLease,
  contextLeaseAddress,
} from "../dist/lease.js";

function config(root, contextName = "codex") {
  return {
    executablePath: "chrome",
    contextName,
    launchTimeoutMs: 100,
    cdpTimeoutMs: 100,
    paths: {
      appDir: root,
      profileDir: join(root, "profile"),
      stateDir: join(root, "state", contextName),
      activeTargetFile: join(root, "state", contextName, "active.json"),
      refsFile: join(root, "state", contextName, "refs.json"),
      browserPidFile: join(root, "state", contextName, "browser.pid"),
    },
  };
}

test("context lease prevents overlapping programs and releases cleanly", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-browser-lease-"));
  const held = new Set();
  const dependencies = {
    async bind(address) {
      if (held.has(address)) {
        throw Object.assign(new Error("in use"), { code: "EADDRINUSE" });
      }
      held.add(address);
      return async () => {
        held.delete(address);
      };
    },
  };
  const first = await acquireContextLease(config(root), dependencies);
  await assert.rejects(
    acquireContextLease(config(root), dependencies),
    (error) => error.code === "AGENT_CONTEXT_BUSY",
  );
  await first.release();
  const second = await acquireContextLease(config(root), dependencies);
  await second.release();
});

test("context lease separates named agent contexts", async () => {
  const root = await mkdtemp(join(tmpdir(), "agent-browser-lease-"));
  const codex = config(root, "codex");
  const claude = config(root, "claude");
  assert.notEqual(contextLeaseAddress(codex), contextLeaseAddress(claude));
  assert.match(
    contextLeaseAddress(codex, "win32"),
    /^\\\\\.\\pipe\\windows-agent-browser-[a-f0-9]{24}$/u,
  );
});
