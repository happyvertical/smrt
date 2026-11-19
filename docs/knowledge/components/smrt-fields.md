---
type: "Component"
title: "@happyvertical/smrt-fields"
description: "Layered field policy store and resolver (defaults, visibility tiers, help text) for SMRT objects"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-19T13:59:13Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:e9f5f629f29986c91e9d4d62531c385ecc1e783e5f21ff1321de2cff9d1a3a0e"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/fields/package.json"
    title: "@happyvertical/smrt-fields package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/fields/AGENTS.md"
    title: "@happyvertical/smrt-fields packages/fields/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/fields/agents/cookbook-policy.md"
    title: "@happyvertical/smrt-fields packages/fields/agents/cookbook-policy.md"
---

# @happyvertical/smrt-fields

## Package

- Directory: `packages/fields`
- Private: no
- Object source: `scanner`
- Evidence level: `source-inspected`

## Documentation

- `packages/fields/AGENTS.md`
- `packages/fields/agents/cookbook-policy.md`

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
- `./policy`
- `./svelte`

## Models

- `FieldPolicy` (collection `fieldpolicies`, extends `SmrtObject`)
- `FieldPolicyCollection` (collection `fieldpolicycollections`, extends `SmrtCollection`)
- `FieldPolicySuggestion` (collection `fieldpolicysuggestions`, extends `SmrtObject`)
- `FieldPolicySuggestionCollection` (collection `fieldpolicysuggestioncollections`, extends `SmrtCollection`)
- `FieldUsageCounter` (collection `fieldusagecounters`, extends `SmrtObject`)
- `FieldUsageCounterCollection` (collection `fieldusagecountercollections`, extends `SmrtCollection`)
- `FieldUsageLearningAgent` (collection `fieldusagelearningagents`, extends `SmrtObject`)
- `FieldUsageReportReceipt` (collection `fieldusagereportreceipts`, extends `SmrtObject`)
- `FieldUsageReportReceiptCollection` (collection `fieldusagereportreceiptcollections`, extends `SmrtCollection`)
