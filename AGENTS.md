> Fork or clone contributors without the control-plane skills: follow [`smrt-contribute`](.agents/skills/smrt-contribute/SKILL.md), not the maintainer lifecycle below.

<!-- hv-managed-policy:start revision=1.0.0 sha256=718b878b829a6b2c67fd874b30e86e383dd759c4f034d9558b45592c0bda137b -->

## Shared development kernel

- Be concise. Load detailed SOP skills only when the task triggers them.
- Read the repository's `.agents/project.yaml` and nearest `AGENTS.md` files before work.
- Use `implement` by default for accepted issue implementation.
- Tracked implementation work is complete when documented validation is green, `review-cycle` has passed, and the work is handed off with a ready-for-review pull request; do this unprompted. Before editing untracked requested work, create and claim its issue, or — patch-class only — record it on this session's open patch train; a user-scoped throwaway spike is exempt and ends at its report, outside the commit, push, and PR lifecycle.
- Claim an issue before editing it: add `agent: implementation` and post one claim comment naming your runtime, session, and branch. Do not take an issue another session holds with activity in the last 24 hours without a handoff. Assign work to another agent with a `dispatch: <runtime>` label and an instruction comment; the receiver claims it.
- Patch-class work — small bug, doc, and improvement changes with no schema, contract, dependency, or breaking change — may bundle as one patch train on one branch and pull request with one commit per item. An interactive plan of several items for one repository and release line ships the same way as a session train, feature-class included, declared by `foreman`; unattended dispatch-label runs stay one issue per pull request. An incidental patch-class fix of ten lines or fewer near files under edit ships in the same pull request as its own commit, listed under `Drive-by fixes` in the PR description; other findings go to the tracker.
- Hand off intentionally: when done, blocked, or stopping, update your claim comment with the outcome and next step and remove `agent: implementation`. Never delete claim history. Incomplete work gets a ready pull request with `status: blocked` and a concrete handoff. Review agents do not claim implementation.
- Never open a draft pull request. A `fastest`-tier watcher or the app's PR monitor, never the parent session's turns, watches a ready PR until it is mergeable — no base conflicts, no unresolved review threads, the repository's required checks green, its required approvals satisfied — or report a concrete blocker. Where the app provides a PR monitor, turn it on for the pull request as soon as it opens, without asking; that never includes auto-merge.
- Run full documented validation as `hv-heavy -- CMD` when it is on PATH; heavy runs queue machine-wide. A wait that times out (exit 75) or is interrupted is a blocker, never a reason to run unwrapped.
- Agents do not merge unless explicitly authorized in the current session, and then only when the repository's own required checks and approvals pass.
- Run documented validation and update affected docs before shipping. Delegated workers run narrow tests for what they touched, add tests for new behaviour, and self-review; full validation and one `review-cycle` run once on the integrated branch, earlier only for a named high-risk trigger.
- A session that has handed a task to a subagent or started session does no hands-on work on that task (no code reading, checks or review) until that report returns. It reads session reports and pull request and issue state, decides, and briefs; any review, audit, investigation, cleanup or code reading goes to a subagent or session at the matching tier, and only the conclusion returns. "It's only a few tool calls" is not an exception. Briefs cap the report at a short conclusion; a longer report goes back for a summary, unread. A top-tier session is a planning thread: it hands work to a `balanced` foreman before tasks start. Non-implementation work is done at its written conclusion; orchestration is done when every spawned task has reported and the owner has the summary.
- Every subagent or start-session spawn names its model and effort (`thinking`) from the effective model-target map (`$HV_CONFIG_DIR/generated/model-targets.yaml`) by tier — `fastest` watchers and bookkeeping, `balanced` implementation and orchestration, `advanced` genuine reasoning, `smartest` design review — never inherited. Started sessions use `context: fresh` with `model` set; `fork` only when the task needs the conversation (it always inherits).
- Review on `balanced`; `advanced` only for a named high-risk trigger. Review mechanics (risk default, accepted-blocker rule, token cap) live in the `review-cycle` skill; wait outside the implementer.
- When the owner says proceed and leaves, do not re-ask decisions this kernel already covers; anything reserved for the owner (merge, deploy, secrets, DNS) is marked `status: blocked` with a handoff, never a chat question, unless the owner has not yet been asked to authorize it in this session.
- Train workers never start containers or compose projects; they test in-process (`@happyvertical/sql` SQLite, DuckDB, PGlite, or the repo's documented backend). Only integration runs the service stack, as one compose project named after the branch; `services:down` is part of handoff and ship.
- Preserve unrelated work. Never expose or retain secrets.
- Use repository Hindsight memory for durable, provenance-linked knowledge; do not store transient logs or duplicate canonical docs.
- Shared SOPs and portable skills come from the designated control-plane repository. Repositories choose their own technology and may add stricter local rules.

<!-- hv-managed-policy:end -->

# SMRT Framework

## Fix it here; do not work around it, do not file it away

Broken pin, hook, gate, stale generated file, or conflicting package rule: **fix
it in the current branch** as its own `Drive-by fixes` commit. No workarounds
(shims, `--no-verify`, disabled gates, substitute toolchains); a validation
command that cannot run as documented is the bug. Drive-bys within the kernel's
ten-line envelope are mandatory; beyond it, an issue must name why the work cannot
ship here. Full rules: [agents/fix-it-here.md](agents/fix-it-here.md).

pnpm/TypeScript monorepo: `@smrt()` objects generate persistence, REST, CLI, MCP,
and AI operations. Read the package's `AGENTS.md`; see [CONTEXT-MAP.md](CONTEXT-MAP.md).

## Validation

`pnpm install`, `pnpm build`; package checks first, then root: `pnpm test`,
`pnpm typecheck`, `pnpm lint`, `pnpm format-check`,
`pnpm knowledge:check --strict --format markdown`, `pnpm audit:policy`,
`pnpm check:new-surface`, `pnpm check:node-roots`, and CI's standards checks
(`pnpm check:standards`, `check:no-smrt-peers`, `check:package-dag`,
`check:agents-chain`). Details, versions, gotchas: [agents/validation.md](agents/validation.md).
[TESTING_STANDARD.md](TESTING_STANDARD.md) defines package release gates.

## Cross-package invariants

- Numeric defaults define schema: `= 0` is integer, `= 0.0` decimal. Money is
  integer minor units; rates/confidence are decimals. PostgreSQL/DuckDB integers
  materialize as BIGINT, but hydrated values must remain JavaScript-safe integers.
- Extend serialization via `transformJSON()`, never `toJSON()`.
- Use `@foreignKey(Target)` within a package and qualified `@crossPackageRef`
  across packages. STI discriminators are `@scope/pkg:Class` (apps scoped).
- Native UUID ids/FKs on PostgreSQL/DuckDB, text on SQLite; repair values or casts
  at the owning boundary, never weaken UUID columns to text.
- Relationship loads preserve tenant isolation; cross-tenant reads need an
  explicit reviewed `allowCrossTenant` path.
- Junctions: `SmrtJunction`/`SmrtJunctionBase`; `parentId` trees:
  `SmrtHierarchical`; polymorphic links: `SmrtPolymorphicAssociation`. System
  tables: `_smrt_`. Asset ownership uses noun-specific joins; generic associations
  are provenance.
- Use public registry/database/collection APIs; add an owning-package API, not
  private-state access. JSON fields use guarded string get/set helpers.
- Runtime checks table existence and the migrate fingerprint, never creates
  application schema. Use migrations and `smrt doctor --db` / `db:status --parity`.
  Existing int4 deployments need the maintenance-window `db:migrate-int8` flow;
  parity treats int4/int8 as equivalent (CLI guidance).
- Release automation generates changesets; never author them. Dependency
  overrides target the advisory range; ignored GHSAs also need an
  `audit-policy.json` record (`pnpm audit:policy`).

## Documentation and skills

`AGENTS.md` is canonical; `CLAUDE.md` stays exactly `@AGENTS.md`. Keep to
locations, invariants, validation, and links; move detailed contracts into
linked `agents/<module>.md`. No nested AGENTS (ancestry is additive);
`pnpm check:agents-chain` enforces the 32 KB cap.

[WORKFLOW.md](WORKFLOW.md) routes to the lifecycle skills (`implement`, `claim-issue`,
`review-cycle`, `ship`, `resolve`); Work/buzz variants need an explicit Work tracker.

Capabilities belong in the owning package or SDK, never a downstream helper. Knowledge commands, artifacts, and freshness:
[agents/knowledge-artifacts.md](agents/knowledge-artifacts.md).
