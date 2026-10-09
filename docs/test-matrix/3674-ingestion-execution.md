# Ingestion review and execution — #3674

Risk: high (approval authority, tenant isolation, durable concurrent effects).
Base: `9a4df43b9663b888fb886284d7cc1fd1dbae920b`. Contract: ADR 0004.
This is the design matrix; executed evidence is recorded separately with exact HEAD.

U = `pnpm --filter @happyvertical/smrt-ingestion test`;
P = `pnpm --filter @happyvertical/smrt-ingestion test:postgres`.
Every database row runs on real SQLite and PostgreSQL, using the owning ledger
transaction and transaction-bound domain collections. Actors include owner,
review-only delegate, revoked user, other tenant and other confidential scope.
No generated mutation surface is exposed; service authority remains mandatory.

| Behavior/invariant | Reachable trigger | Positive case | Negative/failure case | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level/command |
|---|---|---|---|---|---|---|---|---|
| Policy only narrows | Resolve app/tenant/source/request layers | Intersections/minima/review OR | Deny wins; missing version identity; absent opt-ins | Trusted host configuration | Pure N/A (no persistence) | Node | Unknown/malformed policy | Unit U |
| Immutable review binding | Preview and approve | Exact evidence/attempt/handler/args/target bound | Changed arguments, stale revision, version drift | Authorized reviewer/item scope | Item lock + proposal/decision tx | SQLite/Postgres | Capability registry/handler schema | U/P |
| First decision wins | Concurrent approve/reject | One immutable decision and replay | Conflicting reviewer/request replay content | Two authenticated sessions | DB CAS under item lock | SQLite/Postgres | Session identity never input | U/P |
| Correction/rejection/defer | Review transitions | Edit appends proposal; reject/defer persist | Old approval cannot apply | Reviewer current permissions | Single owning transaction | SQLite/Postgres | Handler preview | U/P |
| Fresh execution authority | Apply/resume after approval | Fresh PrincipalRun bounded captured grants | Revocation, cross-tenant/scope, expired evidence | Source principal plus authenticated requester | Live authorization at mutation boundary | SQLite/Postgres | Public executeAsPrincipal | U/P |
| Exactly one database effect | Concurrent repeated apply | One draft ContentDocument and stable result | Mid-transaction failure rolls back domain+success | Current authorized principal | Same SQL executor for ledger/domain | SQLite/Postgres | Real Contents.create | U/P |
| Durable replay | Cleanup job/runOnce; retry successful action | Original result/tombstone, no new effect | Reprocessing cannot republish completed action | Authorized current reader | Durable action ledger | SQLite/Postgres | Job retention independent | U/P |
| Target freshness | Apply approved attachment | Actual retained asset joins authorized target | Changed target revision/model/owner or asset hash | Current principal/confidential scope | Target check+domain join+ledger tx | SQLite/Postgres | Content.addAsset | U/P |
| External unknown outcome | Crash/throw after submit | Reconcile same stable key/result | No blind repeat; unknown remains blocked | Fresh current grants | Reservation before external I/O; completion fenced | SQLite/Postgres | submit/reconcile unavailable/malformed | U/P |
| Cancellation and expiry | Cancel during issued effect | Pending work blocked, success retained | Never claims to retract issued effect | Current scope | Item/action fencing | SQLite/Postgres | In-flight external effect | U/P |
| Review continuation | Suspend then restart/answer | Existing jobs continuation releases worker | Forged answer cannot approve; wrong actor/session denied | Bound owner/tenant plus live authorizer | Public jobs store/runner | SQLite/Postgres | MCP continuation request/answer | U/P |
| Frozen plan expansion | Resolve pinned playbook | Operation order and stable step action mapping | Intent/nested/changed definitions/unknown capabilities | Host narrowed playbook policy | Atomic plan+proposal publication | SQLite/Postgres | Public resolvePlaybook | U/P |
| Symbolic result binding | Create draft then attach | Exact predecessor revision/result model/ownership | Cycles/cross-item/changed result/missing prerequisite | Per-step fresh principal | Per-action transactions | SQLite/Postgres | Typed record-ID substitution | U/P |
| Partial plan outcomes | Later step fails | Earlier success retained; retry only failed step | Dependent step blocked; abort/continue respected | Revocation between steps | Independent durable action tx | SQLite/Postgres | Real draft+attachment | U/P |
| Public/browser boundary | Build package | DTO/model root browser-safe; server execution only | No agents/provider code in root graph | N/A (build boundary) | N/A (no persistence) | Node/browser bundle | Package exports | build/typecheck |

Full ingestion suites/build/typecheck and relevant root lint/format/knowledge,
package DAG/instruction/audit gates apply. Artifact writers run serially.
Content/agents/playbooks/jobs owner suites apply only if owning source changes;
reference handlers use public APIs and do not modify those packages. UI, provider
extraction and evaluation are later children: no claims or empty passing lanes.

## Executable coverage map

The shared `src/test-support/execution.ts` suite is invoked by both
`execution.test.ts` (SQLite) and `execution.postgres.test.ts` (PostgreSQL).
Evidence is captured under the coordinator's issue 3674 evidence manifest, with
command, exact committed tree, exit status and SHA-256 for each complete log.

| Matrix rows | Executable evidence |
|---|---|
| Policy only narrows | `policy.test.ts`: intersections/minima/review OR, disabled layers, absent automation opt-ins, missing identity and invalid budgets/confidence |
| Immutable review binding; first decision wins | `rejects forged/stale decisions`; `binds exact arguments`; `rejects changed stored arguments`; simultaneous owner/reviewer decisions |
| Correction/rejection/defer | `corrects into a new review revision`; `fails closed for unknown handlers`; rejected/deferred actions create no Content rows |
| Fresh authority | `reauthorizes against current grants`; `requires evaluated layered opt-in`; `rejects changed stored arguments and grants beyond the captured ceiling` |
| Exactly one database effect | `commits one real draft under concurrent repeated apply`; `rolls domain writes back`; `atomically consumes the final database attempt` |
| Durable replay | `keeps completed action identity beyond retention and job cleanup`; `rechecks successful result visibility` |
| Target freshness | `rejects changed symbolic predecessor target`; `rechecks successful result visibility`; reference target lock uses the same executor as Content mutation |
| External unknown outcome | `records unknown external outcomes`; `requires conclusive reconciliation`; `recovers process death after external acceptance` (actual SIGKILL, durable provider receipt, no resend) |
| Cancellation/expiry | `blocks cancelled pending execution and records an already issued external success`; exact approval expiry and retained action tombstone cases |
| Review continuation | Both `restarts durable review` cases use actual McpTaskStore/TaskRunner stop/start; wrong owner denied and forged answer creates no decision/effect |
| Frozen expansion | `re-expands plans into fresh reviews`; `rejects forward/cyclic plan bindings and changed playbook definitions` (also changed plan preview) |
| Symbolic result binding | Real draft/attachment plan; changed predecessor revision/visibility and cross-item dependency denials; malformed forward dependency rolls back the whole expansion |
| Partial plan outcomes | `executes a real dependent draft and attachment plan`; both pinned `abort`/`continue` cases; earlier success remains one domain row |
| Public/browser boundary | Package build's `scripts/check-browser.mjs` bundles root/DTO and compiles a fresh DTO consumer with DOM libraries and no Node types; isolated built `/server` and `/execution` import checks distinguish runtime principal registration from fixture-only Content |

The final-attempt regression was demonstrated failing on the initial execution
implementation (two failed effects entered with a budget of one) before the
savepoint correction. The corrected code rolls back only the domain savepoint,
retaining the item lock and atomically recording the consumed attempt. This
feature has no prior execution implementation on base `9a4df43b`; the remaining
new behaviors therefore use direct invariant tests rather than a nonexistent
base service.

The package-wide test fixtures deliberately migrate ContentContributionAttachment
and ProfileAsset alongside their other domain/asset models (smrtVitestPlugin
loads declared dev-dependency manifests into the test registry), because asset deletion
checks registered noun-owned joins. Fresh-process imports prove Content and
ContentContributionAttachment remain absent from production `/execution`; the
public principal stack does register ProfileAsset. Execution deployments migrate
that dependency graph; receipt-only `/server` does not load it. No schema or
runtime owner-package code was modified.

PostgreSQL fixture cleanup keeps the runtime role non-superuser, closes owned
connections and retries only SQLSTATE 55006 until a bounded deadline. Permission
and unknown errors propagate immediately. `postgres-cleanup.test.ts` checks that
boundary; the PostgreSQL execution suite also holds real connections past the
deadline and proves the database remains intact until ordinary cleanup succeeds.
