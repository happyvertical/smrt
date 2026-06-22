/**
 * Additional unit tests for git commands.
 *
 * The existing git.test.ts thoroughly covers the pure merge functions; this
 * file targets the two command handlers (git:init, merge-json) and the
 * remaining merge/sanitize branches. The handlers shell out to git and call
 * process.exit(), so they run inside a real temp git repository with process.exit
 * stubbed to throw (so we can assert the exit branch without killing the runner).
 * No git internals are mocked — the merge driver config is written to a real
 * `.git`.
 */

import { execSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parseCliArgs } from '@happyvertical/utils';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mergeObjects } from '../git.js';

describe('mergeObjects additional branches', () => {
  it('prefers ours wholesale when ours is a non-object', () => {
    expect(mergeObjects({ a: 1 }, 'scalar', { b: 2 })).toBe('scalar');
  });

  it('merges nested arrays that lack id/slug by preferring ours', () => {
    const result = mergeObjects(
      { items: ['x'] },
      { items: ['a', 'b'] },
      { items: ['c'] },
    );
    expect(result.items).toEqual(['a', 'b']);
  });

  it('falls back to theirs array when ours is absent', () => {
    const result = mergeObjects({}, {}, { tags: ['t1', 't2'] });
    expect(result.tags).toEqual(['t1', 't2']);
  });

  it('keeps a key that exists only in base', () => {
    const result = mergeObjects({ onlyBase: 'kept' }, {}, {});
    expect(result.onlyBase).toBe('kept');
  });

  it('sanitizes dangerous keys inside adopted array subtrees', () => {
    const theirs = JSON.parse(
      '{"records":[{"id":"a","__proto__":{"polluted":true},"safe":1}]}',
    );
    const result = mergeObjects({}, { records: [] }, theirs);
    expect(result.records).toHaveLength(1);
    expect(Object.keys(result.records[0])).not.toContain('__proto__');
    expect(result.records[0].safe).toBe(1);
  });
});

describe('git:init handler', () => {
  let repoDir: string;
  let originalCwd: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    originalCwd = process.cwd();
    repoDir = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-git-init-')));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((
      _code?: number,
    ) => {
      throw new Error('process.exit called');
    }) as never);
  });

  afterEach(() => {
    process.chdir(originalCwd);
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    rmSync(repoDir, { recursive: true, force: true });
  });

  const out = () => logSpy.mock.calls.map((c) => c.join(' ')).join('\n');

  function initRepo() {
    execSync('git init', { cwd: repoDir, stdio: 'ignore' });
  }

  it('configures the merge driver and writes .gitattributes', async () => {
    initRepo();
    process.chdir(repoDir);

    const { gitCommands } = await import('../git.js');
    await gitCommands['git:init'].handler([], {
      patterns: 'data/*.json',
    });

    const gitattributes = readFileSync(
      join(repoDir, '.gitattributes'),
      'utf-8',
    );
    expect(gitattributes).toContain('# SMRT JSON merge driver');
    expect(gitattributes).toContain('data/*.json merge=smrt-json');

    const driver = execSync('git config --local merge.smrt-json.driver', {
      cwd: repoDir,
      encoding: 'utf-8',
    });
    expect(driver).toContain('smrt merge-json');
    expect(out()).toContain('SMRT JSON merge driver configured');
  });

  it('reports already-configured patterns on a second run', async () => {
    initRepo();
    process.chdir(repoDir);

    const { gitCommands } = await import('../git.js');
    await gitCommands['git:init'].handler([], { patterns: 'data/*.json' });
    logSpy.mockClear();
    await gitCommands['git:init'].handler([], { patterns: 'data/*.json' });

    expect(out()).toContain('already configured');
  });

  it('appends a new pattern to an existing .gitattributes', async () => {
    initRepo();
    writeFileSync(join(repoDir, '.gitattributes'), '*.png binary\n');
    process.chdir(repoDir);

    const { gitCommands } = await import('../git.js');
    await gitCommands['git:init'].handler([], { patterns: '*.data.json' });

    const gitattributes = readFileSync(
      join(repoDir, '.gitattributes'),
      'utf-8',
    );
    expect(gitattributes).toContain('*.png binary');
    expect(gitattributes).toContain('*.data.json merge=smrt-json');
  });

  it('exits when not inside a git repository', async () => {
    process.chdir(repoDir); // no `git init`

    const { gitCommands } = await import('../git.js');
    await expect(
      gitCommands['git:init'].handler([], { patterns: 'data/*.json' }),
    ).rejects.toThrow('process.exit called');
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Not a git repository'),
    );
  });
});

describe('merge-json handler', () => {
  let workDir: string;
  let logSpy: ReturnType<typeof vi.spyOn>;
  let errorSpy: ReturnType<typeof vi.spyOn>;
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let exitCodes: Array<number | undefined>;

  // The merge-json handler calls process.exit() *inside* its try/catch. A
  // throwing stub is the only way to halt the handler, but the throw on the
  // success path (exit 0) is then caught by the handler's catch, which calls
  // exit(1). So we record every exit code and assert on the FIRST one, which is
  // the code the real (terminating) process.exit would have used.
  const firstExit = () => exitCodes[0];

  beforeEach(() => {
    workDir = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-merge-json-')));
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    exitCodes = [];
    exitSpy = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
      exitCodes.push(code);
      throw new Error(`process.exit:${code}`);
    }) as never);
  });

  afterEach(() => {
    logSpy.mockRestore();
    errorSpy.mockRestore();
    exitSpy.mockRestore();
    rmSync(workDir, { recursive: true, force: true });
  });

  function write(name: string, content: string) {
    const p = join(workDir, name);
    writeFileSync(p, content);
    return p;
  }

  it('prints usage and exits 1 when arguments are missing', async () => {
    const { gitCommands } = await import('../git.js');
    await expect(gitCommands['merge-json'].handler([], {})).rejects.toThrow(
      'process.exit:1',
    );
    expect(firstExit()).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('Usage: smrt merge-json'),
    );
  });

  it('merges files and writes the result to the ours path (exit 0)', async () => {
    const base = write('base.json', JSON.stringify([{ id: 'a', n: 1 }]));
    const ours = write(
      'ours.json',
      JSON.stringify([
        { id: 'a', n: 1 },
        { id: 'b', n: 2 },
      ]),
    );
    const theirs = write(
      'theirs.json',
      JSON.stringify([
        { id: 'a', n: 1 },
        { id: 'c', n: 3 },
      ]),
    );

    const { gitCommands } = await import('../git.js');
    await expect(
      gitCommands['merge-json'].handler([base, ours, theirs], {
        verbose: true,
      }),
    ).rejects.toThrow();
    expect(firstExit()).toBe(0);

    const merged = JSON.parse(readFileSync(ours, 'utf-8'));
    expect(merged.map((o: any) => o.id).sort()).toEqual(['a', 'b', 'c']);
  });

  it('handles a missing base file (new-file scenario)', async () => {
    const base = join(workDir, 'missing-base.json');
    const ours = write('ours.json', JSON.stringify([{ id: 'a' }]));
    const theirs = write('theirs.json', JSON.stringify([{ id: 'b' }]));

    const { gitCommands } = await import('../git.js');
    await expect(
      gitCommands['merge-json'].handler([base, ours, theirs], {}),
    ).rejects.toThrow();
    expect(firstExit()).toBe(0);
    expect(existsSync(base)).toBe(false);
  });

  it('prints merged output to stdout in dry-run mode', async () => {
    const base = write('base.json', '[]');
    const ours = write('ours.json', JSON.stringify([{ id: 'a' }]));
    const theirs = write('theirs.json', JSON.stringify([{ id: 'b' }]));
    const oursBefore = readFileSync(ours, 'utf-8');

    const { gitCommands } = await import('../git.js');
    await expect(
      gitCommands['merge-json'].handler([base, ours, theirs], {
        dryRun: true,
      }),
    ).rejects.toThrow();
    expect(firstExit()).toBe(0);

    const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('"id": "a"');
    // Dry run must not rewrite ours.
    expect(readFileSync(ours, 'utf-8')).toBe(oursBefore);
  });

  // Regression for #1385: the `'dry-run'` option is declared kebab-cased and
  // `parseCliArgs` returns keys verbatim, so the real CLI yields
  // `options['dry-run']`. The handler previously read `options.dryRun`, so the
  // real `--dry-run` flag was ignored and the merge OVERWROTE the "ours" file
  // instead of printing a preview. The handler-direct test above passed
  // `{ dryRun: true }`, the camel key the CLI never produces, masking the bug.
  it('does NOT overwrite ours when --dry-run is routed through parseCliArgs', async () => {
    const base = write('base.json', '[]');
    const ours = write('ours.json', JSON.stringify([{ id: 'a' }]));
    const theirs = write('theirs.json', JSON.stringify([{ id: 'b' }]));
    const oursBefore = readFileSync(ours, 'utf-8');

    const { gitCommands } = await import('../git.js');
    const mergeJson = gitCommands['merge-json'];

    const parsed = parseCliArgs(
      ['merge-json', base, ours, theirs, '--dry-run'],
      [mergeJson as any],
      {},
    );
    // Premise: the kebab key is produced, not a camelCase one.
    expect(parsed.options['dry-run']).toBe(true);
    expect((parsed.options as any).dryRun).toBeUndefined();

    await expect(
      mergeJson.handler(parsed.args, parsed.options),
    ).rejects.toThrow();
    expect(firstExit()).toBe(0);

    const printed = logSpy.mock.calls.map((c) => c.join(' ')).join('\n');
    expect(printed).toContain('"id": "a"');
    // The whole point: the dry run preview must not have rewritten ours.
    expect(readFileSync(ours, 'utf-8')).toBe(oursBefore);
  });

  it('exits 1 when ours file does not exist', async () => {
    const base = write('base.json', '[]');
    const theirs = write('theirs.json', '[]');
    const missingOurs = join(workDir, 'no-ours.json');

    const { gitCommands } = await import('../git.js');
    await expect(
      gitCommands['merge-json'].handler([base, missingOurs, theirs], {}),
    ).rejects.toThrow('process.exit:1');
    expect(firstExit()).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('"ours" file not found'),
    );
  });

  it('exits 1 on invalid JSON and reports the syntax error', async () => {
    const base = write('base.json', '[]');
    const ours = write('ours.json', 'not valid json {');
    const theirs = write('theirs.json', '[]');

    const { gitCommands } = await import('../git.js');
    await expect(
      gitCommands['merge-json'].handler([base, ours, theirs], {
        verbose: true,
      }),
    ).rejects.toThrow('process.exit:1');
    expect(firstExit()).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining('invalid JSON'),
    );
  });
});
