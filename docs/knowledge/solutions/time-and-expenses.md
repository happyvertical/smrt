---
type: Solution Recipe
title: Time, receipts and job costs
description: Reduce repeated entry of time and expenses while keeping review explicit.
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
- id: smrt-timesheets
  resource: /components/smrt-timesheets.md
  title: '@happyvertical/smrt-timesheets'
- id: smrt-expenses
  resource: /components/smrt-expenses.md
  title: '@happyvertical/smrt-expenses'
- id: smrt-human-resources
  resource: /components/smrt-human-resources.md
  title: '@happyvertical/smrt-human-resources'
- id: smrt-projects
  resource: /components/smrt-projects.md
  title: '@happyvertical/smrt-projects'
- id: smrt-commerce
  resource: /components/smrt-commerce.md
  title: '@happyvertical/smrt-commerce'
- id: import
  resource: https://github.com/happyvertical/happyvertical.com/blob/4da258f6ebd103338e7d0055e98fe2da100a256c/docs/knowledge/ecosystem/solutions/time-and-expenses.md
  path: docs/knowledge/ecosystem/solutions/time-and-expenses.md
  source_revision: 4da258f6ebd103338e7d0055e98fe2da100a256c
  title: Imported from happyvertical.com docs/knowledge/ecosystem/solutions/time-and-expenses.md (commit 4da258f6eb)
---

# Business need

A business records time, collects receipts, assigns costs to jobs and repeatedly reconstructs those records for review.

# Existing components

- [Timesheets](/components/smrt-timesheets.md) models submitted/approved time, corrections and charge/compensation snapshots.[^smrt-timesheets]
- [Expenses](/components/smrt-expenses.md) models reviewed costs and receipt links. Its scope excludes receipt OCR and accounting-provider posting.[^smrt-expenses]
- [Human resources](/components/smrt-human-resources.md) models employment and qualifications; payroll is a separate responsibility.[^smrt-human-resources]
- [Projects](/components/smrt-projects.md) and [commerce](/components/smrt-commerce.md) provide related work and commercial domain components.[^smrt-projects][^smrt-commerce]

# Proposed composition

Create a simple capture-and-review workflow for time and receipts, associated with the company's jobs. This is a proposed composition; a finished field-service or payroll product is not established by this research.

# Work still required

Build the capture interface, work references, permissions and reviewer experience. Supply pricing/compensation rules, accounting exports and any receipt extraction. Test corrections, duplicates and actual business calculations. Sensitive employment records require application-owned authorization.

# Deployment boundary

Choose local storage and database options for internal operations. External accounting services, remote capture synchronization and hosted OCR each introduce their own connectivity requirement. No end-to-end offline workflow was run here.

# Discovery question

Where do your team's time records and receipts end up today, and who checks them?

[^smrt-timesheets]: Timesheet package evidence.
[^smrt-expenses]: Expense package evidence.
[^smrt-human-resources]: HR package evidence.
[^smrt-projects]: Project package evidence.
[^smrt-commerce]: Commerce package evidence.
