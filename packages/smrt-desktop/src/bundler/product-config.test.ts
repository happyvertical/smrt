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
import { isPackagePattern } from './graph.js';
import {
  DEFAULT_SIDECAR_ARGS,
  FEATURE_CATALOG,
  parseProductConfig,
  readProductConfig,
  resolveFeatures,
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
