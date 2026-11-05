---
type: Capability
title: "Scheduled and recurring runs"
description: "Reach for the smrt-jobs ScheduleRunner and smrt-agents AgentSchedule before writing a cron loop or setInterval poller."
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
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/jobs/src/schedule-runner.ts
    path: packages/jobs/src/schedule-runner.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/jobs/src/schedule-runner.ts (ScheduleRunner.triggerSchedule, validateCronExpression, getNextCronDate)"
  - id: s2
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/agents/src/schedule.ts
    path: packages/agents/src/schedule.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/agents/src/schedule.ts (AgentSchedule, getNextCronDate import)"
  - id: s3
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/jobs/src/index.ts
    path: packages/jobs/src/index.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/jobs/src/index.ts (ScheduleRunner, SCHEDULED_JOB_QUEUE exports)"
---

# Scheduled and recurring runs

# Entry point

Schedules are rows, not code. Define an `AgentSchedule` (`@happyvertical/smrt-agents`: agent type, method, args, 5-field `cron`, IANA `timezone`, optional `tenantId`) and run one `ScheduleRunner` (`createScheduleRunner()` from `@happyvertical/smrt-jobs`). Each due schedule is turned into a `SmrtJob` on the `SCHEDULED_JOB_QUEUE`, so a scheduled run gets the same retries, tenant cap and recovery as any other background job (see [background-work](/intents/background-work.md)). `validateCronExpression()` and `getNextCronDate()` are exported for write-time validation.[^s3]

# Why not hand-roll it

`ScheduleRunner.triggerSchedule()` in `schedule-runner.ts` validates the cron and time zone first and moves a schedule with an invalid expression to `status = 'error'` instead of retrying it on every poll; it then enqueues the job before advancing `next_run`, so a transient failure (a tenant-cap hit, a database blip) leaves the due slot to be retried rather than silently losing the run (#1401), and it enqueues through `enqueueJob` so the per-tenant cap and retry ceiling apply (#1402).[^s1] Cron is evaluated in the row's IANA zone with UTC as the default, never the host process zone (#3859).[^s1] `AgentSchedule.calculateNextRun()` imports `getNextCronDate` from smrt-jobs so the model and the runner cannot compute different next-run times.[^s2] A hand-written `setInterval` loop has none of this.

# Component pages

- [smrt-jobs](/components/smrt-jobs.md)
- [smrt-agents](/components/smrt-agents.md)

# Detection signals

- `import:node-cron`
- `import:cron`
- `import:node-schedule`
- `import:agenda`
- `import:croner`
- `call:setInterval`
- `regex:cron\.schedule\(`

[^s1]: `packages/jobs/src/schedule-runner.ts` at `478ae36900`: ScheduleRunner.triggerSchedule, validateCronExpression, getNextCronDate.
[^s2]: `packages/agents/src/schedule.ts` at `478ae36900`: AgentSchedule, getNextCronDate import.
[^s3]: `packages/jobs/src/index.ts` at `478ae36900`: ScheduleRunner, SCHEDULED_JOB_QUEUE exports.
