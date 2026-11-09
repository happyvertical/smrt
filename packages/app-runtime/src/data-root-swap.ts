/**
 * Journalled swap of the local data root for restore-latest (#4805).
 *
 * A data root is a directory, so replacing it is two renames: live to a
 * `previous` sibling, then the verified candidate to live. A crash between
 * them would leave no live root, and the runtime would happily initialize a
 * fresh, empty installation there. So every swap first writes an fsynced
 * journal to the private state root, and while that journal exists
 * {@link acquireWriterLease} refuses every writer except the recovery path.
 * {@link recoverDataRootSwap} rolls an unfinished swap back (`prepared`,
 * `swapped`) or finishes a committed one.
 *
 * The caller holds `operation.lock` and the writer lease across the whole
 * swap, so no process has the live database open (smrt#3379) and nothing can
 * start between the checks and the renames.
 */

import { randomBytes } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { basename, dirname, isAbsolute, join } from 'node:path';
import { errorCode } from './error-code.js';

/** Journal file in the state root while a data-root swap is unfinished. */
export const DATA_ROOT_SWAP_JOURNAL = 'data-root-swap.json';

const NO_FOLLOW = constants.O_NOFOLLOW ?? 0;
const MAX_JOURNAL_BYTES = 8192;

type SwapPhase = 'prepared' | 'swapped' | 'committed';

interface SwapJournal {
  schemaVersion: 1;
  phase: SwapPhase;
  live: string;
  candidate: string;
  /** Where the old live root goes; `null` when there was none. */
  previous: string | null;
  keepPrevious: boolean;
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

function fsyncDirectory(path: string): void {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, constants.O_RDONLY);
    fsyncSync(descriptor);
  } catch (error) {
    // Some platforms (Windows) cannot open or fsync a directory.
    const code = errorCode(error);
    if (code !== 'EISDIR' && code !== 'EPERM' && code !== 'EINVAL') {
      throw error;
    }
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function siblingPattern(live: string, kind: 'restore' | 'previous'): RegExp {
  const name = basename(live).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^\\.${name}\\.${kind}-[a-f0-9]{16}$`);
}

/** A fresh, unused sibling path of `liveRoot` for a restore candidate. */
export function dataRootSiblingPath(
  liveRoot: string,
  kind: 'restore' | 'previous' | 'download',
): string {
  return join(
    dirname(liveRoot),
    `.${basename(liveRoot)}.${kind}-${randomBytes(8).toString('hex')}`,
  );
}

function journalPath(stateRoot: string): string {
  return join(stateRoot, DATA_ROOT_SWAP_JOURNAL);
}

function writeJournal(stateRoot: string, journal: SwapJournal): void {
  const path = journalPath(stateRoot);
  const temporary = `${path}.tmp-${randomBytes(8).toString('hex')}`;
  let descriptor: number | undefined;
  try {
    descriptor = openSync(
      temporary,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | NO_FOLLOW,
      0o600,
    );
    writeSync(descriptor, `${JSON.stringify(journal)}\n`);
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporary, path);
    fsyncDirectory(stateRoot);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    rmSync(temporary, { force: true });
  }
}

function removeJournal(stateRoot: string): void {
  rmSync(journalPath(stateRoot), { force: true });
  fsyncDirectory(stateRoot);
}

/**
 * Read and validate the journal. Its paths must be siblings of the live root
 * with the names this module generates, so a damaged journal can never steer
 * a rename or removal elsewhere.
 */
function readJournal(stateRoot: string): SwapJournal | null {
  let descriptor: number | undefined;
  let text: string;
  try {
    descriptor = openSync(
      journalPath(stateRoot),
      constants.O_RDONLY | NO_FOLLOW,
    );
    const details = fstatSync(descriptor);
    const uid = process.getuid?.();
    if (
      !details.isFile() ||
      details.size > MAX_JOURNAL_BYTES ||
      (details.mode & 0o077) !== 0 ||
      (uid !== undefined && details.uid !== uid)
    ) {
      throw new Error('invalid');
    }
    text = readFileSync(descriptor, 'utf8');
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return null;
    throw new Error(
      'The data-root swap journal cannot be verified; inspect the private state directory.',
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
  let journal: Partial<SwapJournal> | null = null;
  try {
    journal = JSON.parse(text) as Partial<SwapJournal>;
  } catch {
    journal = null;
  }
  const live = journal?.live;
  if (
    journal?.schemaVersion !== 1 ||
    !['prepared', 'swapped', 'committed'].includes(String(journal.phase)) ||
    typeof live !== 'string' ||
    !isAbsolute(live) ||
    typeof journal.keepPrevious !== 'boolean' ||
    typeof journal.candidate !== 'string' ||
    dirname(journal.candidate) !== dirname(live) ||
    !siblingPattern(live, 'restore').test(basename(journal.candidate)) ||
    (journal.previous !== null &&
      (typeof journal.previous !== 'string' ||
        dirname(journal.previous) !== dirname(live) ||
        !siblingPattern(live, 'previous').test(basename(journal.previous))))
  ) {
    throw new Error(
      'The data-root swap journal is malformed; inspect the private state directory.',
    );
  }
  return journal as SwapJournal;
}

/** True while an unfinished data-root swap is journalled in `stateRoot`. */
export function dataRootSwapPending(stateRoot: string): boolean {
  return exists(journalPath(stateRoot));
}

function rollBack(stateRoot: string, journal: SwapJournal): void {
  const { live, candidate, previous } = journal;
  const previousPresent = previous !== null && exists(previous);
  // The live path holds the candidate once the second rename happened: the
  // candidate path is gone and either the old root was moved aside or there
  // was none.
  if (
    exists(live) &&
    !exists(candidate) &&
    (previous === null || previousPresent)
  ) {
    renameSync(live, candidate);
    fsyncDirectory(dirname(live));
  }
  if (previous !== null && previousPresent) {
    if (exists(live)) {
      throw new Error(
        'The interrupted restore cannot be rolled back automatically: both the live and the previous data roots exist.',
      );
    }
    renameSync(previous, live);
    fsyncDirectory(dirname(live));
  }
  rmSync(candidate, { recursive: true, force: true });
  removeJournal(stateRoot);
}

function finish(stateRoot: string, journal: SwapJournal): void {
  if (journal.previous !== null && !journal.keepPrevious) {
    rmSync(journal.previous, { recursive: true, force: true });
  }
  removeJournal(stateRoot);
}

/**
 * Remove restore leftovers a crash before the journal left beside the data
 * root: plaintext candidates, their decrypt staging, and downloaded
 * ciphertext. Kept previous roots are never touched. Call under the writer
 * lease with no swap pending. Returns how many were removed.
 */
export function removeStaleRestoreSiblings(liveRoot: string): number {
  const parent = dirname(liveRoot);
  const name = basename(liveRoot).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const stale = new RegExp(
    `^(\\.${name}\\.(restore|download)-[a-f0-9]{16}|\\.\\.${name}\\.restore-[a-f0-9]{16}\\.[0-9]+\\.[a-f0-9]{16}\\.partial)$`,
  );
  let entries: string[];
  try {
    entries = readdirSync(parent);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return 0;
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!stale.test(entry)) continue;
    rmSync(join(parent, entry), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}

/** Outcome of {@link recoverDataRootSwap}. */
export type DataRootSwapRecovery = 'none' | 'rolled-back' | 'finished';

/**
 * Settle an interrupted swap: roll back one that never committed, finish one
 * that did. `liveRoot`, when given, must be the journal's live root. Call it
 * while holding the writer lease taken with `dataRootSwapRecovery`.
 */
export function recoverDataRootSwap(
  stateRoot: string,
  liveRoot?: string,
): DataRootSwapRecovery {
  const journal = readJournal(stateRoot);
  if (!journal) return 'none';
  if (liveRoot !== undefined && journal.live !== liveRoot) {
    throw new Error(
      'The data-root swap journal names a different data root; inspect the private state directory.',
    );
  }
  if (journal.phase === 'committed') {
    finish(stateRoot, journal);
    return 'finished';
  }
  rollBack(stateRoot, journal);
  return 'rolled-back';
}

/** Options for {@link swapDataRoot}. */
export interface SwapDataRootOptions {
  stateRoot: string;
  liveRoot: string;
  /** Verified candidate from {@link dataRootSiblingPath}(live, 'restore'). */
  candidateRoot: string;
  /** Keep the replaced root instead of deleting it (reported back). */
  keepPrevious?: boolean;
  /** Re-checked just before the first rename; throw to abort. */
  assertWriter?: () => void;
  /** Runs after both renames, before the commit; throw to roll back. */
  beforeCommit?: (liveRoot: string) => void | Promise<void>;
}

/**
 * Replace the live data root with a verified candidate, journalled, with
 * rollback to the previous root on any failure before the commit. Returns the
 * kept previous root, if any.
 */
export async function swapDataRoot(
  options: SwapDataRootOptions,
): Promise<{ previousRoot: string | null }> {
  const { stateRoot, liveRoot, candidateRoot } = options;
  if (dataRootSwapPending(stateRoot)) {
    throw new Error('A data-root swap is already pending; recover it first.');
  }
  if (
    dirname(candidateRoot) !== dirname(liveRoot) ||
    !siblingPattern(liveRoot, 'restore').test(basename(candidateRoot)) ||
    !lstatSync(candidateRoot).isDirectory()
  ) {
    throw new Error('The restore candidate is not a sibling directory.');
  }
  const journal: SwapJournal = {
    schemaVersion: 1,
    phase: 'prepared',
    live: liveRoot,
    candidate: candidateRoot,
    previous: exists(liveRoot)
      ? dataRootSiblingPath(liveRoot, 'previous')
      : null,
    keepPrevious: options.keepPrevious === true,
  };
  writeJournal(stateRoot, journal);
  try {
    options.assertWriter?.();
    if (journal.previous !== null) {
      renameSync(liveRoot, journal.previous);
      fsyncDirectory(dirname(liveRoot));
    }
    renameSync(candidateRoot, liveRoot);
    fsyncDirectory(dirname(liveRoot));
    writeJournal(stateRoot, { ...journal, phase: 'swapped' });
    await options.beforeCommit?.(liveRoot);
  } catch (error) {
    try {
      rollBack(stateRoot, journal);
    } catch (rollbackError) {
      throw new Error(
        'The restore failed and its rollback did not complete; the journal remains for recovery.',
        { cause: new AggregateError([error, rollbackError]) },
      );
    }
    throw error;
  }
  writeJournal(stateRoot, { ...journal, phase: 'committed' });
  finish(stateRoot, { ...journal, phase: 'committed' });
  return {
    previousRoot: journal.keepPrevious ? journal.previous : null,
  };
}
