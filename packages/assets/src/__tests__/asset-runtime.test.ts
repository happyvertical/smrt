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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Asset } from '../asset';
import { AssetAssociationCollection } from '../asset-associations';
import { AssetCapabilitySkippedError } from '../asset-capabilities';
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

    it('passes store options through to the underlying AssetStore', async () => {
      const resolver = vi.fn(async (request) =>
        request.operation === 'write'
          ? { path: `resolved/${request.path}` }
          : undefined,
      );
      const runtime = await createAssetRuntime({
        db,
        storage: storageDir,
        storeOptions: { resolver },
      });

      const asset = await runtime.storeSourceAsset(
        'resolved-notes.txt',
        Buffer.from('routed through factory'),
        { mimeType: 'text/plain', typeSlug: 'document' },
      );

      expect(resolver).toHaveBeenCalledWith(
        expect.objectContaining({
          operation: 'write',
          path: `document/${asset.id}.txt`,
        }),
      );
      expect(asset.sourceUri).toBe(
        `file://${storageDir}/resolved/document/${asset.id}.txt`,
      );
      await expect(runtime.store.read(asset)).resolves.toEqual(
        Buffer.from('routed through factory'),
      );
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

  describe('capability providers', () => {
    it('routes processing, variants, search, sync, and workflows through registered providers', async () => {
      const provider = {
        name: 'test-provider',
        processAsset: vi.fn(async ({ asset }) => ({
          asset,
          metadata: { ok: true },
        })),
        ensureVariant: vi.fn(async ({ asset, request }) => ({
          asset,
          variant: request.variant,
          source: 'cached' as const,
        })),
        searchNearbyAssets: vi.fn(async () => ({
          items: [{ assetId: 'asset-1', origin: 'test' }],
          nextCursor: null,
        })),
        syncExternalAsset: vi.fn(async ({ asset }) => ({
          asset,
          provider: 'test-provider',
          status: 'ready' as const,
          externalAssetId: 'external-1',
        })),
        submitAssetWorkflow: vi.fn(async () => ({
          provider: 'test-provider',
          jobId: 'job-1',
          status: 'queued',
        })),
      };
      const runtime = await createAssetRuntime({
        db,
        storage: storageDir,
        capabilityProviders: [provider],
      });
      const asset = await runtime.storeSourceAsset(
        'image.jpg',
        Buffer.from('jpg'),
        {
          mimeType: 'image/jpeg',
          typeSlug: 'image',
        },
      );

      await expect(runtime.processAsset(asset)).resolves.toMatchObject({
        metadata: { ok: true },
      });
      await expect(
        runtime.ensureVariant(asset, { variant: 'thumb' }),
      ).resolves.toMatchObject({ variant: 'thumb', source: 'cached' });
      await expect(
        runtime.searchNearbyAssets({ latitude: 1, longitude: 2 }),
      ).resolves.toMatchObject({ items: [{ assetId: 'asset-1' }] });
      await expect(runtime.syncExternalAsset(asset)).resolves.toMatchObject({
        provider: 'test-provider',
        externalAssetId: 'external-1',
      });
      await expect(
        runtime.submitAssetWorkflow(asset, { workflowSlug: 'image.generate' }),
      ).resolves.toMatchObject({ jobId: 'job-1' });

      expect(provider.processAsset).toHaveBeenCalledWith(
        expect.objectContaining({
          runtime,
          asset,
        }),
      );
      expect(provider.ensureVariant).toHaveBeenCalledWith(
        expect.objectContaining({
          runtime,
          asset,
          request: { variant: 'thumb' },
        }),
      );
    });

    it('fails clearly when a capability has no registered provider', async () => {
      const runtime = await createAssetRuntime({ db, storage: storageDir });
      const asset = await runtime.storeSourceAsset(
        'image.jpg',
        Buffer.from('jpg'),
        {
          mimeType: 'image/jpeg',
          typeSlug: 'image',
        },
      );

      await expect(
        runtime.ensureVariant(asset, { variant: 'thumb' }),
      ).rejects.toThrow(/No asset capability provider/);
    });

    it('falls through providers that explicitly skip a capability', async () => {
      const skippedProvider = {
        name: 'skip-images',
        processAsset: vi.fn(async () => {
          throw new AssetCapabilitySkippedError(
            'processAsset',
            'skip this asset',
          );
        }),
      };
      const fallbackProvider = {
        name: 'fallback',
        processAsset: vi.fn(async ({ asset }) => ({
          asset,
          metadata: { provider: 'fallback' },
        })),
      };
      const runtime = await createAssetRuntime({
        db,
        storage: storageDir,
        capabilityProviders: [skippedProvider, fallbackProvider],
      });
      const asset = await runtime.storeSourceAsset(
        'audio.wav',
        Buffer.from('wav'),
        {
          mimeType: 'audio/wav',
          typeSlug: 'audio',
        },
      );

      await expect(runtime.processAsset(asset)).resolves.toMatchObject({
        metadata: { provider: 'fallback' },
      });
      expect(skippedProvider.processAsset).toHaveBeenCalled();
      expect(fallbackProvider.processAsset).toHaveBeenCalled();
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
      // metaType describes the derivative object (target of metaId),
      // not the source. Default is 'Asset'.
      expect(links[0].metaType).toBe('Asset');
    });

    it('records derivativeMetaType on the association for STI subtypes', async () => {
      const runtime = await createAssetRuntime({ db, storage: storageDir });
      const source = await runtime.storeSourceAsset(
        'agenda.pdf',
        Buffer.from('PDF'),
        { mimeType: 'application/pdf', typeSlug: 'document' },
      );

      const derived = await runtime.storeDerivedAsset(
        source,
        'agenda-page-1.png',
        Buffer.from('PNG'),
        {
          mimeType: 'image/png',
          typeSlug: 'image',
          role: ASSET_ROLES.DOCUMENT_IMAGE,
          derivativeMetaType: 'Image',
        },
      );

      const links = await runtime.associations.getForAsset(source.id!);
      expect(links).toHaveLength(1);
      expect(links[0].metaId).toBe(derived.id);
      expect(links[0].metaType).toBe('Image');
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
        derivativeMetaType: 'Image',
      });

      expect(link.assetId).toBe(source.id);
      expect(link.metaId).toBe(derivative.id);
      expect(link.role).toBe('document_image');
      expect(link.metaType).toBe('Image');
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

    it('clears a stale extractionError when transitioning out of failed', async () => {
      const runtime = await createAssetRuntime({ db, storage: storageDir });
      const source = await runtime.storeSourceAsset(
        'agenda.pdf',
        Buffer.from('PDF'),
        { mimeType: 'application/pdf', typeSlug: 'document' },
      );

      await runtime.setExtractionStatus(source, 'failed', {
        error: 'pdf parse error',
      });
      expect(JSON.parse(source.description).extractionError).toBe(
        'pdf parse error',
      );

      await runtime.setExtractionStatus(source, 'running');
      const afterRetry = JSON.parse(source.description);
      expect(afterRetry.extractionStatus).toBe('running');
      expect(afterRetry.extractionError).toBeUndefined();

      await runtime.setExtractionStatus(source, 'succeeded');
      const afterSuccess = JSON.parse(source.description);
      expect(afterSuccess.extractionStatus).toBe('succeeded');
      expect(afterSuccess.extractionError).toBeUndefined();
      expect(typeof afterSuccess.extractedAt).toBe('string');
    });

    it('preserves a caller-provided error on repeated failures', async () => {
      const runtime = await createAssetRuntime({ db, storage: storageDir });
      const source = await runtime.storeSourceAsset(
        'agenda.pdf',
        Buffer.from('PDF'),
        { mimeType: 'application/pdf', typeSlug: 'document' },
      );

      await runtime.setExtractionStatus(source, 'failed', { error: 'first' });
      await runtime.setExtractionStatus(source, 'failed', { error: 'second' });

      const parsed = JSON.parse(source.description);
      expect(parsed.extractionError).toBe('second');
    });

    it('preserves free-form description prose under the text key', async () => {
      const runtime = await createAssetRuntime({ db, storage: storageDir });
      const source = await runtime.storeSourceAsset(
        'agenda.pdf',
        Buffer.from('PDF'),
        {
          mimeType: 'application/pdf',
          typeSlug: 'document',
          description: 'City council agenda, regular session, 2026-04-16',
        },
      );
      expect(source.description).toBe(
        'City council agenda, regular session, 2026-04-16',
      );

      await runtime.setExtractionStatus(source, 'running');

      const parsed = JSON.parse(source.description);
      expect(parsed.extractionStatus).toBe('running');
      expect(parsed.text).toBe(
        'City council agenda, regular session, 2026-04-16',
      );

      // A subsequent update should keep the prose around too.
      await runtime.setExtractionStatus(source, 'succeeded');
      const afterSuccess = JSON.parse(source.description);
      expect(afterSuccess.extractionStatus).toBe('succeeded');
      expect(afterSuccess.text).toBe(
        'City council agenda, regular session, 2026-04-16',
      );
    });

    it('leaves an existing JSON object description intact apart from extraction keys', async () => {
      const runtime = await createAssetRuntime({ db, storage: storageDir });
      const source = await runtime.storeSourceAsset(
        'agenda.pdf',
        Buffer.from('PDF'),
        {
          mimeType: 'application/pdf',
          typeSlug: 'document',
          description: JSON.stringify({ author: 'city-clerk', pageCount: 42 }),
        },
      );

      await runtime.setExtractionStatus(source, 'succeeded');

      const parsed = JSON.parse(source.description);
      expect(parsed.author).toBe('city-clerk');
      expect(parsed.pageCount).toBe(42);
      expect(parsed.extractionStatus).toBe('succeeded');
    });
  });
});
