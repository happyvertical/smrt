# Retained provider review and original due dates (#4076)

The host needs the exact frozen invoice lines and tax components to review provider
mapping before any write. The generic accounting snapshot deliberately refuses
unreleased retention. Add a read-only entry point on the owning retention
coordinator; do not relax generic accounting export or expose its internal bypass.
Host-managed due dates must preserve explicitly selected original terms even when
a retention release occurs after the due date. No new date is inferred.

| Behavior/invariant | Reachable trigger / positive | Negative/failure | Actor/context | Executor/runtime | External edge | Level / validation |
| --- | --- | --- | --- | --- | --- | --- |
| Retained frozen review | Public retained snapshot read returns exact original money/lines before posting | Generic export still refuses; missing/wrong tenant and non-retained invoices refuse | Host-authorized actor, active tenant | Caller-affine money transaction; SQLite/PostgreSQL | No provider calls or durable mutation | Shared native retention suite, focused Vitest SQLite and optional PostgreSQL |
| Explicit past-due release | Release effective date later than supplied original due date; exact retained due date and retry | Invalid date, amount/capacity and changed retry still refuse | Same active tenant/host actor | Public retained command, independently durable steps; SQLite/PostgreSQL | Mock public provider, exact SDK request/readback | Shared native retention suite; base regression retains failure log |

No production tenant migration or provider sandbox call is involved. This is part
of the current #4076 batch and shares its final review/CI requirements.

Validation: focused SQLite shared suite passes (6.75s) and native PostgreSQL
shared suite passes (8.75s), including pure mapping rejection before any provider
operation and exact past-due terms. Commerce build passes. The base regression
failed at the previous release-date guard (the concurrency harness then timed out);
the updated harness races startup against rejection so it cannot conceal this
failure. Full logs are retained under the coordinator evidence directory as
`smrt-retention-past-due-base.log`, `smrt-retention-review-focused-v2.log`,
`smrt-retention-review-postgres-v2.log`, and `smrt-retention-review-build-v2.log`.

Retained credit review extension: the shared native suite reads the exact issued
credit before its first provider push, maps the immutable original invoice reference,
rejects wrong source IDs, foreign tenant/realm and generic export, and proves no
provider mutation during review. The initial test used the model enum `credit_note`
instead of the public frozen DTO enum `creditMemo`; that test-only mismatch is
preserved in the first failed log. Focused SQLite now passes. PostgreSQL/build
evidence is recorded with this checkpoint before delivery.

Credit review validation: SQLite 6.68s and managed isolated PostgreSQL 10.99s
passed; commerce build passed with no TypeScript diagnostics. Logs:
`smrt-retained-credit-review-focused-v2.log`,
`smrt-retained-credit-review-postgres-v2.log`, and
`smrt-retained-credit-review-build.log`. An initial runner call lacked an explicit
managed database URL; it failed before connecting. The corrected run used the
managed wrapper and cleaned its owned disposable database.


Native application integration additionally exposed omitted effective-date retention
in ordinary configure/release commands. Explicit calendar dates now survive saved
state and belong to exact retry identity. Shared SQLite/PostgreSQL retention proof
checks configure/release reload, changed-date refusal and outer rollback. Omitted
dates remain unknown; no recorded timestamp is substituted. The initial application
failure and cancelled combined-gate run remain in the MVP evidence ledger.
