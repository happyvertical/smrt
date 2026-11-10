---
type: Solution Recipe
title: Support intake and triage
description: Organize requests and help staff focus on cases needing judgment.
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
- id: smrt-support
  resource: /components/smrt-support.md
  title: '@happyvertical/smrt-support'
- id: smrt-messages
  resource: /components/smrt-messages.md
  title: '@happyvertical/smrt-messages'
- id: smrt-profiles
  resource: /components/smrt-profiles.md
  title: '@happyvertical/smrt-profiles'
- id: smrt-jobs
  resource: /components/smrt-jobs.md
  title: '@happyvertical/smrt-jobs'
- id: smrt-agents
  resource: /components/smrt-agents.md
  title: '@happyvertical/smrt-agents'
- id: import
  resource: https://github.com/happyvertical/happyvertical.com/blob/4da258f6ebd103338e7d0055e98fe2da100a256c/docs/knowledge/ecosystem/solutions/support.md
  path: docs/knowledge/ecosystem/solutions/support.md
  source_revision: 4da258f6ebd103338e7d0055e98fe2da100a256c
  title: Imported from happyvertical.com docs/knowledge/ecosystem/solutions/support.md (commit 4da258f6eb)
---

# Business need

Organize requests and help staff focus on cases needing judgment.

# Existing components

- [@happyvertical/smrt-support](/components/smrt-support.md).[^smrt-support]
- [@happyvertical/smrt-messages](/components/smrt-messages.md).[^smrt-messages]
- [@happyvertical/smrt-profiles](/components/smrt-profiles.md).[^smrt-profiles]
- [@happyvertical/smrt-jobs](/components/smrt-jobs.md).[^smrt-jobs]
- [@happyvertical/smrt-agents](/components/smrt-agents.md).[^smrt-agents]

# Proposed composition

Represent support work, associate messages with the people involved, and schedule or assist triage. **This is a proposed recipe, not an existing turnkey product or customer result.**

# Work still required

Configure inbound channels, routing, staff ownership, permitted agent actions and escalation. Source support for service targets is not a contractual support SLA or an existing managed support desk.

# Deployment boundary

Outside email and chat channels require network access even when internal records are self-hosted. See offline deployment (documented in happyvertical.com, not in this repository).

# Discovery question

What requests arrive most often, and which ones need your personal judgment?

[^smrt-support]: Component evidence and limitations in the linked catalog concept.
[^smrt-messages]: Component evidence and limitations in the linked catalog concept.
[^smrt-profiles]: Component evidence and limitations in the linked catalog concept.
[^smrt-jobs]: Component evidence and limitations in the linked catalog concept.
[^smrt-agents]: Component evidence and limitations in the linked catalog concept.
