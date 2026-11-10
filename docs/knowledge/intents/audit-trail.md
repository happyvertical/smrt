---
type: Capability
title: "Audit trail and change feed"
description: "Use @smrt({ audit }) for who-changed-what records and the _smrt_changes feed for observing writes, instead of history tables or triggers."
tags:
  - smrt
  - intent
status: draft
generated:
  by: claude/smrt-4687
  at: 2026-11-05T00:00:00Z
stale_after: 2027-02-03T00:00:00Z
audience: internal
evidence_level: source-inspected
package_version: 0.60.8
sources:
  - id: s1
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/core/src/audit.ts
    path: packages/core/src/audit.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/core/src/audit.ts (requireAuditOptions, auditSnapshot, writeAudit, AuditWriter)"
  - id: s2
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/core/src/change-feed.ts
    path: packages/core/src/change-feed.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/core/src/change-feed.ts (appendChange, getChangesSince, getTenantScopedChangesSince)"
  - id: s3
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/core/src/change-feed-sensitivity.ts
    path: packages/core/src/change-feed-sensitivity.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/core/src/change-feed-sensitivity.ts (sensitive tables)"
  - id: s4
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/smrt-dev-mcp/src/tool-catalog.ts
    path: packages/smrt-dev-mcp/src/tool-catalog.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/smrt-dev-mcp/src/tool-catalog.ts (recent-changes tool)"
---

# Audit trail and change feed

# Entry point

Two different things. Audit (who changed which fields): put `audit: true` in the model's `@smrt()` config and bind identity with `withAuditContext({ actorId, writer, reason, source }, fn)` from `@happyvertical/smrt-core`; the `writer` receives an `AuditEntry` with per-field before/after. Change feed (what changed, in order): every framework `save()`/`delete()` appends a row to `_smrt_changes`; read it with `getChangesSince(db, { since, tables, limit })` or, for request handlers, `getTenantScopedChangesSince()`. For a deployed database, the `recent-changes` tool of `smrt-dev-mcp` tails the same table read-only.[^s4]

# Why not hand-roll it

`requireAuditOptions()` in `audit.ts` throws when an audited mutation has no writer or no authenticated `actorId`, `auditSnapshot()` records the public projection so credential and permission-gated fields never enter the audit row, `writeAudit()` refuses an entity with ambiguous tenant ownership, and the writer contract requires using the same transaction handle and propagating failures.[^s1] The change feed in `change-feed.ts` allocates `seq` as `MAX(seq)+1` inside the append rather than a native identity column, so a polling cursor cannot skip a change under concurrent writers on SQLite, PostgreSQL or DuckDB; deletes are tombstones, and `getTenantScopedChangesSince()` fails closed to global rows when tenancy is on and no tenant is active.[^s2] Credential-bearing tables are refused by the feed (`change-feed-sensitivity.ts`) because a row id such as a session id is itself a secret.[^s3]

# Component pages

- [smrt-core](/components/smrt-core.md)
- [smrt-dev-mcp](/components/smrt-dev-mcp.md)

# Detection signals

- `regex:audit_?log`
- `regex:audit_?trail`
- `regex:CREATE TABLE\s+\w*audit`

[^s1]: `packages/core/src/audit.ts` at `478ae36900`: requireAuditOptions, auditSnapshot, writeAudit, AuditWriter.
[^s2]: `packages/core/src/change-feed.ts` at `478ae36900`: appendChange, getChangesSince, getTenantScopedChangesSince.
[^s3]: `packages/core/src/change-feed-sensitivity.ts` at `478ae36900`: sensitive tables.
[^s4]: `packages/smrt-dev-mcp/src/tool-catalog.ts` at `478ae36900`: recent-changes tool.
