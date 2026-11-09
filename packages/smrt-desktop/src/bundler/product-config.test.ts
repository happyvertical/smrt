import {
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isPackagePattern, matchPackageName } from './graph.js';
import {
  DEFAULT_SIDECAR_ARGS,
  FEATURE_CATALOG,
  parseProductConfig,
  readProductConfig,
  resolveFeatures,
  SIDECAR_NODE_FLAG_ALLOWLIST,
} from './product-config.js';
import { BundleTreeError, TREE_ERROR_MESSAGE_TABLE } from './tree-errors.js';

const valid = {
  version: 1,
  productId: 'smrt-start',
  bundleId: 'com.happyvertical.smrt-start',
  displayName: 'SMRT Start',
  bridge: { envPrefix: 'SMRT_START', mcpPath: '/api/mcp' },
  sidecar: {
    healthRoute: '/api/_runtime/health',
    dataDirectory: 'runtime',
  },
  features: { default: [], custom: {} },
  exclude: [],
  maxSizeMB: 350,
  nativeExceptions: [],
};

function parse(overrides: Record<string, unknown> | null) {
  return parseProductConfig(
    JSON.stringify(overrides === null ? valid : { ...valid, ...overrides }),
  );
}

function failure(run: () => unknown): BundleTreeError {
  try {
    run();
  } catch (error) {
    expect(error).toBeInstanceOf(BundleTreeError);
    return error as BundleTreeError;
  }
  throw new Error('expected a BundleTreeError');
}

describe('parseProductConfig', () => {
  it('parses the documented example and freezes the result', () => {
    const config = parse(null);
    expect(config).toMatchObject({
      version: 1,
      productId: 'smrt-start',
      bridge: { envPrefix: 'SMRT_START', mcpPath: '/api/mcp' },
      maxSizeMB: 350,
    });
    expect(config.sidecar.args).toEqual(DEFAULT_SIDECAR_ARGS);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.features.default)).toBe(true);
  });

  it('accepts the minimal document and fills defaults', () => {
    const config = parseProductConfig(
      JSON.stringify({
        version: 1,
        productId: 'notes',
        bundleId: 'com.example.notes',
        displayName: 'Notes',
      }),
    );
    expect(config.sidecar).toEqual({
      args: ['app/build/index.js'],
      healthRoute: '/api/_runtime/health',
      dataDirectory: 'runtime',
    });
    expect(config.features).toEqual({ default: [], custom: {} });
    expect(config.exclude).toEqual([]);
    expect(config.bridge).toBeUndefined();
    expect(config.maxSizeMB).toBeUndefined();
  });

  it('accepts a leading byte order mark', () => {
    expect(parseProductConfig(`﻿${JSON.stringify(valid)}`).productId).toBe(
      'smrt-start',
    );
  });

  it('accepts the full optional surface', () => {
    const config = parse({
      sidecar: {
        executable: 'smrt-start-node',
        args: ['--max-old-space-size=512', 'app/build/index.js'],
        healthRoute: '/health',
        dataDirectory: 'data/runtime',
        ownerClaimRoute: '/setup',
      },
      features: {
        default: ['images', 'reports'],
        custom: { reports: { packages: ['@acme/reports', 'chart-*'] } },
      },
      exclude: ['moment', '@types/*'],
      nativeExceptions: [
        { path: 'foo/prebuilds/*/foo.node', reason: 'Wrong arch is deleted' },
      ],
      acknowledgedDynamicImports: [{ from: 'ws', specifier: 'bufferutil' }],
    });
    expect(config.sidecar.ownerClaimRoute).toBe('/setup');
    expect(config.features.default).toEqual(['images', 'reports']);
    expect(config.acknowledgedDynamicImports).toEqual([
      { from: 'ws', specifier: 'bufferutil' },
    ]);
  });

  describe('document-level negatives', () => {
    it.each([
      ['not json', '{nope', 'config_invalid_json'],
      ['empty', '', 'config_invalid_json'],
      ['array', '[]', 'invalid_product_config'],
      ['null', 'null', 'invalid_product_config'],
      ['string', '"x"', 'invalid_product_config'],
      [
        'duplicate top-level key',
        '{"version":1,"version":1,"productId":"a","bundleId":"a.b","displayName":"A"}',
        'config_duplicate_keys',
      ],
      [
        'duplicate nested key',
        JSON.stringify(valid).replace(
          '"envPrefix":"SMRT_START"',
          '"envPrefix":"A","envPrefix":"B"',
        ),
        'config_duplicate_keys',
      ],
      [
        'unknown top-level key',
        JSON.stringify({ ...valid, extra: 1 }),
        'invalid_product_config',
      ],
      [
        'missing productId',
        JSON.stringify({ ...valid, productId: undefined }),
        'invalid_product_config',
      ],
      [
        'missing version',
        JSON.stringify({ ...valid, version: undefined }),
        'invalid_product_config',
      ],
      [
        'unsupported version',
        JSON.stringify({ ...valid, version: 2 }),
        'config_unsupported_version',
      ],
      [
        'string version',
        JSON.stringify({ ...valid, version: '1' }),
        'config_unsupported_version',
      ],
    ])('rejects %s', (_name, text, code) => {
      expect(failure(() => parseProductConfig(text)).code).toBe(code);
    });

    it('rejects a non-string argument', () => {
      expect(
        failure(() => parseProductConfig(undefined as unknown as string)).code,
      ).toBe('config_invalid_json');
    });
  });

  describe('field negatives', () => {
    const cases: [string, Record<string, unknown>][] = [
      ['productId', { productId: 'Smrt' }],
      ['productId', { productId: 'a_b' }],
      ['productId', { productId: '-x' }],
      ['productId', { productId: 'x'.repeat(65) }],
      ['productId', { productId: 7 }],
      ['bundleId', { bundleId: 'nodots' }],
      ['bundleId', { bundleId: 'aux.example.app' }],
      ['bundleId', { bundleId: 'com.example.app/..' }],
      ['displayName', { displayName: '' }],
      ['displayName', { displayName: ' padded ' }],
      ['displayName', { displayName: 'line\nbreak' }],
      ['displayName', { displayName: 'rtl‮override' }],
      ['bridge', { bridge: { envPrefix: 'A' } }],
      ['bridge', { bridge: { envPrefix: 'A', mcpPath: '/m', extra: 1 } }],
      ['bridge.envPrefix', { bridge: { envPrefix: 'lower', mcpPath: '/m' } }],
      ['bridge.mcpPath', { bridge: { envPrefix: 'A', mcpPath: 'no-slash' } }],
      ['sidecar', { sidecar: [] }],
      ['sidecar', { sidecar: { unknown: 1 } }],
      ['sidecar.healthRoute', { sidecar: { healthRoute: '/a b' } }],
      ['sidecar.healthRoute', { sidecar: { healthRoute: 'health' } }],
      ['sidecar.dataDirectory', { sidecar: { dataDirectory: '../x' } }],
      ['sidecar.dataDirectory', { sidecar: { dataDirectory: '/abs' } }],
      ['sidecar.ownerClaimRoute', { sidecar: { ownerClaimRoute: 'x' } }],
      ['sidecar.executable', { sidecar: { executable: 'node' } }],
      ['sidecar.executable', { sidecar: { executable: 'other-node' } }],
      ['sidecar.args', { sidecar: { args: [] } }],
      ['sidecar.args', { sidecar: { args: ['--max-old-space-size=1'] } }],
      ['sidecar.args', { sidecar: { args: ['-e', 'evil()'] } }],
      ['sidecar.args', { sidecar: { args: ['--require=./x.js', 'a.js'] } }],
      ['sidecar.args', { sidecar: { args: ['--import', 'x', 'a.js'] } }],
      ['sidecar.args', { sidecar: { args: ['--inspect=0.0.0.0', 'a.js'] } }],
      ['sidecar.args', { sidecar: { args: ['../escape.js'] } }],
      ['sidecar.args', { sidecar: { args: ['/abs.js'] } }],
      ['sidecar.args', { sidecar: { args: ['bad arg'] } }],
      ['sidecar.args', { sidecar: { args: 'app.js' } }],
      ['sidecar.args', { sidecar: { args: Array(17).fill('a') } }],
      ['features', { features: [] }],
      ['features', { features: { nope: 1 } }],
      ['features.default', { features: { default: ['nope'] } }],
      ['features.default', { features: { default: ['toolchain'] } }],
      ['features.default', { features: { default: ['Images'] } }],
      ['features.default', { features: { default: ['images', 'images'] } }],
      [
        'features.custom',
        { features: { custom: { images: { packages: ['a'] } } } },
      ],
      [
        'features.custom',
        { features: { custom: { Bad: { packages: ['a'] } } } },
      ],
      [
        'features.custom',
        { features: { custom: { ok: { packages: ['../x'] } } } },
      ],
      ['features.custom', { features: { custom: { ok: {} } } }],
      [
        'features.custom',
        { features: { custom: { ok: { packages: [], x: 1 } } } },
      ],
      ['exclude', { exclude: ['a b'] }],
      ['exclude', { exclude: ['x', 'x'] }],
      ['exclude', { exclude: 'x' }],
      ['maxSizeMB', { maxSizeMB: 0 }],
      ['maxSizeMB', { maxSizeMB: 1.5 }],
      ['maxSizeMB', { maxSizeMB: '350' }],
      ['maxSizeMB', { maxSizeMB: 100_001 }],
      ['nativeExceptions', { nativeExceptions: [{ path: 'a' }] }],
      [
        'nativeExceptions',
        { nativeExceptions: [{ path: '../a', reason: 'x' }] },
      ],
      ['nativeExceptions', { nativeExceptions: [{ path: '/a', reason: 'x' }] }],
      [
        'nativeExceptions',
        { nativeExceptions: [{ path: 'a b', reason: 'x' }] },
      ],
      ['nativeExceptions', { nativeExceptions: [{ path: 'a', reason: '' }] }],
      [
        'nativeExceptions',
        { nativeExceptions: [{ path: 'a', reason: 'x', y: 1 }] },
      ],
      ['nativeExceptions', { nativeExceptions: {} }],
      [
        'acknowledgedDynamicImports',
        { acknowledgedDynamicImports: [{ from: 'a' }] },
      ],
      [
        'acknowledgedDynamicImports',
        { acknowledgedDynamicImports: [{ from: 'a b', specifier: 'x' }] },
      ],
      [
        'acknowledgedDynamicImports',
        { acknowledgedDynamicImports: [{ from: '', specifier: 'x' }] },
      ],
    ];
    it.each(cases)('rejects an invalid %s', (field, overrides) => {
      const error = failure(() => parse(overrides));
      expect(error.code).toBe('config_invalid_field');
      expect(error.field).toBe(field);
    });
  });

  it('never echoes a value in the error message or JSON form', () => {
    const error = failure(() => parse({ productId: 'EVIL-VALUE-TOKEN' }));
    expect(error.message).toBe(TREE_ERROR_MESSAGE_TABLE.config_invalid_field);
    expect(JSON.stringify(error)).not.toContain('EVIL-VALUE-TOKEN');
    expect(error.stack ?? '').not.toContain('EVIL-VALUE-TOKEN');
  });

  it('does not let __proto__ keys through custom features', () => {
    const text =
      '{"version":1,"productId":"a","bundleId":"a.b","displayName":"A","features":{"custom":{"__proto__":{"packages":["x"]}}}}';
    expect(failure(() => parseProductConfig(text)).field).toBe(
      'features.custom',
    );
  });
});

describe('sidecar Node flags are an allowlist', () => {
  const args = (...items: string[]) => ({ sidecar: { args: items } });
  const parsed = (...items: string[]) => parse(args(...items)).sidecar.args;
  const rejected = (...items: string[]) => {
    const error = failure(() => parse(args(...items)));
    expect(error.code).toBe('config_invalid_field');
    expect(error.field).toBe('sidecar.args');
  };

  it('documents the one flag a product may set, exactly and only before the script', () => {
    expect(SIDECAR_NODE_FLAG_ALLOWLIST).toHaveLength(1);
    expect(Object.isFrozen(SIDECAR_NODE_FLAG_ALLOWLIST)).toBe(true);
    expect(parsed('--max-old-space-size=512', 'app/build/index.js')).toEqual([
      '--max-old-space-size=512',
      'app/build/index.js',
    ]);
    expect(parsed('--max-old-space-size=10', 'a.js')).toHaveLength(2);
    expect(parsed('--max-old-space-size=999999', 'a.js')).toHaveLength(2);
    expect(parsed('app/build/index.mjs')).toEqual(['app/build/index.mjs']);
    expect(parsed('app/build/index.js', '3000', 'data/x')).toEqual([
      'app/build/index.js',
      '3000',
      'data/x',
    ]);
  });

  const eachCase = (cases: string[][]) =>
    cases.map((flag) => [JSON.stringify(flag), flag] as const);

  it.each(
    eachCase([
      // The flags the denylist let through.
      ['--conditions=development'],
      ['--conditions', 'development'],
      ['-C', 'development'],
      ['-C=development'],
      ['--security-revert=CVE-2023-46809'],
      ['--insecure-http-parser'],
      ['--experimental-config-file=node.json'],
      ['--env-file-if-exists=.env'],
      // The ones it did block, still blocked.
      ['-e'],
      ['--eval=1'],
      ['-p'],
      ['-r'],
      ['--require=./x.js'],
      ['--import=./x.js'],
      ['--loader=./x.js'],
      ['--experimental-loader=./x.js'],
      ['--env-file=.env'],
      ['--inspect=0.0.0.0'],
      ['--inspect-brk'],
      ['--watch'],
      ['--test'],
      ['--interactive'],
      // Node options that were never on any list.
      ['--experimental-vm-modules'],
      ['--disable-proto=delete'],
      ['--allow-natives-syntax'],
      ['--expose-gc'],
      ['--openssl-config=x.cnf'],
      ['--use-openssl-ca'],
      ['--tls-min-v1.0'],
      ['--max-http-header-size=1'],
      ['--permission'],
      ['--stack-size=5000'],
      ['--experimental-default-type=module'],
    ]),
  )('rejects the Node flags %s before a valid script', (_label, flag) => {
    rejected(...flag, 'app/build/index.js');
  });

  it.each(
    eachCase([
      // Abbreviation, spelling and value forms of the one allowed flag.
      ['--max-old-space=512'],
      ['--max-old=512'],
      ['--max-old-space-s=512'],
      ['--max_old_space_size=512'],
      ['--Max-Old-Space-Size=512'],
      ['--max-old-space-size'],
      ['--max-old-space-size='],
      ['--max-old-space-size', '512'],
      ['--max-old-space-size=1'],
      ['--max-old-space-size=0512'],
      ['--max-old-space-size=512mb'],
      ['--max-old-space-size=1000000'],
      ['--max-old-space-size=-1'],
      ['--max-old-space-size=512,--require=./x.js'],
      ['--max-old-space-size=512 --require=./x.js'],
      ['--max-old-space-size=512\n--require=./x.js'],
      ['--max-old-space-size=512', '--max-old-space-size=1024'],
      ['-max-old-space-size=512'],
      ['---max-old-space-size=512'],
    ]),
  )('rejects the spelling %s of the allowed flag', (_label, flag) => {
    rejected(...flag, 'app/build/index.js');
  });

  it('rejects NODE_OPTIONS-style smuggling through the arguments', () => {
    rejected('NODE_OPTIONS=--require=./x.js', 'app/build/index.js');
    rejected('--node-options=--require=./x.js', 'app/build/index.js');
    rejected('--node-options', '--require=./x.js', 'app/build/index.js');
    rejected('--env-file=.env', 'app/build/index.js');
    // A plain first argument must be a script, not an assignment or a value.
    rejected('NODE_OPTIONS=--require=./x.js');
    rejected('3000');
    rejected('app/build/index');
    rejected('app/build/index.json');
    // Nothing after the script may be a flag (Node would not read it; the
    // allowlist stays the only place a dash is accepted).
    rejected('app/build/index.js', '--max-old-space-size=512');
    rejected('app/build/index.js', '--require=./x.js');
    rejected('app/build/index.js', '-e');
    rejected('app/build/index.js', 'NODE_OPTIONS=--require=./x.js');
  });

  it('rejects the -- terminator wherever it stands', () => {
    rejected('--', 'app/build/index.js');
    rejected('--max-old-space-size=512', '--', 'app/build/index.js');
    rejected('app/build/index.js', '--');
    rejected('-', 'app/build/index.js');
  });

  it('needs a script, and no argument may be empty or non-text', () => {
    rejected('--max-old-space-size=512');
    rejected('');
    rejected('app/build/index.js', '');
    expect(() => parse({ sidecar: { args: ['a.js', 3] } })).toThrow();
    expect(() => parse({ sidecar: { args: ['a.js', null] } })).toThrow();
  });
});

describe('feature catalog', () => {
  it('uses only valid, non-overlapping-by-name package patterns', () => {
    for (const [name, definition] of Object.entries(FEATURE_CATALOG)) {
      expect(definition.packages.length, name).toBeGreaterThan(0);
      for (const pattern of definition.packages) {
        expect(isPackagePattern(pattern), `${name}: ${pattern}`).toBe(true);
      }
    }
  });

  it('names exactly the catalogued features and keeps the toolchain out', () => {
    expect(Object.keys(FEATURE_CATALOG).sort()).toEqual([
      'ai-anthropic',
      'ai-google',
      'ai-openai',
      'ai-providers',
      'duckdb',
      'google-apis',
      'images',
      'ocr',
      'pdf',
      'toolchain',
      'vector-sqlite',
    ]);
    expect(FEATURE_CATALOG.toolchain?.enableable).toBe(false);
    expect(Object.isFrozen(FEATURE_CATALOG)).toBe(true);
    expect(Object.isFrozen(FEATURE_CATALOG['google-apis']?.packages)).toBe(
      true,
    );
  });
});

describe('resolveFeatures', () => {
  const base = parse(null);

  it('disables every feature that is not enabled, sorted by name', () => {
    const resolved = resolveFeatures(base, []);
    expect(resolved.enabled).toEqual([]);
    expect(resolved.disabled.map((group) => group.label)).toEqual([
      'feature:ai-anthropic',
      'feature:ai-google',
      'feature:ai-openai',
      'feature:ai-providers',
      'feature:duckdb',
      'feature:google-apis',
      'feature:images',
      'feature:ocr',
      'feature:pdf',
      'feature:toolchain',
      'feature:vector-sqlite',
    ]);
  });

  it('removes an enabled feature from the disabled groups', () => {
    const resolved = resolveFeatures(base, ['images', 'duckdb', 'images']);
    expect(resolved.enabled).toEqual(['duckdb', 'images']);
    const labels = resolved.disabled.map((group) => group.label);
    expect(labels).not.toContain('feature:images');
    expect(labels).not.toContain('feature:duckdb');
    expect(labels).toContain('feature:google-apis');
  });

  it('keeps the runtime helpers of compiled models out of the toolchain', () => {
    const toolchain = FEATURE_CATALOG.toolchain?.packages ?? [];
    expect(
      toolchain.some((p) => matchPackageName(p, '@oxc-project/runtime')),
    ).toBe(false);
    expect(toolchain.some((p) => matchPackageName(p, 'oxc-transform'))).toBe(
      true,
    );
    expect(
      toolchain.some((p) => matchPackageName(p, '@oxc-project/types')),
    ).toBe(true);
    expect(
      toolchain.some((p) =>
        matchPackageName(p, '@oxc-parser/binding-darwin-arm64'),
      ),
    ).toBe(true);
  });

  it('keeps a single provider SDK when only that provider is enabled', () => {
    const resolved = resolveFeatures(base, ['ai-anthropic']);
    const providers = resolved.disabled.find(
      (group) => group.label === 'feature:ai-providers',
    );
    expect(providers?.patterns).toEqual(['@google/genai', 'openai']);
    expect(resolved.disabled.map((group) => group.label)).not.toContain(
      'feature:ai-anthropic',
    );
  });

  it('drops the provider groups entirely when every provider is enabled', () => {
    const labels = resolveFeatures(base, ['ai-providers']).disabled.map(
      (group) => group.label,
    );
    expect(labels).not.toContain('feature:ai-providers');
    expect(labels).not.toContain('feature:ai-anthropic');
    expect(labels).not.toContain('feature:ai-openai');
    expect(labels).not.toContain('feature:ai-google');
  });

  it('combines config defaults with requested features', () => {
    const config = parse({
      features: {
        default: ['ai-providers'],
        custom: { reports: { packages: ['@acme/reports'] } },
      },
      exclude: ['moment'],
    });
    const resolved = resolveFeatures(config, ['reports']);
    expect(resolved.enabled).toEqual(['ai-providers', 'reports']);
    const labels = resolved.disabled.map((group) => group.label);
    expect(labels).not.toContain('feature:reports');
    expect(labels.at(-1)).toBe('exclude');
    expect(resolved.disabled.at(-1)?.patterns).toEqual(['moment']);
  });

  it('includes a custom feature as disabled when it is not enabled', () => {
    const config = parse({
      features: { custom: { reports: { packages: ['@acme/reports'] } } },
    });
    const group = resolveFeatures(config, []).disabled.find(
      (item) => item.label === 'feature:reports',
    );
    expect(group?.patterns).toEqual(['@acme/reports']);
  });

  it('refuses unknown features and the toolchain', () => {
    for (const requested of [['nope'], ['toolchain'], ['__proto__']]) {
      const error = failure(() => resolveFeatures(base, requested));
      expect(error.code).toBe('invalid_option');
      expect(error.field).toBe('features');
    }
  });
});

describe('readProductConfig', () => {
  it('reads a regular file and refuses links and oversize files', async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), 'smrt-bundler-cfg-')));
    try {
      const file = join(dir, 'smrt-desktop.json');
      writeFileSync(file, JSON.stringify(valid));
      expect((await readProductConfig(file)).productId).toBe('smrt-start');

      symlinkSync(file, join(dir, 'link.json'));
      await expect(
        readProductConfig(join(dir, 'link.json')),
      ).rejects.toMatchObject({ code: 'symlink_refused' });

      const big = join(dir, 'big.json');
      writeFileSync(big, ' '.repeat(65 * 1024));
      await expect(readProductConfig(big)).rejects.toMatchObject({
        code: 'file_too_large',
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
