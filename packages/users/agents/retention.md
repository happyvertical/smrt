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
  `users-cli-auth-requests` — prefixed with the package's short name because
  the retention registry is one process-global namespace. Opt one out with
  `runRetentionSweep(db, { tasks: { 'users-sessions': false } })` or
  `smrt db:prune --skip users-sessions`; `unregisterUserRetentionTasks()`
  removes all three.
- **There is no retention window to configure.** An expired credential has
  nothing worth retaining, so each task deletes only already-expired rows. An
  application that keeps expired sessions for audit should opt the task out and
  archive them itself.
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
