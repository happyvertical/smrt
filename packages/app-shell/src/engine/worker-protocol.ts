import type { RuntimeReportErrorCode } from '@happyvertical/smrt-reports';

export const WORKER_OPS = [
  'columnInfo',
  'previewMerge',
  'previewExtract',
  'previewLoad',
  'compileReport',
  'runReport',
  'list',
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
  'pruneSnapshots',
  'purgeArchives',
  'importRecords',
] as const;
export type WorkerOp = (typeof WORKER_OPS)[number];

export type WorkerCall = { id: number; op: string; args: unknown[] };
export type WorkerReply =
  | { id: number; ok: true; value: unknown }
  | {
      id: number;
      ok: false;
      error: string;
      user: boolean;
      reportError?: { code: RuntimeReportErrorCode; path: string };
    };

export interface BootInfo {
  skipped?: number;
  statements: string[];
  snapshot: string | null;
  bootMs: number;
}
