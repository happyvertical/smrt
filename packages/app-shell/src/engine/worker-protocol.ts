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

/** The operation id of boot: registered by the host before the thread starts. */
export const BOOT_OP = 0;

/**
 * Which database identity each op runs as (#5188). `data`: the app's runtime
 * role (user ops and REST). `owner`: the schema owner role (dump work that
 * must read everything). `none`: never touches the database. Boot is `owner`.
 */
export type OpLane = 'data' | 'owner' | 'none';
export const OP_LANES: Record<WorkerOp, OpLane> = {
  columnInfo: 'data',
  previewMerge: 'data',
  previewExtract: 'data',
  previewLoad: 'data',
  compileReport: 'data',
  runReport: 'data',
  list: 'data',
  listByIds: 'data',
  readStoredRows: 'data',
  get: 'data',
  create: 'data',
  update: 'data',
  remove: 'data',
  runMethod: 'data',
  tools: 'data',
  callTool: 'data',
  rest: 'data',
  snapshot: 'owner',
  copyTo: 'owner',
  previewConversion: 'data',
  countValues: 'data',
  countRows: 'data',
  countArchives: 'data',
  countOverwrites: 'data',
  previewUndo: 'data',
  pruneSnapshots: 'none',
  purgeArchives: 'owner',
  importRecords: 'data',
};

/** A cap refusal's numbers, carried across the worker boundary (#5198). */
export interface LimitInfo {
  cap: string;
  limit: number;
  current: number;
  requested: number;
}

/** `EngineError.details` of a cap refusal: what a caller reads instead of the message. */
export const limitDetails = (l: LimitInfo) => ({ code: 'app_limit', ...l });

/**
 * One call into an app worker. `principal` is who asked (see `principal.ts`);
 * the handle refuses a call without a valid one, and the worker checks it again.
 */
export type WorkerCall = {
  /** The operation id: the broker's transaction for this call is named by it. */
  id: number;
  op: string;
  args: unknown[];
  principal: unknown;
};
export type WorkerReply =
  | { id: number; ok: true; value: unknown }
  | {
      id: number;
      ok: false;
      error: string;
      user: boolean;
      /** Refused by the ownership fence (#5190). */
      stale?: boolean;
      /** Refused for the caller (#5188): no valid principal, or a permission it lacks. */
      code?: 'unauthorized' | 'forbidden';
      /** The worker's call queue was full (#5188): retry later; nothing ran. */
      busy?: true;
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
