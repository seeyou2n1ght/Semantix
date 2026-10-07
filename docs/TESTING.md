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
| 0 | Documentation and whitespace | `git diff --check` | Documentation changes |
| 1 | Plugin static and radar behavior | `npm run lint`; `npm exec tsc -- --noEmit --skipLibCheck --types obsidian`; `node tests/radar-state.cjs`; `node tests/indexing.cjs` | Plugin UI or search flow changes |
| 1 | Service process regression | `node tests/service-manager.cjs`; `node tests/api-health.cjs` | Sidecar startup, port handling, restart, or shutdown changes |
| 1 | Engine focused tests | `cd engine`; `uv run pytest tests/test_<area>.py` | An engine module changes |
| 2 | Full plugin | `npm run build`; `npm run lint` | Before completing plugin work |
| 2 | Full engine | `cd engine`; `uv sync --locked`; `uv run pytest` | Before completing engine work |
| 3 | Release | Full checks, then `npm run check:release`; verify the tag equals the manifest version | Before tagging a release |
| 4 | Obsidian vertical slice | Manual test with a disposable Vault and controlled engine | Lifecycle, editor, or end-to-end behavior changes |

Generated root `main.js` and `styles.css` are build outputs. Do not edit them directly. Root `manifest.json` and `versions.json` are release metadata and must remain synchronized with `package.json`.
Use `npm run version -- minor` for a minor release; the script also synchronizes the engine package, health version, smoke assertion, and lockfile.

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
- CrossEncoder returns raw logits on normal and CPU-fallback paths; normalization is applied once. Candidates outside a successful rerank shortlist cannot bypass rejection.
- Real temporary LanceDB tests prove bounded document refill, Vault/exclusion isolation on refill, and FTS-only cosine evidence. A failed channel reports degradation; loss of every eligible recall channel produces HTTP failure rather than an empty success.

- Lexical filters honor request settings and Vault isolation; empty effective queries skip FTS without restoring noise or changing semantic input.
- Card highlight terms occur in the displayed snippet; English substrings, missing evidence, and retained stale cards do not produce misleading highlights.
- Display-only filtering leaves FTS terms intact; compound Chinese terms appear only when the whole span occurs in both query and snippet, and the UI receives no more than six terms per card.
- Stopword recalculation reports the actual number of notes with text, threshold and minimum document frequency used for that Vault.
- `engine/tests/test_lexical.py` exercises real temporary LanceDB/FTS with deterministic vectors plus API wiring. `node tests/radar-state.cjs` also runs `tests/highlights.cjs` for rendering, request settings, stabilization, and whole-note evidence merging.

### Frontend and lifecycle

- A stale search ID or `context_id` cannot replace current sidebar results.
- Edits/cursor changes invalidate Focus responses during debounce, before another request is sent. Superseded queued requests do not reach the engine.
- Whole-note scans show explicitly partial results before completion and stop dispatching further parts after cancellation. Unchanged card payloads preserve DOM; result stabilization retains only current evidence.
- `node tests/radar-state.cjs` includes source-location regression for multiline Markdown, frontmatter, duplicate passages and changed source. Unresolvable matches must not jump to a guessed line.
- Incremental read/batch failures remain queued with capped exponential retry delay; healthy documents proceed. Full/incremental indexing share batch limits and submit empty documents for atomic deletion. In-flight acknowledgments cannot discard newer updates or deletes. `node tests/indexing.cjs` exercises these paths without a real Vault.
- Stopword persistence failure leaves the old disk and memory snapshots intact and fails the API call; concurrent Vault updates preserve both sets.
- Permanent embedding load failure has an error health state; clients retain its message and do not treat it as loading or another service on the port.
- Local sidecar restart attempts are bounded and user stop suppresses automatic restart.
- Mobile behavior matches the accepted support policy before release.

## 4. CI baseline and known gap

CI and release builds run frontend lint with zero warnings, plugin type checking without ambient Node types, radar/process/health regressions, release-contract checks, and backend pytest. Port-probe interfaces must remain typed when Node declarations are unavailable in the community review environment. Owned-process and port-conflict tests use controlled process handles and a real loopback listener; startup and Windows shutdown must disable shell execution and pass arguments separately. Release tags must exactly equal the root manifest version and must not use a `v` prefix.

## 5. Minimal vertical slice

Use one synthetic current note and two indexed candidates:

1. index them under one `vault_id`;
2. call `/search/radar` with a real `RadarContext` and `context_id`;
3. verify Related/Discover separation, echoed context, and zero results from a different Vault;
4. pass the response through the frontend freshness guard before rendering.

This slice proves the client contract, model-service seam, retrieval orchestration, Vault isolation, and stale-response rule without requiring a large Vault fixture.
