# Type-checking a consumer against a local smrt checkout

Consumers (Anytown, Ergot, ...) sometimes run `svelte-check` against an
unreleased smrt checkout instead of the published packages. Done naively this
fails with errors like:

```text
Type '() => ReturnType<import("svelte").Snippet>' is not assignable to type 'Snippet<[]>'.
  ... Two different types with this name exist, but they are unrelated.
  Type '... & unique symbol' is not assignable to type 'unique symbol'.
```

## Cause

Two copies of Svelte end up in one TypeScript program:

- the consumer's own `node_modules/svelte`, and
- the checkout's `node_modules/svelte` (every smrt package has `svelte` as a
  dev dependency, so the checkout always has its own copy).

TypeScript `paths` (`svelte` → the app's copy) redirect **imports**, but when
`svelte-check` compiles a `.svelte` **source** file it adds a
`/// <reference types="svelte" />` directive to the generated code. Type
reference directives ignore `paths` and resolve from the component's own
directory, so an smrt source component pulls in the checkout's Svelte. Each
copy declares its own `SnippetReturn` unique symbol, so a snippet created in
the app cannot be passed to an smrt component's `Snippet` prop.

Two details make this look random:

- It is order dependent: whichever component the program reaches first
  decides which `declare module 'svelte'` wins, so adding or moving an import
  (a calendar page, `WorkingStatus`) can flip a clean run into errors.
- TypeScript dedupes packages with the same name *and version*, so the
  problem hides while both sides happen to resolve the same Svelte patch and
  appears as soon as either side bumps it.

smrt cannot remove the directive (svelte2tsx emits it), but every published
Svelte entry point is typed by built declarations: each `exports` entry with a
`svelte` condition has a `types` condition first, pointing at
`svelte-package` output (`*.svelte.d.ts`). Those declarations import Svelte
normally and carry no reference directive, so they obey `paths`.

## Recommended setup: type against the checkout's built declarations

1. Build the packages you link (`pnpm --filter @happyvertical/smrt-ui... build`,
   or `build:watch` in the package while you work).
2. In the consumer's TypeScript config (for SvelteKit, `kit.typescript.config`
   in `svelte.config.js`), map each linked specifier to the checkout's
   `exports[subpath].types` file, and map `svelte` / `svelte/*` to the app's
   own copy:

```js
// Build tsconfig `paths` for a local smrt checkout from its package exports.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export function smrtCheckoutTypePaths(repo, specifiers, appSvelte = '../node_modules/svelte') {
  const packages = new Map();
  for (const dir of readdirSync(join(repo, 'packages'))) {
    try {
      const pkg = JSON.parse(readFileSync(join(repo, 'packages', dir, 'package.json'), 'utf8'));
      packages.set(pkg.name, { dir: join(repo, 'packages', dir), exports: pkg.exports ?? {} });
    } catch {}
  }
  const paths = { svelte: [appSvelte], 'svelte/*': [`${appSvelte}/*`] };
  for (const specifier of specifiers) {
    const name = specifier.split('/').slice(0, 2).join('/');
    const pkg = packages.get(name);
    const entry = pkg?.exports[`.${specifier.slice(name.length)}`];
    const types = typeof entry === 'object' ? entry.types : undefined;
    if (!types) throw new Error(`${specifier} has no types entry in the checkout`);
    paths[specifier] = [join(pkg.dir, types)];
  }
  return paths;
}
```

3. Keep Vite/Vitest aliases to the checkout's `src` if you want source-level
   HMR at runtime, and set `resolve.dedupe: ['svelte']` so the runtime also
   uses one Svelte.

Because only `.d.ts` files from the checkout enter the program, no smrt
component is compiled by `svelte-check`, and `paths` covers every Svelte
import.

## Alternative: type against the checkout's sources

If you must type-check smrt **sources** (to see errors inside smrt files, or
without building), `paths` alone is not enough. Also pin type reference
directives with `compilerOptions.typeRoots`: a directory that holds only a
`svelte` symlink to the app's Svelte, followed by the usual
`node_modules/@types` roots. The directive then resolves to the app's copy for
every component. Keep the list of source-aliased specifiers short, since each
one pulls that package's sources (and their own imports) into the program.

## `link:` and `file:` dependencies

- `file:` tarballs (`pnpm pack` output) install like the published packages
  and resolve the consumer's Svelte: no extra setup.
- `link:` resolves the checkout's `dist` through `exports`, but imports inside
  it resolve from the checkout, so add the `svelte` / `svelte/*` `paths` above
  (and `resolve.dedupe: ['svelte']` for Vite).
