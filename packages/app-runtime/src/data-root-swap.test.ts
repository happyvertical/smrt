/**
 * Journalled data-root swap for restore-latest (#4805): success, rollback on
 * failure at every step, crash recovery from each journal phase, and the
 * writer refusal while a swap is unsettled.
 */

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DATA_ROOT_SWAP_JOURNAL,
  dataRootSiblingPath,
  dataRootSwapPending,
  recoverDataRootSwap,
  swapDataRoot,
} from './data-root-swap.js';
import { acquireWriterLease } from './writer-lease.js';

const fsHooks = vi.hoisted(() => ({
  beforeRename: undefined as undefined | ((from: string, to: string) => void),
}));

vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>();
  const renameSync: typeof actual.renameSync = (from, to) => {
    fsHooks.beforeRename?.(String(from), String(to));
    return actual.renameSync(from, to);
  };
  return { ...actual, default: { ...actual, renameSync }, renameSync };
});

let base: string;
let stateRoot: string;
let live: string;

function makeRoot(path: string, marker: string): void {
  mkdirSync(join(path, 'assets'), { recursive: true, mode: 0o700 });
  writeFileSync(join(path, 'application.sqlite'), marker);
}

function marker(path: string): string {
  return readFileSync(join(path, 'application.sqlite'), 'utf8');
}

function candidate(content = 'restored'): string {
  const path = dataRootSiblingPath(live, 'restore');
  makeRoot(path, content);
  return path;
}

function writeJournal(journal: Record<string, unknown>): void {
  writeFileSync(
    join(stateRoot, DATA_ROOT_SWAP_JOURNAL),
    `${JSON.stringify({ schemaVersion: 1, keepPrevious: false, ...journal })}\n`,
    { mode: 0o600 },
  );
}

beforeEach(() => {
  base = mkdtempSync(join(realpathSync(tmpdir()), 'smrt-swap-'));
  stateRoot = join(base, 'state');
  mkdirSync(stateRoot, { mode: 0o700 });
  live = join(base, 'data');
  makeRoot(live, 'original');
});

afterEach(() => {
  fsHooks.beforeRename = undefined;
  rmSync(base, { recursive: true, force: true });
});

describe('swapDataRoot', () => {
  it('replaces the live root and removes the previous one', async () => {
    const next = candidate();
    const result = await swapDataRoot({
      stateRoot,
      liveRoot: live,
      candidateRoot: next,
    });
    expect(result.previousRoot).toBeNull();
    expect(marker(live)).toBe('restored');
    expect(existsSync(next)).toBe(false);
    expect(dataRootSwapPending(stateRoot)).toBe(false);
    expect((await import('node:fs')).readdirSync(base).sort()).toEqual([
      'data',
      'state',
    ]);
  });

  it('keeps the previous root when asked', async () => {
    const result = await swapDataRoot({
      stateRoot,
      liveRoot: live,
      candidateRoot: candidate(),
      keepPrevious: true,
    });
    expect(result.previousRoot).not.toBeNull();
    expect(marker(result.previousRoot as string)).toBe('original');
  });

  it('installs into an absent live root (a new machine)', async () => {
    rmSync(live, { recursive: true });
    await swapDataRoot({
      stateRoot,
      liveRoot: live,
      candidateRoot: candidate(),
    });
    expect(marker(live)).toBe('restored');
  });

  it('rolls back when verification after the renames fails', async () => {
    const next = candidate();
    await expect(
      swapDataRoot({
        stateRoot,
        liveRoot: live,
        candidateRoot: next,
        beforeCommit: () => {
          expect(marker(live)).toBe('restored');
          throw new Error('custody refused');
        },
      }),
    ).rejects.toThrow('custody refused');
    expect(marker(live)).toBe('original');
    expect(existsSync(next)).toBe(false);
    expect(dataRootSwapPending(stateRoot)).toBe(false);
  });

  it('rolls back when the second rename fails', async () => {
    const next = candidate();
    fsHooks.beforeRename = (from) => {
      if (from === next)
        throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
    };
    await expect(
      swapDataRoot({ stateRoot, liveRoot: live, candidateRoot: next }),
    ).rejects.toThrow('EXDEV');
    fsHooks.beforeRename = undefined;
    expect(marker(live)).toBe('original');
    expect(dataRootSwapPending(stateRoot)).toBe(false);
  });

  it('aborts before any rename when the writer check fails', async () => {
    await expect(
      swapDataRoot({
        stateRoot,
        liveRoot: live,
        candidateRoot: candidate(),
        assertWriter: () => {
          throw new Error('writer lease lost');
        },
      }),
    ).rejects.toThrow('writer lease lost');
    expect(marker(live)).toBe('original');
  });

  it('refuses a candidate that is not a generated sibling', async () => {
    const elsewhere = join(base, 'elsewhere');
    makeRoot(elsewhere, 'x');
    await expect(
      swapDataRoot({ stateRoot, liveRoot: live, candidateRoot: elsewhere }),
    ).rejects.toThrow('sibling');
    expect(marker(live)).toBe('original');
  });
});

describe('crash recovery', () => {
  it('refuses every writer while a swap is unsettled, except recovery', () => {
    writeJournal({
      phase: 'prepared',
      live,
      candidate: candidate(),
      previous: dataRootSiblingPath(live, 'previous'),
    });
    expect(() => acquireWriterLease(stateRoot)).toThrow(
      'restore-latest --recover',
    );
    const lease = acquireWriterLease(stateRoot, { dataRootSwapRecovery: true });
    lease.release();
  });

  it('rolls back a crash between the two renames (no live root)', () => {
    const next = candidate();
    const previous = dataRootSiblingPath(live, 'previous');
    writeJournal({ phase: 'prepared', live, candidate: next, previous });
    renameSync(live, previous);
    expect(recoverDataRootSwap(stateRoot, live)).toBe('rolled-back');
    expect(marker(live)).toBe('original');
    expect(existsSync(next)).toBe(false);
    expect(existsSync(previous)).toBe(false);
    expect(dataRootSwapPending(stateRoot)).toBe(false);
  });

  it('rolls back a crash after both renames but before the commit', () => {
    const next = candidate();
    const previous = dataRootSiblingPath(live, 'previous');
    writeJournal({ phase: 'swapped', live, candidate: next, previous });
    renameSync(live, previous);
    renameSync(next, live);
    expect(recoverDataRootSwap(stateRoot)).toBe('rolled-back');
    expect(marker(live)).toBe('original');
    expect(existsSync(next)).toBe(false);
  });

  it('rolls back a crash before the first rename', () => {
    const next = candidate();
    writeJournal({
      phase: 'prepared',
      live,
      candidate: next,
      previous: dataRootSiblingPath(live, 'previous'),
    });
    expect(recoverDataRootSwap(stateRoot)).toBe('rolled-back');
    expect(marker(live)).toBe('original');
    expect(existsSync(next)).toBe(false);
  });

  it('rolls a first-time install back to no live root', () => {
    rmSync(live, { recursive: true });
    const next = candidate();
    writeJournal({ phase: 'swapped', live, candidate: next, previous: null });
    renameSync(next, live);
    expect(recoverDataRootSwap(stateRoot)).toBe('rolled-back');
    expect(existsSync(live)).toBe(false);
    expect(existsSync(next)).toBe(false);
  });

  it('finishes a committed swap', () => {
    const next = candidate();
    const previous = dataRootSiblingPath(live, 'previous');
    writeJournal({ phase: 'committed', live, candidate: next, previous });
    renameSync(live, previous);
    renameSync(next, live);
    expect(recoverDataRootSwap(stateRoot)).toBe('finished');
    expect(marker(live)).toBe('restored');
    expect(existsSync(previous)).toBe(false);
  });

  it('refuses a journal that points outside the data root siblings', () => {
    const victim = join(base, 'victim');
    makeRoot(victim, 'keep me');
    writeJournal({
      phase: 'prepared',
      live,
      candidate: victim,
      previous: null,
    });
    expect(() => recoverDataRootSwap(stateRoot)).toThrow('malformed');
    expect(marker(victim)).toBe('keep me');
    expect(marker(live)).toBe('original');
  });

  it('refuses a journal for a different live root', () => {
    writeJournal({
      phase: 'prepared',
      live,
      candidate: candidate(),
      previous: null,
    });
    expect(() => recoverDataRootSwap(stateRoot, join(base, 'other'))).toThrow(
      'different data root',
    );
  });
});
