---
'@happyvertical/smrt-core': patch
---

R3-A follow-up — two small `SmrtHierarchical` corrections surfaced by
codex's round-2 review of R3-B:

1. **Qualified-name resolution.** `SmrtHierarchical._hierarchyCollection`
   was looking up the active collection via `this.constructor.name`
   (simple name). If two packages declared hierarchical classes with the
   same simple name (e.g. both shipped a `Document`), the
   `ObjectRegistry.getSTIBase` / `getCollection` lookups could pick the
   wrong registration. Now uses
   `ObjectRegistry.getClassByConstructor(this.constructor)` to recover
   the registered qualified name and pass that through — the constructor
   reference is unambiguous even when simple names collide. Falls back
   to `this.constructor.name` on miss (e.g. unregistered subclass), in
   which case `getCollection` itself produces the existing
   "not found in ObjectRegistry" error.

2. **Browser entry export.** `packages/core/src/browser.ts` exported
   `SmrtJunction` but not `SmrtHierarchical`. Federated and browser
   consumers of `@happyvertical/smrt-core/browser` couldn't extend the
   hierarchical base without falling back to the Node-oriented main
   entry. Added the missing re-export (plus the `HierarchyView` type).
