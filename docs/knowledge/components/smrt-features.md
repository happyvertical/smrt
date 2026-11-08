---
type: "Component"
title: "@happyvertical/smrt-features"
description: "Code-first feature flags and tenant-aware overrides for the SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-08T15:00:30Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:cc0d83f83d96991b2328fb426f0a52ca17a6d9051471d3c1e0d8070370f4cfd1"
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
