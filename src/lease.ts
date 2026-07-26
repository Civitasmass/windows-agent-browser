import { createHash } from "node:crypto";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AgentBrowserError, errorMessage } from "./errors.js";
import type { BrowserConfig } from "./types.js";

export interface ContextLease {
  address: string;
  release(): Promise<void>;
}

export interface ContextLeaseDependencies {
  bind?: (address: string) => Promise<() => Promise<void>>;
}

export function contextLeaseAddress(
  config: BrowserConfig,
  platform: NodeJS.Platform = process.platform,
): string {
  const profileIdentity =
    platform === "win32"
      ? config.paths.profileDir.toLowerCase()
      : config.paths.profileDir;
  const identity = `${profileIdentity}\0${config.contextName}`;
  const digest = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 24);
  return platform === "win32"
    ? `\\\\.\\pipe\\windows-agent-browser-${digest}`
    : join(tmpdir(), `windows-agent-browser-${digest}.sock`);
}

/**
 * Hold an OS-owned endpoint for one script invocation. Unlike a lock file,
 * Windows releases a named pipe automatically if the process crashes.
 */
export async function acquireContextLease(
  config: BrowserConfig,
  dependencies: ContextLeaseDependencies = {},
): Promise<ContextLease> {
  const address = contextLeaseAddress(config);
  const bind = dependencies.bind ?? bindLeaseEndpoint;
  let releaseEndpoint: () => Promise<void>;
  try {
    releaseEndpoint = await bind(address);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EADDRINUSE") {
      throw new AgentBrowserError(
        "AGENT_CONTEXT_BUSY",
        `Another agent-browser program is already using context ${JSON.stringify(config.contextName)}. Wait for it to finish or use a different AGENT_BROWSER_CONTEXT.`,
        { cause: error },
      );
    }
    throw new AgentBrowserError(
      "AGENT_CONTEXT_LOCK_FAILED",
      `Could not acquire the agent context lease: ${errorMessage(error)}`,
      { cause: error },
    );
  }
  let released = false;
  return {
    address,
    async release() {
      if (released) return;
      released = true;
      await releaseEndpoint();
    },
  };
}

async function bindLeaseEndpoint(
  address: string,
): Promise<() => Promise<void>> {
  const server = createServer((socket) => socket.destroy());
  server.unref();
  await listen(server, address);
  return () => close(server);
}

function listen(server: Server, address: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error) => {
      server.off("listening", onListening);
      reject(error);
    };
    const onListening = () => {
      server.off("error", onError);
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(address);
  });
}

function close(server: Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}
