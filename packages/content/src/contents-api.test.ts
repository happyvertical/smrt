import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Content } from './content';
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

vi.mock('$lib/server/smrt', () => {
  return {
    getCollection: async () => {
      const { Contents: LocalContents } = require('./contents');
      return new LocalContents({ tenantId: 'test-tenant' });
    },
  };
});

// Mock SvelteKit json as just a plain Response
vi.mock('@sveltejs/kit', () => {
  return {
    json: (data: any, init?: any) => {
      return new Response(JSON.stringify(data), {
        status: init?.status || 200,
        headers: { 'Content-Type': 'application/json' },
      });
    },
  };
});

describe('Content API Endpoints', () => {
  let db: DatabaseInterface;
  let mockLocals: any;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    // Make sure tables are created
    await new Content({
      name: 'init',
      title: 'init',
      body: 'init',
      db,
    }).initialize();

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
      expect(data.data.title).toBe('My First Post');
      expect(data.data.tenantId).toBe('test-tenant');
      expect(data.data.id).toBeDefined();
    });

    it('creates content and links references', async () => {
      // Create a reference raw
      const ref1 = new Content({ title: 'Ref 1', tenantId: 'test-tenant', db });
      await ref1.initialize();
      await ref1.save();

      const payload = {
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
        params: { id: data.data.id },
        locals: mockLocals,
      });
      const getData = await unwrapJson(getRes);

      expect(getData.data.referenceIds).toContain(ref1.id);
    });
  });

  describe('GET /api/v1/contents', () => {
    it('lists contents', async () => {
      const c1 = new Content({
        title: 'Post A',
        status: 'published',
        tenantId: 'test-tenant',
        db,
      });
      const c2 = new Content({
        title: 'Post B',
        status: 'draft',
        tenantId: 'test-tenant',
        db,
      });
      await c1.initialize();
      await c1.save();
      await c2.initialize();
      await c2.save();

      const req = currentRequest({}, { status: 'published' });
      const res = await getList({
        request: req as any,
        locals: mockLocals,
        url: req.url as any,
      });
      const data = await unwrapJson(res);

      expect(data.data.length).toBe(1);
      expect(data.data[0].title).toBe('Post A');
      expect(data.count).toBe(1);
    });
  });

  describe('GET /api/v1/contents/[id]', () => {
    it('retrieves single content with references', async () => {
      const ref = new Content({ title: 'A ref', db });
      await ref.initialize();
      await ref.save();

      const main = new Content({ title: 'Main', tenantId: 'test-tenant', db });
      await main.initialize();
      await main.save();
      await main.addReference(ref);

      const res = await getSingle({
        params: { id: main.id },
        locals: mockLocals,
      });
      const data = await unwrapJson(res);

      expect(data.data.title).toBe('Main');
      expect(data.data.referenceIds).toBeDefined();
      expect(data.data.referenceIds.length).toBe(1);
      expect(data.data.referenceIds[0]).toBe(ref.id);
    });

    it('returns 404 for missing content', async () => {
      const res = await getSingle({
        params: { id: 'missing' },
        locals: mockLocals,
      });
      expect(res.status).toBe(404);
    });
  });

  describe('PUT /api/v1/contents/[id]', () => {
    it('updates content properties and syncs references', async () => {
      const ref1 = new Content({ title: 'Ref 1', db });
      const ref2 = new Content({ title: 'Ref 2', db });
      await ref1.initialize();
      await ref1.save();
      await ref2.initialize();
      await ref2.save();

      const main = new Content({
        title: 'Old Title',
        tenantId: 'test-tenant',
        db,
      });
      await main.initialize();
      await main.save();
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

      expect(data.data.title).toBe('New Title');
      expect(data.data.referenceIds).toContain(ref2.id);
      expect(data.data.referenceIds).not.toContain(ref1.id);
    });
  });

  describe('DELETE /api/v1/contents/[id]', () => {
    it('deletes content', async () => {
      const main = new Content({
        title: 'To Delete',
        tenantId: 'test-tenant',
        db,
      });
      await main.initialize();
      await main.save();

      const res = await deleteContent({
        params: { id: main.id },
        locals: mockLocals,
      });
      const data = await unwrapJson(res);

      expect(data.success).toBe(true);

      // confirm 404
      const getRes = await getSingle({
        params: { id: main.id },
        locals: mockLocals,
      });
      expect(getRes.status).toBe(404);
    });
  });
});
