/**
 * docs:agents / docs:claude handler tests.
 *
 * Drives the command handlers against a temp project whose node_modules contains
 * fake @happyvertical/smrt-* and SDK packages, exercising discoverInstalledPackages,
 * discoverSdkPackages, loadPackageInfo, loadAgentDoc, and loadRootDocs. Uses
 * --dry-run to assert generated content, plus a real write to assert file output.
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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { docsCommands } from '../docs-claude.js';

let tempDir: string;
let originalCwd: string;
let logSpy: ReturnType<typeof vi.spyOn>;
let warnSpy: ReturnType<typeof vi.spyOn>;

function makePackage(
  scope: string,
  name: string,
  opts: {
    version?: string;
    agents?: string;
    claude?: string;
    readme?: string;
    pkgName?: string;
  } = {},
): void {
  const dir = join(tempDir, 'node_modules', scope, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({
      name: opts.pkgName ?? `${scope}/${name}`,
      version: opts.version ?? '1.0.0',
    }),
    'utf-8',
  );
  if (opts.agents !== undefined) {
    writeFileSync(join(dir, 'AGENTS.md'), opts.agents, 'utf-8');
  }
  if (opts.claude !== undefined) {
    writeFileSync(join(dir, 'CLAUDE.md'), opts.claude, 'utf-8');
  }
  if (opts.readme !== undefined) {
    writeFileSync(join(dir, 'README.md'), opts.readme, 'utf-8');
  }
}

describe('docs:agents handler', () => {
  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-docs-handler-')));
    originalCwd = process.cwd();
    process.chdir(tempDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    logSpy.mockRestore();
    warnSpy.mockRestore();
  });

  it('generates markdown from installed SMRT and SDK packages (dry-run)', async () => {
    makePackage('@happyvertical', 'smrt-content', {
      version: '2.0.0',
      agents: '# smrt-content\n\nContent docs here.',
    });
    // A package whose CLAUDE.md is just the @AGENTS.md shim -> treated as no doc.
    makePackage('@happyvertical', 'smrt-core', {
      claude: '@AGENTS.md',
    });
    // SDK (non-smrt) package with a CLAUDE.md fallback doc.
    makePackage('@happyvertical', 'ai', {
      claude: '# ai\n\nAI client docs.',
    });

    await docsCommands['docs:agents'].handler([], { 'dry-run': true });

    const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('# SMRT Framework Context');
    expect(printed).toContain('| @happyvertical/smrt-content | 2.0.0 |');
    expect(printed).toContain('## Installed SDK Packages');
    expect(printed).toContain('| @happyvertical/ai | 1.0.0 |');
    expect(printed).toContain('Content docs here.');
    // smrt-core has only the shim CLAUDE.md, so it reports no AGENTS.md.
    expect(printed).toContain('*No AGENTS.md found for this package.*');
  });

  it('writes the output file and reports package counts', async () => {
    makePackage('@happyvertical', 'smrt-content', {
      agents: '# smrt-content\n\nDocs.',
      readme: '## Usage\n\nUse it.',
    });

    await docsCommands['docs:agents'].handler([], {});

    const outputPath = join(tempDir, '.agents', 'smrt-framework.md');
    expect(existsSync(outputPath)).toBe(true);
    const content = readFileSync(outputPath, 'utf-8');
    expect(content).toContain('@happyvertical/smrt-content');
    const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('Generated');
    expect(printed).toContain('1 with AGENTS.md');
  });

  it('exits with an error when no @happyvertical packages are found', async () => {
    mkdirSync(join(tempDir, 'node_modules'), { recursive: true });
    const exitSpy = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('process.exit called');
    }) as any);

    await expect(
      docsCommands['docs:agents'].handler([], { 'dry-run': true }),
    ).rejects.toThrow('process.exit called');

    expect(exitSpy).toHaveBeenCalledWith(1);
    exitSpy.mockRestore();
  });

  it('docs:claude warns about deprecation and uses the .claude output path', async () => {
    makePackage('@happyvertical', 'smrt-content', {
      agents: '# smrt-content\n\nDocs.',
    });

    await docsCommands['docs:claude'].handler([], {});

    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('deprecated'));
    expect(existsSync(join(tempDir, '.claude', 'smrt-framework.md'))).toBe(
      true,
    );
  });

  it('includes framework root docs when run from a monorepo root', async () => {
    // Make tempDir look like a monorepo root so detectMonorepoRoot + loadRootDocs run.
    writeFileSync(
      join(tempDir, 'pnpm-workspace.yaml'),
      "packages:\n  - 'packages/*'\n",
      'utf-8',
    );
    mkdirSync(join(tempDir, 'packages'), { recursive: true });
    writeFileSync(
      join(tempDir, 'AGENTS.md'),
      '# Root Agents\n\nFramework overview text.',
      'utf-8',
    );
    writeFileSync(
      join(tempDir, 'CONTRIBUTING.md'),
      '# Contributing\n\nHow to contribute.',
      'utf-8',
    );
    makePackage('@happyvertical', 'smrt-content', {
      agents: '# smrt-content\n\nDocs.',
    });

    await docsCommands['docs:agents'].handler([], { 'dry-run': true });

    const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('## Framework Documentation');
    expect(printed).toContain('Framework overview text.');
    expect(printed).toContain('*Source: CONTRIBUTING.md*');
  });

  it('skips a package whose package.json cannot be parsed', async () => {
    // Valid package alongside one with broken package.json -> the broken one is
    // skipped via loadPackageInfo's catch, the valid one still documented.
    makePackage('@happyvertical', 'smrt-content', {
      agents: '# smrt-content\n\nDocs.',
    });
    const brokenDir = join(
      tempDir,
      'node_modules',
      '@happyvertical',
      'smrt-bad',
    );
    mkdirSync(brokenDir, { recursive: true });
    writeFileSync(join(brokenDir, 'package.json'), '{ broken json', 'utf-8');

    await docsCommands['docs:agents'].handler([], { 'dry-run': true });

    expect(warnSpy).toHaveBeenCalledWith(
      expect.stringContaining('Could not read package.json'),
    );
    const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('@happyvertical/smrt-content');
  });

  it('discovers workspace packages when node_modules has none', async () => {
    // No node_modules/@happyvertical; provide a pnpm workspace instead.
    writeFileSync(
      join(tempDir, 'pnpm-workspace.yaml'),
      "packages:\n  - 'packages/*'\n",
      'utf-8',
    );
    const pkgDir = join(tempDir, 'packages', 'smrt-widgets');
    mkdirSync(pkgDir, { recursive: true });
    writeFileSync(
      join(pkgDir, 'package.json'),
      JSON.stringify({
        name: '@happyvertical/smrt-widgets',
        version: '3.0.0',
      }),
      'utf-8',
    );
    writeFileSync(
      join(pkgDir, 'AGENTS.md'),
      '# smrt-widgets\n\nWidget docs.',
      'utf-8',
    );

    await docsCommands['docs:agents'].handler([], { 'dry-run': true });

    const printed = logSpy.mock.calls.map((c) => c[0]).join('\n');
    expect(printed).toContain('@happyvertical/smrt-widgets');
    expect(printed).toContain('Widget docs.');
  });
});
