import { SmrtCollection } from '@happyvertical/smrt-core';
import { CommentRevision } from '../models/CommentRevision.js';

export class CommentRevisionCollection extends SmrtCollection<CommentRevision> {
  static readonly _itemClass = CommentRevision;
}
