# Semantix Architecture

This document is the durable source for product scope, system boundaries, contracts, and architecture invariants. Current gaps and priorities live in `PROGRESS.md`; released history lives in `../CHANGELOG.md`.

## 1. Scope

Semantix is a local-first Obsidian plugin that indexes Markdown notes and returns two explainable recommendation streams:

- **Related**: the most directly relevant notes for the active context.
- **Discover**: relevant but diverse notes intended to surface less obvious connections.

Primary users run Obsidian Desktop with a local Python sidecar. A user-configured private remote engine is supported by the protocol, but the mobile support policy is still an open product decision.

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
| Q3 | When reranking is unavailable, should balanced/high-quality requests fail or return an explicitly degraded result? | Determines truthful score semantics and UI behavior. |

## 2. System topology

```text
Obsidian plugin (TypeScript)
  editor context -> freshness gate -> REST client -> Related/Discover UI
                                 |
                                 v
FastAPI sidecar (Python)
  routes -> RadarService -> RetrievalService -> ranking pipeline
                  |              |                    |
                  v              v                    v
          embedding/reranker  LanceDB + FTS      labels + MMR
```

The plugin owns editor context and response freshness. The companion engine owns indexing, retrieval, ranking, storage, and model lifecycle.

### Release boundary

The repository is organized with the Obsidian plugin as the root primary product and the companion calculation engine under `engine/`. Obsidian metadata (`manifest.json`, `versions.json`) lives at the repository root alongside `package.json`. esbuild writes ignored assets to `dist/`; GitHub Release publishes only `main.js`, `manifest.json`, and `styles.css`. Release tags exactly match the manifest version without a `v` prefix.

## 3. Module boundaries

### Plugin (`src/`)

- `main.ts`: plugin lifecycle, settings, indexing orchestration, and Vault events.
- `api/`: HTTP client and TypeScript wire types.
- `core/context.ts`: converts editor state into a Radar context.
- `core/query-gate.ts`: debounces insignificant context changes.
- `core/result-stabilizer.ts`: stabilizes visible results across related contexts.
- `core/radar.ts`: schedules searches and rejects stale responses.
- `core/service-manager.ts`: local process startup, PID cleanup, health checks, bounded recovery, and shutdown.
- `ui/`: sidebar and preview rendering; it never accesses storage directly.

### Engine (`engine/`)

- `main.py`: process lifecycle and HTTP boundary.
- `models.py`: Pydantic wire contracts.
- `services/index_service.py`: Markdown chunking and index preparation.
- `services/retrieval_service.py`: vector/FTS recall, fusion, and document aggregation.
- `services/radar_service.py`: Related/Discover orchestration.
- `services/embedding_service.py`, `services/reranker_service.py`: shared model lifecycle.
- `services/ranking/`: score normalization, Related ranking, Discover gating/MMR, and labels.
- `storage/lancedb_storage.py`: Vault-scoped persistence, replacement, deletion, and FTS lifecycle.
- `config/ranking_config.py`: ranking thresholds, limits, and weights SSOT.

## 4. Data flows

### Indexing

1. The plugin discovers changed Markdown files and sends adaptive batches of at most 25 notes and 150,000 characters.
2. The frontend yields between batches to avoid monopolizing the renderer thread.
3. The backend parses header-aware chunks, embeds them, and replaces only successfully prepared documents.
4. Failed documents retain their previous valid chunks and are reported as failures.
5. A completed full indexing pass requests immediate FTS rebuild.

### Radar search

1. The frontend creates a `context_id` and monotonically increasing local search ID.
2. The backend embeds the query with `为这个句子生成表示以用于检索相关文章：`.
3. Vector and FTS results are fused and aggregated by document. Radar requests use the configured 45-candidate recall limit.
4. `fast` skips CrossEncoder; `balanced` reranks up to 24 candidates; `high_quality` reranks up to 30.
5. Related combines normalized semantic, reranker, and lexical evidence, with bounded folder/tag bonuses.
6. Discover applies a relevance gate, excludes near-duplicates and Related results, applies diversity penalties/bridges, then selects with MMR.
7. The response echoes `context_id`; the frontend discards stale IDs before rendering.

Ranking constants are defined in `engine/config/ranking_config.py`. Current notable defaults are Related weights `0.50/0.35/0.15`, Discover gate `0.45`, duplicate threshold `0.88`, and MMR lambda `0.65`. Do not duplicate these numbers in implementation.

Current labels are generated from actual evidence: Related uses `KEYWORD_MATCH`, `DEEP_SEMANTIC`, `SAME_FOLDER`, `SHARED_TAGS`, or `RELEVANT`; Discover uses `UNLINKED`, `SHARED_CONCEPT`, `CROSS_TOPIC`, `CROSS_FOLDER`, `SHARED_TAGS`, or `SERENDIPITY`.

### Sidecar lifecycle

1. Desktop auto-start validates or removes a recorded orphan process before spawning the configured Python backend.
2. Health polling uses bounded retry/backoff and a circuit breaker after repeated launch failure.
3. The backend watches `SEMANTIX_PARENT_PID`; on Windows, a parent exit code other than `259` means the host is no longer active.
4. User-initiated stop suppresses auto-restart. The watchdog and shutdown path release process and database resources.

## 5. HTTP boundary

`engine/models.py`, FastAPI's generated OpenAPI schema, `engine/main.py`, and `src/api/types.ts` are authoritative. This document catalogs behavior but does not duplicate payload examples.

When `SEMANTIX_API_TOKEN` is configured, the global FastAPI dependency requires the bearer token on every route. `vault_id` is carried in index/search request bodies and in relevant status, metrics, maintenance, and clear-operation query parameters.

| Method | Route | Purpose |
| --- | --- | --- |
| GET | `/health`, `/ready`, `/ping` | Liveness/model state and compatibility information; `/ready` is currently a health alias and may return loading state with HTTP 200. |
| GET | `/index/status`, `/metrics` | Vault-scoped index and runtime information. |
| POST | `/index/batch`, `/index/delete` | Replace indexed documents or delete paths. |
| POST | `/index/clear/request`, `/index/clear/confirm` | Two-step Vault-scoped destructive clear. |
| POST | `/index/compute-stopwords`, `/index/rebuild-fts` | Recompute lexical filters and rebuild FTS. |
| POST | `/search/radar` | Primary Related/Discover query. |
| POST | `/search/semantic` | Deprecated compatibility search. |
| POST | `/maintenance/run` | Vault-scoped maintenance. |

The current reranker-unavailable behavior does not yet meet the truthful-degradation invariant; remediation is tracked in `PROGRESS.md`.

## 6. Storage and isolation

- The frontend derives a stable Vault identifier from Vault name and base path.
- Every persisted row and query path carries `vault_id`; new storage methods must prove this with tests.
- Successful document replacement removes obsolete chunks for only that document and Vault.
- Encoding or write failure must preserve the last valid indexed version.
- Schema incompatibility and storage failure are visible failures, never silent database recreation.

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
