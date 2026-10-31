/**
 * #3115: two packages can each declare a class with the same simple name and
 * keep separate tables (#3111/#3113). The consumer type generator keyed its
 * output by the simple class name, so `smrt-objects.d.ts` emitted
 * `export interface LicenseSaleData` twice (TypeScript silently merged both
 * field sets), `smrt-types.d.ts` emitted the alias twice, and the client/web
 * declarations typed both collections with the merged type.
 *
 * Generated names now follow the qualified identity when simple names collide,
 * and the generator reports the collision. The fixture runs the real
 * `smrtConsumer({ generateTypes: true })` build hook over two installed
 * providers and type-checks the emitted declarations together with a consumer
 * probe that reads each collection's row type.
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
  createObjectDeclarationIndex,
  warnObjectDeclarationCollisions,
} from '../manifest/object-declarations.js';
import type { SmartObjectManifest } from '../scanner/types.js';
import { generateTypeDeclarationFile } from '../vite-plugin/index.js';
import { smrtConsumer } from './index';

const MARKET_CORE = '@ergot/market-core';
const COMMERCE = '@happyvertical/smrt-commerce';

function marketCoreLicenseSale() {
  return {
    qualifiedName: `${MARKET_CORE}:LicenseSale`,
    className: 'LicenseSale',
    packageName: MARKET_CORE,
    name: 'licenseSale',
    collection: 'license-sales',
    filePath: '/build/ergot/packages/market-core/src/license-sale.ts',
    fields: {
      title: { type: 'text', required: true },
      seats: { type: 'integer' },
    },
    methods: {},
    decoratorConfig: { tableName: 'license_sales' },
  };
}

function commerceLicenseSale() {
  return {
    qualifiedName: `${COMMERCE}:LicenseSale`,
    className: 'LicenseSale',
    packageName: COMMERCE,
    name: 'licenseSale',
    collection: 'contracts',
    filePath: '/build/smrt/packages/commerce/src/license-sale.ts',
    fields: {
      contractNumber: { type: 'text', required: true },
      signedAt: { type: 'datetime' },
    },
    methods: {},
    decoratorConfig: { tableName: 'contracts' },
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

const GENERATED_FILES = [
  'smrt-objects.d.ts',
  'smrt-types.d.ts',
  'smrt-client.d.ts',
  'smrt-web.d.ts',
  'smrt-manifest.d.ts',
  'smrt-routes.d.ts',
  'smrt-mcp.d.ts',
];

/** Errors from compiling every generated declaration plus a consumer probe. */
function compileErrors(typesDir: string, probe: string): string[] {
  const probePath = join(typesDir, 'probe.ts');
  writeFileSync(probePath, probe);
  const program = ts.createProgram(
    [...GENERATED_FILES.map((file) => join(typesDir, file)), probePath],
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
    .map(
      (diagnostic) =>
        `${diagnostic.file?.fileName.split('/').pop()}: ${ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n')}`,
    );
}

describe('consumer type generation for distinct same-named classes (#3115)', () => {
  let tmpDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

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

  async function generate(packages: string[], typesDir: string) {
    await buildStart(
      smrtConsumer({
        packages,
        projectRoot: tmpDir,
        disableScanning: true,
        generateTypes: true,
        typesDir,
      }),
    );
    return join(tmpDir, typesDir);
  }

  beforeEach(() => {
    tmpDir = resolve(
      import.meta.dirname,
      `__test-issue-3115-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    writeFileSync(
      join(tmpDir, 'package.json'),
      JSON.stringify({ name: '@fixture/dashboard', version: '1.0.0' }),
    );
    writeProvider(MARKET_CORE, {
      [`${MARKET_CORE}:LicenseSale`]: marketCoreLicenseSale(),
    });
    writeProvider(COMMERCE, {
      [`${COMMERCE}:LicenseSale`]: commerceLicenseSale(),
    });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    logSpy.mockRestore();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('gives each class a qualified row type and types each collection with its own class', async () => {
    const typesDir = await generate(
      [MARKET_CORE, COMMERCE],
      'src/types/smrt-generated',
    );
    const read = (file: string) => readFileSync(join(typesDir, file), 'utf-8');
    const objects = read('smrt-objects.d.ts');
    const types = read('smrt-types.d.ts');
    const client = read('smrt-client.d.ts');
    const web = read('smrt-web.d.ts');

    // No merged bare declaration, one declaration per class.
    expect(objects).not.toMatch(/\bLicenseSaleData\b/);
    expect(
      countMatches(
        objects,
        /export interface ErgotMarketCoreLicenseSaleData\b/g,
      ),
    ).toBe(1);
    expect(
      countMatches(
        objects,
        /export interface HappyverticalSmrtCommerceLicenseSaleData\b/g,
      ),
    ).toBe(1);
    expect(types).toContain(
      "export type ErgotMarketCoreLicenseSaleData = import('./smrt-objects').ErgotMarketCoreLicenseSaleData;",
    );
    expect(types).toContain(
      "export type HappyverticalSmrtCommerceLicenseSaleData = import('./smrt-objects').HappyverticalSmrtCommerceLicenseSaleData;",
    );
    expect(client).toContain(
      `"license-sales": CrudOperations<import('./smrt-objects').ErgotMarketCoreLicenseSaleData>;`,
    );
    expect(client).toContain(
      `"contracts": CrudOperations<import('./smrt-objects').HappyverticalSmrtCommerceLicenseSaleData>;`,
    );
    expect(web).toContain(
      `"license-sales": SmrtWebCollectionDefinition<import('./smrt-objects').ErgotMarketCoreLicenseSaleData>;`,
    );
    expect(web).toContain(
      `"contracts": SmrtWebCollectionDefinition<import('./smrt-objects').HappyverticalSmrtCommerceLicenseSaleData>;`,
    );

    // The generator reports the collision and names both qualified types.
    const warnings = warnSpy.mock.calls.map((call) => String(call[0]));
    expect(
      warnings.some(
        (message) =>
          message.includes('"LicenseSale"') &&
          message.includes(
            `ErgotMarketCoreLicenseSaleData (${MARKET_CORE}:LicenseSale)`,
          ) &&
          message.includes(
            `HappyverticalSmrtCommerceLicenseSaleData (${COMMERCE}:LicenseSale)`,
          ),
      ),
    ).toBe(true);

    // Every generated file type-checks (including smrt-client.d.ts, whose row
    // types are now imported), and each collection carries only its own
    // class's fields: the `@ts-expect-error` lines fail if a row is `any` or a
    // merged type.
    expect(
      compileErrors(
        typesDir,
        `import type { ApiClient } from '@smrt/client';
import type { SmrtWebCollectionDefinitions } from '@smrt/web';
declare const client: ApiClient;
export async function probe(): Promise<void> {
  const sale = await client['license-sales'].get('1');
  const title: string = sale.title;
  // @ts-expect-error commerce-only field is not on the market-core row
  sale.contractNumber;
  const contract = await client.contracts.get('1');
  const contractNumber: string = contract.contractNumber;
  // @ts-expect-error market-core-only field is not on the commerce row
  contract.seats;
  type WebSale = NonNullable<SmrtWebCollectionDefinitions['license-sales']['_row']>;
  const webSeats: WebSale['seats'] = 1;
  void [title, contractNumber, webSeats];
}
`,
      ),
    ).toEqual([]);
  });

  it('is byte-identical regardless of provider aggregation order', async () => {
    const outputs: string[] = [];
    for (const [index, packages] of [
      [MARKET_CORE, COMMERCE],
      [COMMERCE, MARKET_CORE],
    ].entries()) {
      const typesDir = await generate(packages, `src/types/order-${index}`);
      outputs.push(
        GENERATED_FILES.map((file) =>
          readFileSync(join(typesDir, file), 'utf-8'),
        ).join('\n'),
      );
    }
    expect(outputs[1]).toBe(outputs[0]);
  });
});

function marketCoreLicenseSaleCollection() {
  return {
    qualifiedName: `${MARKET_CORE}:LicenseSaleCollection`,
    className: 'LicenseSaleCollection',
    packageName: MARKET_CORE,
    name: 'licenseSaleCollection',
    collection: 'license-sales',
    filePath: '/build/ergot/packages/market-core/src/license-sale.ts',
    extends: 'SmrtCollection',
    extendsTypeArg: 'LicenseSale',
    fields: {},
    methods: {},
    decoratorConfig: {},
  };
}

describe('Vite ambient declarations for distinct same-named classes (#3115)', () => {
  let tmpDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tmpDir = resolve(
      import.meta.dirname,
      `__test-issue-3115-ambient-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    );
    mkdirSync(tmpDir, { recursive: true });
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    if (existsSync(tmpDir)) rmSync(tmpDir, { recursive: true, force: true });
  });

  it('types the virt-client and virt-web modules, including a collection class, with each class row type', async () => {
    const manifest = {
      version: '1.0.0',
      timestamp: 0,
      objects: {
        [`${MARKET_CORE}:LicenseSale`]: marketCoreLicenseSale(),
        [`${MARKET_CORE}:LicenseSaleCollection`]:
          marketCoreLicenseSaleCollection(),
        [`${COMMERCE}:LicenseSale`]: commerceLicenseSale(),
      },
    } as unknown as SmartObjectManifest;
    await generateTypeDeclarationFile(manifest, tmpDir, 'types');
    const declarationPath = join(tmpDir, 'types', 'virtual-modules.d.ts');
    const declarations = readFileSync(declarationPath, 'utf-8');
    expect(declarations).not.toMatch(/\bLicenseSaleData\b/);
    expect(declarations).toContain(
      `"licenseSaleCollection": CrudOperations<import('@happyvertical/smrt-virt-types').ErgotMarketCoreLicenseSaleData>;`,
    );
    expect(warnSpy).toHaveBeenCalled();

    const probePath = join(tmpDir, 'probe.ts');
    writeFileSync(
      probePath,
      `import type { ApiClient } from '@happyvertical/smrt-virt-client';
import type { SmrtWebCollectionDefinitions } from '@happyvertical/smrt-virt-web';
declare const client: ApiClient;
export async function probe(): Promise<void> {
  const viaCollection = await client.licenseSaleCollection.get('1');
  const seats: number | undefined = viaCollection.seats;
  // @ts-expect-error commerce-only field is not on the market-core row
  viaCollection.contractNumber;
  const contract = await client.contracts.get('1');
  const contractNumber: string = contract.contractNumber;
  // @ts-expect-error market-core-only field is not on the commerce row
  contract.seats;
  type WebContract = NonNullable<SmrtWebCollectionDefinitions['contracts']['_row']>;
  const webNumber: WebContract['contractNumber'] = 'C-1';
  void [seats, contractNumber, webNumber];
}
`,
    );
    const program = ts.createProgram([declarationPath, probePath], {
      noEmit: true,
      strict: true,
      skipLibCheck: false,
      types: [],
      target: ts.ScriptTarget.ES2022,
      module: ts.ModuleKind.ESNext,
      moduleResolution: ts.ModuleResolutionKind.Bundler,
    });
    const errors = ts
      .getPreEmitDiagnostics(program)
      .filter(
        (diagnostic) =>
          diagnostic.category === ts.DiagnosticCategory.Error &&
          // The MCP and server modules import the installed core runtime and
          // Node builtins, which this bare program does not resolve; they are
          // unrelated to row types.
          !/@happyvertical\/smrt-core\/runtime|'node:/.test(
            ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
          ),
      )
      .map((diagnostic) =>
        ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'),
      );
    expect(errors).toEqual([]);
  });
});

describe('createObjectDeclarationIndex naming (#3115)', () => {
  function manifestOf(objects: Record<string, unknown>): SmartObjectManifest {
    return {
      version: '1.0.0',
      timestamp: 0,
      objects,
    } as unknown as SmartObjectManifest;
  }

  it('keeps simple names for unique classes and reports nothing', () => {
    const index = createObjectDeclarationIndex(
      manifestOf({ [`${MARKET_CORE}:LicenseSale`]: marketCoreLicenseSale() }),
    );
    expect(index.declarations.map((d) => d.interfaceName)).toEqual([
      'LicenseSaleData',
    ]);
    expect(index.collisions).toEqual([]);
    const log = vi.fn();
    warnObjectDeclarationCollisions(index, log);
    expect(log).not.toHaveBeenCalled();
  });

  it('resolves every listing of a collapsed class to its one name, and collection lookups by object', () => {
    const marketCore = marketCoreLicenseSale();
    const relisted = {
      ...marketCoreLicenseSale(),
      qualifiedName: '@ergot/market-ui:LicenseSale',
      packageName: '@ergot/market-ui',
    };
    const commerce = commerceLicenseSale();
    const index = createObjectDeclarationIndex(
      manifestOf({
        '@ergot/market-ui:LicenseSale': relisted,
        [`${MARKET_CORE}:LicenseSale`]: marketCore,
        [`${COMMERCE}:LicenseSale`]: commerce,
      }),
    );
    expect(index.interfaceNameFor(marketCore as never)).toBe(
      'ErgotMarketCoreLicenseSaleData',
    );
    expect(index.interfaceNameFor(relisted as never)).toBe(
      'ErgotMarketCoreLicenseSaleData',
    );
    expect(index.interfaceNameFor(commerce as never)).toBe(
      'HappyverticalSmrtCommerceLicenseSaleData',
    );
  });

  it('never lets a colliding class keep the bare name, even without a known package', () => {
    const unpackaged = (filePath: string) => ({
      ...marketCoreLicenseSale(),
      qualifiedName: undefined,
      packageName: undefined,
      filePath,
    });
    const index = createObjectDeclarationIndex(
      manifestOf({
        LicenseSale: unpackaged('/app/src/license-sale.ts'),
        [`${COMMERCE}:LicenseSale`]: commerceLicenseSale(),
      }),
    );
    const names = index.declarations.map((d) => d.interfaceName);
    expect(names).not.toContain('LicenseSaleData');
    expect(names).toEqual([
      'HappyverticalSmrtCommerceLicenseSaleData',
      'LicenseSale2Data',
    ]);
    const log = vi.fn();
    warnObjectDeclarationCollisions(index, log);
    expect(log).toHaveBeenCalledTimes(1);
    expect(String(log.mock.calls[0][0])).toContain(
      'LicenseSale2Data (LicenseSale)',
    );
  });

  it('names every listing of a collapsed declaration in the collision report', () => {
    const relisted = {
      ...marketCoreLicenseSale(),
      qualifiedName: '@ergot/admin:LicenseSale',
      packageName: '@ergot/admin',
    };
    const index = createObjectDeclarationIndex(
      manifestOf({
        '@ergot/admin:LicenseSale': relisted,
        [`${MARKET_CORE}:LicenseSale`]: marketCoreLicenseSale(),
        [`${COMMERCE}:LicenseSale`]: commerceLicenseSale(),
      }),
    );
    // The prefix is the first listing's package (documented); the report
    // lists the declaring package's listing too.
    expect(index.collisions[0]?.declarations[0]).toEqual({
      interfaceName: 'ErgotAdminLicenseSaleData',
      objectRefs: ['@ergot/admin:LicenseSale', `${MARKET_CORE}:LicenseSale`],
    });
  });

  it('never reuses a name another class already declares, and suffixes deterministically', () => {
    const index = createObjectDeclarationIndex(
      manifestOf({
        // A real class whose simple name equals one qualified candidate.
        '@other/pkg:ErgotMarketCoreLicenseSale': {
          ...marketCoreLicenseSale(),
          qualifiedName: '@other/pkg:ErgotMarketCoreLicenseSale',
          className: 'ErgotMarketCoreLicenseSale',
          packageName: '@other/pkg',
          filePath: '/build/other/src/x.ts',
        },
        [`${MARKET_CORE}:LicenseSale`]: marketCoreLicenseSale(),
        [`${COMMERCE}:LicenseSale`]: commerceLicenseSale(),
        // Same package and class, but no absolute path: cannot be proven to be
        // the same class, so it is a third declaration.
        LicenseSale: {
          ...marketCoreLicenseSale(),
          qualifiedName: undefined,
          filePath: 'src/license-sale.ts',
        },
      }),
    );
    const names = index.declarations.map((d) => d.interfaceName);
    expect(new Set(names).size).toBe(names.length);
    // Qualified-identity order: market-core, commerce, @other, bare key.
    expect(names).toEqual([
      'ErgotMarketCoreLicenseSale2Data',
      'HappyverticalSmrtCommerceLicenseSaleData',
      'ErgotMarketCoreLicenseSaleData',
      'ErgotMarketCoreLicenseSale3Data',
    ]);
  });
});
