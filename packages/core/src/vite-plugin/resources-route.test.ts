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

const smrtUsersPkgPath = join(
  projectRoot,
  'node_modules',
  '@happyvertical',
  'smrt-users',
  'package.json',
);
const routeFilePath = join(
  projectRoot,
  'src/routes/api',
  '_resources',
  '+server.ts',
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

  it('is true when node_modules/@happyvertical/smrt-users/package.json exists', () => {
    vi.mocked(existsSync).mockImplementation(
      (path) => String(path) === smrtUsersPkgPath,
    );
    expect(consumerHasSmrtUsers(projectRoot)).toBe(true);
  });

  it('is false when smrt-users is not present in node_modules', () => {
    vi.mocked(existsSync).mockReturnValue(false);
    expect(consumerHasSmrtUsers(projectRoot)).toBe(false);
  });
});

describe('generateResourcesRoute (#2663)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('emits the _resources route when smrt-users is resolvable', () => {
    vi.mocked(existsSync).mockImplementation(
      (path) => String(path) === smrtUsersPkgPath,
    );

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
    vi.mocked(existsSync).mockReturnValue(false);

    const generated = generateResourcesRoute(projectRoot, baseOptions);

    expect(generated).toBe(false);
    expect(writeFileSync).not.toHaveBeenCalled();
    expect(mkdirSync).not.toHaveBeenCalled();
  });

  it('preserves an existing hand-written _resources route instead of overwriting it', () => {
    // Both the smrt-users package AND a file already at the route path exist.
    vi.mocked(existsSync).mockImplementation((path) => {
      const p = String(path);
      return p === smrtUsersPkgPath || p === routeFilePath;
    });

    const generated = generateResourcesRoute(projectRoot, baseOptions);

    expect(generated).toBe(false);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('respects resourcesRoute.enabled === false even when smrt-users is present', () => {
    vi.mocked(existsSync).mockImplementation(
      (path) => String(path) === smrtUsersPkgPath,
    );

    const generated = generateResourcesRoute(projectRoot, {
      ...baseOptions,
      resourcesRoute: { enabled: false },
    });

    expect(generated).toBe(false);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('threads kebabRoutes into the generated handler options', () => {
    vi.mocked(existsSync).mockImplementation(
      (path) => String(path) === smrtUsersPkgPath,
    );

    generateResourcesRoute(projectRoot, { ...baseOptions, kebabRoutes: true });

    const content = writtenRouteContent();
    expect(content).toContain('kebabRoutes: true,');
  });
});
