---
type: "Component"
title: "@happyvertical/smrt-languages"
description: "Code-first language strings with config + tenant overrides and AI auto-translation for SMRT"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-08T08:52:15Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:b96c06893e47b251d531646b9d2c2dd9147eccca865cf1800b790bdb21d78aa5"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/languages/package.json"
    title: "@happyvertical/smrt-languages package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/languages/AGENTS.md"
    title: "@happyvertical/smrt-languages packages/languages/AGENTS.md"
---

# @happyvertical/smrt-languages

## Package

- Directory: `packages/languages`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/languages/AGENTS.md`

## Framework dependencies

- [smrt-cli](/components/smrt-cli.md)
- [smrt-config](/components/smrt-config.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-features](/components/smrt-features.md)
- [smrt-jobs](/components/smrt-jobs.md)
- [smrt-prompts](/components/smrt-prompts.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/ai`
- `@happyvertical/logger`
- `@happyvertical/sql`

## Exports

- `.`
- `./cli`
- `./jobs`
- `./manifest`
- `./manifest.json`

## Models

- `LanguageOverride` (collection `languageoverrides`, extends `SmrtObject`)
- `LanguageOverrideCollection` (collection `languageoverrides`, extends `SmrtCollection`)
- `LanguageTranslationTask` (collection `languagetranslationtasks`, extends `SmrtObject`)
