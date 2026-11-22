import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AUTO_GENERATED_ROUTE_HEADER } from '../vite-plugin/route-header.js';
import { type SmrtConsumerOptions, smrtConsumer } from './index.js';

// Pass-through, so one test can fail a single route write (an I/O error
// during commit) and leave partial output behind.
const failedWrites = vi.hoisted(() => ({
  path: undefined as string | undefined,
}));
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const writeFileSync = ((path: unknown, ...rest: unknown[]) => {
    if (failedWrites.path !== undefined && String(path) === failedWrites.path) {
      throw Object.assign(new Error('EIO: injected write failure'), {
        code: 'EIO',
      });
    }
    return (actual.writeFileSync as (...args: unknown[]) => void)(
      path,
      ...rest,
    );
  }) as typeof actual.writeFileSync;
  return { ...actual, default: { ...actual, writeFileSync }, writeFileSync };
});

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
  failedWrites.path = undefined;
  rmSync(projectRoot, { recursive: true, force: true });
});

async function configureConsumer(
  svelteKit: SmrtConsumerOptions['svelteKit'],
): Promise<void> {
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
    ).rejects.toMatchObject({
      code: 'SMRT_ROUTE_OWNERSHIP_CONFLICT',
      phase: 'preflight',
      files: [blockedRouteDirectory],
    });

    // The route-ownership preflight refuses before the hooks run and before
    // any route file is written (#5437): the refused root is neither
    // journaled nor partially written.
    const partialHandler = join(
      projectRoot,
      'src/routes/hosted-b/added-later/+server.ts',
    );
    expect(existsSync(partialHandler)).toBe(false);
    expect(
      JSON.parse(
        readFileSync(
          join(projectRoot, '.smrt/consumer-sveltekit-routes.json'),
          'utf8',
        ),
      ),
    ).toMatchObject({
      routesDir: ['src/routes/hosted-a'],
    });

    // A fresh plugin/config lifecycle must use the durable journal rather
    // than in-process coordinator state to remove the prior complete output.
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

  it.each([
    ['svelteKit:false', false],
    ['legacy svelteKit:true', true],
    ['omitted svelteKit', undefined],
  ] as const)('revokes journaled partial output left by a failed route write in a fresh config when %s', async (_label, disabledSvelteKit) => {
    const hosted = {
      changesRoute: { enabled: false },
      eventsRoute: { enabled: false },
      resourcesRoute: { enabled: false },
    };
    await configureConsumer({
      ...hosted,
      objects: ['@acme/widgets:Widget'],
      routesDir: 'src/routes/hosted-a',
    });
    const priorHandler = join(
      projectRoot,
      'src/routes/hosted-a/widgets/+server.ts',
    );
    expect(readFileSync(priorHandler, 'utf8')).toContain(
      AUTO_GENERATED_ROUTE_HEADER,
    );

    // The commit writes added-later first, then fails on the widgets route.
    failedWrites.path = join(
      projectRoot,
      'src/routes/hosted-b/widgets/+server.ts',
    );
    await expect(
      configureConsumer({
        ...hosted,
        objects: ['@acme/widgets:AddedLater', '@acme/widgets:Widget'],
        routesDir: 'src/routes/hosted-b',
      }),
    ).rejects.toThrow(/EIO/);
    failedWrites.path = undefined;

    const partialHandler = join(
      projectRoot,
      'src/routes/hosted-b/added-later/+server.ts',
    );
    expect(readFileSync(partialHandler, 'utf8')).toContain(
      AUTO_GENERATED_ROUTE_HEADER,
    );
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

    // A fresh plugin/config lifecycle uses the durable journal to remove both
    // the prior complete output and the post-journal partial output.
    await configureConsumer(disabledSvelteKit);

    expect(existsSync(priorHandler)).toBe(false);
    expect(existsSync(partialHandler)).toBe(false);
    expect(
      existsSync(join(projectRoot, '.smrt/consumer-sveltekit-routes.json')),
    ).toBe(false);
  });

  it('the consumer route sweep never deletes application files', async () => {
    const hosted = {
      objects: ['@acme/widgets:Widget'],
      changesRoute: { enabled: false },
      eventsRoute: { enabled: false },
      resourcesRoute: { enabled: false },
    };
    await configureConsumer({ ...hosted, routesDir: 'src/routes/hosted-a' });

    const formerRoot = join(projectRoot, 'src/routes/hosted-a');
    const place = (segment: string, name: string, content: string) => {
      mkdirSync(join(formerRoot, segment), { recursive: true });
      const file = join(formerRoot, segment, name);
      writeFileSync(file, content);
      return file;
    };
    const generatedBody = `${AUTO_GENERATED_ROUTE_HEADER}\n// generated\n`;
    const banner = place(
      'banner',
      '+server.ts',
      `// project banner\n${generatedBody}`,
    );
    const javascript = place('javascript', '+server.js', generatedBody);
    const linkTarget = join(projectRoot, 'linked-handler.ts');
    writeFileSync(linkTarget, generatedBody);
    mkdirSync(join(formerRoot, 'linked'), { recursive: true });
    const link = join(formerRoot, 'linked', '+server.ts');
    symlinkSync(linkTarget, link);
    const bom = place('bom', '+server.ts', `﻿${generatedBody}`);
    const plain = place('plain', '+server.ts', generatedBody);

    await configureConsumer({ ...hosted, routesDir: 'src/routes/hosted-b' });

    expect(readFileSync(banner, 'utf8')).toBe(
      `// project banner\n${generatedBody}`,
    );
    expect(readFileSync(javascript, 'utf8')).toBe(generatedBody);
    expect(lstatSync(link).isSymbolicLink()).toBe(true);
    expect(readFileSync(linkTarget, 'utf8')).toBe(generatedBody);
    expect(existsSync(bom)).toBe(false);
    expect(existsSync(plain)).toBe(false);
    expect(
      existsSync(join(projectRoot, 'src/routes/hosted-b/widgets/+server.ts')),
    ).toBe(true);
  });
});
