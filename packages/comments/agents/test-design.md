# Comments behavior evidence (#3714)

| Behavior / trigger | Positive / failure | Actor / executor | Runtime / edge | Level / command |
| --- | --- | --- | --- | --- |
| Create/read a comment | Persist and reload; deny missing record permission, forged author or tenant | Trusted session actor; same supplied DB handle under tenant context | Node, SQLite/DuckDB/PostgreSQL; polymorphic record authorization callback | Integration, `test` / `test:postgres` |
| Shared record identity in different tenants | Tenant A sees A; never B | Two tenant contexts, same actor and DB | All three SQL dialects; explicit tenant filter | Integration, `test` / `test:postgres` |
| Mention creation | Deduplicate and exclude author; malformed UUID rejected | Authorized author, recipient access callback | All three SQL dialects; missing adapter is supported | Integration, `test` / `test:postgres` |
| Mention delivery | Real UserNotificationService row; denied recipient gets none; replay deduplicates | Supplied notification service/DB | All three SQL dialects; upstream failure leaves saved comment | Integration, `test` / `test:postgres` |
| UI submission | Trim/post; empty body and rejected callback keep actionable feedback | Host authorized projections | Browser Svelte; async callback | Component, `test` |
| Actor/record switch during submission | Reset draft; stale success/error cannot mutate new draft | Changed composite contextKey | Browser Svelte; async completion | Component, `test` |
| Recipe/schema | Recipe includes Comment; generated schema used by real persistence | Registry/test migrator | All three SQL dialects | Integration, `test` / `test:postgres`; `build` |
| Participation gate | Authorized post persists its immutable snapshot and pre-moderation status | Trusted actor; host-injected authorizer | All three SQL dialects; deny/banned/rate-limited decision writes no row | Integration, `test` / `test:postgres` |
| Reply, edit and moderation | Same-record reply, immutable prior-body revision, moderator status transition/report queue | Author or authorized moderator; supplied DB | All three SQL dialects; cross-record reply and another author's edit denied | Integration, `test` / `test:postgres` |

New feature, so a base-regression comparison is N/A. Comment insertion is one
save on the provided executor, with validation/authorization before mutation.
Notification delivery intentionally occurs after save and is not atomic with it;
the failure test asserts the saved-row contract. Unkeyed creates have no retry contract. Explicit keyed creates now support
retry recovery; see [idempotent creation](idempotent-create.md).
The fixture-only playground does not replace the authenticated record surface.

Recipe metadata follow-up (#3604): the comments catalog group, embedded-only
navigation and help are checked in the generated manifest and knowledge artifact
after building with refreshed scanner/core artifacts. Model exposure stays off.
This change does not affect persistence or delivery; prior three-dialect evidence
remains applicable. Full package tests, typecheck, Svelte and Biome are rerun.

#3708 follow-up: the browser-only playground renders fixture projections and
accepts local posts without storage or notification access. Component tests
verify display, posting, instance isolation and reset on remount. Build assertions
verify runtime, playground and demo exports in manifest and knowledge artifacts.
Persistence and authorization are unchanged; existing three-dialect evidence
applies. Route/settings/shell/provider contracts are N/A because they cannot
provide the parent record authorization context.

## Accepted review6084422109 round 1 regressions

- Invalid UUID and 51 distinct mentions: authorized actor, each SQL dialect,
  failed create must leave zero rows for the record. Baseline failed on SQLite,
  DuckDB and PostgreSQL; public model setter now validates before the one insert.
- Actual SQLite CommentService notification rejection composed with the Svelte
  submit callback: saved row remains, draft remains, alert instructs refresh and
  checking the discussion before reposting. Baseline produced “Try again”.
- Commands: full comments `test`, `test:postgres`, `typecheck`, `check`, `build`,
  and Biome; evidence under `/private/tmp/smrt-track-b-evidence/3714-r1-*`.

## Accepted review6084422109 round 6 persistence-key injection

Actor may comment on record A only; another author owns a comment on record B
in the same tenant. Injecting B's slug/context, with and without its primary id,
must create a separate A row and preserve B's identity, author and body. Injected
database and constructor options must not reach persistence or alter defaults.
Real SQLite/DuckDB/PostgreSQL baselines fail these assertions; the service now
allowlists CreateCommentInput and generates identity with insert-only persistence.
Hydration options remain available only on the trusted model path. Full package,
three-dialect, type/Svelte, build and Biome evidence: `3714-round6-*` logs.

## #3836 generic participation enforcement

| Behavior/invariant | Reachable trigger; positive / negative | Actor/context; executor/transaction | Runtime/dialect; external edge | Test level / validation |
| --- | --- | --- | --- | --- |
| Policy selection | Tenant default and exact target override; closed/unknown policy denies | Trusted actor × own/other tenant × mismatched ambient tenant; supplied database | Node SQLite/DuckDB/PostgreSQL; missing policy defaults open | Integration `test`, `test:postgres` |
| Membership and snapshots | Member allowed with frozen evidence; absent/false/malformed entitlement and upstream rejection deny | Host trusted identity/entitlement, no subscription coupling | All three dialects; optional snapshot and unknown decision values | Integration `test`, `test:postgres` |
| Ban enforcement | Tenant/target ban denies; expired/other tenant/other target permits | Tenant-bound query independent of ambient context | All three dialects; malformed expiry fails closed | Integration `test`, `test:postgres` |
| Persisted quota | Concurrent requests never exceed fixed-window quota; actors/tenants isolated, next window permits | Reservation and mutation on same transaction; failure rolls both back | All three dialects; independent service instances sharing DB | Integration `test`, `test:postgres` |
| Retry identity | Keyed comment replay consumes no additional quota, changed payload denied | Comment runOnce transaction and nested participation transaction use same executor | All three dialects; retained comment retry binding | Integration `test`, `test:postgres` |
| UI moderation | Pending/reported rows and callback transitions | Authorized host projections; no browser authorization | Browser Svelte; callback errors and parent-specific reply callback | Component `test`, Svelte `check` |

The generic fixture is a worker co-op project task. New feature: base failure
comparison is N/A. Rate windows are fixed UTC epoch windows, per actor/action
and selected tenant-default or exact-target scope. Policy changes take effect
on subsequent evaluations; concurrent administrative changes are not retroactive.

Author edits serialize on a database row write lock and retain the prior body in
the same transaction. The failed-save regression proves both history and body
roll back; foreign-author edits, foreign-tenant moderation and cross-record replies
are rejected in all three dialects. Models in the recipe include every service
storage dependency. Built participation subpath is imported by a standalone Node
consumer to verify the runtime export, alongside package typechecking.

Author edits also reauthorize participation and spend the comment-action quota;
banned and rate-limited edits fail before changing the retained body/history.

Visible edits under pre-moderation return to pending; editing hidden comments
preserves hidden status. The three-dialect edit test proves both transitions.
