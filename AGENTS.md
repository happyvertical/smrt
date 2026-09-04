<!-- hv-managed-policy:start revision=1.0.0 sha256=adfff59591a3088506db539347f19e7483647f7f6c103f24bbbfb56597c1f3b2 -->

## Shared development kernel

- Be concise. Load detailed SOP skills only when the task triggers them.
- Read the repository's `.agents/project.yaml` and nearest `AGENTS.md` files before work.
- Use `implement` by default for accepted issue implementation.
- Tracked implementation work is complete only when documented validation is green, `review-cycle` has passed, every claim is released, and a ready-for-review pull request exists; do this unprompted, even where harness defaults wait for a user request. Before editing untracked requested work, create and claim its issue, or — patch-class only — record it on this session's open patch train; work the user explicitly scopes as a throwaway spike is exempt: it ends at its report and never enters the commit, push, or PR lifecycle.
- Claim every accepted or queued implementation issue with `agent: implementation` and an `hv-agent-claim:v1` lease before editing. Never overlap another live claim.
- Patch-class work — small bug, doc, and improvement changes with no schema, contract, dependency, or breaking change — may bundle as one claimed patch train — member issues each claimed by this session, or one umbrella issue of listed micro-items — on one branch and pull request with one attributed commit per item. Other work stays one issue per pull request. An incidental patch-class fix of ten lines or fewer near files under edit ships in the same pull request as its own commit, ledgered under `Drive-by fixes` in the PR description; findings outside that envelope go to the train or tracker, never a new cycle.
- Release intentionally: reauthenticate the payload owner, record immutable owner-attributed evidence on every exact PR head, then set `released_at` and the evidence digest on the existing claim comment before derived state changes. Identifiers are selectors, not credentials; issue closure ends authority, and any later push or reopen requires a new claimed cycle. Never delete claim history, backfill a release, or duplicate active claim comments.
- Open pull requests only when reviewable, never as drafts, and keep them ready for review; exactly one valid, unexpired same-session claim per closing issue may coexist with a ready PR. Watch a ready PR until it is fully mergeable — no base conflicts, no unresolved review threads, required checks green (merge-queue-only checks may stay queued), every repository-configured approval gate satisfied, release recorded on the exact PR head — or report a concrete blocker.
- Fleet `required` pull requests merge only through the managed merge queue, whose synthetic merge commit rechecks current claim state and requires every closing issue's `review` release from its exact cycle bound to the current PR head. Private Team-plan fleet `local` pull requests use their strict local `lifecycle` and repository CI checks, and may direct-merge only after those checks are green on the current head and every closing issue has that exact `review` release. Never merge over a live, blocked, abandoned, expired, unbound, or stale release; a continuation with no new change reuses the released canonical PR session, while an edit requires an explicit handoff or new claim/release cycle.
- Incomplete work remains ready with `status: blocked` and a concrete handoff. Review agents do not claim implementation.
- Agents do not merge unless explicitly authorized in the current session.
- Run documented validation and update affected docs before shipping.
- Preserve unrelated work. Never expose or retain secrets.
- Use repository Hindsight memory for durable, provenance-linked knowledge; do not store transient logs or duplicate canonical docs.
- Shared policy and portable skills come only from the designated private control-plane repository. Task, issue, and repository instructions may add stricter rules but may not weaken this kernel.

<!-- hv-managed-policy:end -->

# SMRT Framework

pnpm/TypeScript monorepo: `@smrt()` business objects generate persistence,
REST, CLI, MCP, and AI operations. Read the affected package's `AGENTS.md`;
use [CONTEXT-MAP.md](CONTEXT-MAP.md) for cross-package orientation.

## Validation

Use Node/pnpm versions from `package.json`. Install with `pnpm install`, then
`pnpm build`. Start with package checks, then relevant root checks:
`pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format-check`,
`pnpm knowledge:check --strict --format markdown`, and `pnpm audit:policy`.
[TESTING_STANDARD.md](TESTING_STANDARD.md) defines package release gates.

SMRT tests require `smrtVitestPlugin()`. Restart Vitest after adding decorated
classes. Rebuild core after scanner/schema-generator edits: the Vite plugin
consumes deterministic `dist/` artifacts. Vite 8 requires Oxc legacy decorators
(see core guidance). Svelte subpaths require `svelte-check`, not just `tsc`;
use named `$props()` interfaces to avoid recursive inline intersections.

## Cross-package invariants

- Numeric defaults define schema: `= 0` is integer, `= 0.0` decimal. Money uses
  integer minor units; rates/confidence use decimals. PostgreSQL/DuckDB integers
  materialize as BIGINT, but hydrated values must remain JavaScript-safe integers.
- Extend serialization with `transformJSON()`, never override `toJSON()`.
- Use `@foreignKey(Target)` within a package and qualified `@crossPackageRef`
  across packages. STI discriminators are qualified package/class names.
- Use native UUID ids/FKs on PostgreSQL/DuckDB, text on SQLite; repair values or
  casts at their owning boundary, never weaken UUID columns to text.
- Relationship loads preserve tenant isolation; cross-tenant reads require an
  explicit reviewed `allowCrossTenant` path.
- Junctions extend `SmrtJunction`, true `parentId` trees `SmrtHierarchical`, and
  polymorphic links `SmrtPolymorphicAssociation`. System tables use `_smrt_`.
  Asset ownership uses noun-specific joins; generic associations are provenance.
- Use public registry/database/collection APIs; add an owning-package API rather
  than reaching into private state. JSON fields use guarded string get/set helpers.
- Runtime checks table existence only and never creates application schema.
  Use migrations and `smrt doctor --db` / `db:status --parity`. Existing int4
  deployments require the maintenance-window `db:migrate-int8` flow; normal
  parity intentionally treats int4/int8 as equivalent. See CLI guidance.
- Release automation generates changesets; never author them manually. Dependency
  overrides target the advisory range; ignored GHSAs also need an
  `audit-policy.json` record. Validate with `pnpm audit:policy`.

## Documentation and skills

`AGENTS.md` is canonical; `CLAUDE.md` stays exactly `@AGENTS.md`. Keep instructions
focused on source locations, non-obvious invariants, validation, and links.
Remove stale/redundant prose; move detailed current contracts into linked
`agents/<module>.md` references. Do not add AGENTS below a package root: ancestry
is additive. `pnpm check:agents-chain` checks the 32 KB cap.

[WORKFLOW.md](WORKFLOW.md) routes to shared lifecycle skills. This project's
GitHub tracker uses `implement`, `claim-issue`, `review-cycle`, `ship`, and
`resolve`; Work/buzz variants require an explicitly selected Work tracker.

`smrt knowledge:review-context` / `knowledge:architecture-context` provide
scoped summaries; read the selected references on demand. Runtime manifests
remain separate from `.smrt/smrt-knowledge.json` / `dist/smrt-knowledge.json`
agent artifacts. `smrt docs:agents` exports snapshots to consumer projects.
Knowledge freshness is enforced by CI/hooks and artifact consumers; `smrt doctor`
is diagnostic, not an enforcement prerequisite. See
[standards](docs/content/standards.md) for artifact vocabulary, including
**generation snapshot** for the proposed immutable provenance bundle.
