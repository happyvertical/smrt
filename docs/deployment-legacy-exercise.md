# Disposable native legacy adoption exercise

The independent `legacy-exercise` job in `smrt-chart.yml` runs
`scripts/deployment-legacy-exercise.mjs`. It adds real Git publication, source and
Kustomization acknowledgements, ownership transfer and a native fence to the
existing maintenance/recovery exercise. Publication requires both exercise jobs.
`workflow_dispatch` with `publish: false` supports a feature branch; publication
still requires main and the existing protected publication environment.

This is authored executable qualification, **not evidence of a successful run**.
A successful retained CI receipt is required before making a qualification claim.
No production cluster, credential or downstream application is accessed. The
script requires `SMRT_LEGACY_DEPLOYMENT_EXERCISE=1`, one absolute kubeconfig under
`RUNNER_TEMP`, and an absent kubeconfig file. The script creates and deletes only
`smrt-legacy-ci`; the workflow also cleans it in an unconditional final step.
Workers must not run the cluster. Root integration owns execution and review.

## Production prerequisite and precise profile

The production controller versions observed for #4481 are Flux source-controller
1.6.2, kustomize-controller 1.6.1, helm-controller 1.3.0 (Flux 2.6.4), on Kubernetes
1.34.3+k3s1. The official 2.6.4 HelmRelease CRD has no install/upgrade
`strategy.name: RetryOnFailure`. That profile cannot satisfy this runner's public
contract. The exercise downloads its checksum-bound official CRD and requires the
capability detector to reject it before applying an incompatible HelmRelease.
It then checks the target profile's CRD before installation. Production adoption
is blocked on the separately reviewed controller/API/storage upgrade prerequisite.
There is no strategy downgrade, schema skip or fake acknowledgement.

The actual run uses a production-shaped Kubernetes **1.34.3** Kind node and a
verified compatible **kubectl 1.34.3**, with target **Flux 2.8.8**:
source-controller 1.8.5, kustomize-controller 1.8.5, helm-controller 1.5.5,
notification-controller 1.8.4. The receipt retains declared artifact identities,
actual controller image/imageID values, actual HelmRelease CRD identity and tools.
It must never be presented as qualification of the current production controllers.
The existing normal exercise's separate cluster/profile is unchanged.

The new cluster disables Kind's default CNI and installs **Cilium 1.20.4** using
its official Kind configuration (`ipam.mode=kubernetes`, kube-proxy retained,
one operator). Cilium documents Kubernetes 1.33–1.36 compatibility. NetworkPolicy
is proved by successful TCP connections from the actual static pod before policy,
and bounded TCP timeouts to PostgreSQL/API afterwards; a missing client command
or immediate non-network error does not count as a denied connection.

The controller is exactly production's historical ingress-nginx chart **4.11.3**
(controller 1.11.3), with 11m body and 64k buffer annotations. Its documented
Kubernetes support is 1.26–1.30, **not 1.34**. This is an empirical compatibility
experiment: a passing request/configuration check is not vendor support or a
production security/support claim. The fixture inspects actual nginx configuration
and rejects an oversized body rather than assuming annotation behavior.

## What the real path exercises

A full official Node Debian image runs `git http-backend`, serving smart
upload-pack from a read-only host mount of the same bare object database that the
publisher pushes. A local smart HTTP test actually clones and fetches it; the
cluster additionally validates transport before Flux. Separate legacy and target
branches allow the legacy source to remain at reviewed stop/relinquish SHAs while
private-index CAS commits advance the target source. No Git/Flux observation is
replaced by a canned adapter response. Adoption uses `createLiveAdapter` and its
public native fence callback. The CLI's pending-adoption gate is also exercised.

Seven actual legacy workloads include the continuous static service and bounded
source-crawl CronJob. Original real PodSpecs, images, selectors, UIDs and Flux
inventory IDs are captured, then associated with their actual reviewed stopped
specifications. Original writer credentials and real write ticks are exercised;
the stop rotates to named versioned credentials and revokes the old role. The
legacy Kustomization has pruning disabled before inventory relinquishment. Helm
metadata is set through reviewed legacy manifests, without take-ownership,
force-conflicts or resource recreation. The script checks unchanged resource UIDs
and selectors and unchanged HelmRelease UID across staging/canonical rename.

The qualification producer executes the exact synthetic app migration wrapper
against actual PostgreSQL 17.4: a native role fence violation must fail; the safe
wrapper must succeed and make one durable idempotent effect under its advisory
lock. Its generated association records the actual positive/negative Job
identities, source/tree/lock/toolchain and runtime/chart/configuration identities.
The flag is derived from those executions, not accepted as operator input.

PostgreSQL uses a generated disposable CA and DNS SAN server certificate with
hostnossl rejection. App and fence connections use `sslmode=verify-full`. Real
plaintext, wrong-CA and wrong-SAN attempts must fail. The fence callback queries
fresh role/session facts through verified TLS and reads actual namespace
admission/network-policy objects; those objects and the database TLS identity are
bound before reporting zero writers. A finite fail-closed admission policy checks
controller identities, exact fixture commands, pinned images, rotated Secret refs
and bounded volumes. Unknown real Pods/controllers and forged owner references
must be denied; an impersonated dry-run with the wrong Secret must also fail.
This finite disposable fixture is not general production platform-fence approval.

Missing/stale fences, target UID mismatch, stale reviewed source revision and an
unreviewed field manager refuse advancement. Real rejecting bare-repository
pre-receive hooks hold staging/final publications; a new adapter rereads the
journal and takes fresh native fence observations before retry. These are fixture
server failures, not bypasses of this repository's hooks. The normal stopped →
migrate → verify → active sequence then uses actual Git CAS and Flux acknowledgements.
A continuous real HTTP sampler records primary 200 → identity-bound 503 → 200 and
static/legal 200 throughout. The static pod also has no token/credential env.

## Explicit remaining qualification limits

- Public Ingress HTTPS SAN/leaf checks, immutable reference rotation and correlated
  rollback are authored through the public TLS CLI. A temporary Cilium deny rule
  prevents only the ingress controller's API watches while allowing its backend
  traffic, so a valid new reference can be acknowledged by Flux/Helm while the
  controller serves its cached prior leaf. The runner must correlate that actual
  TLS mismatch, restore exact prior references and preserve every native runtime
  UID/Pod template. This scenario is **unqualified until the actual job succeeds**;
  no local helper test substitutes for that evidence.
- The fixture's migration ledger and finite admission policy demonstrate the
  exercise only; downstream durable application phase semantics and the owning
  platform's complete controller/credential fence still need their own evidence.
- All cluster scenarios must actually pass. Syntax/helper tests establish only
  authoring correctness and real local smart Git transport, not native adoption.

## Verified artifact provenance

Exact download URLs and SHA256s live in the exported `legacyArtifacts` constant.
Cilium and ingress chart checksums were independently matched to their official
repository indexes, and downloaded bytes matched those checksums. The Node full
Debian and PostgreSQL images are pinned to Linux amd64 platform manifests;
PostgreSQL's registry config confirms `PG_MAJOR=17`, `PG_VERSION=17.4`.

- [Official Kind v0.31.0 node image digest](https://github.com/kubernetes-sigs/kind/releases/tag/v0.31.0)
- [Official Kubernetes kubectl install/checksum procedure](https://kubernetes.io/docs/tasks/tools/install-kubectl-linux/)
- [Official Flux 2.6.4 manifest](https://github.com/fluxcd/flux2/releases/download/v2.6.4/install.yaml)
- [helm-controller 1.3.0 public API](https://github.com/fluxcd/helm-controller/blob/v1.3.0/api/v2/helmrelease_types.go)
- [Official Flux 2.8.8 manifest](https://github.com/fluxcd/flux2/releases/download/v2.8.8/install.yaml)
- [Cilium Kind installation](https://docs.cilium.io/en/stable/installation/kind/)
- [Cilium deny precedence](https://docs.cilium.io/en/stable/security/policy/deny/)
- [Cilium Kubernetes compatibility](https://docs.cilium.io/en/stable/network/kubernetes/compatibility/)
- [Official Cilium chart index](https://helm.cilium.io/index.yaml)
- [Official ingress-nginx chart index](https://kubernetes.github.io/ingress-nginx/index.yaml)
- [ingress-nginx supported versions](https://github.com/kubernetes/ingress-nginx#supported-versions-table)
- [Official Node full Debian Dockerfile](https://github.com/nodejs/docker-node/blob/main/26/bookworm/Dockerfile)
- [Git smart HTTP backend](https://git-scm.com/docs/git-http-backend)

Authoring checks:

```sh
node --check scripts/deployment-legacy-exercise.mjs
node --test scripts/deployment-legacy-exercise.test.mjs
actionlint .github/workflows/smrt-chart.yml
```

The job retains sanitized tool output, qualification execution identities,
continuity samples and a final receipt. Secrets/private keys stay in the deleted
fixture scratch directory and are excluded from retained evidence. Failures keep
sanitized diagnostics, never a manufactured successful receipt.
