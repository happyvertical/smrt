import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { generateDevPlaneRoute } from './dev-plane-route.js';
import { AUTO_GENERATED_ROUTE_HEADER } from './route-header.js';
import type { SvelteKitOptions } from './sveltekit-generator.js';

vi.mock('node:fs', async () => {
  const actual = await vi.importActual<typeof import('node:fs')>('node:fs');
  return {
    ...actual,
    existsSync: vi.fn(),
    mkdirSync: vi.fn(),
    writeFileSync: vi.fn(),
  };
});
vi.mock('node:module', async () => {
  const actual =
    await vi.importActual<typeof import('node:module')>('node:module');
  return {
    ...actual,
    createRequire: () => ({
      resolve: (id: string) => {
        if (id === '@happyvertical/smrt-dev-mcp/dev-plane')
          return '/consumer/node_modules/x.js';
        throw new Error(`Cannot find module '${id}'`);
      },
    }),
  };
});

const base: SvelteKitOptions = {
  enabled: true,
  routesDir: 'src/routes/api',
  objectsDir: 'src/lib/objects',
};

describe('generateDevPlaneRoute (#2782)', () => {
  beforeEach(() => {
    vi.mocked(writeFileSync).mockReset();
    vi.mocked(existsSync).mockReturnValue(false);
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('is opt-in and writes nothing by default', () => {
    expect(generateDevPlaneRoute('/consumer', base)).toBe(false);
    expect(
      generateDevPlaneRoute('/consumer', {
        ...base,
        devPlaneRoute: { enabled: false },
      }),
    ).toBe(false);
    expect(writeFileSync).not.toHaveBeenCalled();
  });

  it('emits a dev-only, token-gated catch-all route importing the dev-plane', () => {
    expect(
      generateDevPlaneRoute('/consumer', {
        ...base,
        devPlaneRoute: { enabled: true },
      }),
    ).toBe(true);
    expect(mkdirSync).toHaveBeenCalled();
    const [path, content] = vi.mocked(writeFileSync).mock.calls[0] as [
      string,
      string,
    ];
    expect(path).toBe('/consumer/src/routes/api/_dev/[...tool]/+server.ts');
    expect(content.startsWith(AUTO_GENERATED_ROUTE_HEADER)).toBe(true);
    expect(content).toContain("import { dev } from '$app/environment'");
    expect(content).toContain("from '@happyvertical/smrt-dev-mcp/dev-plane'");
    expect(content).toContain("from '$lib/server/smrt'");
    expect(content).toContain('SMRT_DEV_MCP_TOKEN');
    expect(content).toContain('if (!dev) throw error(404');
    expect(content).toContain('export const GET = handle');
    expect(content).toContain('export const POST = handle');
  });

  it('honours a custom config path and file name', () => {
    generateDevPlaneRoute('/consumer', {
      ...base,
      devPlaneRoute: { enabled: true },
      configPath: 'src/lib/server/infra',
      configFileName: 'smrt-config.ts',
    });
    const [, content] = vi.mocked(writeFileSync).mock.calls[0] as [
      string,
      string,
    ];
    expect(content).toContain("from '$lib/server/infra/smrt-config'");
  });
});
