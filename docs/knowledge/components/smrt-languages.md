---
type: "Component"
title: "@happyvertical/smrt-languages"
description: "Code-first language strings with config + tenant overrides and AI auto-translation for SMRT"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-08T19:39:45Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:d7569adcbc2800a2632c4168d851b886560c4dbd04d2b852f4f6ef1aac17623c"
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
- Object source: `scanner`
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
- `LanguageTranslationTask` (collection `languagetranslationtasks`, extends `SmrtObject`)
