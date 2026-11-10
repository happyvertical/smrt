---
type: Solution Recipe
title: Products and stock operations
description: Keep product and stock information together and support recurring operational tasks.
tags:
- business-workflow
- proposed-composition
status: draft
generated:
  by: claude/smrt-4688
  at: '2026-11-05T00:00:00Z'
stale_after: '2027-02-03T00:00:00Z'
audience: internal
sources:
- id: smrt-products
  resource: /components/smrt-products.md
  title: '@happyvertical/smrt-products'
- id: smrt-inventory
  resource: /components/smrt-inventory.md
  title: '@happyvertical/smrt-inventory'
- id: smrt-commerce
  resource: /components/smrt-commerce.md
  title: '@happyvertical/smrt-commerce'
- id: smrt-ledgers
  resource: /components/smrt-ledgers.md
  title: '@happyvertical/smrt-ledgers'
- id: smrt-jobs
  resource: /components/smrt-jobs.md
  title: '@happyvertical/smrt-jobs'
- id: import
  resource: https://github.com/happyvertical/happyvertical.com/blob/4da258f6ebd103338e7d0055e98fe2da100a256c/docs/knowledge/ecosystem/solutions/stock.md
  path: docs/knowledge/ecosystem/solutions/stock.md
  source_revision: 4da258f6ebd103338e7d0055e98fe2da100a256c
  title: Imported from happyvertical.com docs/knowledge/ecosystem/solutions/stock.md (commit 4da258f6eb)
---

# Business need

Keep product and stock information together and support recurring operational tasks.

# Existing components

- [@happyvertical/smrt-products](/components/smrt-products.md).[^smrt-products]
- [@happyvertical/smrt-inventory](/components/smrt-inventory.md).[^smrt-inventory]
- [@happyvertical/smrt-commerce](/components/smrt-commerce.md).[^smrt-commerce]
- [@happyvertical/smrt-ledgers](/components/smrt-ledgers.md).[^smrt-ledgers]
- [@happyvertical/smrt-jobs](/components/smrt-jobs.md).[^smrt-jobs]

# Proposed composition

Compose product, inventory, commerce and ledger models around the company’s stock movements and operational records. **This is a proposed recipe, not an existing turnkey product or customer result.**

# Work still required

Define units, locations, adjustments, imports, returns and reconciliation. Build the workflow UI and validate consistency under retries; these packages alone do not establish a complete ERP or accounting compliance.

# Deployment boundary

Internal records can use local infrastructure; supplier, carrier, payment and accounting integrations need individually chosen connectors. See offline deployment (documented in happyvertical.com, not in this repository).

# Discovery question

Where do you currently lose track of stock or repeat data entry?

[^smrt-products]: Component evidence and limitations in the linked catalog concept.
[^smrt-inventory]: Component evidence and limitations in the linked catalog concept.
[^smrt-commerce]: Component evidence and limitations in the linked catalog concept.
[^smrt-ledgers]: Component evidence and limitations in the linked catalog concept.
[^smrt-jobs]: Component evidence and limitations in the linked catalog concept.
