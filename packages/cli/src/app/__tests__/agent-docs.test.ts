/**
 * Agent-docs freshness in `smrt app dev` / `build` (#4878 item C): refresh
 * policy, the CI and SMRT_AGENT_DOCS opt-outs, the read-only build warning, and
 * the rule that agent docs never change an exit status or stdout. `install` is
 * covered in operations.test.ts (it needs the real operation fixture).
 */

import {
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  isAgentDocsOff,
  isCiEnvironment,
  refreshAgentDocsOnDev,
  warnAgentDocsOnBuild,
} from '../agent-docs.js';
import { runAppCommand } from '../cli.js';

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const PAGE = (version: string) =>
  `---\ntype: "Component"\ntitle: "@happyvertical/smrt-core"\npackage_version: "${version}"\n---\n\n# smrt-core\n`;

/** A consumer app with a fake smrt-core installed. */
function consumer(version = '1.0.0'): string {
  const root = realpathSync(
    mkdtempSync(join(realpathSync(tmpdir()), 'smrt-agent-docs-')),
  );
  roots.push(root);
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: 'app' }));
  install(root, version);
  return root;
}

function install(root: string, version: string): void {
  const dir = join(root, 'node_modules', '@happyvertical', 'smrt-core');
  mkdirSync(join(dir, 'dist'), { recursive: true });
  writeFileSync(
    join(dir, 'package.json'),
    JSON.stringify({ name: '@happyvertical/smrt-core', version }),
  );
  writeFileSync(join(dir, 'AGENTS.md'), '# smrt-core\n\nDocs.');
  writeFileSync(join(dir, 'dist', 'smrt-knowledge.okf.md'), PAGE(version));
}

/** Every file below `root` (skipping node_modules) with size and mtime. */
function snapshot(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string, prefix: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full, `${prefix}${entry.name}/`);
      else {
        const stat = statSync(full);
        out.push(`${prefix}${entry.name}:${stat.size}:${stat.mtimeMs}`);
      }
    }
  };
  walk(root, '');
  return out.sort();
}

function drive(
  root: string,
  argv: string[],
  options: {
    agentDocs?: Parameters<typeof refreshAgentDocsOnDev>[2];
    status?: number;
  } = {},
) {
  const stdout: string[] = [];
  const stderr: string[] = [];
  const launched: string[][] = [];
  return {
    stdout,
    stderr,
    launched,
    run: () =>
      runAppCommand(argv, {
        cwd: root,
        io: {
          stdout: (text) => stdout.push(text),
          stderr: (text) => stderr.push(text),
        },
        dependencies: {
          agentDocs: options.agentDocs,
          launchVite: async (_context, args) => {
            launched.push(args);
            return options.status ?? 0;
          },
        },
      }),
  };
}

describe('environment predicates', () => {
  it('treats CI as set for any value except empty, 0 and false', () => {
    expect(isCiEnvironment({})).toBe(false);
    expect(isCiEnvironment({ CI: '' })).toBe(false);
    expect(isCiEnvironment({ CI: '0' })).toBe(false);
    expect(isCiEnvironment({ CI: 'false' })).toBe(false);
    expect(isCiEnvironment({ CI: ' FALSE ' })).toBe(false);
    expect(isCiEnvironment({ CI: 'true' })).toBe(true);
    expect(isCiEnvironment({ CI: '1' })).toBe(true);
    expect(isCiEnvironment({ CI: 'yes' })).toBe(true);
  });

  it('SMRT_AGENT_DOCS=off is case-insensitive and exact', () => {
    expect(isAgentDocsOff({ SMRT_AGENT_DOCS: 'off' })).toBe(true);
    expect(isAgentDocsOff({ SMRT_AGENT_DOCS: 'OFF' })).toBe(true);
    expect(isAgentDocsOff({ SMRT_AGENT_DOCS: 'on' })).toBe(false);
    expect(isAgentDocsOff({})).toBe(false);
  });
});

describe('smrt app dev', () => {
  it('refreshes a missing bundle, then is a no-op while fresh', async () => {
    const root = consumer();
    const first = drive(root, ['dev'], { agentDocs: { env: {} } });
    expect(await first.run()).toBe(0);
    expect(first.launched).toHaveLength(1);
    expect(first.stderr.join('')).toContain('agent docs refreshed');
    expect(first.stdout).toEqual([]);
    const bundle = JSON.parse(
      readFileSync(
        join(root, '.agents', 'smrt-knowledge', 'bundle.json'),
        'utf8',
      ),
    );
    expect(bundle.packages[0].version).toBe('1.0.0');

    const before = snapshot(root);
    const second = drive(root, ['dev'], { agentDocs: { env: {} } });
    expect(await second.run()).toBe(0);
    expect(second.stderr).toEqual([]);
    expect(snapshot(root)).toEqual(before);

    install(root, '1.1.0');
    const third = drive(root, ['dev'], { agentDocs: { env: {} } });
    expect(await third.run()).toBe(0);
    expect(third.stderr.join('')).toContain('agent docs refreshed');
    const updated = JSON.parse(
      readFileSync(
        join(root, '.agents', 'smrt-knowledge', 'bundle.json'),
        'utf8',
      ),
    );
    expect(updated.packages[0].version).toBe('1.1.0');
  });

  it('skips under CI and SMRT_AGENT_DOCS=off, and runs when CI is falsy', async () => {
    const refresh = vi.fn(async () => ({
      status: 'skipped-fresh' as const,
      root: '',
      warnings: [],
    }));
    for (const env of [
      { CI: 'true' },
      { CI: '1' },
      { SMRT_AGENT_DOCS: 'off' },
    ]) {
      const dev = drive(consumer(), ['dev'], { agentDocs: { refresh, env } });
      expect(await dev.run()).toBe(0);
    }
    expect(refresh).not.toHaveBeenCalled();
    for (const env of [{}, { CI: '0' }, { CI: 'false' }, { CI: '' }]) {
      const dev = drive(consumer(), ['dev'], { agentDocs: { refresh, env } });
      expect(await dev.run()).toBe(0);
    }
    expect(refresh).toHaveBeenCalledTimes(4);
    expect(refresh.mock.calls[0]).toMatchObject([{ mode: 'if-stale' }]);
  });

  it('writes nothing under CI', async () => {
    const root = consumer();
    const before = snapshot(root);
    const dev = drive(root, ['dev'], { agentDocs: { env: { CI: 'true' } } });
    expect(await dev.run()).toBe(0);
    expect(snapshot(root)).toEqual(before);
  });

  it('starts anyway when the refresh throws, with a plain stderr line', async () => {
    const dev = drive(consumer(), ['dev', '--port', '1'], {
      status: 3,
      agentDocs: {
        env: {},
        refresh: async () => {
          throw new Error('boom');
        },
      },
    });
    expect(await dev.run()).toBe(3);
    expect(dev.launched).toEqual([
      ['dev', '--port', '1', '--host', '127.0.0.1'],
    ]);
    const text = dev.stderr.join('');
    expect(text).toContain('agent docs refresh failed (boom); continuing');
    expect(text).not.toContain('{');
  });

  it('starts anyway when a real refresh fails internally', async () => {
    const root = consumer();
    // An AGENTS.md with a damaged block is a warning, never a failure to start.
    writeFileSync(
      join(root, 'AGENTS.md'),
      '# App\n<!-- smrt:agents:begin -->\n',
    );
    const dev = drive(root, ['dev'], { agentDocs: { env: {} } });
    expect(await dev.run()).toBe(0);
    expect(dev.launched).toHaveLength(1);
    expect(dev.stderr.join('')).toContain('smrt:');
  });

  it('does not refresh where no smrt package is installed', async () => {
    const root = realpathSync(
      mkdtempSync(join(realpathSync(tmpdir()), 'smrt-agent-docs-')),
    );
    roots.push(root);
    writeFileSync(join(root, 'package.json'), '{"name":"plain"}');
    const before = snapshot(root);
    const dev = drive(root, ['dev'], { agentDocs: { env: {} } });
    expect(await dev.run()).toBe(0);
    expect(dev.stderr).toEqual([]);
    expect(snapshot(root)).toEqual(before);
  });

  it('directly: swallows a throwing hook', async () => {
    const lines: string[] = [];
    await expect(
      refreshAgentDocsOnDev(
        '/nowhere',
        { stdout: () => {}, stderr: (text) => lines.push(text) },
        {
          env: {},
          refresh: async () => {
            throw new Error('x');
          },
        },
      ),
    ).resolves.toBeUndefined();
    expect(lines.join('')).toContain('continuing');
  });
});

describe('smrt app build', () => {
  it('warns once about a missing bundle and writes nothing', async () => {
    const root = consumer();
    const before = snapshot(root);
    const build = drive(root, ['build', '--mode', 'production'], {
      agentDocs: { env: {} },
    });
    expect(await build.run()).toBe(0);
    expect(build.launched).toEqual([['build', '--mode', 'production']]);
    expect(build.stdout).toEqual([]);
    expect(build.stderr).toHaveLength(1);
    expect(build.stderr[0]).toContain('missing');
    expect(build.stderr[0]).toContain('smrt docs:agents');
    expect(snapshot(root)).toEqual(before);
    expect(readdirSync(root).sort()).toEqual(['node_modules', 'package.json']);
  });

  it('warns once about a stale bundle, never when fresh', async () => {
    const root = consumer();
    await drive(root, ['dev'], { agentDocs: { env: {} } }).run();
    const fresh = drive(root, ['build'], { agentDocs: { env: {} } });
    expect(await fresh.run()).toBe(0);
    expect(fresh.stderr).toEqual([]);

    install(root, '2.0.0');
    const before = snapshot(root);
    const stale = drive(root, ['build'], { agentDocs: { env: {} } });
    expect(await stale.run()).toBe(0);
    expect(stale.stderr).toHaveLength(1);
    expect(stale.stderr[0]).toContain('stale');
    expect(stale.stderr[0]).toContain('smrt docs:agents');
    expect(snapshot(root)).toEqual(before);
  });

  it('is silent under SMRT_AGENT_DOCS=off and where nothing is installed', async () => {
    const off = drive(consumer(), ['build'], {
      agentDocs: { env: { SMRT_AGENT_DOCS: 'off' } },
    });
    expect(await off.run()).toBe(0);
    expect(off.stderr).toEqual([]);

    const plain = realpathSync(
      mkdtempSync(join(realpathSync(tmpdir()), 'smrt-agent-docs-')),
    );
    roots.push(plain);
    writeFileSync(join(plain, 'package.json'), '{"name":"plain"}');
    const quiet = drive(plain, ['build'], { agentDocs: { env: {} } });
    expect(await quiet.run()).toBe(0);
    expect(quiet.stderr).toEqual([]);
  });

  it('keeps the exit status when inspection throws or the build fails', async () => {
    const throwing = drive(consumer(), ['build'], {
      status: 0,
      agentDocs: {
        env: {},
        inspect: () => {
          throw new Error('nope');
        },
      },
    });
    expect(await throwing.run()).toBe(0);
    expect(throwing.stderr).toEqual([]);

    const failing = drive(consumer(), ['build'], { status: 2 });
    expect(await failing.run()).toBe(2);
  });

  it('directly: reports through the injected inspector only when not fresh', async () => {
    const lines: string[] = [];
    const io = { stdout: () => {}, stderr: (text: string) => lines.push(text) };
    const base = {
      root: '/x',
      installed: true,
      staleReasons: [],
      block: 'present' as const,
      skills: [],
    };
    await warnAgentDocsOnBuild('/x', io, {
      env: {},
      inspect: () => ({ ...base, bundle: 'fresh' }),
    });
    expect(lines).toEqual([]);
    await warnAgentDocsOnBuild('/x', io, {
      env: {},
      inspect: () => ({ ...base, bundle: 'stale' }),
    });
    expect(lines).toHaveLength(1);
  });
});
