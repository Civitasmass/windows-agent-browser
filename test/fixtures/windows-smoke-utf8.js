const expected = "中文テスト✓";
const html = `<!doctype html>
<meta charset="utf-8">
<title>编码テスト</title>
<label>名称 <input aria-label="名称"></label>`;

await browser.open(
  `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
);
const snapshot = await page.snapshot();
const inputRef = snapshot.match(/\btextbox\s+(@\d+)/)?.[1];
if (!inputRef) throw new Error(`UTF-8 smoke ref not found:\n${snapshot}`);

await page.fill(inputRef, expected);
const result = await page.evaluate(() => ({
  title: document.title,
  label: document.querySelector("input")?.ariaLabel,
  value: document.querySelector("input")?.value,
}));
if (result.value !== expected) {
  throw new Error(`UTF-8 value mismatch: ${JSON.stringify(result)}`);
}
console.log(JSON.stringify(result));
