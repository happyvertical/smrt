# @happyvertical/smrt-app-engine

Shared definition-driven app engine for shells and other products. The package name is provisional; keep it out of identifiers and error codes.

## Modules

- `src/index.ts`: public AppHost, definition, command, migration, sandbox and version-store contracts.
- `src/app-worker.ts`: isolated worker entry, published as `./worker`.
- `src/host.ts`: host queue, worker lifecycle, structural changes and drafts.
- [Engine contracts](agents/engine.md): persistence, approvals, sandbox limits, publish and recovery.

## Invariants

Do not import SvelteKit or shell modules. Hosts supply storage, identity and approval decisions. Preserve worker module adjacency in builds. Runtime uses SQLite in-process; tests use temporary data directories and worker threads.

## Validation

Run `pnpm build`, `pnpm typecheck` and `pnpm test`. Tests use the repository smrt Vitest plugin. Build dependencies first; workers resolve their public built entries under plain Node.
