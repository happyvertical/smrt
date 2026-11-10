---
type: "Component"
title: "@happyvertical/smrt-approvals"
description: "Approval decision gate for the SMRT framework: revision-bound, single-use approvals with quorum, expiry, and an append-only event ledger"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T02:12:11Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:bf37937a5368b4d154d06454f975a75ebcedc5ba393c36d1aa67973fcb211da7"
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
- Object source: `scanner`
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
- `ApprovalEventCollection` (collection `approvaleventcollections`, extends `SmrtCollection`)
- `ApprovalPolicy` (collection `approvalpolicies`, extends `SmrtObject`)
- `ApprovalPolicyCollection` (collection `approvalpolicycollections`, extends `SmrtCollection`)
- `ApprovalRequest` (collection `approvalrequests`, extends `SmrtObject`)
- `ApprovalRequestCollection` (collection `approvalrequestcollections`, extends `SmrtCollection`)

## MCP tools

- `get_approvaleventcollections`: get on `@happyvertical/smrt-approvals:ApprovalEventCollection`
- `get_approvalevents`: get on `@happyvertical/smrt-approvals:ApprovalEvent`
- `get_approvalpolicies`: get on `@happyvertical/smrt-approvals:ApprovalPolicy`
- `get_approvalpolicycollections`: get on `@happyvertical/smrt-approvals:ApprovalPolicyCollection`
- `get_approvalrequestcollections`: get on `@happyvertical/smrt-approvals:ApprovalRequestCollection`
- `get_approvalrequests`: get on `@happyvertical/smrt-approvals:ApprovalRequest`
- `list_approvaleventcollections`: list on `@happyvertical/smrt-approvals:ApprovalEventCollection`
- `list_approvalevents`: list on `@happyvertical/smrt-approvals:ApprovalEvent`
- `list_approvalpolicies`: list on `@happyvertical/smrt-approvals:ApprovalPolicy`
- `list_approvalpolicycollections`: list on `@happyvertical/smrt-approvals:ApprovalPolicyCollection`
- `list_approvalrequestcollections`: list on `@happyvertical/smrt-approvals:ApprovalRequestCollection`
- `list_approvalrequests`: list on `@happyvertical/smrt-approvals:ApprovalRequest`
