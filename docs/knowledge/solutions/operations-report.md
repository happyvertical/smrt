---
type: Solution Recipe
title: Recurring operational reports
description: Prepare recurring views of business activity without rebuilding the report each time.
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
- id: smrt-reports
  resource: /components/smrt-reports.md
  title: '@happyvertical/smrt-reports'
- id: smrt-facts
  resource: /components/smrt-facts.md
  title: '@happyvertical/smrt-facts'
- id: smrt-ledgers
  resource: /components/smrt-ledgers.md
  title: '@happyvertical/smrt-ledgers'
- id: smrt-jobs
  resource: /components/smrt-jobs.md
  title: '@happyvertical/smrt-jobs'
- id: smrt-agents
  resource: /components/smrt-agents.md
  title: '@happyvertical/smrt-agents'
- id: import
  resource: https://github.com/happyvertical/happyvertical.com/blob/4da258f6ebd103338e7d0055e98fe2da100a256c/docs/knowledge/ecosystem/solutions/operations-report.md
  path: docs/knowledge/ecosystem/solutions/operations-report.md
  source_revision: 4da258f6ebd103338e7d0055e98fe2da100a256c
  title: Imported from happyvertical.com docs/knowledge/ecosystem/solutions/operations-report.md (commit 4da258f6eb)
---

# Business need

Prepare recurring views of business activity without rebuilding the report each time.

# Existing components

- [@happyvertical/smrt-reports](/components/smrt-reports.md).[^smrt-reports]
- [@happyvertical/smrt-facts](/components/smrt-facts.md).[^smrt-facts]
- [@happyvertical/smrt-ledgers](/components/smrt-ledgers.md).[^smrt-ledgers]
- [@happyvertical/smrt-jobs](/components/smrt-jobs.md).[^smrt-jobs]
- [@happyvertical/smrt-agents](/components/smrt-agents.md).[^smrt-agents]

# Proposed composition

Compose reporting, structured information and scheduled work into a repeatable preparation process. **This is a proposed recipe, not an existing turnkey product or customer result.**

# Work still required

Define the source-of-truth data, calculation rules, reconciliation and audience permissions. Validate every business metric against its authoritative records; generated prose does not establish numerical correctness.

# Deployment boundary

Local data supports a local design; reports pulling current remote data require access to those sources. See offline deployment (documented in happyvertical.com, not in this repository).

# Discovery question

Which report do you rebuild most often, and where does its data come from?

[^smrt-reports]: Component evidence and limitations in the linked catalog concept.
[^smrt-facts]: Component evidence and limitations in the linked catalog concept.
[^smrt-ledgers]: Component evidence and limitations in the linked catalog concept.
[^smrt-jobs]: Component evidence and limitations in the linked catalog concept.
[^smrt-agents]: Component evidence and limitations in the linked catalog concept.
