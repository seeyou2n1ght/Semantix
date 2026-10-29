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
| 1 | Service process regression | `node tests/service-manager.cjs`; `node tests/api-health.cjs`; `node tests/plugin-lifecycle.cjs` | Sidecar startup, port handling, restart, shutdown, or sidebar lifecycle changes |
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
- A heading-only note longer than one child chunk preserves middle and tail text in bounded encoded chunks; an embedding failure leaves its previous index intact.
- On an isolated temporary LanceDB, maintenance preserves current rows, vectors, FTS recall, Vault separation, and a recent readable snapshot. Zero-day cleanup is rejected; manual maintenance honors the requested or current nonzero retention. Database size alone is not an acceptance signal.

### Retrieval and ranking

- `engine/tests/test_reranker_config.py` verifies shared default/explicit legacy selection, pinned M3 revision/safetensors/no remote code/512-token options, same-model CPU fallback, terminal failure without repeated loading, truthful health and partial pre-download failure. Existing raw-logit and semantic-degradation tests remain required. The 2026-10-28 M3 candidate passed the full 65-test engine suite plus API-health/radar regressions, plugin type checking, lint and build; these checks do not replace labeled model evaluation.
- For model changes, freeze model revision, inputs, ranking options and labels before comparison. Use the stock pipeline with shared services and isolated databases; reuse known regression results without calling them unseen holdout evidence. Run resource comparisons in fresh processes so retained bound methods cannot keep the previous model alive. Bound near-limit 16/20-pair CUDA checks and a short CPU compatibility smoke separately; report truncation, embedding-excluded memory, and CPU coverage gaps.

- Related and Discover outputs are mutually exclusive.
- Discover respects its relevance gate and MMR diversity behavior on deterministic vectors.
- Fast mode avoids reranking.
- Document aggregation keeps semantic/lexical scores, vectors, displayed source and highlights on the same selected passage. Other passages contribute to recall ordering but not synthetic final-score maxima; FTS-only evidence retains its actual cosine and lexical score.
- An unavailable reranker does not create a synthetic normalized reranker score.
- CrossEncoder returns raw logits on normal and CPU-fallback paths; normalization is applied once. Candidates outside a successful rerank shortlist cannot bypass rejection.
- Real temporary LanceDB tests prove bounded document refill, Vault/exclusion isolation on refill, and FTS-only cosine evidence. A failed channel reports degradation; loss of every eligible recall channel produces HTTP failure rather than an empty success.

- Base function/custom stopwords are hard FTS exclusions and honor request settings and Vault isolation; empty effective queries skip FTS without restoring excluded terms or changing semantic input. Adaptive filtering is a soft evidence discount: qualifying frequent terms remain searchable, and disabling the option removes that discount without changing the terms sent to semantic search.
- The plugin must send explicit adaptive=false by default and after switching off. Switching either direction invalidates in-flight work and reruns the visible Focus or whole-note scope, including an initial whole-note scan. An older engine or failed/offline preparation sends false and shows persistent inactive status; a supporting endpoint computes the Vault list once before sending true. Superseding health checks, offline/restart transitions, manual recalculation, endpoint changes and late health/preparation results cannot authorize stale capability or a stale list. An old index-status response must not overwrite a later manual computation, and an open drawer must display the accepted list. `node tests/radar-state.cjs`, `node tests/adaptive-preparation.cjs`, `node tests/settings-adaptive.cjs`, and `node tests/api-health.cjs` cover these paths.
- Card highlight terms occur in the displayed snippet; English substrings, missing evidence, and retained stale cards do not produce misleading highlights.
- Diary degree words such as `有点` do not drive FTS/highlights; people and events remain searchable. Weak isolated modifiers may be hidden, but complete shared terms (`可靠传输`, `高效算法`, `最终一致性`, `高可用`) and topical adjectives (`幸福`, `焦虑`) remain eligible. No-overlap semantic paraphrases remain valid results.
- `engine/tests/test_retrieval_quality.py` covers these controlled contracts. It does not establish real-model precision or recall gains; compare frozen inputs and baseline/candidate outputs with independently judged useful and irrelevant notes before making relevance claims.
- Display-only filtering leaves FTS terms intact. Chinese compound recovery must not generate arbitrary 2+1 concatenations; established technical compounds remain eligible only under constrained linguistic rules. The UI receives no more than six terms per card, independently of lexical score evidence.
- Adaptive evidence uses the maximum matched-term strength in the selected indexed FTS tokens (note title, heading ancestry, and child passage; excluding directory names and expanded parent context): 0.25 for generic/function-like terms that remain after exact filtering, 0.5 for adaptive frequent-term support, and 1.0 when any informative term matches. Apply after batch lexical normalization; raw BM25/RRF ordering and highlight selection are separate. These heuristic values are not calibrated probabilities and do not establish real-Vault relevance gains.
- Candidate-relative lexical normalization uses the maximum raw BM25 of rows whose strength is at least the current positive strength; zero-strength rows must not enter any denominator. Final contributions remain capped at 0.25/0.5/1.0. Single ASCII `C`/`R` may affect rank evidence only as complete whitespace-delimited indexed tokens; a `C` query must not obtain scoring evidence from atomic `C++`/`C#` tokens even though the current analyzer recalls them. Display keeps the minimum two-character rule for all terms. Token extraction should preserve whole alphanumeric terms such as `GPT4o`, `Python3`, and `Go`; existing stored snapshots require normal recalculation. `C++`/`C#` conflation with `C` remains deferred, and one ordinary informative word still earns full strength.
- The 2026-10-28 lexical follow-up was accepted as a bounded invariant repair: all 89 final engine tests passed without pytest warnings in 8.93s. A frozen 12-query/28-note real-model A/B retained identical fast useful/irrelevant/missing counts 11/31/0 and balanced 11/3/0, card order and scores; no measured relevance or speed gain is claimed. The final single-letter boundary repair was covered separately by real-FTS and full-suite checks; no frozen input exercises that branch. Evidence is under `C:/Users/seeyo/Documents/Codex/2026-10-28/semantix-lexical-validation`. Quarter/half semantic reservation was rejected after adversarial useful exact shortlist counts fell from 1 to 0 at both fixed 16/20 budgets; the production radar source matches baseline and starvation remains unresolved.
- The separate 2026-10-28 default-path run (`default-balanced-20261028.json` in the same evidence folder) used balanced plus adaptive=false, official cached BGE/M3 and a new isolated DB. Related returned 11 strictly useful and 3 irrelevant notes, all three irrelevant on q06; Discover returned zero and q12 returned zero. The corpus labels measure direct task support and cannot establish whether Discover offers meaningful extensions. No real-Vault or Obsidian host acceptance is inferred.
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
- Local sidecar restart attempts are bounded across elapsed time; exhaustion reports once and remains paused until manual restart or a healthy connection. User stop suppresses automatic restart.
- `node tests/plugin-lifecycle.cjs` covers concurrent sidebar opens, deferred-view reuse, later restored duplicate Semantix leaves, layout-event reentry, activation failure recovery, and unloading during activation. Only Semantix leaves may be consolidated, without moving the retained panel. Radar regressions verify that multiple loaded panels receive identical results, errors, progress, cancellation and context reset.
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
