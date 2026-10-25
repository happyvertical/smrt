---
title: Maintenance-window application deployment
---

# Maintenance-window application deployment

SMRT deployment v1 uses an explicit maintenance window. Replica counts express
capacity; every release may interrupt service. Rolling upgrades and zero-downtime
schema compatibility are deferred. The chart, Git phase runner, and durable
PostgreSQL step API implement the contract below. The
[deployment test matrix](./deployment-test-matrix.md) records required evidence.
A rendered chart is not proof of a deployment, migration, or downstream adoption.

## Ownership and supported boundary

The application owns its workload inventory, immutable images, entrypoints,
readiness assertions, migrations/backfills/seeds, and shutdown behavior. Platform
IaC owns environment bindings: namespaces, PostgreSQL and roles, private buckets,
TLS/DNS/ingress controller, secret delivery, registry access, and external OCR or
model services. The release binds existing resources. It does not install,
upgrade, or delete shared PostgreSQL, Garage, OCR, or model infrastructure.
Uninstall must leave external databases, buckets, and their contents intact.

The independently versioned `smrt-app` chart starts at `0.1.0`; its intended OCI
location is `oci://ghcr.io/happyvertical/charts/smrt-app`. Publication is a separate
reviewed operation. Chart, application source/configuration, lockfile, toolchain,
validation evidence, and each image digest must be associated in the release
record. #4306's receipt API is unpublished; missing matching evidence requires
validation, never an unchecked skip or a dependency on an unmerged worktree.

The tooling entrypoint is `node scripts/deployment/cli.mjs`. Its
[configuration and commands](https://github.com/happyvertical/smrt/blob/main/scripts/deployment/README.md)
describe plan, apply-or-resume, status, recovery, and explicit repair. Run the command
from a protected deployment executor with access to both the cluster's private
Service DNS and the public application hostname. It uses the reviewed packaged
chart and protected application CI evidence; a hand-written success flag does
not establish validation.

Git owns desired release state. Flux/Helm owns rendered Kubernetes resources.
The release runner observes accepted state and publishes guarded Git transitions;
it must not imperatively scale Deployments, change ingress, or suspend a parent
Flux object. Protected deployment writes and exclusive release authorization are
the enforcement boundary. JSON Schema cannot prove historical phase ordering.
A user with unrestricted deployment writes can bypass this protocol; admission
or repository controls must prevent that path for qualified deployment use.

No SMRT operator is required for v1. Flux reconciles the acknowledged Git
revision, Helm owns ordinary application resources, and the release command
coordinates observations and subsequent Git revisions. Existing provider
operators remain platform-owned. A future operator would need evidence that
these explicit lifecycle boundaries cannot support repeated deployments;
automatic shared-service provisioning and rolling deployment remain deferred.

Adopting existing resources requires a reviewed inventory and explicit ownership
transfer. Never silently adopt by matching names or replace unrelated resources.
Retained provider resources stay outside the chart's lifecycle. A fresh install
against an existing database/bucket starts under maintenance with no app writers.

## Values and inventory

Strict values validation must reject unknown fields, malformed references,
mutable application images, unknown workload roles, unsupported provisioning or
autoscaling, and secret values in reference fields. Configuration contains secret
names/keys, never credential material. Named workloads may use independent
images, commands, replica counts, ports/services, startup/readiness/liveness
probes, resources, scheduling constraints, temporary writable volumes, and drain
grace periods. A workload combining tasks and schedules is a singleton scheduler,
not a horizontally scalable task-only worker.

Before entering maintenance, preflight must enumerate every rendered resource,
required existing Secret/key and ConfigMap, pull credential, service account,
controller/CRD, network route, RBAC action, and admission prerequisite. It must
prove the runner can observe the entire writer inventory and the controller can
create/update required resources. Missing access fails before traffic changes;
partial inventory success is insufficient. Diagnostics report references and
redacted categories, never secret values or credential-bearing URLs.

Classify all Deployments, CronJobs, active Jobs, and external writers explicitly.
A read-only monitor needs a genuinely restricted database identity; a role label
alone is not proof. Stop runtime and monitoring sessions during migration,
restore, and permission reconciliation where required by the
[PostgreSQL permission contract](postgres-permissions.md). Unknown writers,
external database clients, unmanaged jobs, or uncertain termination block
migration. An advisory migration lock serializes migrators; it does not fence
application writes. Platform fencing is required when workload termination
cannot establish exclusive mutation access.

The initial chart schema uses `app`, `release`, `current`, `target`, `maintenance`,
`bindings`, and `ingress`. `current` is `false` for bootstrap; otherwise it preserves
the prior runtime while `target` declares the candidate. Workloads are a named
map under each runtime. The `smrt-release-v1` migration guard value declares a
capability; it does not implement the guard or authorize mutation by itself.
Iolaus/Work fixtures use synthetic digests and adoption-only wrapper commands;
applications must supply real images and the durable migration adapter before
use. Secret references must be versioned/immutable for release identity to bind
their configuration without exposing values.

## Acknowledged release phases

Each transition needs a separately accepted Git revision and fresh live evidence
bound to the application, environment, release, revision, configuration, and exact
workload images. Publishing several phase commits without waiting lets Flux skip
them and is invalid. Concurrent attempts serialize per application/environment;
updates use compare-and-swap and preserve unrelated monorepo changes. A stale,
superseded, skipped, or unobserved revision cannot authorize the next phase.

| Phase | Desired state | Evidence required before advancement |
| --- | --- | --- |
| `maintenance` | Public hostname routes to an independent static HTTP 503 responder. Existing runtime images remain current; target images are recorded separately. Bootstrap has zero app replicas. | Public hostname returns the expected maintenance response from the accepted route; responder survives app shutdown. |
| `stopped` | All declared writers have zero desired replicas, schedules are suspended, and active Jobs drain under declared policy. Maintenance persists. | Actual pod/process termination, no active writer Jobs/schedules, complete inventory and required database fencing; desired zero alone is insufficient. |
| `migrate` | Retained, uniquely named ordinary Job runs the target digest with migration-only credentials; app writers remain stopped. | Job rechecks quiescence and lock; runtime/static inventory guard passes before writes; ordered schema, backfill, seed, permission and verification steps have durable outcomes. |
| `verify` | Target runtime images start behind maintenance after successful migration. New writers may run. | Exact current generations, pod imageIDs, ready endpoints, worker readiness/drain contracts, and application HTTP assertions match the release. |
| `active` | Public routing switches to the verified target endpoints. | Public serving assertions and observed serving image identity match the verified release and accepted routing revision. |

A healthy old endpoint, self-reported digest, stale Ready condition, successful
process exit, or HTTP 200 liveness check alone cannot authorize activation.
Verification includes application behavior: an alive process returning HTTP 500
fails. Collect evidence for all required workloads, rejecting missing,
unexpected, or duplicate entries rather than dropping them from the report.

The migration Job is not a Helm hook or runtime initContainer. Retain failed
Jobs and evidence; do not use automatic deletion, TTL cleanup, or retries that
silently rerun partial migrations. Flux/Helm remediation must never roll back to
an old active release after database mutation. The approved controller floor is Flux helm-controller 1.4.5 or later with
matching CRDs. Set `RetryOnFailure` explicitly for both install and upgrade; do
not enable remediation rollback. Integration must validate those settings against
the installed official APIs before qualification. Unvalidated defaults are not
an accepted safety boundary.
Enable Flux drift detection, and leave replacement, force recreation, and cleanup
of failed upgrade resources disabled. A retained failed Job is evidence, not an
instruction to delete and rerun it.

The [Flux example](https://github.com/happyvertical/smrt/blob/main/examples/deployment/flux.yaml)
uses an OCIRepository pinned to the chart's published manifest digest and an
explicit namespace reconciler identity. Replace its deliberate placeholders
with reviewed values; an empty values object cannot install an application.
The runner requires the complete HelmRelease JSON document in protected Git,
without indirect `valuesFrom`, cross-cluster targets, or alternate release names.

Chart checks run in the separate `SMRT chart` workflow. After review and merge,
an authorized maintainer dispatches that workflow on `main` with `publish=true`.
Configure the `smrt-chart-publication` GitHub environment with required reviewers
and main-only deployment protection before enabling publication. The workflow
checks registry inventory, refuses to overwrite an existing version, packages
the chart, and pushes to GHCR; it does not deploy an application. Record the
emitted OCI digest in platform-owned source configuration. Chart versions are
independent of npm releases and do not use manually authored changesets.

## Durable mutation and recovery

`DeploymentPhaseTracker` is exported from
`@happyvertical/smrt-core/migrations` and supports PostgreSQL only. Its
[API and executor contract](https://github.com/happyvertical/smrt/blob/main/packages/core/agents/deployment-phases.md)
describe `runTransactionalStep`, `runReconciledStep`, and `getStepStatus`.
Each execution requires a safety callback that proves runtime/static agreement
and writer exclusion before ledger writes. Transactional callbacks receive only
the pinned connection query API; they must not use a pooled outer database.

SQL `MigrationTracker` remains authoritative for schema checksums and supported
concurrent-index recovery. Do not store opaque shell callbacks in schema history.
Each data or seed step needs a stable identifier, immutable checksum, and durable
resume boundary. Transactional data mutation and its completion marker must use
the same database transaction/executor. Failure before commit rolls back both;
failure after commit must not repeat a completed non-idempotent mutation.

`BackfillTracker.runIfPending()` currently uses check-then-act without locking
and executes the callback before recording completion. Its default use neither
excludes concurrent runners nor closes the commit-to-marker gap. A transaction
bound tracker plus exclusive migration execution is needed for atomic work.
Nontransactional operations require idempotent reconciliation/checkpoints, or an
explicit `needs-repair` outcome after ambiguous interruption. Kubernetes Job
completion and an in-memory step ledger do not prove exactly-once execution.
Checksum changes for an existing step fail closed rather than rerun it.

An interrupted runner resumes from authoritative Git, accepted controller state,
and durable step evidence. Local files and prior console output are insufficient.
Before corrective migration from `verify` or `active`, restore maintenance and
stop the new writers through acknowledged phases. A failed public check restores
maintenance. Do not automatically start an old image against a changed database.

For a failed migration, `recover` publishes stopped state only after identifying
the exact terminal failed Job and Pod and proving maintenance and writer
termination. It never treats unrelated permission, admission, or source failure
as an applied release. The retained failure evidence binds the Job UID and
immutable specification. Once stopped is acknowledged, `repair` publishes a
separate stopped revision with a reviewed target and incremented attempt. Its
protected CI evidence must identify the predecessor, corrected target, and
reconciled durable ledger; `needs-repair` cannot authorize another attempt.
Normal resume then publishes migrate. No command deletes the failed Job or
resets completed data-step markers.

Recovery from failed runtime verification or public serving likewise records the
exact previous target and requires acknowledged stopped state before `repair`.
The corrected target receives a fresh migration attempt, which reruns safety
guards and consults existing durable markers before verification. A direct
stopped-to-verify target edit is outside the protocol.

| Failure | Required operator/release action |
| --- | --- |
| Preflight fails | Correct binding, inventory, authorization, or evidence; no traffic change. |
| Maintenance response cannot be proved | Keep the release from advancing; inspect route/controller identity. |
| Drain or fencing cannot be proved | Keep maintenance; identify remaining writer and obtain termination/fence proof. |
| Migration step fails | Retain Job and durable outcomes; repair the declared step and safely resume. Preserve committed steps. |
| Nontransactional interruption is ambiguous | Report `needs-repair`; reconcile actual external/database state before any retry. |
| Target verification fails | Keep maintenance; stop target writers before corrective mutation. |
| Public serving verification fails | Return routing to maintenance; retain target and database evidence for repair. |
| Database restore required | Use the platform owner's reviewed backup/restore procedure with writers and monitoring stopped; requalify permissions and target compatibility before activation. |

## Application/runtime integration

Runtime profiles remain application-side provider selectors; this chart does not
replace [runtime profiles](runtime-profiles.md) or move platform secrets into
`smrt.config.ts`. Current deployed initialization accepts `prepareDatabase` and
runs it on process startup. Maintenance deployment adoption must make runtime
startup read-only for schema readiness and move all mutation into the dedicated
migration phase. Remove migration initContainers and migration startup gates
before asserting compliance. Runtime pods must not receive migration credentials.

Optional observability integration remains application-owned. Validate its
configuration with the actual SDK in the immutable application image, and confirm
a synthetic event at the intended provider before claiming delivery. Configuration
presence and a local flush are insufficient. Existing HTTP assertions may check
a safe application verification result; keep DSNs, tokens and customer data out
of that response and release diagnostics. Provider delivery is a separate
downstream qualification requirement when that integration is declared.

The following mappings are source evidence refreshed read-only on 2026-10-24,
not deployed conversions. Changes to those repositories and live infrastructure
require their own tracked work and authorization.

| Application and inspected revision | Mapping and required adoption changes |
| --- | --- |
| [Iolaus `9f4f4280`](https://github.com/willgriffin/iolaus/tree/9f4f4280b9531a9af3922038c603d5591e11a48b/deploy/self-hosted/base) | Web/task/schedule capacity 2/1/1, independent extraction service, restricted read-only monitor. Web `/health` readiness and `/live` liveness; task drains up to 240s with 270s grace and heartbeat probes. Preserve entrypoints and extraction/provider bindings. Remove migration initContainers from runtime and monitor workloads; retain maintenance-window/advisory-lock/integrity guards in the dedicated migration command. Qualify worker readiness, monitor shutdown, and external writer fencing. |
| [Work `e54ccdef`](https://github.com/happyvertical/happyvertical.com/tree/e54ccdef38b05cb625a3c7ff870961dda09b5631/manifests/work/base) | Independent web and worker images; existing worker combines task and schedule runners and stays singleton unless downstream splits it. Replace mutable tags with digests, remove web migration/seed initContainer, replace the in-memory `migration-steps.mjs` ledger with durable steps, and add worker readiness plus drain proof. Bind existing `work-shared-postgres` key `uri`; optional worker-only Buzz identity stays worker-only. Preserve separate Studio deployment. Assert `/` and `/login` 200 and `/portal` 303 with the expected login redirect. |
| [Anytown `d672272a`](https://github.com/anytown/anytown.ai/tree/d672272a3cb7867441dab316cf9017269f4759bd/manifests/base/app) | Dashboard, combined background scheduler/jobs, and site-deploy workers require separate named declarations. Background is singleton; site deployment capacity is independent. Preserve preview-controller RBAC, private bucket, mail/AI and shared database bindings. Replace imperative Flux quiescence with acknowledged desired-state transitions; enumerate preview/site jobs and external writers before migration. |
| [Ergot `ebe2d1fc`](https://github.com/happyvertical/ergot.io/tree/ebe2d1fc86340b4c7844a8d3f3e6374de12695a0/manifests/base) | Web, orchestrator, NVIDIA/ROCm/cloud processors, and Studio runtime have independent images and scheduling needs. Preserve model-bank/node-runtime separation. Replace rolling web/startup migration gates with maintenance phases. Extend workload health reports with observed Kubernetes imageIDs/endpoints; retain strict workload-set, manifest/source and readiness assertions. |

No downstream application deployment or real rollout is established by these
mappings. Release evidence must state the exact target/environment, accepted
Git revisions, controller versions, image identities, validation commands, and
remaining adoption gaps. See the matrix for qualification evidence requirements
and the separately authorized real-application rollout requirement.
