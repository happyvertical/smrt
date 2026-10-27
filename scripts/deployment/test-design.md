# Release runner test design

Chart publication guard: `node --test scripts/deployment-chart-publication.test.mjs`.
Publication principal on repository Node; SQL/transactions N/A (registry metadata
reads only). Authenticated exact-version `MANIFEST_UNKNOWN`/`NAME_UNKNOWN` permits
publication; existing version, missing credentials, malformed/unknown/mixed errors,
auth/rate-limit/server/network failure and redirects block it. Token/body errors
are redacted. Tests verify protected workflow ordering and Helm build-metadata tag
mapping. Real workflow run 40354918465 reproduced the former org REST HTTP400;
its validation/exercise/teardown passed before publication failed. The scoped GHCR
guard uses the workflow token without an organization-wide package REST request.
Existing OCI indexes and Docker v2 manifests/lists must also refuse overwrite;
the lookup accepts all four supported media types to avoid false missing-manifest
responses caused by content negotiation.

All tests run with `node --test scripts/deployment-release.test.mjs`. Runtime: Node from root package.json; SQL dialect N/A (runner never executes SQL). Injectable command/observation adapters isolate external contracts; live Kubernetes exercise remains integration evidence, not asserted by unit tests.

| Behavior/invariant | Reachable trigger | Positive | Negative | Actor/context | Executor/transaction | Runtime/dialect | External edge | Level | Command |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Ordered durable phases | resume after every phase | one successor | stale phase/sequence | deployment service account | Git CAS one file | Node / no SQL | Flux acknowledged revision | unit | command above |
| Serialization | concurrent releases | unrelated commit preserved | same file changed / rejected push | Git deployment identity | normal fast-forward push | Node / no SQL | Git remote | unit | command above |
| Full preflight | begin maintenance | all rendered phases authorized | missing named Secret/admission/RBAC | namespace service account | server dry run, no persisted write | Node / no SQL | Helm/kubectl | unit + live integration pending | command above |
| Quiescence | stopped -> migrate | no actual writer Pods | terminating/unknown Pod, unsuspended cron/job | namespace isolated to app | read-only Kubernetes snapshot | Node / no SQL | Pods/controllers | unit | command above |
| Migration attempt | migrate resume | retained completed exact Job | failed/ambiguous Job | migration service account | durable app executor owns SQL atomicity | Node / SQL N/A here | Job status | unit | command above |
| Identity readiness | verify/active | exact images/endpoints/assertions | old image/UID/500/stale generation | runtime service account | observations only | Node / no SQL | Deployment/Pod/EndpointSlice/HTTP | unit | command above |
| Evidence bindings | each transition | stable immutable Secrets/config | changed/mutable Secret | deployment service account | UID/resourceVersion fingerprint | Node / no SQL | Kubernetes Secrets (metadata only) | unit | command above |
| Recovery | explicit recovery after failure | verify -> stopped, active -> maintenance | migration auto retry | authorized operator | Git phase CAS | Node / no SQL | retained failure evidence | unit | command above |
| Redaction | subprocess failure | safe operation name | stderr/credentials echoed | CLI operator | no secret logging | Node / no SQL | subprocess | unit | command above |

| Ownership and safe diagnostics | existing rendered name / failed live proof | exact Helm ownership and established controller manager, typed reason | unmanaged/foreign manager, unknown exception/stderr canary | reconciler impersonation + protected operator | server dry-run only, no forced ownership | Node / no SQL | Helm managedFields, admission, HTTP | unit + live integration | command above |

| Failed-attempt recovery and repair | explicit recover migrate / repair stopped | correlated terminal failed Job + safe stopped CAS, reviewed corrected target attempt++ | unrelated ReadyFalse, active Pod, stale revision, needs-repair ledger receipt | protected CI/operator + controller observation | Git CAS; app ledger reconciliation remains app executor | Node / SQL N/A in runner | Job/HR/CI validation evidence | unit + isolated SQL integration | command above |

| Corrective runtime repair | successful migrate then verify failure or active HTTP failure | required-repair marker, stopped repair target+attempt++, guarded migrate before verify | same-attempt resume, stale/mismatched runtime marker, unresolved ledger | protected app CI/operator | Git CAS only; durable ledger retained | Node / no SQL in runner | phase/revision/target binding | unit + disposable runtime integration | command above |

| New-release predecessor | publish a reviewed maintenance plan after active | healthy accepted exact identity/revision publishes once | unaccepted, unhealthy, stale identity/revision cannot preflight or write; unhealthy predecessor retains existing recovery | protected operator + live controller observation | Git CAS only after fresh predecessor proof | Node / no SQL | Flux/Helm/HTTP | unit adapter + CLI lifecycle | command above |

| Lost acceptance during proof | source moves after initial acknowledgement or during successful/failed HTTP | unchanged accepted health failure retains recovery path | lost acceptance throws before preflight/CAS for active automatic and verify explicit recovery | protected operator + namespace read identity | acknowledgement brackets successful and failed health proof | Node / no SQL | exact source revision + live HTTP boundary | unit live-adapter lifecycle | command above |

Chart 0.2.0 capability contract: chart rendering tests cover hardened runtime and
migration identity/scratch, fixed token/CA/downward projection, default-off and
runtime token rejection, missing explicit observer account, root IDs, unconfined
seccomp, added privileges/capabilities, host paths and credential-shadow mounts.
Runner tests cover matching observed Pods versus altered account/security/token
volumes and missing observer SA/CA/RBAC or Pod-create/admission permission before
maintenance. Actor is the runner/reconciler or dedicated observer in the release
namespace; boundary is Helm rendering, Kubernetes auth/admission and actual Pod
identity; unit tests use deterministic Kubernetes responses. Exact command:
`node --test scripts/deployment-chart.test.mjs scripts/deployment-release.test.mjs`.
Disposable exercise is the separate real-container execution gate for non-root,
seccomp, dropped capabilities, read-only root and scratch under real controllers.

Accepted independent-review regressions additionally cover omitted/default SA
normalization versus admission/live alternate accounts; SSA controller mutation
and jointly injected controller/Pod credential volumes on runtime, migration and
scheduled paths; and rendered maintenance-controller envelope drift. Pod escape
cases cover host ports, process-namespace sharing, pod/container unconfined
seccomp/AppArmor and unsupported SELinux. `hostUsers` omitted/true is the semantic
Kubernetes default, with explicit false-to-true drift separately refused.
