import type {
  CatalogSourceRecord,
  CatalogSyncAdapter,
  CatalogSyncCheckpoint,
  CatalogSyncFailure,
} from './catalog-contracts.js';

export interface CatalogSyncStore {
  getCheckpoint(providerId: string): Promise<CatalogSyncCheckpoint | undefined>;
  saveCheckpoint(checkpoint: CatalogSyncCheckpoint): Promise<void>;
  upsert(record: CatalogSourceRecord, runId: string): Promise<void>;
  withdrawUnseen(providerId: string, runId: string): Promise<number>;
}

/** Policy counts cover only pages processed by the current sync invocation. */
export interface CatalogExclusionSummary {
  total: number;
  byCode: { code: string; count: number }[];
  otherCount: number;
}
export interface CatalogFailureSummary {
  total: number;
  historical: boolean;
  historicalCount: number;
  currentCount: number;
  omittedDetailCount: number;
}
export interface CatalogSyncReport extends CatalogSyncCheckpoint {
  withdrawnCount: number;
  /** Invocation-local, bounded, report-only; never a full-generation coverage total. */
  exclusionSummary?: CatalogExclusionSummary;
  /** Historical diagnostics do not imply a current active failure. */
  failureSummary?: CatalogFailureSummary;
}

const MAX_FAILURE_CODES = 31;
const MAX_POLICY_CODES = 32;
const OVERFLOW_CODE = 'additional-failures';
function addCount(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result))
    throw new Error(
      'Catalog diagnostic occurrence count exceeds the safe integer bound.',
    );
  return result;
}
function occurrenceCount(value: unknown): number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value > 0
    ? value
    : 1;
}
function bounded(value: string, cap: number): string {
  return value.length > cap ? `${value.slice(0, cap - 12)} [truncated]` : value;
}
type CountedFailure = CatalogSyncFailure & {
  count: number;
  omittedDetailCount: number;
};
function diagnostic(raw: CatalogSyncFailure): CountedFailure {
  const value: Partial<CatalogSyncFailure> =
    raw && typeof raw === 'object' ? raw : {};
  const count = occurrenceCount(value.count);
  const invalidCount = value.count !== undefined && count !== value.count;
  const code =
    typeof value.code === 'string' && value.code
      ? value.code
      : 'invalid-failure-entry';
  const message = `${invalidCount ? 'Invalid legacy occurrence count; counted once. ' : ''}${typeof value.message === 'string' ? value.message : 'Stored failure diagnostic is malformed.'}`;
  const cursor = typeof value.cursor === 'string' ? value.cursor : undefined;
  const truncated =
    code.length > 128 || message.length > 512 || (cursor?.length ?? 0) > 256;
  const suppliedOmitted =
    typeof value.omittedDetailCount === 'number' &&
    Number.isSafeInteger(value.omittedDetailCount) &&
    value.omittedDetailCount >= 0
      ? Math.min(count, value.omittedDetailCount)
      : 0;
  return {
    code: bounded(code, 128),
    message: bounded(message, 512),
    ...(cursor !== undefined ? { cursor: bounded(cursor, 256) } : {}),
    ...(typeof value.retryAfterMs === 'number' &&
    Number.isFinite(value.retryAfterMs) &&
    value.retryAfterMs >= 0
      ? { retryAfterMs: value.retryAfterMs }
      : {}),
    count,
    omittedDetailCount: truncated ? count : suppliedOmitted,
  };
}
/** Keep recent per-code facts and exact occurrence totals; declare omitted details. */
function compactFailures(entries: CatalogSyncFailure[]): CountedFailure[] {
  const groups = new Map<string, CountedFailure>();
  let overflowCount = 0;
  for (const raw of entries) {
    const next = diagnostic(raw);
    if (next.code === OVERFLOW_CODE) {
      overflowCount = addCount(overflowCount, next.count);
      continue;
    }
    const previous = groups.get(next.code);
    if (previous) {
      const sameDetail =
        previous.message === next.message &&
        previous.cursor === next.cursor &&
        previous.retryAfterMs === next.retryAfterMs;
      next.omittedDetailCount = addCount(
        sameDetail ? previous.omittedDetailCount : previous.count,
        next.omittedDetailCount,
      );
      next.count = addCount(previous.count, next.count);
      groups.delete(next.code);
    } else if (groups.size === MAX_FAILURE_CODES) {
      const oldest = groups.values().next().value;
      if (oldest) {
        overflowCount = addCount(overflowCount, oldest.count);
        groups.delete(oldest.code);
      }
    }
    groups.set(next.code, next);
  }
  return [
    ...groups.values(),
    ...(overflowCount
      ? [
          {
            code: OVERFLOW_CODE,
            message:
              'Additional failure diagnostics compacted; full detail is unavailable.',
            count: overflowCount,
            omittedDetailCount: overflowCount,
          },
        ]
      : []),
  ];
}
function totalFailures(entries: CatalogSyncFailure[]): number {
  return entries.reduce(
    (total, entry) => addCount(total, occurrenceCount(entry.count)),
    0,
  );
}
function failure(error: unknown): CatalogSyncFailure {
  const value = error as {
    code?: unknown;
    message?: unknown;
    retryAfterMs?: unknown;
  };
  return {
    code: String(value?.code ?? 'enumeration-failed'),
    message: String(value?.message ?? error),
    ...(typeof value?.retryAfterMs === 'number'
      ? { retryAfterMs: value.retryAfterMs }
      : {}),
  };
}

/** Durable metadata synchronization. It never invokes a content acquisition adapter. */
export class CatalogSyncService {
  constructor(
    private readonly store: CatalogSyncStore,
    private readonly retries = 2,
    private readonly maxPages = 100,
  ) {}

  async sync(
    providerId: string,
    adapter: CatalogSyncAdapter,
  ): Promise<CatalogSyncReport> {
    if (!providerId.trim()) throw new Error('A provider ID is required.');
    const saved = await this.store.getCheckpoint(providerId);
    const resuming = saved?.complete === false;
    const runId = resuming
      ? (saved.runId ?? globalThis.crypto.randomUUID())
      : globalThis.crypto.randomUUID();
    let checkpoint: CatalogSyncCheckpoint = {
      providerId,
      cursor: resuming ? saved?.cursor : undefined,
      complete: false,
      importedCount: resuming ? (saved?.importedCount ?? 0) : 0,
      failures: compactFailures(resuming ? (saved?.failures ?? []) : []),
      runId,
    };
    const historicalCount = totalFailures(checkpoint.failures);
    let currentCount = 0;
    let withdrawnCount = 0;
    let policyTotal = 0;
    let otherCount = 0;
    const policyCodes = new Map<string, number>();
    const report = (): CatalogSyncReport => ({
      ...checkpoint,
      withdrawnCount,
      exclusionSummary: {
        total: policyTotal,
        byCode: [...policyCodes].map(([code, count]) => ({ code, count })),
        otherCount,
      },
      failureSummary: {
        total: totalFailures(checkpoint.failures),
        historical: historicalCount > 0,
        historicalCount,
        currentCount,
        omittedDetailCount: checkpoint.failures.reduce(
          (total, entry) => addCount(total, entry.omittedDetailCount ?? 0),
          0,
        ),
      },
    });
    const pause = async (
      reason: string,
      entries: CatalogSyncFailure[],
    ): Promise<CatalogSyncReport> => {
      currentCount = addCount(
        currentCount,
        totalFailures(entries.map(diagnostic)),
      );
      checkpoint = {
        ...checkpoint,
        complete: false,
        paused: true,
        pauseReason: bounded(reason, 512),
        failures: compactFailures([...checkpoint.failures, ...entries]),
      };
      await this.store.saveCheckpoint(checkpoint);
      return report();
    };
    const cursors = new Set<string>();
    if (checkpoint.cursor) cursors.add(checkpoint.cursor);
    for (let pageCount = 0; pageCount < this.maxPages; pageCount++) {
      let page:
        | Awaited<ReturnType<CatalogSyncAdapter['enumerate']>>
        | undefined;
      let lastFailure: CatalogSyncFailure | undefined;
      for (let attempt = 0; attempt <= this.retries; attempt++) {
        try {
          page = await adapter.enumerate({
            cursor: checkpoint.cursor,
            checkpoint,
          });
          break;
        } catch (error) {
          lastFailure = failure(error);
        }
      }
      if (!page) {
        const terminalFailure = lastFailure ?? {
          code: 'enumeration-failed',
          message: 'Adapter returned no catalog page.',
        };
        return await pause(terminalFailure.message, [terminalFailure]);
      }
      if (page.complete && page.nextCursor)
        throw new Error('A terminal catalog page cannot have a next cursor.');
      if (
        !page.complete &&
        !page.nextCursor &&
        !page.paused &&
        !page.exclusions?.length &&
        !page.policyExclusions?.length
      )
        throw new Error('A partial catalog page requires a next cursor.');
      for (const omission of page.policyExclusions ?? []) {
        const count = occurrenceCount(omission.count);
        policyTotal = addCount(policyTotal, count);
        const code =
          typeof omission.code === 'string' &&
          /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/.test(omission.code)
            ? omission.code
            : 'invalid-policy-code';
        if (policyCodes.has(code) || policyCodes.size < MAX_POLICY_CODES)
          policyCodes.set(code, addCount(policyCodes.get(code) ?? 0, count));
        else otherCount = addCount(otherCount, count);
      }
      // Current operational failures never advance, withdraw, or claim success.
      // Saved legacy diagnostics remain audit history, without guessed reclassification.
      if (page.paused || page.exclusions?.length) {
        const entries = page.exclusions?.length
          ? page.exclusions
          : [{ code: 'paused', message: 'Catalog source is paused.' }];
        return await pause(entries[0].message, entries);
      }
      for (const record of page.records) {
        if (
          record.providerId !== providerId ||
          !record.stableId ||
          !record.revision
        )
          throw new Error(
            'Catalog records require matching provider, stable ID, and revision.',
          );
        await this.store.upsert(record, runId);
      }
      checkpoint = {
        ...checkpoint,
        cursor:
          page.nextCursor ?? (page.complete ? undefined : checkpoint.cursor),
        complete: page.complete,
        paused: false,
        pauseReason: undefined,
        importedCount: checkpoint.importedCount + page.records.length,
      };
      if (!page.complete) {
        if (!page.nextCursor) {
          // A valid snapshot can be retained while its declared coverage is
          // explicitly unconfirmed. This is a controlled policy pause, not an
          // access/parse failure, and can never authorize withdrawal.
          checkpoint = {
            ...checkpoint,
            paused: true,
            pauseReason: bounded(
              page.policyExclusions?.[0]?.message ??
                'Catalog scope is incomplete.',
              512,
            ),
          };
          await this.store.saveCheckpoint(checkpoint);
          return report();
        }
        if (checkpoint.cursor && cursors.has(checkpoint.cursor))
          return await pause('Catalog source did not advance its cursor.', [
            {
              cursor: checkpoint.cursor,
              code: 'cursor-cycle',
              message: 'Catalog source did not advance its cursor.',
            },
          ]);
        if (checkpoint.cursor) cursors.add(checkpoint.cursor);
        await this.store.saveCheckpoint(checkpoint);
        continue;
      }
      withdrawnCount = await this.store.withdrawUnseen(providerId, runId);
      checkpoint = {
        providerId,
        complete: true,
        importedCount: checkpoint.importedCount,
        failures: checkpoint.failures,
        lastSuccessfulAt: new Date().toISOString(),
      };
      await this.store.saveCheckpoint(checkpoint);
      return report();
    }
    // A controlled invocation budget is a resumable yield, not a source failure.
    checkpoint = {
      ...checkpoint,
      complete: false,
      paused: false,
      pauseReason: undefined,
    };
    await this.store.saveCheckpoint(checkpoint);
    return report();
  }
}
