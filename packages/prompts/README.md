# @happyvertical/smrt-prompts

Typed prompt definitions, tenant-aware prompt overrides, and runtime prompt
resolution for SMRT applications.

This package provides:

- `definePrompt()` for code-first prompt registration
- `resolvePrompt()` for layered prompt resolution
- `PromptOverride` CRUD models for app-level and tenant-level prompt settings
- named AI profiles loaded from `packages.prompts` config

Stored overrides support partial fields, so applications can override only the
template, profile, model, or AI params without forking the rest of a prompt.
