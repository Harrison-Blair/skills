import importlib.util
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest


ROOT = Path(__file__).resolve().parents[1]
SCRIPT = ROOT / "scripts/validate_repo.py"
HAS_SKILLS_REF = importlib.util.find_spec("skills_ref") is not None


@unittest.skipUnless(HAS_SKILLS_REF, "install requirements-ci.txt to run validator tests")
class ValidatorTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="skills validator ")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.write("skills/good/SKILL.md", """---\nname: good\ndescription: A valid test skill.\n---\n\nInstructions.\n""")
        self.write("hooks/ci.json", '{"hooks": {}}\n')

    def write(self, relative, content):
        path = self.root / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content, encoding="utf-8")
        return path

    def run_validator(self):
        return subprocess.run(
            [sys.executable, str(SCRIPT), str(self.root)],
            text=True, capture_output=True,
        )

    def test_valid_repository(self):
        self.write("skills/good/assets/hello world.txt", "asset\n")
        self.write(
            "README.md",
            "See [the skill][ref].\n\n"
            "![asset](skills/good/assets/hello%20world.txt#preview)\n\n"
            "[ref]: skills/good/SKILL.md\n",
        )
        result = self.run_validator()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)

    def test_missing_skill_file_and_relative_target_are_reported(self):
        (self.root / "skills/good/SKILL.md").unlink()
        self.write("README.md", "[missing](docs/nope.md)\n")
        result = self.run_validator()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("Missing required file: SKILL.md", result.stdout)
        self.assertIn("missing local target 'docs/nope.md'", result.stdout)

    def test_installed_dependencies_are_skipped(self):
        self.write("skills/good/app/node_modules/pkg/README.md", "[gone](missing.md)\n")
        self.write("skills/good/app/node_modules/pkg/x.yaml", "- not a mapping\n")
        self.write("skills/good/app/notes.md", "[gone](missing.md)\n")
        result = self.run_validator()
        self.assertNotIn("node_modules", result.stdout)
        self.assertIn("skills/good/app/notes.md: missing local target", result.stdout)

    def test_invalid_frontmatter_is_reported(self):
        self.write("skills/good/SKILL.md", """---\nname: Bad Name\ndescription: nope\n---\n""")
        result = self.run_validator()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("must be lowercase", result.stdout)

    def test_malformed_json_and_yaml_are_reported(self):
        self.write("hooks/bad.json", '{"hooks":\n')
        self.write("skills/good/agents/bad.yaml", "bad: [\n")
        result = self.run_validator()
        self.assertNotEqual(result.returncode, 0)
        self.assertIn("hooks/bad.json: invalid JSON", result.stdout)
        self.assertIn("skills/good/agents/bad.yaml: invalid YAML", result.stdout)

    def test_code_examples_and_external_links_are_ignored(self):
        self.write("README.md", """[external](https://example.test/nope)\n\n```md\n[code](missing.md)\n```\n""")
        result = self.run_validator()
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
