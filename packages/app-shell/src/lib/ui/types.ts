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
  ref?: string;
  hidden?: boolean;
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
  digest: string;
  fromVersion: number;
  toVersion: number;
  versions: {
    version: number;
    summary: string;
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

export interface Description {
  mode: Target;
  draft: DraftInfo | null;
  frozen: boolean;
  name: string;
  version: number;
  recipes: string[];
  models: Record<string, ModelInfo>;
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
  createdAt: string;
  purged: boolean;
  current: boolean;
}

export type ApprovalStatus = 'pending' | 'approved' | 'denied' | 'failed';

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
  preview: unknown;
}

export type ShellEvent =
  | {
      type: 'changed';
      target?: 'live' | 'draft';
      version: number;
      summary: string;
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
    };
