/**
 * asset-serving tests
 *
 * Exercises the generic serving contract end-to-end with an in-memory
 * SQLite DB and a real temp-directory asset store.
 */

import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join as pathJoin } from 'node:path';
import { getTestDatabase } from '@happyvertical/smrt-core/testing';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type AssetRuntime, createAssetRuntime } from '../asset-runtime';
import {
  AssetServeError,
  resolveAssetForServing,
  serveAsset,
} from '../asset-serving';

describe('serveAsset', () => {
  let db: DatabaseInterface;
  let storageDir: string;
  let runtime: AssetRuntime;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    storageDir = mkdtempSync(pathJoin(tmpdir(), 'asset-serving-'));
    runtime = await createAssetRuntime({ db, storage: storageDir });
  });

  afterEach(async () => {
    if (db && typeof db.close === 'function') {
      await db.close();
    }
    if (storageDir && existsSync(storageDir)) {
      rmSync(storageDir, { recursive: true, force: true });
    }
  });

  it('returns 200 with bytes, content-type, and content-disposition', async () => {
    const asset = await runtime.storeSourceAsset(
      'hello.txt',
      Buffer.from('hello'),
      { mimeType: 'text/plain', typeSlug: 'document' },
    );

    const response = await serveAsset({ runtime, asset: asset.id! });

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('text/plain');
    expect(response.headers.get('content-length')).toBe('5');
    const disposition = response.headers.get('content-disposition') ?? '';
    expect(disposition.startsWith('inline;')).toBe(true);
    expect(disposition).toContain('hello.txt');

    const body = Buffer.from(await response.arrayBuffer());
    expect(body.toString()).toBe('hello');
  });

  it('uses attachment disposition when requested', async () => {
    const asset = await runtime.storeSourceAsset(
      'report.pdf',
      Buffer.from('PDF'),
      { mimeType: 'application/pdf', typeSlug: 'document' },
    );

    const response = await serveAsset({
      runtime,
      asset,
      disposition: 'attachment',
    });

    expect(response.headers.get('content-disposition')).toMatch(/^attachment;/);
  });

  it('returns 404 when the asset id does not resolve', async () => {
    const response = await serveAsset({ runtime, asset: 'missing-id' });
    expect(response.status).toBe(404);
  });

  it('returns 403 when tenantId mismatches', async () => {
    const asset = await runtime.storeSourceAsset(
      'secret.txt',
      Buffer.from('secret'),
      { mimeType: 'text/plain', typeSlug: 'document' },
    );
    asset.tenantId = 'tenant-a';
    await asset.save();

    const response = await serveAsset({
      runtime,
      asset: asset.id!,
      tenantId: 'tenant-b',
    });

    expect(response.status).toBe(403);
  });

  it('allows global (tenantId=null) assets through a tenant check', async () => {
    const asset = await runtime.storeSourceAsset(
      'public.txt',
      Buffer.from('pub'),
      { mimeType: 'text/plain', typeSlug: 'document' },
    );

    const response = await serveAsset({
      runtime,
      asset: asset.id!,
      tenantId: 'tenant-a',
    });

    expect(response.status).toBe(200);
  });

  it('runs the custom canAccess hook after tenant checks', async () => {
    const asset = await runtime.storeSourceAsset(
      'guarded.txt',
      Buffer.from('x'),
      { mimeType: 'text/plain', typeSlug: 'document' },
    );

    const response = await serveAsset({
      runtime,
      asset: asset.id!,
      canAccess: () => false,
    });

    expect(response.status).toBe(403);
  });

  describe('resolveAssetForServing', () => {
    it('throws AssetServeError(404) for unknown ids', async () => {
      await expect(
        resolveAssetForServing({ runtime, asset: 'nope' }),
      ).rejects.toMatchObject({
        name: 'AssetServeError',
        status: 404,
      });
    });

    it('returns bytes + metadata for authorised callers', async () => {
      const asset = await runtime.storeSourceAsset(
        'ok.txt',
        Buffer.from('ok'),
        { mimeType: 'text/plain', typeSlug: 'document' },
      );

      const resolved = await resolveAssetForServing({
        runtime,
        asset: asset.id!,
      });

      expect(resolved.asset.id).toBe(asset.id);
      expect(resolved.data.toString()).toBe('ok');
      expect(resolved.contentType).toBe('text/plain');
      expect(resolved.size).toBe(2);
    });

    it('surfaces 500 errors from the store as AssetServeError', async () => {
      const asset = await runtime.storeSourceAsset(
        'broken.txt',
        Buffer.from('bytes'),
        { mimeType: 'text/plain', typeSlug: 'document' },
      );
      // Force the store to fail by pointing at a missing file
      asset.sourceUri = 'file:///definitely/not/real/path.txt';
      await asset.save();

      await expect(
        resolveAssetForServing({ runtime, asset: asset.id! }),
      ).rejects.toBeInstanceOf(AssetServeError);
    });
  });
});
