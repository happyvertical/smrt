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
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  consumerHasSmrtUsers,
  generateResourcesRoute,
  reservesResourcesRoute,
  willGenerateResourcesRoute,
} from './resources-route.js';
import {
  generateSvelteKitRoutes,
  type SvelteKitOptions,
} from './sveltekit-generator.js';

const options: SvelteKitOptions = {
  enabled: true,
  routesDir: 'src/routes/api',
  objectsDir: 'src/lib/objects',
};
describe('real consumer ESM resource dependency resolution (#4493)', () => {
  let directory: string;
  let projectRoot: string;
  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), 'smrt-resource-import-only-'));
    projectRoot = join(directory, 'apps', 'consumer');
    mkdirSync(projectRoot, { recursive: true });
    writeFileSync(
      join(projectRoot, 'package.json'),
      JSON.stringify({ name: '@test/resource-consumer', type: 'module' }),
    );
  });
  afterEach(() => rmSync(directory, { recursive: true, force: true }));
  function install(
    base = projectRoot,
    target = './sveltekit.js',
    exported = true,
    packageName = 'smrt-users',
  ) {
    const location = join(base, 'node_modules', '@happyvertical', packageName);
    mkdirSync(location, { recursive: true });
    writeFileSync(
      join(location, 'package.json'),
      JSON.stringify({
        name: `@happyvertical/${packageName}`,
        type: 'module',
        version: '1.0.0',
        exports: exported
          ? { './sveltekit': { types: './sveltekit.d.ts', import: target } }
          : { '.': { import: './sveltekit.js' } },
      }),
    );
    writeFileSync(
      join(location, 'sveltekit.js'),
      packageName === 'smrt-users'
        ? 'export function createResourceListHandler() {}\n'
        : 'export function createSmrtSvelteKitRuntime() {}\n',
    );
    writeFileSync(
      join(location, 'sveltekit.d.ts'),
      packageName === 'smrt-users'
        ? 'export declare function createResourceListHandler(): unknown;\n'
        : 'export declare function createSmrtSvelteKitRuntime(): unknown;\n',
    );
    return location;
  }
  const route = () =>
    join(projectRoot, options.routesDir, '_resources', '+server.ts');
  async function generatedConfig() {
    await generateSvelteKitRoutes(
      projectRoot,
      {
        version: '1',
        timestamp: 0,
        packageName: '@test/resource-consumer',
        objects: {},
      },
      options,
    );
    return readFileSync(join(projectRoot, 'src/lib/server/smrt.ts'), 'utf8');
  }
  it('selects the runtime config for an actual import-only app-runtime without inferring users', async () => {
    install(projectRoot, './sveltekit.js', true, 'smrt-app-runtime');
    expect(() =>
      createRequire(pathToFileURL(join(projectRoot, 'package.json'))).resolve(
        '@happyvertical/smrt-app-runtime/sveltekit',
      ),
    ).toThrow();
    expect(consumerHasSmrtUsers(projectRoot)).toBe(false);
    expect(await generatedConfig()).toContain('createSmrtSvelteKitRuntime');
    expect(existsSync(route())).toBe(false);
  });
  it('selects a hoisted import-only application runtime from the consumer', async () => {
    install(directory, './sveltekit.js', true, 'smrt-app-runtime');
    expect(await generatedConfig()).toContain('createSmrtSvelteKitRuntime');
  });
  it.each([
    'absent',
    'unexported',
    'missing',
    'directory',
  ] as const)('retains legacy config when app-runtime is %s', async (state) => {
    if (state !== 'absent') {
      const location = install(
        projectRoot,
        state === 'missing'
          ? './missing.js'
          : state === 'directory'
            ? './directory'
            : './sveltekit.js',
        state !== 'unexported',
        'smrt-app-runtime',
      );
      if (state === 'directory') mkdirSync(join(location, 'directory'));
    }
    expect(await generatedConfig()).not.toContain('createSmrtSvelteKitRuntime');
  });
  it('emits the route for a real import-only package that CommonJS cannot resolve', () => {
    install();
    expect(() =>
      createRequire(pathToFileURL(join(projectRoot, 'package.json'))).resolve(
        '@happyvertical/smrt-users/sveltekit',
      ),
    ).toThrow();
    expect(consumerHasSmrtUsers(projectRoot)).toBe(true);
    expect(willGenerateResourcesRoute(projectRoot, options)).toBe(true);
    expect(generateResourcesRoute(projectRoot, options)).toBe(true);
    expect(readFileSync(route(), 'utf8')).toContain(
      "import { createResourceListHandler } from '@happyvertical/smrt-users/sveltekit';",
    );
  });
  it('resolves an import-only package hoisted above the consumer root', () => {
    install(directory);
    expect(existsSync(join(projectRoot, 'node_modules'))).toBe(false);
    expect(consumerHasSmrtUsers(projectRoot)).toBe(true);
    expect(generateResourcesRoute(projectRoot, options)).toBe(true);
  });
  it('skips an absent dependency without resolving through the framework workspace', () => {
    expect(consumerHasSmrtUsers(projectRoot)).toBe(false);
    expect(generateResourcesRoute(projectRoot, options)).toBe(false);
    expect(existsSync(route())).toBe(false);
  });
  it('skips a package that does not export the actual imported subpath', () => {
    install(projectRoot, './sveltekit.js', false);
    expect(consumerHasSmrtUsers(projectRoot)).toBe(false);
    expect(generateResourcesRoute(projectRoot, options)).toBe(false);
  });
  it('skips missing and directory targets rather than emitting an unusable import', () => {
    const location = install(projectRoot, './missing.js');
    expect(consumerHasSmrtUsers(projectRoot)).toBe(false);
    expect(generateResourcesRoute(projectRoot, options)).toBe(false);
    writeFileSync(
      join(location, 'package.json'),
      JSON.stringify({
        name: '@happyvertical/smrt-users',
        type: 'module',
        exports: { './sveltekit': { import: './directory' } },
      }),
    );
    mkdirSync(join(location, 'directory'));
    expect(consumerHasSmrtUsers(projectRoot)).toBe(false);
  });
  it.each([
    '+server.ts',
    '+server.js',
  ])('preserves a handwritten %s with a real import-only dependency', (filename) => {
    install();
    const directory = join(projectRoot, options.routesDir, '_resources');
    mkdirSync(directory, { recursive: true });
    const existing = join(directory, filename);
    const handwritten =
      'export const GET = () => new Response("application-owned");\n';
    writeFileSync(existing, handwritten);
    expect(consumerHasSmrtUsers(projectRoot)).toBe(true);
    expect(willGenerateResourcesRoute(projectRoot, options)).toBe(false);
    expect(reservesResourcesRoute(projectRoot, options)).toBe(true);
    expect(generateResourcesRoute(projectRoot, options)).toBe(false);
    expect(readFileSync(existing, 'utf8')).toBe(handwritten);
  });
  it('retains explicit generation disablement for import-only consumers', () => {
    install();
    expect(
      generateResourcesRoute(projectRoot, {
        ...options,
        resourcesRoute: { enabled: false },
      }),
    ).toBe(false);
    expect(existsSync(route())).toBe(false);
  });
});
