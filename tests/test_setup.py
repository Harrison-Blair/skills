"""Filesystem regression tests: python3 -m unittest discover -s tests -v.

Fixtures redirect the script's home references to SKILLS_TEST_HOME rather than
changing HOME or touching the user's actual configuration. Windows command
boundaries are simulated; native junction behavior needs a Git Bash smoke test.
"""

import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import time
import unittest


SOURCE = Path(__file__).resolve().parents[1]

# Offline stand-in for git. Every fixture repo is a plain directory, so the
# work-tree probe has to be answered for the script to accept it as a clone.
STUB_GIT = r"""#!/bin/sh
[ "$3" = rev-parse ] && [ "$4" = --show-toplevel ] && { echo "$2"; exit 0; }
exit 1
"""

# A fake git whose pull moves HEAD and rewrites the script, so the sync has to
# hand off to the new copy. The inserted line records every run of that copy.
REEXEC_GIT = r"""#!/bin/sh
repo="$2"
state="$repo/.pulled"
case "$3 ${4:-}" in
  "rev-parse --show-toplevel") echo "$repo" ;;
  "rev-parse HEAD") if [ -e "$state" ]; then echo 2222222; else echo 1111111; fi ;;
  pull*)
    : > "$state"
    awk 'BEGIN { patched = 0 }
      /^main "\$@"$/ && patched == 0 {
        print "printf reexec >> \"$SKILLS_TEST_HOME/reexec-marker\""
        patched = 1
      }
      { print }' "$repo/scripts/setup.sh" > "$repo/scripts/setup.new"
    mv "$repo/scripts/setup.new" "$repo/scripts/setup.sh"
    chmod +x "$repo/scripts/setup.sh"
    ;;
  *) exit 1 ;;
esac
"""

# A fake git that records every pull, so the network throttle can be observed.
COUNTING_GIT = r"""#!/bin/sh
[ "$3" = rev-parse ] && [ "$4" = --show-toplevel ] && { echo "$2"; exit 0; }
[ "$3" = rev-parse ] && [ "$4" = HEAD ] && { echo 1111111; exit 0; }
[ "$3" = pull ] && { printf 'pull\n' >> "$SKILLS_TEST_HOME/pulls"; exit 0; }
exit 1
"""

# A fake git that "clones" by copying the fixture repo, so bootstrap can be
# exercised without a network. It records the URL it was asked for.
BOOTSTRAP_GIT = r"""#!/bin/sh
if [ "$1" = clone ]; then
  printf '%s\n' "$2" > "$SKILLS_TEST_HOME/cloned-url"
  cp -R "$SKILLS_FIXTURE" "$3" || exit 1
  exit 0
fi
[ "$3" = rev-parse ] && [ "$4" = --show-toplevel ] && { echo "$2"; exit 0; }
exit 1
"""


class SetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="skills setup ")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.repo = self.base / "repo"
        self.home = self.base / "home"
        self.shared = self.home / ".agents/skills"
        self.claude = self.home / ".claude/skills"
        self.shared.mkdir(parents=True)
        self.claude.parent.mkdir(parents=True)
        (self.repo / "scripts").mkdir(parents=True)
        shutil.copytree(SOURCE / "hooks", self.repo / "hooks")
        self.script = self.repo / "scripts/setup.sh"
        self.script.write_text(
            (SOURCE / "scripts/setup.sh").read_text().replace(
                "$HOME", "$SKILLS_TEST_HOME"
            )
        )
        self.env = dict(os.environ, SKILLS_TEST_HOME=str(self.home))
        # Sync exercises the real linking flow with a deterministic offline pull.
        bin_dir = self.base / "bin"
        bin_dir.mkdir()
        git = bin_dir / "git"
        git.write_text(STUB_GIT)
        git.chmod(0o755)
        self.env["PATH"] = str(bin_dir) + os.pathsep + self.env["PATH"]
        self.skill = self.add_skill(self.repo / "skills/shared-one")
        (self.repo / "pi/skills-autopull").mkdir(parents=True)
        (self.repo / "pi/mockup").mkdir(parents=True)

    def add_skill(self, path):
        path.mkdir(parents=True)
        (path / "SKILL.md").write_text("local contents must survive\n")
        return path

    def run_setup(self, mode="setup", shell="bash"):
        result = subprocess.run(
            [shell, str(self.script), mode], env=self.env,
            text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stderr)
        return result

    def sync_command(self, repo=None):
        """The hook command line setup.sh writes for a clone."""
        return 'sh "%s/scripts/setup.sh" --sync' % Path(repo or self.repo).resolve()

    def hook_commands(self, path, event="SessionStart"):
        data = json.loads(Path(path).read_text())
        return [h["command"] for g in data["hooks"][event] for h in g["hooks"]]

    def assert_shared_link(self):
        self.assertTrue(self.claude.is_dir())
        self.assertFalse(self.claude.is_symlink())
        self.assertEqual(
            (self.claude / "shared-one").readlink(), self.shared / "shared-one"
        )
        self.assertEqual((self.claude / "shared-one").resolve(), self.skill.resolve())

    def test_fresh_setup_and_repeat_preserve_hooks(self):
        settings = self.claude.parent / "settings.json"
        settings.write_text('{"hooks": {}, "custom": "keep"}\n')
        self.run_setup()
        self.assert_shared_link()
        first_settings = settings.read_bytes()
        self.run_setup()
        self.assert_shared_link()
        self.assertEqual(settings.read_bytes(), first_settings)
        self.assertIn('"custom": "keep"', settings.read_text())

    def test_legacy_symlink_migrates_on_setup_and_sync(self):
        local = self.add_skill(self.shared / "machine-shared")
        for mode in ("setup", "--sync"):
            with self.subTest(mode=mode):
                self.claude.symlink_to(self.shared, target_is_directory=True)
                self.run_setup(mode)
                self.assert_shared_link()
                self.assertEqual((self.claude / local.name).resolve(), local.resolve())
                self.assertEqual((local / "SKILL.md").read_text(),
                                 "local contents must survive\n")
                shutil.rmtree(self.claude)

    def test_existing_local_folders_and_conflicts_survive(self):
        local = self.add_skill(self.claude / "claude-only")
        conflict = self.add_skill(self.claude / "shared-one")
        shared_conflict = self.add_skill(self.shared / "shared-one")
        for mode in ("setup", "--sync"):
            result = self.run_setup(mode)
            self.assertIn("left untouched", result.stderr)
            for path in (local, conflict, shared_conflict):
                self.assertFalse(path.is_symlink())
                self.assertEqual((path / "SKILL.md").read_text(),
                                 "local contents must survive\n")
        self.assertFalse((self.shared / "claude-only").exists())
        self.assertFalse((self.repo / "skills/claude-only").exists())

    def test_sync_adds_shared_skills_and_prunes_only_managed_links(self):
        self.run_setup()
        external = self.add_skill(self.base / "external")
        (self.claude / "external").symlink_to(external)
        (self.claude / "unrelated-broken").symlink_to(self.base / "missing")
        (self.claude / "different-name").symlink_to(self.shared / "missing")
        (self.shared / "unrelated-broken").symlink_to(self.base / "missing")
        local = self.add_skill(self.claude / "claude-only")
        shared_local = self.add_skill(self.shared / "machine-shared")
        added = self.add_skill(self.repo / "skills/new-skill")
        shutil.rmtree(self.skill)
        self.run_setup("--sync")
        self.assertFalse((self.shared / "shared-one").is_symlink())
        self.assertFalse((self.claude / "shared-one").is_symlink())
        self.assertEqual((self.claude / "new-skill").resolve(), added.resolve())
        self.assertEqual((self.claude / shared_local.name).resolve(), shared_local.resolve())
        self.assertEqual((self.claude / "external").resolve(), external.resolve())
        for name in ("unrelated-broken", "different-name"):
            self.assertTrue((self.claude / name).is_symlink())
        self.assertTrue((self.shared / "unrelated-broken").is_symlink())
        self.assertTrue((local / "SKILL.md").is_file())

    def test_unrelated_root_symlinks_are_never_followed(self):
        for exists in (True, False):
            with self.subTest(exists=exists):
                target = self.base / ("external" if exists else "missing")
                if exists:
                    self.add_skill(target)
                self.claude.symlink_to(target, target_is_directory=True)
                result = self.run_setup("--sync")
                self.assertIn("left untouched", result.stderr)
                self.assertEqual(self.claude.readlink(), target)
                self.assertFalse((target / "shared-one").exists())
                self.claude.unlink()

    def test_conflicting_external_links_are_preserved(self):
        self.claude.mkdir()
        for exists in (True, False):
            with self.subTest(exists=exists):
                target = self.base / ("external" if exists else "missing")
                if exists:
                    self.add_skill(target)
                link = self.claude / "shared-one"
                link.symlink_to(target, target_is_directory=True)
                result = self.run_setup("--sync")
                self.assertIn("left untouched", result.stderr)
                self.assertEqual(link.readlink(), target)
                link.unlink()

    def test_file_in_place_of_root_is_preserved(self):
        self.claude.write_text("preserve")
        result = self.run_setup()
        self.assertIn("left untouched", result.stderr)
        self.assertEqual(self.claude.read_text(), "preserve")

    def test_missing_claude_is_not_created(self):
        self.claude.parent.rmdir()
        self.run_setup("--sync")
        self.assertFalse(self.claude.parent.exists())

    def test_sh_hook_entrypoint(self):
        self.claude.symlink_to(self.shared, target_is_directory=True)
        self.run_setup("--sync", shell="sh")
        self.assert_shared_link()

    def test_sync_merges_hooks_into_both_harness_files(self):
        (self.home / ".codex").mkdir()
        settings = self.claude.parent / "settings.json"
        codex = self.home / ".codex/hooks.json"
        result = self.run_setup("--sync")
        self.assertEqual(result.stdout, "")
        for path in (settings, codex):
            self.assertEqual(self.hook_commands(path), [self.sync_command()])
        entry = json.loads(codex.read_text())["hooks"]["SessionStart"][0]
        self.assertTrue(entry["hooks"][0]["async"])

    def test_managed_hook_entry_is_updated_and_others_left_alone(self):
        settings = self.claude.parent / "settings.json"
        unmanaged = {"matcher": "startup",
                     "hooks": [{"type": "command", "command": "echo local"}]}
        outdated = {"matcher": "*",
                    "hooks": [{"type": "command", "command": self.sync_command(),
                               "timeout": 5}]}
        settings.write_text(json.dumps(
            {"hooks": {"SessionStart": [unmanaged, outdated]}, "custom": "keep"}
        ))
        self.run_setup("--sync")
        data = json.loads(settings.read_text())
        self.assertEqual(data["custom"], "keep")
        groups = data["hooks"]["SessionStart"]
        self.assertEqual(groups[0], unmanaged)
        self.assertEqual(groups[1], {"matcher": "startup", "hooks": [
            {"type": "command", "command": self.sync_command(), "timeout": 30}]})
        self.assertEqual(len(groups), 2)
        first = settings.read_bytes()
        self.run_setup("--sync")
        self.assertEqual(settings.read_bytes(), first)

    def test_hook_file_permissions_survive_a_rewrite(self):
        settings = self.claude.parent / "settings.json"
        settings.write_text('{"hooks": {}}\n')
        settings.chmod(0o644)
        self.run_setup("--sync")
        self.assertEqual(self.hook_commands(settings), [self.sync_command()])
        # The merge writes a temp file and renames it; the mode of the file it
        # replaces has to come along, not the 0600 a temp file is born with.
        self.assertEqual(settings.stat().st_mode & 0o777, 0o644)

    def test_unusable_hook_files_are_left_alone_without_failing_a_session(self):
        settings = self.claude.parent / "settings.json"
        for content in ("   \n\t\n", "[1, 2]", '"text"', "{", '{"hooks": null}',
                        '{"hooks": [1, 2]}',
                        '{"hooks": {"SessionStart": {"not": "a list"}}}'):
            with self.subTest(content=content):
                settings.write_text(content)
                result = self.run_setup("--sync")  # a session must not fail
                self.assertEqual(settings.read_text(), content)
                self.assertEqual(result.stdout, "")
                self.assertNotIn("Traceback", result.stderr)
                # No half-written temp file from the atomic replace is left.
                self.assertEqual(list(settings.parent.glob(".hooks-*")), [])

    def test_duplicate_managed_entries_collapse_to_one(self):
        settings = self.claude.parent / "settings.json"
        entry = {"hooks": [{"type": "command", "command": self.sync_command()}]}
        settings.write_text(json.dumps({"hooks": {"SessionStart": [entry, entry]}}))
        self.run_setup("--sync")
        self.assertEqual(self.hook_commands(settings), [self.sync_command()])

    def test_entry_for_a_missing_clone_goes_and_a_live_one_stays(self):
        settings = self.claude.parent / "settings.json"
        other = self.base / "other-clone"
        (other / "scripts").mkdir(parents=True)
        gone = self.sync_command(self.base / "gone")
        live = self.sync_command(other)
        settings.write_text(json.dumps({"hooks": {"SessionStart": [
            {"matcher": "startup", "hooks": [{"type": "command", "command": gone}]},
            {"matcher": "startup", "hooks": [{"type": "command", "command": live}]},
        ]}}))
        result = self.run_setup("--sync")
        self.assertEqual(self.hook_commands(settings), [live, self.sync_command()])
        self.assertIn("another clone", result.stderr)

    def test_a_pull_that_moves_head_reexecs_the_new_script_once(self):
        git = self.base / "bin/git"
        git.write_text(REEXEC_GIT)
        git.chmod(0o755)
        self.run_setup("--sync")
        self.assert_shared_link()
        self.assertEqual((self.home / "reexec-marker").read_text(), "reexec")
        self.assertFalse((self.repo / ".sync.lock").exists())

    def test_a_fresh_lock_makes_sync_do_nothing(self):
        lock = self.repo / ".sync.lock"
        lock.mkdir()
        result = self.run_setup("--sync")
        self.assertEqual(result.stdout, "")
        self.assertEqual(result.stderr, "")
        self.assertFalse((self.shared / "shared-one").exists())
        self.assertTrue(lock.is_dir())

    def test_a_recent_stamp_skips_the_network_pull(self):
        git = self.base / "bin/git"
        git.write_text(COUNTING_GIT)
        git.chmod(0o755)
        pulls = self.home / "pulls"
        stamp = self.repo / ".sync-stamp"
        self.run_setup("--sync")
        self.assertEqual(pulls.read_text().count("pull"), 1)
        self.assertTrue(stamp.is_file())
        # Half a minute old is inside the throttle window. BSD find (macOS)
        # rounds an age up to the next whole minute, so the window has to be
        # spelled as "not older than a minute" to hold here at all.
        recent = time.time() - 30
        os.utime(stamp, (recent, recent))
        self.run_setup("--sync")
        self.assertEqual(pulls.read_text().count("pull"), 1)
        # Well outside it: the next session start fetches again.
        old = time.time() - 600
        os.utime(stamp, (old, old))
        self.run_setup("--sync")
        self.assertEqual(pulls.read_text().count("pull"), 2)

    def test_a_stale_lock_is_reclaimed(self):
        lock = self.repo / ".sync.lock"
        lock.mkdir()
        stale = time.time() - 3600
        os.utime(lock, (stale, stale))
        result = self.run_setup("--sync")
        self.assertIn("stale lock", result.stderr)
        self.assert_shared_link()
        self.assertFalse(lock.exists())

    def add_command(self, skill, name, output):
        target = skill / "bin" / name
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text("#!/bin/sh\necho %s \"$@\"\n" % output)
        target.chmod(0o755)
        return target

    def test_skill_commands_get_wrappers_on_path(self):
        self.add_command(self.skill, "hello", "hi")
        bin_dir = self.home / ".local/bin"
        result = self.run_setup()
        wrapper = bin_dir / "hello"
        run = subprocess.run([str(wrapper), "there"], text=True, capture_output=True)
        self.assertEqual(run.stdout, "hi there\n")
        self.assertIn("not on PATH", result.stderr)
        before = wrapper.stat().st_mtime_ns
        self.run_setup("--sync")
        self.assertEqual(wrapper.stat().st_mtime_ns, before, "unchanged wrappers are not rewritten")

    def test_foreign_files_and_live_clones_keep_their_command_names(self):
        bin_dir = self.home / ".local/bin"
        bin_dir.mkdir(parents=True)
        (bin_dir / "mine").write_text("#!/bin/sh\necho local\n")
        other = self.add_command(self.add_skill(self.base / "other/skills/x"), "theirs", "other")
        (bin_dir / "theirs").write_text("#!/bin/sh\n# skills repo command: %s\nexec \"%s\" \"$@\"\n" % (other, other))
        (bin_dir / "stale").write_text("#!/bin/sh\n# skills repo command: /gone/skills/x/bin/stale\nexec /gone \"$@\"\n")
        for name in ("mine", "theirs", "stale"):
            self.add_command(self.skill, name, "ours")
        result = self.run_setup()
        self.assertEqual((bin_dir / "mine").read_text(), "#!/bin/sh\necho local\n")
        self.assertIn(str(other), (bin_dir / "theirs").read_text())
        self.assertIn(str(self.repo), (bin_dir / "stale").read_text(), "a dead clone's wrapper is taken over")
        self.assertIn("mine exists and is not a skills command wrapper", result.stderr)
        self.assertIn("from another clone", result.stderr)

    def test_removed_commands_are_pruned_and_uninstall_removes_the_rest(self):
        gone = self.add_command(self.skill, "gone", "x")
        self.add_command(self.skill, "kept", "y")
        bin_dir = self.home / ".local/bin"
        self.run_setup()
        (bin_dir / "unrelated").write_text("#!/bin/sh\n")
        gone.unlink()
        self.run_setup("--sync")
        self.assertFalse((bin_dir / "gone").exists())
        self.assertTrue((bin_dir / "kept").exists())
        self.run_setup("--uninstall")
        self.assertFalse((bin_dir / "kept").exists())
        self.assertTrue((bin_dir / "unrelated").exists())

    def test_uninstall_removes_only_what_setup_installed(self):
        (self.home / ".codex").mkdir()
        extensions = self.home / ".pi/agent/extensions"
        extensions.parent.mkdir(parents=True)
        settings = self.claude.parent / "settings.json"
        unmanaged = {"matcher": "startup",
                     "hooks": [{"type": "command", "command": "echo local"}]}
        settings.write_text(json.dumps(
            {"hooks": {"SessionStart": [unmanaged]}, "custom": "keep"}
        ))
        # A machine-local shared skill: Claude gets a link to it, but the link
        # vouches for nothing inside the clone, so it is not this repo's to drop.
        shared_local = self.add_skill(self.shared / "machine-shared")
        self.run_setup()
        self.assertTrue((self.claude / "shared-one").is_symlink())
        self.assertTrue((self.claude / "machine-shared").is_symlink())
        # Every folder under pi/ is linked as an extension of the same name.
        self.assertTrue((extensions / "skills-autopull").is_symlink())
        self.assertTrue((extensions / "mockup").is_symlink())
        # Everything below is somebody else's and has to come through untouched.
        local = self.add_skill(self.claude / "claude-only")
        external = self.add_skill(self.base / "external")
        (self.shared / "external").symlink_to(external)
        (self.claude / "external").symlink_to(external)

        result = self.run_setup("--uninstall")
        self.assertIn("removed:", result.stdout)
        for gone in (self.claude / "shared-one", self.shared / "shared-one",
                     extensions / "skills-autopull", extensions / "mockup"):
            self.assertFalse(gone.is_symlink(), gone)
            self.assertFalse(gone.exists(), gone)
        self.assertTrue(self.claude.is_dir())
        self.assertTrue((self.skill / "SKILL.md").is_file())
        self.assertTrue((local / "SKILL.md").is_file())
        self.assertTrue((shared_local / "SKILL.md").is_file())
        self.assertTrue((external / "SKILL.md").is_file())
        self.assertEqual((self.claude / "machine-shared").readlink(), shared_local)
        for kept in (self.shared / "external", self.claude / "external"):
            self.assertEqual(kept.readlink(), external)
        self.assertEqual(json.loads(settings.read_text()),
                         {"hooks": {"SessionStart": [unmanaged]}, "custom": "keep"})
        self.assertEqual(self.hook_commands(self.home / ".codex/hooks.json"), [])

    def test_uninstall_keeps_other_clones_entries_and_the_repo(self):
        settings = self.claude.parent / "settings.json"
        other = self.base / "other-clone"
        (other / "scripts").mkdir(parents=True)
        live = self.sync_command(other)
        gone = self.sync_command(self.base / "gone")
        settings.write_text(json.dumps({"hooks": {"SessionStart": [
            {"matcher": "startup", "hooks": [{"type": "command", "command": live}]},
            {"matcher": "startup", "hooks": [{"type": "command", "command": gone}]},
            {"matcher": "startup",
             "hooks": [{"type": "command", "command": self.sync_command()}]},
        ]}}))
        self.run_setup("--uninstall")
        # An entry for a clone that is missing belongs to whoever owns it; this
        # clone's uninstall is not the place to tidy it away.
        self.assertEqual(self.hook_commands(settings), [live, gone])
        self.assertTrue((self.repo / "scripts/setup.sh").is_file())

    def test_uninstall_writes_nothing_to_files_holding_none_of_its_hooks(self):
        (self.home / ".codex").mkdir()
        settings = self.claude.parent / "settings.json"
        codex = self.home / ".codex/hooks.json"
        settings.write_text('{"custom": "keep"}')
        self.run_setup("--uninstall")
        # Neither file had an entry for this clone, so neither gains an empty
        # hooks block -- and the one that was never there is not created.
        self.assertEqual(settings.read_text(), '{"custom": "keep"}')
        self.assertFalse(codex.exists())
        # Same when a hooks object is there but the template's event is not.
        foreign = {"hooks": {"PreToolUse": [
            {"hooks": [{"type": "command", "command": "echo local"}]}]}}
        settings.write_text(json.dumps(foreign))
        self.run_setup("--uninstall")
        self.assertEqual(json.loads(settings.read_text()), foreign)
        self.assertFalse(codex.exists())

    def test_uninstall_removes_the_legacy_whole_directory_link(self):
        local = self.add_skill(self.shared / "machine-shared")
        self.claude.symlink_to(self.shared, target_is_directory=True)
        self.run_setup("--uninstall")
        self.assertFalse(self.claude.is_symlink())
        self.assertFalse(self.claude.exists())
        self.assertTrue((local / "SKILL.md").is_file())

    def run_standalone(self, script, cwd=None, clone=None):
        """Run a copy of the script that has no clone around it."""
        env = dict(self.env, SKILLS_FIXTURE=str(self.repo))
        if clone is not None:
            env["SKILLS_HOME"] = str(clone)
        git = self.base / "bin/git"
        git.write_text(BOOTSTRAP_GIT)
        git.chmod(0o755)
        if isinstance(script, Path):
            return subprocess.run(["sh", str(script)], env=env, cwd=cwd,
                                  text=True, capture_output=True)
        return subprocess.run(["sh", "-s"], input=script, env=env, cwd=cwd,
                              text=True, capture_output=True)

    def test_a_downloaded_script_clones_and_hands_over(self):
        clone = self.base / "clone"
        loose = self.base / "loose/setup.sh"
        loose.parent.mkdir()
        shutil.copy2(self.script, loose)
        result = self.run_standalone(loose, clone=clone)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("cloning", result.stdout)
        self.assertEqual((self.home / "cloned-url").read_text().strip(),
                         "https://github.com/Harrison-Blair/skills.git")
        # The run continued inside the clone: its skills are linked and the hook
        # names the clone, not the directory the loose copy sat in.
        self.assertEqual((self.claude / "shared-one").resolve(),
                         (clone / "skills/shared-one").resolve())
        self.assertEqual(self.hook_commands(self.claude.parent / "settings.json"),
                         [self.sync_command(clone)])
        self.assertIn("Next steps", result.stdout)

    def test_a_piped_script_ignores_the_directory_it_was_run_from(self):
        # $0 is the shell's own name here, so the enclosing directory -- which
        # is a clone -- must not be mistaken for the script's own.
        clone = self.base / "clone"
        result = self.run_standalone(self.script.read_text(),
                                     cwd=self.repo / "skills", clone=clone)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("cloning", result.stdout)
        self.assertEqual(self.hook_commands(self.claude.parent / "settings.json"),
                         [self.sync_command(clone)])

    def test_an_existing_clone_is_reused_rather_than_cloned_over(self):
        loose = self.base / "loose/setup.sh"
        loose.parent.mkdir()
        shutil.copy2(self.script, loose)
        result = self.run_standalone(loose, clone=self.repo)
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertFalse((self.home / "cloned-url").exists())
        self.assertIn("using clone: %s" % self.repo, result.stdout)
        self.assert_shared_link()

    def test_bootstrap_refuses_to_clone_over_an_unrelated_directory(self):
        occupied = self.add_skill(self.base / "occupied")
        loose = self.base / "loose/setup.sh"
        loose.parent.mkdir()
        shutil.copy2(self.script, loose)
        result = self.run_standalone(loose, clone=occupied)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("is not a clone of", result.stderr)
        self.assertEqual([p.name for p in occupied.iterdir()], ["SKILL.md"])
        self.assertFalse((self.claude.parent / "settings.json").exists())

    def run_junction_prune(self, directory, prefix, junctions):
        """Drive prune_junctions against a simulated `dir /AL` listing."""
        def windows(path):
            return "X:" + str(path).replace("/", "\\")

        listing = [" Volume in drive X has no label.",
                   " Directory of %s" % windows(directory), "",
                   "09/12/2026  09:41 AM    <DIR>          ."]
        listing += ["09/12/2026  09:41 AM    <JUNCTION>     %s [%s]"
                    % (name, windows(target)) for name, target in junctions]
        listing.append("               0 File(s)              0 bytes")
        (self.home / "listing").write_text("\r\n".join(listing) + "\r\n")
        definitions = self.script.read_text().split('\nmain "$@"')[0]
        harness = self.repo / "scripts/windows-prune.sh"
        harness.write_text(definitions + r'''
is_windows() { return 0; }
cygpath() {
  case "$1" in
    -w) printf 'X:%s\n' "$(printf '%s' "$2" | tr '/' '\\')" ;;
    -u) printf '%s\n' "$(printf '%s' "${2#X:}" | tr '\\' '/')" ;;
    *) printf '%s\n' "$2" ;;
  esac
}
cmd() {
  case "$2" in
    dir) [ "$3" = /AL ] || exit 91; cat "$SKILLS_TEST_HOME/listing" ;;
    rmdir)
      [ "$#" = 3 ] || exit 92
      printf '%s\n' "$3" >> "$SKILLS_TEST_HOME/removed"
      rmdir "$(printf '%s' "${3#X:}" | tr '\\' '/')"
      ;;
    *) exit 93 ;;
  esac
}
prune_junctions "$1" "$2"
''')
        return subprocess.run(
            ["bash", str(harness), str(directory), str(prefix)],
            env=self.env, text=True, capture_output=True,
        )

    def test_windows_prunes_only_stale_junctions_into_managed_targets(self):
        external = self.add_skill(self.base / "external")
        for name in ("shared-one", "gone", "outside", "stray"):
            (self.shared / name).mkdir()
        result = self.run_junction_prune(self.shared, self.repo / "skills", [
            ("shared-one", self.skill),                 # managed, target alive
            ("gone", self.repo / "skills/gone"),        # managed, target gone
            ("outside", external),                      # not ours, alive
            ("stray", self.base / "missing"),           # not ours, broken
        ])
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout.split(), ["pruned:", "gone"])
        self.assertFalse((self.shared / "gone").exists())
        for kept in ("shared-one", "outside", "stray"):
            self.assertTrue((self.shared / kept).is_dir(), kept)
        self.assertTrue((self.skill / "SKILL.md").is_file())
        self.assertTrue((external / "SKILL.md").is_file())
        # Exactly one rmdir crossed the command boundary, with one argument.
        self.assertEqual((self.home / "removed").read_text().splitlines(),
                         ["X:" + str(self.shared / "gone").replace("/", "\\")])

    def run_windows_boundary(self, fail_removal=False, unrelated=False):
        # Represent a junction as a real directory and emulate its resolution.
        # The actual target contains a sentinel; it must not be removed.
        self.claude.mkdir()
        sentinel = self.add_skill(self.shared / "sentinel")
        definitions = self.script.read_text().split('\nmain "$@"')[0]
        harness = self.repo / "scripts/windows-test.sh"
        harness.write_text(definitions + r'''
is_windows() { return 0; }
resolve() {
  if [ "$1" = "$SKILLS_TEST_HOME/.claude/skills" ]; then
    if [ "$TEST_UNRELATED" = 1 ]; then echo /unrelated; else (cd "$AGENTS_SKILLS" && pwd -P); fi
  else
    (cd "$1" && pwd -P)
  fi
}
cygpath() { echo "$2"; }
cmd() {
  case "$2" in
    dir) echo skills ;;
    rmdir)
      [ "$#" = 3 ] || exit 91
      [ "$3" = "$SKILLS_TEST_HOME/.claude/skills" ] || exit 92
      echo removal > "$SKILLS_TEST_HOME/removal"
      [ "$TEST_FAIL_REMOVAL" = 0 ] || return 1
      rmdir "$3"
      ;;
    mklink)
      [ "$#" = 5 ] && [ "$3" = /J ] || exit 93
      mkdir "$4"
      echo "$5" > "$4/target"
      ;;
    *) exit 94 ;;
  esac
}
link_claude_skills
''')
        result = subprocess.run(
            ["bash", str(harness)], text=True, capture_output=True,
            env=dict(self.env, TEST_FAIL_REMOVAL=str(int(fail_removal)),
                     TEST_UNRELATED=str(int(unrelated))),
        )
        self.assertTrue((sentinel / "SKILL.md").is_file())
        return result

    def test_windows_junction_migration_command_boundary(self):
        result = self.run_windows_boundary()
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertTrue((self.home / "removal").is_file())
        self.assertEqual((self.claude / "sentinel/target").read_text().strip(),
                         str(self.shared / "sentinel"))

    def test_windows_failed_removal_stops_migration(self):
        result = self.run_windows_boundary(fail_removal=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertTrue((self.home / "removal").is_file())
        self.assertEqual(list(self.claude.iterdir()), [])

    def test_windows_unrelated_junction_is_preserved(self):
        result = self.run_windows_boundary(unrelated=True)
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("left untouched", result.stderr)
        self.assertFalse((self.home / "removal").exists())
        self.assertEqual(list(self.claude.iterdir()), [])


if __name__ == "__main__":
    unittest.main()
