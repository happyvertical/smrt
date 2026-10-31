/**
 * Real-filesystem consumer resolution for the generated `_dev` route (#3913).
 * `@happyvertical/smrt-dev-mcp/dev-plane` is published with only `types` and
 * `import` conditions, so the detector must use ESM resolution anchored at
 * the consumer rather than a CommonJS `createRequire(...).resolve` probe.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { consumerResolvesImport } from './consumer-import.js';
import {
  consumerHasSmrtDevMcp,
  generateDevPlaneRoute,
  willGenerateDevPlaneRoute,
} from './dev-plane-route.js';
import type { SvelteKitOptions } from './sveltekit-generator.js';

const specifier = '@happyvertical/smrt-dev-mcp/dev-plane';
const options: SvelteKitOptions = {
  enabled: true,
  routesDir: 'src/routes/api',
  objectsDir: 'src/lib/objects',
  devPlaneRoute: { enabled: true },
};
// The published export shape, read from the real package so the fixture can
// never drift from what consumers install.
const publishedDevPlaneExport = (
  JSON.parse(
    readFileSync(
      resolve(import.meta.dirname, '../../../smrt-dev-mcp/package.json'),
      'utf8',
    ),
  ) as { exports: Record<string, unknown> }
).exports['./dev-plane'] as { types: string; import: string };

describe('generated _dev route consumer ESM resolution (#3913)', () => {
  let directory: string;
  let projectRoot: string;
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    directory = mkdtempSync(join(tmpdir(), 'smrt-dev-plane-import-only-'));
    projectRoot = join(directory, 'apps', 'consumer');
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({ name: '@test/dev-plane-consumer', type: 'module' }),
    );
  });
  afterEach(() => {
    vi.restoreAllMocks();
    rmSync(directory, { recursive: true, force: true });
  });

  function install(
    base = projectRoot,
    exportsMap: unknown = { './dev-plane': publishedDevPlaneExport },
  ) {
    const location = join(
      base,
      'node_modules',
      '@happyvertical',
      'smrt-dev-mcp',
    );
    mkdirSync(join(location, 'dist'), { recursive: true });
    writeFileSync(
      join(location, 'package.json'),
      JSON.stringify({
        name: '@happyvertical/smrt-dev-mcp',
        type: 'module',
        version: '1.0.0',
        exports: exportsMap,
      }),
    );
    writeFileSync(
      join(location, 'dist/dev-plane.js'),
      'export function createDevPlane() {}\n',
    );
    writeFileSync(
      join(location, 'dist/dev-plane.d.ts'),
      'export declare function createDevPlane(): unknown;\n',
    );
    return location;
  }
  const route = () =>
    join(projectRoot, options.routesDir, '_dev', '[...tool]', '+server.ts');

  it('publishes the dev-plane subpath with import conditions only', () => {
    expect(Object.keys(publishedDevPlaneExport).sort()).toEqual([
      'import',
      'types',
    ]);
  });

  it('emits the route for an installed import-only dev-plane that CommonJS cannot resolve', () => {
    install();
    expect(() =>
      createRequire(pathToFileURL(join(projectRoot, 'package.json'))).resolve(
        specifier,
      ),
    ).toThrow();
    expect(consumerHasSmrtDevMcp(projectRoot)).toBe(true);
    expect(willGenerateDevPlaneRoute(projectRoot, options)).toBe(true);
    expect(generateDevPlaneRoute(projectRoot, options)).toBe(true);
    expect(readFileSync(route(), 'utf8')).toContain(`from '${specifier}'`);
  });

  it('resolves a dev-plane hoisted above the consumer root', () => {
    install(directory);
    expect(existsSync(join(projectRoot, 'node_modules'))).toBe(false);
    expect(consumerHasSmrtDevMcp(projectRoot)).toBe(true);
    expect(generateDevPlaneRoute(projectRoot, options)).toBe(true);
  });

  it('skips an absent package without resolving through the framework workspace', () => {
    expect(consumerHasSmrtDevMcp(projectRoot)).toBe(false);
    expect(generateDevPlaneRoute(projectRoot, options)).toBe(false);
    expect(existsSync(route())).toBe(false);
  });

  it('skips a package that does not export the dev-plane subpath', () => {
    install(projectRoot, { '.': { import: './dist/dev-plane.js' } });
    expect(consumerHasSmrtDevMcp(projectRoot)).toBe(false);
    expect(generateDevPlaneRoute(projectRoot, options)).toBe(false);
  });

  it.each([
    ['missing', './dist/missing.js'],
    ['directory', './dist'],
  ])('skips a %s export target', (_state, target) => {
    install(projectRoot, { './dev-plane': { import: target } });
    expect(consumerHasSmrtDevMcp(projectRoot)).toBe(false);
    expect(generateDevPlaneRoute(projectRoot, options)).toBe(false);
  });

  it('stays opt-in even when the dev-plane resolves', () => {
    install();
    expect(
      generateDevPlaneRoute(projectRoot, {
        ...options,
        devPlaneRoute: { enabled: false },
      }),
    ).toBe(false);
    expect(existsSync(route())).toBe(false);
  });

  it('shares one resolver for every generated-route dependency', () => {
    install();
    expect(consumerResolvesImport(projectRoot, specifier)).toBe(true);
    expect(
      consumerResolvesImport(
        projectRoot,
        '@happyvertical/smrt-users/sveltekit',
      ),
    ).toBe(false);
  });
});
