---
type: Capability
title: "Tenant scoping and cross-tenant reads"
description: "Reach for smrt-tenancy and the core allowCrossTenant opt-in instead of filtering by tenant_id by hand."
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
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/tenancy/src/interceptor.ts
    path: packages/tenancy/src/interceptor.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/tenancy/src/interceptor.ts (createTenantInterceptor, rawQueryPolicy)"
  - id: s2
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/tenancy/src/index.ts
    path: packages/tenancy/src/index.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/tenancy/src/index.ts (withTenant, withSystemContext, queryGlobal, queryWithGlobals)"
  - id: s3
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/core/src/object.ts
    path: packages/core/src/object.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/core/src/object.ts (SmrtObject.assertRelatedTenant, allowCrossTenant)"
  - id: s4
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/core/src/collection.ts
    path: packages/core/src/collection.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/core/src/collection.ts (SmrtCollection.findSimilarToEmbedding tenant prefilter)"
---

# Tenant scoping and cross-tenant reads

# Entry point

Import from `@happyvertical/smrt-tenancy`. Declare a model with `@TenantScoped({ mode })` and a `@tenantId()` field, call `enableTenancy()` once at startup, and run request work inside `withTenant({ tenantId }, fn)` (adapters: `createSvelteKitHandle`, `createExpressMiddleware`, `createCliContext`). Collections then filter by tenant automatically. Read shared rows with `queryWithGlobals()`/`queryGlobal()`, use `withSystemContext()` only for reviewed system work, and opt into a cross-tenant relationship load with `{ allowCrossTenant: true }` on `loadRelated`/`getRelated` (core).[^s2]

# Why not hand-roll it

A hand-written `WHERE tenant_id = ?` covers only the query you wrote. The interceptor in `interceptor.ts` throws `TenantIsolationError` for any raw SQL against a tenant-scoped class unless the call passes `allowRawOnTenantScoped` (default `rawQueryPolicy: 'throw'`).[^s1] In core, `SmrtObject.assertRelatedTenant()` makes relationship loads, including cache hits from an earlier eager load, throw on a cross-tenant reference, and only the exact value `allowCrossTenant === true` bypasses it, not a truthy value from untyped callers (#1321).[^s3] Semantic search runs the tenant interceptor's list prefilter first and ranks only that tenant's ids, because the embeddings table has no tenant column.[^s4]

# Component pages

- [smrt-tenancy](/components/smrt-tenancy.md)
- [smrt-core](/components/smrt-core.md)

# Detection signals

- `regex:WHERE\s+tenant_id`
- `regex:tenant_?[iI]d\s*=\s*\?`
- `regex:tenantId\s*[!=]==`

[^s1]: `packages/tenancy/src/interceptor.ts` at `478ae36900`: createTenantInterceptor, rawQueryPolicy.
[^s2]: `packages/tenancy/src/index.ts` at `478ae36900`: withTenant, withSystemContext, queryGlobal, queryWithGlobals.
[^s3]: `packages/core/src/object.ts` at `478ae36900`: SmrtObject.assertRelatedTenant, allowCrossTenant.
[^s4]: `packages/core/src/collection.ts` at `478ae36900`: SmrtCollection.findSimilarToEmbedding tenant prefilter.
