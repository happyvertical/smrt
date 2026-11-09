import { randomBytes } from 'node:crypto';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FilesystemInterface } from '@happyvertical/files';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { resolvePolicy } from '../config.js';
import { accountHandle, sha256Hex } from '../encoding.js';
import { createRelayHttpServer } from '../node-server.js';
import {
  assertObjectKey,
  chunkObjectKey,
  FilesObjectStore,
  FilesystemObjectStore,
} from '../object-store.js';
import { loadServerConfig } from '../server.js';
import {
  createHarness,
  type Harness,
  leaseToken,
  newDevice,
  registerDevice,
  signed,
} from './helpers.js';

const UPLOAD = '3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b';
const OBJECT = '0123456789abcdef0123456789abcdef';

describe('object keys', () => {
  it('derives keys only from the account hash, upload id, index, and attempt id', () => {
    const handle = accountHandle('acct-a');
    expect(chunkObjectKey(handle, UPLOAD, 7, OBJECT)).toBe(
      `v1/${handle}/${UPLOAD}/7.${OBJECT}`,
    );
    expect(handle).not.toContain('acct-a');
  });

  it.each([
    '../etc/passwd',
    `v1/${'a'.repeat(64)}/../../x/0`,
    `v1/${'a'.repeat(64)}/${UPLOAD}/../0`,
    `v1/${'a'.repeat(64)}/${UPLOAD}/01`,
    `/v1/${'a'.repeat(64)}/${UPLOAD}/0`,
    `v1/${'A'.repeat(64)}/${UPLOAD}/0`,
    `v1/${'a'.repeat(64)}/${UPLOAD}/0/extra`,
    `v1/${'a'.repeat(64)}/${UPLOAD}/0`,
    `v1/${'a'.repeat(64)}/${UPLOAD}/0.${OBJECT}/../x`,
    `v1\\${'a'.repeat(64)}\\${UPLOAD}\\0`,
  ])('rejects the hostile key %s', (key) => {
    expect(() => assertObjectKey(key)).toThrow('invalid object key');
  });

  it('rejects path segments in identifiers before they reach a key', () => {
    expect(() => chunkObjectKey('../../x', UPLOAD, 0, OBJECT)).toThrow();
    expect(() =>
      chunkObjectKey(accountHandle('a'), '../x', 0, OBJECT),
    ).toThrow();
    expect(() =>
      chunkObjectKey(accountHandle('a'), UPLOAD, 0, '../x'),
    ).toThrow();
  });
});

describe('FilesystemObjectStore', () => {
  let root: string;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'vault-store-'));
  });
  afterEach(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it('writes atomically, reads back, and deletes', async () => {
    const store = new FilesystemObjectStore(root);
    const key = chunkObjectKey(accountHandle('a'), UPLOAD, 0, OBJECT);
    const data = new Uint8Array(randomBytes(1000));
    await store.put(key, data);
    expect(Buffer.from((await store.get(key)) ?? [])).toEqual(
      Buffer.from(data),
    );
    const entries = await readdir(root, { recursive: true });
    expect(entries.some((entry) => String(entry).includes('.tmp-'))).toBe(
      false,
    );
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
    await store.delete(key);
  });

  it('refuses keys outside the derived shape', async () => {
    const store = new FilesystemObjectStore(root);
    await expect(store.put('../escape', new Uint8Array(1))).rejects.toThrow();
    await expect(store.get('../escape')).rejects.toThrow();
  });
});

describe('FilesObjectStore (S3 adapter)', () => {
  function fakeFilesystem() {
    const objects = new Map<string, Buffer>();
    const notFound = Object.assign(new Error('missing'), {
      name: 'FileNotFoundError',
    });
    const fs = {
      async write(path: string, content: Buffer) {
        objects.set(path, Buffer.from(content));
      },
      async read(path: string) {
        const value = objects.get(path);
        if (!value) throw notFound;
        return value;
      },
      async delete(path: string) {
        if (!objects.delete(path)) throw notFound;
      },
      async exists(path: string) {
        return objects.has(path);
      },
    };
    return { objects, fs: fs as unknown as FilesystemInterface };
  }

  it('stores bytes under the validated key and maps missing objects to null', async () => {
    const { objects, fs } = fakeFilesystem();
    const store = new FilesObjectStore(fs);
    const key = chunkObjectKey(accountHandle('a'), UPLOAD, 3, OBJECT);
    await store.put(key, new Uint8Array([1, 2, 3]));
    expect([...objects.keys()]).toEqual([key]);
    expect([...((await store.get(key)) ?? [])]).toEqual([1, 2, 3]);
    await store.delete(key);
    await store.delete(key);
    expect(await store.get(key)).toBeNull();
    await store.check();
    await expect(store.put('../x', new Uint8Array(1))).rejects.toThrow();
  });
});

describe('policy and environment configuration', () => {
  const policy = {
    quota: { maxBytes: 100, maxSnapshots: 3 },
    retention: { keepLast: 2, keepWithinMs: 0 },
  };

  it('requires retention to leave room for one upload', () => {
    expect(() =>
      resolvePolicy({ ...policy, retention: { keepLast: 3, keepWithinMs: 0 } }),
    ).toThrow('keepLast');
  });

  it('caps the chunk bound and rejects non-integers', () => {
    expect(() =>
      resolvePolicy({ ...policy, limits: { maxChunkBytes: 65 * 1024 * 1024 } }),
    ).toThrow();
    expect(() =>
      resolvePolicy({ ...policy, quota: { maxBytes: 1.5, maxSnapshots: 3 } }),
    ).toThrow();
  });

  const env = {
    VAULT_RELAY_DATABASE_URL: 'postgres://relay@db/relay',
    VAULT_RELAY_ENTITLEMENTS_DATABASE_URL: 'postgres://relay@db/platform',
    VAULT_RELAY_STORAGE: 's3',
    VAULT_RELAY_S3_BUCKET: 'bucket',
    VAULT_RELAY_S3_ENDPOINT: 'http://garage:3900',
    VAULT_RELAY_S3_REGION: 'garage',
    VAULT_RELAY_S3_ACCESS_KEY_ID: 'id',
    VAULT_RELAY_S3_SECRET_ACCESS_KEY: 'super-secret-value',
    VAULT_RELAY_QUOTA_MAX_BYTES: '1000',
    VAULT_RELAY_QUOTA_MAX_SNAPSHOTS: '5',
    VAULT_RELAY_RETENTION_KEEP_LAST: '3',
    VAULT_RELAY_RETENTION_KEEP_WITHIN_DAYS: '30',
  };

  it('bounds the sequence step by default and reads an override', () => {
    expect(resolvePolicy(policy).limits.maxSequenceJump).toBe(1000);
    expect(
      loadServerConfig(env).policy.limits?.maxSequenceJump,
    ).toBeUndefined();
    expect(
      resolvePolicy(
        loadServerConfig({
          ...env,
          VAULT_RELAY_MAX_SEQUENCE_JUMP: '50',
        }).policy,
      ).limits.maxSequenceJump,
    ).toBe(50);
    for (const bad of ['-1', '1.5', 'many']) {
      expect(() =>
        loadServerConfig({ ...env, VAULT_RELAY_MAX_SEQUENCE_JUMP: bad }),
      ).toThrow();
    }
    // Zero would forbid every upload, so the policy refuses it.
    expect(() =>
      resolvePolicy(
        loadServerConfig({ ...env, VAULT_RELAY_MAX_SEQUENCE_JUMP: '0' }).policy,
      ),
    ).toThrow('maxSequenceJump');
  });

  it('reads a complete environment', () => {
    const config = loadServerConfig(env);
    expect(config.policy.retention.keepWithinMs).toBe(30 * 86_400_000);
    expect(config.port).toBe(8080);
    expect(config.adminToken).toBeUndefined();
  });

  it.each([
    'VAULT_RELAY_QUOTA_MAX_BYTES',
    'VAULT_RELAY_QUOTA_MAX_SNAPSHOTS',
    'VAULT_RELAY_RETENTION_KEEP_LAST',
    'VAULT_RELAY_RETENTION_KEEP_WITHIN_DAYS',
    'VAULT_RELAY_S3_BUCKET',
    'VAULT_RELAY_DATABASE_URL',
    'VAULT_RELAY_ENTITLEMENTS_DATABASE_URL',
  ])('has no default for the owner input %s', (name) => {
    const partial: Record<string, string | undefined> = { ...env };
    delete partial[name];
    expect(() => loadServerConfig(partial)).toThrow(`${name} is required`);
  });

  it('never echoes a configured value in an error', () => {
    try {
      loadServerConfig({
        ...env,
        VAULT_RELAY_QUOTA_MAX_BYTES: 'super-secret-value',
      });
      expect.unreachable();
    } catch (error) {
      expect(String(error)).not.toContain('super-secret-value');
    }
  });
});

describe('Node HTTP adapter', () => {
  let h: Harness;
  beforeEach(async () => {
    h = await createHarness();
  });
  afterEach(async () => {
    await h.close();
  });

  it('serves the device API over HTTP with body binding intact', async () => {
    const device = newDevice('acct-a', 'device-a1');
    await registerDevice(h, device);
    const server = createRelayHttpServer((request) => h.relay.handle(request));
    await new Promise<void>((resolve) =>
      server.listen(0, '127.0.0.1', resolve),
    );
    const { port } = server.address() as AddressInfo;
    try {
      const fencingToken = await leaseToken(h, device);
      const body = JSON.stringify({
        fencingToken,
        sequence: 1,
        byteSize: 5,
        chunkSize: 5,
        sha256: sha256Hex('hello'),
      });
      const begin = signed(h, device, 'POST', '/v1/uploads', { body });
      const response = await fetch(`http://127.0.0.1:${port}/v1/uploads`, {
        method: 'POST',
        headers: begin.headers,
        body,
      });
      expect(response.status).toBe(201);
      const { uploadId } = (await response.json()) as { uploadId: string };
      const put = signed(h, device, 'PUT', `/v1/uploads/${uploadId}/chunks/0`, {
        body: 'hello',
      });
      const stored = await fetch(
        `http://127.0.0.1:${port}/v1/uploads/${uploadId}/chunks/0`,
        { method: 'PUT', headers: put.headers, body: 'hello' },
      );
      expect(stored.status).toBe(200);
      // Bodiless POST and DELETE: clients send no Content-Length.
      const commit = signed(
        h,
        device,
        'POST',
        `/v1/uploads/${uploadId}/commit`,
      );
      const committed = await fetch(
        `http://127.0.0.1:${port}/v1/uploads/${uploadId}/commit`,
        { method: 'POST', headers: commit.headers },
      );
      expect(committed.status).toBe(201);
      const remove = signed(h, device, 'DELETE', '/v1/snapshots/1');
      const removed = await fetch(`http://127.0.0.1:${port}/v1/snapshots/1`, {
        method: 'DELETE',
        headers: remove.headers,
      });
      // The only committed snapshot is not removable from the device API.
      expect(removed.status).toBe(409);
      expect(await removed.json()).toMatchObject({ error: 'last_snapshot' });

      const second = JSON.stringify({
        fencingToken,
        sequence: 2,
        byteSize: 5,
        chunkSize: 5,
        sha256: sha256Hex('hello'),
      });
      const begun = await fetch(`http://127.0.0.1:${port}/v1/uploads`, {
        method: 'POST',
        headers: signed(h, device, 'POST', '/v1/uploads', { body: second })
          .headers,
        body: second,
      });
      const { uploadId: pending } = (await begun.json()) as {
        uploadId: string;
      };
      const abort = signed(h, device, 'DELETE', `/v1/uploads/${pending}`);
      const aborted = await fetch(
        `http://127.0.0.1:${port}/v1/uploads/${pending}`,
        { method: 'DELETE', headers: abort.headers },
      );
      expect(aborted.status).toBe(204);

      const health = await fetch(`http://127.0.0.1:${port}/healthz`);
      expect(health.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
});
