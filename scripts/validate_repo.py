#!/usr/bin/env python3
"""Validate the repository's skills, metadata, and local Markdown links."""

from __future__ import annotations

import argparse
import json
from pathlib import Path
from typing import Iterable
from urllib.parse import unquote, urlsplit

import yaml
from markdown_it import MarkdownIt


def _iter_tokens(tokens):
    for token in tokens:
        yield token
        if token.children:
            yield from _iter_tokens(token.children)


# Installed dependencies (a skill's bundled app) are not skill content.
SKIPPED_DIRS = {"node_modules"}


def skill_files(root: Path, pattern: str) -> list[Path]:
    return sorted(
        path for path in (root / "skills").rglob(pattern)
        if not SKIPPED_DIRS.intersection(path.relative_to(root).parts)
    )


def check_markdown_links(root: Path) -> list[str]:
    """Return errors for local links/images whose destinations do not exist."""
    errors: list[str] = []
    markdown_files = [root / "README.md", *skill_files(root, "*.md")]
    parser = MarkdownIt()
    for markdown_file in markdown_files:
        if not markdown_file.is_file():
            errors.append(f"{markdown_file.relative_to(root)}: file does not exist")
            continue
        try:
            tokens = parser.parse(markdown_file.read_text(encoding="utf-8"))
        except (OSError, UnicodeError) as exc:
            errors.append(f"{markdown_file.relative_to(root)}: cannot read: {exc}")
            continue
        for token in _iter_tokens(tokens):
            if token.type == "link_open":
                destination = token.attrGet("href")
            elif token.type == "image":
                destination = token.attrGet("src")
            else:
                continue
            if not destination:
                continue
            parsed = urlsplit(destination)
            # URLs, mailto links, and fragment-only links are outside this check.
            if parsed.scheme or parsed.netloc or not parsed.path:
                continue
            if parsed.path.startswith("/"):
                continue
            target = markdown_file.parent / unquote(parsed.path)
            if not target.exists():
                relative = markdown_file.relative_to(root)
                errors.append(f"{relative}: missing local target {destination!r}")
    return errors


def check_json_files(root: Path) -> list[str]:
    errors: list[str] = []
    for path in sorted((root / "hooks").glob("*.json")):
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, json.JSONDecodeError) as exc:
            errors.append(f"{path.relative_to(root)}: invalid JSON: {exc}")
            continue
        if not isinstance(data, dict):
            errors.append(f"{path.relative_to(root)}: top-level JSON value must be an object")
    return errors


def check_yaml_files(root: Path) -> list[str]:
    errors: list[str] = []
    paths = skill_files(root, "*.yaml")
    paths += skill_files(root, "*.yml")
    paths += list((root / ".github/workflows").glob("*.yaml"))
    paths += list((root / ".github/workflows").glob("*.yml"))
    for path in sorted(paths):
        try:
            data = yaml.safe_load(path.read_text(encoding="utf-8"))
        except (OSError, UnicodeError, yaml.YAMLError) as exc:
            errors.append(f"{path.relative_to(root)}: invalid YAML: {exc}")
            continue
        if not isinstance(data, dict):
            errors.append(f"{path.relative_to(root)}: top-level YAML value must be a mapping")
    return errors


def check_skills(root: Path) -> list[str]:
    """Validate every immediate skills/<name> directory with skills-ref."""
    try:
        from skills_ref.validator import validate
    except ImportError as exc:  # pragma: no cover - exercised by CI setup
        return [f"skills-ref is required: {exc}"]

    errors: list[str] = []
    skills_root = root / "skills"
    if not skills_root.is_dir():
        return ["skills: directory does not exist"]
    for path in sorted(skills_root.iterdir()):
        if not path.is_dir():
            errors.append(f"{path.relative_to(root)}: skill entry must be a directory")
            continue
        try:
            skill_errors = validate(path)
        except Exception as exc:  # keep checking every skill after parser failures
            skill_errors = [f"validator crashed: {exc}"]
        errors.extend(f"{path.relative_to(root)}: {error}" for error in skill_errors)
    return errors


def collect_errors(root: Path) -> list[str]:
    checks = (check_skills, check_json_files, check_yaml_files, check_markdown_links)
    errors: list[str] = []
    for check in checks:
        errors.extend(check(root))
    return errors


def main(argv: Iterable[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "root", nargs="?", type=Path,
        default=Path(__file__).resolve().parents[1],
        help="repository root (default: the parent of scripts/)",
    )
    args = parser.parse_args(argv)
    root = args.root.resolve()
    errors = collect_errors(root)
    if errors:
        print(f"Repository validation failed with {len(errors)} error(s):")
        for error in errors:
            print(f"  - {error}")
        return 1
    print(f"Repository validation passed: {root}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
