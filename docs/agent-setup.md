# Agent setup

The repository keeps one concise Agent Skill at
`skills/agent-browser-windows/`. Installers copy that same source into each
agent's supported discovery directory; there are no separate Claude and Codex
instruction forks. The paths follow the current
[Claude Code skill discovery](https://code.claude.com/docs/en/skills#where-skills-live)
and [Codex skill discovery](https://learn.chatgpt.com/docs/build-skills#where-to-save-skills)
documentation.

## Installation matrix

| Agent environment | Skill destination | Browser command |
| --- | --- | --- |
| Claude Code, native Windows | `%USERPROFILE%\.claude\skills\agent-browser-windows` | `agent-browser.cmd` |
| Claude Code, native Windows, managed company deployment | `C:\Program Files\ClaudeCode\.claude\skills\agent-browser-windows` | `agent-browser.cmd` |
| Codex, native Windows | `%USERPROFILE%\.agents\skills\agent-browser-windows` | `agent-browser.cmd` |
| Codex in WSL | `~/.agents/skills/agent-browser-windows` | `~/.local/bin/agent-browser` |
| Claude Code in WSL, optional | `~/.claude/skills/agent-browser-windows` | `~/.local/bin/agent-browser` |

Native Windows and WSL have different home directories and do not share their
skill installation. Install both rows if you use Codex in both environments.
The native Codex row covers local CLI, IDE, and desktop sessions that use the
same Windows user home.

## Native Windows user setup

From Windows PowerShell:

```powershell
.\scripts\install.ps1
```

This installs the Windows CLI and copies the user skill for Claude Code and
Codex. It honors an explicit `-ClaudeConfigDir`, then `CLAUDE_CONFIG_DIR`, and
finally falls back to the standard `.claude` directory.
To install or refresh only the skills:

```powershell
.\scripts\install-agent-skills.ps1 -Target All -Scope User
```

Use `-Target Claude` or `-Target Codex` to install only one. The installer
updates directories it previously created. It refuses to overwrite an existing
unowned skill directory unless you inspect that exact directory and pass
`-Force`.

For another custom Claude profile, pass its absolute config directory:

```powershell
.\scripts\install-agent-skills.ps1 -Target Claude `
  -ClaudeConfigDir D:\profiles\claude-config
```

## Claude Code on a company account

The account plan does not change the user skill path. When company policy
allows user filesystem skills, use the user setup above. Workspace-shared
skills and local Claude Code filesystem skills have separate installation
lifecycles; joining a company workspace does not copy this local skill.

If policy blocks user/project skills, an administrator can deploy the same
skill from an elevated Windows PowerShell:

```powershell
.\scripts\install-agent-skills.ps1 -Target Claude -Scope ClaudeManaged
```

This writes only the skill under Claude Code's managed policy directory. It
does not edit `managed-settings.json`, registry policy, permission allowlists,
or plugin policy. IT must separately decide whether the local
`agent-browser.cmd` command and the dedicated browser profile are permitted.
Do not solve a company-policy denial with broad shell allow rules.

Use a company-approved dedicated profile for company work. Do not share that
profile with personal automation: agent contexts separate tab/ref bookkeeping,
not cookies, login state, or browser storage.

If the organization requires all customization to arrive through approved
plugins, package/distribute this skill through its approved marketplace instead
of asking users to bypass that policy.

## Codex in WSL

First run the Windows installer so `agent-browser.cmd` exists on the Windows
`PATH`. Then, from WSL:

```bash
bash scripts/install-wsl.sh
```

This installs the WSL-to-Windows bridge as `~/.local/bin/agent-browser` and the
Codex skill under `~/.agents/skills`. To install the optional Claude Code WSL
skill too:

```bash
bash scripts/install-wsl.sh --with-claude
```

If `~/.local/bin` is not already on `PATH`, add it before starting the agent.
The bridge runs Windows Node and Windows Chrome; do not run `dist/bin.js` with
Linux Node.

## Verify discovery and browser access

Close and reopen an agent after the first installation. Claude Code can invoke
`/agent-browser-windows`; Codex can invoke
`$agent-browser-windows` or find it through `/skills`.

The browser bookkeeping contexts are deliberately different:

| Agent | `AGENT_BROWSER_CONTEXT` |
| --- | --- |
| Native Windows Claude Code | `claude` |
| Native Windows Codex | `codex` |
| WSL Codex | `codex-wsl` |

Verify the transport outside the agent:

```powershell
agent-browser.cmd launch
agent-browser.cmd --doctor
```

Or from WSL:

```bash
agent-browser launch
agent-browser --doctor
```

Then give the agent a read-only smoke task:

```text
Use agent-browser-windows. Inspect the dedicated browser's tabs and snapshot
example.com. Do not change page or remote state.
```

If the skill is visible but command execution is denied, the installation
worked and the remaining boundary is the agent sandbox or company policy.
Grant only the narrow, reviewed command permission appropriate to that
environment.
