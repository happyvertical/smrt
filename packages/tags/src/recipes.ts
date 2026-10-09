/**
 * Declared recipes for smrt-tags (#3719): small, user-facing units of
 * functionality an app or agent can pick instead of the whole package.
 *
 * `tags.taxonomy` is the first app-wide feature recipe. It is browser-safe
 * and has no prerequisites, so it doubles as the pipeline proof for the
 * feature catalogue. Surfaces, providers, and demo data are added once
 * recipes can declare non-model surfaces (#3708).
 *
 * @packageDocumentation
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { Tag } from './tag.js';
import { TagAlias } from './tag-alias.js';

/** A shared tag vocabulary: nested tags with alternative names. */
export class TaxonomyRecipe extends SmrtRecipe {
  static id = 'tags.taxonomy';
  static help = './taxonomy.recipe.md';
  static label = 'Taxonomy';
  static summary =
    'Organise anything with a shared set of nested tags and alternative names.';
  static synonyms = ['tags', 'tagging', 'categories', 'labels', 'topics'];
  static models = [Tag, TagAlias];
  static nav = [
    { label: 'Tags', model: Tag },
    { label: 'Alternative Names', model: TagAlias },
  ];
  // Literal values (`as const` keeps `visibility` a literal type): the scanner
  // reads these statically. `level` is recalculated when a tag moves, so it is
  // shown to no one and never edited by hand.
  static options = {
    Tag: {
      fields: {
        name: { order: 1 },
        parentId: { label: 'Parent tag', order: 2 },
        description: { order: 3 },
        level: { visibility: 'hidden', locked: true },
        metadata: { visibility: 'advanced' },
      },
    },
    TagAlias: {
      fields: {
        alias: { label: 'Alternative name', order: 1 },
        tagSlug: { label: 'Tag', order: 2 },
        language: { order: 3 },
      },
    },
  } as const;
}
