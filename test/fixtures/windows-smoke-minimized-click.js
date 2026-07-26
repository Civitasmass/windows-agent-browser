const html = `<!doctype html>
<title>Minimized Click Smoke</title>
<button onclick="document.body.dataset.clicked='yes'">Run</button>`;

const tab = await browser.open(
  `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
);
const snapshot = await page.snapshot();
const buttonRef = snapshot.match(/\bbutton\s+(@\d+)/)?.[1];
if (!buttonRef) {
  throw new Error(`Minimized-click ref not found:\n${snapshot}`);
}

const browserWindow = await cdp(
  "Browser.getWindowForTarget",
  { targetId: tab.targetId },
  { browser: true },
);
await cdp(
  "Browser.setWindowBounds",
  {
    windowId: browserWindow.windowId,
    bounds: { windowState: "minimized" },
  },
  { browser: true },
);
await sleep(250);

const minimized = await cdp(
  "Browser.getWindowForTarget",
  { targetId: tab.targetId },
  { browser: true },
);
if (minimized.bounds?.windowState !== "minimized") {
  throw new Error(
    `Browser did not minimize: ${JSON.stringify(minimized.bounds)}`,
  );
}

const startedAt = Date.now();
await page.click(buttonRef);
const elapsedMs = Date.now() - startedAt;
const [clicked, restored] = await Promise.all([
  page.evaluate(() => document.body.dataset.clicked),
  cdp(
    "Browser.getWindowForTarget",
    { targetId: tab.targetId },
    { browser: true },
  ),
]);
if (
  clicked !== "yes" ||
  restored.bounds?.windowState === "minimized"
) {
  throw new Error(
    `Minimized click failed: ${JSON.stringify({ clicked, restored })}`,
  );
}

console.log(
  JSON.stringify({
    clicked,
    elapsedMs,
    windowState: restored.bounds?.windowState,
  }),
);
