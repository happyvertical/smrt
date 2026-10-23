import type {
  ProjectContextReference,
  ProjectDecisionOption,
  ProjectDecisionStatus,
  ProjectQuestionStatus,
} from '../project-governance-types.js';

export interface ProjectQuestionView {
  id: string;
  prompt: string;
  status: ProjectQuestionStatus;
  answer?: string;
  ownerLabel?: string;
  contextReferences?: ProjectContextReference[];
  revision: number;
  canResolve?: boolean;
}

export interface ProjectDecisionView {
  id: string;
  question: string;
  status: ProjectDecisionStatus;
  options?: ProjectDecisionOption[];
  outcome?: string;
  rationale?: string;
  ownerLabel?: string;
  contextReferences?: ProjectContextReference[];
  revision: number;
  canResolve?: boolean;
}

export interface ProjectQuestionAnswerInput {
  id: string;
  answer: string;
  expectedRevision: number;
}

export interface ProjectDecisionResolveInput {
  id: string;
  outcome: string;
  rationale: string;
  expectedRevision: number;
}
