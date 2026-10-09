import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';

export interface FrozenCaseSource {
  path: string;
  mediaType: string;
  sha256: string;
  byteLength: number;
  durationSeconds?: number;
}
/** Stable transport identity contains no semantic case/family label. */
export function opaqueCaptureId(caseId: string): string {
  if (!caseId.trim()) throw Error('Missing internal case identity');
  return createHash('sha256')
    .update('evaluation-capture-v1\0')
    .update(caseId)
    .digest('hex');
}
/** Read exactly the reviewed materialization. No regeneration or provider-derived text. */
export function readFrozenSource(
  root: string,
  source: FrozenCaseSource,
): Buffer {
  const path = resolve(root, source.path);
  if (!path.startsWith(`${resolve(root)}${sep}`))
    throw Error('Source outside corpus');
  const bytes = readFileSync(path);
  if (
    bytes.length !== source.byteLength ||
    createHash('sha256').update(bytes).digest('hex') !== source.sha256
  )
    throw Error('Changed frozen source');
  return bytes;
}
/** Browser upload uses its real multipart contract and retains original source bytes.
 * Text uses JSON's original text field; all binary formats retain one uploaded file.
 * Transport metadata is recorded separately by the runner after durable receipt.
 */
export function caseUploadRequest(
  source: FrozenCaseSource,
  bytes: Buffer,
  captureId: string,
  capturedAt: string,
): Request {
  if (!captureId.trim() || !Number.isFinite(Date.parse(capturedAt)))
    throw Error('Invalid frozen capture metadata');
  if (
    bytes.length !== source.byteLength ||
    createHash('sha256').update(bytes).digest('hex') !== source.sha256
  )
    throw Error('Changed frozen source');
  const headers = { 'idempotency-key': captureId };
  if (source.mediaType === 'text/plain') {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    if (!Buffer.from(text).equals(bytes))
      throw Error('Text roundtrip changed source');
    return new Request('http://evaluation.invalid/api/upload', {
      method: 'POST',
      headers: { ...headers, 'content-type': 'application/json' },
      body: JSON.stringify({ capturedAt, text }),
    });
  }
  const body = new FormData();
  body.set('captureId', captureId);
  body.set('capturedAt', capturedAt);
  body.set(
    'captureSource',
    source.mediaType.startsWith('audio/')
      ? 'audio'
      : source.mediaType.startsWith('image/')
        ? 'camera'
        : 'document',
  );
  body.set('sha256', source.sha256);
  body.set(
    'file',
    new Blob([Uint8Array.from(bytes)], { type: source.mediaType }),
    `source${extname(source.path)}`,
  );
  return new Request('http://evaluation.invalid/api/upload', {
    method: 'POST',
    headers,
    body,
  });
}
