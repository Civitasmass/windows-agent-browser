const { access, unlink } = await import("node:fs/promises");
const { tmpdir } = await import("node:os");
const { resolve, join } = await import("node:path");
const { spawn } = await import("node:child_process");

const html = `<!doctype html>
<title>Occluded Click Smoke</title>
<button id="run" onclick="document.body.dataset.clicked='yes'">Run</button>`;

await browser.open(
  `data:text/html;charset=utf-8,${encodeURIComponent(html)}`,
);

const readyFile = join(
  tmpdir(),
  `agent-browser-occluder-${process.pid}-${Date.now()}.ready`,
);
const occluder = spawn(
  "powershell.exe",
  [
    "-NoProfile",
    "-ExecutionPolicy",
    "Bypass",
    "-File",
    resolve("benchmarks/windows-occluder.ps1"),
    "-Seconds",
    "8",
    "-ReadyFile",
    readyFile,
  ],
  { stdio: "ignore" },
);
let spawnError;
occluder.once("error", (error) => {
  spawnError = error;
});

try {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    if (spawnError) throw spawnError;
    try {
      await access(readyFile);
      break;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
    await sleep(50);
  }
  await access(readyFile);
  await sleep(250);

  const startedAt = Date.now();
  await page.click("loc=css:#run");
  const elapsedMs = Date.now() - startedAt;
  const state = await page.evaluate(() => ({
    clicked: document.body.dataset.clicked ?? null,
    visibility: document.visibilityState,
  }));
  if (state.clicked !== "yes") {
    throw new Error(`Occluded click did not land: ${JSON.stringify(state)}`);
  }
  console.log(JSON.stringify({ ...state, elapsedMs }));
} finally {
  if (occluder.exitCode === null) occluder.kill();
  await unlink(readyFile).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}
