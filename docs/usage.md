# Usage guide

Detailed reference for Windows Agent Browser. Start with the
[README](../README.md) for the overview and quick start; the full helper API is
in [`skills/agent-browser-windows/references/api.md`](../skills/agent-browser-windows/references/api.md).

- [Requirements](#requirements)
- [Install](#install)
- [Calling the Windows runtime from WSL](#calling-the-windows-runtime-from-wsl)
- [Launch and diagnose](#launch-and-diagnose)
- [Run one JavaScript program](#run-one-javascript-program)
- [Inspect unfamiliar controls; batch known steps](#inspect-unfamiliar-controls-batch-known-steps)
- [Wait for the transition you actually trigger](#wait-for-the-transition-you-actually-trigger)
- [Tabs, evaluation, and screenshots](#tabs-evaluation-and-screenshots)
- [Raw CDP](#raw-cdp)
- [Environment variables and contexts](#environment-variables-and-contexts)
- [Limitations](#limitations)
- [Occlusion smoke test](#occlusion-smoke-test)

## Requirements

- Windows 10 or Windows 11
- Windows Node.js 22 or newer
- Google Chrome or Microsoft Edge
- PowerShell, Command Prompt, or a Bash environment such as Git Bash

Windows 11 25H2 uses the same launcher and CDP path as Windows 10; there is no
Windows-version gate. On Windows PowerShell 5.1, set
`$OutputEncoding = [System.Text.UTF8Encoding]::new($false)` before piping
non-ASCII JavaScript to the CLI. WSL's quoted heredoc already preserves UTF-8.

The launcher must run under **Windows Node.js**. Running `dist/bin.js` with
Linux Node inside WSL resolves Linux executables and paths and is not a
supported way to control Windows Chrome. Use the WSL bridge instead.

## Install

`scripts/install.ps1` verifies Windows Node.js 22+, finds `npm.cmd`, installs
the checkout globally, and installs the Agent Skill for native Windows Claude
Code and Codex. It does not copy or inspect the default Chrome profile. Pass
`-SkipAgentSkills` when an administrator will deploy the skill separately.

Manual development workflow:

```powershell
npm install
npm run check
npm link
```

`npm link` places `agent-browser` on your npm command path. If PowerShell
blocks npm-generated `.ps1` shims, invoke `agent-browser.cmd` instead. You can
always run the built CLI directly with `node .\dist\bin.js --help`.

The project is distributed as source; a signed Windows installer is not part of
the MVP.

## Calling the Windows runtime from WSL

Install from Windows PowerShell first so `agent-browser.cmd` is on the Windows
`PATH`, then install the Codex WSL skill and bridge:

```bash
bash scripts/install-wsl.sh
```

The installed `~/.local/bin/agent-browser` wrapper crosses into the Windows
runtime. It preserves standard input and safe arguments, and forwards
`AGENT_BROWSER_CONTEXT`, `AGENT_BROWSER_CHROME`, `AGENT_BROWSER_HOME`, and
`AGENT_BROWSER_PROFILE` through `WSLENV`.

```bash
AGENT_BROWSER_CONTEXT=codex-wsl agent-browser --doctor
AGENT_BROWSER_CONTEXT=codex-wsl agent-browser launch
```

- Executable, home, and profile overrides must be Windows-style paths because
  Windows Node consumes them; the wrapper does not translate them. Do not pass
  `/mnt/c/...` paths.
- `AGENT_BROWSER_WINDOWS_CMD` selects another installed Windows command, for
  example `C:\Users\name\AppData\Roaming\npm\agent-browser.cmd`.
- Arguments containing `cmd.exe` metacharacters are rejected rather than
  reinterpreted.
- The wrapper is transport convenience, not a sandbox: the program still runs
  with the Windows user's Node.js permissions. It does not transcode stdin;
  error text produced by `cmd.exe` itself may use the Windows code page.

## Launch and diagnose

```powershell
$env:AGENT_BROWSER_CONTEXT = "codex"
agent-browser.cmd --doctor   # read-only; reports executable, profile, connection
agent-browser.cmd launch     # start or reuse the dedicated visible browser
agent-browser.cmd --doctor   # verify the connection
```

Before the first launch, `--doctor` can report `healthy: false` and exit with
status 1 because there is no debugging endpoint yet.

**Debugging port.** The launcher reserves an explicit nonzero loopback port. Do
not change it to `--remote-debugging-port=0`: Chromium treats port `0` as an
automation request and exposes `navigator.webdriver === true`. The launcher
does not add `--enable-automation`, headless mode, or scripts that falsify
browser properties. This removes Chrome's universal WebDriver signal; it does
not promise an undetectable browser.

**Profile.** The first launch creates a separate profile; sign in to the sites
you need inside that window. Do not point `AGENT_BROWSER_PROFILE` at Chrome's
`User Data` directory or any daily-use profile. The launcher rejects the common
Chrome and Edge `User Data` locations as a guardrail. Copying the daily profile
does not migrate logins: since Chrome 136 a non-standard user-data directory
uses a different encryption key (see Chrome's
[remote-debugging security change](https://developer.chrome.com/blog/remote-debugging-port)).

**Launch lock.** Concurrent launches are serialized with
`<profile>\.agent-browser-launch.lock`. If `BROWSER_LAUNCH_LOCKED` persists,
use `--doctor` to find the lock and verify no launch is in progress. The
launcher never guesses that a lock is stale.

**Browser not found.** Set the executable explicitly:

```powershell
$env:AGENT_BROWSER_CHROME = "C:\Program Files\Google\Chrome\Application\chrome.exe"
agent-browser.cmd launch
```

## Run one JavaScript program

The CLI injects four helpers: `browser` (tabs), `page` (selected tab), `cdp`
(raw Chrome DevTools Protocol), and `sleep`.

Each stdin program is compiled with Node's `AsyncFunction`. It can access
`process`, `import()` modules such as `node:fs` and `node:child_process`, and
do anything the Windows user can. Only run code you trust.

PowerShell here-string:

```powershell
@'
const tab = await browser.open("https://example.com");
console.log({ targetId: tab.targetId });
console.log(await page.snapshot());
'@ | agent-browser.cmd
```

Bash heredoc — the quotes around `JS` matter. `<<'JS'` preserves backslashes
byte for byte; unquoted `<<JS` performs shell expansion and can rewrite
regexes, template literals, and `\\`:

```bash
agent-browser <<'JS'
console.log(await page.snapshot());
JS
```

If a transport still mangles a complex program, feed a file instead:

```bash
agent-browser < script.js
```

```powershell
$OutputEncoding = [System.Text.UTF8Encoding]::new($false)
Get-Content -LiteralPath .\script.js -Raw -Encoding UTF8 | agent-browser.cmd
```

## Inspect unfamiliar controls; batch known steps

The whole program is submitted before it runs, so the model cannot read a
snapshot and rewrite later statements in the same invocation. When controls are
unfamiliar:

1. Run a discovery command that prints the tab's `targetId` and
   `page.snapshot()`.
2. Let the agent read the output and pick an actual `@N`.
3. Run a second command with the same `AGENT_BROWSER_CONTEXT`, call
   `browser.use(targetId)`, then use that ref.

```bash
AGENT_BROWSER_CONTEXT=codex-wsl agent-browser <<'JS'
await browser.use("TARGET_ID_FROM_PREVIOUS_OUTPUT");
await page.fill("@4", "agent-friendly browsers");
await page.press("Enter", { waitForNavigation: true, timeoutMs: 20_000 });
console.log(await page.snapshot());
JS
```

`@4` is only an example: pick refs from the real snapshot and refresh it after
DOM-changing actions. Steps whose targets and outcomes are already known can be
batched, and `page.waitForAny()` lets a script branch between known outcomes
without another model round trip. See
[`adaptive-execution.md`](adaptive-execution.md) for where that boundary lies.

## Wait for the transition you actually trigger

Mouse and keyboard helpers call CDP `Page.bringToFront` before dispatching
input, which restores a minimized managed window. The launcher also passes
`--disable-backgrounding-occluded-windows`, so a fully covered browser keeps
rendering and acknowledging input even when Windows foreground policy stops it
from being raised. The switch applies only when the browser process starts:
after upgrading, close the Agent Browser window once and run `launch` again. A
covered page may use more CPU/GPU than stock Chrome, and input can take focus
from the user, so do not automate while the user is controlling that browser.

New document:

```js
await page.click("@12", { waitForNavigation: true, timeoutMs: 20_000 });
```

Same-document SPA routing:

```js
await page.click("@12");
await page.waitForURL(/\/results(?:[/?#]|$)/, { timeoutMs: 20_000 });
```

Finite set of known outcomes:

```js
const outcome = await page.waitForAny([
  { name: "results", url: /\/results(?:[/?#]|$)/ },
  { name: "inline", selector: "[data-results]", state: "visible" },
  { name: "error", selector: "[role=alert]", state: "visible" }
]);
```

`page.waitForLoadState()` only checks whether the current document reaches
`readyState === "complete"`. It does not wait for a future navigation; after an
untracked click it can return before the navigation begins.

## Tabs, evaluation, and screenshots

```js
const tabs = await browser.tabs();
const target = tabs.find((tab) => tab.url.includes("example.com"));
if (target) await browser.use(target.targetId);

console.log(await page.evaluate(() => ({ title: document.title, url: location.href })));
console.log(await page.screenshot({ path: "artifacts/example.png", fullPage: true }));
```

Without `path`, `screenshot()` returns base64, which may be large.

## Raw CDP

```js
console.log(await cdp("Browser.getVersion", {}, { browser: true }));
```

Use the page helpers when they cover the operation and raw CDP for missing
capabilities such as scrolling or frame interaction. CDP and `evaluate` follow
the same task authorization as other tools; neither is limited to read-only
work. Do not extract credentials or unrelated profile data.

## Environment variables and contexts

| Variable | Purpose |
| --- | --- |
| `AGENT_BROWSER_CONTEXT` | Per-agent active-tab/ref state; use distinct values such as `codex` and `claude` |
| `AGENT_BROWSER_CHROME` | Explicit Chrome or Edge executable path |
| `AGENT_BROWSER_HOME` | Root for managed state; default `%LOCALAPPDATA%\agent-browser` |
| `AGENT_BROWSER_PROFILE` | Dedicated profile; default `%AGENT_BROWSER_HOME%\profile` |
| `AGENT_BROWSER_WINDOWS_CMD` | WSL-wrapper command override; default `agent-browser.cmd` |

Paths may contain spaces. Context state lives under
`%AGENT_BROWSER_HOME%\state\<context>`. Context names are 1–64 characters of
letters, digits, dots, underscores, or hyphens, normalized to lowercase;
omitting the variable uses `default`.

Contexts separate only the active tab and latest refs between invocations.
Agents still share tabs, cookies, storage, and logins. Use separate dedicated
profiles when real isolation is required.

## Limitations

- **Use only the dedicated Agent Browser profile.** No profile import is
  performed.
- No task Spaces yet: scripts share one profile, cookies, storage, and tabs, so
  concurrent agents can interfere with each other.
- Snapshots use the AX tree exposed through stock CDP. Coverage of
  out-of-process iframes, sandboxed cross-origin frames, canvas, browser UI,
  extension UI, and OS dialogs is not guaranteed. Iframe content that appears is
  read-only: controls inside an iframe do not get `@N` refs. Screenshot-based
  coordinate clicks and raw CDP remain available; browser chrome and native
  dialogs need a native browser or Computer Use tool.
- `@N` refs are short-lived; re-snapshot after navigation or page changes.
- No bypass of CAPTCHA, passkeys, Windows Hello, payment approval, anti-bot
  systems, or browser security controls. Hand those steps to the user.
- Stdin JavaScript is trusted local code and is **not sandboxed**.

## Occlusion smoke test

This opt-in test briefly places a full-screen topmost window over the browser
and verifies that a CDP click still lands:

```powershell
Get-Content -LiteralPath .\test\fixtures\windows-smoke-occluded-click.js -Raw |
  agent-browser.cmd
```

Run it only on a disposable desktop session. The cover closes after eight
seconds, and the test does not call `SetForegroundWindow`.
