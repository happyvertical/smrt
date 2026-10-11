# Shared cost and pricing release (#3791)

Risk: high because reviewed financial facts persist across tenant boundaries.
The host authorizes source facts, work dates and policy choices. The package
calculators do not select a jurisdiction or authorize a customer invoice.

| Behavior / invariant | Reachable trigger | Positive case | Negative / failure case | Actor / context | Executor / transaction | Runtime / dialect | External edge | Level | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Expense basis composes with billing | Host bills a purchase | Recoverable tax excluded; nonrecoverable tax retained; markup provenance preserved | Legacy unknown basis remains unknown; no inferred zero tax | Authorized host, same currency | Pure calculation; persistence covered by #3792 | Node; SQL N/A for composition | Expenses public model and commerce cost-billing export | Integration example | `pnpm --filter @happyvertical/smrt-expenses test` |
| Billing modes retain sign and principal ownership | Third party paid or supplier refunded | Fee-only has zero principal; refund reverses principal and fee; overhead/fixed contract produce zero incremental charge | Unknown mode rejected by #3793 | Authorized host policy | Pure calculation, no mutation | Node; SQL N/A | Public billing result | Integration example | `pnpm --filter @happyvertical/smrt-expenses test` |
| Tax rounding is explicit | Several fractional-cent taxable lines | Invoice scope rounds aggregate once; line scope preserves line rounding | Missing tax mapping rejected; no jurisdiction inferred | Host supplies approved tax categories | Pure calculation, no mutation | Node; SQL N/A | Public tax result | Integration example | `pnpm --filter @happyvertical/smrt-expenses test` |

Member matrices cover financial persistence, migrations, tenant isolation,
rollback, rate changes, private compensation and approval/correction retry.
Run the full touched-package suites, their maintained browser and PostgreSQL
lanes, public export checks, and documented root checks before review. Recorded
release evidence binds the combined committed head, rather than treating worker
results as validation of later integration changes.

These examples are synthetic contract proofs, not a complete client import or
an accountant-approved tax policy. Downstream adoption follows public package
publication; receivables, deposits, settlement and accounting writes remain
separate work under happyvertical/tradeschief.com#277.
