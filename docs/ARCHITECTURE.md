# Semantix Architecture

This document is the durable source for product scope, system boundaries, contracts, and architecture invariants. Current gaps, priorities, and released history live in `PROGRESS.md`.

## 1. Scope

Semantix is a local-first Obsidian plugin that indexes Markdown notes and returns two explainable recommendation streams:

- **Related**: the most directly relevant notes for the active context.
- **Discover**: relevant but diverse notes intended to surface less obvious connections.

The released plugin is desktop-only (`manifest.json`). Desktop users can run a local Python sidecar or a user-configured private remote engine. Mobile guards/settings are retained for future support work; mobile usage is not a supported release capability.

### Core use cases

1. Build and incrementally maintain a Vault-scoped semantic/FTS index.
2. Search from the editor while rejecting responses for stale contexts.
3. Start, monitor, recover, and stop a local backend without leaking orphan processes.

### Hard constraints

- Note content stays on user-controlled infrastructure.
- All storage and retrieval operations are isolated by `vault_id`.
- Model inference does not run on the Obsidian renderer thread.
- Index failures remain visible and must not destroy the previous valid document index.

### Non-goals

- A hosted Semantix cloud service.
- A general-purpose vector database API.
- Knowledge-graph or distributed-job infrastructure without measured need.

### Open product decisions

| ID | Question | Why it matters |
| --- | --- | --- |
| Q1 | Is remote-engine mobile usage officially supported or best-effort? | Determines release claims and mobile acceptance tests. |
| Q2 | Must plugin and engine versions match exactly, or only the API/index versions? | Determines compatibility and upgrade policy. |
| Q3 | Resolved by ADR-0008: unavailable reranking returns explicitly degraded semantic results; failure of all eligible recall channels fails the request. | Keeps incomplete results distinct from a successful no-match response. |

## 2. System topology

```text
Obsidian plugin (TypeScript)
  editor context -> freshness gate -> REST client -> Related/Discover UI
                                 |
                                 v
FastAPI sidecar (Python)
  routes -> RadarPipeline -> RetrievalService -> ranking pipeline
                  |              |                    |
                  v              v                    v
          embedding/reranker  LanceDB + FTS      labels + MMR
```

The plugin owns editor context and response freshness. The companion engine owns indexing, retrieval, ranking, storage, and model lifecycle.

### Release boundary

The repository is organized with the Obsidian plugin as the root primary product and the companion calculation engine under `engine/`. Obsidian metadata (`manifest.json`, `versions.json`) lives at the repository root alongside `package.json`. esbuild writes ignored `main.js` and `styles.css` to the repository root; GitHub Release publishes only those files and `manifest.json`. Release tags exactly match the manifest version without a `v` prefix.

## 3. Module boundaries

### Plugin (`src/`)

- `main.ts`: plugin lifecycle, settings, indexing orchestration, and Vault events.
- `api/`: HTTP client and TypeScript wire types.
- `core/context.ts`: converts editor state into a Radar context.
- `core/query-gate.ts`: debounces insignificant context changes.
- `core/result-stabilizer.ts`: stabilizes visible results across related contexts.
- `core/radar.ts`: schedules searches and rejects stale responses.
- `core/service-manager.ts`: local process startup, owned-process cleanup, health checks, bounded recovery, and shutdown.
- `ui/`: sidebar and preview rendering; it never accesses storage directly.

### Engine (`engine/`)

- `main.py`: process lifecycle and HTTP boundary.
- `models.py`: Pydantic wire contracts.
- `services/database_service.py`: composition entry point for shared storage/index/retrieval services; no forwarding facade.
- `services/index_service.py`: Markdown chunking and index preparation.
- `services/retrieval_service.py`: vector/FTS recall, fusion, and document aggregation.
- `services/radar_service.py`: Related/Discover orchestration.
- `services/embedding_service.py`, `services/reranker_service.py`: shared model lifecycle. Reranker identity, pinned M3 revision and 512-token pair limit are shared with the pre-downloader through `config/model_config.py`.
- `services/ranking/`: score normalization, Related ranking, Discover gating/MMR, and labels.
- `storage/lancedb_storage.py`: Vault-scoped persistence, replacement, deletion, and FTS lifecycle.
- `config/ranking_config.py`: ranking thresholds, limits, and weights SSOT.

## 4. Data flows

### Indexing

1. Full indexing and incremental sync share document preparation and request batching: at most 25 notes and a 150,000-character target. An indivisible larger note occupies its own request. Empty cleaned notes are submitted to remove their previous index. Incremental read failures remain queued while healthy notes continue; acknowledgments remove only the revision actually submitted.
2. The frontend yields between batches to avoid monopolizing the renderer thread.
3. The backend parses header-aware chunks, embeds them, and replaces only successfully prepared documents.
4. Failed documents retain their previous valid chunks and are reported as failures.
5. A completed full indexing pass requests immediate FTS rebuild.
6. Startup/reconnect and exclusion changes reconcile the current Vault against `GET /index/paths`. Successful file mtime/size signatures are stored in plugin data, separately for each Vault/engine address; serialized saves prevent older writes from overwriting newer state. A request records its submitted signature, never a later edit's stat. Missing/changed notes are queued; obsolete or excluded paths are queued for deletion. Health polling does not re-embed the entire Vault. The first reconciliation without saved signatures may queue all existing notes. Filesystem tools that preserve both mtime and size require an explicit full rebuild.
7. Full rebuild retains each current note's old valid index until successful replacement, then re-enumerates eligible local files and deletes obsolete paths in batches of at most 25. A completely empty/excluded Vault still performs cleanup. Read/embedding failures retain previous valid indexes and queue affected files for retry. Cancellation, cleanup failure, FTS failure and connection changes cannot produce a complete-success state. A rebuild requires a valid current indexed-path inventory; an older engine must be updated before this complete rebuild workflow can run.
8. Reconciliation, full rebuild and clear are mutually exclusive within the plugin instance. Each pauses and waits for incremental writes as needed. Successful clear discards queued work from before its confirmed write boundary and clears displayed cards, while retaining later file events; failed clear retains pending work. Later edits or a later startup/reconnect reconciliation may index notes again. This is not interprocess coordination. Endpoint identities and connection generations reject stale inventories and acknowledgments. Physical index availability failures produce HTTP failure, not an empty inventory.
9. Index UI distinguishes pending sync, checking, unverified/failed inventory and a completed check. Settings fetch metrics from their actual `display()` lifecycle and accept current index-status snapshots; late metrics cannot overwrite a newer snapshot or another endpoint. Refreshes update only status/storage descriptions, preserving inputs and drawers. A nonzero count alone never means up-to-date. Failed inventory is not used to infer deletions; automatic retry is bounded by connection changes, exclusion changes or an explicit manual connection check/rebuild.

### Radar search

1. The frontend creates a `context_id` and monotonically increasing local search ID. Editor/cursor changes immediately invalidate in-flight Focus responses. One network search is in flight at a time; only the latest waiting context is sent next. Obsidian's transport does not cancel already-running inference.
   The sidebar reports the captured source file, heading, and whether the query came from a selection, current line, paragraph, or whole note. Changing the adaptive setting invalidates the previous search and refreshes that same scope once the authoritative connection and frequent-term preparation finish.
   Disabling writing auto-trigger blocks typing, selection and cursor/paragraph changes, cancels pending automatic callbacks and invalidates an active Focus query; file switches and explicit scans remain available. Ranking mode, result count, MMR lambda, custom stopwords and exclusions invalidate old responses immediately, coalesce input for 250ms, then save/refresh the same visible scope. Exclusions share one frontend matcher for indexing, exact-path request expansion and final rendering, including partial scan results. Missing source files are filtered before rendering, and confirmed index deletions remove already displayed cards without forcing a new query. Insufficient text marks retained cards stale and explains why no new query ran. The source breadcrumb exposes a bounded captured-query excerpt via tooltip and accessible label.
2. The backend embeds the query with `为这个句子生成表示以用于检索相关文章：`.
3. FTS uses engine-owned function-word filtering plus request-scoped custom stopwords. These exact function/custom terms are hard exclusions from FTS. The adaptive-filter setting does not remove frequent terms: when enabled, terms appearing in at least 30% of indexed notes receive a soft lexical-evidence discount. With no effective FTS terms it is skipped; embedding and reranking retain the original semantic text. Each channel targets up to 45 distinct documents, keeping at most two chunks per document. Up to four bounded batches of at least 80 rows exclude already-seen documents during refill; the channel union is then fused and aggregated. FTS-only chunks receive cosine evidence from their stored vectors and the query vector instead of an artificial zero.
4. `fast` skips CrossEncoder; `balanced` reranks up to 16 candidates; `high_quality` reranks up to 20. Candidate text includes its semantic path/title and snippet. The model service explicitly returns raw logits; sigmoid/power normalization runs once. After successful reranking, only that shortlist competes in both streams. Unscored candidates cannot substitute semantic scores to bypass reranker rejection. If reranking is unavailable, all recalled candidates use the existing semantic fallback with a response warning.
5. Related combines normalized semantic, reranker, and lexical evidence, with bounded folder/tag bonuses and its existing composite admission threshold. Explicitly linked notes retain their lower Related gate. The thresholds are heuristic, not calibrated probabilities; a separate content-only gate was rejected after independent synthetic evaluation showed loss of a useful paraphrase while retaining unrelated results.
6. Discover applies its relevance gate, excludes near-duplicates and Related results, applies diversity penalties/bridges, then selects with MMR. It uses the same recalled/reranked candidate pool as Related. A useful extension outside that pool cannot be recovered by changing MMR lambda. Same-folder and same-topic results remain eligible; structural labels do not establish conceptual novelty. Candidate coverage and human-rated extension usefulness need separate evaluation before changing the shared-shortlist policy.
7. Each card includes `matched_terms`: a bounded set of informative overlaps in its displayed snippet, indicating lexical overlap rather than semantic attribution. Degree words such as `有点` are hard function-word filters for FTS, while semantic input is unchanged. Display-only weak modifiers are suppressed in isolation but retained in complete shared expressions such as `可靠传输` and `最终一致性`; Chinese compound recovery is constrained to linguistic patterns rather than unrestricted 2+1 concatenation. Missing lexical overlap yields plain text without rejecting semantic candidates. The response echoes `context_id`; the frontend discards stale IDs before rendering.

Adaptive lexical evidence is computed per Vault from indexed-note document frequency (30% cutoff). For each candidate, use matched terms in its selected indexed FTS tokens (note title, heading ancestry, and child passage; excluding directory names and expanded parent context): generic/function-like terms that remain after exact filtering have evidence strength 0.25, adaptive frequent-term support 0.5, and any informative-term match 1.0. The candidate's factor is the maximum matched-term strength, preserving stronger evidence when extra weak terms also match. Normalization is candidate-relative: for each positive strength, use as denominator the maximum raw BM25 among rows whose strength is at least that strength; zero-strength rows never enter a denominator. Final lexical contribution remains capped at 0.25/0.5/1.0 for weak/adaptive/informative evidence. Raw BM25 and RRF ordering inputs remain unchanged, and highlight selection is evaluated separately from score qualification. Single ASCII `C` and `R` contribute rank evidence only as complete whitespace-delimited indexed tokens, excluding atomic `C++`/`C#` collisions; display retains the minimum two-character rule for all terms, with no single-Hanzi relaxation. These values are heuristic evidence limits, not calibrated probabilities. Existing setting and API/storage wire names remain compatible. Existing stored snapshots require normal stopword/token recalculation to acquire the updated token contract; there is no automatic production change or migration.

Adaptive token extraction reuses the query-term tokenizer's full alphanumeric tokens (including names such as `GPT4o`, `Python3`, and `Go`) rather than splitting them into fragments. `C++` and `C#` remain unresolved because current extraction conflates them with `C`; these are deferred. A candidate receiving full credit from one ordinary informative word is a known limitation.

Document-level RRF and hit counts decide the candidate order. The strongest cosine passage currently supplies semantic and lexical scores, vector, snippet, source text and highlight terms together; independent maxima from other passages are not combined into final ranking evidence. Controlled synthetic comparisons supported this selection for one fast-mode long-note case without an observed exact-term regression; they do not establish broad quality gains. The legacy base reranker loses a useful recovery paraphrase; the default M3 reranker restored it in the frozen regression corpus, without establishing real-Vault acceptance. Long notes and same-person/different-event matches remain relevance risks; stronger model scores alone do not establish user usefulness.

Explicit whole-note scans split the cleaned note into bounded text parts, search each part with its own echoed context ID, show completed-part progress, and merge the highest-scoring card per path. Completed parts are shown progressively with a partial-results notice. Stop prevents subsequent parts and stale rendering; the active inference may finish. A failed/cancelled scan marks displayed cards stale and never presents them as complete. Editing a note invalidates its scan, while cursor movement alone does not.

Whole-note merging excludes every path seen in any part's Related stream from Discover, even if the final Related limit cuts that path. It merges per-part scores without running a new global semantic MMR selection over the union; per-part diversity is not a claim of whole-note semantic diversity.

The stabilizer preserves the relative positions of surviving current results, not obsolete membership or labels. Identical card payloads do not rebuild the card DOM. Optional response `warnings` distinguish degraded results from no matches; loss of all eligible recall channels raises an HTTP error. Logs split embedding, recall, reranking and ranking time without recording query text.

Cards also carry the exact indexed child text as `source_text`. Navigation and preview match its complete cleaned text against current source lines, including multiline/Markdown-formatted passages. Ambiguous or changed passages have no guessed location. This uses existing index text and requires no rebuild; older engines fall back to the complete snippet.

Ranking constants are defined in `engine/config/ranking_config.py`. Current notable defaults are Related weights `0.50/0.35/0.15`, Discover gate `0.45`, duplicate threshold `0.88`, and MMR lambda `0.65`. Do not duplicate these numbers in implementation.

Each stream emits at most one evidence-based label: `MISSING_LINK`, `ISLAND_WAKE`, `CONCEPT_BRIDGE` (optionally carrying a target), `CROSS_DOMAIN`, or `TOPIC_TAG`. `ISLAND_WAKE` means no outgoing links, and `CROSS_DOMAIN` means a different top-level folder. New engines do not emit `DEEP_ECHO`; older response label codes remain display-compatible. The UI does not show high/medium/low score tiers because these heuristic scores are not calibrated confidence across queries.

### Sidecar lifecycle

1. Desktop auto-start uses the engine virtual environment when present, then spawns the configured Python backend. Force restart only stops the process held by the current plugin instance; the parent watchdog handles processes left by a previous session.
2. Health polling uses bounded retry/backoff and a circuit breaker after repeated launch failure. Three automatic recovery attempts exhaust the budget; elapsed time alone cannot reset it. Manual restart or a healthy connection resets recovery. Quiet health polling remains available to detect an externally restored engine.
3. The backend watches `SEMANTIX_PARENT_PID`; on Windows, a parent exit code other than `259` means the host is no longer active.
4. User-initiated stop suppresses auto-restart. The watchdog and shutdown path release process and database resources.

## 5. HTTP boundary

`engine/models.py`, FastAPI's generated OpenAPI schema, `engine/main.py`, and `src/api/types.ts` are authoritative. This document catalogs behavior but does not duplicate payload examples.

When `SEMANTIX_API_TOKEN` is configured, the global FastAPI dependency requires the `X-Semantix-Token` header on every route. `vault_id` is carried in index/search request bodies and in index-status, metrics, and clear-operation query parameters. Stopword computation is Vault-scoped; physical database maintenance and FTS rebuild operate on shared storage.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health`, `/ready`, `/ping` | Liveness/model state and compatibility information; `/ready` is a health alias. Health returns `ok`, `loading`, or `error` with HTTP 200; clients must inspect the state. |
| GET | `/index/status`, `/metrics` | Vault-scoped note counts/stopwords; search timing and physical storage metrics are engine-wide. |
| GET | `/index/paths` | Complete distinct indexed paths for the requested Vault; available with health capability `vault_indexed_paths`. Failure is distinct from an empty list. |
| POST | `/index/batch`, `/index/delete` | Replace indexed documents or delete paths. |
| POST | `/index/clear/request`, `/index/clear/confirm` | Two-step Vault-scoped destructive clear. |
| POST | `/index/compute-stopwords`, `/index/rebuild-fts` | Recompute lexical filters and rebuild FTS. |
| POST | `/search/radar` | Primary Related/Discover query. |
| POST | `/maintenance/run` | Engine-wide physical maintenance; manual and scheduled runs use the configured retention (at least one day). |

The reranker defaults to official `BAAI/bge-reranker-v2-m3` revision `953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e`, safetensors, no remote code, and at most 512 tokens per query/passage pair. Explicit `SEMANTIX_RERANKER_MODEL=BAAI/bge-reranker-base` retains legacy resource compatibility; GPU failure falls back to CPU using the same selected model, never silently to base. Embedding/profile/index and ranking weights/thresholds are unchanged.

Unavailable reranking returns semantic fallback with explicit response warnings, as specified by ADR-0008. `/health` and `/ready` add selected reranker model/revision/status/device. Top-level `ok` denotes available semantic retrieval; the message reports degraded reranking until ready. Permanent loading or CPU inference failure stops automatic retries until engine restart. Permanent embedding initialization failure returns an error health state and is shown to the user rather than waiting indefinitely.

Health also advertises `adaptive_lexical_soft_discount` in `capabilities`. The plugin sends adaptive=true only after that capability is observed and a Vault-scoped frequent-term recalculation succeeds on the current endpoint; older engines, offline state and failed preparation use adaptive=false with visible inactive status. Endpoint identity and request generation prevent late responses from an earlier engine connection from enabling the setting.

## 6. Storage and isolation

- The frontend derives a stable Vault identifier from Vault name and base path.
- Every persisted row and query path carries `vault_id`; new storage methods must prove this with tests.
- Successful document replacement removes obsolete chunks for only that document and Vault.
- Encoding or write failure must preserve the last valid indexed version.
- Schema incompatibility and storage failure are visible failures, never silent database recreation.
- Stopword changes serialize per storage instance and atomically replace the JSON snapshot before updating memory; write failure preserves the old snapshot and propagates to the API.
- Maintenance retains verified versions for at least one day and never forces deletion of unverified files, which may belong to a concurrent writer. This bounds normal old-snapshot readers without claiming to protect an arbitrarily long read transaction. History older than the chosen period remains eligible for pruning.

The default database path is `engine/semantix_lance`, anchored to the engine source directory independently of the process working directory. `SEMANTIX_DB_PATH` overrides it; an explicit relative override resolves from the process working directory.

## 7. Runtime configuration

The sidecar supports `SEMANTIX_API_TOKEN`, `SEMANTIX_DB_PATH`, `SEMANTIX_ALLOWED_ORIGINS`, `SEMANTIX_LOG_LEVEL`, `SEMANTIX_RERANKER_MODEL`, `SEMANTIX_PARENT_PID`, `SEMANTIX_WATCHDOG_TIMEOUT`, `SEMANTIX_HOST`, and `SEMANTIX_PORT`. Defaults and user-facing setup are maintained in `README.md` and the implementation.

## 8. Architecture invariants

- Every persistence and retrieval path `MUST` filter by `vault_id`.
- A failed document update `MUST NOT` delete its previous valid index; a successful replacement `MUST` remove obsolete chunks.
- Business logic `MUST` reuse the shared embedding and reranking services.
- The frontend `MUST` reject stale search IDs or `context_id` values.
- Loading, partial, degraded, and failed states `MUST NOT` be reported as full success.
- Dependencies and abstractions `SHOULD` be added only for a measured, current requirement.

## 9. Agent tools

Daily work needs Git, Node.js 22/npm, and Python 3.11+/uv; the commands and behavioral gates are listed in `TESTING.md`. Obsidian with a disposable Vault is required for host acceptance of editor, lifecycle, or end-to-end changes. No cloud, project-management, or additional MCP plugin is required for repository maintenance.
