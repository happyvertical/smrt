# Paper intake bridge

Import server integration from `@happyvertical/smrt-education/ingestion`, never
from browser code. Build IngestionService, SubmissionService and the supplied
scope from one authenticated server session. Derive learner/enrollment selection
from authorized application state, not OCR output or uploaded metadata.

1. Receive retained bytes through IngestionService.receive with bounded request
   sizes, captured authority and retention. Accepted/duplicate receipts share the
   existing durable item identity. Retry/unavailable is not a successful upload.
2. `queueEducationExtraction(service,itemId,configuration)` allocates the immutable
   extraction revision. The registered ingestion job dispatch invokes
   `processEducationAnalysis` with the saved item/revision and its authenticated
   worker service. Extraction runs outside transactions; success allocates a
   separately dispatched interpretation revision with ingestion's frozen source
   pin. Ingestion's outbox repair/recovery APIs remain the owner of missing jobs.
3. `educationIntakeHandlers({submissions,request})` discovers only the authorized
   learner/enrollment's assignment lessons. Unknown/ambiguous proposal outcomes
   remain unresolved. Use ingestion's preview/decision/apply APIs for the human
   identification choice; do not select the first candidate automatically.
4. After explicit assignment confirmation, `captureEducationIntake` reads original
   evidence through the authenticated ingestion service and copies it through
   SubmissionService private storage. Supply `kind: 'blank_reference'` before work
   begins or `kind: 'completed_work'` for an attempt. A correction supplies the
   previous submission ID and a NEW intake item. Durable tenant/item uniqueness
   prohibits rebinding captured bytes to another learner/lesson/kind/predecessor.
   Retrying a capture preserves its identity; storage failures propagate with the
   owning service's compensation/reconciliation contract.
5. Reconfigure the authoritative catalog with the captured `submissionId`, then
   queue fresh extraction with `queueEducationExtraction(service,itemId,config,
   submissionId)`, then generate a fresh interpretation/preview for grading. The grade handler binds
   the exact captured intake and attempt. Every policy must require human review;
   the adapter rejects an effective policy without `requireReview`. Marks remain
   proposals until ingestion records an approved guardian decision. A blank
   reference cannot be graded. Applying uses `withExecutor(context.db)` and
   `applyReviewedSubmission`, with no provider or blob I/O. Ingestion owns action
   retries/decision idempotency; education owns current-attempt checks.

The host execution authorizer must serialize current grant checks/revocation with
writes. Use `educationIntakeTargetResolver({submissions,request,submissionId?})`
for its target resolver: it locks the enrollment and reauthorizes on the supplied
executor. It uses these revision formats: lessons use
`assignment:<enrollmentId>:<lessonId>`; submissions use
`attempt:<submissionId>:<status>`. The latter must also recheck the current attempt
and intake binding. These identities do not authorize arbitrary catalog access.
Answer keys and private source locators never enter candidate labels.

## Decoder deployment

The SDK adapter uses disposable child processes with deadlines and a Node heap
cap. Native decoder allocations require a real operating-system ceiling. Call
`requireIngestionMemoryLimit(maximumBytes)` **in the decoder worker at startup**
before constructing `createSDKExtractionAdapter({nativeMemoryIsolation:
'host-enforced', ...})`. The check requires Linux cgroup v2, reads actual process
membership and all visible ancestor `memory.max` values, and fails closed for
missing/unlimited/over-policy limits or inaccessible files. Children inherit the
worker cgroup. Deploy an unprivileged container with a finite memory limit, no
writable cgroup mount, and no permission to escape/migrate cgroups. A configuration
string alone is insufficient. Container termination/OOM remains a retry/recovery
condition in ingestion, never a successful extraction.

The web server may run on macOS or another platform while jobs run in that Linux
worker. Local mock extraction tests establish sequencing and authorization,
not live OCR quality or production container enforcement. An actual memory-limited
worker launch and live provider smoke test are deployment acceptance prerequisites.
Provider credentials belong only in trusted worker configuration; do not put them
in receipts, job arguments, scope metadata or logs.

Selected catalog content must come from the explicit acquisition service, carrying
resource/revision/hash and attribution/notices. Catalog discovery is metadata
only and cannot establish download permission. Pin the acquired reference to the
assignment; do not replace it when the source catalog changes.

## Learner uploads and guardian execution

`capturedCeiling.execution.principalId` is mandatory and immutable. A learner
upload that will later be reviewed by a guardian must capture a trusted,
server-provisioned execution principal, distinct from the requesting person.
The host explicitly provisions that principal's maximum scoped operations and
rechecks its current grants on the supplied executor. Uploading never grants
those permissions to the learner. Missing principal provisioning is a closed
configuration error; existing learner-principal receipts cannot be silently
upgraded or have their captured ceiling rewritten.

Ingestion already executes as that stable principal **on behalf of** the current
authenticated `scope.actorId`. The bridge preserves the principal permission
runtime and its intersected permission snapshot while entering a nested tenant
context for the actual requesting human. Education then verifies this actor's
membership, learner ownership or guardian relationship on `context.db`; its
existing own-learner grading prohibition still applies. Both authorizations are
required: principal grants alone cannot authorize guardian grading, and a
legitimate guardian cannot exceed the receipt's principal ceiling. Current grant
and guardian relationship revocation must serialize with execution, as before.
