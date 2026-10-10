import type { ImportIssue, ImportRunResult, ValidRecord } from './types.js';

export interface RunImportOptions {
  records: readonly ValidRecord[];
  /** Persist one record; reject to fail just that row. */
  createRecord: (values: Record<string, unknown>) => Promise<unknown>;
  /** Parallel requests. Default 3; 1 keeps file order on the server. */
  concurrency?: number;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Create the validated records through the supplied collection call, one
 * request per row, continuing past row failures so one bad row never loses the
 * rest. Aborting stops starting new rows; in-flight rows finish and are counted.
 */
export async function runImport(
  options: RunImportOptions,
): Promise<ImportRunResult> {
  const { records, createRecord, signal, onProgress } = options;
  const concurrency = Math.max(1, Math.floor(options.concurrency ?? 3));
  const failed: ImportIssue[] = [];
  let created = 0;
  let attempted = 0;
  let done = 0;
  let next = 0;

  async function worker(): Promise<void> {
    while (next < records.length && !signal?.aborted) {
      const record = records[next++];
      attempted++;
      try {
        await createRecord(record.values);
        created++;
      } catch (error) {
        failed.push({
          code: 'import-failed',
          line: record.line,
          detail: messageOf(error),
        });
      }
      done++;
      onProgress?.(done, records.length);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(concurrency, records.length) }, worker),
  );
  failed.sort((a, b) => a.line - b.line);
  return { attempted, created, failed, aborted: signal?.aborted === true };
}
