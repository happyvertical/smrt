---
type: "Component"
title: "@happyvertical/smrt-fields"
description: "Layered field policy store and resolver (defaults, visibility tiers, help text) for SMRT objects"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T01:55:44Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:b5da9360239e879f176aecf30b728ff2f2e63236b0174e5a79d9544d4518b0a8"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/fields/package.json"
    title: "@happyvertical/smrt-fields package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/fields/AGENTS.md"
    title: "@happyvertical/smrt-fields packages/fields/AGENTS.md"
---

# @happyvertical/smrt-fields

## Package

- Directory: `packages/fields`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/fields/AGENTS.md`

## Framework dependencies

- [smrt-cli](/components/smrt-cli.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-scanner](/components/smrt-scanner.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-users](/components/smrt-users.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/sql`

## Exports

- `.`
- `./manifest`
- `./manifest.json`
- `./playground`
- `./svelte`

## Models

- `FieldPolicy` (collection `fieldpolicies`, extends `SmrtObject`)
- `FieldPolicyCollection` (collection `fieldpolicies`, extends `SmrtCollection`)
- `FieldPolicySuggestion` (collection `fieldpolicysuggestions`, extends `SmrtObject`)
- `FieldPolicySuggestionCollection` (collection `fieldpolicysuggestions`, extends `SmrtCollection`)
- `FieldUsageCounter` (collection `fieldusagecounters`, extends `SmrtObject`)
- `FieldUsageCounterCollection` (collection `fieldusagecounters`, extends `SmrtCollection`)
- `FieldUsageLearningAgent` (collection `fieldusagelearningagents`, extends `SmrtObject`)
- `FieldUsageReportReceipt` (collection `fieldusagereportreceipts`, extends `SmrtObject`)
- `FieldUsageReportReceiptCollection` (collection `fieldusagereportreceipts`, extends `SmrtCollection`)
