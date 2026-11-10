---
type: Capability
title: "Background work and retries"
description: "Reach for smrt-jobs before writing a queue, worker loop, retry counter or job table."
tags:
  - smrt
  - intent
status: draft
generated:
  by: claude/smrt-4687
  at: 2026-11-05T00:00:00Z
stale_after: 2027-02-03T00:00:00Z
audience: internal
evidence_level: source-inspected
package_version: 0.60.8
sources:
  - id: s1
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/jobs/src/smrt-job.ts
    path: packages/jobs/src/smrt-job.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/jobs/src/smrt-job.ts (SmrtJobCollection.claimReady)"
  - id: s2
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/jobs/src/background-policy.ts
    path: packages/jobs/src/background-policy.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/jobs/src/background-policy.ts (MAX_JOB_RETRIES, DEFAULT_TENANT_JOB_CAP, clampRetries)"
  - id: s3
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/jobs/src/stale-recovery.ts
    path: packages/jobs/src/stale-recovery.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/jobs/src/stale-recovery.ts (DEFAULT_LEASE_TTL_MS, getEffectiveLeaseTtlMs)"
  - id: s4
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/jobs/src/object-extension.ts
    path: packages/jobs/src/object-extension.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/jobs/src/object-extension.ts (withBackgroundJobs, BackgroundCapable, BgOptions)"
  - id: s5
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/jobs/src/index.ts
    path: packages/jobs/src/index.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/jobs/src/index.ts (public exports)"
---

# Background work and retries

# Entry point

Import from `@happyvertical/smrt-jobs`. `withBackgroundJobs(Class)` adds `bg(method, args, { delay, retries, priority, queue, timeout })` and a fluent `background(method, args).delay('5m').retries(5).priority('high').enqueue()` to a SmrtObject class; both return a `JobHandle` and persist a `SmrtJob` row. Workers are a `TaskRunner` (`createTaskRunner()`); job progress and events go through `JobContext` and `SmrtJobEvent`. Mark which methods a persisted job may invoke with `backgroundEligible`/`markBackgroundEligible`.[^s4][^s5]

# Why not hand-roll it

A quick queue over a table usually claims work with a SELECT followed by an UPDATE, which lets two workers take the same row. `SmrtJobCollection.claimReady()` in `smrt-job.ts` claims in one conditional UPDATE so concurrent workers cannot receive the same pending row and never claim more than `limit` rows; on PostgreSQL it selects candidates in a `MATERIALIZED` CTE because the earlier `IN (SELECT ... FOR UPDATE SKIP LOCKED)` form let a single claim take the whole backlog (#3145).[^s1] `background-policy.ts` clamps a requested retry count to `MAX_JOB_RETRIES` (25) so a poison job cannot pin a worker, and `assertWithinTenantCreationCap` bounds a tenant to `DEFAULT_TENANT_JOB_CAP` (10,000) non-terminal jobs so one tenant cannot starve the shared pool.[^s2] A crashed worker's `running` jobs are recovered by worker liveness leases (`DEFAULT_LEASE_TTL_MS` 30 s, never fewer than three renewal ticks), not by per-job heartbeats.[^s3]

# Component pages

- [smrt-jobs](/components/smrt-jobs.md)
- [smrt-core](/components/smrt-core.md)

# Detection signals

- `import:bullmq`
- `import:bull`
- `import:bee-queue`
- `import:pg-boss`
- `import:kue`
- `regex:FOR UPDATE SKIP LOCKED`

[^s1]: `packages/jobs/src/smrt-job.ts` at `478ae36900`: SmrtJobCollection.claimReady.
[^s2]: `packages/jobs/src/background-policy.ts` at `478ae36900`: MAX_JOB_RETRIES, DEFAULT_TENANT_JOB_CAP, clampRetries.
[^s3]: `packages/jobs/src/stale-recovery.ts` at `478ae36900`: DEFAULT_LEASE_TTL_MS, getEffectiveLeaseTtlMs.
[^s4]: `packages/jobs/src/object-extension.ts` at `478ae36900`: withBackgroundJobs, BackgroundCapable, BgOptions.
[^s5]: `packages/jobs/src/index.ts` at `478ae36900`: public exports.
