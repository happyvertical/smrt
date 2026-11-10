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

export interface Description {
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
  | { type: 'changed'; version: number; summary: string }
  | { type: 'records'; model: string | null }
  | {
      type: 'approval';
      id: string;
      status: ApprovalStatus;
      summary: string;
    };
