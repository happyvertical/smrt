# @happyvertical/smrt-playbooks

Layered playbook definitions, tenant-aware overrides, and plan resolution for
s-m-r-t agents.

A playbook is a named, described sequence of steps an agent follows. It gives a
multi-step intent — "check out this cart" — a home that is neither a custom
model action nor a view intent, and browser agents, in-app agents, the Node MCP
server, and the CLI all follow the same resolved plan.

## Installation

```bash
pnpm add @happyvertical/smrt-playbooks
```

## Quick start

```typescript
import { definePlaybook, resolvePlaybook } from '@happyvertical/smrt-playbooks';

// 1. Register a playbook's defaults at startup
definePlaybook({
  key: 'commerce.cart.checkout',
  title: 'Check out this cart',
  description: 'Submits the order and captures payment.',
  steps: [
    {
      kind: 'operation',
      model: '@happyvertical/smrt-commerce:Order',
      action: 'submit',
    },
    {
      kind: 'operation',
      model: '@happyvertical/smrt-commerce:Payment',
      action: 'capture',
    },
  ],
  onStepFailure: 'abort',
});

// 2. Resolve a plan for a caller on a plane
const resolution = await resolvePlaybook('commerce.cart.checkout', {
  db,
  plane: 'server',
});

if (!resolution.ok) {
  // Fails closed with a specific reason: unknown-playbook, disabled,
  // plane-not-declared, intent-registry-unavailable, unknown-intent.
  throw new Error(resolution.message);
}

for (const step of resolution.plan.steps) {
  // The agent executes each step itself; this package never does.
  // step.classification is inherited from the referenced operation.
}
```

## What this package provides

- **`definePlaybook()`** — code-first playbook registration in a global process
  registry, so a package ships its own playbooks
- **`resolvePlaybook()`** — layered resolution: code default → config override →
  stored app override → stored tenant override → runtime override
- **`PlaybookOverride`** — CRUD model for app-level and tenant-level playbook
  settings, stored in `_smrt_playbook_overrides`
- **Plane validity** — a playbook declares `browser`, `server`, or both, and
  resolution on an undeclared plane fails closed
- **TTL cache** keyed by `(key, tenantId)`, invalidated on override save/delete

## Guarantees

- **A playbook is a script, never a call.** Resolution returns a plan; nothing
  here executes a step. A playbook is therefore never an authority boundary —
  each step is authorized independently where it runs.
- **Step lists are never editable.** No override layer, including a direct
  model write, can change a playbook's steps. An agent's description of what it
  is about to do always matches the steps it will follow.
- **Enablement narrows only.** A tenant may disable a playbook; it can never
  enable one a lower layer disabled.
- **Undeclared classification fails closed** to
  `{ effect: 'destructive', idempotent: false, openWorld: true }`. Steps never
  classify themselves; classification is inherited from the referenced
  operation.

## Documentation

- See [`AGENTS.md`](./AGENTS.md) for package-internal patterns
- See [`docs/content/standards.md`](../../docs/content/standards.md) for
  monorepo conventions
- See related: [`@happyvertical/smrt-prompts`](../prompts) (the layered-override
  pattern this package mirrors),
  [`@happyvertical/smrt-languages`](../languages),
  [`@happyvertical/smrt-features`](../features)
