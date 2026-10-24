# Release runner test design

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
