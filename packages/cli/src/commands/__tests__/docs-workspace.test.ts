/**
 * docs:agents at a pnpm workspace root (#4734).
 *
 * Builds a fixture consumer workspace (root + two members, packages installed
 * per member the way pnpm does) and drives the real handler against it.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkOkfBundleFreshness } from '@happyvertical/smrt-dev-mcp/knowledge';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireCommandHandler } from '../../__tests__/command-handler.js';
import { docsCommands } from '../docs-claude.js';
import { resolveDocsRoot } from '../docs-workspace.js';

let root: string;
let originalCwd: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

function install(
  installRoot: string,
  name: string,
  version: string,
  withPage = false,
): void {
  const dir = join(installRoot, 'node_modules', '@happyvertical', name);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: `@happyvertical/${name}`, version }),
  );
  writeFileSync(join(dir, 'AGENTS.md'), `# ${name}\n\nDocs for ${name}.`);
  if (withPage) {
    writeFileSync(
      join(dir, 'dist', 'smrt-knowledge.okf.md'),
      `---\ntype: "Component"\npackage_version: "0.0.0"\n---\n\n# ${name} ${version}\n`,
    );
  }
}

function member(path: string): string {
  const dir = join(root, path);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: path.replace('/', '-'), version: '0.0.0' }),
  );
  return dir;
}

function run(options: Record<string, unknown> = {}): Promise<void> {
  return requireCommandHandler(docsCommands['docs:agents'])([], options);
}

function printed(): string {
  return logSpy.mock.calls.map((call) => call[0]).join('\n');
}

describe('docs:agents in a pnpm workspace', () => {
  let appA: string;
  let appB: string;

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-docs-workspace-')));
    originalCwd = process.cwd();
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
    writeFileSync(join(root, 'package.json'), '{"name":"consumer"}');
    appA = member('apps/a');
    appB = member('apps/b');
    install(appA, 'smrt-core', '1.0.0', true);
    install(appB, 'smrt-core', '1.0.0', true);
    install(appA, 'smrt-jobs', '1.2.0', true);
    install(appB, 'smrt-jobs', '1.3.0', true);
    install(appB, 'ai', '2.0.0');
    process.chdir(root);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(root, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it('writes framework file, bundle and skills at the workspace root', async () => {
    await run();

    const framework = readFileSync(
      join(root, '.agents', 'smrt-framework.md'),
      'utf-8',
    );
    // Union of members, deduped by name+version.
    expect(framework.match(/\| @happyvertical\/smrt-core \|/g)).toHaveLength(1);
    expect(framework).toContain('| @happyvertical/smrt-core | 1.0.0 |');
    expect(framework).toContain('| @happyvertical/ai | 2.0.0 |');

    const bundle = join(root, '.agents', 'smrt-knowledge');
    expect(existsSync(join(bundle, 'components', 'smrt-core.md'))).toBe(true);
    expect(existsSync(join(bundle, 'bundle.json'))).toBe(true);
    for (const dir of ['.claude/skills', '.agents/skills']) {
      expect(existsSync(join(root, dir, 'smrt-catalog', 'SKILL.md'))).toBe(
        true,
      );
    }
    expect(existsSync(join(appA, '.agents'))).toBe(false);
    expect(printed()).toContain(`pnpm workspace root: ${root}`);
  });

  it('lists a package with version skew once, with each version', async () => {
    await run();

    const framework = readFileSync(
      join(root, '.agents', 'smrt-framework.md'),
      'utf-8',
    );
    expect(framework.match(/\| @happyvertical\/smrt-jobs \|/g)).toHaveLength(1);
    expect(framework).toContain(
      '| @happyvertical/smrt-jobs | 1.2.0 (apps/a), 1.3.0 (apps/b) |',
    );

    const bundleDir = join(root, '.agents', 'smrt-knowledge');
    const manifest = JSON.parse(
      readFileSync(join(bundleDir, 'bundle.json'), 'utf-8'),
    );
    const jobs = manifest.packages.find(
      (entry: { name: string }) => entry.name === '@happyvertical/smrt-jobs',
    );
    expect(jobs).toEqual({
      name: '@happyvertical/smrt-jobs',
      version: '1.3.0',
      versions: ['1.2.0', '1.3.0'],
      concept: '/components/smrt-jobs.md',
    });
    const core = manifest.packages.find(
      (entry: { name: string }) => entry.name === '@happyvertical/smrt-core',
    );
    expect(core.versions).toBeUndefined();
    // The highest version's page is exported.
    expect(
      readFileSync(join(bundleDir, 'components', 'smrt-jobs.md'), 'utf-8'),
    ).toContain('package_version: "1.3.0"');

    // The freshness gate understands a workspace bundle.
    const stale = checkOkfBundleFreshness(root, {
      installRoots: [root, appA, appB],
    }).filter((issue) => issue.code === 'stale-okf-bundle');
    expect(stale).toEqual([]);
  });

  it('is idempotent on rerun', async () => {
    await run();
    const first = readFileSync(
      join(root, '.agents', 'smrt-knowledge', 'bundle.json'),
      'utf-8',
    );
    await run();
    expect(
      readFileSync(
        join(root, '.agents', 'smrt-knowledge', 'bundle.json'),
        'utf-8',
      ),
    ).toBe(first);
  });

  it('resolves to the workspace root when run from inside a member', async () => {
    process.chdir(appA);
    await run();

    expect(existsSync(join(root, '.agents', 'smrt-framework.md'))).toBe(true);
    expect(existsSync(join(root, '.claude', 'skills', 'smrt-catalog'))).toBe(
      true,
    );
    expect(existsSync(join(appA, '.agents'))).toBe(false);
    expect(printed()).toContain(`pnpm workspace root: ${root}`);
    expect(printed()).toContain('--here');
  });

  it('--here keeps the member-local behaviour', async () => {
    process.chdir(appA);
    await run({ here: true });

    const framework = readFileSync(
      join(appA, '.agents', 'smrt-framework.md'),
      'utf-8',
    );
    expect(framework).toContain('| @happyvertical/smrt-jobs | 1.2.0 |');
    expect(framework).not.toContain('@happyvertical/ai');
    expect(existsSync(join(appA, '.claude', 'skills', 'smrt-catalog'))).toBe(
      true,
    );
    expect(existsSync(join(root, '.agents'))).toBe(false);
    expect(printed()).not.toContain('pnpm workspace root');
  });

  it('dry-run writes nothing and reports the root on stderr', async () => {
    await run({ 'dry-run': true });

    expect(existsSync(join(root, '.agents'))).toBe(false);
    expect(printed()).toContain('| @happyvertical/smrt-jobs |');
    expect(errorSpy.mock.calls.map((call) => call[0]).join('\n')).toContain(
      `pnpm workspace root: ${root}`,
    );
  });

  it('refuses a symlinked destination at the workspace root', async () => {
    const { symlinkSync } = await import('node:fs');
    mkdirSync(join(root, 'elsewhere'));
    mkdirSync(join(root, '.claude'));
    symlinkSync(join(root, 'elsewhere'), join(root, '.claude', 'skills'));

    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as never);
    await expect(run()).rejects.toThrow('process.exit called');
    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(existsSync(join(root, 'elsewhere', 'smrt-catalog'))).toBe(false);
  });
});

describe('resolveDocsRoot', () => {
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-docs-resolve-')));
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it('stays local outside a workspace', () => {
    expect(resolveDocsRoot({ cwd: root })).toEqual({
      root,
      installRoots: [root],
      workspace: false,
      liftedFromMember: false,
    });
  });

  it('does not treat the smrt repository as a consumer workspace', () => {
    writeFileSync(
      join(root, 'pnpm-workspace.yaml'),
      'packages:\n  - packages/*\n',
    );
    writeFileSync(join(root, 'package.json'), '{"name":"@happyvertical/smrt"}');
    const pkg = join(root, 'packages', 'x');
    mkdirSync(pkg, { recursive: true });
    expect(resolveDocsRoot({ cwd: pkg })).toMatchObject({
      root: pkg,
      workspace: false,
    });
  });

  it('lifts a member to the workspace root and honours here', () => {
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
    writeFileSync(join(root, 'package.json'), '{"name":"consumer"}');
    const app = join(root, 'apps', 'a');
    mkdirSync(app, { recursive: true });
    writeFileSync(join(app, 'package.json'), '{"name":"a"}');

    const lifted = resolveDocsRoot({ cwd: app });
    expect(lifted).toMatchObject({
      root,
      workspace: true,
      liftedFromMember: true,
    });
    expect(lifted.installRoots).toEqual([root, app]);
    expect(resolveDocsRoot({ cwd: app, here: true }).root).toBe(app);
  });

  it('lifts a directory nested inside a member to the workspace root', () => {
    writeFileSync(join(root, 'pnpm-workspace.yaml'), 'packages:\n  - apps/*\n');
    writeFileSync(join(root, 'package.json'), '{"name":"consumer"}');
    const app = join(root, 'apps', 'web');
    mkdirSync(join(app, 'src'), { recursive: true });
    writeFileSync(join(app, 'package.json'), '{"name":"web"}');
    expect(resolveDocsRoot({ cwd: join(app, 'src') })).toMatchObject({
      root,
      workspace: true,
      liftedFromMember: true,
    });
    expect(resolveDocsRoot({ cwd: root })).toMatchObject({
      root,
      liftedFromMember: false,
    });
  });

  it('stays local for a directory the workspace does not include', () => {
    writeFileSync(
      join(root, 'pnpm-workspace.yaml'),
      'packages:\n  - packages/*\n',
    );
    writeFileSync(join(root, 'package.json'), '{"name":"consumer"}');
    const scratch = join(root, 'scratch', 'site');
    mkdirSync(scratch, { recursive: true });
    expect(resolveDocsRoot({ cwd: scratch })).toEqual({
      root: scratch,
      installRoots: [scratch],
      workspace: false,
      liftedFromMember: false,
    });
  });
});
