import { describe, expect, it } from 'vitest';
import {
  buildChildEnv,
  CHILD_ENV_ALLOWLIST,
  sanitizePath,
} from './child-env.js';

const CANARY = 'canary-secret-value-7f3a';

const HOSTILE_BASE: Record<string, string> = {
  PATH: '/usr/bin:/bin',
  HOME: '/home/builder',
  NODE_OPTIONS: `--require /tmp/${CANARY}.js`,
  NODE_PATH: `/tmp/${CANARY}`,
  NODE_EXTRA_CA_CERTS: `/tmp/${CANARY}.pem`,
  NPM_TOKEN: CANARY,
  NODE_AUTH_TOKEN: CANARY,
  GITHUB_TOKEN: CANARY,
  GH_TOKEN: CANARY,
  AWS_SECRET_ACCESS_KEY: CANARY,
  AWS_SESSION_TOKEN: CANARY,
  ANTHROPIC_API_KEY: CANARY,
  OPENAI_API_KEY: CANARY,
  SSH_AUTH_SOCK: `/tmp/${CANARY}`,
  npm_config__authToken: CANARY,
  npm_config_ignore_scripts: 'false',
  npm_config_registry: `https://user:${CANARY}@registry.example`,
  NPM_CONFIG_USERCONFIG: `/tmp/${CANARY}`,
  PNPM_CONFIG_IGNORE_SCRIPTS: 'false',
  LD_PRELOAD: `/tmp/${CANARY}.so`,
  LD_LIBRARY_PATH: `/tmp/${CANARY}`,
  DYLD_INSERT_LIBRARIES: `/tmp/${CANARY}.dylib`,
  DYLD_LIBRARY_PATH: `/tmp/${CANARY}`,
  BASH_ENV: `/tmp/${CANARY}`,
  ENV: `/tmp/${CANARY}`,
  LANG: 'tr_TR.UTF-8',
  LC_ALL: 'tr_TR.UTF-8',
  LC_COLLATE: 'tr_TR.UTF-8',
  HTTPS_PROXY: 'http://proxy.example:3128',
  NO_PROXY: 'localhost',
  CI: 'true',
  __proto__x: CANARY,
};

describe('buildChildEnv', () => {
  it('passes only allowlisted environment names to pnpm', () => {
    const env = buildChildEnv(HOSTILE_BASE, {}, { platform: 'linux' });
    const allowed = new Set([
      ...CHILD_ENV_ALLOWLIST,
      'LANG',
      'LC_ALL',
      'npm_config_ignore_scripts',
      'npm_config_update_notifier',
    ]);
    for (const name of Object.keys(env)) expect(allowed.has(name)).toBe(true);
    expect(env.PATH).toBe('/usr/bin:/bin');
    expect(env.HOME).toBe('/home/builder');
    expect(env.HTTPS_PROXY).toBe('http://proxy.example:3128');
    expect(env.CI).toBe('true');
  });

  it('never leaks a canary token, whatever the variable name', () => {
    const env = buildChildEnv(HOSTILE_BASE, {}, { platform: 'linux' });
    expect(JSON.stringify(env)).not.toContain(CANARY);
    // Also under case-insensitive Windows matching.
    const win = buildChildEnv(
      { ...HOSTILE_BASE, Path: 'C:\\Windows' },
      {},
      { platform: 'win32' },
    );
    expect(JSON.stringify(win)).not.toContain(CANARY);
  });

  it('drops NODE_OPTIONS and npm_config_* from the child environment', () => {
    const env = buildChildEnv(HOSTILE_BASE, {}, { platform: 'linux' });
    for (const name of [
      'NODE_OPTIONS',
      'NODE_PATH',
      'NODE_EXTRA_CA_CERTS',
      'npm_config__authToken',
      'npm_config_registry',
      'NPM_CONFIG_USERCONFIG',
      'PNPM_CONFIG_IGNORE_SCRIPTS',
      'LD_PRELOAD',
      'LD_LIBRARY_PATH',
      'DYLD_INSERT_LIBRARIES',
      'DYLD_LIBRARY_PATH',
      'BASH_ENV',
      'ENV',
      'SSH_AUTH_SOCK',
    ]) {
      expect(env).not.toHaveProperty(name);
    }
  });

  it('forces ignore-scripts in the child environment', () => {
    const env = buildChildEnv(
      {
        npm_config_ignore_scripts: 'false',
        NPM_CONFIG_IGNORE_SCRIPTS: 'false',
      },
      {},
      { platform: 'linux' },
    );
    expect(env.npm_config_ignore_scripts).toBe('true');
    expect(env).not.toHaveProperty('NPM_CONFIG_IGNORE_SCRIPTS');
  });

  it('forces a deterministic locale regardless of the host', () => {
    const env = buildChildEnv(HOSTILE_BASE, {}, { platform: 'linux' });
    expect(env.LANG).toBe('C');
    expect(env.LC_ALL).toBe('C');
    expect(env).not.toHaveProperty('LC_COLLATE');
  });

  it('is deterministic: sorted keys, same output for reordered input', () => {
    const a = buildChildEnv(
      { HOME: '/h', PATH: '/bin', CI: '1' },
      {},
      { platform: 'linux' },
    );
    const b = buildChildEnv(
      { CI: '1', PATH: '/bin', HOME: '/h' },
      {},
      { platform: 'linux' },
    );
    expect(Object.keys(a)).toEqual(Object.keys(b));
    expect(Object.keys(a)).toEqual([...Object.keys(a)].sort());
    expect(a).toEqual(b);
  });

  it('does not mutate its inputs and ignores undefined values', () => {
    const base = Object.freeze({ PATH: '/bin', HOME: undefined });
    const extra = Object.freeze({ TMPDIR: '/tmp/x' });
    const env = buildChildEnv(base, extra, { platform: 'linux' });
    expect(env).not.toHaveProperty('HOME');
    expect(env.TMPDIR).toBe('/tmp/x');
  });

  it('reduces PATH to absolute entries so cwd can never supply pnpm', () => {
    expect(sanitizePath('/usr/bin::bin:.:/opt/x:', 'linux')).toBe(
      '/usr/bin:/opt/x',
    );
    expect(sanitizePath('', 'linux')).toBeUndefined();
    expect(sanitizePath('.:rel', 'linux')).toBeUndefined();
    expect(sanitizePath('C:\\Windows;;bin;\\\\srv\\share;.', 'win32')).toBe(
      'C:\\Windows;\\\\srv\\share',
    );
    const env = buildChildEnv({ PATH: '.:rel' }, {}, { platform: 'linux' });
    expect(env).not.toHaveProperty('PATH');
    const withExtra = buildChildEnv(
      { PATH: '/bin' },
      { PATH: '/staging/bin:.' },
      { platform: 'linux' },
    );
    expect(withExtra.PATH).toBe('/staging/bin');
  });

  it('matches Windows names case-insensitively and emits canonical names', () => {
    const env = buildChildEnv(
      {
        Path: 'C:\\Windows\\System32',
        SYSTEMROOT: 'C:\\Windows',
        comspec: 'C:\\Windows\\System32\\cmd.exe',
        Pathext: '.EXE;.CMD',
        NODE_OPTIONS: '--evil',
        Node_Options: '--evil',
      },
      {},
      { platform: 'win32' },
    );
    expect(env.PATH).toBe('C:\\Windows\\System32');
    expect(env.SystemRoot).toBe('C:\\Windows');
    expect(env.ComSpec).toBe('C:\\Windows\\System32\\cmd.exe');
    expect(env.PATHEXT).toBe('.EXE;.CMD');
    expect(Object.keys(env).some((k) => /node_options/i.test(k))).toBe(false);
    // POSIX is case sensitive: `Path` is not `PATH`.
    expect(
      buildChildEnv({ Path: '/bin' }, {}, { platform: 'linux' }),
    ).not.toHaveProperty('PATH');
  });

  it('drops values with NUL or absurd length', () => {
    const env = buildChildEnv(
      { HOME: '/h\0evil', TMPDIR: 'x'.repeat(40000), CI: '1' },
      {},
      { platform: 'linux' },
    );
    expect(env).not.toHaveProperty('HOME');
    expect(env).not.toHaveProperty('TMPDIR');
    expect(env.CI).toBe('1');
  });

  it('lets extra override allowlisted names and add pnpm location variables', () => {
    const env = buildChildEnv(
      { HOME: '/home/builder', PNPM_HOME: '/x' },
      { HOME: '/staging/home', npm_config_store_dir: '/staging/store' },
      { platform: 'linux' },
    );
    expect(env.HOME).toBe('/staging/home');
    expect(env.npm_config_store_dir).toBe('/staging/store');
  });

  it('rejects extra entries that are not allowed', () => {
    const base = { PATH: '/bin' };
    for (const extra of [
      { NODE_OPTIONS: '--evil' },
      { NODE_PATH: '/x' },
      { npm_config_ignore_scripts: 'false' },
      { LC_ALL: 'en_US.UTF-8' },
      { LD_PRELOAD: '/x' },
      { NPM_TOKEN: 'x' },
      { npm_config__authToken: 'x' },
      { 'BAD NAME': 'x' },
      { HOME: 'with\0nul' },
    ]) {
      expect(() => buildChildEnv(base, extra, { platform: 'linux' })).toThrow(
        expect.objectContaining({ code: 'invalid_environment' }),
      );
    }
    try {
      buildChildEnv(base, { NPM_TOKEN: 'super-secret' }, { platform: 'linux' });
    } catch (error) {
      expect((error as Error).message).not.toContain('NPM_TOKEN');
      expect((error as Error).message).not.toContain('super-secret');
    }
  });

  it('keeps a host variable called __proto__ out of the result', () => {
    const base = JSON.parse('{"__proto__":"x","PATH":"/bin"}');
    const env = buildChildEnv(base, {}, { platform: 'linux' });
    expect(Object.getPrototypeOf(env)).toBe(Object.prototype);
    expect(Object.hasOwn(env, '__proto__')).toBe(false);
  });
});
