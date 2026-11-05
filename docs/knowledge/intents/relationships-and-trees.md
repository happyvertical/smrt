---
type: Capability
title: "Polymorphic links, junctions and trees"
description: "Extend SmrtJunction, SmrtHierarchical and SmrtPolymorphicAssociation instead of writing link tables, parent_id traversal or type/id pairs by hand."
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
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/core/src/hierarchical.ts
    path: packages/core/src/hierarchical.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/core/src/hierarchical.ts (SmrtHierarchical.moveTo, getDescendants)"
  - id: s2
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/core/src/junction.ts
    path: packages/core/src/junction.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/core/src/junction.ts (SmrtJunction.attach, setLinks)"
  - id: s3
    resource: https://github.com/happyvertical/smrt/blob/478ae3690052b825b79b28235369ee7a5f6d2f20/packages/core/src/polymorphic-association.ts
    path: packages/core/src/polymorphic-association.ts
    source_revision: 478ae3690052b825b79b28235369ee7a5f6d2f20
    title: "packages/core/src/polymorphic-association.ts (SmrtPolymorphicAssociation)"
---

# Polymorphic links, junctions and trees

# Entry point

All three are exported from `@happyvertical/smrt-core`. Trees: `class Place extends SmrtHierarchical` (a `parentId` self-reference) gives `getAncestors()`, `getDescendants()`, `getHierarchy()` and a cycle-checked `moveTo()`. Many-to-many: a collection extending `SmrtJunction` declares `leftField`/`rightField` and gets `attach()`, `detach()`, `byLeft()`, `byRight()` and `setLinks()`; composite-key owners extend `SmrtJunctionBase`. Links to any model: `class CommentAssociation extends SmrtPolymorphicAssociation` stores `metaType` (qualified class name), `metaId` and `role`, and `hydrate()` resolves the target through the registry. Classes whose self-reference means something else (an evolution chain, a derivation DAG) must not extend `SmrtHierarchical`.

# Why not hand-roll it

`SmrtHierarchical.moveTo()` in `hierarchical.ts` refuses to move a node to itself or beneath one of its own descendants before it saves, which a bare `parentId` update does not, and traversal is breadth-first with one batched query per level.[^s1] `SmrtJunction.attach()` in `junction.ts` spreads caller options first so the fixed left and right keys always win and untrusted options cannot retarget the write, and it upserts on the model's `conflictColumns` (with the documented caveat that a duplicate rewrites the row id); `setLinks()` replaces a left id's full set and is documented as not transactional.[^s2] `SmrtPolymorphicAssociation` keeps `metaId` a bare string with `metaType` resolved through `ObjectRegistry`, rather than an untyped foreign key per target.[^s3]

# Component pages

- [smrt-core](/components/smrt-core.md)

# Detection signals

- `regex:parent_?[iI]d\s*[:=]`
- `regex:WITH RECURSIVE`
- `regex:entity_?type`

[^s1]: `packages/core/src/hierarchical.ts` at `478ae36900`: SmrtHierarchical.moveTo, getDescendants.
[^s2]: `packages/core/src/junction.ts` at `478ae36900`: SmrtJunction.attach, setLinks.
[^s3]: `packages/core/src/polymorphic-association.ts` at `478ae36900`: SmrtPolymorphicAssociation.
