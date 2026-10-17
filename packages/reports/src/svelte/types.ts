import type { RuntimeReportResult } from '../runtime-compiler.js';
import type { RuntimeReportSpec } from '../runtime-spec.js';

/** Browser projection only: never includes persisted result rows. */
export interface SavedRuntimeReport {
  id: string;
  title: string;
  description?: string;
  sourceId: string;
  createdByUserId: string;
  status: 'active' | 'archived';
  spec: RuntimeReportSpec;
  /** When the report was saved (approved), when the host knows it. */
  savedAt?: string;
  /** Browser-session hint only. Runtime result rows and run history are not persisted. */
  lastRunAt?: string;
  /** Host permission hint. The archive endpoint authorizes every mutation again. */
  canArchive: boolean;
}

/** A principal-scoped transport. Replace it when the tenant or viewer changes. */
export interface RuntimeReportsClient {
  list(options: {
    onlyMine: boolean;
    includeArchived: boolean;
  }): Promise<SavedRuntimeReport[]>;
  get(id: string): Promise<SavedRuntimeReport>;
  run(id: string): Promise<RuntimeReportResult>;
  archive(id: string, archived: boolean): Promise<void>;
  confirm(proposal: RuntimeReportProposal): Promise<SavedRuntimeReport>;
}

export type { RuntimeReportResult, RuntimeReportSpec };

/** Server-issued proposal projection; the server retains the canonical pending spec. */
export interface RuntimeReportProposal {
  status: 'awaiting_confirmation';
  specHash: string;
  spec: RuntimeReportSpec;
  sourceLabel: string;
  confirmPath: string;
  preview: RuntimeReportResult;
}
