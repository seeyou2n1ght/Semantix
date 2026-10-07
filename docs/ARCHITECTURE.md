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
- `services/embedding_service.py`, `services/reranker_service.py`: shared model lifecycle.
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

### Radar search

1. The frontend creates a `context_id` and monotonically increasing local search ID. Editor/cursor changes immediately invalidate in-flight Focus responses. One network search is in flight at a time; only the latest waiting context is sent next. Obsidian's transport does not cancel already-running inference.
2. The backend embeds the query with `为这个句子生成表示以用于检索相关文章：`.
3. FTS uses engine-owned function-word filtering plus request-scoped custom stopwords and optional Vault stopwords. With no effective terms it is skipped; embedding and reranking retain the original semantic text. Each channel targets up to 45 distinct documents, keeping at most two chunks per document. Up to four bounded batches of at least 80 rows exclude already-seen documents during refill; the channel union is then fused and aggregated. FTS-only chunks receive cosine evidence from their stored vectors and the query vector instead of an artificial zero.
4. `fast` skips CrossEncoder; `balanced` reranks up to 16 candidates; `high_quality` reranks up to 20. Candidate text includes its semantic path/title and snippet. The model service explicitly returns raw logits; sigmoid/power normalization runs once. After successful reranking, only that shortlist competes in both streams. Unscored candidates cannot substitute semantic scores to bypass reranker rejection. If reranking is unavailable, all recalled candidates use the existing semantic fallback with a response warning.
5. Related combines normalized semantic, reranker, and lexical evidence, with bounded folder/tag bonuses.
6. Discover applies a relevance gate, excludes near-duplicates and Related results, applies diversity penalties/bridges, then selects with MMR.
7. Each card includes `matched_terms`: a bounded set of informative overlaps in its displayed snippet, indicating lexical overlap rather than semantic attribution. Display-only weak-word filtering and 2+1-character Chinese compound recovery do not change recall terms or ranking weights. Missing evidence yields plain text. The response echoes `context_id`; the frontend discards stale IDs before rendering.

Explicit whole-note scans split the cleaned note into bounded text parts, search each part with its own echoed context ID, show completed-part progress, and merge the highest-scoring card per path. Completed parts are shown progressively with a partial-results notice. Stop prevents subsequent parts and stale rendering; the active inference may finish. A failed/cancelled scan marks displayed cards stale and never presents them as complete. Editing a note invalidates its scan, while cursor movement alone does not.

The stabilizer preserves the relative positions of surviving current results, not obsolete membership or labels. Identical card payloads do not rebuild the card DOM. Optional response `warnings` distinguish degraded results from no matches; loss of all eligible recall channels raises an HTTP error. Logs split embedding, recall, reranking and ranking time without recording query text.

Cards also carry the exact indexed child text as `source_text`. Navigation and preview match its complete cleaned text against current source lines, including multiline/Markdown-formatted passages. Ambiguous or changed passages have no guessed location. This uses existing index text and requires no rebuild; older engines fall back to the complete snippet.

Ranking constants are defined in `engine/config/ranking_config.py`. Current notable defaults are Related weights `0.50/0.35/0.15`, Discover gate `0.45`, duplicate threshold `0.88`, and MMR lambda `0.65`. Do not duplicate these numbers in implementation.

Each stream emits at most one evidence-based label: `MISSING_LINK`, `ISLAND_WAKE`, `CONCEPT_BRIDGE` (optionally carrying a target), `DEEP_ECHO`, `CROSS_DOMAIN`, or `TOPIC_TAG`. Older response label codes remain display-compatible.

### Sidecar lifecycle

1. Desktop auto-start uses the engine virtual environment when present, then spawns the configured Python backend. Force restart only stops the process held by the current plugin instance; the parent watchdog handles processes left by a previous session.
2. Health polling uses bounded retry/backoff and a circuit breaker after repeated launch failure.
3. The backend watches `SEMANTIX_PARENT_PID`; on Windows, a parent exit code other than `259` means the host is no longer active.
4. User-initiated stop suppresses auto-restart. The watchdog and shutdown path release process and database resources.

## 5. HTTP boundary

`engine/models.py`, FastAPI's generated OpenAPI schema, `engine/main.py`, and `src/api/types.ts` are authoritative. This document catalogs behavior but does not duplicate payload examples.

When `SEMANTIX_API_TOKEN` is configured, the global FastAPI dependency requires the `X-Semantix-Token` header on every route. `vault_id` is carried in index/search request bodies and in index-status, metrics, and clear-operation query parameters. Stopword computation is Vault-scoped; physical database maintenance and FTS rebuild operate on shared storage.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health`, `/ready`, `/ping` | Liveness/model state and compatibility information; `/ready` is a health alias. Health returns `ok`, `loading`, or `error` with HTTP 200; clients must inspect the state. |
| GET | `/index/status`, `/metrics` | Vault-scoped note counts/stopwords; search timing and physical storage metrics are engine-wide. |
| POST | `/index/batch`, `/index/delete` | Replace indexed documents or delete paths. |
| POST | `/index/clear/request`, `/index/clear/confirm` | Two-step Vault-scoped destructive clear. |
| POST | `/index/compute-stopwords`, `/index/rebuild-fts` | Recompute lexical filters and rebuild FTS. |
| POST | `/search/radar` | Primary Related/Discover query. |
| POST | `/maintenance/run` | Engine-wide physical maintenance; the request sets retention for scheduled maintenance, while manual cleanup uses zero days. |

Unavailable reranking returns semantic fallback with explicit response warnings, as specified by ADR-0008. Permanent embedding initialization failure returns an error health state and is shown to the user rather than waiting indefinitely.

## 6. Storage and isolation

- The frontend derives a stable Vault identifier from Vault name and base path.
- Every persisted row and query path carries `vault_id`; new storage methods must prove this with tests.
- Successful document replacement removes obsolete chunks for only that document and Vault.
- Encoding or write failure must preserve the last valid indexed version.
- Schema incompatibility and storage failure are visible failures, never silent database recreation.
- Stopword changes serialize per storage instance and atomically replace the JSON snapshot before updating memory; write failure preserves the old snapshot and propagates to the API.

The default database path is `./semantix_lance`; deployment may override it with `SEMANTIX_DB_PATH`.

## 7. Runtime configuration

The sidecar supports `SEMANTIX_API_TOKEN`, `SEMANTIX_DB_PATH`, `SEMANTIX_ALLOWED_ORIGINS`, `SEMANTIX_LOG_LEVEL`, `SEMANTIX_PARENT_PID`, `SEMANTIX_WATCHDOG_TIMEOUT`, `SEMANTIX_HOST`, and `SEMANTIX_PORT`. Defaults and user-facing setup are maintained in `README.md` and the implementation.

## 8. Architecture invariants

- Every persistence and retrieval path `MUST` filter by `vault_id`.
- A failed document update `MUST NOT` delete its previous valid index; a successful replacement `MUST` remove obsolete chunks.
- Business logic `MUST` reuse the shared embedding and reranking services.
- The frontend `MUST` reject stale search IDs or `context_id` values.
- Loading, partial, degraded, and failed states `MUST NOT` be reported as full success.
- Dependencies and abstractions `SHOULD` be added only for a measured, current requirement.

## 9. Agent tools

Daily work needs only Git, Node.js 22/npm, Python 3.11+/uv, and the standard-library Harness validator. Obsidian with a disposable Vault is required only for editor, lifecycle, or end-to-end changes. No cloud, project-management, or additional MCP plugin is required for repository maintenance.
