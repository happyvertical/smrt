/**
 * Generation never overwrites or shadows an application route file.
 *
 * A route file is generator output only when it is a `+server.ts` starting
 * with the generated-route header. When application code occupies a path the
 * generator needs, generation fails with an error naming the file, before it
 * changes the route tree, on the producer's direct path and the coordinated
 * path alike. Application files at paths the generator does not need are
 * left alone.
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
import { dirname, join } from 'node:path';
import { resolveConfig } from 'vite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ApplicationRouteConflictError,
  findApplicationServerModule,
  writeGeneratedRouteFile,
} from './generated-route-ownership.js';
import { smrtPlugin } from './index.js';
import { AUTO_GENERATED_ROUTE_HEADER } from './route-header.js';

const MODEL = `import { SmrtObject, smrt } from '@happyvertical/smrt-core';

@smrt({ api: { routes: { archive: { method: 'POST' } } } })
export class OwnedTicket extends SmrtObject {
  title = '';

  async archive(): Promise<boolean> {
    return true;
  }
}
`;

const APPLICATION_ROUTE = 'export const GET = () => new Response("mine");\n';

const SVELTEKIT = {
  enabled: true,
  routesDir: 'src/routes/api',
  objectsDir: 'src/lib/objects',
} as const;

let projectRoot: string;
const route = (path: string) => join(projectRoot, 'src/routes/api', path);

function writeApplicationFile(file: string, content = APPLICATION_ROUTE) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
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
  projectRoot = mkdtempSync(join(tmpdir(), 'smrt-route-ownership-'));
  mkdirSync(join(projectRoot, 'src/lib/objects'), { recursive: true });
  mkdirSync(join(projectRoot, 'src/lib/server'), { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ name: '@fixture/route-ownership', type: 'module' }),
  );
  writeFileSync(join(projectRoot, 'src/lib/objects/OwnedTicket.ts'), MODEL);
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
])('%s and application route files', (_label, generate) => {
  it.each([
    ['the collection route', 'ownedtickets/+server.ts'],
    ['the item route', 'ownedtickets/[id]/+server.ts'],
    ['a custom-action route', 'ownedtickets/[id]/archive/+server.ts'],
    ['the change-feed route', '_changes/+server.ts'],
    ['the events route', '_events/+server.ts'],
    ['an item route, as +server.js', 'ownedtickets/[id]/+server.js'],
  ])('fails naming an application file at %s and changes nothing', async (_name, path) => {
    await generate();
    const generatedCollection = readFileSync(
      route('ownedtickets/+server.ts'),
      'utf-8',
    );
    const occupied = route(path);
    writeApplicationFile(occupied);

    const failure = generate();
    await expect(failure).rejects.toBeInstanceOf(ApplicationRouteConflictError);
    await expect(failure).rejects.toThrow(occupied);

    expect(readFileSync(occupied, 'utf-8')).toBe(APPLICATION_ROUTE);
    if (path !== 'ownedtickets/+server.ts') {
      // Nothing was swept: the earlier generated routes are still there.
      expect(readFileSync(route('ownedtickets/+server.ts'), 'utf-8')).toBe(
        generatedCollection,
      );
    }
  });

  it('fails naming an application file at the knowledge route', async () => {
    writeFileSync(
      join(projectRoot, 'smrt.config.json'),
      JSON.stringify({ knowledge: { api: { enabled: true } } }),
    );
    const knowledge = join(
      projectRoot,
      'src/routes/__smrt/knowledge/+server.ts',
    );
    writeApplicationFile(knowledge);

    await expect(generate()).rejects.toThrow(knowledge);
    expect(readFileSync(knowledge, 'utf-8')).toBe(APPLICATION_ROUTE);
  });

  it('leaves application files at paths it does not generate', async () => {
    const own = route('ownedtickets/export/+server.ts');
    const resources = route('_resources/+server.ts');
    writeApplicationFile(own);
    writeApplicationFile(resources);

    await generate();

    expect(readFileSync(own, 'utf-8')).toBe(APPLICATION_ROUTE);
    expect(readFileSync(resources, 'utf-8')).toBe(APPLICATION_ROUTE);
    expect(
      readFileSync(route('ownedtickets/+server.ts'), 'utf-8').startsWith(
        AUTO_GENERATED_ROUTE_HEADER,
      ),
    ).toBe(true);
  });

  it('regenerates over its own earlier output', async () => {
    await generate();
    await generate();

    expect(
      readFileSync(route('ownedtickets/[id]/+server.ts'), 'utf-8').startsWith(
        AUTO_GENERATED_ROUTE_HEADER,
      ),
    ).toBe(true);
  });
});

describe('writeGeneratedRouteFile', () => {
  const content = `${AUTO_GENERATED_ROUTE_HEADER}\nexport const GET = () => new Response('ok');\n`;

  it('writes a route into an empty directory and over generated output', () => {
    const dir = join(projectRoot, 'routes', 'thing');
    const file = writeGeneratedRouteFile(dir, content, 'the thing route');
    expect(readFileSync(file, 'utf-8')).toBe(content);
    writeGeneratedRouteFile(dir, `${content}// again\n`, 'the thing route');
    expect(readFileSync(file, 'utf-8')).toContain('// again');
    expect(findApplicationServerModule(dir)).toBeUndefined();
  });

  it.each([
    '+server.ts',
    '+server.js',
  ])('refuses a directory holding an application %s', (name) => {
    const dir = join(projectRoot, 'routes', 'taken');
    writeApplicationFile(join(dir, name));

    expect(() =>
      writeGeneratedRouteFile(dir, content, 'the taken route'),
    ).toThrow(ApplicationRouteConflictError);
    expect(readFileSync(join(dir, name), 'utf-8')).toBe(APPLICATION_ROUTE);
    if (name === '+server.js') {
      expect(existsSync(join(dir, '+server.ts'))).toBe(false);
    }
  });
});
