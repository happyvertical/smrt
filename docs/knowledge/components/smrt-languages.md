---
type: "Component"
title: "@happyvertical/smrt-languages"
description: "Code-first language strings with config + tenant overrides and AI auto-translation for SMRT"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T14:34:22Z"
audience: "internal"
evidence_level: "source-inspected"
package_version: "0.60.8"
source_revision: "sha256:ce82aa953f2d8e0200385ff1332bf0c82c57cbdce7080f6bdd99403c5a7c7525"
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

- Version: `0.60.8`
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
