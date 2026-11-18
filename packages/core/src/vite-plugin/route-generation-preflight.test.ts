/**
 * Route generation validates every object's routes before it sweeps the
 * generated route tree, so a failed generation leaves the previous routes in
 * place. Covers the producer's direct path (`configResolved` without a config
 * hook) and the coordinated path (Vite config hook through the coordinator).
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveConfig } from 'vite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { smrtPlugin } from './index.js';
import { AUTO_GENERATED_ROUTE_HEADER } from './route-header.js';

const VALID_MODEL = `import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({ api: { routes: { archive: { method: 'POST' } } } })
export class PreflightTicket extends SmrtObject {
  title = '';

  async archive(): Promise<boolean> {
    return true;
  }
}
`;

/** Two methods that resolve to the same generated handler (POST /…/close). */
const DUPLICATE_ROUTE_MODEL = `import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  api: {
    routes: {
      archive: { method: 'POST', path: 'close' },
      dismiss: { method: 'POST', path: 'close' },
    },
  },
})
export class PreflightTicket extends SmrtObject {
  title = '';

  async archive(): Promise<boolean> {
    return true;
  }

  async dismiss(): Promise<boolean> {
    return true;
  }
}
`;

const SVELTEKIT = {
  enabled: true,
  routesDir: 'src/routes/api',
  objectsDir: 'src/lib/objects',
} as const;

let projectRoot: string;
const collectionRoute = () =>
  join(projectRoot, 'src/routes/api/preflighttickets/+server.ts');
const itemRoute = () =>
  join(projectRoot, 'src/routes/api/preflighttickets/[id]/+server.ts');

function writeModel(source: string): void {
  writeFileSync(
    join(projectRoot, 'src/lib/objects/PreflightTicket.ts'),
    source,
  );
}

async function generateDirect(): Promise<void> {
  const plugin = smrtPlugin({
    include: ['src/**/*.ts'],
    generateTypes: false,
    svelteKit: SVELTEKIT,
  });
  await (plugin as any).configResolved({
    root: projectRoot,
    build: {},
    plugins: [],
  });
}

async function generateCoordinated(): Promise<void> {
  await resolveConfig(
    {
      root: projectRoot,
      configFile: false,
      logLevel: 'silent',
      plugins: [
        smrtPlugin({
          include: ['src/**/*.ts'],
          generateTypes: false,
          svelteKit: SVELTEKIT,
        }),
      ],
    },
    'build',
  );
}

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'smrt-route-preflight-'));
  mkdirSync(join(projectRoot, 'src/lib/objects'), { recursive: true });
  mkdirSync(join(projectRoot, 'src/lib/server'), { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ name: '@fixture/route-preflight', type: 'module' }),
  );
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(projectRoot, { recursive: true, force: true });
});

describe.each([
  ['direct producer generation', generateDirect],
  ['coordinated generation', generateCoordinated],
])('%s validates before it removes generated routes', (_label, generate) => {
  it('keeps the previous generated routes when an object has two handlers for one route', async () => {
    writeModel(VALID_MODEL);
    await generate();
    expect(
      readFileSync(collectionRoute(), 'utf-8').startsWith(
        AUTO_GENERATED_ROUTE_HEADER,
      ),
    ).toBe(true);
    expect(existsSync(itemRoute())).toBe(true);

    writeModel(DUPLICATE_ROUTE_MODEL);
    await expect(generate()).rejects.toThrow(
      /Duplicate custom API route handler/,
    );

    expect(existsSync(collectionRoute())).toBe(true);
    expect(existsSync(itemRoute())).toBe(true);
    expect(
      existsSync(
        join(
          projectRoot,
          'src/routes/api/preflighttickets/[id]/archive/+server.ts',
        ),
      ),
    ).toBe(true);
  });

  it('still regenerates routes for a valid change', async () => {
    writeModel(VALID_MODEL);
    await generate();
    writeModel(VALID_MODEL.replace("title = '';", "title = '';\n  body = '';"));
    await generate();

    expect(readFileSync(collectionRoute(), 'utf-8')).toContain(
      AUTO_GENERATED_ROUTE_HEADER,
    );
  });

  it('refuses an object whose static action takes the item route path', async () => {
    writeModel(`import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({ api: { routes: { lookup: { path: '[id]', scope: 'collection' } } } })
export class PreflightTicket extends SmrtObject {
  title = '';

  static async lookup(): Promise<boolean> {
    return true;
  }
}
`);
    await expect(generate()).rejects.toThrow(/Conflicting SvelteKit route/);
  });

  it('refuses a collection named sync whose apply action would replace the sync-apply route', async () => {
    writeModel(`import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({
  collection: 'sync',
  api: { routes: { apply: { scope: 'collection', method: 'POST' } } },
})
export class PreflightTicket extends SmrtObject {
  title = '';

  static async apply(): Promise<boolean> {
    return true;
  }
}
`);
    await expect(generate()).rejects.toThrow(/Conflicting SvelteKit route/);
  });
});
