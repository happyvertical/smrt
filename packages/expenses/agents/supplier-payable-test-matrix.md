## Expense supplier payable authority (#4096)

Public methods on a persisted positive Expense, delegated by the Expense collection:
- recordSupplierPayable(input): immutable original source snapshot, explicit currency, payableBasisMinor:number|null, original dated held/released/settled evidence, source namespace/key/version and original author/evidence; current recorder separately supplied. Stable request replay.
- recordSupplierPayableEvent(input): append current evidenced hold/release/settlement, or explicit refund reconciliation with payableReductionMinor, retainedReductionMinor and cashReturnedMinor tied to one actual linked Expense refund. No provider/bank/journal execution.
- completeSupplierPayableBasis(input): one explicit reviewed completion of an originally unknown basis, preserving original snapshot.
- getSupplierPayablePosition({asOfDate?}): typed original/event lineage, stable event UUIDs, exact held/released/net-paid/available payable amounts; basis/position unknown when basis or linked refund interpretation is unknown.

Dates and same-day sequence are supplied explicitly. Original author is source text, never an invented current profile. Current recorder is independently attributed. Each event retains source namespace/key/version or current evidence and request identity. No current approval is synthesized. All money is safe integer minor units in Expense currency. Original basis cannot exceed gross; actual tax/recovery/company-cost remains unchanged.

Conservation: retained = held - released - explicitly retained refund reductions; net obligation = payable basis - explicit payable refund reductions; net paid = settlements - explicit supplier cash returns; available payable = obligation - net paid - retained. Every dated prefix must be nonnegative when known. Cash returns cannot exceed actual earlier settlements; retained reductions cannot exceed original retained capacity. Linked refund amount bounds both the explicit economic and cash directions independently; no inference that they are equal. New/unreconciled linked refunds make payable position unknown and prohibit new settlement/release; recorded held counters remain visible while retained availability is unknown. Current settlement requires known basis and all refund dispositions. Original settlement facts may retain an unknown basis subject to gross upper bounds. Employee reimbursement is independent.

One guarded JSON authority on Expense owns these calculations; child event UUIDs are immutable concrete command evidence. Direct field writes, deletion, source money/payer/currency mutation and mapped-refund mutation/deletion are refused. Existing shared Expense source row locks/CAS serialize refunds with payable commands. Unknown refunds may be recorded but cannot authorize additional payment. Caller executor and outer rollback are preserved.

| Behavior | Trigger / positive | Failure | Context / executor | Runtime / edge | Proof |
|---|---|---|---|---|---|
| Original authority | record holds/releases with null basis and original author | changed retry, malformed/unknown event, currency mismatch | owner tenant/current recorder, caller transaction | Node26 SQLite+PG; original source DTO | focused shared native suite |
| Dated conservation | hold/release/settlement exact amounts, supplied ordering | overrelease/overpayment, ambiguous chronology, unsafe values | same source lock/CAS | SQLite+PG; no external I/O | prefix + native race tests |
| Refund directions | explicit economic/retained/cash disposition against actual linked refund | absent disposition -> unknown; excess/changed refund refused | source+refund locks | SQLite+PG public Expense refund authority | native conservation and mutation tests |
| Immutable authority | exact replay and stable event IDs | direct save/delete/source rewrite | tenant/context allow+deny | generated CRUD remains closed | native guards |
| Atomicity | caller transaction success/retry | outer rollback, competing final capacity | supplied executor | SQLite+managed PG | focused rollback/concurrency |
| Compatibility | no payable authority retains existing Expense behavior | no inferred cost/tax/reimbursement changes | existing public reads | supported current package | focused relevant existing Expense tests |

Risk: high, shared financial capacity and concurrent mutation. No live provider calls or sandbox certification. Root coordinates one integration/release candidate and combined review.
