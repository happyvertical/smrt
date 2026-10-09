/**
 * Declared feature recipes for smrt-assets (#3725).
 *
 * The recipes describe the package's model-backed asset workflows. UI surface,
 * provider, runtime, and demo-seed declarations are intentionally deferred to
 * the recipe-surface contract in #3708.
 */

import { SmrtRecipe } from '@happyvertical/smrt-core';
import { Asset } from './asset.js';
import { AssetAssociation } from './asset-association.js';
import { AssetMetafield } from './asset-metafield.js';
import { AssetStatus } from './asset-status.js';
import { AssetType } from './asset-type.js';
import { Folder } from './folder.js';

/** Organize, classify, and manage a library of files and media. */
export class AssetLibraryRecipe extends SmrtRecipe {
  static id = 'assets.library';
  static help = './assets-library.recipe.md';
  static label = 'Asset Library';
  static summary =
    'Organize files and media with folders, types, and statuses.';
  static synonyms = ['media library', 'file library', 'digital assets'];
  static group = {
    id: 'assets',
    label: 'Files and media',
    summary:
      'Organize files and media, then attach them to the records that need them.',
  };
  static section = {
    id: 'assets',
    label: 'Assets',
    icon: 'folder',
    description: 'Files, media and attachments for your work.',
  };
  static models = [Asset, Folder, AssetType, AssetStatus, AssetMetafield];
  static nav = [
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
  ];
  static options = {
    Asset: {
      fields: {
        name: { label: 'Name', order: 1 },
        description: { order: 2 },
        folderId: { label: 'Folder', order: 3 },
        typeSlug: { label: 'Type', order: 4 },
        statusSlug: { label: 'Status', order: 5 },
        mimeType: { label: 'File type', order: 6 },
      },
    },
    Folder: {
      fields: {
        name: { label: 'Name', order: 1 },
        description: { order: 2 },
      },
    },
  } as const;
}

/** Attach authorized files to records while retaining their provenance. */
export class AssetAttachmentsRecipe extends SmrtRecipe {
  static id = 'assets.attachments';
  static help = './assets-attachments.recipe.md';
  static label = 'Attachments';
  static summary =
    'Attach authorized files to records and retain their history.';
  static synonyms = [
    'file attachments',
    'record files',
    'supporting documents',
  ];
  static group = {
    id: 'assets',
    label: 'Files and media',
    summary:
      'Organize files and media, then attach them to the records that need them.',
  };
  static section = {
    id: 'assets',
    label: 'Assets',
    icon: 'folder',
    description: 'Files, media and attachments for your work.',
  };
  static models = [Asset, AssetAssociation];
  static nav = [
    {
      label: 'Attachments',
      model: Asset,
      icon: 'fileText',
      description: 'Supporting files connected to the record you are viewing.',
      noun: 'attachment',
    },
  ];
  static requires = ['assets.library'];
  static options = {
    Asset: {
      fields: {
        name: { label: 'File name', order: 1 },
        description: { label: 'Description', order: 2 },
        mimeType: { label: 'File type', order: 3 },
      },
    },
    AssetAssociation: {
      fields: {
        assetId: { label: 'Attachment', order: 1 },
        role: { label: 'Role', order: 2 },
        sortOrder: { label: 'Display order', order: 3 },
      },
    },
  } as const;
}
