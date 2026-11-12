import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { installTestHome, testHomeEnvironment } from '../test-home.js';

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
  it('records the real account bases before a Node runner replaces its home', () => {
    const env = { ...process.env };
    delete env.SMRT_FORBIDDEN_STATE_BASES;
    const preload = fileURLToPath(
      new URL('../test-home-register.ts', import.meta.url),
    );
    const result = JSON.parse(
      execFileSync(
        process.execPath,
        [
          '--import',
          preload,
          '-e',
          'console.log(JSON.stringify({home:process.env.HOME,real:require("node:os").userInfo().homedir,bases:JSON.parse(process.env.SMRT_FORBIDDEN_STATE_BASES)}))',
        ],
        { encoding: 'utf8', env },
      ),
    );
    expect(result.bases).toContain(
      join(result.real, 'Library', 'Application Support'),
    );
    expect(result.bases).toContain(join(result.real, '.local', 'state'));
    expect(result.bases).toContain(join(result.real, 'AppData', 'Local'));
    expect(existsSync(result.home)).toBe(false);
    expect(Object.keys(testHomeEnvironment()).sort()).toEqual(
      [
        ...names,
        'SMRT_FORBIDDEN_STATE_BASES',
        'PLAYWRIGHT_BROWSERS_PATH',
      ].sort(),
    );
  });

  it('preserves browser prerequisites while isolating state and restores the caller', () => {
    const original = process.env.PLAYWRIGHT_BROWSERS_PATH;
    for (const configured of [undefined, '/test/browser-cache', '0']) {
      if (configured === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
      else process.env.PLAYWRIGHT_BROWSERS_PATH = configured;
      const beforeHome = process.env.HOME;
      const dispose = installTestHome();
      try {
        expect(process.env.HOME).not.toBe(beforeHome);
        if (configured === undefined) {
          expect(process.env.PLAYWRIGHT_BROWSERS_PATH).toMatch(
            /ms-playwright$/,
          );
          expect(process.env.PLAYWRIGHT_BROWSERS_PATH).not.toContain(
            process.env.HOME,
          );
        } else {
          expect(process.env.PLAYWRIGHT_BROWSERS_PATH).toBe(configured);
        }
        expect(testHomeEnvironment().PLAYWRIGHT_BROWSERS_PATH).toBe(
          process.env.PLAYWRIGHT_BROWSERS_PATH,
        );
        const nestedDispose = installTestHome();
        const browserPath = process.env.PLAYWRIGHT_BROWSERS_PATH;
        nestedDispose();
        expect(process.env.PLAYWRIGHT_BROWSERS_PATH).toBe(browserPath);
      } finally {
        dispose();
      }
      expect(process.env.PLAYWRIGHT_BROWSERS_PATH).toBe(configured);
    }
    if (original === undefined) delete process.env.PLAYWRIGHT_BROWSERS_PATH;
    else process.env.PLAYWRIGHT_BROWSERS_PATH = original;
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

  it('records the original platform bases and preserves them through nested runners', () => {
    const original = process.env.SMRT_FORBIDDEN_STATE_BASES;
    const dispose = installTestHome();
    try {
      expect(process.env.SMRT_FORBIDDEN_STATE_BASES).toBe(original);
      expect(JSON.parse(original ?? '[]').length).toBeGreaterThan(0);
      expect(
        execFileSync(
          process.execPath,
          ['-p', 'process.env.SMRT_FORBIDDEN_STATE_BASES'],
          { encoding: 'utf8' },
        ).trim(),
      ).toBe(original);
    } finally {
      dispose();
    }
  });

  it('does not attribute another process writing a forbidden base to this runner', () => {
    const root = mkdtempSync(join(tmpdir(), 'smrt-other-runner-'));
    const original = process.env.SMRT_FORBIDDEN_STATE_BASES;
    process.env.SMRT_FORBIDDEN_STATE_BASES = JSON.stringify([root]);
    const dispose = installTestHome();
    try {
      writeFileSync(join(root, 'other-process'), 'keep');
      expect(dispose).not.toThrow();
      expect(readFileSync(join(root, 'other-process'), 'utf8')).toBe('keep');
    } finally {
      dispose();
      if (original === undefined) delete process.env.SMRT_FORBIDDEN_STATE_BASES;
      else process.env.SMRT_FORBIDDEN_STATE_BASES = original;
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
        import { execFileSync } from 'node:child_process';
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
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 70_000);
});
