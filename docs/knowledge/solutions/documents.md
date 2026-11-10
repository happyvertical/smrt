---
type: Solution Recipe
title: Document intake and reusable knowledge
description: Reduce repeated reading and rekeying of business documents.
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
- id: smrt-content
  resource: /components/smrt-content.md
  title: '@happyvertical/smrt-content'
- id: smrt-assets
  resource: /components/smrt-assets.md
  title: '@happyvertical/smrt-assets'
- id: smrt-facts
  resource: /components/smrt-facts.md
  title: '@happyvertical/smrt-facts'
- id: smrt-jobs
  resource: /components/smrt-jobs.md
  title: '@happyvertical/smrt-jobs'
- id: smrt-agents
  resource: /components/smrt-agents.md
  title: '@happyvertical/smrt-agents'
- id: import
  resource: https://github.com/happyvertical/happyvertical.com/blob/4da258f6ebd103338e7d0055e98fe2da100a256c/docs/knowledge/ecosystem/solutions/documents.md
  path: docs/knowledge/ecosystem/solutions/documents.md
  source_revision: 4da258f6ebd103338e7d0055e98fe2da100a256c
  title: Imported from happyvertical.com docs/knowledge/ecosystem/solutions/documents.md (commit 4da258f6eb)
---

# Business need

Reduce repeated reading and rekeying of business documents.

# Existing components

- [@happyvertical/smrt-content](/components/smrt-content.md).[^smrt-content]
- [@happyvertical/smrt-assets](/components/smrt-assets.md).[^smrt-assets]
- [@happyvertical/smrt-facts](/components/smrt-facts.md).[^smrt-facts]
- [@happyvertical/smrt-jobs](/components/smrt-jobs.md).[^smrt-jobs]
- [@happyvertical/smrt-agents](/components/smrt-agents.md).[^smrt-agents]

# Proposed composition

Combine stored documents, background processing and structured facts so people can review extracted information and reuse it. **This is a proposed recipe, not an existing turnkey product or customer result.**

# Work still required

Add PDF/OCR adapters where needed, define the extraction schema and evidence links, test representative documents and decide when a person must correct or approve results. This does not establish an accurate invoice parser or regulated record system.

# Deployment boundary

Local files and models are candidate choices; OCR/model provisioning and any hosted provider must be checked for the selected workflow. See offline deployment (documented in happyvertical.com, not in this repository).

# Discovery question

Which documents do you repeatedly read, and what information do you copy out?

[^smrt-content]: Component evidence and limitations in the linked catalog concept.
[^smrt-assets]: Component evidence and limitations in the linked catalog concept.
[^smrt-facts]: Component evidence and limitations in the linked catalog concept.
[^smrt-jobs]: Component evidence and limitations in the linked catalog concept.
[^smrt-agents]: Component evidence and limitations in the linked catalog concept.
