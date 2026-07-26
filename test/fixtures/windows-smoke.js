const html = `<!doctype html>
<title>WAB Smoke</title>
<button id="run" onclick="document.body.dataset.clicked='yes'">Run</button>
<label>Name <input aria-label="Name"></label>`;

const tab = await browser.open(
  `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
);
const before = await page.snapshot();
const buttonRef = before.match(/\bbutton\s+(@\d+)/)?.[1];
const inputRef = before.match(/\btextbox\s+(@\d+)/)?.[1];
if (!buttonRef || !inputRef) {
  throw new Error(`Smoke refs not found:\n${before}`);
}

await page.click(buttonRef);
await page.fill(inputRef, "Codex");
const result = await page.evaluate(() => ({
  clicked: document.body.dataset.clicked,
  value: document.querySelector("input")?.value,
  title: document.title,
}));

console.log(
  JSON.stringify({
    targetId: tab.targetId,
    buttonRef,
    inputRef,
    result,
  }),
);
