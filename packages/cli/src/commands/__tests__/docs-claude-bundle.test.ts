/**
 * docs:agents knowledge bundle tests (#4689): the "Find it by intent" section
 * and the `.agents/smrt-knowledge/` export, driven against a temp consumer
 * project whose node_modules holds fake @happyvertical packages.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { requireCommandHandler } from '../../__tests__/command-handler.js';
import { docsCommands } from '../docs-claude.js';
import { containedPath, isValidPackageName } from '../docs-knowledge-bundle.js';

let tempDir: string;
let originalCwd: string;
let logSpy: ReturnType<typeof vi.spyOn>;

const page = (name: string) =>
  `---\ntype: "Component"\ntitle: "@happyvertical/${name}"\npackage_version: "0.0.1"\nsource_revision: "sha256:abc"\n---\n\n# ${name}\n`;

const INDEX = `---
type: Index
title: "Developer-intent index"
package_version: 0.0.1
---

# Developer-intent index

| Intent | Page | Home package(s) | Entry point | Hand-rolled signals |
| --- | --- | --- | --- | --- |
| Background work and retries | [background-work](/intents/background-work.md) | [smrt-jobs](/components/smrt-jobs.md), [smrt-core](/components/smrt-core.md) | \`withBackgroundJobs\` | \`import:bullmq\` |
| Human approval steps | [human-approvals](/intents/human-approvals.md) | [smrt-approvals](/components/smrt-approvals.md) | \`ApprovalService\` | \`regex:approved_by\` |
`;

function install(
  name: string,
  version: string,
  opts: { shipsPage?: boolean } = {},
): string {
  const dir = join(tempDir, 'node_modules', '@happyvertical', name);
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: `@happyvertical/${name}`, version }),
  );
  writeFileSync(join(dir, 'AGENTS.md'), `# ${name}\n\nDocs.`);
  if (opts.shipsPage) {
    // Stamped with the monorepo version, as committed; export must re-stamp.
    writeFileSync(join(dir, 'dist', 'smrt-knowledge.okf.md'), page(name));
  }
  return dir;
}

/** The installed smrt-cli carries the intent pages. */
function installCliWithIntents(): void {
  install('smrt-cli', '2.5.0');
  const dir = join(
    tempDir,
    'node_modules/@happyvertical/smrt-cli/dist/knowledge/intents',
  );
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'index.md'), INDEX);
  writeFileSync(
    join(dir, 'background-work.md'),
    '---\ntype: Intent\n---\n\nbg\n',
  );
  writeFileSync(
    join(dir, 'human-approvals.md'),
    '---\ntype: Intent\n---\n\nappr\n',
  );
}

const run = (options: Record<string, unknown> = {}) =>
  requireCommandHandler(docsCommands['docs:agents'])([], options);
const printed = () => logSpy.mock.calls.map((call) => call[0]).join('\n');

describe('docs:agents knowledge bundle (#4689)', () => {
  beforeEach(() => {
    tempDir = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-docs-bundle-')));
    originalCwd = process.cwd();
    process.chdir(tempDir);
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  afterEach(() => {
    process.chdir(originalCwd);
    rmSync(tempDir, { recursive: true, force: true });
    logSpy.mockRestore();
  });

  it('lists only intents whose home package is installed, naming versions', async () => {
    installCliWithIntents();
    install('smrt-jobs', '1.2.3');

    await run({ 'dry-run': true });

    const out = printed();
    expect(out).toContain('## Find it by intent');
    expect(out).toContain('Background work and retries');
    expect(out).toContain('smrt-jobs@1.2.3');
    expect(out).toContain('(smrt-knowledge/intents/background-work.md)');
    // smrt-core is a home but not installed; smrt-approvals is not installed.
    expect(out).not.toContain('smrt-core@');
    expect(out).not.toContain('Human approval steps');
    expect(out.indexOf('## Find it by intent')).toBeLessThan(
      out.indexOf('## Installed SMRT Packages'),
    );
  });

  it('omits the intent section when no home package is installed', async () => {
    installCliWithIntents();
    install('smrt-content', '1.0.0');

    await run({ 'dry-run': true });

    expect(printed()).not.toContain('Find it by intent');
  });

  it('exports installed component pages and matching intents, re-stamping package_version', async () => {
    installCliWithIntents();
    install('smrt-jobs', '1.2.3', { shipsPage: true });
    // Installed but ships no page (older release): reported, not fatal.
    install('smrt-content', '1.0.0');

    await run();

    const bundle = join(tempDir, '.agents', 'smrt-knowledge');
    const jobs = readFileSync(
      join(bundle, 'components', 'smrt-jobs.md'),
      'utf-8',
    );
    expect(jobs).toContain('package_version: "1.2.3"');
    expect(jobs).toContain('source_revision: "sha256:abc"');
    expect(jobs).not.toContain('"0.0.1"');
    expect(existsSync(join(bundle, 'components', 'smrt-content.md'))).toBe(
      false,
    );

    expect(existsSync(join(bundle, 'intents', 'background-work.md'))).toBe(
      true,
    );
    expect(existsSync(join(bundle, 'intents', 'human-approvals.md'))).toBe(
      false,
    );
    const index = readFileSync(join(bundle, 'intents', 'index.md'), 'utf-8');
    expect(index).toContain('background-work');
    expect(index).not.toContain('human-approvals');
    // Intent pages carry the version of the smrt-cli that supplied them.
    expect(index).toContain('package_version: 2.5.0');

    const manifest = JSON.parse(
      readFileSync(join(bundle, 'bundle.json'), 'utf-8'),
    );
    expect(manifest.format).toBe('smrt-okf-bundle/1');
    expect(manifest.packages).toEqual([
      {
        name: '@happyvertical/smrt-jobs',
        version: '1.2.3',
        concept: '/components/smrt-jobs.md',
      },
    ]);
    expect(manifest.intents).toEqual(['background-work']);
    expect(printed()).toContain('knowledge bundle exported');
    expect(printed()).toContain('ship no knowledge page');
  });

  it('skips a package whose name escapes the bundle or mismatches its directory', async () => {
    installCliWithIntents();
    install('smrt-jobs', '1.2.3', { shipsPage: true });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    // Traversal name that would resolve to .agents/smrt-framework.md.
    const evil = install('smrt-x', '9.9.9', { shipsPage: true });
    writeFileSync(
      join(evil, 'package.json'),
      JSON.stringify({
        name: '@happyvertical/smrt-x/../../../smrt-framework',
        version: '9.9.9',
      }),
    );
    // Valid-looking name that is not the directory's identity.
    const liar = install('smrt-liar', '1.0.0', { shipsPage: true });
    writeFileSync(
      join(liar, 'package.json'),
      JSON.stringify({ name: '@happyvertical/smrt-jobs', version: '6.6.6' }),
    );
    const sentinel = join(tempDir, '.agents', 'smrt-framework.md');

    await run();
    warn.mockRestore();

    const bundle = join(tempDir, '.agents', 'smrt-knowledge');
    const manifest = JSON.parse(
      readFileSync(join(bundle, 'bundle.json'), 'utf-8'),
    );
    expect(manifest.packages.map((p: { name: string }) => p.name)).toEqual([
      '@happyvertical/smrt-jobs',
    ]);
    expect(manifest.packages[0].version).toBe('1.2.3');
    expect(existsSync(join(bundle, 'components', 'smrt-x.md'))).toBe(false);
    expect(existsSync(join(tempDir, '.agents', 'smrt-framework', 'x.md'))).toBe(
      false,
    );
    // The framework file is the generated one, not the hostile page.
    expect(readFileSync(sentinel, 'utf-8')).not.toContain('source_revision');
    expect(
      readFileSync(join(bundle, 'components', 'smrt-jobs.md'), 'utf-8'),
    ).toContain('package_version: "1.2.3"');
  });

  it('refuses to write a destination outside the bundle directory', () => {
    expect(() => containedPath('/tmp/bundle', '../escape.md')).toThrow(
      /outside/,
    );
    expect(() => containedPath('/tmp/bundle', 'components/../../x')).toThrow(
      /outside/,
    );
    expect(containedPath('/tmp/bundle', 'components/a.md')).toBe(
      '/tmp/bundle/components/a.md',
    );
    expect(isValidPackageName('@happyvertical/smrt-x/../../y')).toBe(false);
    expect(isValidPackageName('@happyvertical/smrt-jobs')).toBe(true);
    expect(isValidPackageName('plain-name')).toBe(true);
  });

  it('refuses a bundle directory that is a symlink and leaves its target intact', async () => {
    installCliWithIntents();
    install('smrt-jobs', '1.2.3', { shipsPage: true });
    // A checkout can carry this link; writing through it would replace
    // `components/` wherever it points.
    const target = join(tempDir, 'elsewhere');
    mkdirSync(join(target, 'components'), { recursive: true });
    const sentinel = join(target, 'components', 'keep.md');
    writeFileSync(sentinel, 'keep');
    mkdirSync(join(tempDir, '.agents'), { recursive: true });
    symlinkSync(target, join(tempDir, '.agents', 'smrt-knowledge'));

    // The command reports the failure and exits non-zero (vitest turns the
    // exit into a rejection).
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    await expect(run()).rejects.toThrow(/process\.exit/);
    expect(error.mock.calls.flat().join('\n')).toMatch(/symlink/);
    error.mockRestore();

    expect(readFileSync(sentinel, 'utf-8')).toBe('keep');
    expect(existsSync(join(target, 'components', 'smrt-jobs.md'))).toBe(false);
    expect(existsSync(join(target, 'bundle.json'))).toBe(false);
  });

  it('keeps exportedAt while content is unchanged and drops uninstalled pages on rerun', async () => {
    installCliWithIntents();
    install('smrt-jobs', '1.2.3', { shipsPage: true });
    await run();
    const bundle = join(tempDir, '.agents', 'smrt-knowledge');
    const manifestPath = join(bundle, 'bundle.json');
    const first = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    writeFileSync(
      manifestPath,
      JSON.stringify({ ...first, exportedAt: '2026-01-01T00:00:00Z' }),
    );

    await run();
    expect(JSON.parse(readFileSync(manifestPath, 'utf-8')).exportedAt).toBe(
      '2026-01-01T00:00:00Z',
    );

    // A version bump changes the content, so the export is re-dated.
    install('smrt-jobs', '1.3.0', { shipsPage: true });
    await run();
    const bumped = JSON.parse(readFileSync(manifestPath, 'utf-8'));
    expect(bumped.exportedAt).not.toBe('2026-01-01T00:00:00Z');
    expect(bumped.packages[0].version).toBe('1.3.0');

    // Uninstalling the home package removes its pages from the bundle.
    rmSync(join(tempDir, 'node_modules/@happyvertical/smrt-jobs'), {
      recursive: true,
    });
    install('smrt-content', '1.0.0', { shipsPage: true });
    await run();
    expect(existsSync(join(bundle, 'components', 'smrt-jobs.md'))).toBe(false);
    expect(existsSync(join(bundle, 'intents', 'background-work.md'))).toBe(
      false,
    );
    expect(existsSync(join(bundle, 'components', 'smrt-content.md'))).toBe(
      true,
    );
  });

  it('writes nothing under --dry-run', async () => {
    installCliWithIntents();
    install('smrt-jobs', '1.2.3', { shipsPage: true });

    await run({ 'dry-run': true });

    expect(existsSync(join(tempDir, '.agents'))).toBe(false);
  });
});
