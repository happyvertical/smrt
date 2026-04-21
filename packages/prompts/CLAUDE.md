# prompts

SMRT prompt registry and tenant-aware prompt override package.

## Core pieces

- `definePrompt()` registers code defaults in a global process registry
- `resolvePrompt()` merges code defaults, config overrides, stored overrides, and a runtime override
- `PromptOverride` stores partial app-level and tenant-level overrides with write-time validation

## Conventions

- Prompt keys should be namespaced by package or domain, e.g. `projects.issue.incorporateFeedback`
- Stored overrides use nullable fields so inheritance stays field-by-field
- Provider selection is indirect in v1: prompts select named profiles, and profiles resolve to provider/model in config
- `editable` flags are enforced on `PromptOverride.save()` so invalid rows fail loudly
