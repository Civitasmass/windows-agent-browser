# Agent Browser API

The installed runtime injects `browser`, `page`, `cdp`, and `sleep` into one
async JavaScript program on stdin. `browser.open/use` return tab metadata and
bind the global `page`; they do not return a Playwright Page. Values persist in
the browser, while script-local variables do not persist across invocations.

## Browser and transport

| Method | Result / behavior |
| --- | --- |
| `browser.tabs()` | Current page targets: `{targetId, title, url}`. |
| `browser.current()` | Selected target metadata. |
| `browser.open(url?, {wait?, timeoutMs?}?)` | Create/select tab; default URL `about:blank`. |
| `browser.use(targetId)` | Select existing tab; returns metadata. |
| `browser.close(targetId?)` | Close specified/selected tab. |
| `page.goto(url, {wait?, timeoutMs?}?)` | Navigate selected page. |
| `page.info()` | URL/title, viewport, scroll and document dimensions. |

Navigation waits for the new document to load by default. For a task that only
needs a particular rendered control, `{wait:false}` plus `waitForAny` can avoid
waiting for unrelated page resources. Never skip the task's readiness check.

`AGENT_BROWSER_CONTEXT` selects saved tab/ref state. `AGENT_BROWSER_CHROME`
selects Chrome/Edge; `AGENT_BROWSER_HOME` and `AGENT_BROWSER_PROFILE` select app
state and a dedicated profile. Use Windows paths for the latter from WSL.
Do not run concurrent scripts on the same context or manipulate another task's
tabs. Different contexts still share cookies and storage.

Windows 10/11 use the same Node 22+ and Chrome/Edge code path. WSL forwards stdin
to Windows Node through `winbrowse.cmd`; it does not need Linux Chromium.
PowerShell 5.1 defaults to ASCII when piping text to native programs: set
`$OutputEncoding = [System.Text.UTF8Encoding]::new($false)` before the pipe.
For saved scripts use `Get-Content -LiteralPath .\task.js -Raw -Encoding UTF8 |
winbrowse.cmd` with that encoding setting. In WSL, use a quoted heredoc or
`winbrowse < task.js`. Relative file paths resolve from Windows Node's cwd;
use `wslpath -w` for a file under a mounted Windows drive.

If the command fails to connect, run `winbrowse --doctor` once and address
the reported cause. This reports configuration and probes CDP without opening
a new browser. `winbrowse launch` starts/reuses the managed browser.

## Observe and interact

| Method | Accepted arguments |
| --- | --- |
| `page.snapshot({maxChars?}?)` | AX text and current `@N` refs; truncation is marked. |
| `page.evaluate(expression)` | JavaScript expression string. |
| `page.evaluate(fn, arg?)` | Function plus JSON-serializable argument; promises awaited. |
| `page.click(target, {waitForNavigation?, timeoutMs?}?)` | `@N`, CSS, `[x,y]`, or `{x,y}`. |
| `page.fill(target, value)` | Replace editable text using ref or CSS. |
| `page.type(target, text, {delayMs?}?)` | Insert text using ref or CSS; no delay by default. |
| `page.press(key, {waitForNavigation?, timeoutMs?}?)` | Focused element; e.g. `Enter`, `Tab`, `Control+a`. |
| `page.setInputFiles(target, files)` | Ref/CSS file input, one path or array of existing files. |
| `page.setViewport({width,height,deviceScaleFactor?,mobile?})` | Emulated CSS viewport; defaults DPR 1, desktop. |
| `page.screenshot({path?,fullPage?,format?,quality?}?)` | Path if supplied, otherwise base64; formats png/jpeg/webp. |

CSS is raw (`#search`) or prefixed (`loc=css:#search`). It resolves the first
matching top-level element, so choose an unambiguous selector from the page or
its source. Role/href/XPath locators and Playwright methods are not implemented.
Refs belong to the latest snapshot and selected document; navigation invalidates
them. A dynamic replacement may invalidate a control without changing the URL.

Input helpers bring the selected tab to the foreground and restore a minimized
managed window. The launch flags keep covered renderers responsive. Avoid
conflicting input while the user controls that desktop. `setInputFiles` assigns
the file input directly without a native chooser; a site's change handler may
upload immediately, so the authorization must include that file/destination.

### Visual controls and frames

Use screenshot-driven `page.click([x,y])` for canvas or iframe controls when
DOM targets are unavailable. Coordinates are viewport CSS pixels, not Windows
screen coordinates. With deviceScaleFactor 2, image pixel offsets need dividing
by 2; full-page captures also require accounting for scroll. Check `page.info()`
and the capture geometry when mapping points. Inspect a new image after the
layout or viewport changes. Prefer viewport captures for coordinate work.

Iframe controls have no AX refs in this runtime; top-level CSS does not pierce
frames. Visual clicks can still reach visible frame controls. For richer frame
work use a correctly selected CDP session or available native browser/Computer
Use tools. The page screenshot excludes browser chrome and OS dialogs; those
need native tools. Windows Computer Use operates on the active, unlocked
desktop. Availability depends on the host tools, not just the selected model.

## Wait for the required outcome

- `page.waitForURL(stringOrRegExp, {timeoutMs?}?)`: exact-or-contains string or
  regexp match. Use an expectation that does not already match the old page.
- `page.waitForLoadState({timeoutMs?}?)`: current document `readyState=complete`;
  no named load states. It alone does not correlate with an earlier click.
- `page.waitForAny(conditions, {timeoutMs?,pollMs?}?)`: first matching
  `{name,index,url}`; fields within one condition are ANDed. String/regexp URL
  and text, CSS selector, optional `state:'visible'` (requires selector).
- `page.waitForTimeout(ms)` / `sleep(ms)`: explicit delay when actually needed.

`waitForNavigation:true` on click/press requires a new document and times out
on SPA routing. Use `waitForURL`/`waitForAny` there; URL alone does not prove the
result content has rendered.

```js
await browser.use(savedTargetId);
await page.fill('#query', query);
await page.waitForAny([{name:'ready', selector:'button[type=submit]', state:'visible'}]);
await page.click('button[type=submit]');
const outcome = await page.waitForAny([
  {name:'done', selector:'[data-result]', state:'visible'},
  {name:'error', selector:'[role=alert]', state:'visible'}
]);
console.log(await page.evaluate(name => ({
  outcome: name,
  text: document.querySelector(name === 'done' ? '[data-result]' : '[role=alert]').textContent
}), outcome.name));
```

This pattern assumes the selectors and outcomes have been established. New
semantic decisions require returning evidence to the model. Choose one useful
observation instead of mechanically printing info, snapshot and screenshot.

## CDP

`cdp(method, params?, {browser?,sessionId?}?)` addresses the selected page by
default; `{browser:true}` addresses the browser, and `sessionId` selects an
explicit attached session. Use it for in-scope operations missing from helpers,
such as scrolling, dialog handling, or frame interaction. It is not restricted
to read-only calls. Respect the host's permissions and the existing task scope;
no separate confirmation is required merely for choosing CDP or evaluate.
