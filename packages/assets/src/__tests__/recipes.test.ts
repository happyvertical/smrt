import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractFieldRefs } from '@happyvertical/smrt-core';
import { describe, expect, it } from 'vitest';
import { Asset } from '../asset.js';
import { AssetAssociation } from '../asset-association.js';
import { AssetMetafield } from '../asset-metafield.js';
import { AssetStatus } from '../asset-status.js';
import { AssetType } from '../asset-type.js';
import { Folder } from '../folder.js';
import { AssetAttachmentsRecipe, AssetLibraryRecipe } from '../recipes.js';
import playground, { assetGridMockAssets } from '../svelte/playground.js';

describe('assets feature recipes (#3725)', () => {
  const recipes = [AssetLibraryRecipe, AssetAttachmentsRecipe];

  it('declares the library and attachments workflows with unique ids', () => {
    expect(recipes.map((recipe) => recipe.id)).toEqual([
      'assets.library',
      'assets.attachments',
    ]);
  });

  it('binds navigation and models to the owning assets package', () => {
    expect(AssetLibraryRecipe.models).toEqual([
      Asset,
      Folder,
      AssetType,
      AssetStatus,
      AssetMetafield,
    ]);
    expect(AssetLibraryRecipe.nav).toEqual([
      {
        label: 'Assets',
        model: Asset,
        icon: 'archive',
        description: 'Files and media you can organize, reuse and share.',
        noun: 'asset',
      },
      {
        label: 'Folders',
        model: Folder,
        icon: 'folder',
        description: 'Organize assets into clear, reusable groups.',
        noun: 'folder',
      },
    ]);
    expect(AssetAttachmentsRecipe.models).toEqual([Asset, AssetAssociation]);
    expect(AssetAttachmentsRecipe.nav).toEqual([
      {
        label: 'Attachments',
        model: Asset,
        icon: 'fileText',
        description:
          'Supporting files connected to the record you are viewing.',
        noun: 'attachment',
      },
    ]);
    expect(AssetAttachmentsRecipe.requires).toEqual(['assets.library']);
  });

  it('shares the Files and media card and Assets navigation section', () => {
    expect(AssetLibraryRecipe.group).toEqual({
      id: 'assets',
      label: 'Files and media',
      summary:
        'Organize files and media, then attach them to the records that need them.',
    });
    expect(AssetAttachmentsRecipe.group).toEqual(AssetLibraryRecipe.group);
    expect(AssetLibraryRecipe.section).toEqual({
      id: 'assets',
      label: 'Assets',
      icon: 'folder',
      description: 'Files, media and attachments for your work.',
    });
    expect(AssetAttachmentsRecipe.section).toEqual(AssetLibraryRecipe.section);
  });

  it('only requires a recipe declared in this package', () => {
    const ids = new Set(recipes.map((recipe) => recipe.id));
    for (const recipe of recipes) {
      for (const required of recipe.requires)
        expect(ids.has(required)).toBe(true);
    }
  });

  it('marks browser fixtures as mock data without a network upload', () => {
    expect(
      playground.entries.map((entry) => [entry.id, entry.modes?.mock?.label]),
    ).toEqual([
      ['private-attachments', 'Mock'],
      ['asset-grid', 'Mock'],
    ]);
    expect(assetGridMockAssets).toHaveLength(3);
    expect(assetGridMockAssets[0].sourceUri).toMatch(/^data:image\/svg\+xml/);
  });

  describe('user-facing help', () => {
    const models = [
      [
        AssetLibraryRecipe,
        {
          Asset: new Asset(),
          Folder: new Folder(),
          AssetType: new AssetType(),
          AssetStatus: new AssetStatus(),
          AssetMetafield: new AssetMetafield(),
        },
      ],
      [
        AssetAttachmentsRecipe,
        { Asset: new Asset(), AssetAssociation: new AssetAssociation() },
      ],
    ] as const;

    it.each(models)('%s points at a complete help file', (recipe) => {
      expect(recipe.help).toMatch(/^\.\/assets-[a-z]+\.recipe\.md$/);
      const markdown = readFileSync(
        fileURLToPath(new URL(`../${recipe.help}`, import.meta.url)),
        'utf-8',
      );
      expect(markdown).toContain('## Overview');
      expect(markdown).toContain('## Tasks');
    });

    it.each(
      models,
    )('%s names only fields its models declare', (recipe, byName) => {
      const markdown = readFileSync(
        fileURLToPath(new URL(`../${recipe.help}`, import.meta.url)),
        'utf-8',
      );
      for (const reference of extractFieldRefs(markdown)) {
        const [modelName, fieldName = modelName] = reference.split('.');
        const model = byName[modelName as keyof typeof byName];
        expect(model, reference).toBeDefined();
        expect(fieldName in (model as object), reference).toBe(true);
      }
    });
  });
});
