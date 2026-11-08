import { createHash, timingSafeEqual } from 'node:crypto';
import { DesktopContractError } from './errors.js';

const REDACTED = '[REDACTED]';
const INSPECT = Symbol.for('nodejs.util.inspect.custom');
const unpairedSurrogate = /\p{Surrogate}/u;

/**
 * A string that cannot leak through `toString`, template literals, `JSON`,
 * `util.inspect`/`console.log`, spreading or `structuredClone`.
 *
 * The value lives in a `#private` field, so the instance has no own
 * properties at all: enumeration, `Object.assign`, spread and
 * `structuredClone` all produce an empty object.
 *
 * `reveal()` is the only accessor. Only the final handoff to the child process
 * (the fd 3 frame encoder) may call it; keep every other use grep-able and
 * out of review.
 */
export class SecretString {
  readonly #value: string;

  constructor(value: string) {
    if (
      typeof value !== 'string' ||
      value.length === 0 ||
      value.includes('\0') ||
      unpairedSurrogate.test(value)
    ) {
      throw new DesktopContractError('invalid_secret');
    }
    this.#value = value;
    Object.freeze(this);
  }

  /** The secret text. Reserved for the single handoff to the consumer. */
  reveal(): string {
    return this.#value;
  }

  /** Length in UTF-16 code units; reveals nothing beyond the size. */
  get length(): number {
    return this.#value.length;
  }

  /**
   * Constant-time comparison. Both values are hashed first, so neither the
   * contents nor the lengths influence the comparison time.
   */
  equals(other: unknown): boolean {
    if (!(other instanceof SecretString)) return false;
    const a = createHash('sha256').update(this.#value, 'utf8').digest();
    const b = createHash('sha256').update(other.#value, 'utf8').digest();
    return timingSafeEqual(a, b);
  }

  toString(): string {
    return REDACTED;
  }

  toJSON(): string {
    return REDACTED;
  }

  [Symbol.toPrimitive](): string {
    return REDACTED;
  }

  [INSPECT](): string {
    return `SecretString(${REDACTED})`;
  }

  get [Symbol.toStringTag](): string {
    return 'SecretString';
  }
}
