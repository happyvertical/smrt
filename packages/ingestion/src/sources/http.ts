import type { IntakePart } from '../server.js';
import {
  boundedBytes,
  deliver,
  keys,
  record,
  type SourceBinding,
  SourceInputError,
  type SourceResult,
  safeFailure,
  text,
  timestamp,
} from './common.js';

export interface AuthenticatedSource extends SourceBinding {
  /** Explicit wire limit includes multipart framing and capture metadata. */
  maxRequestBytes: number;
  /** Host proves ownership/current access and copies immutable owner bytes. */
  snapshotReference?(reference: {
    owner: 'asset' | 'message';
    id: string;
    version: string;
  }): Promise<IntakePart[]>;
}
export interface SourceHttpOptions {
  /** Authenticate and select enabled source from server configuration, never body fields. */
  authenticate(request: Request): Promise<AuthenticatedSource | null>;
}
function response(result: SourceResult): Response {
  return Response.json(result, {
    status:
      result.kind === 'accepted' || result.kind === 'duplicate'
        ? 200
        : result.kind === 'retry'
          ? 503
          : 'category' in result && result.category === 'authentication'
            ? 401
            : 'category' in result && result.category === 'limit'
              ? 413
              : 400,
  });
}
/** Reference Web Request handler; mobile clients reuse their durable UUID Idempotency-Key. */
export function createSourceDeliveryHandler(
  options: SourceHttpOptions,
): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      const binding = await options.authenticate(request);
      if (!binding?.enabled)
        return response({ kind: 'rejected', category: 'authentication' });
      if (request.method !== 'POST') throw new SourceInputError('invalid');
      const key = text(request.headers.get('idempotency-key'));
      const length = request.headers.get('content-length');
      if (
        length &&
        (!/^\d+$/.test(length) || Number(length) > binding.maxRequestBytes)
      )
        throw new SourceInputError('limit');
      const bytes = await boundedBytes(request.body, binding.maxRequestBytes);
      const type = request.headers.get('content-type') || '';
      let deliveredAt: Date;
      const parts: IntakePart[] = [];
      if (type.split(';')[0] === 'application/json') {
        let payload: Record<string, unknown>;
        try {
          payload = record(
            JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes)),
          );
        } catch {
          throw new SourceInputError('invalid');
        }
        keys(payload, ['capturedAt', 'text', 'structured', 'reference']);
        deliveredAt = timestamp(payload.capturedAt);
        if (
          ['text', 'structured', 'reference'].filter(
            (field) => payload[field] !== undefined,
          ).length !== 1
        )
          throw new SourceInputError('invalid');
        if (payload.text !== undefined) {
          if (typeof payload.text !== 'string')
            throw new SourceInputError('invalid');
          parts.push({
            partId: 'body',
            mediaType: 'text/plain',
            bytes: Buffer.from(payload.text),
          });
        } else if (payload.structured !== undefined) {
          parts.push({
            partId: 'body',
            mediaType: 'application/json',
            bytes: Buffer.from(JSON.stringify(record(payload.structured))),
          });
        } else {
          const ref = record(payload.reference);
          keys(ref, ['owner', 'id', 'version']);
          if (
            (ref.owner !== 'asset' && ref.owner !== 'message') ||
            !binding.snapshotReference
          )
            throw new SourceInputError('invalid');
          const reference = {
            owner: ref.owner,
            id: text(ref.id),
            version: text(ref.version),
          } as const;
          const snapshots = await binding.snapshotReference(reference);
          if (!snapshots.length)
            throw new SourceInputError('unavailable_bytes');
          for (const part of snapshots)
            parts.push({
              ...part,
              sourceReference: part.sourceReference ?? reference,
            });
        }
      } else if (type.startsWith('multipart/form-data;')) {
        let form: FormData;
        try {
          form = await new Response(Buffer.from(bytes), {
            headers: { 'content-type': type },
          }).formData();
        } catch {
          throw new SourceInputError('invalid');
        }
        const fields: Record<string, string> = {};
        for (const [name, value] of form.entries()) {
          if (typeof value === 'string') {
            if (
              !['captureId', 'capturedAt', 'captureSource', 'sha256'].includes(
                name,
              ) ||
              fields[name] !== undefined
            )
              throw new SourceInputError('invalid');
            fields[name] = value;
          } else {
            if (name !== 'file' || parts.length)
              throw new SourceInputError('invalid');
            parts.push({
              partId: 'file',
              parentPartId: 'capture',
              mediaType: value.type,
              bytes: await boundedBytes(
                value.stream(),
                binding.limits.maxBytes,
              ),
            });
          }
        }
        if (
          parts.length !== 1 ||
          text(fields.captureId) !== key ||
          !['camera', 'native_picker', 'audio', 'document'].includes(
            fields.captureSource,
          )
        )
          throw new SourceInputError('invalid');
        deliveredAt = timestamp(fields.capturedAt);
        if (fields.sha256) {
          if (!/^[a-f0-9]{64}$/.test(fields.sha256))
            throw new SourceInputError('invalid');
          parts[0].expectedHash = fields.sha256;
        }
        parts.unshift({
          partId: 'capture',
          mediaType: 'application/json',
          bytes: Buffer.from(
            JSON.stringify({
              captureId: fields.captureId,
              capturedAt: fields.capturedAt,
              captureSource: fields.captureSource,
              ...(fields.sha256 === undefined ? {} : { sha256: fields.sha256 }),
            }),
          ),
        });
      } else throw new SourceInputError('unsupported_type');
      return response(await deliver(binding, key, deliveredAt, parts));
    } catch (error) {
      return response(
        error instanceof SyntaxError
          ? { kind: 'rejected', category: 'invalid' }
          : safeFailure(error),
      );
    }
  };
}

export interface VerifiedVendorDelivery {
  binding: SourceBinding;
  deliveryKey: string;
  deliveredAt: Date;
  parts: IntakePart[];
}
/** Vendor implementation owns signature/timestamp verification and replay identity. */
export function createVendorWebhookHandler(options: {
  maxRequestBytes: number;
  verify(
    request: Request,
    originalBytes: Uint8Array,
  ): Promise<VerifiedVendorDelivery | null>;
}): (request: Request) => Promise<Response> {
  return async (request) => {
    try {
      if (request.method !== 'POST') throw new SourceInputError('invalid');
      const bytes = await boundedBytes(request.body, options.maxRequestBytes);
      const verified = await options.verify(request, bytes);
      if (!verified)
        return response({ kind: 'rejected', category: 'authentication' });
      return response(
        await deliver(
          verified.binding,
          verified.deliveryKey,
          verified.deliveredAt,
          verified.parts,
        ),
      );
    } catch (error) {
      return response(safeFailure(error));
    }
  };
}
