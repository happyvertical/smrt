/**
 * CommentCollection - Collection manager for Comment objects
 */

import { SmrtCollection } from '@happyvertical/smrt-core';
import { Comment } from '../models/Comment';

export class CommentCollection extends SmrtCollection<Comment> {
  static readonly _itemClass = Comment;
}
