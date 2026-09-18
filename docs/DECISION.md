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
