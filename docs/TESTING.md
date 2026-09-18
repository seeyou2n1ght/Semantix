# Semantix Testing and Verification

This document defines the smallest reliable checks for frontend, backend, Harness, and release work.

## 1. Principles

- Run the smallest relevant check first, then the full affected subsystem.
- Use deterministic synthetic notes and mocked model outputs in automated tests; tests must not depend on model downloads or external networks.
- Compilation is necessary but does not prove Vault isolation, index preservation, stale-response rejection, or truthful ranking degradation.
- Report commands actually executed, skipped checks, and any environment-specific warnings separately.

## 2. Verification tiers

| Tier | Scope | Commands | Required when |
| --- | --- | --- | --- |
| 0 | Harness and Markdown | `uv run --project engine python scripts/verify_harness.py .` | Harness or documentation changes |
| 1 | Plugin static checks | `npm run lint`; `npm exec tsc -- --noEmit --skipLibCheck` | Any plugin TypeScript change |
| 1 | Engine focused tests | `cd engine`; `uv run pytest tests/test_<area>.py` | An engine module changes |
| 2 | Full plugin | `npm run build`; `npm run lint` | Before completing plugin work |
| 2 | Full engine | `cd engine`; `uv sync --locked`; `uv run pytest` | Before completing engine work |
| 3 | Release | Full checks, then `npm run check:release`; verify the tag equals the manifest version | Before tagging a release |
| 4 | Obsidian vertical slice | Manual test with a disposable Vault and controlled engine | Lifecycle, editor, or end-to-end behavior changes |

Generated `dist/main.js` and `dist/styles.css` are build outputs. Do not edit them directly. Root `manifest.json` and `versions.json` are release metadata and must remain synchronized with `package.json`.

## 3. Behavioral acceptance gates

### Indexing and storage

- A failed document embedding leaves its previous indexed chunks intact and reports the path as failed.
- A successful shorter replacement deletes obsolete chunks for only that document and Vault.
- Clear, status, stopword, delete, and search operations cannot cross `vault_id` boundaries.
- Schema incompatibility fails visibly instead of silently recreating data.

### Retrieval and ranking

- Related and Discover outputs are mutually exclusive.
- Discover respects its relevance gate and MMR diversity behavior on deterministic vectors.
- Fast mode avoids reranking.
- An unavailable reranker does not create a synthetic normalized reranker score.

### Frontend and lifecycle

- A stale search ID or `context_id` cannot replace current sidebar results.
- Index batch failures remain queued with bounded retry.
- Local sidecar restart attempts are bounded and user stop suppresses automatic restart.
- Mobile behavior matches the accepted support policy before release.

## 4. CI baseline and known gap

CI runs frontend lint/build/release-contract checks and backend pytest. Release tags must exactly equal the root manifest version and must not use a `v` prefix.

## 5. Minimal vertical slice

Use one synthetic current note and two indexed candidates:

1. index them under one `vault_id`;
2. call `/search/radar` with a real `RadarContext` and `context_id`;
3. verify Related/Discover separation, echoed context, and zero results from a different Vault;
4. pass the response through the frontend freshness guard before rendering.

This slice proves the client contract, model-service seam, retrieval orchestration, Vault isolation, and stale-response rule without requiring a large Vault fixture.
