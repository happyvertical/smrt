import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildKnowledgeIndex, checkKnowledgeFreshness } from './index.js';

/**
 * Counts the directories discovery actually opens.
 *
 * The module under test reads directories through `readdirSync` and
 * `opendirSync`, so mocking `node:fs` here is what makes traversal observable —
 * a spy on the `fs` namespace would not be, because the transitive glob
 * machinery captures its adapter at import time. `vi.hoisted` keeps the array
 * defined before the hoisted factory closes over it.
 */
const openedDirs = vi.hoisted(() => [] as string[]);
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const record =
    <Fn extends (...args: never[]) => unknown>(fn: Fn) =>
    (path: never, ...rest: never[]) => {
      openedDirs.push(String(path));
      return fn(path, ...(rest as never[]));
    };
  return {
    ...actual,
    default: actual,
    readdirSync: record(
      actual.readdirSync as (...args: never[]) => unknown,
    ) as typeof actual.readdirSync,
    opendirSync: record(
      actual.opendirSync as (...args: never[]) => unknown,
    ) as typeof actual.opendirSync,
  };
});

/**
 * The consumer-app case: an application that installs the published packages
 * rather than authoring them (#2275).
 *
 * The fixture is deliberately shaped like a real pnpm install — a store whose
 * entries link back out to each other, reachable through a dot directory — and
 * the whole file hangs rather than fails on the pre-fix code. That is the
 * regression: discovery re-walked the same real directories once per path that
 * reached them until the heap ran out.
 */
describe('knowledge index in a consumer app', () => {
  let rootDir: string;

  const AGENT_DOC = '# smrt-content\n\nPublished package guidance.\n';
  const CORE_DOC = '# smrt-core\n\nFoundation guidance.\n';
  /**
   * Enough packages for the sibling links to form a branching cycle rather than
   * a single loop. A kernel gives up on one self-referential link after
   * MAXSYMLINKS hops, but a clique multiplies into `(n-1) ** MAXSYMLINKS`
   * distinct paths to the same real directories — which is the shape that
   * exhausted the heap on a real install.
   */
  const INSTALLED = [
    'smrt-content',
    'smrt-core',
    'smrt-jobs',
    'smrt-tenancy',
    'smrt-users',
    'smrt-web',
  ];

  async function write(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }

  /** Where pnpm materializes a package inside the virtual store. */
  function storeDir(name: string, version: string): string {
    return join(
      rootDir,
      'node_modules',
      '.pnpm',
      `@happyvertical+${name}@${version}`,
      'node_modules',
      '@happyvertical',
      name,
    );
  }

  async function writeInstalledPackage(options: {
    name: string;
    version: string;
    agentDoc: string;
    objects: string[];
  }): Promise<void> {
    const directory = storeDir(options.name, options.version);
    await write(
      join(directory, 'package.json'),
      JSON.stringify({
        name: `@happyvertical/${options.name}`,
        version: options.version,
        files: ['dist', 'AGENTS.md', 'CLAUDE.md'],
        exports: {
          '.': { import: './dist/index.js' },
          './smrt-knowledge.json': './dist/smrt-knowledge.json',
        },
      }),
    );
    await write(join(directory, 'AGENTS.md'), options.agentDoc);
    await write(join(directory, 'CLAUDE.md'), '@AGENTS.md');
    await write(
      join(directory, 'dist', 'smrt-knowledge.json'),
      JSON.stringify({
        schemaVersion: 1,
        generatedAt: new Date().toISOString(),
        packageName: `@happyvertical/${options.name}`,
        packageVersion: options.version,
        sourceHashes: {},
        exports: ['.', './smrt-knowledge.json'],
        dependencies: {},
        smrtDependencies: [],
        sdkDependencies: [],
        tags: [],
        risks: [],
        objects: options.objects.map((name) => ({
          name,
          qualifiedName: `@happyvertical/${options.name}:${name}`,
          collection: `${name.toLowerCase()}s`,
          fields: [],
          relationships: [],
          methods: [],
          surfaces: [],
          relationshipFeatures: [],
          tags: [],
          risks: [],
        })),
        surfaces: [],
        prompts: [],
        relationshipsV2: {
          foreignKeyFields: 0,
          crossPackageRefFields: 0,
          junctionCollections: 0,
          hierarchicalObjects: 0,
          polymorphicAssociations: 0,
          uuidColumns: 0,
        },
      }),
    );
    // The store entry's own scope directory, which is where pnpm puts the
    // sibling links that close the graph.
    mkdirSync(join(directory, 'node_modules', '@happyvertical'), {
      recursive: true,
    });
  }

  /** Links `from` to `to` inside the store, the way pnpm wires peers. */
  function linkSibling(from: string, to: string): void {
    symlinkSync(
      storeDir(to, '1.0.0'),
      join(storeDir(from, '1.0.0'), 'node_modules', '@happyvertical', to),
    );
  }

  beforeEach(async () => {
    openedDirs.length = 0;
    rootDir = mkdtempSync(join(tmpdir(), 'smrt-consumer-app-'));

    // A single-package application: no workspace globs, no packages/ directory.
    await write(
      join(rootDir, 'package.json'),
      JSON.stringify({
        name: 'demo-app',
        version: '0.0.1',
        private: true,
        dependencies: Object.fromEntries(
          INSTALLED.map((name) => [`@happyvertical/${name}`, '1.0.0']),
        ),
      }),
    );
    await write(
      join(rootDir, 'AGENTS.md'),
      '# demo-app\n\nApplication guide.\n',
    );
    await write(join(rootDir, 'CLAUDE.md'), '@AGENTS.md');
    await write(join(rootDir, 'src', 'app.ts'), 'export const app = 1;\n');

    for (const name of INSTALLED) {
      await writeInstalledPackage({
        name,
        version: '1.0.0',
        agentDoc: name === 'smrt-core' ? CORE_DOC : AGENT_DOC,
        objects: [name === 'smrt-content' ? 'Article' : 'Placeholder'],
      });
    }

    // Cross-links between store entries: this is the cycle that made a
    // recursive descent non-terminating.
    for (const from of INSTALLED) {
      for (const to of INSTALLED.filter((name) => name !== from)) {
        linkSibling(from, to);
      }
    }

    // The project's public scope directory, symlinked into the store as pnpm
    // does for direct dependencies.
    mkdirSync(join(rootDir, 'node_modules', '@happyvertical'), {
      recursive: true,
    });
    for (const name of INSTALLED) {
      symlinkSync(
        storeDir(name, '1.0.0'),
        join(rootDir, 'node_modules', '@happyvertical', name),
      );
    }

    // A framework cache directory holding a second copy of the same graph.
    // Dot directories were the hole in the ignore patterns: nothing beneath one
    // was pruned, so the walk fell straight into this store.
    mkdirSync(join(rootDir, '.svelte-kit', 'output'), { recursive: true });
    symlinkSync(
      join(rootDir, 'node_modules'),
      join(rootDir, '.svelte-kit', 'output', 'node_modules'),
    );
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('reports every installed @happyvertical package under scope installed', async () => {
    const index = await buildKnowledgeIndex({ rootDir, scope: 'installed' });

    expect(index.packages.map((pkg) => pkg.name)).toEqual(
      INSTALLED.map((name) => `@happyvertical/${name}`).sort(),
    );

    const content = index.packages.find(
      (pkg) => pkg.name === '@happyvertical/smrt-content',
    );
    expect(content?.version).toBe('1.0.0');
    expect(content?.hasAgentsMd).toBe(true);
    expect(content?.isInstalledDependency).toBe(true);
    expect(content?.exportKeys).toEqual(['.', './smrt-knowledge.json']);
    expect(content?.objectSource).toBe('domain-artifact');
    expect(content?.objects.map((object) => object.className)).toEqual([
      'Article',
    ]);
  });

  it('hashes each shipped AGENTS.md so a consumer can diff documentation drift', async () => {
    const index = await buildKnowledgeIndex({ rootDir, scope: 'installed' });
    const content = index.packages.find(
      (pkg) => pkg.name === '@happyvertical/smrt-content',
    );

    expect(content?.agentDocSha256).toBe(
      createHash('sha256').update(AGENT_DOC).digest('hex'),
    );
    // A version bump is not the signal; the doc hash is. Two packages on the
    // same version must still be distinguishable by what they document.
    const core = index.packages.find(
      (pkg) => pkg.name === '@happyvertical/smrt-core',
    );
    expect(core?.version).toBe(content?.version);
    expect(core?.agentDocSha256).not.toBe(content?.agentDocSha256);
  });

  it('resolves each installed package exactly once despite the symlink graph', async () => {
    const index = await buildKnowledgeIndex({ rootDir, scope: 'project' });
    const installedNames = index.installedPackages.map((pkg) => pkg.name);

    expect(installedNames).toEqual([...new Set(installedNames)]);
    expect(installedNames).toEqual(
      INSTALLED.map((name) => `@happyvertical/${name}`).sort(),
    );
    // The application itself stays in the index alongside its dependencies.
    expect(index.packages.map((pkg) => pkg.name)).toContain('demo-app');
  });

  it('enumerates the scope directory instead of walking node_modules', async () => {
    await buildKnowledgeIndex({ rootDir, scope: 'installed' });

    const inStore = openedDirs.filter((path) =>
      path.includes(join('node_modules', '.pnpm')),
    );
    // Every package is reachable from every other one, so a descent would read
    // the store's directories over and over. Resolution reads the project's
    // `@happyvertical` scope directory and stats each entry once instead, so
    // the store itself is never opened.
    expect(inStore).toEqual([]);
    expect(
      openedDirs.filter((path) => path.includes('node_modules')),
    ).toHaveLength(1);
  });

  it('keeps installed dependencies out of the workspace-authored scopes', async () => {
    for (const scope of ['local', 'package'] as const) {
      const index = await buildKnowledgeIndex({ rootDir, scope });
      expect(index.packages.map((pkg) => pkg.name)).toEqual(['demo-app']);
    }

    // SMRT packages are not SDK packages, so the SDK scope stays empty here.
    const sdk = await buildKnowledgeIndex({ rootDir, scope: 'sdk' });
    expect(sdk.packages).toEqual([]);
  });

  it('does not fail freshness on documentation a consumer cannot author', async () => {
    const result = await checkKnowledgeFreshness({ rootDir });

    expect(result.issues.map((issue) => issue.packageName)).not.toContain(
      '@happyvertical/smrt-content',
    );
    expect(result.ok).toBe(true);
  });

  it('does not report a discovery failure when only dependencies carry objects', async () => {
    const index = await buildKnowledgeIndex({ rootDir });

    expect(index.diagnostics.map((entry) => entry.code)).not.toContain(
      'no-smrt-objects-discovered',
    );
    // The project's own packages still contributed nothing, and a workspace
    // that is supposed to declare @smrt() classes needs to hear about it.
    expect(index.diagnostics.map((entry) => entry.code)).toContain(
      'no-authored-smrt-objects',
    );
  });
});

/**
 * A workspace whose own packages are linked into each other's `node_modules`,
 * which is how pnpm wires an internal dependency. Those links resolve to
 * authored source, and calling that source an installed dependency would
 * quietly exempt it from every rule in the freshness gate (#2275).
 */
describe('workspace packages reached through node_modules links', () => {
  let rootDir: string;

  async function write(path: string, content: string): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }

  async function writeWorkspacePackage(name: string): Promise<void> {
    const directory = join(rootDir, 'packages', name.split('/')[1] as string);
    await write(
      join(directory, 'package.json'),
      JSON.stringify({
        name,
        version: '1.0.0',
        files: ['dist', 'AGENTS.md', 'CLAUDE.md'],
        exports: { '.': { import: './dist/index.js' } },
      }),
    );
    await write(join(directory, 'AGENTS.md'), `# ${name}\n\nAuthored.\n`);
    await write(join(directory, 'CLAUDE.md'), '@AGENTS.md');
  }

  beforeEach(async () => {
    rootDir = mkdtempSync(join(tmpdir(), 'smrt-workspace-links-'));
    await write(
      join(rootDir, 'pnpm-workspace.yaml'),
      "packages:\n  - 'packages/*'\n",
    );
    await write(
      join(rootDir, 'package.json'),
      JSON.stringify({
        name: 'demo-workspace',
        version: '0.0.1',
        private: true,
      }),
    );
    await write(join(rootDir, 'AGENTS.md'), '# demo-workspace\n');
    await write(join(rootDir, 'CLAUDE.md'), '@AGENTS.md');

    // One `smrt-*` name and one SDK-allowlist name: only the second is
    // vulnerable, because `dedupePackages` lets an `sdk`-kind entry be replaced.
    await writeWorkspacePackage('@happyvertical/smrt-widgets');
    await writeWorkspacePackage('@happyvertical/utils');

    for (const [consumer, dependency] of [
      ['smrt-widgets', '@happyvertical/utils'],
      ['utils', '@happyvertical/smrt-widgets'],
    ] as const) {
      const scope = join(
        rootDir,
        'packages',
        consumer,
        'node_modules',
        '@happyvertical',
      );
      mkdirSync(scope, { recursive: true });
      symlinkSync(
        join(rootDir, 'packages', dependency.split('/')[1] as string),
        join(scope, dependency.split('/')[1] as string),
      );
    }
  });

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true });
  });

  it('keeps linked workspace packages authored, not installed', async () => {
    const index = await buildKnowledgeIndex({ rootDir });
    const byName = new Map(index.packages.map((pkg) => [pkg.name, pkg]));

    expect(
      byName.get('@happyvertical/smrt-widgets')?.isInstalledDependency,
    ).toBe(false);
    expect(byName.get('@happyvertical/utils')?.isInstalledDependency).toBe(
      false,
    );
    expect(index.installedPackages).toEqual([]);
  });

  it('still gates linked workspace packages in the freshness check', async () => {
    // `@happyvertical/utils` is exempt for an unrelated, pre-existing reason —
    // an SDK-allowlist name is `kind: 'sdk'` wherever it lives — so the gate is
    // asserted through the linked `smrt-*` package instead.
    await writeFile(
      join(rootDir, 'packages', 'smrt-widgets', 'CLAUDE.md'),
      '# not a shim\n',
    );

    const result = await checkKnowledgeFreshness({ rootDir });

    expect(
      result.issues.map((issue) => `${issue.packageName}:${issue.code}`),
    ).toContain('@happyvertical/smrt-widgets:claude-not-shim');
  });
});
