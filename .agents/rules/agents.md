---
description: Rules for @happyvertical/smrt-agents package
---

# Rules for `@happyvertical/smrt-agents`

These rules specifically target development occurring inside `packages/agents`.

## Dependency Mapping
- **Relies On**: `@happyvertical/smrt-core` (ORM logic), `@happyvertical/smrt-jobs` (Background processing), and the underlying AI SDK (`@happyvertical/ai`).
- **Required By**: Downstream agent runner applications (e.g., Reference SaaS).

## Execution Guardrails
- **Agent Memory**: State and contextual history mapping logic managed within this package should never implement locking mechanisms that could indefinitely halt the `TaskRunner` or inter-agent `DispatchBus`.
- **System Tables**: When altering the database representation for actors or task configurations within `package/agents/src/`, strictly adhere to the `_smrt_` prefixing pattern detailed in the global `CLAUDE.md`.
- **Testing Requirements**: Inter-agent messaging structures are brittle when schema adjustments occur. Ensure you verify payload integrity via `pnpm test` when modifying the `interest` discovery schemas or scheduling handlers.
