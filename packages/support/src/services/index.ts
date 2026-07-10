/**
 * Service barrel for `@happyvertical/smrt-support`.
 */

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
