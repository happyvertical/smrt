import './__smrt-register__.js';

export { CommentCollection } from './collections/CommentCollection.js';
export { CommentReportCollection } from './collections/CommentReportCollection.js';
export { CommentRevisionCollection } from './collections/CommentRevisionCollection.js';
export { Comment } from './models/Comment.js';
export { CommentReport } from './models/CommentReport.js';
export { CommentRevision } from './models/CommentRevision.js';
export {
  type ParticipationAction,
  type ParticipationAuthorizer,
  type ParticipationDecision,
  ParticipationDeniedError,
  type ParticipationRequest,
  type ParticipationTarget,
} from './participation.js';
export { RecordCommentsRecipe } from './recipes.js';
export {
  CommentIdempotencyError,
  CommentService,
} from './services/CommentService.js';
export {
  type CommentNotificationService,
  createCommentMentionNotifications,
} from './services/mentionNotifications.js';
export type {
  CommentActorContext,
  CommentMention,
  CommentMentionNotificationAdapter,
  CommentOptions,
  CommentRecordAccess,
  CreateCommentInput,
} from './types.js';
