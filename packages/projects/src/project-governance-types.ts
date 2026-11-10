export type ProjectQuestionStatus =
  | 'open'
  | 'answered'
  | 'deferred'
  | 'superseded';

export type ProjectDecisionStatus =
  | 'open'
  | 'decided'
  | 'deferred'
  | 'superseded';

export type ProjectGovernanceVisibility = 'internal' | 'client';

export type ProjectGovernanceActorType = 'user' | 'agent' | 'system';

export interface ProjectGovernanceActor {
  type: ProjectGovernanceActorType;
  id: string;
  /** Trusted host authorization. Managers may create, assign, defer, and supersede. */
  canManage?: boolean;
}

export interface ProjectGovernanceScope {
  tenantId: string;
  /** Qualified SMRT class name for the host project's record type. */
  projectType: string;
  projectId: string;
}

export type ProjectContextReferenceKind =
  | 'spec'
  | 'cookbook'
  | 'conversation'
  | 'asset'
  | 'url'
  | 'other';

export interface ProjectContextReference {
  kind: ProjectContextReferenceKind;
  ref: string;
  label?: string;
}

export interface ProjectGovernanceOwner {
  type: ProjectGovernanceActorType;
  id: string;
}

export interface ProjectQuestionCreateInput extends ProjectGovernanceScope {
  prompt: string;
  /** Single-choice suggestions; Other is supplied by the service. */
  options?: ProjectQuestionOption[];
  owner?: ProjectGovernanceOwner | null;
  contextReferences?: ProjectContextReference[];
  visibility?: ProjectGovernanceVisibility;
  actor: ProjectGovernanceActor;
}

export interface ProjectDecisionOption {
  id: string;
  label: string;
  description?: string;
}

export interface ProjectDecisionCreateInput extends ProjectGovernanceScope {
  question: string;
  options?: ProjectDecisionOption[];
  owner?: ProjectGovernanceOwner | null;
  contextReferences?: ProjectContextReference[];
  visibility?: ProjectGovernanceVisibility;
  actor: ProjectGovernanceActor;
}

export type ProjectGovernanceRecordKind = 'question' | 'decision';

export type ProjectGovernanceAction =
  | 'created'
  | 'assigned'
  | 'answered'
  | 'decided'
  | 'deferred'
  | 'reopened'
  | 'superseded';

/** Reserved identity for the always-available free-text choice. */
export const PROJECT_QUESTION_OTHER_OPTION_ID = 'other';

/** Recommendation is display guidance only, never a selected answer. */
export interface ProjectQuestionOption extends ProjectDecisionOption {
  recommended?: boolean;
}

/** Immutable answer provenance; absent on historical free-text events. */
export interface ProjectQuestionAnswerSelection {
  answer: string;
  selectedOptionId?: string;
  optionLabel?: string;
  expectedRevision: number;
  idempotencyKey?: string;
}
