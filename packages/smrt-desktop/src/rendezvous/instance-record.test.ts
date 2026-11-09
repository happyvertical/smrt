import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { DesktopContractError } from '../errors.js';
import {
  INSTANCE_RECORD_FILENAME,
  type InstanceRecordV1,
  isInstanceNonce,
  parseInstanceRecord,
  serializeInstanceRecord,
} from './instance-record.js';

const example = readFileSync(
  new URL('../../examples/instance.json', import.meta.url),
  'utf8',
);
const base = JSON.parse(example) as Record<string, unknown>;
const TOKEN = 'smrt_mcp_LEAKCANARY0123456789';

function parse(overrides: Record<string, unknown>) {
  return parseInstanceRecord(JSON.stringify({ ...base, ...overrides }));
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
function without(key: string): string {
  const copy = { ...base };
  delete copy[key];
  return JSON.stringify(copy);
}

describe('instance record v1', () => {
  it('uses the documented file name', () => {
    expect(INSTANCE_RECORD_FILENAME).toBe('instance.json');
  });

  it('accepts the packaged example and freezes it', () => {
    const parsed = parseInstanceRecord(example);
    expect(parsed).toEqual(base);
    expect(Object.isFrozen(parsed)).toBe(true);
    expect(Object.isFrozen(parsed.control)).toBe(true);
  });

  it('round-trips through the canonical serializer', () => {
    const parsed = parseInstanceRecord(example);
    const text = serializeInstanceRecord(parsed);
    expect(text.endsWith('}\n')).toBe(true);
    expect(parseInstanceRecord(text)).toEqual(parsed);
    expect(serializeInstanceRecord(parseInstanceRecord(text))).toBe(text);
  });

  it('accepts starting and failed records without an origin', () => {
    const starting = parse({ state: 'starting', origin: undefined });
    expect(starting.origin).toBeUndefined();
    const failed = parse({
      state: 'failed',
      origin: undefined,
      failure: 'lease_held',
    });
    expect(failed.failure).toBe('lease_held');
    expect(serializeInstanceRecord(failed)).not.toContain('origin');
  });

  it('accepts a Windows named pipe endpoint', () => {
    const parsed = parse({
      control: {
        kind: 'pipe',
        name: '\\\\.\\pipe\\smrt-0123456789abcdef-00112233445566778899aabbccddeeff',
      },
    });
    expect(parsed.control.kind).toBe('pipe');
  });

  it.each([
    ['productId', 'Not A Slug'],
    ['bundleId', 'nodots'],
    ['instanceNonce', 'ABCDEF'],
    ['instanceNonce', '0f1e2d3c4b5a69788796a5b4c3d2e1f'],
    ['pid', 0],
    ['pid', -4],
    ['pid', 1.5],
    ['pid', '4242'],
    ['shellVersion', '1.4'],
    ['startedAt', '2026-11-01'],
    ['updatedAt', '2026-02-30T00:00:00Z'],
    ['state', 'running'],
    ['origin', 'http://localhost:49152'],
    ['origin', 'http://[::1]:49152'],
    ['origin', 'https://127.0.0.1:49152'],
    ['origin', 'http://127.0.0.1:0'],
    ['origin', 'http://127.0.0.1:65536'],
    ['origin', 'http://127.0.0.1:049152'],
    ['origin', 'http://user@127.0.0.1:49152'],
    ['origin', 'http://127.0.0.1:49152/'],
    ['origin', 'http://127.0.0.1:49152/path'],
    ['control', { kind: 'tcp', port: 80 }],
    ['control', { kind: 'unix', path: 'relative.sock' }],
  ])('rejects an invalid %s (%j)', (field, value) => {
    expect(failure(() => parse({ [field]: value })).code).toBe('invalid_field');
  });

  it('requires origin exactly when ready, failure exactly when failed', () => {
    expect(failure(() => parseInstanceRecord(without('origin'))).code).toBe(
      'invalid_field',
    );
    expect(failure(() => parse({ state: 'starting' })).code).toBe(
      'invalid_field',
    );
    expect(
      failure(() => parse({ state: 'failed', origin: undefined })).code,
    ).toBe('invalid_field');
    expect(failure(() => parse({ failure: 'lease_held' })).code).toBe(
      'invalid_field',
    );
    expect(
      failure(() =>
        parse({ state: 'failed', origin: undefined, failure: 'launch_failed' }),
      ).code,
    ).toBe('invalid_field');
  });

  it('reads a failure code from a newer shell as unknown, not as tampering', () => {
    const record = parse({
      state: 'failed',
      origin: undefined,
      failure: 'disk_on_fire',
    });
    expect(record.failure).toBe('unknown');
    for (const bad of [5, null, 'Not A Code', TOKEN]) {
      expect(
        failure(() =>
          parse({ state: 'failed', origin: undefined, failure: bad }),
        ).code,
      ).toBe('invalid_field');
    }
  });

  it('rejects missing and unknown fields', () => {
    for (const key of [
      'productId',
      'instanceNonce',
      'pid',
      'shellVersion',
      'startedAt',
      'control',
      'state',
    ]) {
      expect(failure(() => parseInstanceRecord(without(key))).code).toBe(
        'invalid_document',
      );
    }
    expect(failure(() => parse({ token: TOKEN })).code).toBe(
      'invalid_document',
    );
  });

  it('rejects unknown and missing versions', () => {
    expect(failure(() => parse({ version: 2 })).code).toBe(
      'unsupported_contract',
    );
    expect(failure(() => parse({ version: '1' })).code).toBe(
      'unsupported_contract',
    );
    expect(failure(() => parseInstanceRecord(without('version'))).code).toBe(
      'invalid_document',
    );
  });

  it('rejects malformed JSON, duplicate keys and non-objects', () => {
    expect(failure(() => parseInstanceRecord('{')).code).toBe('invalid_json');
    expect(failure(() => parseInstanceRecord('[]')).code).toBe(
      'invalid_document',
    );
    expect(failure(() => parseInstanceRecord('null')).code).toBe(
      'invalid_document',
    );
    expect(
      failure(() =>
        parseInstanceRecord(
          example.replace('"pid": 4242,', '"pid": 4242, "pid": 1,'),
        ),
      ).code,
    ).toBe('duplicate_keys');
    expect(
      failure(() =>
        parseInstanceRecord(
          example.replace('"kind": "unix",', '"kind": "unix", "kind": "unix",'),
        ),
      ).code,
    ).toBe('duplicate_keys');
    expect(
      failure(() => parseInstanceRecord(undefined as unknown as string)).code,
    ).toBe('invalid_json');
  });

  it('refuses to serialize an invalid record', () => {
    const record = { ...parseInstanceRecord(example), pid: 0 };
    expect(failure(() => serializeInstanceRecord(record)).code).toBe(
      'invalid_field',
    );
  });

  it('keeps token-bearing input out of every error', () => {
    const inputs = [
      JSON.stringify({ ...base, productId: TOKEN }),
      JSON.stringify({ ...base, origin: `http://127.0.0.1:1/${TOKEN}` }),
      JSON.stringify({ ...base, [TOKEN]: 1 }),
      JSON.stringify({ ...base, control: { kind: 'unix', path: `/${TOKEN}` } }),
      `{"${TOKEN}": 1, "${TOKEN}": 2}`,
      `{"version": "${TOKEN}"}`,
      TOKEN,
    ];
    for (const input of inputs) {
      const error = failure(() => parseInstanceRecord(input));
      expect(error.message).not.toContain(TOKEN);
      expect(error.stack ?? '').not.toContain(TOKEN);
      expect(error.field ?? '').not.toContain(TOKEN);
    }
  });

  it('recognises instance nonces', () => {
    expect(isInstanceNonce('0f1e2d3c4b5a69788796a5b4c3d2e1f0')).toBe(true);
    expect(isInstanceNonce('0F1E2D3C4B5A69788796A5B4C3D2E1F0')).toBe(false);
    expect(isInstanceNonce(5)).toBe(false);
  });

  it('types a record', () => {
    const record: InstanceRecordV1 = parseInstanceRecord(example);
    expect(record.state).toBe('ready');
  });
});
