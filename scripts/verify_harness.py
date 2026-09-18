"""Validate the repository's lightweight agent harness using only stdlib."""

from __future__ import annotations

import re
import sys
from pathlib import Path


ROUTED_DOCS = (
    "docs/ARCHITECTURE.md",
    "docs/PROGRESS.md",
    "docs/DECISION.md",
    "docs/TESTING.md",
    "README.md",
    "CHANGELOG.md",
)
EXPECTED_DOCS = set(ROUTED_DOCS[:4])
PLACEHOLDERS = ("[PROJECT_NAME]", "[COMMAND_", "[UNCERTAINTY_", "[CURRENT_")
LINK_RE = re.compile(r"\[[^]]+\]\(([^)]+)\)")


def validate(root: Path) -> list[str]:
    errors: list[str] = []
    agents = root / "AGENTS.md"
    if not agents.is_file():
        return ["missing AGENTS.md"]

    agents_text = agents.read_text(encoding="utf-8")
    line_count = len(agents_text.splitlines())
    if line_count >= 300:
        errors.append(f"AGENTS.md has {line_count} lines; expected fewer than 300")

    for keyword in ("`MUST`", "`MUST NOT`", "`SHOULD`"):
        if keyword not in agents_text:
            errors.append(f"AGENTS.md is missing RFC-2119 keyword {keyword}")

    actual_docs = {
        path.relative_to(root).as_posix() for path in (root / "docs").glob("*.md")
    }
    for relative in sorted(EXPECTED_DOCS - actual_docs):
        errors.append(f"missing required document: {relative}")
    for relative in sorted(actual_docs - EXPECTED_DOCS):
        errors.append(f"unexpected Markdown document: {relative}")
    if (root / "frontend" / "README.md").exists():
        errors.append("unexpected duplicate document: frontend/README.md")

    markdown_files = [agents]
    for relative in ROUTED_DOCS:
        path = root / relative
        if not path.is_file():
            errors.append(f"missing required document: {relative}")
        else:
            markdown_files.append(path)
        if f"`{relative}`" not in agents_text:
            errors.append(f"AGENTS.md does not route to {relative}")

    for path in markdown_files:
        text = path.read_text(encoding="utf-8")
        for placeholder in PLACEHOLDERS:
            if placeholder in text:
                errors.append(
                    f"template placeholder {placeholder!r} remains in {path.relative_to(root)}"
                )
        for target in LINK_RE.findall(text):
            clean_target = target.split("#", 1)[0]
            if not clean_target or re.match(r"^[a-z][a-z0-9+.-]*:", clean_target, re.I):
                continue
            if not (path.parent / clean_target).resolve().exists():
                errors.append(f"broken link in {path.relative_to(root)}: {target}")

    return errors


def main() -> int:
    root = Path(sys.argv[1] if len(sys.argv) > 1 else ".").resolve()
    errors = validate(root)
    if errors:
        for error in errors:
            print(f"ERROR: {error}")
        return 1
    print("Agent harness validation passed.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
