-- migrations/0001_feed_sources.sql
-- @id: 0001_feed_sources
-- @description: Add content feed source imports and mirror attribution columns

-- @up
CREATE TABLE IF NOT EXISTS content_feed_sources (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
  updated_at TIMESTAMP NOT NULL DEFAULT current_timestamp,
  tenant_id TEXT,
  name TEXT NOT NULL,
  feed_url TEXT NOT NULL,
  homepage_url TEXT,
  format TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  default_category TEXT,
  source_group TEXT,
  poll_interval_minutes INTEGER NOT NULL DEFAULT 15,
  etag TEXT,
  last_modified TEXT,
  last_fetched_at TIMESTAMP,
  last_success_at TIMESTAMP,
  last_error TEXT,
  metadata JSON DEFAULT '{}'
);
CREATE INDEX IF NOT EXISTS content_feed_sources_id_idx ON content_feed_sources(id);
CREATE UNIQUE INDEX IF NOT EXISTS content_feed_sources_tenant_id_feed_url_idx ON content_feed_sources(tenant_id, feed_url);

ALTER TABLE contents ADD COLUMN feed_source_id TEXT;
ALTER TABLE contents ADD COLUMN source_guid TEXT;
ALTER TABLE contents ADD COLUMN source_name TEXT;
ALTER TABLE contents ADD COLUMN source_homepage_url TEXT;
ALTER TABLE contents ADD COLUMN external_url TEXT;
ALTER TABLE contents ADD COLUMN original_published_at TIMESTAMP;
ALTER TABLE contents ADD COLUMN dedupe_key TEXT;

-- @down
ALTER TABLE contents DROP COLUMN dedupe_key;
ALTER TABLE contents DROP COLUMN original_published_at;
ALTER TABLE contents DROP COLUMN external_url;
ALTER TABLE contents DROP COLUMN source_homepage_url;
ALTER TABLE contents DROP COLUMN source_name;
ALTER TABLE contents DROP COLUMN source_guid;
ALTER TABLE contents DROP COLUMN feed_source_id;
DROP INDEX IF EXISTS content_feed_sources_tenant_id_feed_url_idx;
DROP INDEX IF EXISTS content_feed_sources_id_idx;
DROP TABLE IF EXISTS content_feed_sources;
