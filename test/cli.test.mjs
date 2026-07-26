import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { main } from "../dist/cli.js";
import { executeScript } from "../dist/executor.js";

function outputBuffer() {
  return {
    value: "",
    write(text) {
      this.value += text;
      return true;
    },
  };
}

test("CLI help is available without starting or configuring a browser", () => {
  const stdout = outputBuffer();
  const stderr = outputBuffer();

  return main(["--help"], { stdout, stderr }).then((exitCode) => {
    assert.equal(exitCode, 0);
    assert.equal(stderr.value, "");
    assert.match(stdout.value, /^Windows Agent Browser$/mu);
    assert.match(stdout.value, /agent-browser nodejs/u);
    assert.match(stdout.value, /AGENT_BROWSER_PROFILE/u);
  });
});

test("CLI rejects empty stdin with help and a usage exit code", async () => {
  const stdout = outputBuffer();
  const stderr = outputBuffer();
  const exitCode = await main([], {
    stdinText: "  \r\n\t",
    stdout,
    stderr,
  });

  assert.equal(exitCode, 2);
  assert.equal(stdout.value, "");
  assert.match(stderr.value, /^Windows Agent Browser$/mu);
  assert.match(stderr.value, /Usage:/u);
});

test("executor rejects an empty script before browser startup", async () => {
  await assert.rejects(
    executeScript("\n\t "),
    (error) =>
      error instanceof TypeError &&
      error.message === "Browser script is empty.",
  );
});

test("the npm bin entrypoint executes instead of behaving like an import", async (t) => {
  const packageJson = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  );
  assert.equal(
    packageJson.bin["agent-browser"],
    "./dist/bin.js",
  );

  const result = spawnSync(
    process.execPath,
    [
      fileURLToPath(new URL("../dist/bin.js", import.meta.url)),
      "--version",
    ],
    { encoding: "utf8" },
  );
  if (result.error?.code === "EPERM") {
    t.skip("This sandbox does not permit child process execution.");
    return;
  }
  assert.ifError(result.error);
  assert.equal(result.status, 0);
  assert.equal(result.stdout.trim(), packageJson.version);
  assert.equal(result.stderr, "");
});
