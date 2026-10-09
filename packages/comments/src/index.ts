import './__smrt-register__.js';

export { CommentCollection } from './collections/CommentCollection.js';
export { Comment } from './models/Comment.js';
export { RecordCommentsRecipe } from './recipes.js';
export { CommentService } from './services/CommentService.js';
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
} from './types.js';
