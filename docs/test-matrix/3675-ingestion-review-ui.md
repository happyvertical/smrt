# #3675 ingestion review UI behavior contract

Status: implementation complete. Current executable evidence includes SQLite/server 240, PostgreSQL 200, components 25, providers 21, Chromium 5, bundle gate 26, root build 73, root types 143 and CI scripts 181 passing cases/tasks. Final exact-head handoff records the normal packed consumer and all static checks before review. Actual merged proposal base `db1d4f26c3a35b3f04c983432b9689894be521b7` includes the accepted refinements. The final rebase preserves every UI runtime/test blob; only the package release version advances to 0.55.5, with normal metadata/build/pack refresh. The bounded reload fixture selects distinct generated suggestions. High risk: exact human approval provenance, authenticated confidential media, concurrent immutable review revisions.

## Validation lanes

All commands run from packages/ingestion unless prefixed root, under Node26.10.0/pnpm11.25.0; all artifact writers serial. U=`pnpm test` (complete SQLite/server suite), P=`pnpm test:postgres` (real ordinary-role PostgreSQL), C=`pnpm test:components` (real components), E=`pnpm test:e2e` (maintained authenticated Chromium host and real SQLite/domain/extraction), T=`pnpm typecheck` (TS and svelte-check), B=`pnpm build` plus normal pack/isolated TS+Svelte/browser consumer. Also complete `pnpm test:providers`; no live provider calls/accuracy claim. Root build/typecheck/test/lint/format-check/strict knowledge/audit:policy/check:agents-chain apply to final integrated tree; carried evidence requires explicit unchanged-source rationale.

| Behavior/invariant | Reachable trigger | Positive case | Negative/failure case | Actor/context | Data executor/transaction | Runtime/dialect and level | External edge |
|---|---|---|---|---|---|---|---|
| Authoritative waiting reload | Reload/new session | Same item/action/plan IDs and exact saved preview | Denied scope/handler/target and expiry disclose no payload | reviewer × own/foreign tenant/confidential scope | owning item transaction | U/P/E | public listReviews and authenticated host load |
| Inbox states/filter/assignment | Load/filter/assign | processing/unresolved/waiting/failed/deferred/partial/completed and durable assignment | stale assignment CAS; forged assignee/foreign item refused | reviewer/assignment manager | host-owned durable transaction | U/P/C/E | assignment callback has no grant semantics |
| Human review exact binding | Approve/reject/defer each action | explicit displayed args and exact immutable binding submitted | forged actor/hash/args and missing CSRF fail server boundary | authenticated human; unauthenticated/foreign denied | execution owning transaction | U/P/C/E | submitDecision; no client approval authority |
| Edit and corrected destination | Edit canonical args then save | correction returns new preview requiring separate approval | old approval/stale parallel-tab decision loses CAS | two authorized reviewers, revoked actor | execution owning transaction | U/P/C/E | correctedArgs and current candidate callbacks |
| Resume and durable result | Apply/reload/retry | actual ContentDocument and attachment shown once | unknown outcome never offered as safe resend; failed later step preserves predecessor | reviewer/executor separate grants | real domain API shares owning tx | U/P/E | applyAction/applyPlan and persisted result reference |
| Original access and context | Open evidence/view link | authorized PDF/image/audio/email retained context beside fields | no opaque-storage URL construction; foreign/revoked originals refused | reader × tenant/confidential scope | public readEvidence before/after bytes read | U/P/C/E | authenticated host URLs, safe media types/text rendering |
| Honest provider data | Render analysis output | supplied pages/times/alternatives/missing fields and provenance | absent confidence remains unknown; no fabricated links or success on failure | authorized reader | no UI persistence; server snapshot reader | C/E | optional/unknown/malformed/upstream failure states |
| Logical split correction | Edit observed page groups | new immutable provenance revision; original bytes/hash retained | unknown/duplicate/out-of-range page, stale/concurrent revision, denied actor/reviewer grant/policy, late reviewer revocation rollback, replay authority, empty review catalogue, retry conflict, forged extraction/interpretation correction before provider disclosure | authenticated reviewer with process authority | owning locked revision transaction | U/P/C/E | split callback is correction, never approval |
| Late authority and retention | Callbacks pause before publication | live authorized retained snapshot | revocation/deadline during callbacks denies/redacts, rollback preserves minimum | actor × active/revoked scope | owning lock; monotonic retention | U/P | no grant cache or stale payload publication |
| Keyboard/mobile/i18n | 390px and keyboard review | named controls/focus/messages; PDF/image/email/audio journeys | disabled pending controls; errors announced; no unsafe HTML | keyboard/mobile human | N/A presentation; real host persists actions | C/E | smrt-ui primitives and package message catalog |
| Browser/package boundary | Pack/import isolated consumer | types-first /svelte + root/dto browser safe | no Node/provider runtime in browser; missing optional callbacks explicit | consumer | N/A no data mutation | B/T | published exports and Svelte declaration consumer |
| Maintained browser CI | Ingestion/UI/workflow PR and merge queue | Existing browser job builds ingestion closure and runs authenticated suite | Preserve required job conditions; failure uploads evidence | CI runner, no provider credentials | N/A workflow orchestration; browser fixture owns SQLite | workflow/actionlint + root `pnpm test:ci-scripts` and E | existing test-suite.yml affected/full conditions |
| Feedback extension authority | Host mounts optional correctness affordance | explicit human correctness callback separate from decision/outcome | absent callback renders no feedback; unauthorized feedback not passed | authorized host reviewer | N/A no feedback implementation in this issue | C/E | typed extension seam only; #3676 owns persistence |

## Evidence rules

Each lane above names its exact command; U/P run each persistence row on both supported SQL dialects. E uses maintained Chromium, C uses real Svelte components. Auth cases cross actor × resource tenant/scope × active context. Retry cases include duplicate calls and durable reload. New feature has no bug-baseline regression claim; any inherited defect requires a failing base comparison and coordinator acceptance. Final evidence records exact HEAD, command, exit status, nonempty full log digest, case names and each row mapping; planned commands are never marked executed. Browser provider output is deterministic through actual extraction/generation boundaries; it does not measure remote recognition or generative quality.

Assignment ownership is host-defined and explicitly authenticated; UI has no private SQL access. Logical split retains immutable originals and records a new provenance revision. No feedback/rule persistence, model spending, moderation, browser execution authority, or runtime application DDL.

Assignment persistence is a host-owned SQLite reference application contract; PostgreSQL is not declared for that fixture table. The production owning review/split APIs execute U/P on both declared ingestion dialects. UI state/DOM scenarios execute C/E; they do not claim a browser database runtime.

## Final evidence boundary

The immutable handoff maps every row above to named cases and captured command logs,
with exit status and SHA256. Server, DTO and persistence test source is unchanged
from the database-tested checkpoint. Final packaging corrections only move the
independent root/DTO browser check before Svelte packaging (so artifact pruning is
last), and replace unsupported CSS tokens with emitted theme tokens. Fresh build,
components, owning types, Chromium, theme/static and packed-consumer checks cover
those corrections.

Unrelated monorepo runtime suites carry the proposal parent’s complete root test
proof, backed by its byte-equivalent ancestry and this issue’s complete own diff.
No core/runtime schema or other package implementation changes. The only added
runtime dependency is the existing smrt-ui workspace package; other importers and
resolved dependency versions are unchanged. Root build/types, full bundle gate,
CI-script tests and relevant global checks run freshly. This is an explicit carry,
not a claim that the whole monorepo runtime suite was rerun for UI work.

## Accepted round-one reload regressions

Both independent reviews identified historical target revision checks conflating
current read authorization with execution freshness. Four baseline cases fail on
SQLite and PostgreSQL: operation/parent-plan targets changed before/after success.
The corrected owner cases retain unrelated page entries, preserve durable results,
redact stale arguments, expose only authorized identity/CAS recovery metadata,
reject revoked targets/parents and preserve expiry tombstones. Reload-only plan
recovery uses the returned plan revision (never action revision) and fresh approval.
A real generated attachment case proves stale candidate snapshots remain rejected,
the maintained host omits obsolete generation output, and explicit fresh human
arguments re-preview the same action before actual domain application. Component
cases cover empty-args operation/plan editors and exact reload CAS/attempt binding.

Round-two evidence reruns the complete execution and proposal suites on both real
databases, components, owning TS/Svelte/build, maintained Chromium, packed consumer
and affected static/knowledge checks. Unchanged foundation/source/extraction/provider
suites and unrelated root runtime/types retain exact prior evidence; no schema,
dependency, export map or other-package runtime changes occur in this delta.

## Accepted round-two post-preview reload regression

Operation and real parent-plan baselines fail on both databases immediately after
fresh preview and before approval: saved target bindings become fresh while the
immutable generation candidate pin remains stale. The maintained host helper now
distinguishes only the owning typed stale-snapshot error, reacquires current saved
reviews, and withholds generation output. Tests cover two repeated pre-approval
reloads with fresh waiting arguments, fresh approval/application/subsequent reload,
healthy unprepared sibling suggestions, later-candidate denial despite an earlier
stale pin, provider/unknown failures and revocation between classification and
review reacquisition. No strict snapshot/preview freshness gate is relaxed.

Fresh complete execution/proposal PostgreSQL coverage precedes the final reference
helper refinement that preserves healthy unprepared suggestions after saved actions
complete. Final helper lifecycle cases run on both databases; the complete affected
SQLite suite runs after that refinement. Evidence records the PostgreSQL source
hashes and narrower final-helper scope separately. Owning TS/Svelte/build, maintained
browser, server-only error packed export/import and static gates cover the final
tree. Unchanged component presentation, provider adapters and unrelated root suites
carry prior exact committed evidence explicitly.

## Merged-base jobs terminal outcome interaction

Reconciliation onto main `5975461d` preserves all reviewed UI/runtime files. Jobs
now commits terminal state and its safe event atomically. The shared foundation
TaskRunner test on SQLite and PostgreSQL therefore waits for actual intake
completion AND a tenant-bound public terminal outcome whose public job row is
completed. Complete foundation suites cover receipt recovery, dispatch repair,
retention and migration parity against the rebuilt jobs dependency. Focused jobs
terminal/runner/tenant suites cover the changed owning behavior; fresh maintained
browser and packed consumers cover composition. Unchanged execution/proposal
coverage carries explicitly: those paths do not run TaskRunner or read terminal
events, and their source and public job context type are unchanged. The unrelated
smrt-svelte audit presentation is not imported by ingestion's smrt-ui components.

## Accepted round-four pagination boundaries

The prior page-only inbox classifier mislabelled 20 completed actions followed by
a waiting action as completed. Both-dialect fixtures reproduce that result and
the missing off-page target denial, then verify whole-item classification through
public per-page authorization. The 22-row fixture is anchored by a real completed
action/result and one real waiting attachment; test-only cloned rows isolate the
page boundary without repeating domain effects or increasing test timeouts.

The component baseline loses earlier plan steps on Load more and misses revocation
on a reloaded earlier page. Fixed coverage refreshes every displayed page, preserves
21 deduplicated actions/cross-page plans and exact refreshed mutation revisions,
clears all payload on first/later page denial, and fences late completions after
context changes. The public host/DTO contract is unchanged.
