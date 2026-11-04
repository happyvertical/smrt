import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseSidecarManifest } from './index.js';

const example = readFileSync(
  new URL('../examples/node26-sidecar.json', import.meta.url),
  'utf8',
);
const manifest = {
  version: 1,
  executable: 'binaries/node',
  args: ['build/index.js'],
  healthRoute: '/api/_runtime/health',
  dataDirectory: 'runtime',
};

function parse(overrides: Record<string, unknown>) {
  return parseSidecarManifest(JSON.stringify({ ...manifest, ...overrides }));
}

describe('sidecar manifest v1', () => {
  it('accepts the packaged Node 26 example', () => {
    expect(parseSidecarManifest(example)).toEqual(manifest);
  });

  it('accepts nested portable paths and preserves literal arguments', () => {
    const overrides = {
      executable: 'binaries/node.exe',
      dataDirectory: 'runtime/local-v1',
      args: ['script with spaces.js', '', '$HOME', ';', '🪴'],
      healthRoute: '/runtime/~v1/live/',
    };
    expect(parse(overrides)).toEqual({ ...manifest, ...overrides });
    expect(parse({ args: [], healthRoute: '/' }).args).toEqual([]);
  });

  it.each([
    '{ "sensitive":',
    'null',
    '[]',
    '42',
  ])('rejects invalid JSON envelopes without echoing their contents', (json) => {
    expect(() => parseSidecarManifest(json)).toThrow(/^Sidecar manifest/);
    expect(() => parseSidecarManifest(json)).not.toThrow(/sensitive/);
  });

  it.each([undefined, 0, 2, '1', null])('rejects version %j', (version) => {
    expect(() => parse({ version })).toThrow('supported version 1');
  });

  it.each(
    Object.keys(manifest).filter((key) => key !== 'version'),
  )('requires field %s', (key) => {
    expect(() => parse({ [key]: undefined })).toThrow('documented fields');
  });

  it('rejects unexpected fields', () => {
    expect(() => parse({ env: {} })).toThrow('documented fields');
    expect(() =>
      parseSidecarManifest(example.replace('{', '{"__proto__": {},')),
    ).toThrow('documented fields');
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
  ])('rejects unsafe executable and data directory values %j', (path) => {
    expect(() => parse({ executable: path })).toThrow('executable');
    expect(() => parse({ dataDirectory: path })).toThrow('dataDirectory');
  });

  it.each([
    { args: 'build/index.js' },
    { args: null },
    { args: [42] },
    { args: ['one\0two'] },
    { args: ['\ud800'] },
  ])('rejects malformed args %j', (overrides) => {
    expect(() => parse(overrides)).toThrow('args');
  });

  it.each([
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
    '/%2e%2e/health',
    '/%2f%2fexample.com',
    '/health?x=y',
    '/health#x',
    '/health\n',
  ])('rejects unsafe health routes %j', (healthRoute) => {
    expect(() => parse({ healthRoute })).toThrow('healthRoute');
  });
});
