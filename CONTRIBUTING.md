# Contributing to Windows Agent Browser

Thanks for helping build a practical, Windows-first browser interface for AI
agents. The project is an experimental MVP, so small, well-tested changes are
more useful than broad abstractions or premature compatibility layers.

## Before you start

- Read [README.md](README.md), especially the limitations and confirmation
  boundary.
- Read [SECURITY.md](SECURITY.md). Report vulnerabilities privately rather than
  opening a public issue.
- Check existing issues before starting a large change.
- For a behavior or API change, describe the agent use case and the failure mode
  it addresses.

## Development requirements

- Windows 10 or Windows 11
- Windows Node.js 22 or newer
- Google Chrome or Microsoft Edge for real-browser checks
- npm

Run the supported browser launcher with Windows Node. From WSL, use
`bash scripts/agent-browser-wsl` to invoke the built Windows runtime rather than
running `dist/bin.js` with Linux Node. The bridge is not a sandbox and does not
reduce the submitted program's Windows permissions. Profile, home, and
executable overrides passed through the bridge must remain Windows-style paths,
not `/mnt/...` paths.

Install and verify the checkout:

```powershell
npm install
npm run check
```

Useful commands:

```powershell
npm run build       # compile TypeScript into dist/
npm run typecheck   # strict type checking without output
npm test            # build and run the Node test suite
npm run check       # typecheck, build, and test
```

## Repository layout

```text
src/
  bin.ts             executable entry point
  cli.ts             command parsing and stdin handling
  executor.ts        whole-program JavaScript execution
  api.ts             browser/page helpers
  runtime.ts         target sessions and page runtime
  cdp/               dependency-free CDP transport
  chrome.ts          Windows browser discovery and launch
  config.ts          environment and state paths
  snapshot.ts        AX-tree formatting
  refs.ts            temporary @N reference persistence
test/                Node built-in test runner suites
skills/              agent-facing instructions and API reference
scripts/             Windows installer and WSL-to-Windows bridge
```

The exact file set may evolve while the MVP is young. Keep the small public API,
agent skill, README examples, and tests consistent.

## Design principles

- **Windows-first and local-first.** Do not require a hosted control plane.
- **Dedicated profile only.** Never read, import, decrypt, or modify the user's
  normal Chrome/Edge profile.
- **Code over chatty calls.** Preserve the ability to run related actions in one
  JavaScript program.
- **Two-round model decisions.** A model must read a completed snapshot before
  choosing a new `@N`; preserve the discovery command followed by an explicit
  `browser.use(targetId)` action command.
- **Named bookkeeping contexts.** Require stable, distinct
  `AGENT_BROWSER_CONTEXT` values for separate agents, while clearly stating
  that contexts do not isolate profiles, cookies, storage, tabs, or authority.
- **Small agent surface.** Add a helper only when it is safer or materially
  easier than raw CDP.
- **Honest semantics.** Do not claim Playwright compatibility, native task
  Spaces, kernel-level snapshots, or complete OOPIF coverage.
- **No silent failure.** Preserve actionable error codes and surface uncertain
  browser state.
- **Safe by workflow.** Keep irreversible actions, authentication, and user
  handoff boundaries visible to the calling agent.

## Making a change

1. Create a focused branch.
2. Add or update behavior-focused tests.
3. Implement the smallest change that solves the demonstrated problem.
4. Update user-facing documentation and the bundled agent skill when the public
   behavior changes.
5. Run `npm run check`.
6. If browser behavior changed, run a manual check with a new throwaway
   dedicated profile and record the Chrome/Edge and Windows versions.

Do not use a real daily profile for development. Do not add cookies,
credentials, profile databases, per-context state/ref files, downloaded private
files, snapshot output, or screenshots containing personal data to fixtures.
URLs, accessible names, and form values must be treated as potentially
sensitive.

This checkout may live on a Windows-mounted filesystem where CRLF is normal.
Match the existing file and avoid repository-wide line-ending conversions or
formatting churn.

## Testing guidance

Prefer deterministic unit tests with fake CDP responses for:

- request IDs, flattened sessions, timeouts, connection loss, and protocol
  errors;
- snapshot filtering, ordering, truncation, and reference assignment;
- stale, cross-context, wrong-target, wrong-URL, wrong-document, or malformed
  references;
- child-frame content remaining non-actionable and receiving no refs;
- cross-document `waitForNavigation`, SPA `waitForURL`, and the fact that
  `waitForLoadState` is not a future-navigation waiter;
- context name validation and per-context state paths;
- executable discovery, argument construction, and loopback-only launch
  settings;
- error paths and ambiguous state.

Real-browser checks should use an isolated test profile and local pages where
possible. Tests must not depend on bypassing CAPTCHA, anti-bot systems,
authentication challenges, or external service state.

When testing input or focus behavior, record the Windows version, browser
version, keyboard layout, and whether an IME was active. These details often
matter for Windows-specific failures.

## Public API changes

The injected `browser`, `page`, `cdp`, and `sleep` helpers are agent-facing API.
For any public change:

- document exact arguments, units, return values, and error behavior;
- keep examples executable against the current implementation;
- add JSDoc or types at the source boundary;
- update `skills/agent-browser-windows/references/api.md`;
- avoid imitating a Playwright method unless its semantics truly match.

Temporary snapshot references are part of the safety model. Changes must retain
target, URL, and document validation and must not silently resolve a stale `@N`
to a different element. Do not assign small-API refs to iframe controls until
the runtime can safely resolve and act within their frame sessions.

Navigation waiting is deliberately explicit. `page.click()` and `page.press()`
may opt into `{ waitForNavigation: true }` for a new document; same-document
routes use `page.waitForURL()`. Do not redefine `page.waitForLoadState()` as a
future-navigation waiter or document examples that rely on it that way.

## Security-sensitive changes

Call out changes that affect:

- Chrome/Edge process arguments or remote-debugging exposure;
- profile paths, filesystem permissions, cookies, downloads, or uploads;
- JavaScript execution or serialization;
- Windows Node/WSL bridging, dynamic imports, filesystem access, or child
  process creation from stdin programs;
- raw CDP access or target selection;
- context state, agent confirmation, user handoff, or concurrent control;
- ref files, logs, snapshots, screenshots, or errors that may contain secrets,
  URLs, accessible names, or form values.

Do not weaken loopback binding, dedicated-profile validation, or browser
security controls for convenience. A feature intended to evade CAPTCHA,
anti-bot protections, credential encryption, passkeys, Windows Hello, or access
controls will not be accepted.

## Pull requests

Keep pull requests reviewable and include:

- the user-visible problem and intended behavior;
- tests run and their result;
- Windows and browser versions for manual checks;
- known limitations or follow-up work;
- screenshots only when they contain no private data.

Do not mix refactors with behavior changes unless the refactor is required.
Generated build output should follow the repository's existing policy; do not
add unrelated artifacts.

By contributing, you agree that your contribution is licensed under the
project's [MIT License](LICENSE).
