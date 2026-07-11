/**
 * Service barrel for `@happyvertical/smrt-support`.
 */

export {
  type HandoffAiRunSummary,
  type HandoffContextPackage,
  type HandoffTimelineItem,
  type HumanHandoffInput,
  type HumanHandoffResult,
  HumanHandoffService,
  type HumanHandoffServiceOptions,
  type SpecialistRouter,
} from './human-handoff-service.js';
export {
  type RecordServiceTimeEntryInput,
  ServiceTimeEntryService,
  type ServiceTimeEntryServiceOptions,
  type SubmitServiceTimeEntryInput,
} from './service-time-entry-service.js';
export {
  createDefaultAiBoundary,
  createNoopKnowledgeProvider,
  type KnowledgeSnippet,
  type SupportAiAnswerResult,
  type SupportAiBoundary,
  type SupportAiClassifyResult,
  SupportAiWorkflow,
  type SupportAiWorkflowOptions,
  type SupportHandoffNotice,
  type SupportKnowledgeProvider,
  severityRank,
} from './support-ai-workflow.js';
export {
  type CaseActor,
  type CaseTimelineItem,
  type OpenCaseInput,
  type RecordInteractionInput,
  SupportCaseService,
} from './support-case-service.js';
export {
  CHAT_MESSAGE_SOURCE_TYPE,
  CHAT_ROOM_TARGET_TYPE,
  EMAIL_ACCOUNT_TARGET_TYPE,
  EMAIL_SOURCE_TYPE,
  type InboundChatMessage,
  type InboundEmail,
  type IntakeResult,
  registerSupportIntake,
  SUPPORT_INTAKE_INTERCEPTOR,
  type SupportIntakeOptions,
  SupportIntakeService,
} from './support-intake-service.js';
export {
  type ApproveTimeEntryInput,
  type ApproveTimeEntryResult,
  type CorrectTimeEntryInput,
  type CorrectTimeEntryResult,
  type RejectTimeEntryInput,
  type ResolvedPlanTerms,
  TimeEntryApprovalDeniedError,
  TimeEntryApprovalService,
  type TimeEntryApprovalServiceOptions,
} from './time-entry-approval-service.js';
