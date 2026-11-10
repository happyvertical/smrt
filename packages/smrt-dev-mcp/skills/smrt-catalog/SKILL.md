---
name: smrt-catalog
description: Use BEFORE writing infrastructure, utility, or integration code in a project that depends on @happyvertical smrt packages. Fires on requests for scheduled or background jobs and retries ("add a nightly cleanup job"), sending email or notifications ("send the customer a receipt email"), file or object storage and uploads ("upload the logo to storage"), tenancy ("make this tenant-aware"), money and price fields ("add a price field"), plus approvals, audit trails, permissions, search, caching, webhooks, and document generation. Routes to the smrt knowledge catalog so an installed package is reused instead of hand-rolled. Stay silent for ordinary feature work inside an existing @smrt() object (editing its fields, methods, validation, UI, or tests) that needs no new plumbing.
---

# SMRT Catalog

Fire before writing infrastructure, utility, or integration code in a project
that depends on `@happyvertical/smrt-*` packages. The catalog says whether an
installed package already provides the behaviour.

## Workflow

1. Read `.agents/smrt-knowledge/intents/index.md` (written by `smrt docs:agents`).
   Pick the row whose intent matches the request.
2. Read that intent page, then the component page of its home package
   (`.agents/smrt-knowledge/components/<package>.md`).
3. Before writing code, tell the user: the smrt package, the entry point, and
   why it fits (or what is missing). Wait for objection only if the proposal
   changes the requested design.
4. Implement with that entry point. Do not reimplement what the page names.
5. Bundle missing, or no intent row matches: say so, then call `smrt-dev-mcp`
   `build-context` (and `check-knowledge-freshness` when available) and continue
   from its output. If `check-knowledge-freshness` reports the bundle stale,
   say so and suggest rerunning `smrt docs:agents`.

## When the package lacks the behaviour

The home package exists but does not do what is needed:

1. Draft an issue for `happyvertical/smrt` that cites the intent page and the
   component page, states the missing behaviour, and the use case. Show the
   draft to the user; file it only with their approval.
2. Implement the smallest local shim, marked temporary with a comment that
   links the issue (`// TEMPORARY: replace with <package> once <issue URL> ships`).
3. Do not silently reimplement the package.

## Not for

- Editing fields, methods, validation, UI, or tests of an existing `@smrt()`
  object when no new infrastructure is involved.
- Projects that do not depend on smrt packages.
