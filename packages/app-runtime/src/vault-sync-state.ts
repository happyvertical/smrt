/**
 * Machine-local vault position (`<state root>/vault-sync.json`, #4805).
 *
 * Records which snapshot sequence this location's data root is at
 * (`baseSequence`), the highest sequence it has ever seen published
 * (`highestSeenSequence`, the client-side downgrade floor: the relay is
 * untrusted, so a restore never goes below it), and whether writes may have
 * happened since the last publish (`localWritesPending`, so a restore never
 * silently discards them). The state root is never part of a data-root copy,
 * so a copied data root cannot carry a forged position. Holds no secrets.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { join } from 'node:path';
import { errorCode } from './error-code.js';

export const VAULT_SYNC_FILE = 'vault-sync.json';

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_RECORD_BYTES = 2048;
const ACCOUNT_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;

/** Persisted vault position of one location. */
export interface VaultSyncRecord {
  readonly schemaVersion: 1;
  readonly accountId: string;
  readonly baseSequence: number;
  readonly highestSeenSequence: number;
  readonly localWritesPending: boolean;
}

function sequence(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function parse(text: string): VaultSyncRecord | null {
  let value: Partial<VaultSyncRecord> | null;
  try {
    value = JSON.parse(text) as Partial<VaultSyncRecord> | null;
  } catch {
    return null;
  }
  if (
    value?.schemaVersion !== 1 ||
    typeof value.accountId !== 'string' ||
    !ACCOUNT_PATTERN.test(value.accountId) ||
    !sequence(value.baseSequence) ||
    !sequence(value.highestSeenSequence) ||
    value.highestSeenSequence < value.baseSequence ||
    typeof value.localWritesPending !== 'boolean'
  ) {
    return null;
  }
  return {
    schemaVersion: 1,
    accountId: value.accountId,
    baseSequence: value.baseSequence,
    highestSeenSequence: value.highestSeenSequence,
    localWritesPending: value.localWritesPending,
  };
}

/** The location's record, `null` when absent. Throws when unsafe or damaged. */
export function readVaultSyncRecord(stateRoot: string): VaultSyncRecord | null {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      join(stateRoot, VAULT_SYNC_FILE),
      constants.O_RDONLY | NO_FOLLOW,
    );
    const details = fstatSync(descriptor);
    const uid = process.getuid?.();
    if (
      !details.isFile() ||
      details.size > MAX_RECORD_BYTES ||
      (details.mode & 0o077) !== 0 ||
      (uid !== undefined && details.uid !== uid)
    ) {
      throw new Error('unsafe');
    }
    const record = parse(readFileSync(descriptor, 'utf8'));
    if (!record) throw new Error('malformed');
    return record;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new Error(
      'The vault sync record cannot be verified; inspect the private state directory.',
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

/** Atomically replace the location's record (0600, fsynced). */
export function writeVaultSyncRecord(
  stateRoot: string,
  record: Omit<VaultSyncRecord, 'schemaVersion'>,
): VaultSyncRecord {
  const complete = parse(JSON.stringify({ schemaVersion: 1, ...record }));
  if (!complete) throw new Error('Invalid vault sync record.');
  const path = join(stateRoot, VAULT_SYNC_FILE);
  const temporary = `${path}.tmp-${randomBytes(8).toString('hex')}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    writeSync(descriptor, `${JSON.stringify(complete)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
  return complete;
}

/**
 * The record for `accountId`, or a fresh position at sequence 0. A record of
 * a different account is refused: one location follows one vault account.
 */
export function vaultSyncFor(
  stateRoot: string,
  accountId: string,
): VaultSyncRecord {
  const record = readVaultSyncRecord(stateRoot);
  if (record && record.accountId !== accountId) {
    throw new Error(
      'This installation follows a different vault account; it cannot switch accounts in place.',
    );
  }
  return (
    record ?? {
      schemaVersion: 1,
      accountId,
      baseSequence: 0,
      highestSeenSequence: 0,
      localWritesPending: false,
    }
  );
}
