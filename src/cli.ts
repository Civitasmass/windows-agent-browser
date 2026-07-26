import { readFile } from "node:fs/promises";
import { stdin as input } from "node:process";

import { doctorBrowser, ensureBrowser } from "./chrome.js";
import { resolveConfig } from "./config.js";
import { AgentBrowserError } from "./errors.js";
import { executeScript } from "./executor.js";

export const HELP = `Windows Agent Browser

Usage:
  agent-browser <<'JS'
  await browser.open('https://example.com')
  console.log(await page.snapshot())
  JS

  agent-browser nodejs <<'JS'   Alias for stdin script execution
  agent-browser launch          Start or reuse the dedicated browser
  agent-browser --doctor        Inspect configuration and connection state
  agent-browser --help

Environment:
  AGENT_BROWSER_CHROME          Chrome/Edge executable path
  AGENT_BROWSER_HOME            App state directory
  AGENT_BROWSER_PROFILE         Dedicated Chrome profile directory
  AGENT_BROWSER_CONTEXT         Isolate state per agent (for example codex)
`;

interface Writable {
  write(text: string): unknown;
}

export interface CliOptions {
  stdinText?: string;
  stdout?: Writable;
  stderr?: Writable;
}

export async function main(
  argv = process.argv.slice(2),
  options: CliOptions = {},
): Promise<number> {
  const stdout = options.stdout ?? process.stdout;
  const stderr = options.stderr ?? process.stderr;
  if (argv.includes("-h") || argv.includes("--help")) {
    stdout.write(HELP);
    return 0;
  }

  if (argv[0] === "--doctor" || argv[0] === "doctor") {
    let config: ReturnType<typeof resolveConfig>;
    try {
      config = resolveConfig();
    } catch (error) {
      if (error instanceof AgentBrowserError) {
        stdout.write(
          `${JSON.stringify(
            {
              healthy: false,
              errorCode: error.code,
              error: error.message,
            },
            null,
            2,
          )}\n`,
        );
        return 1;
      }
      throw error;
    }
    const report = await doctorBrowser(config);
    stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return report.healthy ? 0 : 1;
  }
  if (argv[0] === "launch") {
    const config = resolveConfig();
    const browser = await ensureBrowser(config);
    stdout.write(
      `${JSON.stringify(
        {
          ready: true,
          launched: browser.launched,
          executablePath: browser.executablePath,
          profileDir: browser.profileDir,
          context: config.contextName,
          port: browser.port,
        },
        null,
        2,
      )}\n`,
    );
    return 0;
  }
  if (argv[0] === "--version" || argv[0] === "-v") {
    const packageJson = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { version?: string };
    stdout.write(`${packageJson.version ?? "unknown"}\n`);
    return 0;
  }
  if (argv[0] === "nodejs") argv.shift();
  if (argv.length > 0) {
    stderr.write(`Unknown argument: ${argv[0]}\n\n${HELP}`);
    return 2;
  }

  const code =
    options.stdinText === undefined
      ? await readStdin()
      : options.stdinText;
  if (!code.trim()) {
    stderr.write(HELP);
    return 2;
  }
  const config = resolveConfig();
  await executeScript(code, { config });
  return 0;
}

async function readStdin(): Promise<string> {
  let code = "";
  input.setEncoding("utf8");
  for await (const chunk of input) code += chunk;
  return code;
}
