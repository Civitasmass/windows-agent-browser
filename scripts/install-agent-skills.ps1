[CmdletBinding()]
param(
    [ValidateSet("All", "Claude", "Codex")]
    [string]$Target = "All",

    [ValidateSet("User", "ClaudeManaged")]
    [string]$Scope = "User",

    [string[]]$ClaudeConfigDir,

    [switch]$Force
)

$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$SkillSource = Join-Path $ProjectRoot "skills\agent-browser-windows"
$SkillEntry = Join-Path $SkillSource "SKILL.md"
$MarkerName = ".installed-by-windows-agent-browser"

if (-not (Test-Path -LiteralPath $SkillEntry -PathType Leaf)) {
    throw "Agent skill was not found at: $SkillEntry"
}

$Destinations = @()

if ($Scope -eq "ClaudeManaged") {
    if ($Target -ne "Claude") {
        throw "ClaudeManaged scope requires -Target Claude."
    }
    if ($ClaudeConfigDir.Count -gt 0) {
        throw "ClaudeManaged scope does not accept -ClaudeConfigDir."
    }
    if ([string]::IsNullOrWhiteSpace($env:ProgramFiles)) {
        throw "ProgramFiles is unavailable; cannot resolve the Claude Code managed policy directory."
    }
    $Destinations += [pscustomobject]@{
        Name = "Claude Code managed"
        Path = Join-Path $env:ProgramFiles "ClaudeCode\.claude\skills\agent-browser-windows"
    }
}
else {
    if ([string]::IsNullOrWhiteSpace($env:USERPROFILE)) {
        throw "USERPROFILE is unavailable; cannot resolve user skill directories."
    }
    if ($Target -eq "All" -or $Target -eq "Claude") {
        $ClaudeRoots = @()
        if ($ClaudeConfigDir.Count -gt 0) {
            $ClaudeRoots = @($ClaudeConfigDir)
        }
        elseif (-not [string]::IsNullOrWhiteSpace($env:CLAUDE_CONFIG_DIR)) {
            $ClaudeRoots = @($env:CLAUDE_CONFIG_DIR)
        }
        else {
            $ClaudeRoots = @(Join-Path $env:USERPROFILE ".claude")
        }

        $SeenClaudeRoots = @{}
        foreach ($ClaudeRootValue in $ClaudeRoots) {
            $ClaudeRoot = [Environment]::ExpandEnvironmentVariables($ClaudeRootValue)
            if (-not [System.IO.Path]::IsPathRooted($ClaudeRoot)) {
                throw "Claude config directory must be an absolute path: $ClaudeRootValue"
            }
            $ClaudeRoot = [System.IO.Path]::GetFullPath($ClaudeRoot)
            $ClaudeRootKey = $ClaudeRoot.ToLowerInvariant()
            if ($SeenClaudeRoots.ContainsKey($ClaudeRootKey)) {
                continue
            }
            $SeenClaudeRoots[$ClaudeRootKey] = $true
            $Destinations += [pscustomobject]@{
                Name = "Claude Code user ($(Split-Path -Leaf $ClaudeRoot))"
                Path = Join-Path $ClaudeRoot "skills\agent-browser-windows"
            }
        }
    }
    if ($Target -eq "All" -or $Target -eq "Codex") {
        $Destinations += [pscustomobject]@{
            Name = "Codex user"
            Path = Join-Path $env:USERPROFILE ".agents\skills\agent-browser-windows"
        }
    }
}

foreach ($Destination in $Destinations) {
    $DestinationPath = $Destination.Path
    $MarkerPath = Join-Path $DestinationPath $MarkerName

    if (Test-Path -LiteralPath $DestinationPath) {
        $DestinationItem = Get-Item -LiteralPath $DestinationPath -Force
        if (-not $DestinationItem.PSIsContainer) {
            throw "Skill destination exists but is not a directory: $DestinationPath"
        }
        if (($DestinationItem.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to update a symlink or junction skill destination: $DestinationPath"
        }
        if (-not (Test-Path -LiteralPath $MarkerPath -PathType Leaf) -and -not $Force) {
            throw "Refusing to overwrite an unowned skill directory: $DestinationPath. Review it, then rerun with -Force to claim this exact directory."
        }
    }
    else {
        New-Item -ItemType Directory -Path $DestinationPath -Force | Out-Null
    }

    Set-Content -LiteralPath $MarkerPath -Value "windows-agent-browser" -Encoding Ascii

    foreach ($SourceFile in Get-ChildItem -LiteralPath $SkillSource -File -Recurse) {
        $RelativePath = $SourceFile.FullName.Substring($SkillSource.Length).TrimStart([char[]]"\/")
        $DestinationFile = Join-Path $DestinationPath $RelativePath
        $DestinationDirectory = Split-Path -Parent $DestinationFile
        New-Item -ItemType Directory -Path $DestinationDirectory -Force | Out-Null
        Copy-Item -LiteralPath $SourceFile.FullName -Destination $DestinationFile -Force
    }

    Write-Host "Installed $($Destination.Name) skill:"
    Write-Host "  $DestinationPath"
}
