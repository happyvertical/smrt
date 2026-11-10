---
type: Solution Recipe
title: Member or customer portal
description: Assemble an authenticated portal with roles and optional subscription entitlements.
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
- id: smrt-users
  resource: /components/smrt-users.md
  title: '@happyvertical/smrt-users'
- id: smrt-tenancy
  resource: /components/smrt-tenancy.md
  title: '@happyvertical/smrt-tenancy'
- id: smrt-subscriptions
  resource: /components/smrt-subscriptions.md
  title: '@happyvertical/smrt-subscriptions'
- id: smrt-features
  resource: /components/smrt-features.md
  title: '@happyvertical/smrt-features'
- id: smrt-svelte
  resource: /components/smrt-svelte.md
  title: '@happyvertical/smrt-svelte'
- id: import
  resource: https://github.com/happyvertical/happyvertical.com/blob/4da258f6ebd103338e7d0055e98fe2da100a256c/docs/knowledge/ecosystem/solutions/membership.md
  path: docs/knowledge/ecosystem/solutions/membership.md
  source_revision: 4da258f6ebd103338e7d0055e98fe2da100a256c
  title: Imported from happyvertical.com docs/knowledge/ecosystem/solutions/membership.md (commit 4da258f6eb)
---

# Business need

Assemble an authenticated portal with roles and optional subscription entitlements.

# Existing components

- [@happyvertical/smrt-users](/components/smrt-users.md).[^smrt-users]
- [@happyvertical/smrt-tenancy](/components/smrt-tenancy.md).[^smrt-tenancy]
- [@happyvertical/smrt-subscriptions](/components/smrt-subscriptions.md).[^smrt-subscriptions]
- [@happyvertical/smrt-features](/components/smrt-features.md).[^smrt-features]
- [@happyvertical/smrt-svelte](/components/smrt-svelte.md).[^smrt-svelte]

# Proposed composition

Combine user and tenant boundaries with application features and subscription models, using the starter as a composition reference. **This is a proposed recipe, not an existing turnkey product or customer result.**

# Work still required

Configure production identity, authorization, billing if needed, branding, account lifecycle and customer workflows. Validate tenant isolation in the actual application; module presence is not a completed security review.

# Deployment boundary

Identity can be self-hosted with additional operations; the inspected starter billing path uses Stripe and is not offline. See offline deployment (documented in happyvertical.com, not in this repository).

# Discovery question

Who signs in, and what must each person be allowed to see or do?

[^smrt-users]: Component evidence and limitations in the linked catalog concept.
[^smrt-tenancy]: Component evidence and limitations in the linked catalog concept.
[^smrt-subscriptions]: Component evidence and limitations in the linked catalog concept.
[^smrt-features]: Component evidence and limitations in the linked catalog concept.
[^smrt-svelte]: Component evidence and limitations in the linked catalog concept.
