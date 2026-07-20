# @happyvertical/smrt-personas

Tenant-owned, context-scoped agent personas for s-m-r-t. A `TenantAgent` decides
whether an agent may run and caps its capabilities; a persona decides how that
agent behaves for a tenant and context—its instructions, tools, acting identity,
principal, memory scope, and priority.

The package also provides a gated learning loop: feedback reinforces memory,
reflection creates pending directive proposals, and a human-authorized approval
service activates instruction changes.

## Installation

```bash
pnpm add @happyvertical/smrt-personas
```

Add `svelte` when consuming the optional directive-review UI.

## Quick start

```ts
import {
  AgentPersonaCollection,
  PersonaResolver,
} from '@happyvertical/smrt-personas';
import { withTenant } from '@happyvertical/smrt-tenancy';

const personas = await AgentPersonaCollection.create({ db: 'app.db' });

await withTenant({ tenantId: 'tenant-1' }, async () => {
  const editor = await personas.create({
    tenantId: 'tenant-1',
    agentClass: '@acme/agents:EditorAgent',
    name: 'newsroom-editor',
    contextType: 'site',
    contextId: 'site-42',
    instructions: 'Prefer local sources and concise summaries.',
    priority: 100,
  });
  editor.setAllowedTools(['facts.search', 'content.update']);
  await editor.save();
});

const resolved = await new PersonaResolver(personas).resolve(
  'tenant-1',
  '@acme/agents:EditorAgent',
  { contextType: 'site', contextId: 'site-42' },
);
```

Resolution prefers exact context over context type over tenant default, then
higher priority. The nearest tenant level with an applicable persona shadows
farther ancestors.

## Layering model

```text
manifest defaults
    → TenantAgent availability and tool ceiling
        → nearest applicable AgentPersona
            → resolved instructions, tools, identity, and memory scope
```

Hierarchy resolution intentionally reads ancestor-tenant personas. Run it from
a reviewed system/admin path rather than inside a strict tenant interceptor
that forbids cross-tenant reads.

## Learning and directive approval

1. `Feedback` records a human or autonomous outcome with a correlation ID.
2. `reinforceFromFeedback()` updates persona-scoped learning memory.
3. `ReflectionRunner` turns evidence into a pending `DirectiveProposal`.
4. `DirectiveApprovalService` requires `personas.activate-directive` before an
   approved rewrite becomes a tenant/persona-scoped prompt override.

Autonomous reflection can propose but cannot activate instructions. Confidence
reinforcement is automatic; instruction changes are permission-gated.

## Durable agent instances

Personas can also identify independently scheduled instances of a multi-instance
agent. `schedulePersonaInstance()`, `buildPersonaInstanceAdmin()`, and
`upgradeSingletonToDefaultPersona()` preserve singleton identity while enabling
per-persona schedules, memory, and administration.

## Public entry points

| Entry point | Purpose |
| --- | --- |
| `@happyvertical/smrt-personas` | Models, resolver, learning loop, approval services |
| `@happyvertical/smrt-personas/svelte` | Presentational `DirectiveReviewQueue` |

## Related packages

- [`smrt-agents`](../agents/README.md) owns availability, scheduling, and agent
  lifecycle.
- [`smrt-prompts`](../prompts/README.md) stores activated instruction overrides.
- [`smrt-users`](../users/README.md) supplies permission resolution and run-as
  principals.
- [`smrt-messages`](../messages/README.md) supplies the fixed persona messaging
  tool boundary.

## Development

```bash
pnpm --filter @happyvertical/smrt-personas test
pnpm --filter @happyvertical/smrt-personas typecheck
pnpm --filter @happyvertical/smrt-personas build
```

See [`AGENTS.md`](./AGENTS.md) for resolver, memory, tenancy, and permission
invariants.
