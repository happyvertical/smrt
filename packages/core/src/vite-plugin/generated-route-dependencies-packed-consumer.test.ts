/**
 * Generated-route dependency detection against installed tarballs (#3913).
 * Core is packed from this workspace and installed into a clean pnpm
 * consumer with no workspace alias. smrt-users, smrt-app-runtime, and
 * smrt-dev-mcp are packed as minimal packages that carry their real
 * published `exports` maps (read from the workspace manifests, so they cannot
 * drift) with stub modules at the selected targets: this isolates resolution
 * from those packages' own runtime graphs, and keeps the test runnable in the
 * core CI shard, which builds only Core's dependency closure. The
 * `mcp-get-serializer-packed-consumer` test uses the same convention.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
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

const dependencies = [
  {
    name: '@happyvertical/smrt-users',
    dir: 'users',
    subpath: './sveltekit',
    source: 'export function createResourceListHandler() {}\n',
  },
  {
    name: '@happyvertical/smrt-app-runtime',
    dir: 'app-runtime',
    subpath: './sveltekit',
    source: 'export function createSmrtSvelteKitRuntime() {}\n',
  },
  {
    name: '@happyvertical/smrt-dev-mcp',
    dir: 'smrt-dev-mcp',
    subpath: './dev-plane',
    source: 'export function createDevPlane() {}\n',
  },
] as const;
const specifiers = dependencies.map(
  ({ name, subpath }) => `${name}${subpath.slice(1)}`,
);

function run(command: string, args: string[], cwd: string): void {
  const result = spawnSync(command, args, {
    cwd,
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 120_000,
  });
  expect(result.error, `${command} ${args.join(' ')}`).toBeUndefined();
  expect(
    result.status,
    `${command} ${args.join(' ')}\n${result.stdout}${result.stderr}`,
  ).toBe(0);
}

/** Pack a package with the workspace package's published export map. */
function packPublishedExports(
  dependency: (typeof dependencies)[number],
  sourceRoot: string,
  tarballs: string,
): string {
  const published = JSON.parse(
    readFileSync(
      resolve(workspaceRoot, 'packages', dependency.dir, 'package.json'),
      'utf8',
    ),
  ) as { exports: Record<string, Record<string, string>> };
  const target = published.exports[dependency.subpath];
  if (!target?.import || Object.hasOwn(target, 'require')) {
    throw new Error(
      `${dependency.name}${dependency.subpath} is no longer an import-only export; revisit #3913 coverage`,
    );
  }
  const source = join(sourceRoot, dependency.dir);
  for (const [condition, file] of Object.entries(target)) {
    const path = join(source, file);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      condition === 'types' ? 'export {};\n' : dependency.source,
    );
  }
  writeFileSync(
    join(source, 'package.json'),
    JSON.stringify({
      name: dependency.name,
      version: '0.0.0-test',
      type: 'module',
      exports: published.exports,
      files: ['dist'],
    }),
  );
  const destination = join(tarballs, dependency.dir);
  run('pnpm', ['pack', '--pack-destination', destination], source);
  const [tarball] = readdirSync(destination).filter((name) =>
    name.endsWith('.tgz'),
  );
  if (!tarball) throw new Error(`pnpm pack produced no ${dependency.name}`);
  return join(destination, tarball);
}

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
      packageNames: ['@happyvertical/smrt-core'],
    });
    const consumerPackagePath = join(consumer.directory, 'package.json');
    const consumerPackage = JSON.parse(
      readFileSync(consumerPackagePath, 'utf8'),
    ) as { dependencies: Record<string, string> };
    for (const dependency of dependencies) {
      consumerPackage.dependencies[dependency.name] =
        `file:${packPublishedExports(
          dependency,
          join(consumer.directory, 'route-dependency-sources'),
          join(consumer.directory, 'route-dependency-tarballs'),
        )}`;
    }
    writeFileSync(
      consumerPackagePath,
      `${JSON.stringify(consumerPackage, null, 2)}\n`,
    );
    run(
      'pnpm',
      ['install', '--ignore-scripts', '--no-frozen-lockfile'],
      consumer.directory,
    );

    // A workspace app with no node_modules of its own: every dependency is
    // hoisted to the consumer root (npm/yarn workspaces, pnpm hoisted).
    const hoistedRoot = join(consumer.directory, 'apps', 'web');
    mkdirSync(hoistedRoot, { recursive: true });
    writeFileSync(
      join(hoistedRoot, 'package.json'),
      JSON.stringify({ name: 'hoisted-web', private: true, type: 'module' }),
    );
    // A project that never installed the optional route dependencies. It is a
    // sibling of the consumer, under the same node_modules-free ancestor the
    // helper selected, so nothing can resolve upward into it.
    absentRoot = mkdtempSync(
      join(dirname(consumer.directory), '.smrt-route-deps-absent-'),
    );
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
