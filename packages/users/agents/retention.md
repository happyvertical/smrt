# smrt-users/credential retention

Module semantics for `src/retention.ts` and the three `deleteExpired()` paths
it drives. Package orientation, the permission model, and the security rules
that apply before editing anything live in [../AGENTS.md](../AGENTS.md) — read
that first.

## Credential retention (#2375)

`SessionCollection.deleteExpired()`,
`UsersMagicLinkTokenCollection.deleteExpired()` and
`UsersCliAuthRequestCollection.deleteExpired()` all existed, and all waited for
an application to remember to call them. Expired credential rows are the worst
kind of unbounded growth: worthless the moment they expire, and exactly the
rows an attacker would like to still find in the table.

`src/retention.ts` contributes the three to the framework retention sweep in
`@happyvertical/smrt-core`, so `smrt db:prune` and a running jobs `TaskRunner`
reap them.

- **The entry point registers on import.** `src/index.ts` calls
  `registerUserRetentionTasks()`, so any process that loaded this package
  contributes the tasks — including `smrt db:prune`, which imports the package
  optionally for exactly that reason. Registering is not scheduling: nothing is
  deleted until something runs a sweep.
- **Task names** are `users-sessions`, `users-magic-link-tokens`,
  `users-cli-auth-requests`, `users-login-attempts`, `users-login-audit-events`
  — prefixed with the package's short name because the retention registry is
  one process-global namespace. Opt one out with
  `runRetentionSweep(db, { tasks: { 'users-sessions': false } })` or
  `smrt db:prune --skip users-sessions`; `unregisterUserRetentionTasks()`
  removes all of them.
- **The credential tasks have no retention window to configure.** An expired
  credential has nothing worth retaining, so each deletes only already-expired
  rows. An application that keeps expired sessions for audit should opt the
  task out and archive them itself. The two #3273 tasks differ: limiter rows
  are pruned once past their own `retain_until` — written by the limiter from
  its configured window and streak-forgiveness horizon, so a custom-configured
  limiter is never swept early — and never while a lockout is live; audit
  events are pruned after
  `DEFAULT_LOGIN_AUDIT_RETENTION_DAYS` (90). A host that needs longer audit
  retention opts `users-login-audit-events` out and archives.
- **All three are a single counted DELETE**, not a hydrate-and-delete loop.
  They now run unattended on a timer, and a per-row delete that throws part-way
  leaves the rest of the expired rows un-reaped — the #1400 reasoning that
  already applied to sessions, now applied to the other two. Counting first
  also gives a usable figure where `rowCount` is not populated, and is what
  makes `{ dryRun }` preview the same predicate rather than an estimate. The
  count and the delete are not one transaction, so the figure is approximate
  under concurrent writers.
- **`expiresAt` is `@field({ indexed: true })`** on `Session`,
  `UsersMagicLinkToken` and `UsersCliAuthRequest`: the prune predicate scans
  that column on every pass.
- **CLI bearer handoff is single-use.** An approved request becomes `consumed`
  and clears its `sessionId` when one poller wins the exchange. The CLI
  retention task deletes pending requests past their TTL, requests already
  marked `expired` by lazy expiry, and consumed history; it retains approved
  requests until exchange so a near-expiry approval cannot orphan its bearer
  session.

## OAuth credential retention

`users-oauth-credentials` prunes expired authorization codes and access-token
revocations. Refresh grants (including consumed or revoked hashes) remain until
30 days after their own expiry, so replay within their validity period and this
grace period still revokes the family. Later replay fails as an unknown token.
This bounds retained rotation history even for continuously active families.
The sweep locks each candidate family using the same row as token rotation,
rechecks its descendants, and deletes the family only when none remain. Live
grants and revocations are never swept. Each family is a separate transaction;
rolled-back contention retries follow the OAuth transaction policy. If the SQL
adapter invalidates a connection (for example SQLite SQLITE_BUSY), the sweep
reports failure; the host must acquire a fresh connection before retrying. It
never continues on an invalidated connection. Dry runs write nothing and
report approximate counts under concurrent writes. Clients and consent records
remain for application-managed lifecycle/audit. Opt-out and unregister work as
for the other retention tasks. No raw bearer or credential hash is logged.
