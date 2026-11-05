---
type: "Component"
title: "@happyvertical/smrt-features"
description: "Code-first feature flags and tenant-aware overrides for the SMRT framework"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T14:34:22Z"
audience: "internal"
evidence_level: "source-inspected"
package_version: "0.60.8"
source_revision: "sha256:980c9ffa21a4ddd92030f2729b4dc47da4765ed89afe675e8193d464e72c9a7b"
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

- Version: `0.60.8`
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
