import { Transform, type TransformCallback } from 'node:stream';

/** Replacement written in place of a credential. */
export const REDACTION = Buffer.from('[REDACTED]');

/** A partial match this long at end of stream is redacted, not emitted. */
const MIN_WITHHELD_PREFIX = 4;

/**
 * Streams bytes through, replacing every occurrence of one secret, including
 * an occurrence split across chunk boundaries. Only a trailing run of bytes
 * that is a proper prefix of the secret is held back, so ordinary traffic
 * (newline-terminated JSON-RPC) is never delayed.
 *
 * @internal
 */
export class SecretRedactor extends Transform {
  private carry: Buffer = Buffer.alloc(0);
  private readonly secret: Buffer;

  constructor(secret: string) {
    super();
    this.secret = Buffer.from(secret, 'utf8');
  }

  override _transform(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: TransformCallback,
  ): void {
    if (this.secret.length === 0) {
      callback(null, chunk);
      return;
    }
    const buffer = Buffer.concat([this.carry, chunk]);
    const parts: Buffer[] = [];
    let offset = 0;
    for (
      let index = buffer.indexOf(this.secret, offset);
      index !== -1;
      index = buffer.indexOf(this.secret, offset)
    ) {
      parts.push(buffer.subarray(offset, index), REDACTION);
      offset = index + this.secret.length;
    }
    const rest = buffer.subarray(offset);
    const held = this.partialSuffix(rest);
    parts.push(rest.subarray(0, rest.length - held));
    this.carry = Buffer.from(rest.subarray(rest.length - held));
    callback(null, Buffer.concat(parts));
  }

  override _flush(callback: TransformCallback): void {
    // The stream ended inside what may be a credential. A short leftover is
    // ordinary text that happens to start like it; a longer one is withheld
    // rather than leak a prefix of the secret.
    const leftover = this.carry;
    this.carry = Buffer.alloc(0);
    callback(
      null,
      leftover.length >= MIN_WITHHELD_PREFIX ? REDACTION : leftover,
    );
  }

  private partialSuffix(rest: Buffer): number {
    const max = Math.min(rest.length, this.secret.length - 1);
    for (let length = max; length > 0; length -= 1) {
      if (
        rest
          .subarray(rest.length - length)
          .equals(this.secret.subarray(0, length))
      ) {
        return length;
      }
    }
    return 0;
  }
}
