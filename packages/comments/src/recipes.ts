import { SmrtRecipe } from '@happyvertical/smrt-core';
import { Comment } from './models/Comment.js';

/** Discussion attached to any authorized business record. */
export class RecordCommentsRecipe extends SmrtRecipe {
  static id = 'comments.records';
  static label = 'Record comments';
  static summary = 'Discuss work directly on the records it concerns.';
  static synonyms = ['comments', 'mentions', 'discussion'];
  static models = [Comment];
}
