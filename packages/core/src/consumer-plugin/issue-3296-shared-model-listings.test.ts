/**
 * #3296: once workspace libraries are built, the aggregated consumer manifest
 * lists one model under every consumer package that scanned its source (each
 * library scans a dependency's model under its own package name, #3110). The
 * consumer type generator must emit ONE declaration per class, not one per
 * listing.
 *
 * The fixture lays out installed provider packages whose real manifests list
 * the same class (same declaring source file) under three qualified names, and
 * runs the real `smrtConsumer({ generateTypes: true })` build hook against
 * them, then type-checks the emitted declaration files with TypeScript.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';
import ts from 'typescript';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  objectDeclarationIdentity,
  selectObjectDeclarations,
} from '../manifest/object-declarations.js';
import { ManifestGenerator } from '../scanner/manifest-generator.js';
import type { SmartObjectManifest } from '../scanner/types.js';
import { generateTypeDeclarationFile } from '../vite-plugin/index.js';
import { smrtConsumer } from './index';

const DECLARING_SOURCE =
  '/workspace/ergot/packages/market-core/src/models/license-sale.ts';

function licenseSaleListing(packageName: string) {
  return {
    qualifiedName: `${packageName}:LicenseSale`,
    className: 'LicenseSale',
    packageName,
    name: 'licenseSale',
    collection: 'license-sales',
    filePath: DECLARING_SOURCE,
    fields: {
      title: { type: 'text', required: true },
      amount: { type: 'integer' },
    },
    methods: {},
    decoratorConfig: { tableName: 'license_sales' },
  };
}

function buildStart(plugin: ReturnType<typeof smrtConsumer>): Promise<void> {
  const hook = plugin.buildStart;
  if (!hook) throw new Error('Expected buildStart hook');
  const handler = typeof hook === 'function' ? hook : hook.handler;
  return Promise.resolve(
    handler.call({} as never, {} as Parameters<typeof handler>[0]),
  );
}

function countMatches(text: string, pattern: RegExp): number {
  return [...text.matchAll(pattern)].length;
}

/** Semantic diagnostics of the generated declaration files, compiled together. */
function declarationErrors(typesDir: string, files: string[]): string[] {
  const program = ts.createProgram(
    files.map((file) => join(typesDir, file)),
    {
      noEmit: true,
      strict: true,
      skipLibCheck: false,
      types: [],
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    },
  );
  return ts
    .getPreEmitDiagnostics(program)
    .filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error)
    .map((diagnostic) =>
      ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
    );
}

describe('consumer type generation for one class listed by several packages (#3296)', () => {
  let tmpDir: string;
  const logSpies: Array<ReturnType<typeof vi.spyOn>> = [];

  function writeProvider(
    packageName: string,
    objects: Record<string, unknown>,
  ) {
    const packageDir = join(tmpDir, 'node_modules', ...packageName.split('/'));
    mkdirSync(join(packageDir, 'dist'), { recursive: true });
    writeFileSync(
      join(packageDir, 'package.json'),
      JSON.stringify({
        name: packageName,
        version: '1.0.0',
        exports: {
          '.': './dist/index.js',
          './manifest.json': './dist/manifest.json',
        },
      }),
    );
    writeFileSync(
      join(packageDir, 'dist', 'manifest.json'),
      JSON.stringify({ version: '1.0.0', packageName, objects }),
    );
  }

  beforeEach(() => {
    tmpDir = resolve(
      import.meta.dirname,
      `__test-issue-3296-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ name: '@fixture/dashboard', version: '1.0.0' }),
    );
    for (const method of ['log', 'warn'] as const) {
      logSpies.push(vi.spyOn(console, method).mockImplementation(() => {}));
    }
  });

  afterEach(() => {
    for (const spy of logSpies.splice(0)) spy.mockRestore();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('emits one LicenseSaleData declaration for the declaring package and every consumer listing', async () => {
    // The declaring package, plus two built workspace libraries that consume
    // its model and list it under their own package names.
    writeProvider('@ergot/market-core', {
      '@ergot/market-core:LicenseSale':
        licenseSaleListing('@ergot/market-core'),
    });
    writeProvider('@ergot/market-ui', {
      '@ergot/market-ui:LicenseSale': licenseSaleListing('@ergot/market-ui'),
    });
    writeProvider('@ergot/factory-dashboard', {
      '@ergot/factory-dashboard:LicenseSale': licenseSaleListing(
        '@ergot/factory-dashboard',
      ),
    });

    const plugin = smrtConsumer({
      packages: [
        '@ergot/market-ui',
        '@ergot/factory-dashboard',
        '@ergot/market-core',
      ],
      projectRoot: tmpDir,
      disableScanning: true,
      generateTypes: true,
      typesDir: 'src/types/smrt-generated',
    });
    await buildStart(plugin);

    // The aggregated manifest still carries every listing; only the generated
    // declarations collapse them.
    const aggregated = JSON.parse(
      readFileSync(join(tmpDir, '.smrt', 'manifest.json'), 'utf-8'),
    );
    expect(Object.keys(aggregated.objects)).toHaveLength(3);

    const typesDir = join(tmpDir, 'src', 'types', 'smrt-generated');
    const objects = readFileSync(join(typesDir, 'smrt-objects.d.ts'), 'utf-8');
    const types = readFileSync(join(typesDir, 'smrt-types.d.ts'), 'utf-8');
    expect(countMatches(objects, /export interface LicenseSaleData\b/g)).toBe(
      1,
    );
    expect(countMatches(types, /export type LicenseSaleData\b/g)).toBe(1);

    // Duplicate `export type` aliases are a hard TS2300 error; the generated
    // row-type declarations must type-check together. (`smrt-client.d.ts`
    // names its row types without importing them, a separate defect that the
    // qualified-name work of #3115 resolves.)
    expect(
      declarationErrors(typesDir, [
        'smrt-objects.d.ts',
        'smrt-types.d.ts',
        'smrt-web.d.ts',
        'smrt-manifest.d.ts',
      ]),
    ).toEqual([]);
  });

  it('is byte-identical regardless of provider aggregation order', async () => {
    const outputs: string[] = [];
    const orders = [
      ['@ergot/market-core', '@ergot/market-ui'],
      ['@ergot/market-ui', '@ergot/market-core'],
    ];
    writeProvider('@ergot/market-core', {
      '@ergot/market-core:LicenseSale':
        licenseSaleListing('@ergot/market-core'),
    });
    writeProvider('@ergot/market-ui', {
      '@ergot/market-ui:LicenseSale': licenseSaleListing('@ergot/market-ui'),
    });
    for (const [index, packages] of orders.entries()) {
      const typesDir = `src/types/order-${index}`;
      await buildStart(
        smrtConsumer({
          packages,
          projectRoot: tmpDir,
          disableScanning: true,
          generateTypes: true,
          typesDir,
        }),
      );
      outputs.push(
        ['smrt-objects.d.ts', 'smrt-types.d.ts']
          .map((file) => readFileSync(join(tmpDir, typesDir, file), 'utf-8'))
          .join('\n'),
      );
    }
    expect(outputs[1]).toBe(outputs[0]);
  });
});

describe('objectDeclarationIdentity / selectObjectDeclarations (#3296)', () => {
  function manifestOf(objects: Record<string, unknown>): SmartObjectManifest {
    return {
      version: '1.0.0',
      timestamp: 0,
      objects,
    } as unknown as SmartObjectManifest;
  }

  it('collapses listings of one class from one absolute source file, keyed in qualified order', () => {
    const declarations = selectObjectDeclarations(
      manifestOf({
        '@ergot/market-ui:LicenseSale': licenseSaleListing('@ergot/market-ui'),
        '@ergot/market-core:LicenseSale':
          licenseSaleListing('@ergot/market-core'),
      }),
    );
    expect(declarations).toHaveLength(1);
    expect(declarations[0]).toMatchObject({
      interfaceName: 'LicenseSaleData',
      manifestKey: '@ergot/market-core:LicenseSale',
      manifestKeys: [
        '@ergot/market-core:LicenseSale',
        '@ergot/market-ui:LicenseSale',
      ],
    });
  });

  it('normalizes Windows separators before comparing source files', () => {
    expect(
      objectDeclarationIdentity('a', {
        ...licenseSaleListing('@a/x'),
        filePath: 'C:\\work\\src\\license-sale.ts',
      } as never),
    ).toBe(
      objectDeclarationIdentity('b', {
        ...licenseSaleListing('@b/x'),
        filePath: 'C:/work/src/license-sale.ts',
      } as never),
    );
  });

  it('keeps same-path listings apart when their fields disagree (separate builds sharing a path layout, or a stale listing)', () => {
    expect(
      selectObjectDeclarations(
        manifestOf({
          '@a/x:LicenseSale': licenseSaleListing('@a/x'),
          '@b/y:LicenseSale': {
            ...licenseSaleListing('@b/y'),
            fields: { title: { type: 'text', required: true } },
          },
        }),
      ),
    ).toHaveLength(2);
    // Field key order is not part of the shape.
    const listing = licenseSaleListing('@b/y');
    expect(
      selectObjectDeclarations(
        manifestOf({
          '@a/x:LicenseSale': licenseSaleListing('@a/x'),
          '@b/y:LicenseSale': {
            ...listing,
            fields: {
              amount: listing.fields.amount,
              title: listing.fields.title,
            },
          },
        }),
      ),
    ).toHaveLength(1);
  });

  it('keeps listings apart when the source path is relative, missing, or names a different class', () => {
    const relative = (packageName: string) => ({
      ...licenseSaleListing(packageName),
      filePath: 'src/models/license-sale.ts',
    });
    const missing = (packageName: string) => ({
      ...licenseSaleListing(packageName),
      filePath: undefined,
    });
    expect(
      selectObjectDeclarations(
        manifestOf({
          '@a/x:LicenseSale': relative('@a/x'),
          '@b/y:LicenseSale': relative('@b/y'),
        }),
      ),
    ).toHaveLength(2);
    expect(
      selectObjectDeclarations(
        manifestOf({
          '@a/x:LicenseSale': missing('@a/x'),
          '@b/y:LicenseSale': missing('@b/y'),
        }),
      ),
    ).toHaveLength(2);
    expect(
      selectObjectDeclarations(
        manifestOf({
          '@a/x:LicenseSale': licenseSaleListing('@a/x'),
          '@a/x:LicenseRefund': {
            ...licenseSaleListing('@a/x'),
            qualifiedName: '@a/x:LicenseRefund',
            className: 'LicenseRefund',
          },
        }),
      ),
    ).toHaveLength(2);
  });
});

describe('producer declaration emitters share the one-declaration-per-class selection (#3296)', () => {
  const manifest = {
    version: '1.0.0',
    timestamp: 0,
    objects: {
      '@ergot/market-ui:LicenseSale': licenseSaleListing('@ergot/market-ui'),
      '@ergot/market-core:LicenseSale':
        licenseSaleListing('@ergot/market-core'),
    },
  } as unknown as SmartObjectManifest;
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = resolve(
      import.meta.dirname,
      `__test-issue-3296-producer-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
  });

  afterEach(() => {
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('writes one interface into the Vite ambient virtual-modules.d.ts', async () => {
    await generateTypeDeclarationFile(manifest, tmpDir, 'types');
    const declarations = readFileSync(
      join(tmpDir, 'types', 'virtual-modules.d.ts'),
      'utf-8',
    );
    expect(
      countMatches(declarations, /export interface LicenseSaleData\b/g),
    ).toBe(1);
  });

  it('renders one interface in the server-mode @smrt/types module', () => {
    const interfaces = new ManifestGenerator().generateTypeDefinitions(
      manifest,
    );
    expect(
      countMatches(interfaces, /export interface LicenseSaleData\b/g),
    ).toBe(1);
  });
});
