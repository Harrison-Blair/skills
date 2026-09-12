#!/usr/bin/env bash
# Wire this clone into the local machine, or (--sync) pull and reconcile.
#
#   scripts/setup.sh              one-time setup after clone
#   scripts/setup.sh --sync       what the session-start hooks run: pull,
#                                 re-link, and re-merge the hook entries
#   scripts/setup.sh --uninstall  remove the links and hook entries this clone
#                                 installed, leaving the clone itself alone
#
# With no clone around it -- piped from curl, or a lone downloaded copy -- the
# script first clones the repo to ${SKILLS_HOME:-~/source/skills} and hands the
# run over to that copy, so the hook it installs names a path that keeps working.
#
# Skills are linked one by one into ~/.agents/skills so machine-local skills can
# live beside them. Hooks are merged into existing config files, never replaced.
# Every statement lives in a function and the file ends with one `main "$@"`, so
# the shell parses the whole script before a pull can replace it on disk.
set -u

REPO_URL="https://github.com/Harrison-Blair/skills.git"
AGENTS_SKILLS="$HOME/.agents/skills"
# Directory holding this script's clone, empty when the script has no file to
# sit next to: piped into a shell, $0 is the shell's own name and `dirname` of
# it would silently point at whatever happens to be above the current directory.
REPO=""
[ -f "$0" ] && REPO="$(cd "$(dirname "$0")/.." && pwd -P)"
LOCK=""
STAMP=""
MODE=setup
LOCK_HELD=0

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

# A path spelled the way a junction target comes back, so the two can be
# compared: `cygpath -u` maps both C:\x and C:/x onto /c/x and leaves /c/x be.
unix_path() {
  if is_windows; then
    cygpath -u "$1" 2>/dev/null || printf '%s\n' "$1"
  else
    printf '%s\n' "$1"
  fi
}

# junction_list DIR: print "name|target" for every junction in DIR. `dir /AL`
# prints "<JUNCTION>  name [target]"; the /B form is_link uses omits the target,
# which is the only thing that says whether a junction is one of ours.
junction_list() {
  MSYS_NO_PATHCONV=1 cmd /c dir /AL "$(cygpath -w "$1")" 2>/dev/null | tr -d '\r' |
    sed -n 's/^.*<JUNCTION>[[:space:]]*\(.*\) \[\(.*\)\]$/\1|\2/p'
}

# Target a directory link records, empty when the path is not a link. Symlink
# targets come back as written (setup writes absolute ones); junction targets
# are converted to the same spelling as unix_path.
link_target() {
  local entry
  if [ -L "$1" ]; then
    readlink "$1"
    return 0
  fi
  is_windows || return 0
  junction_list "$(dirname "$1")" | while IFS= read -r entry; do
    [ "${entry%%|*}" = "$(basename "$1")" ] || continue
    unix_path "${entry#*|}"
  done
}

# Remove a directory link and nothing else. A junction needs `rmdir` -- never
# /S, which would recurse into the real directory on the other side -- while a
# symlink only needs unlinking.
unlink_dir() {
  if [ -L "$1" ]; then
    rm "$1"
  else
    MSYS_NO_PATHCONV=1 cmd /c rmdir "$(cygpath -w "$1")" >/dev/null
  fi
}

# prune_junctions DIR PREFIX: the Windows counterpart of the broken-symlink
# sweep. A junction in DIR goes only when it points under PREFIX -- that is, at
# a skill this setup linked -- and that target is gone. Junctions pointing
# anywhere else, and every real directory, are left as they are.
prune_junctions() {
  local dir="$1" prefix entry name target
  prefix="$(unix_path "$2")"
  [ -d "$dir" ] || return 0
  junction_list "$dir" | while IFS= read -r entry; do
    name="${entry%%|*}"
    target="$(unix_path "${entry#*|}")"
    [ -n "$name" ] || continue
    case "$target" in "$prefix"/*) ;; *) continue ;; esac
    [ -e "$target" ] && continue
    if unlink_dir "$dir/$name"; then
      echo "pruned: $name"
    else
      echo "warn: could not remove junction $dir/$name" >&2
    fi
  done
  return 0
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
    prune_junctions "$AGENTS_SKILLS" "$REPO/skills"
    return 0
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
    prune_junctions "$root" "$AGENTS_SKILLS"
    return 0
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
  [ -d "$HOME/.pi/agent" ] || { echo "skip: ~/.pi/agent not found (Pi)"; return 0; }
  mkdir -p "$HOME/.pi/agent/extensions"
  link_dir "$HOME/.pi/agent/extensions/skills-autopull" "$REPO/pi/skills-autopull"
}

# The command hooks run at session start, with this machine's paths baked in.
# Its shape is also what marks a hook entry as managed by this repo, so it must
# stay stable: Codex re-prompts for trust whenever the command string changes.
sync_cmd() {
  if is_windows; then
    local bash_exe
    bash_exe="$(cygpath -m "$(command -v bash)")"
    echo "\"$bash_exe\" \"$(cygpath -m "$REPO")/scripts/setup.sh\" --sync"
  else
    echo "sh \"$REPO/scripts/setup.sh\" --sync"
  fi
}

# merge_hooks FILE TEMPLATE [ACTION]: reconcile FILE's hook entries with the
# template's. Entries whose command is a `scripts/setup.sh --sync` call are
# managed by this repo: one for this clone is updated in place, one for a clone
# that is gone is removed, one for another clone that still exists is kept with
# a warning. With ACTION "remove" (uninstall) the entries for this clone are
# deleted instead and no other managed entry is touched, not even a dead one.
# Anything else in the file is left exactly as it is. Uses python3, python, or
# powershell; prints the snippet for manual paste when none is available.
merge_hooks() {
  local file="$1" template="$2" action="${3:-merge}" cmd
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
    SNIPPET="$snippet" SYNC_CMD="$cmd" HOOK_ACTION="$action" "$py" - "$file" <<'PY'
import json, os, re, sys, tempfile

path = sys.argv[1]
template = json.loads(os.environ["SNIPPET"])
removing = os.environ.get("HOOK_ACTION") == "remove"
# Managed entries end in a quoted (or bare) setup.sh path plus --sync; the
# Windows form only adds a quoted bash executable in front.
SYNC_RE = re.compile(r'([^"]*)/scripts/setup\.sh"?\s+--sync\s*$')


def clone_of(command):
    """Clone path of a hook command this repo manages, else None."""
    if not isinstance(command, str):
        return None
    match = SYNC_RE.search(command)
    if not match:
        return None
    return match.group(1).strip() or None


def normalize(text):
    return text.replace("\\", "/").rstrip("/").lower()


def clone_exists(text):
    """False only when the clone is confidently gone (Git Bash spells vary)."""
    candidates = [text]
    drive = re.match(r"^([A-Za-z]):[/\\](.*)$", text)
    if drive:
        letter, rest = drive.group(1).lower(), drive.group(2)
        candidates.append("/%s/%s" % (letter, rest))
        candidates.append("/cygdrive/%s/%s" % (letter, rest))
    return any(os.path.isdir(candidate) for candidate in candidates)


def group_clone(group):
    """Clone a whole hook group belongs to, or None to leave the group alone."""
    if not isinstance(group, dict):
        return None
    entries = group.get("hooks")
    if not isinstance(entries, list) or not entries:
        return None
    clones = [
        clone_of(entry.get("command")) if isinstance(entry, dict) else None
        for entry in entries
    ]
    if not all(clones):
        return None
    return clones[0]


self_clone = clone_of(os.environ["SYNC_CMD"])
if self_clone is None:
    print("warn: unrecognized sync command; %s left alone" % path, file=sys.stderr)
    sys.exit(0)

data = {}
try:
    if os.path.exists(path) and os.path.getsize(path) > 0:
        with open(path, encoding="utf-8") as handle:
            data = json.load(handle)
except (OSError, ValueError) as exc:
    print("warn: %s is not readable JSON; left alone: %s" % (path, exc), file=sys.stderr)
    sys.exit(0)
if not isinstance(data, dict) or not isinstance(data.get("hooks", {}), dict):
    print("warn: %s has no hooks object; left alone" % path, file=sys.stderr)
    sys.exit(0)

before = json.dumps(data, sort_keys=True)
if removing and "hooks" not in data:
    # An uninstall has nothing to take out of a file that holds no hooks, and
    # inventing one -- or an empty event list -- would leave more behind than
    # it removed. This is also the file-does-not-exist case.
    print("ok: %s already up to date" % path)
    sys.exit(0)
hooks = data.setdefault("hooks", {})
warnings = []
for event, groups in template.get("hooks", {}).items():
    if removing:
        groups = []  # every entry for this clone becomes surplus, and goes
        if event not in hooks:
            continue  # nothing of this clone's can be in an absent event
    existing = hooks.setdefault(event, [])
    if not isinstance(existing, list):
        warnings.append("warn: %s hooks.%s is not a list; left alone" % (path, event))
        continue
    mine, drop = [], []
    for index, group in enumerate(existing):
        clone = group_clone(group)
        if clone is None:
            continue  # not ours: never touched
        if normalize(clone) == normalize(self_clone):
            mine.append(index)
        elif removing:
            continue  # another clone's entry is not this clone's to clean up
        elif not clone_exists(clone):
            drop.append(index)
        else:
            warnings.append(
                "warn: %s keeps a %s hook for another clone: %s" % (path, event, clone)
            )
    for index, group in zip(mine, groups):
        existing[index] = group  # in place, so ordering around it survives
    drop.extend(mine[len(groups):])  # duplicates for this clone
    for index in sorted(drop, reverse=True):
        del existing[index]
    for group in groups[len(mine):]:
        existing.append(group)

for warning in warnings:
    print(warning, file=sys.stderr)
if json.dumps(data, sort_keys=True) == before:
    print("ok: %s already up to date" % path)
    sys.exit(0)
directory = os.path.dirname(path) or "."
os.makedirs(directory, exist_ok=True)
handle_fd, temp = tempfile.mkstemp(dir=directory, prefix=".hooks-", suffix=".json")
try:
    with os.fdopen(handle_fd, "w", encoding="utf-8") as handle:
        json.dump(data, handle, indent=2)
        handle.write("\n")
    try:
        # mkstemp makes the temp file 0600; carry the real file's mode over so
        # replacing it does not quietly tighten or loosen its permissions.
        os.chmod(temp, os.stat(path).st_mode & 0o7777)
    except OSError:
        pass  # no file there yet: 0600 is the right default for a new config
    os.replace(temp, path)  # atomic: readers never see a half-written file
except BaseException:
    if os.path.exists(temp):
        os.unlink(temp)
    raise
print("updated: %s" % path)
PY
    return
  fi

  if command -v powershell >/dev/null 2>&1; then
    SNIPPET="$snippet" SYNC_CMD="$cmd" HOOK_ACTION="$action" \
      HOOK_FILE="$(cygpath -w "$file" 2>/dev/null || echo "$file")" \
      powershell -NoProfile -Command - <<'PS'
$Path = $env:HOOK_FILE
$tpl = $env:SNIPPET | ConvertFrom-Json
$removing = $env:HOOK_ACTION -eq 'remove'
$rx = [regex]'([^"]*)/scripts/setup\.sh"?\s+--sync\s*$'
function Get-Clone($command) {
  if (-not $command) { return $null }
  $m = $rx.Match([string]$command)
  if (-not $m.Success) { return $null }
  $p = $m.Groups[1].Value.Trim()
  if ($p -eq '') { return $null }
  return $p
}
function Get-Normalized($p) {
  if (-not $p) { return $null }
  return ($p -replace '\\', '/').TrimEnd('/').ToLowerInvariant()
}
function Get-GroupClone($g) {
  $entries = @($g.hooks)
  if ($entries.Count -eq 0) { return $null }
  $first = $null
  foreach ($h in $entries) {
    $c = Get-Clone $h.command
    if (-not $c) { return $null }
    if (-not $first) { $first = $c }
  }
  return $first
}
$selfClone = Get-Normalized (Get-Clone $env:SYNC_CMD)
if (-not $selfClone) {
  [Console]::Error.WriteLine("warn: unrecognized sync command; $Path left alone")
  exit 0
}
$data = if ((Test-Path $Path) -and (Get-Item $Path).Length -gt 0) { Get-Content $Path -Raw | ConvertFrom-Json } else { [pscustomobject]@{} }
if ($removing -and -not $data.PSObject.Properties['hooks']) {
  # Nothing of this clone's can be in a file with no hooks, and writing one
  # would leave more behind than the uninstall removed.
  Write-Output "ok: $Path already up to date"
  exit 0
}
if (-not $data.PSObject.Properties['hooks']) { $data | Add-Member hooks ([pscustomobject]@{}) }
$before = $data | ConvertTo-Json -Depth 20 -Compress
foreach ($ev in $tpl.hooks.PSObject.Properties) {
  if (-not $data.hooks.PSObject.Properties[$ev.Name]) {
    if ($removing) { continue }
    $data.hooks | Add-Member $ev.Name @()
  }
  $groups = if ($removing) { @() } else { @($ev.Value) }
  $existing = [System.Collections.ArrayList]@($data.hooks.($ev.Name))
  $mine = @()
  $drop = @()
  for ($i = 0; $i -lt $existing.Count; $i++) {
    $clone = Get-GroupClone $existing[$i]
    if (-not $clone) { continue }
    if ((Get-Normalized $clone) -eq $selfClone) { $mine += $i }
    elseif ($removing) { continue }
    elseif (-not (Test-Path -LiteralPath $clone -PathType Container)) { $drop += $i }
    else { [Console]::Error.WriteLine("warn: ${Path} keeps a $($ev.Name) hook for another clone: $clone") }
  }
  for ($k = 0; $k -lt $mine.Count; $k++) {
    if ($k -lt $groups.Count) { $existing[$mine[$k]] = $groups[$k] } else { $drop += $mine[$k] }
  }
  foreach ($i in @($drop | Sort-Object -Descending)) { $existing.RemoveAt($i) }
  for ($k = $mine.Count; $k -lt $groups.Count; $k++) { $existing.Add($groups[$k]) | Out-Null }
  $data.hooks.($ev.Name) = @($existing)
}
if (($data | ConvertTo-Json -Depth 20 -Compress) -eq $before) {
  Write-Output "ok: $Path already up to date"
  exit 0
}
New-Item -ItemType Directory -Force (Split-Path $Path) | Out-Null
$temp = "$Path.new"
# WriteAllText with an explicit BOM-less UTF-8, because Set-Content -Encoding
# UTF8 on Windows PowerShell prepends a byte-order mark that strict JSON
# readers (Node's JSON.parse among them) refuse.
$json = ($data | ConvertTo-Json -Depth 20) + "`n"
[System.IO.File]::WriteAllText($temp, $json, (New-Object System.Text.UTF8Encoding $false))
Move-Item -Force -LiteralPath $temp -Destination $Path
Write-Output "updated: $Path"
PS
    return
  fi

  if [ "$action" = remove ]; then
    echo "warn: no python3, python, or powershell found; delete the entry running" >&2
    echo "        $cmd" >&2
    echo "      from $file by hand" >&2
    return
  fi
  echo "warn: no python3, python, or powershell found; add this to $file by hand:" >&2
  echo "$snippet" >&2
  echo >&2
}

# apply_hooks [ACTION]: merge (or, with "remove", strip) this repo's hook
# entries in every harness whose config directory exists.
apply_hooks() {
  local action="${1:-merge}"
  if [ -d "$HOME/.claude" ]; then
    merge_hooks "$HOME/.claude/settings.json" "$REPO/hooks/claude.json" "$action"
  fi
  if [ -d "$HOME/.codex" ]; then
    merge_hooks "$HOME/.codex/hooks.json" "$REPO/hooks/codex.json" "$action"
  elif [ "$action" = merge ]; then
    echo "skip: ~/.codex not found (Codex)"
  fi
}

release_lock() {
  [ "$LOCK_HELD" = 1 ] || return 0
  LOCK_HELD=0
  rmdir "$LOCK" 2>/dev/null || true
  return 0
}

hold_lock() {
  LOCK_HELD=1
  trap 'release_lock; exit 1' HUP INT TERM
  # Quoted so ShellCheck reads the handler as code and sees release_lock used
  # (an unquoted function name reads as a dead store: SC2317, an error in CI).
  trap 'release_lock' EXIT
}

# One run at a time: Claude, Codex and Pi can all start a session at once.
acquire_lock() {
  if [ "${SKILLS_SYNC_REEXEC:-}" = 1 ] && [ -d "$LOCK" ]; then
    hold_lock  # inherited across exec from the run that pulled; still ours
    return 0
  fi
  local waited=0 reclaimed=0
  while :; do
    if mkdir "$LOCK" 2>/dev/null; then
      hold_lock
      return 0
    fi
    # A lock left behind by an interrupted run goes stale after ~10 minutes.
    if [ "$reclaimed" = 0 ] &&
      [ -n "$(find "$LOCK" -maxdepth 0 -mmin +10 2>/dev/null)" ]; then
      reclaimed=1
      echo "warn: reclaiming stale lock $LOCK" >&2
      rmdir "$LOCK" 2>/dev/null || true
      continue
    fi
    if [ "$MODE" != --sync ] && [ "$waited" -lt 5 ]; then
      waited=$((waited + 1))
      sleep 1
      continue
    fi
    [ "$MODE" != --sync ] && echo "warn: another run holds $LOCK; nothing done" >&2
    return 1
  done
}

# The shell the hooks invoke this script with, and the one every hand-off here
# uses, so a re-exec or a bootstrap lands on the same interpreter as a session.
interpreter() {
  if is_windows; then
    command -v bash || echo bash
  else
    command -v sh || echo sh
  fi
}

# Re-run this script once from the freshly pulled copy, on the interpreter the
# hook uses. SKILLS_SYNC_REEXEC stops the new copy from pulling again, so this
# cannot loop. The lock stays held across exec; the new run adopts it.
reexec() {
  export SKILLS_SYNC_REEXEC=1
  exec "$(interpreter)" "$REPO/scripts/setup.sh" "$@"
}

# True unless DIR is confidently not a clone of this repo. The repo layout has
# to be there, and git must not report a different work-tree root -- a copied
# setup.sh sitting inside some other project. When git cannot answer at all
# (absent, or the directory has no history) the layout decides on its own:
# cloning over a working install because git broke would be the worse mistake.
looks_like_clone() {
  local top
  [ -n "$1" ] || return 1
  [ -d "$1" ] || return 1
  [ -f "$1/scripts/setup.sh" ] || return 1
  [ -d "$1/hooks" ] || return 1
  top="$(git -C "$1" rev-parse --show-toplevel 2>/dev/null)" || return 0
  [ -n "$top" ] || return 0
  [ "$(resolve "$top")" = "$(resolve "$1")" ]
}

# Nothing to wire up yet: the script arrived on its own, piped from curl or
# copied somewhere by hand. Get a real clone and hand the whole run to its copy
# of this script, so the hook it installs names a path that stays valid.
bootstrap() {
  local clone
  if [ "${SKILLS_BOOTSTRAPPED:-}" = 1 ]; then
    echo "error: bootstrap did not produce a usable clone" >&2
    return 1
  fi
  clone="${SKILLS_HOME:-$HOME/source/skills}"
  if looks_like_clone "$clone"; then
    echo "using clone: $clone"
  elif [ -e "$clone" ] || [ -L "$clone" ]; then
    echo "error: $clone exists and is not a clone of $REPO_URL; move it or set" >&2
    echo "       SKILLS_HOME to another path" >&2
    return 1
  elif [ "$MODE" = --uninstall ]; then
    echo "error: no clone at $clone to uninstall" >&2
    return 1
  else
    echo "cloning $REPO_URL into $clone"
    mkdir -p "$(dirname "$clone")" || return 1
    git clone "$REPO_URL" "$clone" || { echo "error: git clone failed" >&2; return 1; }
    looks_like_clone "$clone" || { echo "error: $clone is not usable" >&2; return 1; }
  fi
  export SKILLS_BOOTSTRAPPED=1
  exec "$(interpreter)" "$clone/scripts/setup.sh" "$@"
}

# Fast-forward the clone, then hand off to the new script if HEAD moved: bash
# reads a script as it runs it, so continuing in this process could execute a
# mix of the old and new file.
pull() {
  [ "${SKILLS_SYNC_REEXEC:-}" = 1 ] && return 0
  # Throttle: a burst of session starts should hit the network once. Spelled as
  # "not older than a minute" rather than -mmin -1 because BSD find (macOS)
  # rounds the age up to the next whole minute, which makes -mmin -1 false for
  # everything but a stamp written this very second.
  if [ -n "$(find "$STAMP" -maxdepth 0 ! -mmin +1 2>/dev/null)" ]; then
    return 0
  fi
  local before after
  before="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
  GIT_TERMINAL_PROMPT=0 git -C "$REPO" pull --ff-only --quiet >/dev/null 2>&1 || true
  touch "$STAMP" 2>/dev/null || true
  after="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo unknown)"
  [ "$before" != unknown ] || return 0
  [ "$after" != unknown ] || return 0
  [ "$before" != "$after" ] || return 0
  reexec "$@"
}

# Everything setup and --sync both do; --sync just runs it without the chatter.
reconcile() {
  echo "repo: $REPO"
  link_skills
  link_claude_skills
  link_pi
  apply_hooks merge
  return 0
}

# Undo what this clone installed, and only that: a link goes when the target it
# records is inside this clone -- or, in Claude's directory, is an
# ~/.agents/skills entry that is itself one of those links. Real directories,
# links pointing anywhere else, and hooks this repo did not write all stay.
uninstall() {
  local root="$HOME/.claude/skills" repo_skills agents pi d name
  repo_skills="$(unix_path "$REPO/skills")"
  agents="$(unix_path "$AGENTS_SKILLS")"
  echo "repo: $REPO"
  if [ "$(link_target "$root")" = "$agents" ]; then
    # The pre-split whole-directory link; unlinking leaves the shared dir whole.
    unlink_dir "$root" && echo "removed: $root"
  elif [ -d "$root" ]; then
    # Claude's links go first: each names an ~/.agents/skills entry that the
    # next loop deletes, and a vanished entry can no longer vouch for them.
    for d in "$root"/*; do
      name="$(basename "$d")"
      [ "$(link_target "$d")" = "$agents/$name" ] || continue
      case "$(link_target "$AGENTS_SKILLS/$name")" in
        "$repo_skills"/*) ;;
        *) continue ;;
      esac
      unlink_dir "$d" && echo "removed: $d"
    done
  fi
  for d in "$AGENTS_SKILLS"/*; do
    case "$(link_target "$d")" in
      "$repo_skills"/*) unlink_dir "$d" && echo "removed: $d" ;;
    esac
  done
  pi="$HOME/.pi/agent/extensions/skills-autopull"
  if [ "$(link_target "$pi")" = "$(unix_path "$REPO/pi/skills-autopull")" ]; then
    unlink_dir "$pi" && echo "removed: $pi"
  fi
  apply_hooks remove
  echo "kept: the clone at $REPO, and every local skill and hook"
  return 0
}

next_steps() {
  cat <<MSG

Next steps:
  - Codex: open Codex and run /hooks to review and trust the new SessionStart hook.
  - Cursor: enable "Third-party skills" (Settings > Rules, Skills, Subagents) so it
    runs the hook from ~/.claude/settings.json.
  - Machine-local shared skills: plain directories in $AGENTS_SKILLS.
  - Harness-local skills: plain directories in each harness's own skills directory.
MSG
}

main() {
  MODE="${1:-setup}"
  case "$MODE" in
    setup | --sync | --uninstall) ;;
    *) echo "usage: $0 [--sync | --uninstall]" >&2; exit 2 ;;
  esac

  looks_like_clone "$REPO" || bootstrap "$@" || exit 1
  LOCK="$REPO/.sync.lock"
  STAMP="$REPO/.sync-stamp"
  if ! acquire_lock; then
    # --sync runs at session start and must never fail one.
    [ "$MODE" = --sync ] && exit 0
    exit 1
  fi

  case "$MODE" in
    --uninstall) uninstall ;;
    --sync) pull "$MODE"; reconcile >/dev/null ;;
    setup) pull "$MODE"; reconcile; next_steps ;;
  esac
  # Returning rather than exiting: `main "$@"` is the last line, so the status
  # is the same, and an `exit` here would make ShellCheck read everything the
  # EXIT trap runs as dead code (SC2317, an error in CI).
  return 0
}

main "$@"
