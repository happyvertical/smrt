import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DesktopContractError } from '../errors.js';
import { parseSidecarManifest } from '../sidecar-manifest.js';
import {
  assertBundleMatchesSidecar,
  type BundleManifestV1,
  parseBundleManifest,
  serializeBundleManifest,
} from './bundle-manifest.js';

const read = (name: string) =>
  readFileSync(new URL(`../../examples/${name}`, import.meta.url), 'utf8');
const example = read('smrt-bundle.json');
const base = JSON.parse(example) as Record<string, unknown>;
const TOKEN = 'smrt_mcp_LEAKCANARY0123456789';

function parse(overrides: Record<string, unknown>) {
  return parseBundleManifest(JSON.stringify({ ...base, ...overrides }));
}
function bridge(overrides: Record<string, unknown>) {
  return parse({ bridge: { ...(base.bridge as object), ...overrides } });
}
function failure(fn: () => unknown): DesktopContractError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(DesktopContractError);
    return error as DesktopContractError;
  }
  throw new Error('expected a DesktopContractError');
}

describe('bundle manifest v1', () => {
  it('accepts the packaged example', () => {
    expect(parseBundleManifest(example)).toEqual(base);
  });

  it('returns a frozen snapshot', () => {
    const parsed = parseBundleManifest(example);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.bridge)).toBe(true);
    expect(Object.isFrozen(parsed.node)).toBe(true);
  });

  it('omits the optional bridge fields that were not given', () => {
    const parsed = bridge({ serverName: undefined, serverVersion: undefined });
    expect(Object.keys(parsed.bridge)).toEqual([
      'entry',
      'envPrefix',
      'mcpPath',
    ]);
  });

  it('round-trips through the canonical serializer', () => {
    const parsed = parseBundleManifest(example);
    const text = serializeBundleManifest(parsed);
    expect(text.endsWith('}\n')).toBe(true);
    expect(parseBundleManifest(text)).toEqual(parsed);
    expect(serializeBundleManifest(parseBundleManifest(text))).toBe(text);
    expect(Object.keys(JSON.parse(text))).toEqual(Object.keys(base));
  });

  it('serializes the minimal bridge without optional keys', () => {
    const minimal = bridge({ serverName: undefined, serverVersion: undefined });
    const text = serializeBundleManifest(minimal);
    expect(Object.keys(JSON.parse(text).bridge)).toEqual([
      'entry',
      'envPrefix',
      'mcpPath',
    ]);
  });

  it('refuses to serialize an invalid manifest', () => {
    const bad = { ...parseBundleManifest(example), productId: 'Not A Slug' };
    expect(failure(() => serializeBundleManifest(bad)).code).toBe(
      'invalid_field',
    );
    expect(
      failure(() => serializeBundleManifest({ ...bad, version: 2 } as never))
        .code,
    ).toBe('unsupported_contract');
  });

  it.each([
    ['{ "TOKEN":', 'invalid_json'],
    ['', 'invalid_json'],
    ['null', 'invalid_document'],
    ['[]', 'invalid_document'],
    ['"text"', 'invalid_document'],
    ['42', 'invalid_document'],
    ['{}', 'invalid_document'],
  ])('rejects the envelope %j', (json, code) => {
    expect(failure(() => parseBundleManifest(json)).code).toBe(code);
  });

  it('rejects non-string input', () => {
    expect(failure(() => parseBundleManifest(42 as never)).code).toBe(
      'invalid_json',
    );
  });

  it('rejects duplicate keys at any depth', () => {
    expect(
      failure(() =>
        parseBundleManifest(
          example.replace('"version": 1,', '"version": 1, "version": 1,'),
        ),
      ).code,
    ).toBe('duplicate_keys');
    expect(
      failure(() =>
        parseBundleManifest(
          example.replace('"envPrefix"', '"mcpPath": "/x", "envPrefix"'),
        ),
      ).code,
    ).toBe('duplicate_keys');
    expect(
      failure(() =>
        parseBundleManifest(
          example.replace(
            '"executable": "smrt-notes-node"',
            '"executable": "a", "executable": "b"',
          ),
        ),
      ).code,
    ).toBe('duplicate_keys');
  });

  it.each([
    undefined,
    0,
    2,
    '1',
    null,
    true,
  ])('rejects version %j', (version) => {
    const code =
      version === undefined ? 'invalid_document' : 'unsupported_contract';
    expect(failure(() => parse({ version })).code).toBe(code);
  });

  it('rejects unknown and missing fields', () => {
    expect(failure(() => parse({ extra: 1 })).code).toBe('invalid_document');
    expect(
      failure(() =>
        parseBundleManifest(example.replace('{', '{"__proto__": {},')),
      ).code,
    ).toBe('invalid_document');
    for (const key of Object.keys(base).filter((k) => k !== 'version')) {
      expect(failure(() => parse({ [key]: undefined })).code).toBe(
        'invalid_document',
      );
    }
    expect(failure(() => bridge({ extra: 1 })).code).toBe('invalid_field');
    expect(failure(() => bridge({ entry: undefined })).code).toBe(
      'invalid_field',
    );
    expect(
      failure(() => parse({ node: { executable: 'a', extra: 1 } })).code,
    ).toBe('invalid_field');
  });

  const invalidValues: [string, Record<string, unknown>][] = [
    ['productId', { productId: 'Notes' }],
    ['productId', { productId: '-notes' }],
    ['productId', { productId: 'a'.repeat(65) }],
    ['productId', { productId: 7 }],
    ['bundleId', { bundleId: 'single' }],
    ['bundleId', { bundleId: 'com.example.n\u00f6tes' }],
    ['bundleId', { bundleId: 'com..example' }],
    ['bundleId', { bundleId: 'aux.example.app' }],
    ['displayName', { displayName: '' }],
    ['displayName', { displayName: 'a\nb' }],
    ['displayName', { displayName: ' padded ' }],
    ['displayName', { displayName: 'x'.repeat(129) }],
    ['displayName', { displayName: 7 }],
    ['productVersion', { productVersion: '1.0' }],
    ['productVersion', { productVersion: 'v1.0.0' }],
    ['channel', { channel: 'Stable' }],
    ['channel', { channel: '' }],
    ['target', { target: 'darwin' }],
    ['target', { target: 'A-b-c' }],
    ['sidecarManifest', { sidecarManifest: '/sidecar-manifest.json' }],
    ['sidecarManifest', { sidecarManifest: '../sidecar-manifest.json' }],
    ['sidecarManifest', { sidecarManifest: 'a\\b.json' }],
    ['sidecarManifest', { sidecarManifest: 'C:/x.json' }],
    ['sidecarManifest', { sidecarManifest: '' }],
    ['node', { node: 'smrt-start-node' }],
    ['node', { node: null }],
    ['node.executable', { node: { executable: 'a/b' } }],
    ['node.executable', { node: { executable: '../node' } }],
    ['node.executable', { node: { executable: 'node.' } }],
    ['node.executable', { node: { executable: 'nul' } }],
    ['node.executable', { node: { executable: 'C:node' } }],
    ['node.executable', { node: { executable: '' } }],
    ['bridge', { bridge: 'bridge.mjs' }],
  ];
  it.each(invalidValues)('rejects an invalid %s: %j', (field, overrides) => {
    const error = failure(() => parse(overrides));
    expect(error.code).toBe('invalid_field');
    expect(error.field).toBe(field);
  });

  const invalidBridge: [string, Record<string, unknown>][] = [
    ['bridge.entry', { entry: 'bridge/index.ts' }],
    ['bridge.entry', { entry: 'bridge/index' }],
    ['bridge.entry', { entry: '/abs/bridge.mjs' }],
    ['bridge.entry', { entry: 'a/../bridge.mjs' }],
    ['bridge.entry', { entry: 'a\\bridge.mjs' }],
    ['bridge.envPrefix', { envPrefix: 'smrt_notes' }],
    ['bridge.envPrefix', { envPrefix: '1A' }],
    ['bridge.envPrefix', { envPrefix: 'A-B' }],
    ['bridge.mcpPath', { mcpPath: 'api/mcp' }],
    ['bridge.mcpPath', { mcpPath: 'http://127.0.0.1/api/mcp' }],
    ['bridge.mcpPath', { mcpPath: '/api/../mcp' }],
    ['bridge.mcpPath', { mcpPath: '/api/mcp?x=1' }],
    ['bridge.serverName', { serverName: '' }],
    ['bridge.serverName', { serverName: 'x'.repeat(65) }],
    ['bridge.serverName', { serverName: 7 }],
    ['bridge.serverVersion', { serverVersion: '1' }],
  ];
  it.each(invalidBridge)('rejects an invalid %s: %j', (field, overrides) => {
    const error = failure(() => bridge(overrides));
    expect(error.code).toBe('invalid_field');
    expect(error.field).toBe(field);
  });

  it('accepts the supported entry extensions', () => {
    expect(bridge({ entry: 'bridge.js' }).bridge.entry).toBe('bridge.js');
    expect(bridge({ entry: 'a/b/c.mjs' }).bridge.entry).toBe('a/b/c.mjs');
  });

  it('never echoes input in errors', () => {
    const inputs = [
      `{"${TOKEN}":1}`,
      JSON.stringify({ ...base, productId: TOKEN }),
      JSON.stringify({ ...base, bundleId: TOKEN }),
      JSON.stringify({ ...base, displayName: `${TOKEN}\n` }),
      JSON.stringify({ ...base, sidecarManifest: `/${TOKEN}` }),
      JSON.stringify({ ...base, node: { executable: `${TOKEN}/x` } }),
      JSON.stringify({
        ...base,
        bridge: { ...(base.bridge as object), entry: TOKEN },
      }),
      JSON.stringify({ ...base, version: TOKEN }),
      `{"${TOKEN}": 1, "${TOKEN}": 2}`,
      `{"${TOKEN}":`,
    ];
    for (const json of inputs) {
      const error = failure(() => parseBundleManifest(json));
      const text = `${error.message}\n${error.stack}\n${JSON.stringify(error)}\n${error.field ?? ''}`;
      expect(text).not.toContain('LEAKCANARY');
    }
  });
});

describe('assertBundleMatchesSidecar', () => {
  // The two shared examples describe the same product.
  const sidecar = parseSidecarManifest(read('node26-sidecar.json'));

  it('accepts a matching executable', () => {
    expect(() =>
      assertBundleMatchesSidecar(parseBundleManifest(example), sidecar),
    ).not.toThrow();
  });

  it('rejects a different executable with a fixed code', () => {
    const bundle: BundleManifestV1 = parse({ node: { executable: 'node' } });
    const error = failure(() => assertBundleMatchesSidecar(bundle, sidecar));
    expect(error.code).toBe('sidecar_mismatch');
    expect(error.message).not.toContain('node');
  });
});
