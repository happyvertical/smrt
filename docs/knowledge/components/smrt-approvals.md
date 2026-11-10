---
type: "Component"
title: "@happyvertical/smrt-approvals"
description: "Approval decision gate for the SMRT framework: revision-bound, single-use approvals with quorum, expiry, and an append-only event ledger"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-05T15:48:19Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:0bacde778f71bde01a3ac42abcfa0970ba95c54bd33368d05ed60dc4bef4054d"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/approvals/package.json"
    title: "@happyvertical/smrt-approvals package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/approvals/AGENTS.md"
    title: "@happyvertical/smrt-approvals packages/approvals/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/approvals/agents/approvals.md"
    title: "@happyvertical/smrt-approvals packages/approvals/agents/approvals.md"
---

# @happyvertical/smrt-approvals

## Package

- Directory: `packages/approvals`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/approvals/AGENTS.md`
- `packages/approvals/agents/approvals.md`

## Framework dependencies

- [smrt-core](/components/smrt-core.md)
- [smrt-scanner](/components/smrt-scanner.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-types](/components/smrt-types.md)
- [smrt-users](/components/smrt-users.md)
- [smrt-vitest](/components/smrt-vitest.md)

## SDK dependencies

- `@happyvertical/sql`

## Exports

- `.`
- `./manifest`
- `./manifest.json`

## Models

- `ApprovalEvent` (collection `approvalevents`, extends `SmrtObject`)
- `ApprovalEventCollection` (collection `approvalevents`, extends `SmrtCollection`)
- `ApprovalPolicy` (collection `approvalpolicies`, extends `SmrtObject`)
- `ApprovalPolicyCollection` (collection `approvalpolicies`, extends `SmrtCollection`)
- `ApprovalRequest` (collection `approvalrequests`, extends `SmrtObject`)
- `ApprovalRequestCollection` (collection `approvalrequests`, extends `SmrtCollection`)

## MCP tools

- `approvalevent_get`: get on `@happyvertical/smrt-approvals:ApprovalEvent`
- `approvalevent_list`: list on `@happyvertical/smrt-approvals:ApprovalEvent`
- `approvalpolicy_get`: get on `@happyvertical/smrt-approvals:ApprovalPolicy`
- `approvalpolicy_list`: list on `@happyvertical/smrt-approvals:ApprovalPolicy`
- `approvalrequest_get`: get on `@happyvertical/smrt-approvals:ApprovalRequest`
- `approvalrequest_list`: list on `@happyvertical/smrt-approvals:ApprovalRequest`
