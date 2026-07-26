#!/usr/bin/env node

import { main } from "./cli.js";
import { AgentBrowserError, errorMessage } from "./errors.js";

void main()
  .then((code) => {
    process.exitCode = code;
  })
  .catch((error: unknown) => {
    if (error instanceof AgentBrowserError) {
      process.stderr.write(`${error.code}: ${error.message}\n`);
    } else {
      process.stderr.write(
        `AGENT_BROWSER_FAILED: ${errorMessage(error)}\n`,
      );
    }
    process.exitCode = 1;
  });
