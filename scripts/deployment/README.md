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
