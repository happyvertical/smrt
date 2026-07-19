# @happyvertical/smrt-support

AI-first, tenant-scoped Support Cases with channel-neutral intake, guarded lifecycle transitions, human handoff, project-qualified routing, service targets, and auditable service time.

## Installation

```bash
pnpm add @happyvertical/smrt-support
```

## Main APIs

- `SupportIntakeService` creates or joins one canonical case from bound chat or email channels.
- `SupportCaseService` owns interactions, lifecycle, assignment, resolution, reopen history, and linked delivery work.
- `SupportAiWorkflow` applies conservative support policy and records every automated phase.
- Routing and service-target services schedule escalation and preserve audit evidence.
- `@happyvertical/smrt-support/svelte` exports reusable queue, detail, routing, target, and time-approval surfaces.

Case-side generated APIs are read-only; writes go through service facades so tenancy, idempotency, and lifecycle guards cannot be bypassed.

## Validation

```bash
pnpm --filter @happyvertical/smrt-support test
pnpm --filter @happyvertical/smrt-support typecheck
```
