# Semantix Architecture Decisions

This file records durable decisions and their trade-offs. Current implementation facts live in `ARCHITECTURE.md`; superseded ADRs remain as history.

## Decision index

| ADR | Decision | Status | Date |
| --- | --- | --- | --- |
| ADR-0001 | Local sidecar with explicit private-remote option | Accepted | 2026-09-14 |
| ADR-0002 | Vault-scoped LanceDB with atomic document replacement | Accepted | 2026-09-14 |
| ADR-0003 | Versioned REST boundary with frontend context ownership | Accepted | 2026-09-14 |
| ADR-0004 | Four-document Agent Harness with a separate release changelog | Accepted | 2026-09-14 |
| ADR-0005 | Separate monorepo source layout from the Obsidian release contract | Accepted | 2026-09-14 |
| ADR-0006 | Position Obsidian Plugin as repository root product with Engine companion | Accepted | 2026-09-15 |
| ADR-0007 | Flatten built plugin assets to root and enforce desktop-only contract | Accepted | 2026-09-18 |
| ADR-0008 | Keep retrieval evidence and incomplete-result states explicit | Accepted | 2026-10-02 |
| ADR-0009 | Use a pinned M3 reranker with an explicit legacy resource option | Accepted | 2026-10-28 |
| ADR-0010 | Discount adaptive frequent-term evidence without deleting FTS terms | Accepted | 2026-10-28 |
| ADR-0011 | Use strength-aware lexical normalization and preserve alphanumeric query tokens | Accepted as a bounded invariant repair | 2026-10-28 |
| ADR-0012 | Retain a bounded history window during database maintenance | Accepted for local implementation | 2026-10-29 |
| ADR-0013 | Reconcile indexed paths without clearing valid documents first | Accepted for local implementation | 2026-10-30 |

## ADR-0001: Local sidecar with explicit private-remote option

**Status:** Accepted  
**Date:** 2026-09-14  
**Nature:** Documents the existing architecture.

### Context

Embedding and reranking are too heavy for the Obsidian renderer, while note privacy favors user-controlled execution.

### Alternatives considered

1. Run models inside the plugin: simpler deployment but blocks or enlarges the renderer and weakens process isolation.
2. Use a hosted service: easier centralized operations but conflicts with the local-first privacy boundary.
3. Use a local Python sidecar with an explicit private-remote endpoint: preserves process separation and user control at the cost of a second runtime.

### Decision and consequences

Use the local sidecar by default and allow an explicitly configured private-remote engine. Model work stays outside the renderer, but the project must maintain lifecycle, protocol compatibility, and secure remote-deployment guidance.

## ADR-0002: Vault-scoped LanceDB with atomic document replacement

**Status:** Accepted  
**Date:** 2026-09-14  
**Nature:** Documents an existing, regression-tested integrity rule.

### Context

Multiple Vaults share one engine process, and a note may shrink, fail embedding, or be updated concurrently with later retries.

### Alternatives considered

1. Delete then insert: simple but loses the previous valid index when encoding or insertion fails.
2. Separate physical database per Vault: strong isolation but adds lifecycle and migration overhead.
3. Scope rows by `vault_id` and atomically replace each successfully encoded document: minimal storage topology while preserving failure safety.

### Decision and consequences

Use explicit `vault_id` filtering and LanceDB merge replacement. Failed documents retain their previous entries; every new storage path must prove Vault scoping and replacement semantics with tests.

## ADR-0003: Versioned REST boundary with frontend context ownership

**Status:** Accepted  
**Date:** 2026-09-14  
**Nature:** Documents the existing client-server boundary.

### Context

The plugin and engine are separate deliverables. Editor activity can issue overlapping requests whose responses arrive out of order.

### Alternatives considered

1. Unversioned request/response calls: least code but cannot negotiate compatibility or reject stale results reliably.
2. Stateful backend sessions: centralizes ordering but adds server state and cleanup.
3. Versioned REST plus frontend-generated `context_id`: keeps the engine stateless and lets the editor own freshness.

### Decision and consequences

Expose API and index versions through health responses, and echo the frontend-generated `context_id` from Radar searches. The frontend discards stale results; API examples and TypeScript/Pydantic types must remain synchronized.

## ADR-0004: Four-document Agent Harness with a separate release changelog

**Status:** Accepted  
**Date:** 2026-09-14

### Context

Nine overlapping project documents had accumulated duplicated, stale, and contradictory setup, API, retrieval, roadmap, and architecture claims. Agents need a small routing surface without losing durable release history.

### Alternatives considered

1. Keep all topic documents: preserves familiar filenames but continues duplication and drift.
2. Put every fact, including release history, into four Harness documents: fewer files but mixes immutable released history with current progress.
3. Use four Harness documents plus root `README.md` and `AGENTS.md`: one current source per concern, with release history cleanly absorbed into `PROGRESS.md`.

### Decision and consequences

Use `ARCHITECTURE.md`, `PROGRESS.md`, `DECISION.md`, and `TESTING.md` as the only Markdown files under `docs/`. Keep root `README.md` and `AGENTS.md`. Historical release chronology is consolidated directly into `PROGRESS.md` under Release History.

## ADR-0005: Separate monorepo source layout from the Obsidian release contract

**Status:** Accepted  
**Date:** 2026-09-14

### Context

Semantix keeps an Obsidian TypeScript client and a Python Engine in one repository, while Obsidian reads repository-root metadata and installs three flat GitHub Release assets.

### Decision and consequences

Keep source under `frontend/` and `backend/`. Move the single authoritative `manifest.json` and `versions.json` to the repository root, generate ignored plugin assets under `frontend/dist/`, and publish only `main.js`, `manifest.json`, and `styles.css`. Release tags exactly equal the manifest version. This avoids duplicate metadata and preserves the frontend/backend boundary.

## ADR-0006: Position Obsidian Plugin as repository root product with Engine companion

**Status:** Accepted  
**Date:** 2026-09-15

### Context

The previous `frontend/` and `backend/` monorepo layout implied an equal, full-stack web application structure. However, the Obsidian plugin is the primary product that Obsidian users install and interact with, while the Python engine acts as a managed local sidecar/companion service controlled by the plugin lifecycle. Furthermore, separating `frontend/package.json` from root `manifest.json` led to cross-directory traversal scripts and unnatural development ergonomics.

### Decision and consequences

Elevate the Obsidian plugin to the repository root (`package.json`, `tsconfig.json`, `esbuild.config.mjs`, `src/`). Rebrand and move the Python backend to `engine/`. This aligns with the official Obsidian community plugin layout, enables natural developer workflows (`npm run dev` at root), removes all parent-directory traversal scripts, and clearly defines the backend as an auxiliary calculation engine. Engine management commands are integrated into root scripts using `uv`.

## ADR-0007: Flatten built plugin assets to root and enforce desktop-only contract

**Status:** Accepted  
**Date:** 2026-09-18

### Context

While ADR-0006 moved the plugin source to the repository root, `esbuild` still emitted output artifacts to `dist/`, causing divergence with the official Obsidian Community Plugin guidelines. Obsidian's runtime loader strictly expects `manifest.json`, `main.js`, and `styles.css` at the plugin root, meaning local vault development (`.obsidian/plugins/semantix`) and BRAT installation could not resolve `main.js`. Additionally, `manifest.json` declared `isDesktopOnly: false`, conflicting with the plugin's reliance on a local Python companion process.

### Decision and consequences

1. Reconfigure `esbuild.config.mjs` to output directly to the repository root (`outdir: "."`), emitting `main.js` and `styles.css` alongside `manifest.json`.
2. Add `/main.js` and `/styles.css` to `.gitignore` to prevent generated bundle artifacts from polluting git.
3. Update `package.json` `"main"` to `"main.js"`, and align `version-bump.mjs` and `.github/workflows/release.yml` to check and package root assets.
4. Set `"isDesktopOnly": true` in `manifest.json` and provide `"authorUrl"` to satisfy community plugin review requirements.


## ADR-0008: Keep retrieval evidence and incomplete-result states explicit

**Status:** Accepted

**Date:** 2026-10-02

### Context

A real-model probe found that CrossEncoder's default sigmoid output was treated as raw logits and normalized again. Candidates outside the reranked prefix substituted semantic scores for reranker evidence. Fixed chunk-depth recall could fill its budget with one long document. Whole-note scans waited for every part, and local stabilization could retain obsolete cards indefinitely without another response.

### Alternatives and decision

- Explicit raw logits plus one ranking conversion, instead of depending on model activation defaults or retuning weights around compressed scores.
- A bounded reranked shortlist for balanced/high-quality modes, instead of mixing unscored candidates with reranker rejections or reranking every recalled document. This retains the 16/20 inference budgets, at the cost of omitting candidates outside the shortlist; labeled recall evaluation remains necessary.
- Bounded refill excluding seen documents, instead of unlimited overfetch or raising a fixed chunk limit. This improves document coverage but may increase latency; the per-channel round cap is in ranking configuration.
- Degraded semantic fallback with an additive response warning when reranking is unavailable, instead of silently reporting normal quality or failing all searches. If all eligible recall channels fail, fail the request.
- Progressive whole-note results with explicit partial/cancelled/failed states, instead of a blank wait for all parts. Keep current result positions stable without preserving obsolete evidence.

No index migration, release version change, or ranking-weight/threshold retuning is part of this decision. Broad relevance claims require a labeled real-Vault evaluation; synthetic gates and small model probes do not establish them.


## ADR-0009: Use a pinned M3 reranker with an explicit legacy resource option

**Status:** Accepted

**Date:** 2026-10-28

### Context

The legacy base reranker preferred a same-person park event over a useful recovery paraphrase. Raising content-only admission thresholds lost useful paraphrases while retaining unrelated notes; reranking extra passages did not fix the model's judgment. A frozen 27-query stock-pipeline comparison with M3 improved useful balanced cards from 39 to 42 and reduced unrelated cards from 11 to 3 without changing embedding/index, score transforms, weights or gates. These controlled regression findings do not prove general or real-Vault accuracy, and M3 uses more memory and inference time.

### Alternatives and decision

Use the standard official `BAAI/bge-reranker-v2-m3` at tested revision `953dc6f6f85a1b2dbfca4c34a2796e7dde08d41e`, safetensors with remote code disabled. Share identity and loading options between the model service and pre-downloader. Keep the previous 512-token pair budget rather than adopting M3's much larger default context; long pairs can be truncated. Preserve existing embedding/profile/index and ranking parameters, requiring no index rebuild.

Retain only an explicit environment choice of the legacy base model for resource compatibility, rather than silently substituting a cheaper model on failure or adding a new UI selector. GPU failure retries the same model on CPU. Loading or terminal inference failure remains visible through health state and `reranker_unavailable` semantic fallback, with no repeated automatic model loading after failure. Top-level health `ok` continues to mean semantic availability for old clients, while additive fields and the message state actual reranker availability.


## ADR-0010: Discount adaptive frequent-term evidence without deleting FTS terms

**Status:** Accepted

**Date:** 2026-10-28

**Nature:** Retrieval-quality behavior; no wire or index migration.

### Context

Removing every term found in at least 30% of a Vault's notes can erase useful topic signals, especially in focused or small Vaults. The existing adaptive-filter control should reduce generic lexical influence while preserving those terms as searchable evidence.

### Alternatives considered

1. Keep adaptive terms as hard FTS exclusions: simple, but can remove useful lexical recall.
2. Change global lexical/BM25/RRF weights: broad side effects without labeled cross-topic evidence.
3. Keep adaptive terms in FTS and discount their per-candidate lexical evidence: preserves recall and bounds the change to matched terms in the selected passage.

### Decision and consequences

Choose option 3. Base function words and custom stopwords remain hard FTS exclusions; adaptive terms meeting the per-Vault 30% document-frequency cutoff remain searchable. For the candidate's selected indexed FTS tokens (note title, heading ancestry, and child passage; excluding directory names and expanded parent context), use the maximum matched-term strength: generic/function-like terms that remain after exact filtering receive 0.25, adaptive frequent terms 0.5, and any informative term 1.0. Apply the factor after batch lexical normalization. Raw BM25/RRF inputs remain unchanged, and highlight selection is evaluated separately from score qualification. Preserve existing setting and wire names, requiring no migration or index rebuild. These values are conservative heuristics, not calibrated probabilities or evidence of real-Vault relevance gains; acceptance requires controlled regression and separate relevance evaluation.

Compatibility clarification (2026-10-28): an older engine interprets adaptive=true as hard FTS removal, so health now declares the soft-discount capability explicitly. The plugin keeps the saved preference but sends false and shows inactive status until the connected endpoint declares capability and a bounded Vault recalculation succeeds. This avoids deleting lexical recall on older engines while preserving connection compatibility. A failed preparation remains inactive until a manual recalculation, setting change, or later reconnection; endpoint and request generations reject stale results.

## ADR-0011: Use strength-aware lexical normalization and preserve alphanumeric query tokens

**Status:** Accepted as a bounded invariant repair

**Date:** 2026-10-28

**Nature:** Retrieval candidate behavior; no global weights, model, index, version, or deployment change.

### Context

Applying lexical strength only after the previous shared normalization let weak-evidence rows influence normalization for stronger-evidence rows. Adaptive token extraction could also fragment full alphanumeric names. A separate proposed reservation of 25%/50% of the fixed 16/20 reranker candidate budget for semantic results needed scrutiny for starvation and useful exact matches.

### Alternatives considered

1. Keep shared normalization and current token splitting: weak rows can set stronger rows' scale, and alphanumeric names can be split.
2. Normalize each positive strength against the maximum raw BM25 of rows at least as strong, exclude zero-strength rows from denominators, and reuse full alphanumeric query terms: bounded normalization change with the existing final caps and display rules retained.
3. Reserve part of the fixed reranker budget for semantic candidates: synthetic checks reduced the useful exact count from 1 to 0, radar_service source file was byte-equal to baseline after the rejected code was removed, and starvation remained unresolved.

### Decision and consequences

Accept option 2 as a bounded invariant repair, supported by deterministic defect reproduction and controlled real-model nonregression. Final lexical contribution caps remain 0.25/0.5/1.0; raw BM25/RRF ordering, global weights, model, index, version, and deployment do not change. Single ASCII `C` and `R` may contribute rank evidence only when they equal complete whitespace-delimited indexed tokens; `C++` and `C#` do not qualify as `C` evidence. Display retains the minimum two-character rule for all terms. Adaptive extraction reuses full alphanumeric query terms such as `GPT4o`, `Python3`, and `Go`. Existing stored snapshots require normal recalculation; no automatic production change or migration is performed. `C++`/`C#` conflation with `C` is deferred, and full strength from one ordinary informative word remains a known limitation. Evidence and probe JSON are recorded at `C:/Users/seeyo/Documents/Codex/2026-10-28/semantix-lexical-validation`; the final 89-test engine run passed without pytest warnings in 8.93 seconds. A frozen 12-query/28-note real-model comparison retained identical useful/irrelevant/missing counts (fast 11/31/0; balanced 11/3/0), card order and scores. It shows no measured relevance improvement; the final single-letter boundary repair is separately covered by real-FTS tests and the full suite, since no frozen input exercises that branch. No real-Vault or latency acceptance is claimed.

## ADR-0012: Retain a bounded history window during database maintenance

**Status:** Accepted for local implementation

**Date:** 2026-10-29

### Context

The maintenance button sent a selected retention period but the engine always optimized with zero days. LanceDB 0.29.2 documents that zero days removes every verified version except the latest, and `delete_unverified=True` may remove files from an in-progress write without an age check. The heading-only indexing fallback separately truncated text to 500 characters.

### Decision and consequences

Manual maintenance uses the requested retention, or the current retention when the body is omitted; scheduled maintenance uses the same policy. The minimum is one day, the default remains seven days, and saved zero-day settings migrate to one day. Leave `delete_unverified=False`, retaining LanceDB's age protection for files from incomplete writes. The nonzero window allows ordinary readers on recent snapshots to finish while older history remains eligible for pruning; it is not a guarantee for arbitrarily long reads or independent processes. Do not use disk-size reduction as the correctness criterion. Heading-only text is split into bounded overlapping chunks instead of being truncated; body-bearing notes retain their existing chunking path.

## ADR-0013: Reconcile indexed paths without clearing valid documents first

**Status:** Accepted for local implementation

**Date:** 2026-10-30

### Context and alternatives

File events received only while the plugin is loaded cannot describe changes made while Obsidian is closed. Replacing the currently visible files alone also leaves deleted, renamed or newly excluded paths in storage. Clearing the Vault before rebuilding would destroy valid indexes when a subsequent read, embedding or submission fails. Re-embedding every note on every health poll would impose unnecessary model work.

### Decision and consequences

Expose an explicitly Vault-scoped indexed-path inventory, keep successful local file signatures, and reconcile at connection/lifecycle boundaries and when exclusions change. Expand exclusions to concrete known paths for the exact-path search API, and apply the same matcher to displayed cards. Missing/failed inventory must remain distinguishable from an empty index; destructive cleanup requires a successful inventory and current local file enumeration. Full rebuild replaces eligible files individually and removes obsolete paths without clearing the valid indexes of current files first.

Coordinate reconciliation, full rebuild and clear within the plugin instance, and wait for in-flight incremental work before the clear boundary. A successful clear may discard earlier queued work, while later file events remain eligible for sync. Failed clear retains pending work. This coordination is not a distributed lock for independent clients or processes.

Local mtime/size signatures detect ordinary filesystem changes; they do not prove content identity when another tool preserves both values. An explicit full rebuild remains the repair path for that case. Host acceptance and representative real-Vault cost must be measured separately from controlled regression tests. The shared rerank shortlist and relevance gates remain unchanged; whole-note stream identity is repaired without claiming a new global semantic MMR pass.
