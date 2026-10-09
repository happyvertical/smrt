import type { ReceiptResult } from '../dto.js';
import type { IngestionService, IntakePart, ReceiveInput } from '../server.js';

/** Host configuration, reconstructed from authenticated session/account state. */
export interface SourceBinding {
  enabled: boolean;
  service: Pick<IngestionService, 'receive'>;
  sourceId: string;
  sourceVersion: string;
  capturedCeiling: ReceiveInput['capturedCeiling'];
  retention: ReceiveInput['retention'];
  limits: ReceiveInput['limits'];
  allowedMediaTypes: readonly string[];
}
export type SourceResult =
  | ReceiptResult
  | {
      kind: 'rejected';
      category: 'authentication' | 'unsupported_type' | 'unavailable_bytes';
    };
export class SourceInputError extends Error {
  constructor(
    public readonly category:
      | 'invalid'
      | 'limit'
      | 'unsupported_type'
      | 'unavailable_bytes',
  ) {
    super(category);
  }
}
export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw new SourceInputError('invalid');
  return value as Record<string, unknown>;
}
export function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new SourceInputError('invalid');
}
export function text(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > 1024)
    throw new SourceInputError('invalid');
  return value;
}
export function timestamp(value: unknown): Date {
  const date = new Date(text(value));
  if (!Number.isFinite(date.getTime())) throw new SourceInputError('invalid');
  return date;
}
/** Bound bytes before parsing or handing them to the receipt service. */
export async function boundedBytes(
  stream: ReadableStream<Uint8Array> | null,
  limit: number,
): Promise<Uint8Array> {
  if (!Number.isSafeInteger(limit) || limit < 1)
    throw new SourceInputError('limit');
  if (!stream) return new Uint8Array();
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel();
        throw new SourceInputError('limit');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}
/** Intake validates signatures; decoding/format correctness belongs to extraction. */
export function validateMedia(
  bytes: Uint8Array,
  type: string,
  allowed: readonly string[],
): void {
  if (!allowed.includes(type)) throw new SourceInputError('unsupported_type');
  const b = Buffer.from(bytes);
  const ascii = (start: number, end: number) =>
    b.subarray(start, end).toString('ascii');
  const valid: Record<string, boolean> = {
    'application/pdf': ascii(0, 5) === '%PDF-',
    'image/tiff':
      b.subarray(0, 4).equals(Buffer.from([73, 73, 42, 0])) ||
      b.subarray(0, 4).equals(Buffer.from([77, 77, 0, 42])),
    'image/jpeg': b[0] === 255 && b[1] === 216 && b[2] === 255,
    'image/png': b
      .subarray(0, 8)
      .equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])),
    'image/webp': ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP',
    'audio/wav': ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WAVE',
    'audio/ogg': ascii(0, 4) === 'OggS',
    'audio/webm': b.subarray(0, 4).equals(Buffer.from([26, 69, 223, 163])),
    'audio/mpeg':
      ascii(0, 3) === 'ID3' || (b[0] === 255 && (b[1] & 224) === 224),
    'audio/mp4': ascii(4, 8) === 'ftyp',
    'text/plain': true,
    'text/html': true,
    'application/json': true,
  };
  if (!Object.hasOwn(valid, type) || !valid[type])
    throw new SourceInputError('unsupported_type');
  if (type.startsWith('text/') || type === 'application/json') {
    try {
      const s = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (type === 'application/json') JSON.parse(s);
    } catch {
      throw new SourceInputError('invalid');
    }
  }
}
export async function deliver(
  binding: SourceBinding,
  deliveryKey: string,
  deliveredAt: Date,
  parts: IntakePart[],
): Promise<SourceResult> {
  if (!binding.enabled) return { kind: 'rejected', category: 'authentication' };
  try {
    text(deliveryKey);
    if (!Number.isFinite(deliveredAt.getTime()))
      throw new SourceInputError('invalid');
    if (
      parts.length > binding.limits.maxParts ||
      parts.reduce((n, p) => n + p.bytes.byteLength, 0) >
        binding.limits.maxBytes
    )
      throw new SourceInputError('limit');
    for (const part of parts)
      validateMedia(part.bytes, part.mediaType, binding.allowedMediaTypes);
    return await binding.service.receive({
      sourceId: binding.sourceId,
      sourceVersion: binding.sourceVersion,
      capturedCeiling: binding.capturedCeiling,
      retention: binding.retention,
      limits: binding.limits,
      deliveryKey,
      deliveredAt,
      parts,
    });
  } catch (error) {
    return safeFailure(error);
  }
}
export function safeFailure(error: unknown): SourceResult {
  return error instanceof SourceInputError
    ? { kind: 'rejected', category: error.category }
    : { kind: 'retry', category: 'unavailable' };
}
