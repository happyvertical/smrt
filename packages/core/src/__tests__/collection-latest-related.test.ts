import { randomUUID } from 'node:crypto';
import { existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SmrtCollection } from '../collection';
import { field, foreignKey, oneToMany } from '../decorators';
import { GlobalInterceptors } from '../interceptors';
import { SmrtObject } from '../object';
import { smrt } from '../registry';
import { getTestDatabase } from '../testing/database';

let activeInitializers = 0;
let maximumActiveInitializers = 0;
let initializationOrder: string[] = [];

function resetInitializationEvidence(): void {
  activeInitializers = 0;
  maximumActiveInitializers = 0;
  initializationOrder = [];
}

@smrt()
class LatestRelatedParent extends SmrtObject {
  name = '';

  @oneToMany('LatestRelatedEvaluation')
  evaluations: LatestRelatedEvaluation[] = [];

  override async initialize(): Promise<this> {
    await super.initialize();
    if (!this.isPersisted || !this.id) return this;

    activeInitializers += 1;
    maximumActiveInitializers = Math.max(
      maximumActiveInitializers,
      activeInitializers,
    );
    initializationOrder.push(this.name);
    try {
      await new Promise((resolve) => setTimeout(resolve, 5));
      await this.db.get(this.tableName, { id: this.id });
    } finally {
      activeInitializers -= 1;
    }
    return this;
  }
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
  tenantId = '';

  @field()
  note = '';
}

class LatestRelatedParentCollection extends SmrtCollection<LatestRelatedParent> {
  static readonly _itemClass = LatestRelatedParent;
}

class LatestRelatedEvaluationCollection extends SmrtCollection<LatestRelatedEvaluation> {
  static readonly _itemClass = LatestRelatedEvaluation;
}

@smrt()
class LatestRelatedStiParent extends SmrtObject {
  name = '';

  @oneToMany('LatestRelatedStiScoreEvaluation')
  evaluations: LatestRelatedStiScoreEvaluation[] = [];
}

@smrt({ tableStrategy: 'sti' })
class LatestRelatedStiEvaluation extends SmrtObject {
  @field()
  sequence = 0;

  @field()
  note = '';
}

@smrt()
class LatestRelatedStiScoreEvaluation extends LatestRelatedStiEvaluation {
  @foreignKey(LatestRelatedStiParent)
  parentId = '';

  @field()
  score = 0.0;
}

class LatestRelatedStiParentCollection extends SmrtCollection<LatestRelatedStiParent> {
  static readonly _itemClass = LatestRelatedStiParent;
}

class LatestRelatedStiScoreEvaluationCollection extends SmrtCollection<LatestRelatedStiScoreEvaluation> {
  static readonly _itemClass = LatestRelatedStiScoreEvaluation;
}

describe('SmrtCollection.listWithLatestRelated()', () => {
  let db: DatabaseInterface;
  let parents: LatestRelatedParentCollection;
  let evaluations: LatestRelatedEvaluationCollection;

  beforeEach(async () => {
    resetInitializationEvidence();
    db = await getTestDatabase({
      type: 'sqlite',
      url: join(tmpdir(), `latest-related-${randomUUID()}.db`),
    });
    parents = await LatestRelatedParentCollection.create({ db });
    evaluations = await LatestRelatedEvaluationCollection.create({ db });
  });

  afterEach(async () => {
    GlobalInterceptors.unregister('latest-related-transform');
    GlobalInterceptors.unregister('latest-related-scope');
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
    resetInitializationEvidence();

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
    expect(initializationOrder).toEqual(['first', 'second', 'third']);
    expect(maximumActiveInitializers).toBe(1);
  });

  it('keeps related rows paired when afterList filters and reorders parents', async () => {
    const first = await parents.create({ name: 'first' });
    const second = await parents.create({ name: 'second' });
    const third = await parents.create({ name: 'third' });

    await evaluations.create({
      parentId: first.id,
      sequence: 1,
      score: 1.0,
      evaluationScore: 1.0,
      note: 'first related',
    });
    await evaluations.create({
      parentId: second.id,
      sequence: 1,
      score: 2.0,
      evaluationScore: 2.0,
      note: 'second related',
    });
    await evaluations.create({
      parentId: third.id,
      sequence: 1,
      score: 3.0,
      evaluationScore: 3.0,
      note: 'third related',
    });
    resetInitializationEvidence();

    GlobalInterceptors.register({
      name: 'latest-related-transform',
      afterList(_className, results: LatestRelatedParent[]) {
        return results
          .filter((parent) => parent.name !== 'second')
          .sort((left, right) => right.name.localeCompare(left.name));
      },
    });

    const rows = await parents.listWithLatestRelated({
      latestRelated: {
        relation: 'evaluations',
        orderBy: 'sequence DESC',
        select: ['note'],
      },
    });

    expect(rows.map((row) => row.parent.name)).toEqual(['third', 'first']);
    expect(rows.map((row) => row.latestRelated?.note)).toEqual([
      'third related',
      'first related',
    ]);
  });

  it("applies the related collection's tenant scope inside the CTE", async () => {
    const parent = await parents.create({ name: 'scoped parent' });
    await evaluations.create({
      parentId: parent.id,
      sequence: 2,
      score: 9.0,
      evaluationScore: 9.0,
      tenantId: 'tenant-b',
      note: 'blocked related',
    });
    await evaluations.create({
      parentId: parent.id,
      sequence: 1,
      score: 1.0,
      evaluationScore: 1.0,
      tenantId: 'tenant-a',
      note: 'allowed related',
    });

    GlobalInterceptors.register({
      name: 'latest-related-scope',
      beforeList(className, options) {
        if (className !== 'LatestRelatedEvaluation') return;
        return {
          ...options,
          where: { ...options.where, tenantId: 'tenant-a' },
        };
      },
    });

    const rows = await parents.listWithLatestRelated({
      latestRelated: {
        relation: 'evaluations',
        orderBy: 'sequence DESC',
        select: ['note'],
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].latestRelated).toEqual({ note: 'allowed related' });
  });

  it('keeps tied latest rows and null parent sorting stable across pages', async () => {
    const high = await parents.create({ name: 'high' });
    const tied = await parents.create({ name: 'tied' });
    await parents.create({ name: 'empty' });

    await evaluations.create({
      parentId: high.id,
      sequence: 1,
      score: 9.0,
      evaluationScore: 9.0,
      note: 'high',
    });
    for (const note of ['tie-a', 'tie-b']) {
      await evaluations.create({
        parentId: tied.id,
        sequence: 1,
        score: 4.0,
        evaluationScore: 4.0,
        note,
      });
    }

    const readPage = () =>
      parents.listWithLatestRelated({
        latestRelated: {
          relation: 'evaluations',
          orderBy: 'sequence DESC',
          select: ['note'],
          sortBy: 'score DESC',
        },
        limit: 3,
        offset: 0,
      });
    const firstPage = await readPage();
    const secondPage = await readPage();

    expect(firstPage.map((row) => row.parent.name)).toEqual([
      'high',
      'tied',
      'empty',
    ]);
    expect(firstPage.map((row) => row.latestRelated?.note ?? null)).toEqual(
      secondPage.map((row) => row.latestRelated?.note ?? null),
    );
    expect(firstPage[2].latestRelated).toBeNull();
  });

  it('filters an STI related collection to its declared child type', async () => {
    const stiParents = await LatestRelatedStiParentCollection.create({ db });
    const stiEvaluations =
      await LatestRelatedStiScoreEvaluationCollection.create({ db });
    const parent = await stiParents.create({ name: 'sti parent' });
    await stiEvaluations.create({
      parentId: parent.id,
      sequence: 1,
      score: 7.0,
      note: 'sti latest',
    });

    const rows = await stiParents.listWithLatestRelated({
      latestRelated: {
        relation: 'evaluations',
        orderBy: 'sequence DESC',
        select: ['score', 'note'],
      },
    });

    expect(rows).toHaveLength(1);
    expect(rows[0].latestRelated).toEqual({
      score: 7,
      note: 'sti latest',
    });
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
