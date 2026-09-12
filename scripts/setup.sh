#!/usr/bin/env bash
# Wire this clone into the local machine, or (--sync) pull and re-link.
#
#   scripts/setup.sh          one-time setup after clone (re-run after adding hooks)
#   scripts/setup.sh --sync   pull the repo, re-link skills and the Pi extension
#
# Skills are linked one by one into ~/.agents/skills so machine-local skills can
# live beside them. Hooks are merged into existing config files, never replaced.
set -u

REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
AGENTS_SKILLS="$HOME/.agents/skills"
MODE="${1:-setup}"

is_windows() {
  case "$(uname -s)" in MINGW*|MSYS*|CYGWIN*) return 0 ;; *) return 1 ;; esac
}

# Physical path of a link target (or of a plain path).
resolve() { (cd "$1" 2>/dev/null && pwd -P); }

# True for a symlink, or on Windows a junction (listed by `dir /AL`).
is_link() {
  [ -L "$1" ] && return 0
  is_windows && [ -d "$1" ] &&
    MSYS_NO_PATHCONV=1 cmd /c dir /AL /B "$(cygpath -w "$(dirname "$1")")" 2>/dev/null |
    tr -d '\r' | grep -Fxq -- "$(basename "$1")"
}

# link_dir LINK TARGET: create a directory link; never delete anything real.
link_dir() {
  local link="$1" target="$2"
  [ -d "$target" ] || { echo "skip: missing target $target" >&2; return 1; }
  if [ -e "$link" ] || [ -L "$link" ]; then
    if is_link "$link" && [ "$(resolve "$link")" = "$(resolve "$target")" ]; then
      return 0
    fi
    echo "warn: $link exists and is not a link to $target; left untouched" >&2
    return 1
  fi
  mkdir -p "$(dirname "$link")"
  if is_windows; then
    # Junction: no admin rights needed, absolute Windows paths required.
    # Pass as separate argv entries -- wrapping this in one quoted string for
    # `cmd /c` trips a cmd.exe re-quoting bug ("filename... is incorrect")
    # once more than one quoted path is embedded in it.
    MSYS_NO_PATHCONV=1 cmd /c mklink /J "$(cygpath -w "$link")" "$(cygpath -w "$target")" >/dev/null
  else
    ln -s "$target" "$link"
  fi
}

# Link every repo skill into ~/.agents/skills; prune links to removed skills.
link_skills() {
  mkdir -p "$AGENTS_SKILLS"
  local d name
  for d in "$REPO"/skills/*/; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    link_dir "$AGENTS_SKILLS/$name" "${d%/}"
  done
  if is_windows; then
    return 0  # junction detection is unreliable in bash; leave pruning to the user
  fi
  for d in "$AGENTS_SKILLS"/*; do
    [ -L "$d" ] || continue
    case "$(readlink "$d")" in
      "$REPO"/skills/*) [ -e "$d" ] || { rm "$d"; echo "pruned: $(basename "$d")"; } ;;
    esac
  done
}

link_claude_skills() {
  [ -d "$HOME/.claude" ] || { echo "skip: ~/.claude not found (Claude Code)"; return 0; }
  local root="$HOME/.claude/skills" target d name
  target="$(resolve "$AGENTS_SKILLS")" || return 1
  if is_link "$root"; then
    if [ "$(resolve "$root")" != "$target" ]; then
      echo "warn: $root is not a link to $AGENTS_SKILLS; left untouched" >&2
      return 1
    fi
    # Migrate the old whole-directory link without touching its contents.
    # A Windows junction needs rmdir (never /S); a symlink only needs unlinking.
    if [ -L "$root" ]; then
      rm "$root" || return 1
    else
      MSYS_NO_PATHCONV=1 cmd /c rmdir "$(cygpath -w "$root")" || return 1
    fi
  elif [ -e "$root" ] && [ ! -d "$root" ]; then
    echo "warn: $root is not a directory; left untouched" >&2
    return 1
  fi
  mkdir -p "$root" || return 1
  for d in "$AGENTS_SKILLS"/*; do
    [ -d "$d" ] || continue
    name="$(basename "$d")"
    link_dir "$root/$name" "$d"
  done
  if is_windows; then
    return 0  # as with repo skills, stale junction cleanup remains manual
  fi
  for d in "$root"/*; do
    [ -L "$d" ] || continue
    name="$(basename "$d")"
    if [ "$(readlink "$d")" = "$AGENTS_SKILLS/$name" ] && [ ! -e "$d" ]; then
      rm "$d" && echo "pruned: claude/$name"
    fi
  done
}

link_pi() {
  [ -d "$HOME/.pi/agent" ] || { [ "$MODE" = setup ] && echo "skip: ~/.pi/agent not found (Pi)"; return 0; }
  mkdir -p "$HOME/.pi/agent/extensions"
  link_dir "$HOME/.pi/agent/extensions/skills-autopull" "$REPO/pi/skills-autopull"
}

# The command hooks run at session start, with this machine's paths baked in.
sync_cmd() {
  if is_windows; then
    local bash_exe
    bash_exe="$(cygpath -m "$(command -v bash)")"
    echo "\"$bash_exe\" \"$(cygpath -m "$REPO")/scripts/setup.sh\" --sync"
  else
    echo "sh \"$REPO/scripts/setup.sh\" --sync"
  fi
}

# merge_hooks FILE TEMPLATE: add the template's hook entries to FILE unless an
# entry with the same command is already there. Uses python3, python, or
# powershell; prints the snippet for manual paste when none is available.
merge_hooks() {
  local file="$1" template="$2" cmd
  cmd="$(sync_cmd)"
  # JSON-escape the command (backslashes, quotes), then sed-escape it.
  local cmd_json snippet
  cmd_json="$(printf '%s' "$cmd" | sed 's/\\/\\\\/g; s/"/\\"/g')"
  snippet="$(sed "s|__SYNC_CMD__|$(printf '%s' "$cmd_json" | sed 's/[\\&|]/\\&/g')|" "$template")"

  local py=""
  if command -v python3 >/dev/null 2>&1; then py=python3
  elif command -v python >/dev/null 2>&1; then py=python
  fi

  if [ -n "$py" ]; then
    SNIPPET="$snippet" "$py" - "$file" <<'PY'
import json, os, sys
path = sys.argv[1]
tpl = json.loads(os.environ["SNIPPET"])
data = {}
if os.path.exists(path) and os.path.getsize(path) > 0:
    with open(path, encoding="utf-8") as f:
        data = json.load(f)
before = json.dumps(data, sort_keys=True)
hooks = data.setdefault("hooks", {})
for event, groups in tpl.get("hooks", {}).items():
    existing = hooks.setdefault(event, [])
    present = {h.get("command") for g in existing for h in g.get("hooks", [])}
    for g in groups:
        if any(h.get("command") in present for h in g.get("hooks", [])):
            continue
        existing.append(g)
if json.dumps(data, sort_keys=True) == before:
    print(f"ok: {path} already up to date")
    sys.exit(0)
os.makedirs(os.path.dirname(path), exist_ok=True)
with open(path, "w", encoding="utf-8") as f:
    json.dump(data, f, indent=2)
    f.write("\n")
print(f"updated: {path}")
PY
    return
  fi

  if command -v powershell >/dev/null 2>&1; then
    SNIPPET="$snippet" HOOK_FILE="$(cygpath -w "$file" 2>/dev/null || echo "$file")" powershell -NoProfile -Command - <<'PS'
$Path = $env:HOOK_FILE
$tpl = $env:SNIPPET | ConvertFrom-Json
$data = if ((Test-Path $Path) -and (Get-Item $Path).Length -gt 0) { Get-Content $Path -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
if (-not $data.PSObject.Properties['hooks']) { $data | Add-Member hooks ([pscustomobject]@{}) }
$changed = $false
foreach ($ev in $tpl.hooks.PSObject.Properties) {
  if (-not $data.hooks.PSObject.Properties[$ev.Name]) { $data.hooks | Add-Member $ev.Name @() }
  $existing = @($data.hooks.($ev.Name))
  $present = @($existing | ForEach-Object { $_.hooks } | ForEach-Object { $_.command })
  foreach ($g in $ev.Value) {
    $dup = $false
    foreach ($h in $g.hooks) { if ($present -contains $h.command) { $dup = $true } }
    if (-not $dup) { $existing += $g; $changed = $true }
  }
  $data.hooks.($ev.Name) = $existing
}
if (-not $changed) { Write-Output "ok: $Path already up to date"; exit 0 }
New-Item -ItemType Directory -Force (Split-Path $Path) | Out-Null
$data | ConvertTo-Json -Depth 20 | Set-Content $Path -Encoding UTF8
Write-Output "updated: $Path"
PS
    return
  fi

  echo "warn: no python3, python, or powershell found; add this to $file by hand:" >&2
  echo "$snippet" >&2
  echo >&2
}

pull() {
  GIT_TERMINAL_PROMPT=0 git -C "$REPO" pull --ff-only --quiet >/dev/null 2>&1 || true
}

case "$MODE" in
  --sync)
    pull
    link_skills >/dev/null
    link_claude_skills >/dev/null
    link_pi >/dev/null
    exit 0
    ;;
  setup)
    echo "repo: $REPO"
    link_skills
    link_claude_skills
    link_pi
    if [ -d "$HOME/.claude" ]; then
      merge_hooks "$HOME/.claude/settings.json" "$REPO/hooks/claude.json"
    fi
    if [ -d "$HOME/.codex" ]; then
      merge_hooks "$HOME/.codex/hooks.json" "$REPO/hooks/codex.json"
    else
      echo "skip: ~/.codex not found (Codex)"
    fi
    cat <<MSG

Next steps:
  - Codex: open Codex and run /hooks to review and trust the new SessionStart hook.
  - Cursor: enable "Third-party skills" (Settings > Rules, Skills, Subagents) so it
    runs the hook from ~/.claude/settings.json.
  - Machine-local shared skills: plain directories in $AGENTS_SKILLS.
  - Harness-local skills: plain directories in each harness's own skills directory.
  - After adding hooks to hooks/*.json, re-run this script on each machine.
MSG
    ;;
  *)
    echo "usage: $0 [--sync]" >&2
    exit 2
    ;;
esac
