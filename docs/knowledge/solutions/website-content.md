---
type: Solution Recipe
title: Business website and content workflow
description: Publish useful business information through an application composed from existing modules.
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
- id: smrt-sites
  resource: /components/smrt-sites.md
  title: '@happyvertical/smrt-sites'
- id: smrt-content
  resource: /components/smrt-content.md
  title: '@happyvertical/smrt-content'
- id: smrt-assets
  resource: /components/smrt-assets.md
  title: '@happyvertical/smrt-assets'
- id: smrt-profiles
  resource: /components/smrt-profiles.md
  title: '@happyvertical/smrt-profiles'
- id: smrt-svelte
  resource: /components/smrt-svelte.md
  title: '@happyvertical/smrt-svelte'
- id: import
  resource: https://github.com/happyvertical/happyvertical.com/blob/4da258f6ebd103338e7d0055e98fe2da100a256c/docs/knowledge/ecosystem/solutions/website-content.md
  path: docs/knowledge/ecosystem/solutions/website-content.md
  source_revision: 4da258f6ebd103338e7d0055e98fe2da100a256c
  title: Imported from happyvertical.com docs/knowledge/ecosystem/solutions/website-content.md (commit 4da258f6eb)
---

# Business need

Publish useful business information through an application composed from existing modules.

# Existing components

- [@happyvertical/smrt-sites](/components/smrt-sites.md).[^smrt-sites]
- [@happyvertical/smrt-content](/components/smrt-content.md).[^smrt-content]
- [@happyvertical/smrt-assets](/components/smrt-assets.md).[^smrt-assets]
- [@happyvertical/smrt-profiles](/components/smrt-profiles.md).[^smrt-profiles]
- [@happyvertical/smrt-svelte](/components/smrt-svelte.md).[^smrt-svelte]

# Proposed composition

Use site/content and asset capabilities alongside a web interface for the business’s own publishing workflow. **This is a proposed recipe, not an existing turnkey product or customer result.**

# Work still required

Select the web template, build the pages and forms, configure access, content approval, hosting and delivery. An internal offline site and a publicly reachable website have different connectivity requirements.

# Deployment boundary

A public site needs reachable hosting for visitors. An internal application can be designed for a local network. See offline deployment (documented in happyvertical.com, not in this repository).

# Discovery question

Is this mainly a public website, an internal tool, or both?

[^smrt-sites]: Component evidence and limitations in the linked catalog concept.
[^smrt-content]: Component evidence and limitations in the linked catalog concept.
[^smrt-assets]: Component evidence and limitations in the linked catalog concept.
[^smrt-profiles]: Component evidence and limitations in the linked catalog concept.
[^smrt-svelte]: Component evidence and limitations in the linked catalog concept.
