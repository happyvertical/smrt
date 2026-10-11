import { SmrtRecipe } from '@happyvertical/smrt-core';
import { Comment } from './models/Comment.js';

/** Discussion attached to any authorized business record. */
export class RecordCommentsRecipe extends SmrtRecipe {
  static id = 'comments.records';
  static label = 'Record comments';
  static summary = 'Discuss work directly on the records it concerns.';
  static synonyms = ['comments', 'mentions', 'discussion'];
  static group = {
    id: 'comments',
    label: 'Comments',
    summary: 'Keep discussions alongside the records your team works on.',
  };
  static models = [Comment];
  // Record discussions need an authorized parent record, not a global list.
  static nav = [];
  static runtime = 'both' as const;
  static surfaces = [
    {
      kind: 'playground',
      export: '@happyvertical/smrt-comments/svelte#RecordCommentsPlayground',
      label: 'Record discussion preview',
    },
  ] as const;
  static demoSeed = {
    export: '@happyvertical/smrt-comments/svelte#recordCommentsDemo',
  } as const;
  static help = './comments.records.recipe.md';
}
