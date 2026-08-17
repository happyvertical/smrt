---
'@happyvertical/smrt-core': patch
'@happyvertical/smrt-users': patch
---

Declare `__smrtGetRequestScopedDatabase` once, in `smrt-core`.

`smrt-core`'s SvelteKit generator emitted a `declare global` for this name
typed as `SmrtClassOptions['db']` (i.e. `DatabaseConfig`), while `smrt-users`
declared the same global with its package-private `QueryableDatabase`.
TypeScript requires merged `var` declarations to be *identical*, not merely
compatible, so any consumer whose program contained both failed to type-check:

```
Subsequent variable declarations must have the same type.
Variable '__smrtGetRequestScopedDatabase' must be of type
'(() => QueryableDatabase | undefined) | undefined', but here has type
'(() => DatabaseConfig | undefined) | undefined'.
```

`smrt-core` now owns the single canonical declaration (next to
`DatabaseConfig`); `smrt-users` and the generated SvelteKit runtime config both
rely on it instead of redeclaring. The runtime contract is unchanged —
`QueryableDatabase` extends `DatabaseInterface`, which is already an arm of
`DatabaseConfig`, so writers keep installing a live database.

Consumers regenerate `src/lib/server/smrt.ts` on their next build and the
duplicate disappears; no consumer code change is required.
