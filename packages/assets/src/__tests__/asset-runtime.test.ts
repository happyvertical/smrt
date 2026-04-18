/**
 * AssetRuntime tests
 *
 * Covers the public runtime surface: factory wiring, source/derived
 * creation, provenance linking, and the extraction-status helper.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Asset } from '../asset';
import { AssetAssociationCollection } from '../asset-associations';
import { ASSET_ROLES } from '../asset-conventions';
import { AssetRuntime, createAssetRuntime } from '../asset-runtime';
import { AssetCollection } from '../assets';

describe('AssetRuntime', () => {
  let db: DatabaseInterface;
  let storageDir: string;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    storageDir = mkdtempSync(pathJoin(tmpdir(), 'asset-runtime-'));
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
    if (storageDir && existsSync(storageDir)) {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  describe('createAssetRuntime()', () => {
    it('wires collection, associations, and an initialized store from a single config', async () => {
      const runtime = await createAssetRuntime({
        db,
        storage: storageDir,
      });

      expect(runtime).toBeInstanceOf(AssetRuntime);
      expect(runtime.collection).toBeInstanceOf(AssetCollection);
      expect(runtime.associations).toBeInstanceOf(AssetAssociationCollection);
      expect(runtime.store.basePath).toBe(storageDir);
    });

    it('reuses pre-built collections when provided', async () => {
      const collection = await AssetCollection.create({ db });
      const associations = await AssetAssociationCollection.create({ db });

      const runtime = await createAssetRuntime({
        db,
        storage: storageDir,
        collection,
        associations,
      });

      expect(runtime.collection).toBe(collection);
      expect(runtime.associations).toBe(associations);
    });
  });

  describe('storeSourceAsset', () => {
    it('creates a persisted asset with bytes on disk', async () => {
      const runtime = await createAssetRuntime({ db, storage: storageDir });
      const bytes = Buffer.from('hello world');

      const asset = await runtime.storeSourceAsset('notes.txt', bytes, {
        mimeType: 'text/plain',
        typeSlug: 'document',
      });

      expect(asset.id).toBeTruthy();
      expect(asset.sourceUri).toMatch(/^file:\/\//);
      expect(asset.mimeType).toBe('text/plain');

      const reloaded = await runtime.store.readById(asset.id!);
      expect(reloaded?.data.toString()).toBe('hello world');
    });
  });

  describe('storeDerivedAsset', () => {
    it('persists a derivative with parentId + provenance association by default', async () => {
      const runtime = await createAssetRuntime({ db, storage: storageDir });

      const source = await runtime.storeSourceAsset(
        'agenda.pdf',
        Buffer.from('PDF BYTES'),
        { mimeType: 'application/pdf', typeSlug: 'document' },
      );

      const derived = await runtime.storeDerivedAsset(
        source,
        'agenda-page-1.png',
        Buffer.from('PNG BYTES'),
        {
          mimeType: 'image/png',
          typeSlug: 'image',
          role: ASSET_ROLES.DOCUMENT_IMAGE,
        },
      );

      expect(derived.parentId).toBe(source.id);

      const links = await runtime.associations.getForAsset(source.id!);
      expect(links).toHaveLength(1);
      expect(links[0].metaId).toBe(derived.id);
      expect(links[0].role).toBe('document_image');
    });

    it('skips the association when linkAssociation is false', async () => {
      const runtime = await createAssetRuntime({ db, storage: storageDir });
      const source = await runtime.storeSourceAsset(
        'agenda.pdf',
        Buffer.from('PDF'),
        { mimeType: 'application/pdf', typeSlug: 'document' },
      );

      const derived = await runtime.storeDerivedAsset(
        source,
        'thumb.png',
        Buffer.from('PNG'),
        {
          mimeType: 'image/png',
          typeSlug: 'image',
          linkAssociation: false,
        },
      );

      expect(derived.parentId).toBe(source.id);
      const links = await runtime.associations.getForAsset(source.id!);
      expect(links).toHaveLength(0);
    });

    it('rejects derivation from an unpersisted source', async () => {
      const runtime = await createAssetRuntime({ db, storage: storageDir });
      const ghost = new Asset({ name: 'ghost' });

      await expect(
        runtime.storeDerivedAsset(ghost, 'x.png', Buffer.from('x'), {
          mimeType: 'image/png',
          typeSlug: 'image',
        }),
      ).rejects.toThrow(/missing id/);
    });
  });

  describe('linkDerivation', () => {
    it('records an association between existing source + derivative', async () => {
      const runtime = await createAssetRuntime({ db, storage: storageDir });

      const source = await runtime.storeSourceAsset(
        'agenda.pdf',
        Buffer.from('PDF'),
        { mimeType: 'application/pdf', typeSlug: 'document' },
      );
      const derivative = await runtime.storeSourceAsset(
        'manual-extract.png',
        Buffer.from('PNG'),
        { mimeType: 'image/png', typeSlug: 'image' },
      );

      const link = await runtime.linkDerivation(source, derivative, {
        role: ASSET_ROLES.DOCUMENT_IMAGE,
      });

      expect(link.assetId).toBe(source.id);
      expect(link.metaId).toBe(derivative.id);
      expect(link.role).toBe('document_image');
    });
  });

  describe('setExtractionStatus', () => {
    it('writes extraction metadata into the asset description sidecar', async () => {
      const runtime = await createAssetRuntime({ db, storage: storageDir });
      const source = await runtime.storeSourceAsset(
        'agenda.pdf',
        Buffer.from('PDF'),
        { mimeType: 'application/pdf', typeSlug: 'document' },
      );

      await runtime.setExtractionStatus(source, 'succeeded');

      const parsed = JSON.parse(source.description);
      expect(parsed.extractionStatus).toBe('succeeded');
      expect(typeof parsed.extractedAt).toBe('string');
    });

    it('records an error when status is failed', async () => {
      const runtime = await createAssetRuntime({ db, storage: storageDir });
      const source = await runtime.storeSourceAsset(
        'agenda.pdf',
        Buffer.from('PDF'),
        { mimeType: 'application/pdf', typeSlug: 'document' },
      );

      await runtime.setExtractionStatus(source, 'failed', {
        error: 'pdf parse error',
      });

      const parsed = JSON.parse(source.description);
      expect(parsed.extractionStatus).toBe('failed');
      expect(parsed.extractionError).toBe('pdf parse error');
      expect(parsed.extractedAt).toBeUndefined();
    });
  });
});
