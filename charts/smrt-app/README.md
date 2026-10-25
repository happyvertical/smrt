# SMRT application chart

Chart `0.1.0` renders the maintenance-window contract described in
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
`SMRT_APP_NAME` and `SMRT_APP_ENVIRONMENT`; the `SMRT_` namespace is reserved there.
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
