import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { faker } from '@faker-js/faker';
import { makeSlug } from '@have/utils';
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
