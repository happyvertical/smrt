---
type: "Component"
title: "@happyvertical/smrt-features"
description: "Code-first feature flags and tenant-aware overrides for the SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-08T21:55:57Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:11a8e0fecb6968f5ae69661d85e39f0c802292cb4e77dd2a78b26d6d6a71eb74"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/features/package.json"
    title: "@happyvertical/smrt-features package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/features/AGENTS.md"
    title: "@happyvertical/smrt-features packages/features/AGENTS.md"
---

# @happyvertical/smrt-features

## Package

- Directory: `packages/features`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/features/AGENTS.md`

## Framework dependencies

- [smrt-cli](/components/smrt-cli.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-users](/components/smrt-users.md)
- [smrt-vitest](/components/smrt-vitest.md)

## Exports

- `.`
- `./manifest`
- `./manifest.json`
- `./svelte`

## Models

- `FeatureDefinition` (collection `featuredefinitions`, extends `SmrtObject`)
- `FeatureDefinitionCollection` (collection `featuredefinitions`, extends `SmrtCollection`)
- `FeatureOverride` (collection `featureoverrides`, extends `SmrtObject`)
- `FeatureOverrideCollection` (collection `featureoverrides`, extends `SmrtCollection`)
