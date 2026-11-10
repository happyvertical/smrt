---
type: Solution Recipe
title: Customer intake and follow-up
description: Capture enquiries, maintain customer records, and prepare follow-up work.
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
- id: smrt-profiles
  resource: /components/smrt-profiles.md
  title: '@happyvertical/smrt-profiles'
- id: smrt-sales
  resource: /components/smrt-sales.md
  title: '@happyvertical/smrt-sales'
- id: smrt-messages
  resource: /components/smrt-messages.md
  title: '@happyvertical/smrt-messages'
- id: smrt-jobs
  resource: /components/smrt-jobs.md
  title: '@happyvertical/smrt-jobs'
- id: smrt-agents
  resource: /components/smrt-agents.md
  title: '@happyvertical/smrt-agents'
- id: import
  resource: https://github.com/happyvertical/happyvertical.com/blob/4da258f6ebd103338e7d0055e98fe2da100a256c/docs/knowledge/ecosystem/solutions/customer-followup.md
  path: docs/knowledge/ecosystem/solutions/customer-followup.md
  source_revision: 4da258f6ebd103338e7d0055e98fe2da100a256c
  title: Imported from happyvertical.com docs/knowledge/ecosystem/solutions/customer-followup.md (commit 4da258f6eb)
---

# Business need

Capture enquiries, maintain customer records, and prepare follow-up work.

# Existing components

- [@happyvertical/smrt-profiles](/components/smrt-profiles.md).[^smrt-profiles]
- [@happyvertical/smrt-sales](/components/smrt-sales.md).[^smrt-sales]
- [@happyvertical/smrt-messages](/components/smrt-messages.md).[^smrt-messages]
- [@happyvertical/smrt-jobs](/components/smrt-jobs.md).[^smrt-jobs]
- [@happyvertical/smrt-agents](/components/smrt-agents.md).[^smrt-agents]

# Proposed composition

Keep an enquiry, its customer context and the next action together; schedule reminders or draft replies for approval. **This is a proposed recipe, not an existing turnkey product or customer result.**

# Work still required

Define the intake form, deduplication rules, business stages, message templates, approval steps and chosen delivery adapters. A complete CRM UI and migration from current tools are integration work.

# Deployment boundary

Email or messaging delivery needs the chosen server/platform; storing records and preparing local tasks can use local infrastructure. See offline deployment (documented in happyvertical.com, not in this repository).

# Discovery question

Where do enquiries arrive today, and how do you decide who follows up?

[^smrt-profiles]: Component evidence and limitations in the linked catalog concept.
[^smrt-sales]: Component evidence and limitations in the linked catalog concept.
[^smrt-messages]: Component evidence and limitations in the linked catalog concept.
[^smrt-jobs]: Component evidence and limitations in the linked catalog concept.
[^smrt-agents]: Component evidence and limitations in the linked catalog concept.
