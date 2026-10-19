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

export interface CatalogSyncReport extends CatalogSyncCheckpoint {
  withdrawnCount: number;
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

function newRunId(): string {
  return globalThis.crypto.randomUUID();
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
    const runId = resuming ? (saved.runId ?? newRunId()) : newRunId();
    let checkpoint: CatalogSyncCheckpoint = {
      providerId,
      cursor: resuming ? saved?.cursor : undefined,
      complete: false,
      importedCount: resuming ? (saved?.importedCount ?? 0) : 0,
      failures: resuming ? (saved?.failures ?? []) : [],
      runId,
    };
    let withdrawnCount = 0;
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
        checkpoint = {
          ...checkpoint,
          complete: false,
          failures: [...checkpoint.failures, terminalFailure],
        };
        await this.store.saveCheckpoint(checkpoint);
        return { ...checkpoint, withdrawnCount };
      }
      const previousCursor = checkpoint.cursor;
      if (page.complete && page.nextCursor)
        throw new Error('A terminal catalog page cannot have a next cursor.');
      if (
        !page.complete &&
        !page.nextCursor &&
        !page.paused &&
        !page.exclusions?.length
      )
        throw new Error('A partial catalog page requires a next cursor.');
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
        cursor: page.nextCursor ?? (page.complete ? undefined : previousCursor),
        complete: page.complete,
        paused: false,
        pauseReason: undefined,
        importedCount: checkpoint.importedCount + page.records.length,
        failures: [...checkpoint.failures, ...(page.exclusions ?? [])],
      };
      const pause = (reason: string, code: string): CatalogSyncReport => {
        checkpoint = {
          ...checkpoint,
          complete: false,
          paused: true,
          pauseReason: reason,
          failures: [
            ...checkpoint.failures,
            { cursor: checkpoint.cursor, code, message: reason },
          ],
        };
        return { ...checkpoint, withdrawnCount };
      };
      if (page.paused || (!page.nextCursor && !page.complete)) {
        const reason =
          page.exclusions?.[0]?.message ?? 'Catalog source is paused.';
        const report = pause(reason, page.exclusions?.[0]?.code ?? 'paused');
        await this.store.saveCheckpoint(checkpoint);
        return report;
      }
      if (!page.complete) {
        if (checkpoint.cursor && cursors.has(checkpoint.cursor)) {
          const report = pause(
            'Catalog source did not advance its cursor.',
            'cursor-cycle',
          );
          await this.store.saveCheckpoint(checkpoint);
          return report;
        }
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
      return { ...checkpoint, withdrawnCount };
    }
    checkpoint = {
      ...checkpoint,
      complete: false,
      paused: true,
      pauseReason: 'Catalog page limit reached; resume in a later invocation.',
      failures: [
        ...checkpoint.failures,
        {
          cursor: checkpoint.cursor,
          code: 'page-limit',
          message: 'Catalog page limit reached; resume in a later invocation.',
        },
      ],
    };
    await this.store.saveCheckpoint(checkpoint);
    return { ...checkpoint, withdrawnCount };
  }
}
