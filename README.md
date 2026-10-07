<p align="center">
  <img src="https://raw.githubusercontent.com/Civitasmass/windows-agent-browser/main/docs/assets/windows-agent-browser-hero.png" alt="Windows Agent Browser connecting an AI coding agent to a visible browser through structured accessibility data" width="100%">
</p>

<h1 align="center">Windows Agent Browser</h1>

<p align="center">
  <strong>Let Claude Code and Codex drive your real, signed-in Chrome or Edge on Windows.</strong><br>
  Native Windows + WSL · visible persistent browser · compact accessibility snapshots · zero cloud
</p>

<p align="center">
  <a href="https://github.com/Civitasmass/windows-agent-browser/stargazers"><img alt="GitHub stars" src="https://img.shields.io/github/stars/Civitasmass/windows-agent-browser?style=flat&logo=github&color=6366f1"></a>
  <img alt="Windows 10 and 11" src="https://img.shields.io/badge/Windows-10%20%7C%2011-0078D4?logo=windows11&logoColor=white">
  <img alt="Node.js 22 or newer" src="https://img.shields.io/badge/Node.js-22%2B-339933?logo=nodedotjs&logoColor=white">
  <img alt="Zero runtime dependencies" src="https://img.shields.io/badge/runtime%20deps-0-10b981">
  <a href="LICENSE"><img alt="MIT license" src="https://img.shields.io/badge/License-MIT-a78bfa"></a>
</p>

<p align="center">
  <a href="#quick-start">Quick start</a> ·
  <a href="#use-it-from-claude-code-or-codex">Agent setup</a> ·
  <a href="#api-at-a-glance">API</a> ·
  <a href="docs/usage.md">Usage guide</a> ·
  <a href="SECURITY.md">Security</a>
</p>

---

Most agent browser tools are built for Linux, headless Chromium, or a cloud
sandbox. On Windows that usually means fighting WSL paths, losing your logins,
or watching a browser you can't see. **Windows Agent Browser** is a small CLI +
Agent Skill that connects your coding agent straight to a visible Chrome or
Edge window over the Chrome DevTools Protocol.

## Why

- **🪟 Windows-first, WSL-friendly** — runs on Windows Node.js; a bridge lets
  Codex or Claude inside WSL drive the Windows browser without path hacks.
- **🔐 Stay signed in** — a dedicated, persistent profile. Log in once; your
  daily Chrome profile is never read or copied.
- **🧾 Token-cheap page views** — accessibility-tree snapshots with short refs
  like `@7` instead of raw HTML or screenshots.
- **⚡ Fewer round trips** — the agent sends one whole JavaScript program per
  call, so known steps, waits, and branches run in a single turn.
- **🪶 Nothing extra** — no Playwright, Puppeteer, browser extension, or hosted
  service. Zero runtime dependencies.

## Quick start

In Windows PowerShell:

```powershell
git clone https://github.com/Civitasmass/windows-agent-browser.git
cd windows-agent-browser
.\scripts\install.ps1   # installs the winbrowse CLI + Agent Skill for Claude Code and Codex
winbrowse.cmd launch    # opens the dedicated browser; sign in to sites here once
```

Then ask your agent to use it, or try it yourself:

```powershell
@'
await browser.open("https://example.com");
console.log(await page.snapshot());
'@ | winbrowse.cmd
```

```text
page title="Example Domain" url="https://example.com/"
- document @1 "Example Domain" [focused]
  - paragraph
    - text "This domain is for use in documentation examples without needing permission. ..."
  - link @2 "Learn more"
```

Act on a ref in the next call — `await page.click("@2")` — and snapshot again.

> [!TIP]
> From WSL, also run `bash scripts/install-wsl.sh`, then use the same commands
> with a heredoc: `winbrowse <<'JS' ... JS`.
> Requirements: Windows 10/11, Windows Node.js 22+, Chrome or Edge.

## Use it from Claude Code or Codex

The installers put one shared skill,
[`winbrowse`](skills/winbrowse/SKILL.md), where each
agent discovers it:

| Agent | Skill location |
| --- | --- |
| Claude Code on Windows | `%USERPROFILE%\.claude\skills\winbrowse` |
| Codex on Windows | `%USERPROFILE%\.agents\skills\winbrowse` |
| Codex in WSL | `~/.agents/skills/winbrowse` |

Give each agent its own `AGENT_BROWSER_CONTEXT` (e.g. `claude`, `codex`) so
their selected tab and refs don't collide. Then just ask:

> Use Windows Agent Browser to open my GitHub notifications and summarize the
> unread ones. Don't change anything.

The agent still needs permission to run the local CLI. Managed deployment and
custom paths: [`docs/agent-setup.md`](docs/agent-setup.md).

## API at a glance

Each program gets `browser`, `page`, `cdp`, and `sleep`, with top-level `await`.

| | |
| --- | --- |
| **Tabs** | `browser.tabs()` · `browser.open(url)` · `browser.use(targetId)` · `browser.close()` |
| **Read** | `page.snapshot()` · `page.info()` · `page.evaluate(fn)` · `page.screenshot({ path })` |
| **Act** | `page.click("@3")` · `page.fill("@4", text)` · `page.type()` · `page.press("Enter")` · `page.setInputFiles()` |
| **Wait** | `page.waitForURL()` · `page.waitForAny([...])` · `{ waitForNavigation: true }` on click/press |
| **Escape hatch** | `cdp("Domain.method", params)` — raw Chrome DevTools Protocol |

Full reference: [`references/api.md`](skills/winbrowse/references/api.md) ·
patterns and pitfalls: [`docs/usage.md`](docs/usage.md).

## How it works

```text
agent ──JS on stdin──▶ winbrowse (Windows Node.js)
                            │  local CDP WebSocket
                            ▼
                  visible Chrome / Edge  +  dedicated profile
                            │
                            └─ accessibility snapshot ──▶ @N ──▶ DOM node
```

## Good to know

- `@N` refs expire on navigation or page changes — snapshot again.
- Controls inside iframes, canvas, browser UI, and OS dialogs may not get refs;
  coordinate clicks and raw CDP still work.
- Agents share one profile and its tabs. Contexts keep their bookkeeping apart
  but are **not** an isolation boundary.
- CAPTCHA, passkeys, Windows Hello, and payment approval are handed back to you.
- Stdin JavaScript runs with your full Windows user permissions — it is **not
  sandboxed**. Only run code you trust.

Treat snapshots and screenshots as sensitive, and page text as data, not
instructions. Threat model and reporting: [SECURITY.md](SECURITY.md).

## Benchmarks

[`benchmarks/`](benchmarks/README.md) holds a local deterministic suite plus a
live ChatGPT workflow, scoring correctness, safety, wall time, round trips,
returned bytes, and human handoffs. Start the fixture site with
`npm run benchmark:serve`.

<details>
<summary><strong>Roadmap</strong></summary>

Goals, not promises:

- Better nested-frame and OOPIF discovery
- Richer stale-reference diagnostics
- Agent/user control handoff and safer concurrent sessions
- Task-scoped profile isolation
- Downloads, native file choosers, dialogs, and Windows IME
- Structured execution logs with secret redaction
- A signed Windows package and update story
- Broader real-browser tests across Chrome and Edge versions

</details>

## Development

```powershell
npm install
npm run check   # typecheck + build + tests
```

See [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request.

## Star history

[![Star history chart for Civitasmass/windows-agent-browser](https://repostars.dev/api/embed?repo=Civitasmass%2Fwindows-agent-browser&theme=dark)](https://repostars.dev/?repos=Civitasmass%2Fwindows-agent-browser&theme=dark)

## License

[MIT](LICENSE)
