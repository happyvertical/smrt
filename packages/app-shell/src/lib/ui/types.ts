import type { GeneratedExpression } from '@happyvertical/smrt-core';
import type {
  RuntimeReportResult,
  RuntimeReportSpec,
} from '@happyvertical/smrt-reports/svelte';
// Shapes of the shell's JSON routes (see README.md). Kept as plain types so
// client code never imports the engine or server modules.

export type FieldType =
  | 'text'
  | 'number'
  | 'integer'
  | 'boolean'
  | 'date'
  | 'money'
  | 'choice'
  | 'reference'
  | 'json';

export interface FieldDef {
  type: FieldType;
  label?: string;
  required?: boolean;
  choices?: string[];
  money?: { currency: string; scale: number };
  ref?: string;
  hidden?: boolean;
  calculated?: GeneratedExpression;
}

export interface MethodParam {
  type: FieldType;
  required?: boolean;
}

export interface MethodInfo {
  description: string;
  params: Record<string, MethodParam>;
}

export interface ModelInfo {
  kind: 'app' | 'shipped-subclass';
  label: string;
  table: string;
  className: string;
  extends: string | null;
  fields: Record<string, FieldDef>;
  ownFields: string[];
  methods: Record<string, MethodInfo>;
}

export type Target = 'live' | 'draft';

export interface DraftInfo {
  id: string;
  name: string;
  status: 'open';
  baseVersion: number;
  version: number | null;
  changes: number;
  createdAt: string;
  createdBy: string;
  liveVersion: number;
  liveFrozen: boolean;
  publishable: boolean;
  problem: string | null;
  recovery: 'none' | 'rolled-forward' | 'rolled-back';
}

export interface PublishPreview {
  fieldRenames?: {
    model: string;
    from: string;
    to: string;
    fromLabel: string;
    toLabel: string;
  }[];
  modelLabels?: Record<string, string>;
  fields?: Record<string, Record<string, FieldDef>>;
  reportChanges?: { kind: 'added' | 'changed' | 'removed'; text: string }[];
  digest: string;
  fromVersion: number;
  toVersion: number;
  versions: {
    version: number;
    summary: string;
    humanSummary?: string;
    dataSteps?: {
      op: 'loadRecords' | 'extractModel' | 'mergeRecords';
      model: string;
      mode?: 'insert' | 'upsert';
      counts: Record<string, unknown>;
    }[];
    statements: string[];
    steps: {
      op: string;
      table: string;
      column?: string;
      from?: unknown;
      to?: unknown;
    }[];
  }[];
  definition: {
    modelsAdded: string[];
    modelsRemoved: string[];
    recipesAdded: string[];
    recipesRemoved: string[];
    models: Record<
      string,
      {
        fieldsAdded: string[];
        fieldsRemoved: string[];
        fieldsChanged: { field: string; from: FieldDef; to: FieldDef }[];
      }
    >;
  };
  archives: { values: number; tables: number };
  methods: {
    model: string;
    name: string;
    description: string;
    code: string;
    change: 'added' | 'changed' | 'unchanged';
  }[];
}

export interface ReportDef {
  label?: string;
  description?: string;
  spec: RuntimeReportSpec;
}
export type AppReportResult = Omit<RuntimeReportResult, 'columns'> & {
  columns: (RuntimeReportResult['columns'][number] & {
    choices?: string[];
    money?: { currency: string; scale: number };
    reference?: string;
    labelColumn?: string;
  })[];
};

export interface Description {
  mode: Target;
  draft: DraftInfo | null;
  frozen: boolean;
  name: string;
  version: number;
  recipes: string[];
  models: Record<string, ModelInfo>;
  reports?: Record<string, ReportDef>;
  pendingApprovals: number;
}

export type RecordRow = Record<string, unknown> & {
  id: string;
  createdAt?: string | null;
};

export interface VersionInfo {
  publish: { draftId: string; name: string } | null;
  version: number;
  parent: number | null;
  author: string;
  summary: string;
  humanSummary?: string;
  createdAt: string;
  purged: boolean;
  current: boolean;
}

/**
 * `unknown` is the shell's view of an approval left `executing`: a change
 * whose outcome the engine could not tell (#5486). It is never stored; a
 * reopen settles the row, and the view then reads approved or failed.
 */
export type ApprovalStatus =
  | 'pending'
  | 'approved'
  | 'denied'
  | 'failed'
  | 'unknown';

export type ApprovalAction =
  | {
      kind: 'publish-draft';
      draftId: string;
      draftName: string;
      digest: string;
    }
  | { kind: 'discard-draft'; draftId: string; draftName: string }
  | { kind: 'command'; command: Record<string, unknown> }
  | { kind: 'tool'; name: string; args: Record<string, unknown> }
  | { kind: 'rest'; method: string; url: string; body?: string }
  | { kind: 'record-delete'; model: string; id: string };

export interface ApprovalView {
  id: string;
  status: ApprovalStatus;
  summary: string;
  humanSummary?: string;
  preview: unknown;
  action: ApprovalAction | null;
  requestedBy: string;
  decidedBy: string;
  decidedAt: string;
  result: unknown;
  createdAt: string;
}

export interface PendingApproval {
  status: 'pending_approval';
  approvalId: string;
  summary: string;
  humanSummary?: string;
  preview: unknown;
}

/** One waiting change as `GET /api/shell/changes` sends it (README "Changes waiting"). */
export interface ChangeCardView {
  id: string;
  position: number;
  group: string;
  source: 'assistant' | 'import' | 'api' | 'quick';
  /** Plain words for the card's heading. */
  summary: string;
  status: 'active' | 'removed';
  revision: number;
  /** An adopted older draft's change: no commands, no Remove, no Quick edit. */
  opaque: boolean;
  commands: Record<string, unknown>[];
  checks: { code: string; message: string; cause?: string }[];
  /** The assistant's review questions; they never block Apply. */
  questions: ChangeQuestion[];
  /** The owner's comments on this change and the assistant's answers. */
  comments: ChangeComment[];
  /** The assistant is changing this card for a comment right now. */
  revising: boolean;
  threadId: string;
  messageId: string;
  editable: boolean;
}

export interface ChangeQuestion {
  id: string;
  text: string;
  /** `adds`: clicking it makes a new change; otherwise it just closes the question. */
  choices: { label: string; adds: boolean; summary?: string }[];
  state: 'open' | 'answered';
  /** Index of the choice taken, once answered. */
  answered?: number;
}

export interface ChangeComment {
  kind: 'comment';
  role: 'owner' | 'assistant';
  text: string;
  at: string;
  state?: 'revising' | 'done';
}

export interface ChangeBlocker {
  code: string;
  message: string;
  cardId?: string;
  key?: string;
  field?: string;
}

/** `GET /api/shell/changes`: the ONE source of the waiting count. */
export interface ChangesState {
  batchId: string | null;
  status: 'none' | 'open' | 'held';
  /** Active cards: the one number the owner sees. */
  count: number;
  generation: number;
  /** Apply's `expect`. */
  digest: string;
  /** `stale`: waiting for its check; `checking`: the check is running. */
  checkState: 'none' | 'ok' | 'blocked' | 'stale' | 'checking';
  canApply: boolean;
  /** The server's own `applyNowEligible`: the chat reply may offer "Apply now". */
  applyNow: boolean;
  blockers: ChangeBlocker[];
  overwrites: {
    recordsUpdated: number;
    recordsMerged: number;
    archivedValues: number;
    archivedTables: number;
  } | null;
  held: string | null;
  liveVersion: number;
  baseVersion: number;
  cards: ChangeCardView[];
  discarded: { batchId: string; count: number; generation: number } | null;
  lastApplied: {
    batchId: string;
    appliedAt: string;
    versions: number[];
    undone: boolean;
    undoDigest: string;
    count: number;
  } | null;
}

export type ShellEvent =
  | {
      type: 'changes';
      status: 'changed' | 'applied' | 'discarded' | 'undone';
      batchId: string;
      count: number;
      generation: number;
    }
  | {
      type: 'changed';
      target?: 'live' | 'draft';
      version: number;
      summary: string;
      humanSummary?: string;
    }
  | { type: 'records'; target?: 'live' | 'draft'; model: string | null }
  | {
      type: 'draft';
      status: 'started' | 'published' | 'discarded' | 'unpublishable';
      id: string;
      name: string;
    }
  | {
      type: 'approval';
      id: string;
      status: ApprovalStatus;
      summary: string;
      humanSummary?: string;
    };
