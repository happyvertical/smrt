import { smrt } from '@happyvertical/smrt-core';
import { Comment as SmrtComment } from '../models/Comment.js';

// Register only after the framework models and a registry snapshot are loaded.
export function registerAppModels(): { Comment: typeof SmrtComment } {
  class Comment extends SmrtComment {}
  smrt({
    packageName: '@local/issue-4931-comments',
    tableName: 'record_comments',
  })(Comment);
  return { Comment };
}
