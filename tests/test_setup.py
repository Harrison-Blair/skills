"""Filesystem regression tests: python3 -m unittest discover -s tests -v.

Fixtures redirect the script's home references to SKILLS_TEST_HOME rather than
changing HOME or touching the user's actual configuration. Windows command
boundaries are simulated; native junction behavior needs a Git Bash smoke test.
"""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


SOURCE = Path(__file__).resolve().parents[1]


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
        git.write_text('#!/bin/sh\nexit 1\n')
        git.chmod(0o755)
        self.env["PATH"] = str(bin_dir) + os.pathsep + self.env["PATH"]
        self.skill = self.add_skill(self.repo / "skills/shared-one")

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

    def run_windows_boundary(self, fail_removal=False, unrelated=False):
        # Represent a junction as a real directory and emulate its resolution.
        # The actual target contains a sentinel; it must not be removed.
        self.claude.mkdir()
        sentinel = self.add_skill(self.shared / "sentinel")
        definitions = self.script.read_text().split('case "$MODE" in')[0]
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
