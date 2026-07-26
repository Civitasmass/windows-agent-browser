[CmdletBinding()]
param(
    [switch]$SkipAgentSkills
)

$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$PackageJson = Join-Path $ProjectRoot "package.json"

if (-not (Test-Path -LiteralPath $PackageJson -PathType Leaf)) {
    throw "package.json was not found at: $PackageJson"
}

$NodeCommand = Get-Command "node.exe" -CommandType Application -ErrorAction SilentlyContinue
if ($null -eq $NodeCommand) {
    throw "Node.js was not found on PATH. Install Node.js 22 or newer, then run this script again."
}

$NodeVersion = (& $NodeCommand.Source --version | Select-Object -First 1)
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($NodeVersion)) {
    throw "Unable to read the Node.js version."
}

$NodeVersion = $NodeVersion.Trim()
if ($NodeVersion -notmatch "^v(?<major>[0-9]+)(?:\.[0-9]+){2}") {
    throw "Unexpected Node.js version: $NodeVersion"
}

$NodeMajor = [int]$Matches["major"]
if ($NodeMajor -lt 22) {
    throw "Node.js 22 or newer is required. Found $NodeVersion."
}

$NpmCommand = Get-Command "npm.cmd" -CommandType Application -ErrorAction SilentlyContinue
if ($null -eq $NpmCommand) {
    throw "npm.cmd was not found on PATH. Repair or reinstall Node.js, then run this script again."
}

Write-Host "Installing windows-agent-browser from:"
Write-Host "  $ProjectRoot"

Push-Location -LiteralPath $ProjectRoot
try {
    # Bootstrap a fresh checkout without lifecycle recursion, then run the
    # full verification explicitly before installing the already-built CLI.
    & $NpmCommand.Source install --include=dev --ignore-scripts
    if ($LASTEXITCODE -ne 0) {
        throw "npm dependency installation failed with exit code $LASTEXITCODE."
    }

    & $NpmCommand.Source run check
    if ($LASTEXITCODE -ne 0) {
        throw "npm check failed with exit code $LASTEXITCODE."
    }

    & $NpmCommand.Source install --global --ignore-scripts -- $ProjectRoot
    if ($LASTEXITCODE -ne 0) {
        throw "npm global installation failed with exit code $LASTEXITCODE."
    }

    if (-not $SkipAgentSkills) {
        $SkillInstaller = Join-Path $PSScriptRoot "install-agent-skills.ps1"
        & $SkillInstaller -Target All -Scope User
    }
}
finally {
    Pop-Location
}

Write-Host ""
Write-Host "Installation complete."
Write-Host "This installer does not read or copy your default Chrome profile."
Write-Host "If the dedicated browser is already open, close it once so updated launch flags take effect."
Write-Host ""
Write-Host "Next steps:"
Write-Host "  agent-browser --doctor"
Write-Host "  agent-browser launch"
if (-not $SkipAgentSkills) {
    Write-Host "  Restart Claude Code or Codex, then invoke agent-browser-windows."
}
