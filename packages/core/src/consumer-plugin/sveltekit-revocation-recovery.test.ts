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
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { AUTO_GENERATED_ROUTE_HEADER } from '../vite-plugin/route-header.js';
import { smrtConsumer } from './index.js';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'smrt-consumer-route-recovery-'));
  const providerDir = join(projectRoot, 'node_modules', '@acme', 'widgets');
  mkdirSync(join(providerDir, 'dist'), { recursive: true });
  writeFileSync(
    join(projectRoot, 'package.json'),
    JSON.stringify({ name: 'consumer-route-recovery', private: true }),
  );
  writeFileSync(
    join(providerDir, 'package.json'),
    JSON.stringify({ name: '@acme/widgets', version: '1.0.0' }),
  );
  writeFileSync(
    join(providerDir, 'dist', 'manifest.json'),
    JSON.stringify({
      packageName: '@acme/widgets',
      objects: {
        '@acme/widgets:AddedLater': {
          className: 'AddedLater',
          qualifiedName: '@acme/widgets:AddedLater',
          collection: 'added-later',
          fields: {},
          methods: {},
          decoratorConfig: { api: { include: ['list', 'get'] } },
        },
        '@acme/widgets:Widget': {
          className: 'Widget',
          qualifiedName: '@acme/widgets:Widget',
          collection: 'widgets',
          fields: {},
          methods: {},
          decoratorConfig: { api: { include: ['list', 'get'] } },
        },
      },
    }),
  );
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

async function configureConsumer(svelteKit: unknown): Promise<void> {
  const plugin: any = smrtConsumer({
    packages: ['@acme/widgets'],
    projectRoot,
    disableScanning: true,
    generateTypes: false,
    ...(svelteKit === undefined ? {} : { svelteKit }),
  });
  const configHook = plugin.config;
  const handler =
    typeof configHook === 'function' ? configHook : configHook.handler;
  await handler({ root: projectRoot, plugins: [plugin] });
}

describe('consumer SvelteKit route ownership recovery', () => {
  it.each([
    ['svelteKit:false', false],
    ['legacy svelteKit:true', true],
    ['omitted svelteKit', undefined],
  ] as const)('revokes journaled partial output in a fresh config when %s', async (_label, disabledSvelteKit) => {
    await configureConsumer({
      objects: ['@acme/widgets:Widget'],
      routesDir: 'src/routes/hosted-a',
      changesRoute: { enabled: false },
      eventsRoute: { enabled: false },
      resourcesRoute: { enabled: false },
    });

    const priorHandler = join(
      projectRoot,
      'src/routes/hosted-a/widgets/+server.ts',
    );
    expect(
      readFileSync(priorHandler, 'utf8').startsWith(
        AUTO_GENERATED_ROUTE_HEADER,
      ),
    ).toBe(true);

    const blockedRouteDirectory = join(
      projectRoot,
      'src/routes/hosted-b/widgets',
    );
    mkdirSync(join(projectRoot, 'src/routes/hosted-b'), {
      recursive: true,
    });
    writeFileSync(blockedRouteDirectory, '// handwritten route blocker\n');

    await expect(
      configureConsumer({
        objects: ['@acme/widgets:AddedLater', '@acme/widgets:Widget'],
        routesDir: 'src/routes/hosted-b',
        changesRoute: { enabled: false },
        eventsRoute: { enabled: false },
        resourcesRoute: { enabled: false },
      }),
    ).rejects.toThrow();

    const partialHandler = join(
      projectRoot,
      'src/routes/hosted-b/added-later/+server.ts',
    );
    expect(
      readFileSync(partialHandler, 'utf8').startsWith(
        AUTO_GENERATED_ROUTE_HEADER,
      ),
    ).toBe(true);
    expect(
      JSON.parse(
        readFileSync(
          join(projectRoot, '.smrt/consumer-sveltekit-routes.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      routesDir: ['src/routes/hosted-a', 'src/routes/hosted-b'],
    });

    // A fresh plugin/config lifecycle must use the durable journal rather
    // than in-process coordinator state to remove both the prior complete
    // output and this post-journal partial output.
    await configureConsumer(disabledSvelteKit);

    expect(existsSync(priorHandler)).toBe(false);
    expect(existsSync(partialHandler)).toBe(false);
    expect(readFileSync(blockedRouteDirectory, 'utf8')).toBe(
      '// handwritten route blocker\n',
    );
    expect(
      existsSync(join(projectRoot, '.smrt/consumer-sveltekit-routes.json')),
    ).toBe(false);
  });
});
