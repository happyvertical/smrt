/**
 * Generated-route dependency detection against real installed tarballs
 * (#3913). Core, smrt-users, smrt-app-runtime, and smrt-dev-mcp are packed
 * from this workspace and installed into a clean pnpm consumer, so the
 * detectors see the published `types`/`import`-only subpath exports exactly
 * as an application does — no workspace alias or fixture export map.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const packageDir = resolve(import.meta.dirname, '../..');
const workspaceRoot = resolve(packageDir, '../..');

interface PackedConsumer {
  directory: string;
  cleanup: () => void;
}

interface PackedConsumerModule {
  createPackedConsumer(input: {
    root: string;
    packageNames: string[];
  }): PackedConsumer;
}

interface LayoutReport {
  resourcesRoute: boolean;
  devPlaneRoute: boolean;
  runtimeConfig: boolean;
  requireResolves: Record<string, boolean>;
  importResolves: Record<string, string | null>;
}

const specifiers = [
  '@happyvertical/smrt-users/sveltekit',
  '@happyvertical/smrt-app-runtime/sveltekit',
  '@happyvertical/smrt-dev-mcp/dev-plane',
];

describe('generated route dependencies in a packed consumer (#3913)', () => {
  let consumer: PackedConsumer | undefined;
  let absentRoot: string | undefined;
  let report: Record<'direct' | 'hoisted' | 'absent', LayoutReport>;

  beforeAll(async () => {
    const { createPackedConsumer } = (await import(
      pathToFileURL(resolve(workspaceRoot, 'scripts/packed-consumer.mjs')).href
    )) as PackedConsumerModule;
    consumer = createPackedConsumer({
      root: workspaceRoot,
      packageNames: [
        '@happyvertical/smrt-core',
        '@happyvertical/smrt-users',
        '@happyvertical/smrt-app-runtime',
        '@happyvertical/smrt-dev-mcp',
      ],
    });

    // A workspace app with no node_modules of its own: every dependency is
    // hoisted to the consumer root (npm/yarn workspaces, pnpm hoisted).
    const hoistedRoot = join(consumer.directory, 'apps', 'web');
    mkdirSync(hoistedRoot, { recursive: true });
    writeFileSync(
      join(hoistedRoot, 'package.json'),
      JSON.stringify({ name: 'hoisted-web', private: true, type: 'module' }),
    );
    // A project that never installed the optional route dependencies. It is
    // outside the consumer tree so nothing can resolve upward into it.
    absentRoot = mkdtempSync(join(tmpdir(), 'smrt-route-deps-absent-'));
    writeFileSync(
      join(absentRoot, 'package.json'),
      JSON.stringify({ name: 'absent-web', private: true, type: 'module' }),
    );

    const script = join(consumer.directory, 'detect-routes.mjs');
    writeFileSync(
      script,
      `import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateSvelteKitRoutes } from '@happyvertical/smrt-core/vite-plugin';

const specifiers = ${JSON.stringify(specifiers)};
const options = {
  enabled: true,
  routesDir: 'src/routes/api',
  objectsDir: 'src/lib/objects',
  devPlaneRoute: { enabled: true },
};
const report = {};
for (const [layout, projectRoot] of Object.entries(JSON.parse(process.argv[2]))) {
  const anchor = pathToFileURL(join(projectRoot, 'package.json')).href;
  const requireFrom = createRequire(anchor);
  // Node's own ESM resolver, from a module inside the project root.
  const probe = join(projectRoot, 'resolve-probe.mjs');
  writeFileSync(probe, \`export const resolved = Object.fromEntries(\${JSON.stringify(specifiers)}.map((specifier) => {
  try { return [specifier, import.meta.resolve(specifier)]; } catch { return [specifier, null]; }
}));
\`);
  const { resolved } = await import(pathToFileURL(probe).href);
  rmSync(probe);
  await generateSvelteKitRoutes(
    projectRoot,
    { version: '1', timestamp: 0, packageName: layout, objects: {} },
    options,
  );
  const config = join(projectRoot, 'src/lib/server/smrt.ts');
  report[layout] = {
    resourcesRoute: existsSync(join(projectRoot, 'src/routes/api/_resources/+server.ts')),
    devPlaneRoute: existsSync(join(projectRoot, 'src/routes/api/_dev/[...tool]/+server.ts')),
    runtimeConfig: existsSync(config) && readFileSync(config, 'utf8').includes('createSmrtSvelteKitRuntime'),
    requireResolves: Object.fromEntries(specifiers.map((specifier) => {
      try { requireFrom.resolve(specifier); return [specifier, true]; } catch { return [specifier, false]; }
    })),
    importResolves: resolved,
  };
}
console.log(JSON.stringify(report));
`,
    );
    const result = spawnSync(
      process.execPath,
      [
        script,
        JSON.stringify({
          direct: consumer.directory,
          hoisted: hoistedRoot,
          absent: absentRoot,
        }),
      ],
      {
        cwd: consumer.directory,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
        timeout: 120_000,
      },
    );
    expect(result.error).toBeUndefined();
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const lines = String(result.stdout).trim().split('\n');
    report = JSON.parse(lines[lines.length - 1] ?? '{}');
  }, 600_000);

  afterAll(() => {
    consumer?.cleanup();
    if (absentRoot) rmSync(absentRoot, { recursive: true, force: true });
  });

  it('installs real import-only subpaths that a CommonJS probe cannot resolve', () => {
    for (const specifier of specifiers) {
      expect(report.direct.requireResolves[specifier], specifier).toBe(false);
      expect(report.direct.importResolves[specifier], specifier).toMatch(
        /\/node_modules\/\.pnpm\/.+\.js$/,
      );
    }
  });

  it('emits every dependency-gated route for a direct install', () => {
    expect(report.direct).toMatchObject({
      resourcesRoute: true,
      devPlaneRoute: true,
      runtimeConfig: true,
    });
  });

  it('emits every dependency-gated route for an app hoisted below the install', () => {
    expect(report.hoisted).toMatchObject({
      resourcesRoute: true,
      devPlaneRoute: true,
      runtimeConfig: true,
    });
    expect(report.hoisted.importResolves).toEqual(report.direct.importResolves);
  });

  it('skips every dependency-gated route when the packages are absent', () => {
    expect(report.absent).toMatchObject({
      resourcesRoute: false,
      devPlaneRoute: false,
      runtimeConfig: false,
    });
    for (const specifier of specifiers) {
      expect(report.absent.importResolves[specifier], specifier).toBeNull();
    }
  });

  it('leaves no route behind in the absent project', () => {
    expect(
      existsSync(join(absentRoot ?? '', 'src/routes/api/_resources')),
    ).toBe(false);
  });
});
