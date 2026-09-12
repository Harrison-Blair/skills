"""Native junction tests; this module intentionally fails on Windows without Git Bash."""

import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest


@unittest.skipUnless(os.name == "nt", "native junction tests run on Windows CI")
class WindowsSetupTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="skills setup ")
        self.addCleanup(self.temp.cleanup)
        self.base = Path(self.temp.name)
        self.home = self.base / "home"
        self.repo = self.base / "repo"
        self.shared = self.home / ".agents/skills"
        self.claude = self.home / ".claude/skills"
        self.claude.parent.mkdir(parents=True)
        self.repo.mkdir()
        (self.repo / "scripts").mkdir()
        shutil.copy2(
            Path(__file__).parents[1] / "scripts/setup.sh",
            self.repo / "scripts/setup.sh",
        )
        shutil.copytree(Path(__file__).parents[1] / "hooks", self.repo / "hooks")
        self.add_skill(self.repo / "skills/shared-one")
        self.env = dict(os.environ)
        # Git Bash accepts drive-letter paths with forward slashes and uses HOME
        # for the script's machine-local destinations.
        self.env["HOME"] = self.home.as_posix()
        self.env["USERPROFILE"] = self.home.as_posix()
        self.bash = shutil.which("bash")
        if not self.bash:
            raise AssertionError("Git for Windows Bash is required for native junction tests")
        version = subprocess.run([self.bash, "--version"], text=True, capture_output=True)
        self.assertEqual(version.returncode, 0, version.stderr)

    def add_skill(self, path):
        path.mkdir(parents=True)
        (path / "SKILL.md").write_text(
            "---\nname: %s\ndescription: Test skill.\n---\n" % path.name,
            encoding="utf-8",
        )
        return path

    def run_setup(self, mode="setup"):
        result = subprocess.run(
            [self.bash, "scripts/setup.sh", mode], cwd=self.repo,
            env=self.env, text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        return result

    @staticmethod
    def is_junction(path):
        return path.is_junction()

    def make_junction(self, link, target):
        result = subprocess.run(
            ["cmd.exe", "/d", "/c", "mklink", "/J", str(link), str(target)],
            text=True, capture_output=True,
        )
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertTrue(self.is_junction(link), link)

    def remove_empty_directory(self, path):
        for child in path.iterdir():
            if child.is_junction():
                result = subprocess.run(
                    ["cmd.exe", "/d", "/c", "rmdir", str(child)],
                    text=True, capture_output=True,
                )
                self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
            elif child.is_symlink():
                child.unlink()
            elif child.is_dir():
                shutil.rmtree(child)
            else:
                child.unlink()
        path.rmdir()

    def test_fresh_and_repeated_setup_create_real_root_and_junctions(self):
        for _ in range(2):
            self.run_setup()
            self.assertTrue(self.claude.is_dir())
            self.assertFalse(self.is_junction(self.claude))
            link = self.claude / "shared-one"
            self.assertTrue(self.is_junction(link))
            self.assertEqual(link.resolve(), (self.repo / "skills/shared-one").resolve())

    def test_legacy_junction_migration_preserves_targets(self):
        self.run_setup()
        self.add_skill(self.shared / "machine-shared")
        self.remove_empty_directory(self.claude)
        self.make_junction(self.claude, self.shared)
        self.run_setup("--sync")
        self.assertFalse(self.is_junction(self.claude))
        migrated = self.claude / "machine-shared"
        self.assertTrue(self.is_junction(migrated))
        self.assertEqual(migrated.resolve(), (self.shared / "machine-shared").resolve())
        self.assertTrue((self.shared / "machine-shared/SKILL.md").is_file())

    def test_stale_junctions_are_pruned_and_other_junctions_survive(self):
        doomed = self.add_skill(self.repo / "skills/doomed")
        self.run_setup()
        self.assertTrue(self.is_junction(self.shared / "doomed"))
        self.assertTrue(self.is_junction(self.claude / "doomed"))
        external = self.add_skill(self.base / "external")
        self.make_junction(self.shared / "unrelated", external)
        local = self.add_skill(self.shared / "machine-shared")
        shutil.rmtree(doomed)
        result = self.run_setup("--sync")
        self.assertFalse(self.is_junction(self.shared / "doomed"))
        self.assertFalse((self.shared / "doomed").exists())
        self.assertFalse(self.is_junction(self.claude / "doomed"))
        self.assertFalse((self.claude / "doomed").exists())
        # A junction out of this setup's reach, and the real directories on the
        # far side of every junction, are untouched.
        self.assertTrue(self.is_junction(self.shared / "unrelated"))
        self.assertEqual((self.shared / "unrelated").resolve(), external.resolve())
        self.assertTrue((external / "SKILL.md").is_file())
        self.assertTrue((local / "SKILL.md").is_file())
        self.assertTrue(self.is_junction(self.claude / "shared-one"))
        self.assertEqual(result.returncode, 0)

    def test_uninstall_removes_junctions_and_leaves_real_directories(self):
        self.run_setup()
        external = self.add_skill(self.base / "external")
        self.make_junction(self.claude / "unrelated", external)
        local = self.add_skill(self.claude / "claude-only")
        result = self.run_setup("--uninstall")
        self.assertIn("removed:", result.stdout)
        for gone in (self.claude / "shared-one", self.shared / "shared-one"):
            self.assertFalse(self.is_junction(gone), gone)
            self.assertFalse(gone.exists(), gone)
        self.assertTrue(self.claude.is_dir())
        self.assertFalse(self.is_junction(self.claude))
        self.assertTrue(self.is_junction(self.claude / "unrelated"))
        self.assertTrue((external / "SKILL.md").is_file())
        self.assertTrue((local / "SKILL.md").is_file())
        self.assertTrue((self.repo / "skills/shared-one/SKILL.md").is_file())

    def test_local_folders_conflicts_and_unrelated_junctions_survive(self):
        self.run_setup()
        local = self.add_skill(self.claude / "claude-only")
        external = self.add_skill(self.base / "external")
        unrelated = self.claude / "unrelated"
        self.make_junction(unrelated, external)
        self.add_skill(self.repo / "skills/claude-only")
        self.add_skill(self.repo / "skills/new-skill")
        result = self.run_setup("--sync")
        self.assertIn("left untouched", result.stderr)
        self.assertTrue((local / "SKILL.md").is_file())
        self.assertTrue(self.is_junction(unrelated))
        self.assertEqual(unrelated.resolve(), external.resolve())
        self.assertTrue(self.is_junction(self.claude / "new-skill"))


if __name__ == "__main__":
    unittest.main()
