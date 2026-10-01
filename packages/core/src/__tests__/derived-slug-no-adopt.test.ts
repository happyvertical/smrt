/**
 * A name is not an identity.
 *
 * `getSlug()` derives a missing slug from `name` → `title` → `label`. Before
 * this, a NEW object whose derived slug matched an existing same-owner row
 * adopted that row through the `(tenant_id, slug, context)` natural key and
 * `DO UPDATE` overwrote it: attaching a second picture named
 * `generated-content-image-001.jpg` replaced the first picture's bytes, and a
 * second "New conversation" chat thread took over the first. Only an explicit
 * natural key adopts now; a derived slug that is taken moves to `-2`, `-3`, ….
 */

import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { getTestDatabase } from '../testing/database.js';

const TENANT_A = 'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa';
const TENANT_B = 'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb';

type Row = Record<string, unknown>;

/** A picture: tenant-owned, slug derived from the file name. */
@smrt({ tableName: 'ds_pictures' })
class DsPicture extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  @field({ type: 'text' })
  sourceUri: string = '';

  @field({ sqlType: 'UUID', nullable: true })
  tenantId: string | null = null;

  constructor(options: Record<string, unknown> = {}) {
    super(options as never);
    if (typeof options.name === 'string') this.name = options.name;
    if (typeof options.sourceUri === 'string')
      this.sourceUri = options.sourceUri;
    if (options.tenantId !== undefined) {
      this.tenantId = options.tenantId as string | null;
    }
  }
}

class DsPictureCollection extends SmrtCollection<DsPicture> {
  static readonly _itemClass = DsPicture;
}

/** An article: the title-derived slug is its public URL. */
@smrt({ tableName: 'ds_articles' })
class DsArticle extends SmrtObject {
  @field({ type: 'text' })
  title: string = '';

  @field({ type: 'text' })
  body: string = '';

  @field({ sqlType: 'UUID', nullable: true })
  tenantId: string | null = null;

  constructor(options: Record<string, unknown> = {}) {
    super(options as never);
    if (typeof options.title === 'string') this.title = options.title;
    if (typeof options.body === 'string') this.body = options.body;
    if (options.tenantId !== undefined) {
      this.tenantId = options.tenantId as string | null;
    }
  }
}

class DsArticleCollection extends SmrtCollection<DsArticle> {
  static readonly _itemClass = DsArticle;
}

/** No tenant column: the key is the global (slug, context). */
@smrt({ tableName: 'ds_labels' })
class DsLabel extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  constructor(options: Record<string, unknown> = {}) {
    super(options as never);
    if (typeof options.name === 'string') this.name = options.name;
  }
}

class DsLabelCollection extends SmrtCollection<DsLabel> {
  static readonly _itemClass = DsLabel;
}

/** Keyed by an external id: a sync that re-imports updates in place. */
@smrt({
  tableName: 'ds_imports',
  conflictColumns: ['tenant_id', 'external_id'],
})
class DsImport extends SmrtObject {
  @field({ type: 'text' })
  name: string = '';

  @field({ type: 'text' })
  externalId: string = '';

  @field({ sqlType: 'UUID', nullable: true })
  tenantId: string | null = null;

  constructor(options: Record<string, unknown> = {}) {
    super(options as never);
    if (typeof options.name === 'string') this.name = options.name;
    if (typeof options.externalId === 'string')
      this.externalId = options.externalId;
    if (options.tenantId !== undefined) {
      this.tenantId = options.tenantId as string | null;
    }
  }
}

class DsImportCollection extends SmrtCollection<DsImport> {
  static readonly _itemClass = DsImport;
}

describe('a derived slug never adopts another record', () => {
  let db: Awaited<ReturnType<typeof getTestDatabase>>;

  beforeAll(async () => {
    ObjectRegistry.registerCollection('DsPicture', DsPictureCollection);
    ObjectRegistry.registerCollection('DsArticle', DsArticleCollection);
    ObjectRegistry.registerCollection('DsLabel', DsLabelCollection);
    ObjectRegistry.registerCollection('DsImport', DsImportCollection);
    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['DsPicture', 'DsArticle', 'DsLabel', 'DsImport'],
    });
  });

  afterAll(async () => {
    await db?.close?.();
  });

  beforeEach(async () => {
    for (const table of [
      'ds_pictures',
      'ds_articles',
      'ds_labels',
      'ds_imports',
    ]) {
      await db.query(`DELETE FROM ${table}`);
    }
  });

  it('a second picture with the same file name is a second row; the first keeps its bytes', async () => {
    const pictures = await DsPictureCollection.create({ db });
    const first = await pictures.create({
      name: 'generated-content-image-001.jpg',
      sourceUri: 'file:///a.jpg',
      tenantId: TENANT_A,
    });
    const second = await pictures.create({
      name: 'generated-content-image-001.jpg',
      sourceUri: 'file:///b.jpg',
      tenantId: TENANT_A,
    });

    expect(second.id).not.toBe(first.id);
    expect(first.slug).toBe('generated-content-image-001-jpg');
    expect(second.slug).toBe('generated-content-image-001-jpg-2');
    const rows = (await db.list('ds_pictures', {})) as Row[];
    expect(rows).toHaveLength(2);
    expect(rows.find((row) => row.id === first.id)?.source_uri).toBe(
      'file:///a.jpg',
    );
    expect(rows.find((row) => row.id === second.id)?.source_uri).toBe(
      'file:///b.jpg',
    );
  });

  it('a public title slug counts up: council-meeting, -2, -3', async () => {
    const articles = await DsArticleCollection.create({ db });
    const made = [];
    for (const body of ['one', 'two', 'three']) {
      made.push(
        await articles.create({
          title: 'Council meeting',
          body,
          tenantId: TENANT_A,
        }),
      );
    }
    expect(made.map((article) => article.slug)).toEqual([
      'council-meeting',
      'council-meeting-2',
      'council-meeting-3',
    ]);
    const rows = (await db.list('ds_articles', {})) as Row[];
    expect(rows.map((row) => row.body).sort()).toEqual(['one', 'three', 'two']);
  });

  it('two tenants each keep the plain slug', async () => {
    const articles = await DsArticleCollection.create({ db });
    const a = await articles.create({ title: 'Parade', tenantId: TENANT_A });
    const b = await articles.create({ title: 'Parade', tenantId: TENANT_B });
    expect(a.slug).toBe('parade');
    expect(b.slug).toBe('parade');
  });

  it('after nine numbered slugs the id makes the slug unique', async () => {
    const labels = await DsLabelCollection.create({ db });
    for (let index = 0; index < 9; index += 1) {
      await labels.create({ name: 'Hockey' });
    }
    const tenth = await labels.create({ name: 'Hockey' });
    const idPart = String(tenth.id).replace(/-/g, '').slice(0, 8);
    expect(tenth.slug).toBe(`hockey-${idPart}`);
    const rows = (await db.list('ds_labels', {})) as Row[];
    expect(rows).toHaveLength(10);
    expect(new Set(rows.map((row) => row.slug)).size).toBe(10);
  });

  it('a global (tenantless) table does not adopt either', async () => {
    const labels = await DsLabelCollection.create({ db });
    const first = await labels.create({ name: 'Hockey' });
    const second = await labels.create({ name: 'Hockey' });
    expect(second.id).not.toBe(first.id);
    expect(second.slug).toBe('hockey-2');
  });

  it('re-saving a persisted object keeps its slug', async () => {
    const articles = await DsArticleCollection.create({ db });
    const article = await articles.create({
      title: 'Budget',
      tenantId: TENANT_A,
    });
    article.body = 'edited';
    await article.save();
    expect(article.slug).toBe('budget');
    const rows = (await db.list('ds_articles', {})) as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe('edited');
  });

  it('an explicit slug is a natural key: it still adopts, keeping id and created_at', async () => {
    const articles = await DsArticleCollection.create({ db });
    const first = await articles.create({
      title: 'Budget',
      body: 'v1',
      tenantId: TENANT_A,
    });
    const [before] = (await db.list('ds_articles', {})) as Row[];

    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = new DsArticle({ db, tenantId: TENANT_A });
    await again.initialize();
    again.title = 'Budget';
    again.body = 'v2';
    again.slug = 'budget';
    await again.save();

    expect(again.id).toBe(first.id);
    const rows = (await db.list('ds_articles', {})) as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0].body).toBe('v2');
    expect(String(rows[0].created_at)).toBe(String(before.created_at));
  });

  it('an external-id key still updates in place', async () => {
    const imports = await DsImportCollection.create({ db });
    const first = await imports.create({
      name: 'Agenda',
      externalId: 'doc-1',
      tenantId: TENANT_A,
    });
    const again = await imports.create({
      name: 'Agenda (revised)',
      externalId: 'doc-1',
      tenantId: TENANT_A,
    });
    expect(again.id).toBe(first.id);
    const rows = (await db.list('ds_imports', {})) as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0].name).toBe('Agenda (revised)');
  });

  it('getOrUpsert by name still finds the existing row', async () => {
    const labels = await DsLabelCollection.create({ db });
    const first = await labels.getOrUpsert({ name: 'Rink' });
    const again = await labels.getOrUpsert({ name: 'Rink' });
    expect(again.id).toBe(first.id);
    expect((await db.list('ds_labels', {})) as Row[]).toHaveLength(1);
  });

  it('getOrUpsert updates the row its name keys when another field differs', async () => {
    const pictures = await DsPictureCollection.create({ db });
    const first = await pictures.getOrUpsert({
      name: 'Rink.jpg',
      sourceUri: 's3://blue',
      tenantId: TENANT_A,
    });
    // The all-field lookup misses (sourceUri differs); the create is keyed by
    // the derived slug and updates the same row instead of adding rink-jpg-2.
    const again = await pictures.getOrUpsert({
      name: 'Rink.jpg',
      sourceUri: 's3://red',
      tenantId: TENANT_A,
    });
    expect(again.id).toBe(first.id);
    expect(again.slug).toBe(first.slug);
    const rows = (await db.list('ds_pictures', {})) as Row[];
    expect(rows).toHaveLength(1);
    expect(rows[0].source_uri).toBe('s3://red');
    // Running the importer again is idempotent.
    await pictures.getOrUpsert({
      name: 'Rink.jpg',
      sourceUri: 's3://red',
      tenantId: TENANT_A,
    });
    expect((await db.list('ds_pictures', {})) as Row[]).toHaveLength(1);
  });

  it("getOrUpsert never adopts another tenant's row through its name", async () => {
    const pictures = await DsPictureCollection.create({ db });
    const a = await pictures.getOrUpsert({
      name: 'Rink.jpg',
      sourceUri: 's3://a',
      tenantId: TENANT_A,
    });
    const b = await pictures.getOrUpsert({
      name: 'Rink.jpg',
      sourceUri: 's3://b',
      tenantId: TENANT_B,
    });
    expect(b.id).not.toBe(a.id);
    const rows = (await db.list('ds_pictures', {})) as Row[];
    expect(rows.find((row) => row.id === a.id)?.source_uri).toBe('s3://a');
  });
});
