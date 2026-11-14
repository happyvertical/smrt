import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  buildSidecarEnv,
  parseSidecarManifest,
  RESERVED_ENV_KEYS,
  serializeSidecarManifest,
} from './sidecar-manifest.js';

const example = readFileSync(
  new URL('../examples/node26-sidecar.json', import.meta.url),
  'utf8',
);
const manifest = {
  version: 1,
  executable: 'smrt-notes-node',
  args: ['app/build/index.js'],
  healthRoute: '/api/_runtime/health',
  dataDirectory: 'runtime',
  env: {
    NODE_ENV: 'production',
    NODE_OPTIONS: '',
    NODE_PATH: '',
    SMRT_APP_ID: 'smrt-notes',
  },
};

function parse(overrides: Record<string, unknown>) {
  return parseSidecarManifest(JSON.stringify({ ...manifest, ...overrides }));
}

describe('sidecar manifest v1', () => {
  it('accepts the packaged Node 26 example', () => {
    expect(parseSidecarManifest(example)).toEqual(manifest);
  });

  it('accepts nested data directories and preserves literal arguments', () => {
    const overrides = {
      executable: 'node.exe',
      dataDirectory: 'runtime/local-v1',
      args: ['script with spaces.js', '', '$HOME', ';', '🪴'],
      healthRoute: '/runtime/~v1/live/',
    };
    expect(parse(overrides)).toEqual({ ...manifest, ...overrides });
    expect(parse({ args: [], healthRoute: '/' }).args).toEqual([]);
  });

  it('omits optional keys that were not given', () => {
    const { env: _env, ...required } = manifest;
    const parsed = parseSidecarManifest(JSON.stringify(required));
    expect(Object.keys(parsed)).toEqual(Object.keys(required));
  });

  it.each([
    { env: {} },
    { env: { NODE_ENV: 'production', _x1: '', Mixed_Case: 'ü🪴' } },
    { ownerClaimRoute: '/' },
    { ownerClaimRoute: '/api/_runtime/owner-claim/' },
    { env: { A: 'b' }, ownerClaimRoute: '/claim' },
  ])('accepts optional fields %j', (overrides) => {
    expect(parse(overrides)).toEqual({ ...manifest, ...overrides });
  });

  it.each([
    '{ "sensitive":',
    '{"version":1,}',
    '',
    'null',
    'true',
    '"text"',
    '[]',
    '[{"a":1}]',
    '42',
  ])('rejects invalid JSON envelopes without echoing their contents', (json) => {
    expect(() => parseSidecarManifest(json)).toThrow(/^Sidecar manifest/);
    expect(() => parseSidecarManifest(json)).not.toThrow(/sensitive/);
  });

  it('rejects non-string input', () => {
    expect(() => parseSidecarManifest(42 as unknown as string)).toThrow(
      'JSON text',
    );
  });

  it.each([
    undefined,
    0,
    2,
    '1',
    null,
    true,
  ])('rejects version %j', (version) => {
    expect(() => parse({ version })).toThrow('supported version 1');
  });

  it.each(
    Object.keys(manifest).filter((key) => key !== 'version' && key !== 'env'),
  )('requires field %s', (key) => {
    expect(() => parse({ [key]: undefined })).toThrow('documented fields');
  });

  it('rejects unexpected fields', () => {
    expect(() => parse({ extra: 1 })).toThrow('documented fields');
    expect(() =>
      parseSidecarManifest(example.replace('{', '{"__proto__": {},')),
    ).toThrow('documented fields');
  });

  it.each([
    ['executable', [42, true, null, [], {}]],
    ['healthRoute', [42, true, null, [], {}]],
    ['dataDirectory', [42, true, null, [], {}]],
    ['ownerClaimRoute', [42, true, null, [], {}]],
    ['env', [42, true, 'A=b', null, ['A']]],
  ] as const)('rejects non-string or wrongly typed %s values', (key, values) => {
    for (const value of values) {
      expect(() => parse({ [key]: value })).toThrow(key);
    }
  });

  it.each([
    null,
    42,
    '',
    'a/b',
    'binaries/node',
    '/node',
    '../node',
    '..',
    '.',
    '.node',
    'node/',
    'C:/node',
    'C:node',
    '\\\\host\\node',
    'binaries\\node',
    'node:alt',
    '%2e%2e',
    'nödé',
    'node\u202e',
    'COM1.exe',
    'nul',
    'node.',
    'node ',
    'node\n',
  ])('rejects a non-basename executable %j', (value) => {
    expect(() => parse({ executable: value })).toThrow('executable');
  });

  it.each([
    'node',
    'node-v26',
    'my_app',
    'node.exe',
    'a.b.c',
    '_x',
    '9lives',
  ])('accepts executable basename %j', (value) => {
    expect(parse({ executable: value }).executable).toBe(value);
  });

  it.each([
    null,
    42,
    '',
    '/node',
    '../node',
    'binaries/../node',
    'binaries/./node',
    'binaries//node',
    'binaries/node/',
    'C:/node',
    'C:node',
    '\\\\host\\node',
    'binaries\\node',
    'binaries/node:alt',
    'binaries/%2e%2e/node',
    'binaries/COM1.exe',
    'binaries/nul/log',
    'binaries/node.',
    'binaries/node ',
    'binaries/node\n',
    // Unicode and dot-prefixed segments
    'runtimé',
    'run/ünï',
    '🪴',
    '.runtime',
    'run/.hidden',
    'run/..',
    // Windows device names, suffixes and trailing dots
    'CON',
    'con',
    'con.txt',
    'Prn.log',
    'AUX.tar.gz',
    'COM1',
    'com9.exe',
    'LPT9.x',
    'lpt0',
    'NUL.',
    'run/NUL.',
    'run/dir.',
    'dir./run',
  ])('rejects unsafe data directory values %j', (path) => {
    expect(() => parse({ dataDirectory: path })).toThrow('dataDirectory');
  });

  it.each([
    'COM10',
    'console',
    'nullable',
    'con_1',
    'lpt',
    'com',
    'run/a.b',
    'a-b_c.d',
  ])('accepts names that only resemble devices: %j', (path) => {
    expect(parse({ dataDirectory: path }).dataDirectory).toBe(path);
  });

  it.each([
    { args: 'build/index.js' },
    { args: null },
    { args: [42] },
    { args: [null] },
    { args: [['x']] },
    { args: ['one\0two'] },
    { args: ['\ud800'] },
    { args: ['ok', '\udc00'] },
  ])('rejects malformed args %j', (overrides) => {
    expect(() => parse(overrides)).toThrow('args');
  });

  const unsafeRoutes = [
    null,
    '',
    'health',
    'http://127.0.0.1/health',
    'https://example.com/health',
    '//example.com/health',
    '/\\example.com/health',
    '/foo//health',
    '/foo/../health',
    '/foo/./health',
    '/..',
    '/%2e%2e/health',
    '/%2f%2fexample.com',
    '/health?x=y',
    '/health#x',
    '/health\n',
    '/hëalth',
    '/a b',
  ];

  it.each(unsafeRoutes)('rejects unsafe health routes %j', (healthRoute) => {
    expect(() => parse({ healthRoute })).toThrow('healthRoute');
  });

  it.each(
    unsafeRoutes,
  )('applies the health route grammar to ownerClaimRoute %j', (route) => {
    expect(() => parse({ ownerClaimRoute: route })).toThrow('ownerClaimRoute');
  });

  describe('env', () => {
    const casings = (key: string) => [
      key,
      key.toLowerCase(),
      key[0] + key.slice(1).toLowerCase(),
      key
        .split('')
        .map((c, i) => (i % 2 ? c.toLowerCase() : c.toUpperCase()))
        .join(''),
    ];

    it('exports the reserved names', () => {
      expect([...RESERVED_ENV_KEYS]).toEqual([
        'HOST',
        'PORT',
        'ORIGIN',
        'SMRT_DATA_DIR',
        'SMRT_DESKTOP_OWNER_LINK_SECRET',
        'SMRT_DESKTOP_KEYCHAIN',
      ]);
    });

    it.each(
      RESERVED_ENV_KEYS.flatMap(casings),
    )('rejects reserved key %s without echoing its value', (key) => {
      const attempt = () => parse({ env: { [key]: 'secret-value' } });
      expect(attempt).toThrow('reserved');
      expect(attempt).not.toThrow(/secret-value/);
    });

    it.each([
      'ORIGINS',
      'PORT2',
      'HOSTNAME',
      'SMRT_DATA_DIRECTORY',
      'MY_HOST',
    ])('accepts non-reserved lookalike %s', (key) => {
      expect(parse({ env: { [key]: 'x' } }).env).toEqual({ [key]: 'x' });
    });

    it.each([
      '',
      '1A',
      'A-B',
      'A B',
      'A=B',
      'A.B',
      'Ünï',
      'A\0B',
      'A\n',
    ])('rejects invalid key %j', (key) => {
      expect(() => parse({ env: { [key]: 'x' } })).toThrow('env');
    });

    it.each([
      ['A', 'a'],
      ['Path', 'PATH'],
      ['x_Y', 'X_y'],
    ])('rejects keys colliding ignoring case: %s / %s', (a, b) => {
      expect(() => parse({ env: { [a]: '1', [b]: '2' } })).toThrow('unique');
    });

    it.each([
      42,
      true,
      null,
      ['x'],
      { nested: 'x' },
      'a\0b',
      '\0',
      '\ud800',
      'ok\udc00ok',
    ])('rejects invalid value %j', (value) => {
      const attempt = () => parse({ env: { OK: value } });
      expect(attempt).toThrow('env');
    });

    it('accepts paired surrogates and other control characters in values', () => {
      expect(parse({ env: { A: '🪴\n\t' } }).env).toEqual({ A: '🪴\n\t' });
    });

    it('keeps __proto__ as inert data', () => {
      const parsed = parseSidecarManifest(
        '{"version":1,"executable":"node","args":[],"healthRoute":"/",' +
          '"dataDirectory":"d","env":{"__proto__":"x","constructor":"y"}}',
      );
      expect(Object.getPrototypeOf(parsed.env)).toBe(Object.prototype);
      expect(Object.keys(parsed.env ?? {})).toEqual([
        '__proto__',
        'constructor',
      ]);
      expect(({} as Record<string, unknown>).x).toBeUndefined();
      expect(Object.hasOwn(Object.prototype, 'x')).toBe(false);
    });
  });

  describe('duplicate keys', () => {
    const base =
      '"version":1,"executable":"node","args":[],"healthRoute":"/",' +
      '"dataDirectory":"d"';

    it.each([
      ['top level', `{${base},"executable":"other"}`],
      ['top level unescaped', `{${base},"\\u0065xecutable":"other"}`],
      ['version', `{"version":1,${base}}`],
      ['env', `{${base},"env":{"A":"1","A":"2"}}`],
      ['env escaped', `{${base},"env":{"A":"1","\\u0041":"2"}}`],
      ['env __proto__', `{${base},"env":{"__proto__":"1","__proto__":"2"}}`],
      ['top-level __proto__', `{"__proto__":1,"__proto__":2,${base}}`],
      ['env case differs only', `{${base},"env":{"A":"1","a":"2"}}`],
      ['unknown nested', `{${base},"env":{"A":{"x":1,"x":2}}}`],
    ])('rejects duplicate keys: %s', (_name, json) => {
      expect(() => parseSidecarManifest(json)).toThrow(/^Sidecar manifest/);
    });

    it.each([
      ['top level', `{${base},"executable":"other"}`, 'repeat'],
      ['env', `{${base},"env":{"A":"1","A":"2"}}`, 'repeat'],
      [
        'env __proto__',
        `{${base},"env":{"__proto__":"1","__proto__":"2"}}`,
        'repeat',
      ],
    ])('uses a value-free duplicate diagnostic: %s', (_name, json, text) => {
      expect(() => parseSidecarManifest(json)).toThrow(text);
      expect(() => parseSidecarManifest(json)).not.toThrow(/other|__proto__/);
    });

    it('does not mistake string values or braces in strings for keys', () => {
      const json =
        '{"version":1,"executable":"node","args":["version","version"],' +
        '"healthRoute":"/","dataDirectory":"d",' +
        '"env":{"A":"{\\"x\\":1,\\"x\\":2}","B":"A"}}';
      expect(parseSidecarManifest(json).env).toEqual({
        A: '{"x":1,"x":2}',
        B: 'A',
      });
    });

    it('scans objects inside arrays per object', () => {
      const unknown = (value: string) => `{${base},"extra":${value}}`;
      expect(() => parseSidecarManifest(unknown('[{"a":1},{"a":2}]'))).toThrow(
        'documented fields',
      );
      expect(() => parseSidecarManifest(unknown('[{"a":1,"a":2}]'))).toThrow(
        'repeat',
      );
    });

    it('does not mistake keys at different depths for duplicates', () => {
      expect(
        parseSidecarManifest(`{${base},"env":{"version":"1","args":"x"}}`).env,
      ).toEqual({ version: '1', args: 'x' });
    });
  });
});

describe('buildSidecarEnv', () => {
  const supplied = {
    port: 49152,
    dataDirectory: '/home/me/.local/share/app/runtime',
  };

  it('applies supervisor values and the manifest env to the base', () => {
    expect(
      buildSidecarEnv({ env: { NODE_ENV: 'production' } }, supplied, {
        PATH: '/usr/bin',
        UNSET: undefined,
      }),
    ).toEqual({
      PATH: '/usr/bin',
      NODE_ENV: 'production',
      HOST: '127.0.0.1',
      PORT: '49152',
      ORIGIN: 'http://127.0.0.1:49152',
      SMRT_DATA_DIR: '/home/me/.local/share/app/runtime',
    });
  });

  it('applies the owner-link secret last, only when supplied, never from base or manifest', () => {
    const withSecret = buildSidecarEnv(
      { env: { smrt_desktop_owner_link_secret: 'manifest' } },
      { ...supplied, ownerLinkSecret: 'a'.repeat(64) },
      { Smrt_Desktop_Owner_Link_Secret: 'inherited' },
    );
    expect(withSecret.SMRT_DESKTOP_OWNER_LINK_SECRET).toBe('a'.repeat(64));
    expect(
      Object.keys(withSecret).filter((k) =>
        /^smrt_desktop_owner_link_secret$/i.test(k),
      ),
    ).toEqual(['SMRT_DESKTOP_OWNER_LINK_SECRET']);
    const without = buildSidecarEnv({}, supplied, {
      SMRT_DESKTOP_OWNER_LINK_SECRET: 'inherited',
    });
    expect('SMRT_DESKTOP_OWNER_LINK_SECRET' in without).toBe(false);
  });

  it('strips the keychain marker from base and manifest and never sets it', () => {
    const env = buildSidecarEnv(
      { env: { smrt_desktop_keychain: '1' } },
      supplied,
      { SMRT_DESKTOP_KEYCHAIN: '1', Smrt_Desktop_Keychain: '1' },
    );
    expect(Object.keys(env).some((k) => /keychain/i.test(k))).toBe(false);
  });

  it('works without a manifest env', () => {
    expect(Object.keys(buildSidecarEnv({}, supplied, {})).sort()).toEqual([
      'HOST',
      'ORIGIN',
      'PORT',
      'SMRT_DATA_DIR',
    ]);
  });

  it('strips inherited reserved names in any case so supplied values win', () => {
    const env = buildSidecarEnv({}, supplied, {
      HOST: '0.0.0.0',
      port: '80',
      Origin: 'https://evil.example',
      smrt_data_dir: '/elsewhere',
      Smrt_Data_Dir: '/elsewhere2',
      KEEP: '1',
    });
    expect(env).toEqual({
      KEEP: '1',
      HOST: '127.0.0.1',
      PORT: '49152',
      ORIGIN: 'http://127.0.0.1:49152',
      SMRT_DATA_DIR: '/home/me/.local/share/app/runtime',
    });
  });

  it('lets manifest env override base entries but never reserved names', () => {
    const env = buildSidecarEnv(
      { env: { KEEP: 'manifest', port: '1', Host: 'evil' } },
      supplied,
      { KEEP: 'base' },
    );
    expect(env.KEEP).toBe('manifest');
    expect(env.PORT).toBe('49152');
    expect(env.HOST).toBe('127.0.0.1');
    expect(
      Object.keys(env)
        .filter((k) => /^(host|port)$/i.test(k))
        .sort(),
    ).toEqual(['HOST', 'PORT']);
  });

  it('treats __proto__ as an ordinary variable', () => {
    const env = buildSidecarEnv(
      {
        env: parseSidecarManifest(
          '{"version":1,"executable":"node","args":[],"healthRoute":"/",' +
            '"dataDirectory":"d","env":{"__proto__":"x"}}',
        ).env,
      },
      supplied,
      {},
    );
    expect(Object.getPrototypeOf(env)).toBe(Object.prototype);
    expect(Object.hasOwn(env, '__proto__')).toBe(true);
    expect(Object.keys(env)).toContain('__proto__');
  });

  it('does not mutate its inputs', () => {
    const base = { A: '1', HOST: 'x' };
    const env = { B: '2' };
    buildSidecarEnv({ env }, supplied, base);
    expect(base).toEqual({ A: '1', HOST: 'x' });
    expect(env).toEqual({ B: '2' });
  });

  it.each([1, 65535, 8080])('accepts port %d', (port) => {
    expect(buildSidecarEnv({}, { ...supplied, port }, {}).PORT).toBe(
      String(port),
    );
  });

  it.each([
    0,
    -1,
    65536,
    1.5,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    '80' as unknown as number,
  ])('rejects port %j', (port) => {
    expect(() => buildSidecarEnv({}, { ...supplied, port }, {})).toThrow(
      'port',
    );
  });

  it.each([
    '/data',
    '/',
    '//server/share/data',
    'C:\\Users\\me\\AppData\\Roaming\\app\\runtime',
    'c:/Users/me/app',
    '\\\\server\\share\\data',
  ])('accepts absolute data directory %j', (dataDirectory) => {
    expect(
      buildSidecarEnv({}, { ...supplied, dataDirectory }, {}).SMRT_DATA_DIR,
    ).toBe(dataDirectory);
  });

  it.each([
    '',
    'runtime',
    './runtime',
    '../runtime',
    '~/runtime',
    'C:',
    'C:runtime',
    '\\runtime',
    '\\\\server',
    '\\\\server\\',
    '/data\0',
    '/data\ud800',
    42 as unknown as string,
    undefined as unknown as string,
  ])('rejects data directory %j', (dataDirectory) => {
    expect(() =>
      buildSidecarEnv({}, { ...supplied, dataDirectory }, {}),
    ).toThrow('data directory');
  });
});

describe('serializeSidecarManifest', () => {
  const full = {
    version: 1 as const,
    executable: 'smrt-notes-node',
    args: ['app/build/index.js'],
    healthRoute: '/api/_runtime/health',
    dataDirectory: 'runtime',
    env: { NODE_ENV: 'production', NODE_OPTIONS: '', NODE_PATH: '' },
    ownerClaimRoute: '/setup',
  };

  it('writes canonical JSON with a fixed key order and a trailing newline', () => {
    const text = serializeSidecarManifest(full);
    expect(text.endsWith('}\n')).toBe(true);
    expect(Object.keys(JSON.parse(text))).toEqual([
      'version',
      'executable',
      'args',
      'healthRoute',
      'dataDirectory',
      'env',
      'ownerClaimRoute',
    ]);
    // Key order of the input does not matter.
    const scrambled = Object.fromEntries(Object.entries(full).reverse());
    expect(serializeSidecarManifest(scrambled as typeof full)).toBe(text);
  });

  it('round-trips through the parser byte for byte', () => {
    const text = serializeSidecarManifest(full);
    expect(parseSidecarManifest(text)).toEqual(full);
    expect(serializeSidecarManifest(parseSidecarManifest(text))).toBe(text);
  });

  it('omits absent optional fields and keeps empty env values', () => {
    const { env: _env, ownerClaimRoute: _route, ...bare } = full;
    expect(Object.keys(JSON.parse(serializeSidecarManifest(bare)))).toEqual([
      'version',
      'executable',
      'args',
      'healthRoute',
      'dataDirectory',
    ]);
    expect(JSON.parse(serializeSidecarManifest(full)).env.NODE_OPTIONS).toBe(
      '',
    );
  });

  it('refuses a manifest the parser would reject', () => {
    expect(() =>
      serializeSidecarManifest({ ...full, env: { PORT: '1' } }),
    ).toThrow(/reserved/);
    expect(() =>
      serializeSidecarManifest({ ...full, executable: 'a/b' }),
    ).toThrow(/basename/);
    expect(() =>
      serializeSidecarManifest({ ...full, healthRoute: 'health' }),
    ).toThrow(/healthRoute/);
  });
});

describe('normal built-app working directory', () => {
  it('round trips the optional app cwd and rejects escapes and unknown directories', () => {
    const value = {
      ...manifest,
      workingDirectory: 'app' as const,
      args: ['build/index.js'],
    };
    expect(parseSidecarManifest(serializeSidecarManifest(value))).toEqual(
      value,
    );
    for (const workingDirectory of [
      '..',
      '../app',
      '/app',
      'app/build',
      '',
      null,
      1,
    ]) {
      expect(() =>
        parseSidecarManifest(JSON.stringify({ ...value, workingDirectory })),
      ).toThrow('workingDirectory');
    }
    expect(parseSidecarManifest(example).workingDirectory).toBeUndefined();
  });
});
