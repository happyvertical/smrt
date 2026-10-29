# SMRT application chart

Chart `0.3.0` renders the maintenance-window contract described in
[the deployment guide](../../docs/content/deployment.md). It creates application
Deployments, Services, CronJobs, one static responder, an Ingress, an inventory
ConfigMap, and a retained migration Job. Existing databases, private buckets and
Secrets remain externally owned. Installing or uninstalling this chart never
creates or deletes those bindings.

The required `current` field accepts exactly `false` for bootstrap or a complete
runtime object; missing, null, true and empty objects are rejected. Bootstrap is
published at maintenance sequence zero by the runner and acknowledged through all
phases before activation.

Supply a complete values document; there are deliberately no deployable defaults.
`values.schema.json` is the strict published input contract. Unknown fields,
mutable images, inline environment values, unsupported provisioning and missing
writer classifications fail rendering. Environment values come from named Secret
keys. Use immutable, versioned Secrets for both sensitive and ordinary runtime
configuration; changing a referenced Secret in place is unsupported. The release
runner checks the immutable flag, identity and named keys without logging data.
The Helm release name is limited to 20 characters to bound Kubernetes names.
Pin images to platform manifest digests and constrain their node architecture.
The v1 runner compares actual Pod imageID digests directly; OCI index-to-platform
resolution belongs to trusted application CI, not the observation command.

The inventory separates named external Secret reads from Helm's release-storage
Secret requirements (`sh.helm.release.v1.<name>.v*`). Helm needs namespace-scoped
storage get/list/watch/create/update/patch/delete access; named binding reads
alone cannot reconcile a release. Namespace isolation and the reconciler identity
remain platform-owned prerequisites.

```sh
helm lint --strict charts/smrt-app -f charts/smrt-app/fixtures/iolaus.json
helm template fixture charts/smrt-app -f charts/smrt-app/fixtures/work.json
helm package charts/smrt-app
node --test scripts/deployment-chart.test.mjs
```

`current` contains the entire prior runtime specification, including every image,
command, Secret reference, probe and scheduling constraint. Maintenance preserves
that pod specification, suspends new CronJobs and routes traffic to the responder.
Stopped and migrate set **every** current Deployment to zero. Bootstrap uses
`current: false` and creates no application workload before verify. Verify starts
`target` while retaining maintenance routing; active changes the public backend.
Only active permits new CronJobs. Named schedule and background Deployments and
CronJobs require one replica. Background is the combined singleton runner role;
independently scalable task workers use task. Every workload explicitly declares
whether it writes, including services and read-only monitors.

The chart does not sequence historical transitions or prove stopped writers.
Protected Git writes, live observation, admission dry-runs, immutable Secret
identities, external-writer fencing and HTTP checks belong to the release runner.
Rendering active directly bypasses that protocol and must be denied by deployment
permissions. All resource metadata carries release/phase/sequence labels. Runtime
pod templates instead carry a workload-spec hash and stable workload/writer labels,
so acknowledging a phase does not restart the old application.

The responder image must be an immutable **nginx-compatible** image supporting the
provided command and `/etc/nginx/conf.d/default.conf`. The chart mounts a generated
static config: `/ready` returns 200, all other paths return 503 with the configured
body and `X-Smrt-Release` / `X-Smrt-Sequence` headers. It has no database or runtime
Secret dependency. The runner checks the public configured HTTP path and identity.
The Ingress has one public web backend; TLS can refer to an existing Secret.

The ordinary migration Job name includes release ID and attempt. It has no hook,
TTL or automatic retry. Helm's `helm.sh/resource-policy: keep` retains it after the
migrate manifest disappears and after uninstall. Retained Jobs are operational
history and need a separately reviewed cleanup policy. A retry requires an explicit
new attempt and a durable migration decision; deleting or renaming a failed Job is
not proof that rerunning its internal phases is safe.

The migration image must match a target workload image. Its command must invoke an
application-owned wrapper implementing `smrt-release-v1`: recheck writer quiescence,
acquire the database migration advisory lock, check runtime/static agreement, and
use the durable application phase API before mutations. The `guard` field is a
capability declaration, **not implementation or proof**. A release must fail
preflight until that wrapper and its platform fencing are verified. Migration and
runtime credentials must use different Secrets; read-only monitor credentials
should also have database-enforced read-only permissions. The chart injects only
non-secret migration identity variables `SMRT_RELEASE_ID`, `SMRT_RELEASE_ATTEMPT`,
`SMRT_APP_NAME` and `SMRT_APP_ENVIRONMENT`. Those names and other `SMRT_`
names remain reserved in migration configuration, except the exact application
settings `SMRT_RUNTIME_PROFILE` and `SMRT_APP_ID`. Chart 0.2.1 permits these two
settings through named migration Secret keys so a wrapper can select its runtime
profile and application identity; neither setting replaces release identity.
Migration pod identity remains stable across phase sequence changes.

`<helm-release>-inventory` contains `data["inventory.json"]`: version 1, the union
of current/target resource names, all referenced Secret names and keys, and the
RBAC/admission prerequisites. This includes future target workloads and migration
Jobs before entering maintenance. Repeated Secret entries describe multiple
usages. The runner must validate the entire inventory before any traffic change,
including dry-running every phase under the actual reconciliation identity.
Inventory presence is not evidence that permission or admission checks passed.

The Iolaus and Work fixtures are adoption examples, not runnable deployment values.
All image digests are synthetic. Replace them with published images and real
immutable Secret references. The example `scripts/release-migrate.mjs` is a required
downstream wrapper, not an existing entry point in those applications. Iolaus needs
the current per-workload migration initContainers removed, its existing guarded
migration command wrapped, real extractor identity/command, monitor command and
heartbeat probes verified. Its task grace is 270 seconds; schedule is 90 seconds.
Work needs migration/seed initContainers removed, its in-memory migration ledger
replaced with durable phase execution, and worker heartbeat/readiness plus drain
proof added. Work's runner combines task and scheduling execution and is modeled
as a singleton background workload; its independent Studio deployment stays
externally owned. Both examples require actual adoption PRs and rollout evidence.

### Pod hardening and migration observation (chart 0.2.0)

Named workloads and migration accept optional `serviceAccountName`,
`podSecurityContext`, and `securityContext`. These are bounded fields, not raw
PodSpec fragments. A supplied pod context requires `runAsNonRoot: true`, positive
`runAsUser`/`runAsGroup`, and `seccompProfile: {type: RuntimeDefault}`; optional
`fsGroup` and `supplementalGroups` must also be positive IDs. A supplied container
context requires `allowPrivilegeEscalation: false`, `readOnlyRootFilesystem: true`,
and `capabilities: {drop: [ALL]}`. Unknown fields and privilege/host escape settings
are rejected. Existing snapshots may omit these fields. Migration now accepts the
same `scratch` emptyDir declarations as named workloads. Scratch names/paths must
be unique; host/system roots and traversal paths cannot shadow credentials.
Chart 0.3.0 also preserves an optional migration `nodeSelector` map in the Job PodSpec.

`target.migration.observerAccess: true` requires an explicit pre-existing migration
`serviceAccountName`. It adds a read-only projection at
`/var/run/secrets/kubernetes.io/serviceaccount` containing `token`, `ca.crt`,
`namespace`, `pod-name`, and `pod-uid`. The native service-account token requests
600 seconds; Kubernetes rotates it, so callbacks must reread the token for fresh
requests. The API server controls its effective validity. CA comes from the
namespace's pre-existing `kube-root-ca.crt` ConfigMap. Verify TLS normally. Runtime
observer access and arbitrary projections are unsupported. Automatic service
account token mounting remains false on every pod, including migration.

The platform owns these service accounts, their read-only observer RBAC, root CA,
and any inherited image-pull Secret references. The runner requires observer
`get`/`list` on pods, deployments, replica sets, jobs, cron jobs, stateful sets,
daemon sets and horizontal pod autoscalers in the release namespace, plus bounded
`get configmap/<releaseName>-maintenance` to validate the responder config. It reads
all declared service accounts and inherited pull-secret references before
maintenance. The chart inventory lists service accounts, observer identities and
CA ConfigMaps; it creates none of these platform resources.

Preflight also creates synthetic Pods with `kubectl create --dry-run=server`
under the reconciler identity using each phase's exact template. This requires
namespace-scoped `create pods`; RBAC cannot restrict that grant to dry runs.
Random fresh names prevent adopting existing Pods. Nothing is persisted. Admission
identity can differ from the actual workload controller, and policies can change;
this is current evidence, not a guarantee of future admission. Actual observed
Pods must preserve the rendered security, service-account, scratch and credential
projection envelope. Qualify real execution under the hardened settings with the
disposable deployment exercise before adoption. Published charts 0.1.0, 0.2.0 and 0.2.1 must never be overwritten.
The bounded legacy adoption and continuous static contract ships as feature-minor
chart 0.3.0; it does not replace any previously published artifact.

### Bounded legacy resource adoption

`workloads.<name>.selectorLabels` optionally replaces the default Deployment and
Service selector. It accepts one to eight Kubernetes labels and reserves the
instance label and `smrt.happyvertical.com/*` labels. The same labels are merged
into the pod labels. Current and target must retain identical effective selectors
for a workload name; ordinary releases cannot change its static classification
or a continuous static Service port.
Omission retains the existing selector and resource names.

`readOnlyConfigMaps` accepts at most eight external immutable named ConfigMap
bindings: `{volumeName, configMapName, hash, mountPath, items: [{key, path}]}`.
`hash` is the canonical release helper hash of
`{data: configMap.data ?? {}, binaryData: configMap.binaryData ?? {}}`.
Items map individual keys to flat relative filenames. Mounts are directory mounts,
read-only, with no subPath, Secret or raw volume escape. Names and mount paths
cannot overlap scratch or other configuration mounts. One ConfigMap name cannot
claim different hashes across current and target. The inventory lists these under
`readOnlyConfigMaps` as external resources, never Helm-owned resources; observers
need bounded named ConfigMap reads and must prove immutable content and identity.

`continuousStatic: true` keeps a nonscheduled `role: service` workload running
through stopped and migrate. It requires `writer: false`, empty `env`, one to
three replicas, explicit `automountServiceAccountToken: false`, and both strict
hardening contexts described above. Its Deployment uses a fixed RollingUpdate
strategy with `maxUnavailable: 0` and `maxSurge: 1`, preserving service while new
pod labels or immutable configuration references roll out. Other Deployments keep
the existing Recreate strategy. Bootstrap still creates no application pods
before verify; static runtime and HTTP 200 checks begin only when that target is
actually rendered. This declaration alone proves no isolation: adoption requires live
pod/owner/image/config verification and platform CNI denial of credential/API and
writer-network access. Other workloads continue stopping regardless of writer
labels. No runtime API token or arbitrary PodSpec field is supported.

Within `ingress`, optional `name` preserves an existing primary Ingress identity.
Optional `annotations` permits only NGINX `proxy-body-size` (1m, 2m, 4m, 8m, 10m,
11m) and `proxy-buffer-size` (4k, 8k, 16k, 32k, 64k). `additionalRoutes` accepts
up to eight `{name, host, workload, tlsSecretName?, annotations?}` records targeting
continuous static services present in both runtimes. Each route retains its own
TLS reference, is independently inventoried, and continues serving while the
primary route uses maintenance. Names and hosts must be unique. All fields remain
inside the existing configuration identity hash; no annotation snippet, issuer
control or private service exposure is allowed.

CronJobs optionally accept `startingDeadlineSeconds` (1–600),
`activeDeadlineSeconds` (1–3300), `ttlSecondsAfterFinished` (1–86400), and
`successfulJobsHistoryLimit` (0–2) / `failedJobsHistoryLimit` (0–3). Omitting them
retains the prior timing behavior and history defaults of one each. Retained
migration Jobs continue having no automatic cleanup TTL.

Ordinary stopped/migrate proofs with a running continuous static exemption require
fresh platform writer-fence observations on every proof, including releases after
adoption. Protected runner `writerFence` configuration binds the native provider
and contract; omission blocks advancement. Preflight checks provider presence and
source identity without requiring writers already stopped. The published stopped
or migrate phase must then prove zero **unapproved** namespace/database writers
and actual static isolation before the next phase can publish. Bootstrap with
`current:false` renders no static exemption before verify and needs no such proof.
