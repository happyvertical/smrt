# #4491 behavior-to-test matrix

Risk: high — invitation identity, tenancy and proof consumption authority.

| Behavior/invariant | Reachable trigger | Positive | Negative/failure | Actor/context | Executor/transaction | Runtime/dialect | Contract edge | Level | Command |
|---|---|---|---|---|---|---|---|---|---|
| Exact role selector | prepare roleId | destination role | foreign/missing role, both/neither selector | trusted host exact destination | caller tx | Node SQLite/PostgreSQL | legacy roleSlug default unchanged | integration | users focused tests |
| Preserve owned identity | opt-in prepare/issue/accept/mailbox | active canonical existing family Person | wrong email/type/owner/source membership; suspended; pending non-global | exact invitee independent identity | caller tx | Node SQLite/PostgreSQL | default global; new pending global unchanged | integration | users focused tests |
| Bounded host identity read | requireOwnedPersonForTenant | exact current user + active destination | different actor/context, inactive destination, missing identity | signed active tenant actor | supplied collection executor | Node SQLite/PostgreSQL | no profile/credential rebinding | integration | users focused tests |
| Atomic acceptance | consume proofs then host writes | exact membership + edge commit | host throw rolls back proof claims, activation, edge | independent mailbox invitee | caller tx | Node SQLite/PostgreSQL | independent transport callback, no real mail | integration | users focused tests |
| OIDC unchanged | authorizeOidcOwner on opted-in service | canonical global path | existing tenant Person refused | verified strict protocol claims | same caller tx | Node SQLite/PostgreSQL | no new OIDC reconciliation policy | integration | users focused tests |
| Revoke/resend generations | issue/revoke/reprepare | new grant after cancellation accepts | all old grants/mailbox proofs remain invalid; active never disabled; malformed state refuses | trusted exact destination | caller tx; PG row locks | Node SQLite/PostgreSQL | canonical membership metadata, no schema change | integration | users focused tests |
| Binding/status/retry | issue/reissue/complete | retry pending same role; preserve active role | changed profile/role, revoke, replay, concurrent completion | exact destination + invitee | separate caller txs | Node SQLite/PostgreSQL (concurrency PG) | single-use proofs | integration | users focused tests |

Commands: `pnpm --filter @happyvertical/smrt-users test -- src/__tests__/tenant-invitation.test.ts src/__tests__/mailbox-authentication.test.ts src/__tests__/family-invitation.test.ts`; PostgreSQL same focused files with `TEST_DB_ADAPTER=postgres DATABASE_URL=<isolated integration database>`; package typecheck/build. PostgreSQL infrastructure is integration-owned; workers do not start containers. Evidence is retained outside checkout in `/Users/will/Work/tmp/hearth-family-management-20261029`.

## Retained mailbox request reservation follow-up

High risk: embedded root handles may share the caller transaction, so implicit reservation inside a transaction can roll back the send budget. New capability is minted/settled outside the transaction.

| Behavior/invariant | Trigger | Allow | Deny/failure | Actor/context | Executor/transaction | Runtime/dialect | Contract edge | Level | Command |
|---|---|---|---|---|---|---|---|---|---|
| Retained budget | reserve then failed delivery | counts 1..5 remain after rollback | sixth request denied; no sends | server exact source/destination | limiter root before caller tx | Node SQLite/PostgreSQL | no refund API | integration | users focused mailbox tests |
| Opaque one-use scope | request with capability | normalized destination/source, same limiter | forged/copied/serialized/reused/concurrent; wrong purpose/source/email/tenant/limiter consumes capability | trusted host only | synchronous WeakMap delete before first await | Node SQLite/PostgreSQL | no browser representation | integration | users focused mailbox tests |
| Deadline | old key window or delayed identity | earliest actual reserved deadline <=30s | expiry before generate/delivery, including after awaits | trusted host | fixed original reserved key windows | Node SQLite/PostgreSQL | no fresh-window timestamp approximation | integration | limiter + mailbox tests |
| Embedded fail closed | no capability | PostgreSQL implicit unchanged | embedded no writes/mail before refusal | server | caller tx | SQLite/DuckDB; PostgreSQL compatibility | malformed/unknown returning consumes uniform source budget | integration | users focused mailbox tests |
