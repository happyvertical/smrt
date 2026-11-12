import { execFileSync, spawnSync } from 'node:child_process';
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
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { guardTestStateBases, installTestHome } from '../test-home.js';

const names = [
  'HOME',
  'USERPROFILE',
  'XDG_STATE_HOME',
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'LOCALAPPDATA',
  'APPDATA',
];

describe('test home isolation', () => {
  it('fails the Node script runner on a child escape and still cleans its owned home', () => {
    const root = mkdtempSync(join(tmpdir(), 'smrt-home-escape-'));
    const preload = fileURLToPath(
      new URL('../test-home-register.ts', import.meta.url),
    );
    try {
      const result = spawnSync(
        process.execPath,
        [
          '--import',
          preload,
          '--input-type=module',
          '-e',
          `
        import { execFileSync } from 'node:child_process';
        console.log(process.env.HOME);
        execFileSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], "escape")', ${JSON.stringify(join(root, 'escaped-state'))}]);
      `,
        ],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            SMRT_TEST_REAL_STATE_BASES: JSON.stringify([root]),
          },
        },
      );
      expect(result.status).toBe(1);
      expect(result.stderr).toContain(
        'Tests wrote 1 new entries into the real state base',
      );
      expect(existsSync(result.stdout.trim())).toBe(false);
      expect(existsSync(join(root, 'escaped-state'))).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('isolates all OS paths, passes them to production children, and restores/cleans up', () => {
    const before = names.map((name) => process.env[name]);
    const dispose = installTestHome();
    const home = process.env.HOME;
    if (!home) throw new Error('Test home was not installed');
    try {
      expect(names.every((name) => process.env[name]?.startsWith(home))).toBe(
        true,
      );
      expect(home).not.toBe(before[0]);
      const childHome = execFileSync(
        process.execPath,
        [
          '--input-type=module',
          '-e',
          `
        import { homedir } from 'node:os';
        import { mkdirSync } from 'node:fs';
        import { join } from 'node:path';
        for (const base of [join(homedir(), 'Library', 'Application Support'), process.env.XDG_STATE_HOME, process.env.LOCALAPPDATA]) {
          mkdirSync(join(base, '.child-123456789abc-state'), { recursive: true });
        }
        console.log(homedir());
      `,
        ],
        { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } },
      ).trim();
      expect(childHome).toBe(home);
      expect(
        existsSync(
          join(
            home,
            'Library',
            'Application Support',
            '.child-123456789abc-state',
          ),
        ),
      ).toBe(true);
    } finally {
      dispose();
    }
    expect(existsSync(home)).toBe(false);
    expect(names.map((name) => process.env[name])).toEqual(before);
    dispose(); // teardown and exit fallback are idempotent
  });

  it.each([
    '.app-123456789abc-state',
    'unexpected-file',
  ])('rejects child writes of %s without deleting them', (name) => {
    const root = mkdtempSync(join(tmpdir(), 'smrt-state-guard-'));
    try {
      writeFileSync(join(root, 'existing'), 'keep');
      const check = guardTestStateBases([root]);
      expect(check).not.toThrow();
      execFileSync(process.execPath, [
        '-e',
        'require("node:fs").writeFileSync(process.argv[1], "child")',
        join(root, name),
      ]);
      expect(check).toThrow(
        'Tests wrote 1 new entries into the real state base',
      );
      expect(readFileSync(join(root, name), 'utf8')).toBe('child');
      expect(readFileSync(join(root, 'existing'), 'utf8')).toBe('keep');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('isolates a real Vitest worker and its child before test imports, then removes the home', () => {
    const root = mkdtempSync(join(tmpdir(), 'smrt-home-consumer-'));
    const setup = fileURLToPath(
      new URL('../test-home.global-setup.ts', import.meta.url),
    );
    const vitest = fileURLToPath(
      new URL('../../node_modules/vitest/vitest.mjs', import.meta.url),
    );
    try {
      writeFileSync(
        join(root, 'vitest.config.mjs'),
        `export default { test: { globalSetup: [${JSON.stringify(setup)}], pool: 'forks', maxWorkers: 1 } };`,
      );
      // Import vitest by absolute path because the temporary consumer has no node_modules.
      writeFileSync(
        join(root, 'home.test.mjs'),
        `
        import { it, expect } from ${JSON.stringify(fileURLToPath(new URL('../../node_modules/vitest/dist/index.js', import.meta.url)))};
        import { homedir, userInfo } from 'node:os';
        import { writeFileSync } from 'node:fs';
        import { execFileSync, spawnSync } from 'node:child_process';
        const home = homedir();
        writeFileSync(${JSON.stringify(join(root, 'home.txt'))}, home);
        it('inherits isolated home before evaluation', () => {
          expect(home).not.toBe(userInfo().homedir);
          expect(execFileSync(process.execPath, ['-p', 'require("node:os").homedir()'], { encoding: 'utf8', env: { ...process.env, NODE_ENV: 'production' } }).trim()).toBe(home);
        });
      `,
      );
      execFileSync(process.execPath, [vitest, 'run', '--root', root], {
        encoding: 'utf8',
        timeout: 60_000,
      });
      const home = readFileSync(join(root, 'home.txt'), 'utf8');
      expect(existsSync(home)).toBe(false);
      const fakeState = join(root, 'fake-state');
      mkdirSync(fakeState);
      writeFileSync(
        join(root, 'home.test.mjs'),
        `
        import { it } from ${JSON.stringify(fileURLToPath(new URL('../../node_modules/vitest/dist/index.js', import.meta.url)))};
        import { execFileSync } from 'node:child_process';
        it('child escapes', () => execFileSync(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], "escape")', ${JSON.stringify(join(fakeState, '.app-123456789abc-state'))}]));
      `,
      );
      const escaped = spawnSync(
        process.execPath,
        [vitest, 'run', '--root', root],
        {
          encoding: 'utf8',
          timeout: 60_000,
          env: {
            ...process.env,
            SMRT_TEST_REAL_STATE_BASES: JSON.stringify([fakeState]),
          },
        },
      );
      expect(escaped.status).toBe(1);
      expect(escaped.stderr).toContain(
        'Tests wrote 1 new entries into the real state base',
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 70_000);
});
