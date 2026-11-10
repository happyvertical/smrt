# Safe scheduling and job deduplication

Polls `_smrt_agent_schedules` every 60s. Due selection and the transactional
claim both apply optional `agentTypes` and `tenantIds` scopes (`[]` admits none;
`undefined` preserves system-wide operation). `queue` defaults to `agents`.
Configure a dedicated task-worker queue and exact scopes for a host that must
only run its own scheduled operation.

Admission locks and re-reads the authoritative schedule row, rechecks enabled /
active / due occurrence / capacity, then inserts the job and advances `next_run`
in the same transaction. Competing runners cannot consume the same occurrence.
A failed enqueue or process crash before commit rolls everything back; the next
poll can retry the unchanged due slot. After commit the durable job belongs to
TaskRunner's existing lease/retry/terminal recovery contract. ScheduleRunner
never independently fails a TaskRunner-owned job. Pending jobs (including delayed
retries) and running jobs both occupy `maxConcurrent` slots. Reconciliation takes
the same schedule-row lock, so a stale count cannot erase a new admission.

`args._scheduledFor` is the admitted original `next_run` as a UTC ISO instant,
retained across task attempts and passed to the handler. `_scheduleId` remains
internal metadata; neither field grants authority. `method_args` may not supply
`_scheduledFor`, `_scheduleId`, or `_agentConfig`. The handler must resolve current
authority and implement domain idempotency. `stop()` prevents new admissions and
waits for the in-flight poll/transaction before resolving; stop the scheduler
before draining its TaskRunner.

`next_run` is recomputed from *now*, never from the previous slot: this is
**fire-once-forward**. One overdue occurrence is admitted, then the next future
zoned cron time is armed. There is no missed-run backfill. One admission per
occurrence differs from no overlapping executions: `maxConcurrent = 1` prevents
multiple pending/running jobs for that schedule; a job dedupe key can serialize
a broader caller-defined resource. Neither promise preempts an orphaned timed-out
handler (see the at-least-once contract above).

### Store deduplication (#2994)

`SmrtJobCollection.enqueueJob({ ..., dedupeKey })` reserves at most one
pending/running job per effective tenant and nonblank key (at most 512 chars).
Concurrent calls return the existing job unchanged, even if the later arguments
differ. Terminal completion/failure/cancellation permits the next enqueue.
Ordinary retry delays retain the reservation; manual retry of an older terminal
job refuses while a newer job reserves its key. This is in-flight suppression,
not permanent occurrence/request replay or an authorization boundary.

The registered `_smrt_job_dedupe_slots` model owns the database uniqueness and
row lock; the opaque hash partitions keys by tenant, including global NULL.
The nullable indexed `SmrtJob.dedupeKey` retains provenance. Migrate before using
upgraded workers (`smrt db:migrate`); no partial-index dependency on DuckDB.
Slots retain one pointer per distinct key, including after terminal-job retention
prunes the referenced row. Use stable resource keys rather than one-shot tokens.
Generated slot API/CLI/MCP access is disabled. Callers must use `enqueueJob` and
public retry/cancel APIs; direct model/SQL lifecycle writes bypass store guards.

`enqueueJob(data, { transaction: tx })` uses an existing caller-owned transaction
for every read/write and opens no nested transaction (DuckDB has no savepoints).
The caller must propagate failures and commit/roll back `tx`. Without that option
a keyed enqueue opens its own transaction. Returned models use the caller's
connection, never an ended internal transaction. Enqueue persists once; a second
save must never race a consumer's first claim.

## Exact occurrence integrity

A trusted host can opt into `ScheduleRunnerConfig.occurrenceSigner` using a
`DurableJobPayloadSigner`; omitted or `null` preserves legacy unsigned runners.
The host configuration is the only source of that signer, never schedule or job
arguments. `ScheduleRunner.capabilities.occurrenceIntegrity` lets hosts reject an
older runtime before enabling schedules that require this contract.

During the same atomic occurrence transaction, after the real job ID exists,
the runner signs and saves `args._scheduleAdmission` before commit. A signer,
verification, or protected-save failure rolls back both job and consumed slot.
There is no post-commit signing/save or visible unsigned protected job. Row
`method_args` cannot supply the reserved `_scheduleAdmission` name.

The exact envelope is `{ purpose: 'smrt.schedule-admission', version: 1, keyId,
jobId, tenantId, scheduleId, scheduledFor, queue, objectType, objectId, method,
args }`. The args snapshot uses the existing signer's canonical persisted JSON
representation and excludes **only** top-level `_scheduleAdmission`; static
consent, constructor config and all other arguments remain bound. Metadata is
exactly `{ version: 1, keyId, signature }`. The tenant is explicit (`null` for
global); occurrence time must be a canonical UTC ISO instant.

`getScheduleAdmissionPayload(job, keyId)` is a pure payload builder, not a signer
or public minting endpoint. `verifyScheduleAdmission(job, signer)` returns false
on missing/unknown/malformed metadata, unknown/retired keys, tampered arguments,
or a copied signature on a different job, period, schedule, tenant or execution
target. Handlers requiring protected admission must verify the authoritative job
row even if a legacy unsigned runner could enqueue it. Actual worker execution
alone does not prove scheduler admission.

Legitimate retries preserve the same job ID, args and signature; lifecycle fields
are excluded. For key rotation a trusted keyring can mint with its current
`keyId` while retaining older verification keys for existing jobs. Retiring an old
key denies those retries until an explicit host reconciliation policy resolves
it. Never put keys in arguments or logs. This signature proves admitted identity,
not current actor grants, policy, database uniqueness, handler exactly-once
execution, or safety against trusted code that holds a signing key. Hosts must
still recheck current authority and use normal claims/domain idempotency.

## Public retry capacity and lock order

`job.retry()` reads canonical persisted tenant, schedule association, key and
arguments. Caller-edited model fields cannot choose another schedule/key or
rewrite business arguments/signatures. It validates current tenant ownership
before taking write locks, then locks **schedule → dedupe slot → job** in one
transaction. Admission and reconciliation use the same physical schedule row and
pending/running count. A pending retry's own slot is excluded; other pending,
delayed-retry and running occurrences count toward `maxConcurrent`, including
values greater than 1. Full capacity denies without resetting attempts, changing
status or reassigning the key. A later retry can proceed once a slot is free.
Running/completed jobs cannot be retried. Missing/foreign/malformed persisted
canonical occurrence associations fail closed.

`_scheduleId` alone is compatibility metadata shared by independent producers,
not an AgentSchedule discriminator. Persisted `_scheduledFor` or
`_scheduleAdmission` marks a canonical agent occurrence and requires its
same-tenant schedule even if that schedule's target was later reconfigured.
A legacy job without those markers occupies agent capacity only when its stored
execution type/object ID/method matches the actual same-tenant AgentSchedule.
Other producer metadata neither requires an agent table nor changes an unrelated
schedule, including a coincident ID. Table availability is checked portably on
the caller executor before SQL, without catching a missing-table error inside
an already-aborted PostgreSQL transaction. Admission/reconciliation count marked
prior occurrences across target reconfiguration and matching legacy agent jobs,
not unrelated producers' same-named metadata. Retry rechecks the canonical stored
arguments, tenant, target and association after its locks before lifecycle writes.

The transition changes lifecycle fields only, then hydrates the authoritative
row/revision back into the model, including keyed retries. It preserves the exact
stored args and signature. `retry({ transaction: tx })` joins an existing caller
transaction without nesting (DuckDB has no savepoints); the caller must propagate
errors and roll back on failure. That caller must not acquire lower-order locks
before this API. Completion's job transaction commits before its separate schedule
callback, so it never holds a job lock while waiting for a schedule lock. Automatic
handler retry keeps its existing nonterminal slot; no new admission is made.
This remains a nonterminal-row concurrency guarantee, not preemption of an orphan
JavaScript handler or a substitute for handler authority/idempotency.

Keyed enqueue requires canonical lowercase hyphenated UUID tenant identities,
including ambient context. Valid alternate UUID spellings (uppercase, braces or
compact form) fail before any slot/job write; load the canonical tenant identity
first. This prevents native PostgreSQL/DuckDB UUID hydration from changing the
identity used to hash a slot. Opaque non-UUID tenant strings remain exact and case
sensitive; no global case folding or relaxed tenant guard is applied. Nonkeyed
legacy enqueue behavior is unchanged. The keyed API is unreleased: private
uppercase development fixtures are not an existing-public-data migration case.

## Durable required admission (#3346)

A schedule that must never be consumed by an unsigned or differently routed host
persists this public requirement in `AgentSchedule.methodArgs`:

```ts
const policy: ScheduleAdmissionPolicy = {
  version: 1,
  requireIntegrity: true,
  queue: 'protected-agents',
  keyId: 'current-host-key',
};
schedule.methodArgs = { ...consentedArguments, _scheduleAdmissionPolicy: policy };
```

`getScheduleAdmissionPolicy(args)` returns a validated copy, or `null` only when
absent. A present malformed/unknown policy blocks. `ScheduleRunner` requires a
trusted `occurrenceSigner` whose current `keyId` matches and the exact `queue`.
It checks before reconciliation/claim writes and again under the occurrence
lock. A blocked schedule keeps its due time, counts, errors and jobs unchanged;
`schedule:blocked` emits only `{ scheduleId, reason }` with a bounded reason code
(`INVALID_ADMISSION_POLICY`, `MISSING_OCCURRENCE_SIGNER`, `WRONG_OCCURRENCE_KEY`,
`WRONG_OCCURRENCE_QUEUE`). This diagnostic is not persisted on the schedule.
Hosts must require both `ScheduleRunner.capabilities.requiredOccurrenceIntegrity`
and `AgentSchedule.capabilities.requiredAdmissionPolicy`, plus the public
`AgentSchedule.prototype.reconfigureAdmissionPolicy` method, before enabling
protected schedules. New jobs with old agents is an unsupported mixed cohort.
Absent policy retains legacy unsigned scheduling behavior. Full immutable job
arguments, including this policy, participate in admission signing. Verification
also rejects a policy inconsistent with the signed job queue or signature key.

Ordinary public `AgentSchedule.save()`/generated updates cannot remove or replace
an existing policy through mutated arguments, including fresh-object natural-key
upserts. An agents-owned mandatory write predicate binds the canonical stored
JSON; late collisions fail closed and callers reload/retry. This uses core's
public `GlobalInterceptors.writeGuard` seam without replacing tenant predicates.
Ordinary sequential same-policy and unprotected upserts keep their existing API.

A trusted host explicitly rotates/removes policy through the loaded model's
`reconfigureAdmissionPolicy(nextPolicyOrNull, { authorize: async context => ... })`.
The callback must check the **current** authenticated operator/tenant permission;
its context contains persisted schedule ID/tenant and previous/next policy.
Throwing denies without a write. Generated CRUD never supplies this callback.
Current tenant ownership and normal loaded revision CAS still apply. The same
instance must not be concurrently saved/rebound during this operation. This is
an explicit authorization boundary, not a serialized bypass flag.

For rotation, first retain old verification keys in the trusted keyring while
selecting a new current minting key, then authorize the durable policy key change.
Existing jobs retain their original exact arguments/signature on retry; unknown
or retired verification keys deny. Integrity does not replace current authority,
job/schedule locking or downstream command idempotency. Code holding trusted keys
and authorization callbacks remains trusted; this does not defend against it.

Owning focused tests cover SQLite and native DuckDB policy blocking, locked
recheck, exact protected retry/rotation, public save/CAS and late collision.
`packages/jobs/src/__tests__/retry-admission-postgres.optional.test.ts` additionally
covers real separate-connection retry/admission commit and rollback with signature
preservation. Coordinator integration owns PostgreSQL and the complete gates.
