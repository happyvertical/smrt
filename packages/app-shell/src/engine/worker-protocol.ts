export const WORKER_OPS = [
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
  | { id: number; ok: false; error: string; user: boolean };

export interface BootInfo {
  statements: string[];
  snapshot: string | null;
  bootMs: number;
}
