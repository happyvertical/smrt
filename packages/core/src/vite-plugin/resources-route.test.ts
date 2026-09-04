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

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// Mock node:fs module (same pattern as changes-route.test.ts / events-route.test.ts)
vi.mock('node:fs', () => ({
  existsSync: vi.fn(),
  mkdirSync: vi.fn(),
  writeFileSync: vi.fn(),
  readFileSync: vi.fn(),
  readdirSync: vi.fn(),
  unlinkSync: vi.fn(),
}));

// consumerHasSmrtUsers resolves via node:module's createRequire rather than
// existsSync (see the module doc — a hardcoded physical path misses
// workspace-hoisted installs). Mock the require it constructs so each test
// controls whether resolution succeeds.
const mockResolve = vi.fn<(specifier: string) => string>();
vi.mock('node:module', () => ({
  createRequire: () => ({ resolve: mockResolve }),
}));

// Import after mocking
import {
  consumerHasSmrtUsers,
  generateResourcesRoute,
} from './resources-route';
import { AUTO_GENERATED_ROUTE_HEADER } from './route-header';
import type { SvelteKitOptions } from './sveltekit-generator';

const projectRoot = '/test/project';

const baseOptions: SvelteKitOptions = {
  enabled: true,
  routesDir: 'src/routes/api',
  objectsDir: 'src/lib/objects',
};

function resolveSmrtUsers(): void {
  mockResolve.mockImplementation((specifier) => {
    if (specifier === '@happyvertical/smrt-users/sveltekit') {
      return '/fake/node_modules/@happyvertical/smrt-users/dist/sveltekit.js';
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
