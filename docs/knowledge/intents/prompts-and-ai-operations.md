---
type: Capability
title: "Prompts and AI operations"
description: "Register prompts with smrt-prompts and expose AI-callable operations through @smrt({ ai }) instead of inline prompt strings and ad-hoc LLM clients."
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
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/prompts/src/models/PromptOverride.ts
    path: packages/prompts/src/models/PromptOverride.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/prompts/src/models/PromptOverride.ts (PromptOverride.validatePromptOverride)"
  - id: s2
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/prompts/src/prompt-override-service.ts
    path: packages/prompts/src/prompt-override-service.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/prompts/src/prompt-override-service.ts (assertValidPromptScope, InvalidPromptScopeError)"
  - id: s3
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/prompts/src/prompt-resolver.ts
    path: packages/prompts/src/prompt-resolver.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/prompts/src/prompt-resolver.ts (resolvePrompt)"
  - id: s4
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/agents/src/ai-config.ts
    path: packages/agents/src/ai-config.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/agents/src/ai-config.ts (resolveAgentAIOptions)"
  - id: s5
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/core/src/registry/types.ts
    path: packages/core/src/registry/types.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/core/src/registry/types.ts (SmrtClassOptions.ai)"
---

# Prompts and AI operations

# Entry point

Prompts: `definePrompt({ key, template, ai })` registers a namespaced code default; `await resolvePrompt(key, { override })` returns the effective template, profile, model and params after layering code default, config file, app override, tenant override and runtime override field by field. Writes go through `PromptOverrideService` with a host-supplied authorizer; a management screen uses `PromptSettingsService`. AI operations on models: `@smrt({ ai: { callable: ['analyze'] } })` chooses which methods an AI may call, and `SmrtObject` provides `is()`, `do()` and `describe()`. Agents resolve per-tenant provider keys with `resolveAgentAIOptions()` (smrt-agents).[^s3][^s5]

# Why not hand-roll it

`PromptOverride` validates on save in `PromptOverride.ts` that the prompt key is registered and that no field the definition marks not editable is overridden, so a tenant cannot override a locked template or model.[^s1] `assertValidPromptScope()` in `prompt-override-service.ts` rejects an unknown scope type, an app id other than the app scope constant and blank or untrimmed tenant ids before the authorizer runs, so a malformed tenant write cannot land on the app-wide row, and every write fails closed without a `true` from the authorizer.[^s2] `resolveAgentAIOptions()` takes the provider key from `SecretService` for the current tenant with ancestor-tenant fallback by default, instead of reading one global environment key.[^s4] An inline prompt string has no override layering, no authorization of edits and no key management.

# Component pages

- [smrt-prompts](/components/smrt-prompts.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-agents](/components/smrt-agents.md)

# Detection signals

- `import:openai`
- `import:@anthropic-ai/sdk`
- `import:langchain`
- `regex:You are an? [a-z ]+`
- `regex:role:\s*['"]system['"]`

[^s1]: `packages/prompts/src/models/PromptOverride.ts` at `478ae36900`: PromptOverride.validatePromptOverride.
[^s2]: `packages/prompts/src/prompt-override-service.ts` at `478ae36900`: assertValidPromptScope, InvalidPromptScopeError.
[^s3]: `packages/prompts/src/prompt-resolver.ts` at `478ae36900`: resolvePrompt.
[^s4]: `packages/agents/src/ai-config.ts` at `478ae36900`: resolveAgentAIOptions.
[^s5]: `packages/core/src/registry/types.ts` at `478ae36900`: SmrtClassOptions.ai.
