import { getTestDatabase } from '@happyvertical/smrt-core';
import type { DatabaseInterface } from '@happyvertical/sql';
import { syncSchema } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { Contents } from './contents';

const CONTENT_REFERENCES_SCHEMA = `
CREATE TABLE IF NOT EXISTS content_references (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  source_id TEXT,
  target_id TEXT
);
CREATE INDEX IF NOT EXISTS content_references_id_idx ON content_references (id);
CREATE UNIQUE INDEX IF NOT EXISTS content_references_source_id_target_id_idx ON content_references (source_id, target_id);
`;

const CONTENT_VERSIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS content_versions (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  content_id TEXT,
  version INTEGER NOT NULL DEFAULT 1,
  kind TEXT DEFAULT 'manual',
  title TEXT,
  description TEXT,
  body TEXT,
  status TEXT,
  summary TEXT,
  snapshot TEXT,
  metadata TEXT,
  tenant_id TEXT
);
CREATE INDEX IF NOT EXISTS content_versions_id_idx ON content_versions (id);
CREATE UNIQUE INDEX IF NOT EXISTS content_versions_content_id_version_idx ON content_versions (content_id, version);
`;

const CONTENT_REVIEWS_SCHEMA = `
CREATE TABLE IF NOT EXISTS content_reviews (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  content_id TEXT,
  content_version_id TEXT,
  kind TEXT,
  policy_key TEXT,
  status TEXT,
  summary TEXT,
  findings TEXT,
  reviewer TEXT,
  metadata TEXT,
  tenant_id TEXT
);
CREATE INDEX IF NOT EXISTS content_reviews_id_idx ON content_reviews (id);
`;

const CONTENT_CORRECTIONS_SCHEMA = `
CREATE TABLE IF NOT EXISTS content_corrections (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  content_id TEXT,
  content_version_id TEXT,
  fact_id TEXT,
  replacement_fact_id TEXT,
  correction_type TEXT,
  status TEXT,
  summary TEXT,
  incorrect_text TEXT,
  corrected_text TEXT,
  public_note TEXT,
  metadata TEXT,
  tenant_id TEXT,
  published_at DATETIME
);
CREATE INDEX IF NOT EXISTS content_corrections_id_idx ON content_corrections (id);
`;

describe('Contents', () => {
  let db: DatabaseInterface;
  let contents: Contents;

  beforeEach(async () => {
    db = await getTestDatabase({ type: 'sqlite', url: ':memory:' });
    contents = await Contents.create({
      tenantId: 'test-tenant',
      db,
    });
    await syncSchema({ db, schema: CONTENT_REFERENCES_SCHEMA });
    await syncSchema({ db, schema: CONTENT_VERSIONS_SCHEMA });
    await syncSchema({ db, schema: CONTENT_REVIEWS_SCHEMA });
    await syncSchema({ db, schema: CONTENT_CORRECTIONS_SCHEMA });
  });

  afterEach(async () => {
    if (db && typeof (db as any).close === 'function') {
      await (db as any).close();
    }
  });

  it('looks up published content by slug', async () => {
    const created = await contents.create({
      name: 'Bridge update',
      title: 'Bridge update',
      slug: 'bridge-update',
      status: 'published',
      tenantId: 'test-tenant',
    } as any);

    const result = await contents.getBySlug({
      slug: created.slug,
      status: 'published',
    });

    expect(result).toMatchObject({
      id: created.id,
      slug: 'bridge-update',
      status: 'published',
      title: 'Bridge update',
    });
  });

  it('returns null when the status filter does not match', async () => {
    await contents.create({
      name: 'Draft bridge update',
      title: 'Draft bridge update',
      slug: 'draft-bridge-update',
      status: 'draft',
      tenantId: 'test-tenant',
    } as any);

    const result = await contents.getBySlug({
      slug: 'draft-bridge-update',
      status: 'published',
    });

    expect(result).toBeNull();
  });
});
