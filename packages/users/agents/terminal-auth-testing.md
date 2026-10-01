# Terminal approval storage and regression matrix — #3076

The failed-approval budget is shared storage, keyed by unique `user_id`.
Each UPSERT candidate uses a unique private slug, so concurrent first inserts do
not also collide on the inherited `(slug, context)` index. Existing rows require
no migration: their slug is not used for lookup or authorization. The guarded
UPSERT continues to reserve at most the configured count across service instances
and processes. Unknown database failures propagate; they are not authentication
successes or silently converted to a rate-limit response.

Risk: high (terminal authentication and shared rate-limit authority). No public
API, schema, session, tenant or approval contract changes.

| Behavior / trigger | Positive | Negative / failure | Actor / executor | Runtime / edge | Validation |
|---|---|---|---|---|---|
| First reservation candidates | Distinct private insert slugs, one user budget | Third reservation denied at limit2; old code deterministically repeats slug | Same user, real SQL observed without replacing executor | SQLite; independent PostgreSQL service connections | users `test`, `test:postgres` |
| Concurrent invalid approvals | Three attempts reach ordinary auth denial | Ten rejected, exactly seven typed rate limits; zero attacker sessions | One attacker/user+tenant, two instances, atomic UPSERT | SQLite and PostgreSQL18 | users `test`, `test:postgres` |
| Concurrent approval/exchange | Eight approvals share one session, one of eight exchanges succeeds | Seven exchanges expired, consumed row clears session ID | UUID user/tenant, owning services | PostgreSQL; SQLite existing lifecycle coverage | users `test`, `test:postgres` |
| Window/release | Successful attempts release their reservation | Old-window release cannot erase new-window failure; cleanup failure cannot reverse committed approval | Existing storage executor, no retry change | SQLite | users `test` |
| Fixture retry/reseed | Two complete fixture cycles use the same emails | No duplicate email from prior committed fixture rows | Test-owned UUIDs, explicit cleanup through public database interface | PostgreSQL; intentionally independent connections outside rollback | users `test:postgres` |

Before the repair, the candidate regression fails (one slug instead of two),
and the second PostgreSQL fixture cycle fails its fixed-email insert. Actual CI
also captured a PostgreSQL duplicate `(slug, context)` error during concurrent
first reservations. The fixture cleans only its own IDs in FK order, then rolls
back its isolated handle; it must not replace real connections with one shared
transaction, weaken count assertions, or disable retries.

Run documented users build, typecheck (including Svelte), test, test:postgres and
verify:pack gates. PostgreSQL runs use the canonical disposable-database wrapper.
Root knowledge checks follow all producers. No new dialect is introduced; the
terminal auth regression suite declares SQLite and PostgreSQL coverage.
