import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field, foreignKey, oneToMany } from '../decorators';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

@smrt()
class LatestRelatedParent extends SmrtObject {
  name = '';

  @oneToMany('LatestRelatedEvaluation')
  evaluations: LatestRelatedEvaluation[] = [];
}

@smrt()
class LatestRelatedEvaluation extends SmrtObject {
  @foreignKey(LatestRelatedParent)
  parentId = '';

  @field()
  sequence = 0;

  @field()
  score = 0.0;

  @field()
  evaluationScore = 0.0;

  @field()
  note = '';
}

class LatestRelatedParentCollection extends SmrtCollection<LatestRelatedParent> {
  static readonly _itemClass = LatestRelatedParent;
}

class LatestRelatedEvaluationCollection extends SmrtCollection<LatestRelatedEvaluation> {
  static readonly _itemClass = LatestRelatedEvaluation;
}

describe('SmrtCollection.listWithLatestRelated()', () => {
  let db: DatabaseInterface;
  let parents: LatestRelatedParentCollection;
  let evaluations: LatestRelatedEvaluationCollection;

  beforeEach(async () => {
    db = await getTestDatabase({
      type: 'sqlite',
      url: join(tmpdir(), `latest-related-${randomUUID()}.db`),
    });
    parents = await LatestRelatedParentCollection.create({ db });
    evaluations = await LatestRelatedEvaluationCollection.create({ db });
  });

  afterEach(async () => {
    await db.close?.();
  });

  it('selects one latest row per parent and sorts before pagination', async () => {
    const first = await parents.create({ name: 'first' });
    const second = await parents.create({ name: 'second' });
    const third = await parents.create({ name: 'third' });

    await evaluations.create({
      parentId: first.id,
      sequence: 1,
      score: 1.0,
      evaluationScore: 1.0,
      note: 'old first',
    });
    await evaluations.create({
      parentId: first.id,
      sequence: 2,
      score: 9.0,
      evaluationScore: 9.0,
      note: 'latest first',
    });
    await evaluations.create({
      parentId: second.id,
      sequence: 1,
      score: 4.0,
      evaluationScore: 4.0,
      note: 'latest second',
    });
    // Third intentionally has no related row.

    const page = await parents.listWithLatestRelated({
      latestRelated: {
        relation: 'evaluations',
        orderBy: 'sequence DESC',
        select: ['score', 'note'],
        sortBy: 'evaluationScore DESC',
      },
      limit: 2,
      offset: 0,
    });

    expect(page).toHaveLength(2);
    expect(page.map((row) => row.parent.name)).toEqual(['first', 'second']);
    expect(page[0].latestRelated).toEqual({ score: 9, note: 'latest first' });
    expect(page[1].latestRelated).toEqual({ score: 4, note: 'latest second' });

    const nextPage = await parents.listWithLatestRelated({
      latestRelated: {
        relation: 'evaluations',
        orderBy: 'sequence DESC',
        select: ['score'],
        sortBy: 'evaluationScore DESC',
      },
      limit: 2,
      offset: 2,
    });
    expect(nextPage).toHaveLength(1);
    expect(nextPage[0].parent.name).toBe('third');
    expect(nextPage[0].latestRelated).toBeNull();
  });

  it('uses the declared relation and rejects unrelated fields', async () => {
    await parents.create({ name: 'only parent' });

    await expect(
      parents.listWithLatestRelated({
        latestRelated: {
          relation: 'missing',
          orderBy: 'sequence DESC',
        },
      }),
    ).rejects.toThrow("latestRelated.relation 'missing'");

    await expect(
      parents.listWithLatestRelated({
        latestRelated: {
          relation: 'evaluations',
          orderBy: 'notAField DESC',
        },
      }),
    ).rejects.toThrow(/Invalid orderBy field/);
  });

  it('uses the same window-query shape on DuckDB', async () => {
    const duckDb = await getTestDatabase({
      type: 'duckdb',
      url: join(tmpdir(), `latest-related-${randomUUID()}.duckdb`),
    });
    try {
      const duckParents = await LatestRelatedParentCollection.create({
        db: duckDb,
      });
      const duckEvaluations = await LatestRelatedEvaluationCollection.create({
        db: duckDb,
      });
      const parent = await duckParents.create({ name: 'duck parent' });
      await duckEvaluations.create({
        parentId: parent.id,
        sequence: 1,
        score: 7.0,
        evaluationScore: 7.0,
        note: 'duck latest',
      });

      const rows = await duckParents.listWithLatestRelated({
        latestRelated: {
          relation: 'evaluations',
          orderBy: 'sequence DESC',
          select: ['score', 'note'],
        },
      });
      expect(rows[0].latestRelated).toEqual({
        score: 7,
        note: 'duck latest',
      });
    } finally {
      await duckDb.close?.();
    }
  });

  it('uses the same window-query shape on JSON-on-DuckDB', async () => {
    const jsonPath = join(tmpdir(), `latest-related-${randomUUID()}`);
    const jsonDb = await getTestDatabase({
      type: 'json',
      url: jsonPath,
      classes: ['LatestRelatedParent', 'LatestRelatedEvaluation'],
    });
    try {
      const jsonParents = await LatestRelatedParentCollection.create({
        db: jsonDb,
      });
      const jsonEvaluations = await LatestRelatedEvaluationCollection.create({
        db: jsonDb,
      });
      const parent = await jsonParents.create({ name: 'json parent' });
      await jsonEvaluations.create({
        parentId: parent.id,
        sequence: 1,
        score: 8.0,
        evaluationScore: 8.0,
        note: 'json latest',
      });

      const rows = await jsonParents.listWithLatestRelated({
        latestRelated: {
          relation: 'evaluations',
          orderBy: 'sequence DESC',
          select: ['score', 'note'],
        },
      });
      expect(rows[0].latestRelated).toEqual({
        score: 8,
        note: 'json latest',
      });
    } finally {
      await jsonDb.close?.();
      if (existsSync(jsonPath)) {
        rmSync(jsonPath, { recursive: true, force: true });
      }
    }
  });
});
