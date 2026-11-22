/**
 * A settable accessor must not be a way round a protected field (#5195): a
 * body that names `tags` (a setter) writes `tagsJson`, a read-only column.
 * The write is judged by its effect on the object, not only by the keys the
 * body names, on every path that applies a write body.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection.js';
import { field } from '../decorators/index.js';
import { APIGenerator } from '../generators/rest.js';
import { SmrtObject } from '../object.js';
import { ObjectRegistry, smrt } from '../registry.js';
import { applyUpdateInput } from '../request-input.js';
import { getTestDatabase } from '../testing/database.js';
import { FieldNotWritableError } from '../write-input.js';

@smrt({ api: { include: ['list', 'get', 'create', 'update'] } })
class AliasWriteRow extends SmrtObject {
  @field({ type: 'text' })
  label: string = '';

  @field({ type: 'text', readonly: true })
  tagsJson: string = '[]';

  get tags(): string[] {
    return JSON.parse(this.tagsJson) as string[];
  }
  set tags(value: string[]) {
    this.tagsJson = JSON.stringify(value);
  }

  /** A setter over a writable column stays a legitimate alias. */
  get labelUpper(): string {
    return this.label.toUpperCase();
  }
  set labelUpper(value: string) {
    this.label = value.toLowerCase();
  }
}
class AliasWriteRowCollection extends SmrtCollection<AliasWriteRow> {
  static readonly _itemClass = AliasWriteRow;
}

describe('a setter cannot write a protected field', () => {
  let dir = '';
  let rows: AliasWriteRowCollection;
  let rest: (req: Request) => Promise<Response>;
  let segment = '';
  let close: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ObjectRegistry.registerCollection(
      'AliasWriteRow',
      AliasWriteRowCollection as never,
    );
    dir = mkdtempSync(join(tmpdir(), 'smrt-protected-alias-'));
    const db = await getTestDatabase({
      type: 'sqlite',
      url: join(dir, 'app.db'),
      classes: ['AliasWriteRow'],
    });
    close = async () => db.close?.();
    rows = await AliasWriteRowCollection.create({ db });
    segment = ObjectRegistry.getClass('AliasWriteRow')?.collection as string;
    const api = new APIGenerator(
      { basePath: '/api', authMiddleware: () => async (req: Request) => req },
      { db },
    );
    api.registerCollection(segment, rows as never);
    rest = api.generateHandler();
  });
  afterAll(async () => {
    await close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  const patch = (id: string, body: unknown) =>
    rest(
      new Request(`http://local/api/${segment}/${id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body),
      }),
    );
  const stored = async (id: string) =>
    (await rows.get(id, { cache: false } as never)) as AliasWriteRow;

  it('REST: PATCH {"tags":["changed"]} is refused and tagsJson stays', async () => {
    const id = (await rows.create({ label: 'a' } as never)).id as string;
    const response = await patch(id, { tags: ['changed'] });
    const body = await response.text();
    // Probe output, kept in the failure message of the assertions below.
    const tagsJson = (await stored(id)).tagsJson;
    expect(
      { status: response.status, body, tagsJson },
      JSON.stringify({ status: response.status, body, tagsJson }),
    ).toMatchObject({ status: 400, tagsJson: '[]' });
    expect(JSON.parse(body).error).toMatchObject({
      code: 'VALIDATION_FIELD_NOT_WRITABLE',
      details: { field: 'tagsJson' },
    });
  });

  it('REST: a setter whose effect leaves the protected field alone applies', async () => {
    const id = (await rows.create({ label: 'a' } as never)).id as string;
    expect((await patch(id, { labelUpper: 'NEW' })).status).toBe(200);
    expect((await stored(id)).label).toBe('new');
    // The same value through the alias is no change.
    expect((await patch(id, { tags: [] })).status).toBe(200);
  });

  it('applyUpdateInput refuses the alias and leaves the object unchanged', async () => {
    const row = await rows.create({ label: 'a' } as never);
    expect(() =>
      applyUpdateInput(row, { label: 'b', tags: ['x'] }, 'AliasWriteRow'),
    ).toThrow(FieldNotWritableError);
    expect(row.tagsJson).toBe('[]');
    expect(row.label).toBe('a');
  });
});
