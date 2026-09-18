# Semantix Agent Guide

This file is the repository execution router and invariant anchor. Keep it concise; load detailed documents only when the task needs them.

## Goals and priorities

Semantix is a local-first semantic retrieval plugin for Obsidian. Prefer correctness, vault isolation, failure visibility, and maintainability over speculative features or benchmark-only speedups.

## Core invariants

- Vault isolation: every indexed or retrieved record `MUST` be scoped by `vault_id`.
- Index integrity: a failed document update `MUST NOT` destroy its previous valid index.
- Model lifecycle: embedding and reranking models `MUST` be created only through the shared services.
- Fresh UI state: long frontend work `SHOULD` yield to Obsidian and report real progress.
- Truthful failure: loading, partial, degraded, and failed states `MUST NOT` be presented as success.
- Security: local binding is the default; token and origin controls remain available for remote use.
- Consistency: `package.json` is the version SSOT; ranking numbers live in `engine/config/ranking_config.py`.

## Documentation routing

| Need | Read |
| --- | --- |
| Product scope, architecture, contracts, invariants | `docs/ARCHITECTURE.md` |
| Current state, gaps, priorities, open questions | `docs/PROGRESS.md` |
| Durable design decisions and trade-offs | `docs/DECISION.md` |
| Validation commands and evidence expectations | `docs/TESTING.md` |
| Installation and user operation | `README.md` |
| Released changes | `CHANGELOG.md` |

## Task start

1. Read the routed document for the task.
2. Inspect the real implementation and `git diff`; documentation may lag code.
3. Check unresolved questions in `docs/ARCHITECTURE.md` before making a product-level assumption.
4. Preserve unrelated uncommitted changes.

## Change discipline

- Update `docs/PROGRESS.md` when current status, priorities, gaps, or verification evidence changes.
- Add an ADR to `docs/DECISION.md` only for a durable choice with meaningful alternatives.
- Update `CHANGELOG.md` only for released, user-visible history.
- Change versions only through `npm run version -- [patch|minor|major]`.
- Do not instantiate `SentenceTransformer` or `CrossEncoder` in business logic; use the shared services.

## Commands

```powershell
uv run --project engine python scripts/verify_harness.py .

npm run lint
npm run build
npm run check:release

cd engine
uv sync --locked
uv run pytest
```

## Completion

A change is complete only when the smallest relevant checks in `docs/TESTING.md` pass and the result is backed by current output. A green process exit does not override warnings, skipped coverage, stale generated artifacts, or an unverified runtime path.
