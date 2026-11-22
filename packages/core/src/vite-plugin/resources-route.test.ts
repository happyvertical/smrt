/**
 * Tests for the generated SvelteKit `_resources` CLI discovery route
 * (issue #2663).
 *
 * Tests the generator, not the generated output at runtime (same approach as
 * `changes-route.test.ts` / `events-route.test.ts`): assert the emitted
 * route file's location and load-bearing content, plus the guard behavior
 * that makes this emitter different from its siblings — it must NEVER emit
 * an import that cannot resolve, and must NEVER clobber a hand-written
 * route.
 */

import { existsSync, mkdirSync, openSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock node:fs module (same pattern as changes-route.test.ts / events-route.test.ts)
vi.mock('node:fs', () => {
  const existsSync = vi.fn();
  return {
    existsSync,
    // Route ownership lstats planned paths: every directory exists, and an
    // endpoint file exists exactly when the existsSync fixture says so.
    lstatSync: vi.fn((path: string) => {
      const endpoint = /\+server\.[jt]s$/.test(String(path));
      if (endpoint && !existsSync(path)) {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      }
      return {
        isFile: () => endpoint,
        isDirectory: () => !endpoint,
        isSymbolicLink: () => false,
      };
    }),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
    // Writers open, then write to the descriptor (here: the path).
    openSync: vi.fn((path: string) => path),
    closeSync: vi.fn(),
    readFileSync: vi.fn(() => '// hand-written route\n'),
    readdirSync: vi.fn(),
    unlinkSync: vi.fn(),
    statSync: vi.fn(() => ({ isFile: () => true })),
  };
});

// Resolve the exact generated import under ESM conditions from the consumer.
// Real import-only/hoisted/missing target fixtures live in resources-route-resolution.test.ts.
const mockResolve = vi.fn<(specifier: string, parent: string) => string>();
vi.mock('import-meta-resolve', () => ({
  resolve: (specifier: string, parent: string) =>
    mockResolve(specifier, parent),
}));

// Import after mocking
import { RouteFilePlan } from './generated-route-files';
import {
  consumerHasSmrtUsers,
  generateResourcesRoute as generateResourcesRouteInto,
} from './resources-route';
import { AUTO_GENERATED_ROUTE_HEADER } from './route-header';
import type { SvelteKitOptions } from './sveltekit-generator';

/** Plan, check and commit the route as the generator does; true if written. */
function generateResourcesRoute(
  root: string,
  options: SvelteKitOptions,
): boolean {
  const plan = new RouteFilePlan();
  generateResourcesRouteInto(root, options, plan);
  plan.preflight();
  return plan.commit().length > 0;
}

const projectRoot = '/test/project';

const baseOptions: SvelteKitOptions = {
  enabled: true,
  routesDir: 'src/routes/api',
  objectsDir: 'src/lib/objects',
};

function resolveSmrtUsers(): void {
  mockResolve.mockImplementation((specifier) => {
    if (specifier === '@happyvertical/smrt-users/sveltekit') {
      return 'file:///fake/node_modules/@happyvertical/smrt-users/dist/sveltekit.js';
    }
    throw Object.assign(new Error(`Cannot find module '${specifier}'`), {
      code: 'MODULE_NOT_FOUND',
    });
  });
}

function doNotResolveSmrtUsers(): void {
  mockResolve.mockImplementation((specifier) => {
    throw Object.assign(new Error(`Cannot find module '${specifier}'`), {
      code: 'MODULE_NOT_FOUND',
    });
  });
}

const routeFilePath = join(
  projectRoot,
  'src/routes/api',
  '_resources',
  '+server.ts',
);
const routeFilePathJs = join(
  projectRoot,
  'src/routes/api',
  '_resources',
  '+server.js',
);

function writtenRouteContent(): string {
  const call = vi
    .mocked(writeFileSync)
    .mock.calls.find(
      (args) => typeof args[0] === 'string' && args[0].endsWith('+server.ts'),
    );
  expect(call).toBeDefined();
  return String(call?.[1]);
}

describe('consumerHasSmrtUsers (#2663)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('is true when @happyvertical/smrt-users/sveltekit resolves', () => {
    resolveSmrtUsers();
    expect(consumerHasSmrtUsers(projectRoot)).toBe(true);
    expect(mockResolve).toHaveBeenCalledWith(
      '@happyvertical/smrt-users/sveltekit',
      pathToFileURL(join(projectRoot, 'package.json')).href,
    );
  });

  it('is false when smrt-users is not resolvable', () => {
    doNotResolveSmrtUsers();
    expect(consumerHasSmrtUsers(projectRoot)).toBe(false);
  });
});

describe('generateResourcesRoute (#2663)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits the _resources route when smrt-users is resolvable', () => {
    resolveSmrtUsers();
    vi.mocked(existsSync).mockReturnValue(false);

    const generated = generateResourcesRoute(projectRoot, baseOptions);

    expect(generated).toBe(true);
    expect(mkdirSync).toHaveBeenCalledWith(
      join(projectRoot, 'src/routes/api', '_resources'),
      { recursive: true },
    );
    // Created exclusively, then written through the descriptor (the mocked
    // descriptor is the path).
    expect(openSync).toHaveBeenCalledWith(routeFilePath, 'wx');
    expect(writeFileSync).toHaveBeenCalledWith(
      routeFilePath,
      expect.any(String),
      'utf-8',
    );

    const content = writtenRouteContent();
    expect(content).toContain(AUTO_GENERATED_ROUTE_HEADER);
    expect(content).toContain(
      "import { createResourceListHandler } from '@happyvertical/smrt-users/sveltekit';",
    );
    expect(content).toContain("import '$lib/server/smrt';");
    // #3416: registration no longer depends on the app's config module.
    expect(content.indexOf("import '$lib/server/smrt-register';")).toBeLessThan(
      content.indexOf("import '$lib/server/smrt';"),
    );
    expect(content).toContain("import '$lib/server/smrt-register';");
    expect(content).toContain('export const GET = createResourceListHandler({');
    expect(content).toContain('ensureRegistry: async () => {');
  });

  it('does not emit the _resources route when smrt-users is absent', () => {
    doNotResolveSmrtUsers();
    vi.mocked(existsSync).mockReturnValue(false);

    const generated = generateResourcesRoute(projectRoot, baseOptions);

    expect(generated).toBe(false);
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(mkdirSync).not.toHaveBeenCalled();
  });

  it('preserves an existing hand-written +server.ts route instead of overwriting it', () => {
    resolveSmrtUsers();
    vi.mocked(existsSync).mockImplementation(
      (path) => String(path) === routeFilePath,
    );

    const generated = generateResourcesRoute(projectRoot, baseOptions);

    expect(generated).toBe(false);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('preserves an existing hand-written +server.js route instead of writing +server.ts alongside it', () => {
    // Regression test: a .ts-only existence check is blind to a
    // hand-written +server.js, so the generator would previously write
    // +server.ts next to it and SvelteKit would refuse the route with
    // "Multiple endpoint files found".
    resolveSmrtUsers();
    vi.mocked(existsSync).mockImplementation(
      (path) => String(path) === routeFilePathJs,
    );

    const generated = generateResourcesRoute(projectRoot, baseOptions);

    expect(generated).toBe(false);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('respects resourcesRoute.enabled === false even when smrt-users is present', () => {
    resolveSmrtUsers();
    vi.mocked(existsSync).mockReturnValue(false);

    const generated = generateResourcesRoute(projectRoot, {
      ...baseOptions,
      resourcesRoute: { enabled: false },
    });

    expect(generated).toBe(false);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('threads kebabRoutes into the generated handler options', () => {
    resolveSmrtUsers();
    vi.mocked(existsSync).mockReturnValue(false);

    generateResourcesRoute(projectRoot, { ...baseOptions, kebabRoutes: true });

    const content = writtenRouteContent();
    expect(content).toContain('kebabRoutes: true,');
  });
});
