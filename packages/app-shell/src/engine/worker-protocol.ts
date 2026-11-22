import type { RuntimeReportErrorCode } from '@happyvertical/smrt-reports';

export const WORKER_OPS = [
  'columnInfo',
  'previewMerge',
  'previewExtract',
  'previewLoad',
  'compileReport',
  'runReport',
  'list',
  'listByIds',
  'readStoredRows',
  'get',
  'create',
  'update',
  'remove',
  'runMethod',
  'tools',
  'callTool',
  'rest',
  'snapshot',
  'copyTo',
  'previewConversion',
  'countValues',
  'countRows',
  'countArchives',
  'countOverwrites',
  'previewUndo',
  'pruneSnapshots',
  'purgeArchives',
  'importRecords',
] as const;
export type WorkerOp = (typeof WORKER_OPS)[number];

/** A cap refusal's numbers, carried across the worker boundary (#5198). */
export interface LimitInfo {
  cap: string;
  limit: number;
  current: number;
  requested: number;
}

/** `EngineError.details` of a cap refusal: what a caller reads instead of the message. */
export const limitDetails = (l: LimitInfo) => ({ code: 'app_limit', ...l });

export type WorkerCall = { id: number; op: string; args: unknown[] };
export type WorkerReply =
  | { id: number; ok: true; value: unknown }
  | {
      id: number;
      ok: false;
      error: string;
      user: boolean;
      /** Refused by the ownership fence (#5190). */
      stale?: boolean;
      /** Set only on a cap refusal (#5198). */
      limit?: LimitInfo;
      reportError?: {
        code: RuntimeReportErrorCode;
        path: string;
        /** Parser reason only: fixed grammar text, never SQL or a path. */
        reason?: string;
      };
    };

export interface BootInfo {
  skipped?: number;
  statements: string[];
  snapshot: string | null;
  bootMs: number;
}
