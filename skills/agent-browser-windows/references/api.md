# Agent Browser MVP API

This document describes the intended MVP surface. Do not infer Playwright methods or compatibility beyond the APIs listed here.

## Contents

- [Invocation](#invocation)
- [Environment](#environment)
- [Browser](#browser)
- [Page inspection and navigation](#page-inspection-and-navigation)
- [Page interaction](#page-interaction)
- [Waiting](#waiting)
- [Raw CDP](#raw-cdp)
- [Complete patterns](#complete-patterns)

## Invocation

Pass one JavaScript program to `agent-browser` on standard input. Helpers are injected into the script; do not import them.
The Bash examples use the `codex-wsl` context; replace it with the exact
context assigned to the invoking agent in `SKILL.md`.

```bash
AGENT_BROWSER_CONTEXT=codex-wsl agent-browser <<'JS'
const tabs = await browser.tabs();
console.log(tabs);
JS
```

The program may use top-level `await`. Print values needed by the calling agent with `console.log`. The complete program is submitted before it runs: the agent cannot read a printed snapshot and then revise the remaining statements in that same invocation. Use one invocation to discover refs and a later invocation to act on them. A script can still adapt to known, machine-testable outcomes with ordinary JavaScript and `page.waitForAny()`; only a new semantic decision by the model requires another invocation.

Stdin JavaScript is trusted local code, not a sandbox. It runs with the invoking Windows user's full Node.js host permissions and can access files, processes, and the network. Run only code produced by a trusted agent.

`page` is a globally injected API bound to the tab most recently opened or selected with `browser.open()` or `browser.use()`. Those browser methods return tab metadata, not a `Page` object.

## Environment

| Variable | Purpose |
|---|---|
| `AGENT_BROWSER_CONTEXT` | Select per-agent active-target and latest-ref state. Set it on every invocation: use `codex` for Codex and `claude` for Claude. |
| `AGENT_BROWSER_CHROME` | Override the Chrome or Edge executable path. |
| `AGENT_BROWSER_HOME` | Override the application state directory. |
| `AGENT_BROWSER_PROFILE` | Override the dedicated browser profile directory. Never set it to the normal Chrome or Edge profile. |

Never let different agents share the `default` context. Contexts share the same browser profile, cookies, storage, and visible tabs. A context does not provide a security boundary or ego-style task Space, and one agent can still interfere with another agent's tabs. Use separate dedicated profiles when actual isolation is required.

## Browser

### `browser.open(url?, options?)`

Open and select a new tab, optionally navigate to `url`, and return its tab metadata. Navigation waits for the document loader started by this call to finish by default. Pass `{ wait: false }` to return without waiting or set `{ timeoutMs }` to change the timeout.

```js
const tab = await browser.open("https://example.com", {
  timeoutMs: 20_000
});
console.log(tab.targetId, tab.title, tab.url);
console.log(await page.info());
```

### `browser.tabs()`

Return the currently controllable page targets. Each tab includes at least its target identifier, title, and URL.

```js
for (const tab of await browser.tabs()) {
  console.log(tab.targetId, tab.title, tab.url);
}
```

### `browser.use(targetId)`

Select an existing page target and return its tab metadata. Subsequent `page` calls operate on that selected tab. Use a current identifier from `browser.tabs()` rather than retaining one indefinitely.

```js
const tabs = await browser.tabs();
if (tabs.length === 0) throw new Error("No browser tabs are available");
const tab = await browser.use(tabs[0].targetId);
console.log(tab);
console.log(await page.info());
```

### `browser.close(targetId?)`

Close the selected target, or the current page when the implementation permits an omitted identifier. Do not close tabs the user did not place in scope.

```js
const [tab] = await browser.tabs();
if (tab) await browser.close(tab.targetId);
```

## Page inspection and navigation

### `page.info()`

Return the current page's URL, title, viewport dimensions, scroll position, and document dimensions. It does not return a target identifier; obtain target IDs from browser methods. Check it before acting on a reused tab and after an unexpected navigation.

```js
console.log(await page.info());
```

### `page.goto(url, options?)`

Navigate the current page and wait for the document loader started by this call to finish by default. Pass `{ wait: false }` to return without waiting or set `{ timeoutMs }` to change the timeout.

```js
await page.goto("https://example.com/account", {
  timeoutMs: 20_000
});
```

### `page.snapshot()`

Return a compact accessibility-based page representation. Actionable nodes carry temporary references such as `@12`.

```js
console.log(await page.snapshot());
```

Take a snapshot before the first interaction and again after navigation, modal changes, filtering, submission, or any other meaningful DOM change. Never reuse an old `@N` merely because its number still appears plausible.

The latest snapshot's refs are persisted for the next CLI invocation. Select the same tab with `browser.use(targetId)` before using them. The runtime rejects refs when the tab, URL, or document no longer matches, but do not rely on rejection as a substitute for deliberate state checks.

The MVP may render elements from an iframe in snapshot text, but it intentionally assigns no `@N` refs to iframe controls. Do not invent a ref or guess coordinates for those elements; hand the step to the user when no safe top-level-page alternative exists.

### `page.screenshot(options?)`

Capture the visible page. Supply a path when supported by the current build and print the returned result.

```js
console.log(await page.screenshot({ path: "artifacts/account.png" }));
```

Use screenshots to diagnose missing visual context, not to guess irreversible actions.

### `page.setViewport(options)`

Apply CDP device metrics for deterministic responsive checks. Width and height
are positive integer CSS pixels.

```js
console.log(await page.setViewport({
  width: 390,
  height: 844,
  deviceScaleFactor: 2,
  mobile: true
}));
```

This changes the selected tab's emulated viewport, not the physical Windows
browser window. Set the intended viewport explicitly before each visual
comparison.

### `page.evaluate(expression)`

Evaluate a narrowly scoped JavaScript expression in the page and return its serializable result.

```js
console.log(await page.evaluate(
  "({ title: document.title, url: location.href })"
));
```

Prefer snapshots for interaction. Do not use evaluation to read secrets, bypass origin boundaries, hide automation, or perform an unconfirmed state change.

## Page interaction

Interaction targets in the MVP are snapshot references such as `"@12"`.
Before dispatching mouse or keyboard input, `click`, `fill`, `type`, and
`press` call CDP `Page.bringToFront`. On visible Windows Chrome/Edge this
restores a minimized managed browser window and focuses its tab. The launcher
also disables backgrounding of occluded Windows so a fully covered renderer
continues acknowledging CDP input when Windows foreground policy leaves the
browser behind another application. This does not raise the browser above
native dialogs or authorize input during user control. The launch switch
requires closing and relaunching an already running dedicated browser after an
upgrade, and may increase resource use while the window is covered.

### `page.click(target, options?)`

Click the referenced element. Pass `{ waitForNavigation: true, timeoutMs? }` when the click is expected to create and load a new document.

```js
await page.click("@12", {
  waitForNavigation: true,
  timeoutMs: 20_000
});
```

`waitForNavigation` waits for a document identity change, so use it for cross-document navigation only. It times out for same-document SPA routing; click without that option and use `page.waitForURL()` instead. After a click that changes the page, take a new snapshot. Confirm immediately before clicking a submit, send, delete, purchase, or payment control.

### `page.fill(target, value)`

Replace the value of an editable element.

```js
await page.fill("@27", "search terms");
```

Use `fill` for deterministic replacement. Filling may stage a form for user review; it does not authorize submission.

### `page.type(target, text)`

Focus the referenced element and type text as keyboard input without first replacing its current value.

```js
await page.type("@27", " additional text");
```

### `page.setInputFiles(target, files)`

Assign one or more existing local files to a top-level page file input. The
target may be a current snapshot ref or CSS target. Relative paths resolve in
the Windows Node.js process's current working directory.

```js
await page.setInputFiles(
  "loc=css:input[type=file]",
  ["benchmarks/fixtures/orders.csv"]
);
```

The runtime verifies every path is a regular file before sending it to Chrome.
This method does not operate a native Windows file chooser and does not pierce
an iframe. Obtain explicit approval for the exact file and destination
immediately before uploading; never discover or substitute other local files.

### `page.press(key, options?)`

Send a key to the currently focused element. Focus a target first with `page.click()`, `page.fill()`, or `page.type()`. Use conventional key names such as `"Enter"`, `"Tab"`, or `"Escape"`. Pass `{ waitForNavigation: true, timeoutMs? }` only when the keypress is expected to create a new document.

```js
await page.fill("@27", "search terms");
await page.press("Enter", {
  waitForNavigation: true,
  timeoutMs: 20_000
});
```

As with `page.click()`, use `page.waitForURL()` instead of `waitForNavigation` for same-document SPA routing. Treat `Enter` as a possible form submission. Obtain confirmation first when it can cause a remote change.

## Waiting

### `page.waitForLoadState(options?)`

Wait until the current document reaches `document.readyState === "complete"`. Set `{ timeoutMs }` to change the timeout; this MVP does not accept a named load state.

```js
await page.waitForLoadState({ timeoutMs: 20_000 });
```

This checks whichever document is current when called. It is not correlated with an earlier click or keypress and may return before a newly triggered navigation begins. Use the action's `{ waitForNavigation: true }` option for expected cross-document navigation. This helper also does not guarantee that a single-page application has finished rendering.

### `page.waitForURL(expected, options?)`

Wait for the current URL to equal or contain a string, or to match a regular expression. Use this after an action that performs same-document SPA routing.

```js
await page.click("@12");
await page.waitForURL(/\/results(?:[/?#]|$)/, {
  timeoutMs: 20_000
});
```

Choose an expected URL that does not already match the pre-action page. This helper confirms the URL transition, not that all asynchronous SPA content has rendered.

### `page.waitForAny(conditions, options?)`

Poll several known outcomes through one page evaluation and return the first
match as `{ name, index, url }`. A condition needs a unique `name` and at least
one of `url`, `selector`, or `text`. Fields in the same condition are ANDed.
String URL/text tests use exact-or-contains matching; regular expressions are
supported. `{ state: "visible" }` requires a selector.

```js
const outcome = await page.waitForAny(
  [
    { name: "results", url: /\/results(?:[/?#]|$)/ },
    {
      name: "inline",
      selector: "[data-results]",
      state: "visible",
      text: "Complete"
    },
    { name: "error", selector: "[role=alert]", state: "visible" }
  ],
  { timeoutMs: 20_000, pollMs: 100 }
);

if (outcome.name === "error") {
  console.log(await page.snapshot());
} else {
  console.log(await page.evaluate(
    "document.querySelector('[data-results]')?.textContent ?? document.body.innerText"
  ));
}
```

Use this only for outcomes whose tests and handling are known before the script
starts. It cannot ask the model to interpret a newly printed snapshot within
the same invocation.

### `page.waitForTimeout(ms)`

Wait for a short, explicit interval in milliseconds.

```js
await page.waitForTimeout(500);
```

Prefer load states and fresh snapshots over long arbitrary delays. Do not build blind retry loops.

## Raw CDP

### `cdp(method, params?)`

Send a Chrome DevTools Protocol command to the active page session and return its result.

```js
console.log(await cdp("Runtime.evaluate", {
  expression: "document.readyState",
  returnByValue: true
}));
```

Use CDP only when the MVP page API lacks a required operation. Prefer read-only commands. Do not use CDP to access unrelated targets, browser credentials, or protected profile data.

## Complete patterns

### Inspect an authenticated page

```bash
AGENT_BROWSER_CONTEXT=codex-wsl agent-browser <<'JS'
const tabs = await browser.tabs();
const existing = tabs.find((tab) => tab.url.includes("example.com"));
const tab = existing
  ? await browser.use(existing.targetId)
  : await browser.open("https://example.com/account");

console.log(tab);
console.log(await page.info());
console.log(await page.snapshot());
JS
```

### Discover, then search

Run a discovery invocation first:

```bash
AGENT_BROWSER_CONTEXT=codex-wsl agent-browser <<'JS'
const tab = await browser.open("https://example.com/search");
console.log({ targetId: tab.targetId });
console.log(await page.snapshot());
JS
```

After reading that output and identifying the search field ref, run a second invocation. For a traditional cross-document form:

```bash
AGENT_BROWSER_CONTEXT=codex-wsl agent-browser <<'JS'
await browser.use("TARGET_ID_FROM_PREVIOUS_OUTPUT");
await page.fill("@8", "quarterly report");
await page.press("Enter", {
  waitForNavigation: true,
  timeoutMs: 20_000
});
console.log(await page.info());
console.log(await page.snapshot());
JS
```

For a same-document SPA route, do not request a document-navigation wait:

```js
await page.press("Enter");
await page.waitForURL(
  /[?&]q=quarterly(?:%20|\+)report(?:[&#]|$)/,
  {
    timeoutMs: 20_000
  }
);
```

Read the resulting snapshot after the invocation completes before selecting any new refs.

### Handle a finite result race in one invocation

When a known action can produce a small set of deterministic states, do not
print an intermediate value merely to choose among those states:

```js
await page.click("@12");
const outcome = await page.waitForAny([
  { name: "redirect", url: /\/results(?:[/?#]|$)/ },
  { name: "inline", selector: "[data-results]", state: "visible" },
  { name: "validation", selector: "[role=alert]", state: "visible" }
]);

switch (outcome.name) {
  case "redirect":
  case "inline":
    console.log(await page.snapshot());
    break;
  case "validation":
    console.log({
      outcome: outcome.name,
      message: await page.evaluate(
        "document.querySelector('[role=alert]')?.textContent"
      )
    });
    break;
}
```

### Stage a form without submitting

First run a discovery invocation and read its output. Then use the tab ID and refs from that completed invocation:

```bash
AGENT_BROWSER_CONTEXT=codex-wsl agent-browser <<'JS'
await browser.use("TARGET_ID_FROM_PREVIOUS_OUTPUT");
await page.fill("@14", "Draft title");
await page.fill("@18", "Draft body for user review");
console.log(await page.info());
JS
```

Stop here. Report the staged values and request confirmation. After approval, use one invocation to take and return a fresh verification snapshot. Read that output, identify the current submit ref, and only then run the confirmed submit click in another invocation.

### Recover from an uncertain result

```bash
AGENT_BROWSER_CONTEXT=codex-wsl agent-browser <<'JS'
await browser.use("TARGET_ID_FROM_BROWSER_TABS");
console.log(await page.info());
console.log(await page.snapshot());
console.log(await page.screenshot({ path: "artifacts/uncertain-state.png" }));
JS
```

Do not repeat the previous action until this evidence shows that doing so is safe.
