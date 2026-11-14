## Replaces in the cookbook host

The later migration can replace these regions of
[host/design-runs.ts](../../template-sveltekit/host/design-runs.ts):

- `enqueue`: transactional job admission and dedupe configuration.
- `driver`: store construction, `authorizeWrite`, `authorizeRelease`,
  `ownsExecution` and common driver/job composition.
- `installDesignRunExecutor` bridge: authentic context/claim capture, target
  checks and abort-signal forwarding.
- `forOwner`: generic start/status/stop/resume and `resumeAfterApproval` plumbing,
  including verified stale-recovery re-admission.

Jobs' `getJobClaim` replaces the bridge's `SELECT worker_id` capture.
`assertJobClaim` replaces `authorizeWrite`'s conditional no-op update and
`ownsExecution`'s ownership SELECT. `assertJobClaimForRelease` replaces
`authorizeRelease`'s terminal-or-running conditional update. Host-specific
historical migrations still need their own migration policy and CAS.

The host retains schemas, pass/profile selection, owner/thread authorization,
approval decisions, effect replay, legacy migrations, latest-by-thread lookup,
proposal validation and presentation. `configure` adapts those existing callbacks.

Existing example-host runs lack the admission digest and authentic lease claim
metadata required here. Admission replay and orphan-lease recovery fail closed
without an explicit compatibility/migration policy; never reconstruct an old
claim from a later job row or hash mutable input as its original request.
