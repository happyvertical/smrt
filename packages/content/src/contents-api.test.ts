import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { syncSchema } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Contents } from './contents';
import {
  POST as createContent,
  GET as getList,
} from './routes/api/v1/contents/+server';
import {
  DELETE as deleteContent,
  GET as getSingle,
  PUT as updateContent,
} from './routes/api/v1/contents/[id]/+server';

let currentContents: Contents | undefined;

const CONTENT_REFERENCES_SCHEMA = `
CREATE TABLE IF NOT EXISTS content_references (
  id TEXT PRIMARY KEY,
  slug TEXT NOT NULL,
  context TEXT NOT NULL,
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  source_id TEXT,
  target_id TEXT
);
CREATE INDEX IF NOT EXISTS content_references_id_idx ON content_references (id);
CREATE UNIQUE INDEX IF NOT EXISTS content_references_source_id_target_id_idx ON content_references (source_id, target_id);
`;

vi.mock('$lib/server/smrt', () => {
  return {
    getCollection: async () => {
      if (!currentContents) {
        throw new Error('Test collection not initialized');
      }

      return currentContents;
    },
  };
});

vi.mock('$lib/server/seed-contents', () => ({
  seedContents: async () => {},
}));

vi.mock('$lib/server/seed-images', () => ({
  seedImages: async () => {},
}));

// Mock SvelteKit json as just a plain Response
vi.mock('@sveltejs/kit', () => {
  return {
    json: (data: any, init?: any) => {
      return new Response(JSON.stringify(data), {
        status: init?.status || 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
    error: (status: number, body?: any) =>
      Object.assign(
        new Error(typeof body === 'string' ? body : body?.message || 'Error'),
        {
          status,
          body,
        },
      ),
  };
});

describe('Content API Endpoints', () => {
  let db: DatabaseInterface;
  let mockLocals: any;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    currentContents = await Contents.create({
      tenantId: 'test-tenant',
      db,
    });
    await syncSchema({ db, schema: CONTENT_REFERENCES_SCHEMA });

    mockLocals = {
      tenantId: 'test-tenant',
      profileId: 'test-user',
      // We pass the global test db down through a mocked context or expect getSmrtClient to pick up the global test registry
    };
  });

  afterEach(async () => {
    if (db && typeof (db as any).close === 'function') {
      await (db as any).close();
    }

    currentContents = undefined;
  });

  // Helper to create mock Request for endpoints
  function currentRequest(
    body?: any,
    searchParams: Record<string, string> = {},
  ) {
    const url = new URL('http://localhost');
    for (const [k, v] of Object.entries(searchParams)) {
      url.searchParams.set(k, v);
    }
    return {
      url,
      json: async () => body,
    };
  }

  // Helper to unwrap standard SvelteKit json() response
  async function unwrapJson(res: Response) {
    return res.json();
  }

  describe('POST /api/v1/contents', () => {
    it('creates a new content item', async () => {
      const payload = {
        name: 'my-first-post',
        title: 'My First Post',
        body: 'Hello World',
        type: 'article',
        status: 'draft',
      };

      const req = currentRequest(payload);
      const res = await createContent({
        request: req as any,
        locals: mockLocals,
      });
      const data = await unwrapJson(res);

      expect(res.status).toBe(201);
      expect(data.title).toBe('My First Post');
      expect(data.id).toBeDefined();
    });

    it('creates content and links references', async () => {
      // Create a reference raw
      const ref1 = await currentContents?.create({
        name: 'Ref 1',
        title: 'Ref 1',
        tenantId: 'test-tenant',
      });

      const payload = {
        name: 'post-with-refs',
        title: 'Post with Refs',
        body: 'See references.',
        referenceIds: [ref1.id],
      };

      const req = currentRequest(payload);
      const res = await createContent({
        request: req as any,
        locals: mockLocals,
      });
      const data = await unwrapJson(res);

      expect(res.status).toBe(201);

      // Verify via GET
      const getRes = await getSingle({
        params: { id: data.id },
        locals: mockLocals,
      });
      const getData = await unwrapJson(getRes);

      expect(getData.referenceIds).toContain(ref1.id);
    });
  });

  describe('GET /api/v1/contents', () => {
    it('lists contents', async () => {
      await currentContents?.create({
        name: 'Post A',
        title: 'Post A',
        status: 'published',
        tenantId: 'test-tenant',
      });
      await currentContents?.create({
        name: 'Post B',
        title: 'Post B',
        status: 'draft',
        tenantId: 'test-tenant',
      });

      const req = currentRequest();
      const res = await getList({
        request: req as any,
        locals: mockLocals,
        url: req.url as any,
      });
      const data = await unwrapJson(res);

      expect(data.items).toHaveLength(2);
      expect(data.items.map((item: any) => item.title)).toEqual(
        expect.arrayContaining(['Post A', 'Post B']),
      );
      expect(data.count).toBe(2);
    });
  });

  describe('GET /api/v1/contents/[id]', () => {
    it('retrieves single content with references', async () => {
      const ref = await currentContents?.create({
        name: 'A ref',
        title: 'A ref',
      });

      const main = await currentContents?.create({
        name: 'Main',
        title: 'Main',
        tenantId: 'test-tenant',
      });
      await main.addReference(ref);

      const res = await getSingle({
        params: { id: main.id },
        locals: mockLocals,
      });
      const data = await unwrapJson(res);

      expect(data.title).toBe('Main');
      expect(data.referenceIds).toBeDefined();
      expect(data.referenceIds.length).toBe(1);
      expect(data.referenceIds[0]).toBe(ref.id);
      expect(data.references).toHaveLength(1);
      expect(data.references[0].id).toBe(ref.id);
      expect(data.references[0].title).toBe('A ref');
    });

    it('returns 404 for missing content', async () => {
      await expect(
        getSingle({
          params: { id: 'missing' },
          locals: mockLocals,
        }),
      ).rejects.toMatchObject({
        status: 404,
      });
    });
  });

  describe('PUT /api/v1/contents/[id]', () => {
    it('updates content properties and syncs references', async () => {
      const ref1 = await currentContents?.create({
        name: 'Ref 1',
        title: 'Ref 1',
      });
      const ref2 = await currentContents?.create({
        name: 'Ref 2',
        title: 'Ref 2',
      });

      const main = await currentContents?.create({
        name: 'Old Title',
        title: 'Old Title',
        tenantId: 'test-tenant',
      });
      await main.addReference(ref1);

      const payload = {
        title: 'New Title',
        referenceIds: [ref2.id], // Drop ref1, add ref2
      };

      const req = currentRequest(payload);
      const res = await updateContent({
        params: { id: main.id },
        request: req as any,
        locals: mockLocals,
      });
      const data = await unwrapJson(res);

      expect(data.title).toBe('New Title');
      expect(data.referenceIds).toContain(ref2.id);
      expect(data.referenceIds).not.toContain(ref1.id);
    });
  });

  describe('DELETE /api/v1/contents/[id]', () => {
    it('deletes content', async () => {
      const main = await currentContents?.create({
        name: 'To Delete',
        title: 'To Delete',
        tenantId: 'test-tenant',
      });

      const res = await deleteContent({
        params: { id: main.id },
        locals: mockLocals,
      });
      const data = await unwrapJson(res);

      expect(data.success).toBe(true);

      // confirm 404
      await expect(
        getSingle({
          params: { id: main.id },
          locals: mockLocals,
        }),
      ).rejects.toMatchObject({
        status: 404,
      });
    });
  });
});
