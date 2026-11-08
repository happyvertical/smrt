import { DesktopContractError } from '../errors.js';
import { isIsoUtcTimestamp, isLoopbackOrigin } from '../internal/grammar.js';
import {
  hasClosedKeys,
  isRecord,
  parseStrictJson,
} from '../internal/strict-json.js';
import { SecretString } from '../secret-string.js';
import {
  type CredentialFailureCode,
  isCredentialFailureCode,
} from './control-handler.js';
import { isMcpToken } from './grammar.js';

/**
 * The fd 3 frame protocol between the launcher and the bridge it spawned.
 *
 * NDJSON over the anonymous pipe the launcher inherits into the child at
 * descriptor 3: one JSON object per line, UTF-8, at most
 * `HANDOFF_FRAME_MAX_BYTES` per frame including the newline, `"v":1`, closed
 * schemas, duplicate keys rejected. Direction is part of the schema: each
 * side accepts only the frames the other side may send.
 *
 * - launcher to bridge: `credential` (`seq` 0 is the initial frame, a higher
 *   `seq` is a refresh after rotation, expiry or a sidecar port change) and
 *   `unavailable`
 * - bridge to launcher: `refresh` (sent after a 401, 403 or refused
 *   connection; the bridge rate-limits it to one per ten seconds)
 */
export const HANDOFF_FRAME_MAX_BYTES = 2048;

export type HandoffDirection = 'to-bridge' | 'to-launcher';

export interface CredentialFrame {
  readonly v: 1;
  readonly type: 'credential';
  /** 0 for the initial frame, incremented for every refresh. */
  readonly seq: number;
  /** The only origin the bearer may be sent to. */
  readonly origin: string;
  readonly token: SecretString;
  readonly expiresAt: string;
}

export interface UnavailableFrame {
  readonly v: 1;
  readonly type: 'unavailable';
  readonly seq: number;
  readonly code: CredentialFailureCode;
}

export interface RefreshFrame {
  readonly v: 1;
  readonly type: 'refresh';
}

export type LauncherFrame = CredentialFrame | UnavailableFrame;
export type BridgeFrame = RefreshFrame;
export type HandoffFrame = LauncherFrame | BridgeFrame;

const MAX_SEQ = 0x7fffffff;
const credentialKeys = ['v', 'type', 'seq', 'origin', 'token', 'expiresAt'];
const unavailableKeys = ['v', 'type', 'seq', 'code'];
const refreshKeys = ['v', 'type'];

function invalid(): DesktopContractError {
  return new DesktopContractError('invalid_handoff_frame');
}

function isSeq(value: unknown): value is number {
  return (
    Number.isSafeInteger(value) &&
    (value as number) >= 0 &&
    (value as number) <= MAX_SEQ
  );
}

function utf8Length(text: string): number {
  return new TextEncoder().encode(text).length;
}

function validate(value: unknown, direction: HandoffDirection): HandoffFrame {
  if (!isRecord(value) || !Object.hasOwn(value, 'v')) throw invalid();
  if (value.v !== 1) throw new DesktopContractError('unsupported_contract');
  if (direction === 'to-launcher') {
    if (value.type !== 'refresh' || !hasClosedKeys(value, refreshKeys)) {
      throw invalid();
    }
    return Object.freeze({ v: 1, type: 'refresh' } as const);
  }
  if (value.type === 'credential') {
    if (
      !hasClosedKeys(value, credentialKeys) ||
      !isSeq(value.seq) ||
      !isLoopbackOrigin(value.origin) ||
      !isMcpToken(value.token) ||
      !isIsoUtcTimestamp(value.expiresAt)
    ) {
      throw invalid();
    }
    return Object.freeze({
      v: 1,
      type: 'credential',
      seq: value.seq,
      origin: value.origin,
      token: new SecretString(value.token),
      expiresAt: value.expiresAt,
    } as const);
  }
  if (value.type === 'unavailable') {
    if (
      !hasClosedKeys(value, unavailableKeys) ||
      !isSeq(value.seq) ||
      !isCredentialFailureCode(value.code)
    ) {
      throw invalid();
    }
    return Object.freeze({
      v: 1,
      type: 'unavailable',
      seq: value.seq,
      code: value.code,
    } as const);
  }
  throw invalid();
}

/**
 * Parse one frame line (an optional single trailing `\n` is accepted). The
 * error is always value-free: `invalid_handoff_frame`,
 * `handoff_frame_too_large` or `unsupported_contract`.
 */
export function parseHandoffFrame(
  line: string,
  direction: HandoffDirection,
): HandoffFrame {
  if (typeof line !== 'string') throw invalid();
  if (utf8Length(line) > HANDOFF_FRAME_MAX_BYTES) {
    throw new DesktopContractError('handoff_frame_too_large');
  }
  const text = line.endsWith('\n') ? line.slice(0, -1) : line;
  if (text.length === 0 || /[\n\r]/.test(text)) throw invalid();
  const parsed = parseStrictJson(text);
  if (!parsed.ok) throw invalid();
  return validate(parsed.value, direction);
}

/**
 * Encode a frame as one line ending in `\n`. This is the only place on the
 * launcher side that reveals the bearer, and the result goes straight to the
 * pipe: never log or store it. The frame is validated as a parsed frame would
 * be, so an invalid frame cannot be written.
 */
export function encodeHandoffFrame(
  frame: HandoffFrame,
  direction: HandoffDirection,
): string {
  let wire: Record<string, unknown>;
  if (frame?.type === 'credential') {
    if (!(frame.token instanceof SecretString)) throw invalid();
    wire = {
      v: frame.v,
      type: frame.type,
      seq: frame.seq,
      origin: frame.origin,
      token: frame.token.reveal(),
      expiresAt: frame.expiresAt,
    };
  } else if (frame?.type === 'unavailable') {
    wire = { v: frame.v, type: frame.type, seq: frame.seq, code: frame.code };
  } else if (frame?.type === 'refresh') {
    wire = { v: frame.v, type: frame.type };
  } else {
    throw invalid();
  }
  const line = `${JSON.stringify(wire)}\n`;
  // Round-trip through the parser: it enforces size, schema and direction.
  parseHandoffFrame(line, direction);
  return line;
}

/**
 * Guard for the launcher: true when `secret` appears inside any of `values`
 * (argv entries, environment values, ...). Use it to prove a child's command
 * line and environment are token-free before spawning.
 */
export function containsSecret(
  secret: SecretString,
  values: readonly string[],
): boolean {
  const revealed = secret.reveal();
  return values.some((value) => value.includes(revealed));
}

/**
 * Incremental decoder for a pipe: feed it chunks, get complete frames. A line
 * longer than `HANDOFF_FRAME_MAX_BYTES` without a newline, or any invalid
 * frame, throws and poisons the decoder (the peer is misbehaving: close the
 * pipe). Buffered partial data is bounded by the cap.
 */
export class HandoffFrameDecoder {
  readonly #direction: HandoffDirection;
  readonly #utf8 = new TextDecoder('utf-8', { fatal: true });
  #pending = '';
  #poisoned = false;

  constructor(direction: HandoffDirection) {
    this.#direction = direction;
  }

  push(chunk: string | Uint8Array): HandoffFrame[] {
    if (this.#poisoned) throw invalid();
    try {
      this.#pending +=
        typeof chunk === 'string'
          ? chunk
          : this.#utf8.decode(chunk, { stream: true });
      const frames: HandoffFrame[] = [];
      for (;;) {
        const newline = this.#pending.indexOf('\n');
        if (newline === -1) break;
        const line = this.#pending.slice(0, newline + 1);
        this.#pending = this.#pending.slice(newline + 1);
        frames.push(parseHandoffFrame(line, this.#direction));
      }
      if (utf8Length(this.#pending) >= HANDOFF_FRAME_MAX_BYTES) {
        throw new DesktopContractError('handoff_frame_too_large');
      }
      return frames;
    } catch (error) {
      this.#poisoned = true;
      this.#pending = '';
      throw error instanceof DesktopContractError ? error : invalid();
    }
  }
}
