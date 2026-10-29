# Git phase release command

Run with repository Node version. The runner calls Git, Helm, kubectl, and HTTP directly; it does not accept observation files. It publishes one phase per invocation and waits for exact Flux acknowledgement on the next invocation.

```
node scripts/deployment/cli.mjs plan deployment-config.json target-runtime.json unique-release-id > reviewed-plan.json
node scripts/deployment/cli.mjs apply-or-resume deployment-config.json reviewed-plan.json
node scripts/deployment/cli.mjs status deployment-config.json
node scripts/deployment/cli.mjs apply-or-resume deployment-config.json
node scripts/deployment/cli.mjs recover deployment-config.json
node scripts/deployment/cli.mjs repair deployment-config.json corrected-target-runtime.json
```

For bootstrap, the Git deployment file must be absent and `plan` input is a complete HelmRelease JSON document with `current:false`, maintenance phase, sequence zero, and a unique ID. For upgrades, the input is the complete new runtime; the prior target becomes the entire current runtime. Publication requires fresh proof that the prior active release is accepted at the exact Git revision and healthy. An unhealthy predecessor must follow recovery before a new release can start.

`recover` is explicit: verify goes to stopped, active goes to maintenance preserving the target runtime. Both record a required-repair marker bound to the failed runtime target, release, attempt, phase and exact observed revision; active then proceeds normally from maintenance to stopped. Stopped cannot publish migrate again until an explicit reviewed repair increments the attempt, even if the preceding migration Job succeeded. A failed migrate phase goes to stopped only after the live observer correlates the exact terminal failed Job/Pod, immutable spec/image/attempt, no live writers, suspended schedules and identity-bound maintenance response. Exact Git/Flux/OCI/configuration agreement remains required before and after phase proof, including failed health proof; lost acknowledgement cannot authorize recovery. Only the expected controller Ready=False Job failure may waive Ready=True; unrelated admission, permission, source, stale-generation or unknown failures remain blocked. Failed Job UID/spec evidence is retained in Git and rechecked; the command never deletes or mutates it.

After stopped is acknowledged, `repair` accepts a reviewed corrected runtime, increments the migration attempt and phase sequence, and publishes another stopped revision. Current runtime, application/environment, database/bucket bindings and retained failed Jobs are preserved. The protected CI evidence must bind either the failed migration attempt or runtime-recovery marker, the corrected target and reconciled durable ledger. The next `apply-or-resume` may then publish migrate. A fresh attempt never resets the durable ledger or permits rerunning unsafe steps; unresolved `needs-repair` blocks repair. No automatic migration retry exists. An accepted active-phase health/public assertion failure automatically publishes maintenance through the same preflight/CAS path; `status` remains read-only.

Configuration (paths refer to protected CI inputs):

```json
{
  "repository": "/checkout/deployment-repo",
  "branch": "main",
  "file": "apps/example/release.json",
  "namespace": "example-production",
  "chart": "/artifacts/smrt-app-0.1.0.tgz",
  "chartSource": { "name": "smrt-app", "namespace": "flux-system", "digest": "sha256:IMMUTABLE_OCI_MANIFEST_DIGEST" },
  "source": { "name": "deployment-source", "namespace": "flux-system" },
  "kustomization": { "name": "example", "namespace": "flux-system" },
  "validationEvidence": { "file": "/artifacts/validated-app.json", "sha256": "SHA256_OF_FILE_BYTES" },
  "maintenanceAssertions": [{ "url": "https://example.test/", "status": 503 }],
  "privateAssertions": [{ "url": "http://example-web.example-production.svc.cluster.local:3000/health", "status": 200, "bodyIncludes": "ready" }],
  "publicAssertions": [{ "url": "https://example.test/", "status": 200 }]
}
```

The complete HelmRelease declares `spec.serviceAccountName` for its reconciler, `spec.releaseName` equal to its name, and install/upgrade `strategy.name: RetryOnFailure` without remediation, and `driftDetection.mode: enabled` without resource/path exclusions. `install.replace`, `upgrade.force`, and `upgrade.cleanupOnFail` must remain disabled so a controller cannot recreate resources or remove a failed retained migration attempt. Only digest-pinned OCIRepository `spec.chartRef` is supported. Indirect `valuesFrom`, remote `kubeConfig`, alternate storage namespace, suspension, and namespace provisioning are rejected. The runner must be able to impersonate that identity/groups for inventory authorization and server admission dry runs. Helm storage requires namespace-scoped Secret get/list/watch/create/update/patch/delete under the reconciler identity, checked before maintenance; Helm revision Secret names are generated, so a fixed named-reference rule alone is insufficient. Both the reconciler and default runtime ServiceAccounts must already exist. Observation permissions belong to the runner. Private HTTP runs inside the cluster and must address exact runtime Service DNS; public and maintenance assertions must address the declared ingress host. Assertions optionally include exact `headers` and `bodyIncludes`; redirects are not followed. HTTP 500 always fails. The maintenance responder must return release/sequence headers.

The validation evidence file is produced by trusted application CI after actual validation. It is **not** a signed receipt API, and an operator-authored `passed:true` is not validation. This deliberately has no dependency on unpublished #4306 receipts. Its required fields are:

- `source`, `tree`, `lock`, `toolchain`: nonempty identities with retained CI evidence.
- `runtimeIdentity`: `hash(target)` exported by `release.mjs`.
- `migrationImage`: exact migration digest; `migrationCommandIdentity`: `hash(target.migration.command)`.
- `migrationProtocol`: `smrt-release-v1`; `validation.passed`: true after testing the actual image wrapper.
- `chartArtifactSha256`: SHA256 of packaged chart bytes; `chartReferenceIdentity`: `hash(helmRelease.spec.chartRef)`. `chartOciDigest` equals the protected source digest and `chartSourceIdentity` equals `hash(ociRepository.spec)`; source readiness and digest are checked live.
- `configurationIdentity`: `hash({maintenance, bindings, ingress})` from the reviewed values.

For a repair, the same CI evidence also requires `recovery` with:

- `predecessor`: the exact JSON object in the candidate's `smrt.happyvertical.com/repair-predecessor` annotation (`identity`, `releaseId`, previous/new attempt and previous target identity, plus failed Job UID for a migration failure or the exact `runtimeRecovery` marker for verify/active recovery).
- `targetIdentity`: `hash(correctedTarget)`.
- `ledgerState`: `reconciled`; `ledgerEvidenceIdentity`: SHA256 identity of retained application validation/reconciliation evidence. CI must actually inspect/reconcile the durable app ledger; these fields are an association with trusted validation, not an operator override or proof inferred from Job completion.

The trusted producer must verify packaged chart identity matches the protected Flux chart source/version, and migration wrapper uses the public durable phase API, rechecks live quiescence immediately before database writes, and holds a session-pinned migration lock. A completed Kubernetes Job alone cannot establish these properties. Transactional work/marker affinity and nontransactional reconciliation remain application/core responsibilities. Missing evidence blocks preflight; no validation skip exists.

Security boundary: one protected application/environment namespace, protected Git deployment file, trusted CI principal, immutable digest images, immutable versioned named Secrets, and no external writers to the database during maintenance. Namespace write access and database writer credentials must be restricted by the platform; labels alone do not fence an adversarial writer. Shared database/bucket infrastructure is retained and never provisioned by this runner. If external writers exist, this v1 must not be adopted until the platform supplies a real fence; an advisory migrator lock is not one.

Existing rendered names must already carry exact Helm release-name, release-namespace, managed-by ownership and an established `helm-controller` managed-fields entry; collisions require a reviewed ownership transfer before release. Server dry runs use that same established manager and impersonated reconciler identity, without force-conflicts. [Kubernetes SSA field ownership](https://kubernetes.io/docs/reference/using-api/server-side-apply/) and [server dry-run semantics](https://kubernetes.io/docs/reference/kubectl/generated/kubectl_apply/) explain why a separate preflight manager conflicts with legitimate controller-owned fields. Other manager conflicts and admission failures remain blocking; no state is persisted by this check. Dry runs establish current admission/RBAC evidence, not a promise of future reconciliation.

Every phase renders and server-dry-runs all phases of the packaged chart before publication. The runner fails on unknown namespace workloads, unsupported controllers/autoscalers, missing permissions, Secret/key/version changes, stale Flux revisions, wrong workload counts/generations/images/EndpointSlice Pod UIDs, and failed HTTP assertions. The deployment document is updated through a private Git index and a normal fast-forward push, preserving unrelated commits. Same-file changes, superseded file history, or a racing push fail. No force push, imperative scaling, ingress patch, or suspend mutation is used.

The app's normal entrypoints must not run migrations. The chart guard string is an adoption declaration, not executable enforcement. Real Flux/Kubernetes/database rollout evidence is separate from unit tests and rendering; run the isolated integration test before enabling a deployment principal.

Image verification compares the digest in each actual Pod `imageID` with the declared image digest. V1 requires a platform manifest digest for each workload, with matching node architecture constraints; it does not resolve an OCI multi-platform index into a platform manifest during observation. The trusted application CI producer must resolve and validate those immutable platform artifacts before constructing the target runtime.

Failed observations return `failureCode` and a safe diagnostic `failure` message, including image identity, readiness, HTTP expected/received numeric status, and named-resource permission gates. Only exported `DeploymentError` messages are public; unexpected exceptions and subprocess stderr remain redacted.

Application environment entries must be exact named Secret key references; literal `value`, `envFrom`, and extra reference fields are rejected before `plan` can return content. Commands and arguments are reviewed non-secret configuration; never place credentials in them. CLI command/configuration examples are exercised by the focused CLI dispatch tests, with adapters explicitly limited to unit fixtures.

Chart 0.2.0 adds bounded pod/container hardening, explicit pre-existing service
accounts, migration emptyDir scratch and optional migration-only observer access.
See the chart README for the exact projection and platform-owned prerequisites.
Preflight requires reconciler `create pods` for synthetic server dry-run admission
as well as reads of named service accounts, inherited pull Secrets and observer
CA. The observer must have namespace-scoped `get`/`list` on all supported writer
controllers and pods (including HPA), plus `get configmap/<releaseName>-maintenance`
for exact responder configuration validation. Runtime API-token projection remains off.
Actual Pod observation rejects added privilege/host access and credential volumes.
Run `node --test scripts/deployment-chart.test.mjs scripts/deployment-release.test.mjs`
for the focused contract suite. The disposable exercise uses non-root 10001,
RuntimeDefault seccomp, no escalation, dropped capabilities, read-only root and
bounded `/tmp` scratch on web, task and migration containers.
The exercise provisions its own disposable pre-existing observer SA/Role/Binding,
then enables the migration projection and checks every projected file is readable.
It compares projected Pod name/UID from bounded non-secret logs against the actual
Kubernetes Pod, verifies scratch writes and root-write refusal, checks runtime
Pods have no projected credentials, and checks missing-SA/denied-read RBAC failures.
It does not substitute those file checks for the application's TLS API observation.

Admission and live proofs compare controller templates with the original rendered
security/account/volume envelope before trusting their Pods. Standalone runtime
proofs also bind that envelope to declared workload values. Omitted service
accounts mean `default`; an injected alternate account refuses. Controller
server dry runs request JSON and inspect the admitted template, so controller
webhooks cannot silently introduce credential volumes for a later Pod to inherit.
Host ports, shared process namespaces, unsupported SELinux options and unconfined
pod/container seccomp or AppArmor profiles refuse. Kubernetes `hostUsers` defaults
to true: omitted and explicit true have the same meaning. The chart exposes no
user-namespace override; the verifier still binds an explicitly false expected
value when checking a supplied template. It does not reject standard API defaults.

## Explicit legacy Flux adoption

An existing logical application is never bootstrap input. `current:false` and
sequence zero remain exclusively for an absent application. Legacy adoption uses
an independently reviewed, UID-bound stopped handover; it never asserts that the
old PodSpecs were already generated by this chart.

```
node scripts/deployment/cli.mjs adopt-plan deployment-config.json adopt-plan.json
node scripts/deployment/cli.mjs adopt-or-resume deployment-config.json adopt-plan.json
node scripts/deployment/cli.mjs adopt-status deployment-config.json adopt-plan.json
```

Each mutating invocation advances one protected Git journal stage:
`planned → legacy-stopped → relinquished → helm-staged → helm-established → finalized`.
Before the first journal publication and every later publication, the runner
reobserves native Kubernetes/Flux state and a fresh platform writer fence. A saved
stage, Job completion or operator-provided boolean never supplies that evidence.
`adopt-status` only reads protected artifacts; it does not claim live readiness.
Read-only planning can inspect a qualified plan before a fence provider exists.
Missing qualification or a missing production fence provider blocks publication.

The strict `smrt.happyvertical.com/legacy-adoption-v1` plan has these exact fields:

- `adoptionId`, `releaseId`, `namespace`, `releaseName` identify the handover.
- `canonicalFile`, `stagingFile`, `stateFile` are distinct tracked-relative paths.
- `legacy` contains repository URL, full 40-hex `revision`,
  `maintenanceRevision`, `stopRevision`, `relinquishRevision`, and `source` and
  `kustomization` references, each with exact `namespace`, `name`, `uid`.
- `snapshot` and `qualification` each contain `file` and the SHA256 of its bytes.
- `normalizedCurrentIdentity`, `targetIdentity`, `configurationIdentity`,
  `chartArtifactSha256`, `chartOciDigest` bind reviewed runtime/configuration and
  both packaged and OCI chart artifacts.
- `fenceContract` contains `id` and `identity`.
- `candidate` is the complete HelmRelease with namespace/name, real normalized
  `current`, qualified `target`, stopped phase, sequence 1 and attempt 1. It must
  have no caller-supplied adoption annotations. Normal chart/Flux policy and
  trusted application CI validation still apply at staging preflight.

The snapshot (`smrt.happyvertical.com/legacy-snapshot-v1`) retains `adoptionId`,
the exact `legacy` object, `normalization` with `normalizedCurrentIdentity` and a
reviewed `explanation`, and `resources`. Each resource records `apiVersion`,
`kind`, `namespace`, `name`, `uid`, actual original `spec`, its `specIdentity`,
reviewed post-stop `normalizedSpecIdentity`, unchanged `selector`,
`legacyManager`, and Flux `fluxInventoryId`. Workload records additionally retain
actual complete `podSpec` including init containers, and all `oldImages`.
Snapshots can contain confidential old PodSpecs: retain them in protected Git
with appropriate access; the CLI emits hashes and safe diagnostics, not these
specs. The normalization record explains the reviewed changes between the actual
legacy configuration and the normalized stopped current runtime.

Trusted CI produces `smrt.happyvertical.com/legacy-adoption-qualification-v1` with
`adoptionId`, `snapshotSha256`, the plan's current/target/configuration/chart
identities, `fenceContractIdentity`, nonempty `source`, `tree`, `lock`, `toolchain`
and `validation.passed: true` after actual compatibility validation. The exact
fields for chart identities are `chartArtifactSha256` and `chartOciDigest`.
As with normal validation evidence, trust comes from the protected producer and
configured byte identity, not an invented signing API or an operator JSON flag.

Add this protected configuration alongside the ordinary release configuration:

```json
{
  "adoption": {
    "stateFile": "adoption/proof/state.json",
    "stagingFile": "deploy/adoption/flux/pending.json",
    "fluxPath": "deploy/adoption/flux",
    "sourceUid": "ACTUAL_NEW_GITREPOSITORY_UID",
    "kustomizationUid": "ACTUAL_NEW_KUSTOMIZATION_UID",
    "snapshotSha256": "SHA256_OF_REVIEWED_SNAPSHOT_BYTES",
    "qualificationSha256": "SHA256_OF_TRUSTED_CI_QUALIFICATION_BYTES",
    "fenceObserver": {
      "file": "adoption/platform-fence.mjs",
      "sha256": "SHA256_OF_REVIEWED_PLATFORM_MODULE_BYTES"
    }
  }
}
```

This version requires a dedicated Flux auto-generated resource directory, matching
live target Kustomization `spec.path` and its exact source/UID. Canonical and staging
files must be immediate children of that directory; no other tracked resources
or explicit `kustomization.yaml`, `kustomization.yml` or `Kustomization` are
permitted there. Plan, journal, snapshot, qualification and platform code live
outside it. The legacy source/Kustomization may be different principals and
remain bound separately. This restriction makes staging-to-canonical publication
an atomic Git rename of one same-name HelmRelease under one Kustomization, without
an interval of duplicate rendered resources or a resource-list edit.

The reviewed platform module exports `observeWriterFence(context)`. CLI loads only
the protected tracked Git bytes matching configured SHA256, as an ES module;
use absolute or `node:` imports rather than relative module imports. Embedders
instead pass the explicit public callback as
`createLiveAdapter(config, command, request, { adoptionFenceObserver })`.
There is no shell-string or observation-JSON override. The callback runs afresh
and returns `apiVersion: smrt.happyvertical.com/writer-fence-v1`, `contractId`,
`contractIdentity`, `adoptionId`, `planIdentity`, `namespace`, `epoch`,
`observedAt`, `expiresAt`, `namespacePolicyIdentity`, `databasePolicyIdentity`, and
`observations`. Times are Unix milliseconds, observations must be at most 30
seconds old, and expiry is at most 30 seconds ahead. Each observation contains
exactly `scope` (`namespace` or `database`), SHA256 `identity`, `observedAt`, and
`activeWriters: 0`; both scopes are required. These are associations with actual
platform observations, not a generic `passed:true`. Platform code must verify
namespace admission/credential restrictions and database credentials/sessions;
this runner cannot manufacture a database fence from workload labels or a lock.

The platform first publishes separately reviewed legacy maintenance/stop changes.
The runner verifies exact legacy UID/source/revision acknowledgement, observed
normalized specs/selectors, actual drained writers/Jobs, identity-bound HTTP 503
and legal/static route HTTP 200 plus the fresh namespace/database fence. Protected
`staticAssertions` target every additional static host and require status 200.
The platform then performs the reviewed ownership handover: disable old
Kustomization pruning, relinquish its actual inventory, preserve UIDs/selectors,
and set exact Helm release-name/release-namespace/managed-by metadata and
`kustomize.toolkit.fluxcd.io/prune: disabled` on retained resources. Unknown
controllers, field managers, live writers and changed identities remain blocking.
The runner does not scale or patch legacy resources for the operator.

Staging preflight allows the exact approved legacy UID/manager state only and
renders/admission-dry-runs all phases. Other SSA conflicts remain fatal; no force,
Helm broad take-ownership, delete/recreate or automatic restart is enabled. It
publishes the stopped candidate with `smrt.happyvertical.com/adoption-{id,plan,
status:pending,origin}`. Canonical remains absent. Establishment requires exact
Flux acknowledgement, normal Helm values/storage and established helm-controller
ownership, preserved UIDs/selectors, stopped writers, static health and fresh
fences. Finalization atomically renames staging to canonical with status `complete`,
`adoption-proof` (observation identity) and `adoption-state` (journal identity).
Actual binding-version annotations are pinned. Resume after finalization
reobserves the exact final commit and all live gates before reporting success.

Normal mutable CLI commands refuse pending live markers or pending/mismatched
journals. After genuine stopped adoption acknowledgement, ordinary release
progression publishes migrate sequence 2, verify 3, then active 4 using the actual
stopped predecessor. The journal remains durable and history-bound; ambiguous
failure stays held with maintenance and fencing intact. No invocation increments
a migration attempt, restarts legacy writers or reconstructs missing UIDs.
Unit fixtures exercise protocol branches and real local Git CAS/rename behavior;
they do not establish actual Kind/Flux/database adoption. A real isolated native
exercise is required before enabling the principal.

Journal observations retain bounded, typed safe native resource UID/spec/selector
hashes and manager names, exact legacy and target Flux principal identities,
revision/time, and the complete typed fence observation (scope identities, epoch,
policy hashes, times and zero-writer counts). They retain no raw PodSpecs, Secret
contents, database rows or exception messages. `adoption-proof` hashes the retained
canonical observation record; its immutable protected Git journal is the proof
artifact. `adoption-state` hashes the complete journal and its preceding-state
link. Finalization immediately reobserves the final commit; pending reconciliation
can leave the final rename committed while the command refuses success, and the
next invocation rechecks that final state without another publication.


### Ordinary release fences for continuous static runtimes

Every actual stopped/migrate proof that exempts a running continuous static
runtime requires fresh native namespace/database writer-fence facts. This applies
after adoption and to recovery observations as well. The protected configuration
contains `writerFence: {id, identity, observer: {file, sha256}}`. The observer is a
regular tracked Git module outside the actual target Kustomization resource
directory (`spec.path` must be a dedicated relative directory), loaded only
from the exact observed Git revision after its SHA256 matches. It exports
`observeWriterFence`; the existing explicit SDK `adoptionFenceObserver` injection
is also supported with the same contract id/identity. Missing or changed provider
code blocks. Preflight resolves and validates the provider without calling native
zero-writer queries while maintenance writers may legitimately still run.

For ordinary release calls the request contains `operation: "release"`, the full
protected Git `document`, `documentIdentity` (the existing values identity),
`documentSha256` (`hash(document)` including control spec and annotations), exact
`revision`, `releaseId`, `phase`, `attempt`, `namespace`, `contractId`,
`contractIdentity`, and `observedAt`. Its `context` contains exactly operation,
documentIdentity, documentSha256, revision, releaseId, phase and attempt. The
response is the existing `smrt.happyvertical.com/writer-fence-v1` native envelope
with exactly contractId, contractIdentity, context, namespace, epoch, observedAt,
expiresAt, namespacePolicyIdentity, databasePolicyIdentity and observations, plus
apiVersion. The ordinary context replaces adoptionId/planIdentity; the adoption
variant and retained journal format remain unchanged.

Both namespace and database observations must be fresh within 30 seconds, bound
to the same contract/namespace/full document/revision/phase/attempt, and report
zero unapproved writers. A native guard may exclude only the exact currently
approved migration session/controller during migrate; it must not report a
blanket all-sessions-zero condition that deadlocks legitimate migration. Native
policy and CNI enforcement must be observed; labels, immutable configuration and
an operator flag are insufficient. Provider exceptions are redacted. The normal
sequencer consumes this actual stopped/migrate proof before the next CAS; it does
not request facts for an unpublished prospective phase. Bootstrap current:false
has no running static exemption before verify and skips premature static HTTP
assertions, preserving the no-application-Pods-before-verify contract.


After candidate preflight, Git CAS refreshes the native fence for the actual
published current stopped/migrate document immediately before private-index
mutation. The full current document and exact source revision must still match
the observed snapshot; a concurrent source change requires a new observation.
This guard is shared by advance, recovery, planning and repair CAS paths. It never
queries zero-writer facts for an unpublished candidate or maintenance writers.
Expiry never releases the platform's native latch.

Reviewed legacy repository URLs support HTTP(S) without userinfo and SSH URLs with
the nonsecret `git` user, including `ssh://git@github.com/willgriffin/jobgeni.git`.
Passwords, HTTP userinfo, queries, fragments and control characters are rejected.
The URL is preserved exactly for native Flux source equality; it is not rewritten
or converted to a different transport during adoption.
