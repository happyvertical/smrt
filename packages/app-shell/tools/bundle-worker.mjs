// Bundle the engine worker (`dist/engine/app-worker.js`) into a few split files
// under `worker-bundle/` (#5213). A worker thread loads about 500 modules
// and keeps their source text on its heap; the bundle loads the same code from
// far fewer, and a worker is about half the resident size (see
// agents/engine.md, "Worker footprint"). Opt-in: the unbundled worker is the
// default, a host selects this one with `workerUrl` (`bundledWorkerUrl()`) or
// SMRT_APP_SHELL_WORKER=bundle.
//
// Rules this file must keep:
// - NEVER minify identifiers. smrt claims tables by class name
//   (`_smrt_billing_relationships`), and a mangled name collides. `keepNames`
//   also stops the bundler from renaming a colliding top-level class
//   (`Foo` -> `Foo2`), which would change its `.name`. Whitespace and syntax
//   minification gain nothing, so none is used.
// - Native add-ons stay external and resolve from this package at run time,
//   so the bundle must sit inside the package (`dist/`). The worker opens
//   SQLite through `@libsql/client` (bundled) over the native `libsql`, which
//   is therefore a direct dependency of this package (pnpm resolves it from
//   here). Optional drivers the worker never opens (DuckDB) stay external too.
import { rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const entry = join(root, 'dist/engine/app-worker.js');
// Outside `dist/` on purpose: the package `files` list publishes `dist/`, and
// this output (22 MiB) is built by the host that wants it, not shipped.
const outdir = join(root, 'worker-bundle');

rmSync(outdir, { recursive: true, force: true });
const result = await build({
  entryPoints: [entry],
  outdir,
  bundle: true,
  splitting: true,
  format: 'esm',
  platform: 'node',
  target: 'node26',
  keepNames: true,
  minify: false,
  metafile: true,
  logLevel: 'warning',
  // Optional drivers and add-ons that cannot be bundled (native bindings).
  external: [
    // The QuickJS variants each ship an `emscripten-module.wasm` the glue
    // code opens next to itself; they must stay where the package put them.
    'quickjs-emscripten',
    'quickjs-emscripten-core',
    '@jitl/*',
    '@duckdb/*',
    'duckdb',
    'libsql',
    // PGlite (the engine suite's PostgreSQL pass) loads its WebAssembly
    // files next to itself, like QuickJS above.
    '@electric-sql/pglite',
    'pg-native',
    'better-sqlite3',
    'bufferutil',
    'utf-8-validate',
    'fsevents',
    '*.node',
  ],
  // Bundled CommonJS dependencies call `require`.
  banner: {
    js: "import { createRequire as __smrtCreateRequire } from 'node:module';\nconst require = __smrtCreateRequire(import.meta.url);",
  },
});
const outputs = Object.entries(result.metafile.outputs);
const bytes = outputs.reduce((n, [, o]) => n + o.bytes, 0);
console.log(
  `[bundle-worker] ${outputs.length} files, ${(bytes / 1048576).toFixed(1)} MiB -> worker-bundle/app-worker.js`,
);
