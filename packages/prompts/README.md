# @happyvertical/smrt-prompts

Typed prompt definitions, tenant-aware prompt overrides, and runtime prompt resolution for SMRT applications.

## Installation

```bash
pnpm add @happyvertical/smrt-prompts
```

## Quick start

```typescript
import { definePrompt, resolvePrompt } from '@happyvertical/smrt-prompts';

// 1. Register a prompt's defaults at startup
definePrompt({
  key: 'projects.issue.incorporateFeedback',
  template: 'Rewrite the issue body incorporating this feedback: {feedback}',
  ai: {
    profile: 'default',
    params: { temperature: 0.4 },
  },
});

// 2. Resolve at runtime (auto-uses tenant context from AsyncLocalStorage)
const resolved = await resolvePrompt('projects.issue.incorporateFeedback', {
  vars: { feedback: '...' },
});

// resolved.template — the merged template with overrides applied
// resolved.ai     — the merged AI configuration (profile, model, params)
```

## What this package provides

- **`definePrompt()`** — code-first prompt registration in a global process registry
- **`resolvePrompt()`** — layered resolution: code default → config override → stored app override → stored tenant override → runtime override
- **`PromptOverride`** — CRUD model for app-level and tenant-level prompt settings, stored in `_smrt_prompt_overrides`
- **Named AI profiles** loaded from `packages.prompts` config — prompts select profile names, profiles resolve to provider/model in config
- **TTL cache** keyed by `(key, tenantId)`, invalidated on override save/delete

Stored overrides support partial fields, so applications can override only the template, profile, model, or AI params without forking the rest of a prompt.

## Documentation

- See [`AGENTS.md`](./AGENTS.md) for package-internal patterns
- See [`docs/standards.md`](../../docs/standards.md) for monorepo conventions
- See related: [`@happyvertical/smrt-languages`](../languages) (mirrors this package for language strings), [`@happyvertical/smrt-features`](../features) (feature flags)
