/**
 * Make the packaged `./core` entry self-contained (#4238).
 *
 * `smrt kitchen` downloads the planner tarball into its cache and imports
 * `dist/core/index.js` with bare Node, without installing the planner's
 * dependencies (they include the browser inference runtimes). svelte-package
 * leaves `./core` importing `@happyvertical/smrt-core`, `-commerce`, `-ui` and
 * `-reports` subpaths, so that import failed. This rebuilds the entry as one
 * ES module with every non-built-in import inlined; the other `dist/` files
 * (the Svelte entries) are untouched.
 *
 * Usage: node scripts/bundle-core.ts [distDir]   (default: dist)
 */
import {
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { build } from 'vite';

const dist = resolve(process.argv[2] ?? 'dist');
const entry = join(dist, 'core', 'index.js');
if (!existsSync(entry)) {
  console.error(`${entry} is missing; run svelte-package first.`);
  process.exit(1);
}
const outDir = mkdtempSync(join(tmpdir(), 'planner-core-bundle-'));
try {
  const result = await build({
    configFile: false,
    logLevel: 'warn',
    // Run from the package so workspace dependencies resolve as installed.
    root: resolve(import.meta.dirname, '..'),
    // 'webworker' (not 'node') keeps the bundler from emitting its Node
    // `createRequire(import.meta.url)` runtime shim, which would put an
    // `import 'node:module'` at the top of an entry that browser client builds
    // reach (#5000). The entry needs no Node built-ins.
    ssr: { noExternal: true, target: 'webworker' },
    build: {
      ssr: entry,
      outDir,
      emptyOutDir: true,
      minify: false,
      sourcemap: false,
      rollupOptions: {
        output: {
          format: 'es',
          entryFileNames: 'index.js',
          codeSplitting: false,
        },
      },
    },
  });
  const bundled = join(outDir, 'index.js');
  // The bundler's own record of what the chunk still imports.
  const outputs = (Array.isArray(result) ? result : [result]).flatMap(
    (output) => ('output' in output ? output.output : []),
  );
  const bare = outputs
    .flatMap((chunk) =>
      chunk.type === 'chunk' ? [...chunk.imports, ...chunk.dynamicImports] : [],
    )
    .filter((specifier) => !specifier.startsWith('node:'));
  if (bare.length > 0) {
    throw new Error(`bundled ./core still imports: ${bare.join(', ')}`);
  }
  // Copy, not rename: the temporary directory may be on another device.
  // Guard (#5000): the self-contained entry must stay free of Node built-ins.
  const text = readFileSync(bundled, 'utf8');
  const nodeImport = text.match(/(?:from|import\s*\()\s*["']node:[^"']+["']/);
  if (nodeImport) {
    throw new Error(`bundled ./core imports a Node built-in: ${nodeImport[0]}`);
  }
  copyFileSync(bundled, entry);
  console.log(`./core bundled into ${entry}`);
} finally {
  rmSync(outDir, { recursive: true, force: true });
}
