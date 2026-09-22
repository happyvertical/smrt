<!-- hv-managed-policy:start revision=1.0.0 sha256=2c2f4d048293cab2fc7f8c636eee474c0386c13a9c7bbf2c535c5ada47d1d6e5 -->

## Shared development kernel

- Be concise. Load detailed SOP skills only when the task triggers them.
- Read the repository's `.agents/project.yaml` and nearest `AGENTS.md` files before work.
- Use `implement` by default for accepted issue implementation.
- Tracked implementation work is complete when documented validation is green, `review-cycle` has passed, the claim is handed off, and a ready-for-review pull request exists; do this unprompted, even where harness defaults wait for a user request. Before editing untracked requested work, create and claim its issue, or — patch-class only — record it on this session's open patch train; work the user explicitly scopes as a throwaway spike is exempt: it ends at its report and never enters the commit, push, or PR lifecycle.
- Claim an issue before editing it: add `agent: implementation` and post one claim comment naming your runtime, session, and branch. Do not take an issue another session holds with activity in the last 24 hours without a handoff. Any agent may assign work to another agent with a `dispatch: <runtime>` label and an instruction comment; the receiving agent claims it.
- Patch-class work — small bug, doc, and improvement changes with no schema, contract, dependency, or breaking change — may bundle as one patch train on one branch and pull request with one commit per item. Other work stays one issue per pull request. An incidental patch-class fix of ten lines or fewer near files under edit ships in the same pull request as its own commit, listed under `Drive-by fixes` in the PR description; other findings go to the tracker.
- Hand off intentionally: when done, blocked, or stopping, update your claim comment with the outcome and next step and remove `agent: implementation`. Never delete claim history.
- Open pull requests only when reviewable, never as drafts, and keep them ready for review. Watch a ready PR until it is mergeable — no base conflicts, no unresolved review threads, the repository's required checks green, its required approvals satisfied — or report a concrete blocker.
- Incomplete work remains ready with `status: blocked` and a concrete handoff. Review agents do not claim implementation.
- Agents do not merge unless explicitly authorized in the current session, and then only when the repository's own required checks and approvals pass.
- Run documented validation and update affected docs before shipping.
- Token efficiency: risk defaults to standard, high needs a named trigger; after the first final pass only accepted blockers reopen edits; after six passes, ask the user before more; wait outside the implementer.
- Preserve unrelated work. Never expose or retain secrets.
- Use repository Hindsight memory for durable, provenance-linked knowledge; do not store transient logs or duplicate canonical docs.
- Shared SOPs and portable skills come from the designated control-plane repository. Repositories choose their own technology and may add stricter local rules.

<!-- hv-managed-policy:end -->

# SMRT Framework

## Fix it here; do not work around it, do not file it away

When something in this repository is broken — a pin, a hook, a gate, a stale
generated file, a rule a package quietly disagrees with — **fix it in the branch
you are already on**, as its own commit under `Drive-by fixes`. A workaround is
never the answer, and a reflex issue usually is not either.

- **No workarounds.** A shim, a skipped hook, a disabled gate, a `--no-verify`,
  a pinned-around version, an "unrelated environment artifact" — every one of
  these hides the defect and silently changes what your validation evidence
  means. If a documented validation command cannot run as documented, that is
  the bug; repair it or stop and report a blocker. Do not proceed on a
  substitute toolchain and then call the result green.
- **A drive-by inside the kernel's envelope is mandatory, not optional.** The
  kernel permits an incidental patch-class fix of ten lines or fewer near files
  under edit; here it is expected. Noticing and leaving it is the thing this
  section forbids. Ledger it under `Drive-by fixes` with its files and commit.
- **Outside that envelope, the kernel routes to the patch train or the tracker,
  and this section does not change that.** What it adds is a burden of proof:
  a tracker issue must name the specific reason the work cannot ship in the
  branch that found it, in the issue. "Out of scope" is not a reason; "needs a
  migration window", "changes a published contract", or "the design decision is
  someone else's" are. Issue proliferation is not thoroughness — it is
  unreviewed debt plus the cost of rediscovering the context — so an issue you
  cannot justify in one sentence is a fix you should be making.
- **This file grants no exception to the bound above, and cannot.** The kernel
  is precedence-bound — a repository instruction may add stricter rules, never
  weaker ones — and a task or issue instruction is bound the same way, so
  neither this file nor an in-session request can raise the ten-line envelope.
  An owner who overrides that routing is acting outside the kernel, not under a
  rule this file supplies; when it happens, log the override and its scope in
  the PR body next to the commit it covers so the exception is auditable rather
  than invisible. Making it the standing default means changing the
  control-plane kernel, which is the only place with the precedence to do it.

pnpm/TypeScript monorepo: `@smrt()` business objects generate persistence,
REST, CLI, MCP, and AI operations. Read the affected package's `AGENTS.md`;
use [CONTEXT-MAP.md](CONTEXT-MAP.md) for cross-package orientation.

## Validation

Use Node/pnpm versions from `package.json`. Install with `pnpm install`, then
`pnpm build`. Start with package checks, then relevant root checks:
`pnpm test`, `pnpm typecheck`, `pnpm lint`, `pnpm format-check`,
`pnpm knowledge:check --strict --format markdown`, and `pnpm audit:policy`.
`pnpm lint` runs Biome directly (`biome ci`, pinned to CI's exact version,
#2710) rather than through Turbo — no package defines its own `lint` or
`format-check` script (see [standards](docs/content/standards.md));
`pnpm format-check` is the same check under its documented name.
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
