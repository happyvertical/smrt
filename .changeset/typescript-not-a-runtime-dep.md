---
'@happyvertical/smrt-core': patch
---

Move `typescript` from `dependencies` to `devDependencies`.

No runtime source in `smrt-core` imports `typescript` — the only occurrences
are string literals in migration `format: 'sql' | 'typescript'` unions. Its
presence as a production dependency satisfied `cosmiconfig`'s optional
`typescript` peer, so bundlers followed cosmiconfig's `require('typescript')`
and pulled the whole compiler into consumers' server bundles, statically
reachable from their SvelteKit `hooks.server` entry.

`smrt-config` already registers `jiti` as the loader for `.ts` config files, so
cosmiconfig's TypeScript loader was never used at runtime.

Measured on a consumer (anytown dashboard, adapter-node production build):
the compiler is no longer statically imported from the server entry — it moves
behind a dynamic `import()` that the jiti path never executes. Note the chunk
is still emitted (`typescript-*.js`, ~9.3 MB) because `typescript` remains
resolvable through other optional peers (`@sveltejs/kit`, `@tanstack/db`), so
image size is unchanged; what changes is that it is no longer parsed at boot.
