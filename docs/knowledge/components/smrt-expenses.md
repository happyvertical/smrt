---
type: "Component"
title: "@happyvertical/smrt-expenses"
description: "Expense records for the SMRT framework - reviewed costs against a cost object, deduplicated receipts, and commitment drawdown"
status: "stable"
generated:
  by: "smrt/scripts/generate-knowledge-okf.ts"
  at: "2026-11-10T01:55:44Z"
audience: "internal"
evidence_level: "source-inspected"
source_revision: "sha256:31a68b9286b11fff241aeb286186bd89b7aeb21e47f7238289dda30c9334373b"
sources:
  - id: "manifest"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/expenses/package.json"
    title: "@happyvertical/smrt-expenses package manifest"
  - id: "agents"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/expenses/AGENTS.md"
    title: "@happyvertical/smrt-expenses packages/expenses/AGENTS.md"
  - id: "agents-2"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/expenses/agents/allocation-test-matrix.md"
    title: "@happyvertical/smrt-expenses packages/expenses/agents/allocation-test-matrix.md"
  - id: "agents-3"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/expenses/agents/expense-ui.md"
    title: "@happyvertical/smrt-expenses packages/expenses/agents/expense-ui.md"
  - id: "agents-4"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/expenses/agents/financial-facts-test-matrix.md"
    title: "@happyvertical/smrt-expenses packages/expenses/agents/financial-facts-test-matrix.md"
  - id: "agents-5"
    resource: "https://github.com/happyvertical/smrt/blob/main/packages/expenses/agents/reviewed-allocations.md"
    title: "@happyvertical/smrt-expenses packages/expenses/agents/reviewed-allocations.md"
---

# @happyvertical/smrt-expenses

## Package

- Directory: `packages/expenses`
- Private: no
- Object source: `domain-artifact`
- Evidence level: `source-inspected`

## Documentation

- `packages/expenses/AGENTS.md`
- `packages/expenses/agents/allocation-test-matrix.md`
- `packages/expenses/agents/expense-ui.md`
- `packages/expenses/agents/financial-facts-test-matrix.md`
- `packages/expenses/agents/reviewed-allocations.md`

## Framework dependencies

- [smrt-assets](/components/smrt-assets.md)
- [smrt-commerce](/components/smrt-commerce.md)
- [smrt-core](/components/smrt-core.md)
- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-types](/components/smrt-types.md)
- [smrt-ui](/components/smrt-ui.md)
- [smrt-users](/components/smrt-users.md)
- [smrt-vitest](/components/smrt-vitest.md)

## Exports

- `.`
- `./manifest`
- `./manifest.json`
- `./playground`
- `./svelte`
- `./ui`

## Models

- `Billings` (collection `expenseallocationbillings`, extends `SmrtCollection`)
- `Expense` (collection `expenses`, extends `SmrtObject`)
- `ExpenseAllocationBilling` (collection `expenseallocationbillings`, extends `SmrtObject`)
- `ExpenseAllocationPortion` (collection `expenseallocationportions`, extends `SmrtObject`)
- `ExpenseAllocationRevision` (collection `expenseallocationrevisions`, extends `SmrtObject`)
- `ExpenseCollection` (collection `expenses`, extends `SmrtCollection`)
- `ExpenseReceipt` (collection `expensereceipts`, extends `SmrtObject`)
- `ExpenseReceiptCollection` (collection `expensereceipts`, extends `SmrtJunction`)
- `Portions` (collection `expenseallocationportions`, extends `SmrtCollection`)
- `Revisions` (collection `expenseallocationrevisions`, extends `SmrtCollection`)
