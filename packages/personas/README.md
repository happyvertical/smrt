# @happyvertical/smrt-personas

Tenant-owned, context-scoped agent personas, learning feedback, reflection proposals, and permission-gated directive activation.

## Installation

```bash
pnpm add @happyvertical/smrt-personas
```

## Main APIs

- `AgentPersona` and `AgentPersonaCollection` store per-tenant behavioral profiles.
- `PersonaResolver` layers manifest defaults, the `TenantAgent` availability ceiling, and the most specific enabled persona.
- `Feedback` and `LearningMemory` capture confidence-scored outcomes.
- `ReflectionRunner` creates reviewable `DirectiveProposal` records.
- `DirectiveApprovalService` activates approved instructions only for principals with `personas.activate-directive`.
- `@happyvertical/smrt-personas/svelte` exports the presentational review queue.

## Validation

```bash
pnpm --filter @happyvertical/smrt-personas test
pnpm --filter @happyvertical/smrt-personas typecheck
```
