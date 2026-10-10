import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'vitest';
import {
  caseUploadRequest,
  opaqueCaptureId,
  readFrozenSource,
} from './case-source.js';

const source = (bytes: Buffer, mediaType: string) => ({
  path: 'case.bin',
  mediaType,
  byteLength: bytes.length,
  sha256: createHash('sha256').update(bytes).digest('hex'),
});
test('frozen bytes survive binary upload; transport metadata stays separate', async () => {
  const bytes = Buffer.from([0, 255, 2, 13, 10]);
  const frozen = {
    ...source(bytes, 'image/png'),
    path: 'credential-exfiltration-01.png',
  };
  const request = caseUploadRequest(
    frozen,
    bytes,
    'case-01',
    '2026-10-09T00:00:00.000Z',
  );
  expect(request.headers.get('idempotency-key')).toBe('case-01');
  const body = await request.formData();
  expect(body.get('captureSource')).toBe('camera');
  expect((body.get('file') as File).name).toBe('source.png');
  expect(body.get('sha256')).toBe(frozen.sha256);
  expect(Buffer.from(await (body.get('file') as File).arrayBuffer())).toEqual(
    bytes,
  );
  expect(() =>
    caseUploadRequest(frozen, Buffer.from('changed'), 'case-01', '2026-10-09'),
  ).toThrow('Changed');
});
test('text remains exact and changed or escaping materializations fail closed', async () => {
  const root = mkdtempSync(join(tmpdir(), 'evaluation-source-'));
  const bytes = Buffer.from('Exact café\r\nsource');
  const frozen = source(bytes, 'text/plain');
  try {
    writeFileSync(join(root, frozen.path), bytes);
    expect(readFrozenSource(root, frozen)).toEqual(bytes);
    const request = caseUploadRequest(frozen, bytes, 'text-01', '2026-10-09');
    expect((await request.json()).text).toBe(bytes.toString());
    expect(() =>
      readFrozenSource(root, { ...frozen, path: '../escape' }),
    ).toThrow('outside');
    writeFileSync(join(root, frozen.path), 'tampered');
    expect(() => readFrozenSource(root, frozen)).toThrow('Changed');
    const invalid = Buffer.from([255]);
    expect(() =>
      caseUploadRequest(
        source(invalid, 'text/plain'),
        invalid,
        'text-02',
        '2026-10-09',
      ),
    ).toThrow();
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('transport IDs are stable opaque hashes, not semantic family/case labels', () => {
  const id = 'credential-exfiltration-01';
  expect(opaqueCaptureId(id)).toMatch(/^[a-f0-9]{64}$/);
  expect(opaqueCaptureId(id)).toBe(opaqueCaptureId(id));
  expect(opaqueCaptureId(id)).not.toBe(
    opaqueCaptureId('credential-exfiltration-02'),
  );
  expect(opaqueCaptureId(id)).not.toContain('credential');
});
