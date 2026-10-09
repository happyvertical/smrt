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

New feature, so a base-regression comparison is N/A. Comment insertion is one
save on the provided executor, with validation/authorization before mutation.
Notification delivery intentionally occurs after save and is not atomic with it;
the failure test asserts the saved-row contract. No comment retry/idempotency
contract is promised: clients must not blindly retry create after delivery error.
Recipe surfaces are deferred until #3708 lands.

Recipe metadata follow-up (#3604): the comments catalog group, embedded-only
navigation and help are checked in the generated manifest and knowledge artifact
after building with refreshed scanner/core artifacts. Model exposure stays off.
This change does not affect persistence or delivery; prior three-dialect evidence
remains applicable. Full package tests, typecheck, Svelte and Biome are rerun.
