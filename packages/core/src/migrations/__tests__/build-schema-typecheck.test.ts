/**
 * rv1 (#4929): the generated `.smrt/build-schema.js` and the generated
 * registration that imports it sit inside consumer apps' own type-checked
 * trees. They must type-check under strict settings, with and without
 * `checkJs`, including TypeScript's check of side-effect imports.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import ts from 'typescript';
import { afterEach, describe, expect, it } from 'vitest';
import { generateSvelteKitRoutes } from '../../vite-plugin/sveltekit-generator.js';
import { generateBuildSchemaModule } from '../build-schema.js';

const manifest = {
  version: '1.0.0',
  timestamp: 0,
  packageName: '@rv1/app',
  objects: {},
};

function diagnostics(root: string, options: ts.CompilerOptions): string[] {
  const program = ts.createProgram({
    // Without allowJs the .js module is reached only through the import.
    rootNames: [
      join(root, 'src/lib/server/smrt-register.ts'),
      ...(options.allowJs ? [join(root, '.smrt/build-schema.js')] : []),
    ],
    options: {
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.NodeNext,
      moduleResolution: ts.ModuleResolutionKind.NodeNext,
      strict: true,
      noImplicitAny: true,
      noUncheckedSideEffectImports: true,
      noEmit: true,
      skipLibCheck: true,
      types: [],
      ...options,
    },
  });
  return ts
    .getPreEmitDiagnostics(program)
    .map(
      (diagnostic) =>
        `${diagnostic.file?.fileName ?? ''}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
    );
}

describe('generated build schema files type-check in consumer projects (rv1)', () => {
  let root: string;
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it.each([
    ['allowJs + checkJs', { allowJs: true, checkJs: true }],
    ['TypeScript only (a .js import with no declaration)', {}],
  ] as const)(
    '%s, strict',
    async (_label, options) => {
      root = mkdtempSync(join(tmpdir(), 'rv1-build-schema-tsc-'));
      // A consumer's view of smrt-core: only what the registration uses.
      const core = join(root, 'node_modules/@happyvertical/smrt-core');
      mkdirSync(core, { recursive: true });
      writeFileSync(
        join(core, 'package.json'),
        JSON.stringify({
          name: '@happyvertical/smrt-core',
          type: 'module',
          exports: { '.': { types: './index.d.ts', default: './index.js' } },
        }),
      );
      writeFileSync(
        join(core, 'index.d.ts'),
        'export declare const ObjectRegistry: { registerPackageManifest(manifest: unknown): unknown };\n',
      );
      writeFileSync(
        join(root, 'package.json'),
        JSON.stringify({ name: '@rv1/app', type: 'module' }),
      );
      await generateSvelteKitRoutes(root, manifest, {
        enabled: true,
        routesDir: 'src/routes/api',
        objectsDir: 'src/lib/objects',
        configPath: 'src/lib/server',
      });
      // The manifest writers publish this; write it the same way.
      writeFileSync(
        join(root, '.smrt/build-schema.js'),
        generateBuildSchemaModule(manifest),
      );
      expect(diagnostics(root, options)).toEqual([]);
    },
    30_000,
  );
});
