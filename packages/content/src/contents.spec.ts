import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { faker } from '@faker-js/faker';
import { getTestDatabase } from '@happyvertical/smrt-core';
import { ImageCollection } from '@happyvertical/smrt-images';
import { syncSchema } from '@happyvertical/sql';
import { makeSlug } from '@happyvertical/utils';
import { expect, it } from 'vitest';
import { ContentAssetCollection } from './content-assets';
import { Contents } from './contents';

const TMP_DIR = path.resolve(`${os.tmpdir()}/.have-sdk-tests/contents`);
fs.mkdirSync(TMP_DIR, { recursive: true });

/**
 * Creates a unique database URL for testing
 * Each test gets its own database file to avoid conflicts
 */
function getTestDbUrl(testName: string): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(7);
  return `file:${TMP_DIR}/${testName}-${timestamp}-${random}.db`;
}

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

const GOVERNANCE_POLICIES_SCHEMA = `
CREATE TABLE IF NOT EXISTS content_governance_policies (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  key TEXT NOT NULL,
  label TEXT,
  kind TEXT,
  instructions TEXT,
  enabled BOOLEAN,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS content_governance_policies_id_idx ON content_governance_policies (id);
CREATE UNIQUE INDEX IF NOT EXISTS content_governance_policies_key_idx ON content_governance_policies (key);
`;

const GOVERNANCE_PROFILES_SCHEMA = `
CREATE TABLE IF NOT EXISTS content_governance_profiles (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  key TEXT NOT NULL,
  label TEXT,
  description TEXT,
  enabled BOOLEAN,
  requirements TEXT,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS content_governance_profiles_id_idx ON content_governance_profiles (id);
CREATE UNIQUE INDEX IF NOT EXISTS content_governance_profiles_key_idx ON content_governance_profiles (key);
`;

const GOVERNANCE_ASSIGNMENTS_SCHEMA = `
CREATE TABLE IF NOT EXISTS content_governance_assignments (
  id TEXT PRIMARY KEY NOT NULL,
  slug TEXT NOT NULL,
  context TEXT NOT NULL DEFAULT '',
  created_at DATETIME NOT NULL,
  updated_at DATETIME NOT NULL,
  tenant_id TEXT,
  key TEXT NOT NULL,
  label TEXT,
  content_type TEXT NOT NULL,
  content_variant TEXT,
  enabled BOOLEAN,
  fact_linking_enabled BOOLEAN,
  transparency_enabled BOOLEAN,
  publication_profile_key TEXT,
  correction_profile_key TEXT,
  enforce_publish_readiness BOOLEAN,
  default_fact_relationship TEXT,
  metadata TEXT
);
CREATE INDEX IF NOT EXISTS content_governance_assignments_id_idx ON content_governance_assignments (id);
CREATE UNIQUE INDEX IF NOT EXISTS content_governance_assignments_key_idx ON content_governance_assignments (key);
`;

it('should persist bodyFormat and restore it from content versions', async () => {
  const db = await getTestDatabase({
    type: 'sqlite',
    url: getTestDbUrl('body-format'),
  });
  const contents = await Contents.create({
    db,
  });
  await syncSchema({ db, schema: CONTENT_VERSIONS_SCHEMA });
  await syncSchema({ db, schema: GOVERNANCE_POLICIES_SCHEMA });
  await syncSchema({ db, schema: GOVERNANCE_PROFILES_SCHEMA });
  await syncSchema({ db, schema: GOVERNANCE_ASSIGNMENTS_SCHEMA });

  const content = await contents.create({
    name: 'body-format',
    title: 'Body format',
    body: '<p>HTML body</p>',
    bodyFormat: 'html',
    status: 'draft',
  });

  const reloaded = await contents.get({ id: content.id });
  expect(reloaded?.bodyFormat).toBe('html');

  const version = await content.createVersion({ summary: 'Before markdown' });
  expect(version.getSnapshot().bodyFormat).toBe('html');

  content.body = 'Markdown body';
  content.bodyFormat = 'markdown';
  await content.save();
  await content.restoreFromVersion(version.version);

  expect(content.body).toBe('<p>HTML body</p>');
  expect(content.bodyFormat).toBe('html');
});

it.skipIf(!process.env.OPENAI_API_KEY)(
  'should be able to getOrInsert a content item',
  async () => {
    const contents = await Contents.create({
      ai: {
        type: 'openai',
        apiKey: process.env.OPENAI_API_KEY || 'test-key',
      },
      db: {
        url: getTestDbUrl('getOrInsert'),
      },
    });

    const fakeContentData = {
      title: faker.lorem.sentence(),
      body: faker.lorem.paragraph(),
      author: faker.person.fullName(),
      publish_date: faker.date.recent(),
    };

    const content = await contents.getOrUpsert(fakeContentData);
    expect(content.id).toBeDefined();

    const content2 = await contents.getOrUpsert(fakeContentData);
    expect(content2.id).toBe(content.id);

    const got = await contents.get({ id: content.id });
    expect(got?.id).toEqual(content.id);
  },
);

it.skipIf(!process.env.OPENAI_API_KEY)(
  'should respect the context of the slug',
  async () => {
    const contents = await Contents.create({
      ai: {
        type: 'openai',
        apiKey: process.env.OPENAI_API_KEY || 'test-key',
      },
      db: {
        url: getTestDbUrl('context-slug'),
      },
    });

    const fakeContentData = {
      title: faker.lorem.sentence(),
      body: faker.lorem.paragraph(),
      author: faker.person.fullName(),
      publish_date: faker.date.recent(),
    };

    const slug = makeSlug(fakeContentData.title);

    const content = await contents.getOrUpsert({
      ...fakeContentData,
      url: 'http://setinfirst.com',
      slug,
      context: 'contextA',
    });
    expect(content.id).toBeDefined();

    const different = await contents.getOrUpsert({
      ...fakeContentData,
      slug,
      context: 'contextB',
      source: 'set in different context',
    });
    expect(different.id).not.toBe(content.id);

    const contextA = await contents.get({
      slug,
      context: 'contextA',
    });

    const _contextB = await contents.get({
      slug,
      context: 'contextB',
    });

    const updated = await contents.getOrUpsert({
      description: 'foo',
      slug,
      context: 'contextA',
    });

    expect(updated.id).toBeDefined();
    expect(updated.description).toBe('foo');
    expect(updated.id).toBe(contextA?.id);
  },
);

// skipped because it takes a long time
it.skip('should be able to mirror a bit of content give a url', async () => {
  const contents = await Contents.create({
    ai: {
      type: 'openai',
      apiKey: process.env.OPENAI_API_KEY || 'test-key',
    },
    db: {
      url: getTestDbUrl('mirror-content'),
    },
  });

  const created = await contents.mirror({
    url: 'https://townofbentley.ca/wp-content/uploads/2024/12/Signed-Minutes-November-26-2024-Regular-Council-Meeting.pdf',
    mirrorDir: `${TMP_DIR}/mirror-test`,
  });
  expect(created?.id).toBeDefined();
}, 60000);

it.skip('should be able to sync a content dir', async () => {
  const contents = await Contents.create({
    ai: {
      type: 'openai',
      apiKey: process.env.OPENAI_API_KEY || 'test-key',
    },
    db: {
      url: getTestDbUrl('sync-content-dir'),
    },
    fs: {
      type: 'filesystem',
      cacheDir: `${TMP_DIR}/cache`,
    },
  });

  // for (let x = 0; x < 10; x++) {
  await contents.getOrUpsert({
    type: 'article',
    title: faker.lorem.sentence(),
    description: faker.lorem.sentence(),
    body: faker.lorem.paragraph(),
    author: faker.person.fullName(),
    publish_date: faker.date.recent(),
  });
  // }

  // await contents.syncContentDir({ contentDir: `${TMP_DIR}/content` });
});

it.skipIf(!process.env.OPENAI_API_KEY)(
  'should be able to list content',
  async () => {
    const contents = await Contents.create({
      ai: {
        type: 'openai',
        apiKey: process.env.OPENAI_API_KEY || 'test-key',
      },
      db: {
        url: getTestDbUrl('list-content'),
      },
    });

    const fakeContentData = {
      type: 'article',
      title: faker.lorem.sentence(),
      body: faker.lorem.paragraph(),
      author: faker.person.fullName(),
      publish_date: faker.date.recent(),
    };

    const content = await contents.getOrUpsert(fakeContentData);
    await content.save();

    const fakeContentData2 = {
      title: faker.lorem.sentence(),
      body: faker.lorem.paragraph(),
      author: faker.person.fullName(),
      publish_date: faker.date.recent(),
    };

    const content2 = await contents.getOrUpsert(fakeContentData2);
    await content2.save();

    const fakeContentData3 = {
      title: faker.lorem.sentence(),
      body: faker.lorem.paragraph(),
      author: faker.person.fullName(),
      publish_date: faker.date.recent(),
    };
    const content3 = await contents.getOrUpsert(fakeContentData3);
    await content3.save();

    expect(content.id).toBeDefined();

    // const content2 = await contents.getOrUpsert(fakeContentData);
    // expect(content2.id).toBe(content.id);

    const articles = await contents.list({
      where: {
        type: 'article',
      },
    });
    expect(articles?.length).toEqual(1);

    const articleCount = await contents.count({
      where: {
        type: 'article',
      },
    });
    expect(articleCount).toEqual(1);
  },
);

it.skipIf(!process.env.OPENAI_API_KEY)(
  'should support variant field for namespaced classification',
  async () => {
    const contents = await Contents.create({
      ai: {
        type: 'openai',
        apiKey: process.env.OPENAI_API_KEY || 'test-key',
      },
      db: {
        url: getTestDbUrl('variant-field'),
      },
    });

    // Test 1: Create content with variant
    const upcomingArticle = await contents.getOrUpsert({
      type: 'article',
      variant: 'praeco:meeting:upcoming',
      title: 'Upcoming Council Meeting',
      body: 'Meeting preview content',
      source: 'meeting-123',
    });

    expect(upcomingArticle.variant).toBe('praeco:meeting:upcoming');
    expect(upcomingArticle.id).toBeDefined();

    // Test 2: Create different variant for same meeting
    const summaryArticle = await contents.getOrUpsert({
      type: 'article',
      variant: 'praeco:meeting:summary',
      title: 'Council Meeting Summary',
      body: 'Meeting summary content',
      source: 'meeting-123',
    });

    expect(summaryArticle.variant).toBe('praeco:meeting:summary');
    expect(summaryArticle.id).not.toBe(upcomingArticle.id);

    // Test 3: Content without variant (null)
    const regularArticle = await contents.getOrUpsert({
      type: 'article',
      title: 'Regular Article',
      body: 'Regular content',
    });

    expect(regularArticle.variant).toBeNull();

    // Test 4: Query by specific variant
    const praecoSummaries = await contents.list({
      where: {
        type: 'article',
        variant: 'praeco:meeting:summary',
      },
    });

    expect(praecoSummaries?.length).toBe(1);
    expect(praecoSummaries?.[0]?.id).toBe(summaryArticle.id);

    // Test 5: toJSON includes variant
    const json = upcomingArticle.toJSON();
    expect(json.variant).toBe('praeco:meeting:upcoming');
  },
);

it('should return an empty asset list on a fresh database before any asset writes', async () => {
  const contents = await Contents.create({
    db: {
      url: getTestDbUrl('fresh-assets'),
    },
  });

  const content = await contents.create({
    name: 'Fresh asset lookup',
    title: 'Fresh asset lookup',
    body: 'No assets yet',
    status: 'draft',
  });

  const assets = await content.getAssets();
  expect(assets).toEqual([]);
});

it('should persist content assets via content_assets', async () => {
  const dbUrl = getTestDbUrl('persisted-assets');
  const contents = await Contents.create({
    db: {
      url: dbUrl,
    },
  });
  const images = await ImageCollection.create({
    db: {
      url: dbUrl,
    },
  });

  const content = await contents.create({
    name: 'asset-source',
    title: 'Asset source',
    body: 'Has one asset',
    status: 'draft',
  });
  const image = await images.create({
    name: 'asset-source.jpg',
    sourceUri: 'file:///tmp/asset-source.jpg',
    mimeType: 'image/jpeg',
    width: 1280,
    height: 720,
  });

  await content.addAsset(image, 'thumbnail', 3);

  const reloadedContents = await Contents.create({
    db: {
      url: dbUrl,
    },
  });
  const contentAssets = await ContentAssetCollection.create({
    db: {
      url: dbUrl,
    },
  });
  const reloaded = await reloadedContents.get({ id: content.id });
  const links = await contentAssets.getForContent(content.id as string);

  expect(reloaded).toBeTruthy();
  expect(links).toHaveLength(1);
  expect(links[0]?.assetId).toBe(image.id);
  expect(links[0]?.relationship).toBe('thumbnail');
  expect(links[0]?.sortOrder).toBe(3);

  const assets = await reloaded?.getAssets('thumbnail');
  expect(assets).toHaveLength(1);
  expect(assets?.[0]?.id).toBe(image.id);
});

it('should sync editor-style assetIds on save', async () => {
  const dbUrl = getTestDbUrl('editor-asset-sync');
  const contents = await Contents.create({
    db: {
      url: dbUrl,
    },
  });
  const images = await ImageCollection.create({
    db: {
      url: dbUrl,
    },
  });

  const content = await contents.create({
    name: 'editor-asset-sync',
    title: 'Editor asset sync',
    body: 'Starts without attachments',
    status: 'draft',
  });
  const image = await images.create({
    name: 'editor-asset-sync.jpg',
    sourceUri: 'file:///tmp/editor-asset-sync.jpg',
    mimeType: 'image/jpeg',
    width: 1280,
    height: 720,
  });

  (content as any).assetIds = [image.id];
  await content.save();

  let reloaded = await contents.get({ id: content.id });
  expect(await reloaded?.getAssets()).toHaveLength(1);
  expect((await reloaded?.getAssets())?.[0]?.id).toBe(image.id);

  (reloaded as any).assetIds = [];
  await reloaded?.save();

  reloaded = await contents.get({ id: content.id });
  expect(await reloaded?.getAssets()).toEqual([]);
});

it('should return an empty reference list before any reference writes', async () => {
  const contents = await Contents.create({
    db: {
      url: getTestDbUrl('fresh-reference-read'),
    },
  });

  const content = await contents.create({
    name: 'fresh-reference-read',
    title: 'Fresh reference read',
    body: 'No references yet',
    status: 'draft',
  });

  await expect(content.getReferences()).resolves.toEqual([]);
});

it('should persist content references via the ContentReference model', async () => {
  const dbUrl = getTestDbUrl('persisted-references');
  const contents = await Contents.create({
    db: {
      url: dbUrl,
    },
  });

  const source = await contents.create({
    name: 'source-content',
    title: 'Source content',
    body: 'Source body',
    status: 'draft',
  });

  const target = await contents.create({
    name: 'target-content',
    title: 'Target content',
    body: 'Target body',
    status: 'draft',
  });

  await source.addReference(target);

  const reloadedContents = await Contents.create({
    db: {
      url: dbUrl,
    },
  });
  const reloadedSource = await reloadedContents.get({ id: source.id });

  expect(reloadedSource).toBeTruthy();

  const references = await reloadedSource?.getReferences();
  expect(references).toHaveLength(1);
  expect(references[0]?.id).toBe(target.id);
});

it('should create URL reference targets with the source tenantId', async () => {
  const contents = await Contents.create({
    db: {
      url: getTestDbUrl('tenant-reference-target'),
    },
  });

  const source = await contents.create({
    name: 'tenant-reference-source',
    title: 'Tenant reference source',
    body: 'Tenant scoped source',
    status: 'draft',
    tenantId: 'tenant-1',
  });

  await source.addReference('https://example.com/reference');

  const referenced = await contents.get({
    url: 'https://example.com/reference',
    tenantId: 'tenant-1',
  });

  expect(referenced).toBeTruthy();
  expect(referenced?.tenantId).toBe('tenant-1');
});
