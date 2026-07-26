#!/usr/bin/env bash
set -euo pipefail

install_claude=false
force=false

usage() {
  echo "Usage: bash scripts/install-wsl.sh [--with-claude] [--force]"
  echo "Installs the WSL bridge and the Codex user skill."
}

while (($# > 0)); do
  case "$1" in
    --with-claude)
      install_claude=true
      ;;
    --force)
      force=true
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      echo "install-wsl.sh: unknown argument: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
  shift
done

if [[ -z "${HOME-}" || "$HOME" != /* ]]; then
  echo "install-wsl.sh: HOME must be an absolute Linux path." >&2
  exit 2
fi

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
project_root=$(cd -- "$script_dir/.." && pwd)
skill_source="$project_root/skills/agent-browser-windows"
bridge_source="$script_dir/agent-browser-wsl"
marker_name=.installed-by-windows-agent-browser

if [[ ! -f "$skill_source/SKILL.md" || ! -f "$bridge_source" ]]; then
  echo "install-wsl.sh: run this installer from a complete windows-agent-browser checkout." >&2
  exit 2
fi

install_skill() {
  local name=$1
  local destination=$2
  local marker="$destination/$marker_name"

  if [[ -L "$destination" ]]; then
    echo "install-wsl.sh: refusing to update a symlink skill destination: $destination" >&2
    exit 1
  fi
  if [[ -e "$destination" && ! -d "$destination" ]]; then
    echo "install-wsl.sh: skill destination is not a directory: $destination" >&2
    exit 1
  fi
  if [[ -d "$destination" && ! -f "$marker" && "$force" != true ]]; then
    echo "install-wsl.sh: refusing to overwrite unowned skill directory: $destination" >&2
    echo "Review it, then rerun with --force to claim this exact directory." >&2
    exit 1
  fi

  mkdir -p -- "$destination"
  printf '%s\n' windows-agent-browser > "$marker"
  cp -R -- "$skill_source/." "$destination/"
  echo "Installed $name skill:"
  echo "  $destination"
}

bin_dir="$HOME/.local/bin"
bridge_destination="$bin_dir/agent-browser"
bridge_marker="$bin_dir/.agent-browser-installed-by-windows-agent-browser"

if [[ -L "$bridge_destination" ]]; then
  echo "install-wsl.sh: refusing to update a symlink command: $bridge_destination" >&2
  exit 1
fi
if [[ -e "$bridge_destination" && ! -f "$bridge_marker" && "$force" != true ]]; then
  echo "install-wsl.sh: refusing to overwrite unowned command: $bridge_destination" >&2
  echo "Review it, then rerun with --force to claim this exact file." >&2
  exit 1
fi

mkdir -p -- "$bin_dir"
printf '%s\n' windows-agent-browser > "$bridge_marker"
install -m 0755 -- "$bridge_source" "$bridge_destination"

install_skill "Codex user" "$HOME/.agents/skills/agent-browser-windows"
if [[ "$install_claude" == true ]]; then
  install_skill "Claude Code user" "$HOME/.claude/skills/agent-browser-windows"
fi

echo "Installed WSL bridge:"
echo "  $bridge_destination"
if [[ ":${PATH-}:" != *":$bin_dir:"* ]]; then
  echo "Add $bin_dir to PATH before starting Codex or Claude Code."
fi
echo "Windows agent-browser.cmd must already be installed on the Windows PATH."
