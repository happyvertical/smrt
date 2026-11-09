# Scoped outbox and attachment evidence (#4747)

High risk: tenant authority and confidential attachment disclosure. Host code
owns immutable document/recipient consent; this service accepts trusted byte
resolvers, never arbitrary URLs or file paths. All other outbox behavior stays
on the existing public lease/transition/provider contract.

| Invariant | Trigger | Positive | Negative/failure | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level/command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Selection precedes loading/limit/claim | dispatchDue(deliveryIds) | exact requested pending/expired row found despite older unrelated rows | empty/malformed IDs never widen; foreign ID cannot cross tenant; unrelated rows untouched | principal exact tenant, or explicitly trusted system | same supplied db and existing CAS lease | Node26, SQLite and PostgreSQL; DuckDB where package supports | optional additive selector; legacy omission preserved | notification-outbox.test.ts plus PostgreSQL lane |
| Dispatch authorization | explicit or omitted tenantIds | permitted principal dispatches own tenant | foreign scope or absent messages.send denied before query/lease; unscoped principal must choose tenants | validated MessagingPrincipal; per-row check before dispatch | existing public collection; no new schema | Node26/SQLite + PG | no-principal legacy trusted system preserved | regression base failure/head pass |
| Real attachment bytes | pre-handoff resolver | bytes reach capture and existing Email.send options | malformed/missing return or resolver failure reaches no provider | host resolver reauthorizes current approved artifact; tenant context | existing delivery/message, resolver before handedOffAt | Node26/SQLite + PG | SendEmailAttachment, no provider import | narrow byte/resolver/default-transport tests |
| Retry safety | rejected send/recovery | resolver reruns before each fresh handoff | unknown outcome uncertain; no byte resolver/send on accepted reconciliation | current dispatch principal and host policy per attempt | existing durable state machine and lease | Node26/SQLite + PG | provider rejection/lost response | focused retry/recovery tests plus existing suite |

| Required policy admission | protected enqueue/batch/default dispatch | recognized policy + immutable artifact/destination binding yields bytes | unknown/missing policy blocks before lease, zero provider calls; new protected clone cannot clear policy | trusted server policy map, live host resource authority | public delivery save + CAS transitions | Node26/SQLite + PostgreSQL | old dispatcher binaries excluded from protected rollout | three baseline failures; current tests plus migrated PG proof |

Full touched-package tests/type checks/root documented validation remain release
gates. No UI change: browser N/A (package has no maintained browser harness).
Two additive policy columns require normal migration; legacy rows retain empty
policy defaults. PostgreSQL proof exercises native UUID/JSONB protection and
blocked default dispatch. Current-head evidence receipts
are recorded outside the worktree by the coordinator.

## Canonical Message handoff guard (#4747)

Named high-risk trigger: confidential attachment disclosure through an alternate
public send/retry/provider path. Source baseline regressions run before edits.

| Invariant / trigger | Positive | Negative/failure | Actor/context | Executor / durable state | Runtime/dialect | Contract edge / command |
| --- | --- | --- | --- | --- | --- | --- |
| Durable association | protected canonical message reload/save retains delivery | direct send/retry, cleared correlation/metadata, spoofed id, clone retaining protection cannot escape | trusted outbox policy vs arbitrary public caller | persisted delivery.messageId + protected message marker + original loaded identity; same supplied db | Node26 SQLite; PG integration | public Message/Email APIs; notification-outbox guard suite |
| Exact capability | approved bytes reach default EmailSender once | omitted/changed bytes, recipient/body/cc/bcc/from/headers changes deny | private one-use scope only after trusted current policy | exact tenant/delivery/message/lease/attempt/body/destination/byte digests | Node26 SQLite + PG | no public mint or arbitrary method dispatch |
| Actual provider boundary | current sending lease/attempt permits one handoff | lease loss/expiry after validation, reentrant/concurrent second call, detached async context expiry deny | same exact instance/canonical identity | re-read current persisted delivery immediately at handoff; one-use flags | Node26 SQLite + PG | default sender + capture provider |
| Retry and uncertainty | definite rejection permits new policy validation on fresh attempt | unknown remains uncertain; direct retry cannot resend | current authority per outbox attempt | existing outbox reconciliation/state machine | Node26 SQLite + PG | existing protected/default transport suite |
| Compatibility | ordinary unprotected messages still send/retry | forged protected marker never grants authority | current ordinary account semantics | existing Message CAS | Node26 SQLite + PG | provider-neutral root, no SDK import |

Trust boundary: package guards cannot prevent arbitrary trusted server code from
calling a provider SDK outside the messaging package. The private helper is not a
package-root export and never accepts a client-selected authorization callback.

Natural-key protection checks both stored old identity and the resulting adopted
identity inside a caller-affine transaction; a row appearing during a save cannot
be adopted to erase protection. Public saves inside an active provider scope gain
no lifecycle authority: only private canonical send/retry code can authorize its
exact one-use lifecycle save. Unknown-outcome marker rewrites fail. The shared
suite exercises these paths under SQLite and is wired into the migrated PG lane.
