import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { faker } from '@faker-js/faker';
import { makeSlug } from '@happyvertical/utils';
import { expect, it } from 'vitest';
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
