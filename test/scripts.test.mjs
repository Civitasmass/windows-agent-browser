import assert from "node:assert/strict";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const installerUrl = new URL("../scripts/install.ps1", import.meta.url);
const skillInstallerUrl = new URL(
  "../scripts/install-agent-skills.ps1",
  import.meta.url,
);
const skillInstallerPath = fileURLToPath(skillInstallerUrl);
const wrapperUrl = new URL("../scripts/agent-browser-wsl", import.meta.url);
const wrapperPath = fileURLToPath(wrapperUrl);
const wslInstallerUrl = new URL(
  "../scripts/install-wsl.sh",
  import.meta.url,
);
const wslInstallerPath = fileURLToPath(wslInstallerUrl);
const skillUrl = new URL(
  "../skills/agent-browser-windows/SKILL.md",
  import.meta.url,
);
const occluderUrl = new URL(
  "../benchmarks/windows-occluder.ps1",
  import.meta.url,
);
const occludedClickUrl = new URL(
  "./fixtures/windows-smoke-occluded-click.js",
  import.meta.url,
);

test("PowerShell installer checks Node 22 and installs this project globally", async () => {
  const source = await readFile(installerUrl, "utf8");

  assert.match(source, /\$PSScriptRoot/u);
  assert.match(source, /Get-Command "node\.exe"/u);
  assert.match(source, /\$NodeMajor -lt 22/u);
  assert.match(source, /Get-Command "npm\.cmd"/u);
  assert.match(source, /install --include=dev --ignore-scripts/u);
  assert.match(
    source,
    /run check/u,
    "the Windows build and tests must pass before global installation",
  );
  assert.match(
    source,
    /install --global --ignore-scripts -- \$ProjectRoot/u,
    "npm must receive the resolved project root as one PowerShell argument",
  );
  assert.match(source, /\[switch\]\$SkipAgentSkills/u);
  assert.match(source, /install-agent-skills\.ps1/u);
  assert.match(source, /-Target All -Scope User/u);
  assert.match(source, /agent-browser --doctor/u);
  assert.match(source, /agent-browser launch/u);
  assert.match(source, /updated launch flags take effect/u);

  assert.doesNotMatch(source, /\b(?:Copy-Item|xcopy|robocopy)\b/iu);
  assert.doesNotMatch(source, /Chrome[\\/]User Data/iu);
});

test("PowerShell skill installer targets Claude, Codex, and managed Claude paths safely", async (t) => {
  const source = await readFile(skillInstallerUrl, "utf8");

  assert.match(source, /\.claude/u);
  assert.match(source, /CLAUDE_CONFIG_DIR/u);
  assert.match(source, /ClaudeConfigDir/u);
  assert.match(
    source,
    /\.agents\\skills\\agent-browser-windows/u,
  );
  assert.match(
    source,
    /ClaudeCode\\\.claude\\skills\\agent-browser-windows/u,
  );
  assert.match(source, /ClaudeManaged scope requires -Target Claude/u);
  assert.match(source, /Refusing to overwrite an unowned skill directory/u);
  assert.match(source, /FileAttributes\]::ReparsePoint/u);
  assert.match(source, /\$MarkerName/u);
  assert.doesNotMatch(
    source,
    /managed-settings\.json|New-ItemProperty|Set-ItemProperty/iu,
  );
  assert.doesNotMatch(source, /DetectedSplitClaudeRoots/u);

  if (process.platform !== "win32") {
    t.diagnostic(
      "PowerShell installer execution is covered by the native Windows test job",
    );
    return;
  }

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "agent-browser-windows-skills-test-"),
  );
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const environment = {
    ...process.env,
    USERPROFILE: temporaryDirectory,
  };
  const runInstaller = () =>
    spawnSync(
      "powershell.exe",
      [
        "-NoProfile",
        "-ExecutionPolicy",
        "Bypass",
        "-File",
        skillInstallerPath,
        "-Target",
        "All",
        "-Scope",
        "User",
      ],
      { env: environment, encoding: "utf8" },
    );

  for (const run of [runInstaller(), runInstaller()]) {
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
  }

  const expectedSkill = await readFile(skillUrl, "utf8");
  for (const destination of [
    join(
      temporaryDirectory,
      ".claude",
      "skills",
      "agent-browser-windows",
    ),
    join(
      temporaryDirectory,
      ".agents",
      "skills",
      "agent-browser-windows",
    ),
  ]) {
    assert.equal(
      await readFile(join(destination, "SKILL.md"), "utf8"),
      expectedSkill,
    );
    assert.equal(
      (
        await readFile(
          join(destination, ".installed-by-windows-agent-browser"),
          "utf8",
        )
      ).trim(),
      "windows-agent-browser",
    );
  }
});

test("shared skill stays concise and documents both shell transports", async () => {
  const source = await readFile(skillUrl, "utf8");

  assert.ok(
    Buffer.byteLength(source, "utf8") < 5_000,
    "SKILL.md should keep setup detail in separate documentation",
  );
  assert.match(source, /agent-browser\.cmd/u);
  assert.match(source, /agent-browser <<'JS'/u);
  assert.match(source, /AGENT_BROWSER_CONTEXT/u);
  assert.match(source, /references\/api\.md/u);
  assert.doesNotMatch(source, /npm install|Program Files\\ClaudeCode/iu);
});

test("Windows occlusion smoke test covers the browser without forcing foreground", async () => {
  const [occluder, smoke] = await Promise.all([
    readFile(occluderUrl, "utf8"),
    readFile(occludedClickUrl, "utf8"),
  ]);

  assert.match(occluder, /\$Form\.TopMost = \$true/u);
  assert.match(
    occluder,
    /\$Form\.WindowState = \[System\.Windows\.Forms\.FormWindowState\]::Maximized/u,
  );
  assert.match(occluder, /\[System\.IO\.File\]::WriteAllText/u);
  assert.match(smoke, /await access\(readyFile\)/u);
  assert.match(smoke, /await page\.click\("loc=css:#run"\)/u);
  assert.match(smoke, /document\.visibilityState/u);
  assert.doesNotMatch(
    `${occluder}\n${smoke}`,
    /SetForegroundWindow|ShowWindowAsync|user32/iu,
  );
});

test("WSL wrapper has valid Bash syntax and keeps arguments safely separated", async (t) => {
  const source = await readFile(wrapperUrl, "utf8");
  if (process.platform === "win32") {
    t.diagnostic("Bash syntax execution is covered by the WSL/Linux test job");
  } else {
    const syntax = spawnSync("bash", ["-n", wrapperPath], {
      encoding: "utf8",
    });
    if (
      syntax.error?.code === "ENOENT" ||
      syntax.error?.code === "EPERM"
    ) {
      t.diagnostic(
        "bash execution is unavailable; static wrapper checks still ran",
      );
    } else {
      assert.ifError(syntax.error);
      assert.equal(syntax.status, 0, syntax.stderr);
    }
  }
  assert.match(
    source,
    /windows_command=\$\{AGENT_BROWSER_WINDOWS_CMD:-agent-browser\.cmd\}/u,
  );
  assert.match(
    source,
    /exec cmd\.exe \/d \/s \/c "\$windows_command" "\$@"/u,
  );
  for (const variableName of [
    "AGENT_BROWSER_CONTEXT",
    "AGENT_BROWSER_CHROME",
    "AGENT_BROWSER_HOME",
    "AGENT_BROWSER_PROFILE",
  ]) {
    assert.match(source, new RegExp(`\\b${variableName}\\b`, "u"));
  }
  assert.match(source, /share_with_windows "\$variable_name"/u);
  assert.match(source, /export WSLENV/u);
  assert.doesNotMatch(source, /AGENT_BROWSER_(?:CHROME|HOME|PROFILE)\/p/u);
  assert.doesNotMatch(source, /\beval\b(?!\.)/u);
  assert.doesNotMatch(source, /\$\*/u);
});

test("WSL installer adds the bridge and shared skills without touching shell profiles", async (t) => {
  const source = await readFile(wslInstallerUrl, "utf8");
  assert.match(source, /\.agents\/skills\/agent-browser-windows/u);
  assert.match(source, /\.claude\/skills\/agent-browser-windows/u);
  assert.match(source, /bin_dir="\$HOME\/\.local\/bin"/u);
  assert.match(source, /bridge_destination="\$bin_dir\/agent-browser"/u);
  assert.match(source, /refusing to overwrite unowned/u);
  assert.match(source, /refusing to update a symlink/u);
  assert.doesNotMatch(source, /\b(?:sudo|eval)\b/u);
  assert.doesNotMatch(source, /\.(?:bashrc|profile|zshrc)/u);

  if (process.platform === "win32") {
    t.skip("The WSL installer execution test runs in WSL/Linux");
    return;
  }
  const bash = spawnSync("bash", ["--version"], { encoding: "utf8" });
  if (bash.error?.code === "ENOENT" || bash.error?.code === "EPERM") {
    t.skip("bash execution is unavailable on this development host");
    return;
  }
  assert.ifError(bash.error);

  const temporaryHome = await mkdtemp(
    join(tmpdir(), "agent-browser-wsl-install-test-"),
  );
  t.after(() => rm(temporaryHome, { recursive: true, force: true }));
  const environment = {
    ...process.env,
    HOME: temporaryHome,
    PATH: process.env.PATH ?? "",
  };
  const runInstaller = () =>
    spawnSync("bash", [wslInstallerPath, "--with-claude"], {
      env: environment,
      encoding: "utf8",
    });

  for (const run of [runInstaller(), runInstaller()]) {
    assert.ifError(run.error);
    assert.equal(run.status, 0, run.stderr);
  }

  const expectedSkill = await readFile(skillUrl, "utf8");
  for (const destination of [
    join(
      temporaryHome,
      ".agents",
      "skills",
      "agent-browser-windows",
    ),
    join(
      temporaryHome,
      ".claude",
      "skills",
      "agent-browser-windows",
    ),
  ]) {
    assert.equal(
      await readFile(join(destination, "SKILL.md"), "utf8"),
      expectedSkill,
    );
  }
  const installedBridge = join(
    temporaryHome,
    ".local",
    "bin",
    "agent-browser",
  );
  assert.equal(
    await readFile(installedBridge, "utf8"),
    await readFile(wrapperUrl, "utf8"),
  );
  assert.notEqual((await stat(installedBridge)).mode & 0o111, 0);

  const conflictingHome = join(temporaryHome, "conflict");
  const conflictingCommand = join(
    conflictingHome,
    ".local",
    "bin",
    "agent-browser",
  );
  await mkdir(join(conflictingHome, ".local", "bin"), {
    recursive: true,
  });
  await writeFile(conflictingCommand, "owned by another tool\n");
  const conflict = spawnSync("bash", [wslInstallerPath], {
    env: {
      ...environment,
      HOME: conflictingHome,
    },
    encoding: "utf8",
  });
  assert.equal(conflict.status, 1);
  assert.match(conflict.stderr, /refusing to overwrite unowned command/u);
  assert.equal(
    await readFile(conflictingCommand, "utf8"),
    "owned by another tool\n",
  );
});

test("WSL wrapper preserves stdin, argv, and browser environment with a fake cmd.exe", async (t) => {
  if (process.platform === "win32") {
    t.skip("The fake cmd.exe transport test runs in WSL/Linux");
    return;
  }
  const bash = spawnSync("bash", ["--version"], { encoding: "utf8" });
  if (bash.error?.code === "ENOENT" || bash.error?.code === "EPERM") {
    t.skip("bash execution is unavailable on this development host");
    return;
  }
  assert.ifError(bash.error);

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "agent-browser-wsl-test-"),
  );
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));

  const fakeCmd = join(temporaryDirectory, "cmd.exe");
  const argsFile = join(temporaryDirectory, "args");
  const environmentFile = join(temporaryDirectory, "environment");
  const stdinFile = join(temporaryDirectory, "stdin");
  await writeFile(
    fakeCmd,
    `#!/usr/bin/env bash
printf '%s\\0' "$@" > "$WRAPPER_CAPTURE_ARGS"
printf '%s' "\${WSLENV-}" > "$WRAPPER_CAPTURE_ENV"
cat > "$WRAPPER_CAPTURE_STDIN"
`,
  );
  await chmod(fakeCmd, 0o755);

  const stdin = Buffer.from([0x61, 0x00, 0x62, 0x0a, 0xff]);
  const result = spawnSync("bash", [wrapperPath, "nodejs"], {
    input: stdin,
    env: {
      ...process.env,
      PATH: `${temporaryDirectory}:${process.env.PATH ?? ""}`,
      WSLENV: "EXISTING/u:AGENT_BROWSER_CONTEXT/u",
      AGENT_BROWSER_WINDOWS_CMD: String.raw`C:\Tools\agent-browser.cmd`,
      AGENT_BROWSER_CONTEXT: "codex",
      AGENT_BROWSER_CHROME: String.raw`C:\Program Files\Chrome\chrome.exe`,
      AGENT_BROWSER_HOME: String.raw`D:\agent-browser`,
      AGENT_BROWSER_PROFILE: String.raw`D:\agent-browser\profiles\codex`,
      WRAPPER_CAPTURE_ARGS: argsFile,
      WRAPPER_CAPTURE_ENV: environmentFile,
      WRAPPER_CAPTURE_STDIN: stdinFile,
    },
    encoding: "buffer",
  });

  assert.equal(result.status, 0, result.stderr.toString("utf8"));
  assert.deepEqual(
    (await readFile(argsFile)).toString("utf8").split("\0").slice(0, -1),
    [
      "/d",
      "/s",
      "/c",
      String.raw`C:\Tools\agent-browser.cmd`,
      "nodejs",
    ],
  );
  assert.equal(
    await readFile(environmentFile, "utf8"),
    [
      "EXISTING/u",
      "AGENT_BROWSER_CONTEXT/w",
      "AGENT_BROWSER_CHROME",
      "AGENT_BROWSER_HOME",
      "AGENT_BROWSER_PROFILE",
    ].join(":"),
  );
  assert.deepEqual(await readFile(stdinFile), stdin);
});

test("quoted Bash heredoc preserves JavaScript backslashes byte for byte", async (t) => {
  if (process.platform === "win32") {
    t.skip("The quoted-heredoc transport test runs in WSL/Linux");
    return;
  }
  const bash = spawnSync("bash", ["--version"], { encoding: "utf8" });
  if (bash.error?.code === "ENOENT" || bash.error?.code === "EPERM") {
    t.skip("bash execution is unavailable on this development host");
    return;
  }
  assert.ifError(bash.error);

  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "agent-browser-heredoc-test-"),
  );
  t.after(() => rm(temporaryDirectory, { recursive: true, force: true }));
  const passthrough = join(temporaryDirectory, "passthrough.mjs");
  await writeFile(passthrough, "process.stdin.pipe(process.stdout);");

  const program = String.raw`const pattern = /\/adaptive\/result\//;
const windowsPath = "C:\\Tools\\agent-browser.cmd";
`;
  const quoteForBash = (value) =>
    `'${value.replaceAll("'", String.raw`'\''`)}'`;
  const command =
    `${quoteForBash(process.execPath)} ${quoteForBash(passthrough)} <<'JS'\n` +
    `${program}JS\n`;
  const result = spawnSync("bash", ["-c", command], {
    encoding: "utf8",
  });

  assert.ifError(result.error);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, program);
});
