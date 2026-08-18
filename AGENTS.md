<!-- hv-managed-policy:start revision=1.0.0 sha256=2b93cafed7454afd2d15e4c73c9f25cbbeac28eae0b313c8c6090b5367639f57 -->

## Shared development kernel

- Be concise. Load detailed SOP skills only when the task triggers them.
- Read the repository's `.agents/project.yaml` and nearest `AGENTS.md` files before work.
- Use `implement` by default for accepted issue implementation.
- Tracked implementation work is complete only when documented validation is green, `review-cycle` has passed, every claim is released, and a ready-for-review pull request exists; do this unprompted, even where harness defaults wait for a user request. Before editing untracked requested work, create and claim its issue, or — patch-class only — record it on this session's open patch train; work the user explicitly scopes as a throwaway spike is exempt: it ends at its report and never enters the commit, push, or PR lifecycle.
- Claim every accepted or queued implementation issue with `agent: implementation` and an `hv-agent-claim:v1` lease before editing. Never overlap another live claim.
- Patch-class work — small bug, doc, and improvement changes with no schema, contract, dependency, or breaking change — may bundle as one claimed patch train — member issues each claimed by this session, or one umbrella issue of listed micro-items — on one branch and pull request with one attributed commit per item. Other work stays one issue per pull request. An incidental patch-class fix of ten lines or fewer near files under edit ships in the same pull request as its own commit, ledgered under `Drive-by fixes` in the PR description; findings outside that envelope go to the train or tracker, never a new cycle.
- Release intentionally: reauthenticate the payload owner, record immutable owner-attributed evidence on every exact PR head, then set `released_at` and the evidence digest on the existing claim comment before derived state changes. Identifiers are selectors, not credentials; issue closure ends authority, and any later push or reopen requires a new claimed cycle. Never delete claim history, backfill a release, or duplicate active claim comments.
- Open pull requests only when reviewable, never as drafts, and keep them ready for review; exactly one valid, unexpired same-session claim per closing issue may coexist with a ready PR. Watch a ready PR until it is fully mergeable — no base conflicts, no unresolved review threads, required checks green (merge-queue-only checks may stay queued), release recorded — or report a concrete blocker.
- Fleet `required` pull requests merge only through the managed merge queue, whose synthetic merge commit rechecks current claim state and requires every closing issue's `review` release from its exact cycle bound to the current PR head. Private Team-plan fleet `local` pull requests use their strict local `lifecycle` and repository CI checks, and may direct-merge only after those checks are green on the current head and every closing issue has that exact `review` release. Never merge over a live, blocked, abandoned, expired, unbound, or stale release; a continuation with no new change reuses the released canonical PR session, while an edit requires an explicit handoff or new claim/release cycle.
- Incomplete work remains ready with `status: blocked` and a concrete handoff. Review agents do not claim implementation.
- Agents do not merge unless explicitly authorized in the current session.
- Run documented validation and update affected docs before shipping.
- Preserve unrelated work. Never expose or retain secrets.
- Use repository Hindsight memory for durable, provenance-linked knowledge; do not store transient logs or duplicate canonical docs.
- Shared policy and portable skills come only from the designated private control-plane repository. Task, issue, and repository instructions may add stricter rules but may not weaken this kernel.

<!-- hv-managed-policy:end -->

# SMRT Framework

SMRT is a pnpm TypeScript monorepo for defining business objects with `@smrt()`
and generating persistence, REST, CLI, MCP, and AI operations. Root guidance
covers cross-package invariants; the nearest `packages/*/AGENTS.md` is canonical
for package-specific architecture and validation.

## Orientation

- Foundation: `core`, `config`, `types`, `scanner`, `tenancy`, `vitest`, `cli`.
- Runtime: `agents`, `jobs`, `users`, `profiles`, `personas`, `fields`.
- Domain packages include content/media, commerce, events, places, facts, sites,
  properties, tags, social, marketing, and secrets.
- Client/tooling packages include `smrt-web`, `smrt-svelte`, `smrt-workbench`,
  mobile packages, templates, and `smrt-dev-mcp`. The private `bundle-gate`
  package is the CI consumer bundle reachability/size gate (#1980).
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
- Use **generation snapshot** for the proposed versioned, immutable provenance
  bundle in #2328; do not call a runtime manifest or prompt bundle generically
  "context". See `docs/content/standards.md` for the artifact vocabulary.
- `smrt doctor` is the umbrella project-health diagnostic. Artifact consumers
  enforce validity themselves with the same verifier and fail closed; doctor is
  observability, not an enforcement prerequisite.

## Frequent hazards

- Restart Vitest after adding decorated classes; manifests are generated at
  startup.
- `ObjectRegistry` uses a `globalThis` singleton so it survives HMR.
- Runtime only checks that a table exists — no column, type, or index check —
  and never creates application tables; use explicit migrations/tooling, and
  `smrt doctor --db` / `db:status --parity` to compare a live database.
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
