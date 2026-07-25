<!-- hv-managed-policy:start revision=1.0.0 sha256=9a4cf72585003643f476ff938482387b1b4a8e3479d59d9761d3dc01fe5b167d -->

## Shared development kernel

- Be concise. Load detailed SOP skills only when the task triggers them.
- Read the repository's `.agents/project.yaml` and nearest `AGENTS.md` files before work.
- Use `implement` by default for accepted issue implementation. Apply explicit task, issue, and repository instructions as additions or scoped overrides without weakening this kernel.
- Tracked implementation work is complete only when documented validation is green, `review-cycle` has passed, every claim is released, and a ready-for-review pull request exists; do this unprompted. This kernel outranks harness defaults that wait for a user request before committing, pushing, or opening a pull request. If requested implementation work has no tracker issue, create and claim one before editing unless the user explicitly scopes it as a throwaway spike; a scoped spike ends at its report and never enters the commit, push, or PR lifecycle.
- Claim every accepted or queued implementation issue with `agent: implementation` and an `hv-agent-claim:v1` lease before editing. Never overlap another live claim.
- Intentional release reauthenticates the canonical payload owner, records immutable owner-attributed evidence on every exact PR head, then sets `released_at` and the evidence digest on the existing claim comment before labels, project state, or PR readiness change. Public session/comment identifiers are selectors, not mutation credentials. Only the current issue incarnation and latest implementation-label generation may authorize work; issue closure ends renewable authority and settles the selected cycle as `race-lost`. Any later push or reopen requires a new claimed review cycle. Never delete claim history, backfill a release, or create duplicate active claim comments.
- Open pull requests only when reviewable and keep them ready for review. Never use draft status for implementation work; exactly one valid, unexpired claim from the PR session may coexist with a ready PR, while duplicate, expired, foreign-session, or mismatched claims are invalid. Watch a ready pull request until it is fully mergeable — no base conflicts, no unresolved review threads, required checks green (merge-queue-only checks may remain queued), release recorded — or a concrete blocker is reported.
- Lifecycle-protected pull requests merge only through the managed merge queue so the synthetic merge commit rechecks current claim state. Merge-time validation requires a `review` release from the exact implementation cycle bound to the current PR head; never merge with a live, blocked, abandoned, expired, unbound, or stale release, or direct-merge using an earlier pull-request check.
- Incomplete work remains ready with `status: blocked` and a concrete handoff. Review agents do not claim implementation.
- Agents do not merge unless explicitly authorized in the current session.
- Run documented validation and update affected docs before shipping.
- Preserve unrelated work. Never expose or retain secrets.
- Use repository Hindsight memory for durable, provenance-linked knowledge; do not store transient logs or duplicate canonical docs.
- Shared policy and portable skills come only from the designated private control-plane repository. Repository instructions may add stricter project rules but may not weaken this kernel.

<!-- hv-managed-policy:end -->

# SMRT Framework

SMRT is a pnpm TypeScript monorepo for defining business objects with `@smrt()`
and generating persistence, REST, CLI, MCP, and AI operations. Root guidance
covers cross-package invariants; the nearest `packages/*/AGENTS.md` is canonical
for package-specific architecture and validation.

## Orientation

- Foundation: `core`, `config`, `types`, `scanner`, `tenancy`, `vitest`, `cli`.
- Runtime: `agents`, `jobs`, `users`, `profiles`, `personas`.
- Domain packages include content/media, commerce, events, places, facts, sites,
  properties, tags, social, marketing, and secrets.
- Client/tooling packages include `smrt-web`, `smrt-svelte`, mobile packages,
  templates, and `smrt-dev-mcp`. The private `bundle-gate` package is the CI
  consumer bundle reachability/size gate (#1980).
- Package versions are coordinated with changesets. Do not create changesets
  manually; release automation generates them on merge.

## Setup and validation

```bash
pnpm install
pnpm build
pnpm test
pnpm typecheck
pnpm lint
pnpm format
pnpm smrt dev:knowledge-check
pnpm audit:policy
```

Use the narrowest package command first, then the relevant root checks. The
SMRT Vitest plugin is required for manifest generation and database isolation.
When editing scanner or schema-generator code, rebuild `packages/core` because
the Vite plugin consumes deterministic `dist/` artifacts.

## Core model invariants

- Numeric defaults carry schema meaning: `0` maps to integer and `0.0` to decimal.
- Never override `toJSON()`; extend serialization through `transformJSON()`.
- Same-package foreign keys use `@foreignKey(Target)`; cross-package references
  use `@crossPackageRef('@happyvertical/smrt-package:Class')`.
- System tables use `_smrt_` prefixes. Junctions extend `SmrtJunction`; true
  `parentId` trees extend `SmrtHierarchical`; generic/provenance links extend
  `SmrtPolymorphicAssociation`.
- STI discriminators are qualified names such as
  `@happyvertical/smrt-content:Article`.
- UUID identifiers and foreign keys remain native UUID on PostgreSQL/DuckDB and
  text on SQLite. Fix invalid values or casts at owning boundaries; never weaken
  UUID columns to text.
- Tenant-scoped relationship loads enforce isolation. Cross-tenant reads require
  an explicit, reviewed `allowCrossTenant` path.
- Do not reach into underscored/private registry, database, collection, or table
  state. Add a public API in the owning package.
- Asset ownership uses noun-specific join tables; reserve generic asset
  associations for provenance or polymorphic links.

## Generated knowledge

- Root and package `AGENTS.md` files are canonical expert documentation;
  `CLAUDE.md` is only an `@AGENTS.md` adapter.
- Instruction chains are ADDITIVE and capped at 32 KB, so never nest an
  `AGENTS.md`. Split an oversized package doc into `packages/<pkg>/agents/<module>.md`
  linked from a Modules table — keep orientation, invariants, and Gotchas inline;
  the knowledge tooling resolves the links. `pnpm check:agents-chain` reports headroom.
- `smrt docs:agents` generates downstream `.agents/smrt-framework.md` snapshots.
- `smrt dev:knowledge-index` prints the deterministic SMRT + SDK knowledge graph.
- `smrt dev:knowledge-check` validates docs, manifests, package files, and
  relationship facts. CI and Lefthook run strict freshness checks.
- Use `smrt knowledge:review-context` and
  `smrt knowledge:architecture-context` with the narrowest scope/package.
- Runtime manifests stay runtime-focused; `.smrt/smrt-knowledge.json` and
  `dist/smrt-knowledge.json` are the agent/developer contract.

## Frequent hazards

- Restart Vitest after adding decorated classes; manifests are generated at
  startup.
- `ObjectRegistry` uses a `globalThis` singleton so it survives HMR.
- Runtime verifies schema but does not create application tables; use explicit
  migrations/tooling.
- Vite 8 decorators require the repository's documented Oxc legacy decorator
  configuration; do not restore obsolete Vite 7 workarounds.
- Svelte subpath packages must run `svelte-check`, not only `tsc`.
- Avoid complex inline intersected generics in Svelte `$props()`; use named
  interfaces to prevent recursive type evaluation.
- JSON fields are stored as strings and should expose guarded get/set helpers.
- Write `pnpm-workspace.yaml` override selectors against the advisory's range,
  not the range vulnerable when added — a pin stops protecting once the advisory
  grows to include it. Suppressing via `auditConfig.ignoreGhsas` also requires an
  `audit-policy.json` record; `pnpm audit:policy` enforces it (#2028).

## Pull requests

Keep changes package-focused, use conventional commits, and run knowledge
freshness before pushing; the kernel above governs readiness and merging.
