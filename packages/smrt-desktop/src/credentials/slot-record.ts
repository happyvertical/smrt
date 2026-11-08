import { randomUUID } from 'node:crypto';
import { DesktopContractError } from '../errors.js';
import { deepFreeze } from '../internal/freeze.js';
import { isIsoUtcTimestamp, isUuidV4 } from '../internal/grammar.js';
import {
  type AtomicWriteOptions,
  type FileCustodyOptions,
  readPrivateFile,
  writePrivateFileAtomic,
} from '../internal/private-file.js';
import {
  hasClosedKeys,
  isRecord,
  parseStrictJson,
} from '../internal/strict-json.js';
import { isScopeList } from './grammar.js';

/** File name of the slot record in the private state directory. */
export const SLOT_RECORD_FILENAME = 'mcp-slot.json';

/**
 * - `minted`: the slot id exists and was persisted before the first request
 *   (#4726 requires this); `expiresAt` is `null` until a credential was
 *   committed to custody, then the credential's expiry.
 * - `revoking`: a disconnect started but the server revoke is not confirmed.
 *   The shell stops serving the credential at once and retries the revoke.
 * - `revoked`: the server confirmed the revoke (permanent for the id); the
 *   next connect uses a new slot id.
 */
export type SlotState = 'minted' | 'revoking' | 'revoked';

const states: readonly string[] = ['minted', 'revoking', 'revoked'];

/** Non-secret metadata of the one credential slot. Holds no token. */
export interface SlotRecordV1 {
  readonly version: 1;
  /** Opaque lowercase UUIDv4 chosen by the desktop app (never the server). */
  readonly slotId: string;
  readonly scopes: readonly string[];
  /** Expiry of the committed credential, or `null` before the first commit. */
  readonly expiresAt: string | null;
  readonly state: SlotState;
}

const requiredKeys = [
  'version',
  'slotId',
  'scopes',
  'expiresAt',
  'state',
] as const satisfies readonly (keyof SlotRecordV1)[];

function invalid(field: string): DesktopContractError {
  return new DesktopContractError('invalid_field', { field });
}

function validateSlotRecord(input: unknown): SlotRecordV1 {
  if (!isRecord(input)) throw new DesktopContractError('invalid_document');
  if (!Object.hasOwn(input, 'version')) {
    throw new DesktopContractError('invalid_document');
  }
  if (input.version !== 1) {
    throw new DesktopContractError('unsupported_contract');
  }
  if (!hasClosedKeys(input, requiredKeys)) {
    throw new DesktopContractError('invalid_document');
  }
  const { slotId, scopes, expiresAt, state } = input;
  if (!isUuidV4(slotId)) throw invalid('slotId');
  if (!isScopeList(scopes)) throw invalid('scopes');
  if (expiresAt !== null && !isIsoUtcTimestamp(expiresAt)) {
    throw invalid('expiresAt');
  }
  if (typeof state !== 'string' || !states.includes(state)) {
    throw invalid('state');
  }
  return deepFreeze({
    version: 1,
    slotId,
    scopes: [...scopes],
    expiresAt,
    state: state as SlotState,
  } as const);
}

/**
 * Parse `mcp-slot.json`. Throws a `DesktopContractError` with a fixed message
 * (`invalid_json`, `duplicate_keys`, `unsupported_contract`,
 * `invalid_document`, `invalid_field`); the input is never echoed.
 */
export function parseSlotRecord(json: string): SlotRecordV1 {
  if (typeof json !== 'string') {
    throw new DesktopContractError('invalid_json');
  }
  const parsed = parseStrictJson(json);
  if (!parsed.ok) {
    throw new DesktopContractError(
      parsed.reason === 'syntax' ? 'invalid_json' : 'duplicate_keys',
    );
  }
  return validateSlotRecord(parsed.value);
}

/** Serialize a validated record as canonical JSON with a trailing newline. */
export function serializeSlotRecord(record: SlotRecordV1): string {
  const r = validateSlotRecord(record);
  return `${JSON.stringify(
    {
      version: r.version,
      slotId: r.slotId,
      scopes: r.scopes,
      expiresAt: r.expiresAt,
      state: r.state,
    },
    null,
    2,
  )}\n`;
}

/** A fresh slot id: lowercase UUIDv4. */
export function newSlotId(): string {
  return randomUUID();
}

/** A new `minted` slot with no committed credential yet. */
export function newSlotRecord(
  scopes: readonly string[],
  slotId: string = newSlotId(),
): SlotRecordV1 {
  return validateSlotRecord({
    version: 1,
    slotId,
    scopes,
    expiresAt: null,
    state: 'minted',
  });
}

/**
 * Read the slot record at `path` with the private-file rules (`O_NOFOLLOW`,
 * `fstat` on the descriptor). A missing file is `null`; a file that fails the
 * trust or schema checks throws a value-free `DesktopContractError`.
 */
export async function readSlotRecord(
  path: string,
  options: FileCustodyOptions = {},
): Promise<SlotRecordV1 | null> {
  let text: string;
  try {
    text = await readPrivateFile(path, options);
  } catch (error) {
    if ((error as { kind?: unknown } | null)?.kind === 'absent') return null;
    throw new DesktopContractError('credential_invalid');
  }
  try {
    return parseSlotRecord(text);
  } catch {
    throw new DesktopContractError('credential_invalid');
  }
}

/**
 * Persist the slot record atomically. Call it, and wait for it, before the
 * first mint request for a new slot id.
 */
export async function writeSlotRecord(
  path: string,
  record: SlotRecordV1,
  options: AtomicWriteOptions = {},
): Promise<void> {
  const text = serializeSlotRecord(record);
  try {
    await writePrivateFileAtomic(path, text, options);
  } catch {
    throw new DesktopContractError('credential_unavailable');
  }
}
