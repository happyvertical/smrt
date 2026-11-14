# smrt-design-runs

Server-only glue between inference's durable design driver/store and jobs'
TaskRunner. `src/index.ts` exports `createDesignRunJobs`, owner bindings,
snapshot/start/options types and informational `PACKAGE_NAME`. No models, tables,
UI, engine selection, product schemas or application effects belong here.

- Hosts supply `kind`, versioned `definition`, authorization and `configure`.
  Reconstruct passes and engine/resource adapters from durable input on restart.
- Start derives a UUID from kind/owner/tenant/key, then uses inference's insert
  CAS and transactional enqueue. Dedupe keys use that run ID, never package names.
- Job handlers accept authentic runner contexts only. Capture `getJobClaim` once;
  use jobs' public transaction-bound assertions for checkpoint and settled-lease
  release. No `_smrt_jobs` SQL here, including tests; mutate jobs through public
  APIs when simulating a stolen claim.
- `install()` occupies inference's one executor slot for the DB. Multi-kind hosts
  install their own router once and dispatch each saved kind to `handler`.
- `forOwner` must use an authenticated principal. Authorization reruns on every
  operation and job invocation. Driver resource/check callbacks retain host policy.
- Cancel delegates to inference's resumable Stop (#4995), then cancels the backing
  job and signals local execution. A retained inference lease blocks resume until
  the original promise settles; never clear it merely because a timeout expired.
- Only authoritative `stale-recovery` of the exact failed job/attempt permits
  resume of a running/checking checkpoint with a retained lease. Checkpoint CAS
  and re-admission share a transaction; the replacement job claim authorizes replay.
- Hosts persist approval decisions using their own approval service, then call
  `continueAfterApproval`. Checks replay that decision; effects must be idempotent.

Validate with package `build`, `typecheck`, `test`. Tests use real TaskRunner and
in-process SQLite with fake pass execution and Ajv; no containers or model calls.
