import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractFieldRefs } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import { TaxonomyRecipe } from '../index.js';
import { TaxonomyRecipe as FromRecipes } from '../recipes.js';
import { Tag } from '../tag.js';
import { TagAlias } from '../tag-alias.js';

describe('tags recipes (#3719)', () => {
  it('is exported from the package entry', () => {
    expect(TaxonomyRecipe).toBe(FromRecipes);
  });

  it('declares tags.taxonomy over Tag and TagAlias with no prerequisites', () => {
    expect(TaxonomyRecipe.id).toBe('tags.taxonomy');
    expect(TaxonomyRecipe.models).toEqual([Tag, TagAlias]);
    expect(TaxonomyRecipe.nav).toEqual([
      { label: 'Tags', model: Tag },
      { label: 'Alternative Names', model: TagAlias },
    ]);
    expect(TaxonomyRecipe.requires).toEqual([]);
  });

  it('nav only names listed models', () => {
    for (const entry of TaxonomyRecipe.nav)
      expect(TaxonomyRecipe.models).toContain(entry.model);
  });

  it('hides and locks the denormalised depth', () => {
    expect(TaxonomyRecipe.options.Tag.fields.level).toEqual({
      visibility: 'hidden',
      locked: true,
    });
  });

  describe('user-facing help (#3591)', () => {
    const markdown = () =>
      readFileSync(
        fileURLToPath(new URL(`../${TaxonomyRecipe.help}`, import.meta.url)),
        'utf-8',
      );

    it('points at a help file beside recipes.ts', () => {
      expect(TaxonomyRecipe.help).toBe('./taxonomy.recipe.md');
      expect(markdown()).toContain('## Overview');
      expect(markdown()).toContain('## Tasks');
    });

    it('names only fields the models declare', () => {
      const declared = new Set([
        ...Object.keys(new Tag()),
        ...Object.keys(new TagAlias()),
      ]);
      const refs = extractFieldRefs(markdown());
      expect(refs.length).toBeGreaterThan(0);
      for (const ref of refs) expect(declared.has(ref), ref).toBe(true);
    });
  });
});
