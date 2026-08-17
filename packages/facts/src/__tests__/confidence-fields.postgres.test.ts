/**
 * PostgreSQL round-trip proof for the confidence columns fixed in #2361.
 *
 * `FactEvidence.confidence` was declared `number = 0`, which compiles to an
 * INTEGER column while its siblings `Fact.confidence` and
 * `FactSource.credibility` (both `0.0`) are DECIMAL. A confidence score lives
 * entirely in `[0, 1]`, so an INTEGER column makes every meaningful value
 * unstorable — PostgreSQL raises `22P02` and SQLite quietly accepts it, which
 * is why the SQLite suites never caught it.
 *
 * Confidence is a *rate*, not money: it is inherently fractional, so decimal is
 * correct here. Money elsewhere in the framework goes the other way — integer
 * minor units — which is why the lint treats the two vocabularies separately.
 */

import {
  createIsolatedTestDbFromManifest,
  type IsolatedTestDbResult,
  isPostgresAvailable,
} from '@happyvertical/smrt-vitest';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FactEvidenceCollection } from '../fact-evidences.js';
import { FactSourceCollection } from '../fact-sources.js';
import { FactCollection } from '../facts.js';

const describePostgres = isPostgresAvailable() ? describe : describe.skip;

describePostgres('facts confidence columns on PostgreSQL (#2361)', () => {
  let isolated: IsolatedTestDbResult | undefined;
  let db: DatabaseInterface;
  let facts: FactCollection;
  let evidence: FactEvidenceCollection;
  let sources: FactSourceCollection;

  beforeEach(async () => {
    isolated = await createIsolatedTestDbFromManifest({
      includeObjects: ['Fact', 'FactEvidence', 'FactSource'],
    });
    if (isolated.config.type !== 'postgres') {
      throw new Error('Expected a PostgreSQL test database');
    }
    db = isolated.baseDb;
    facts = await FactCollection.create({ db });
    evidence = await FactEvidenceCollection.create({ db });
    sources = await FactSourceCollection.create({ db });
  });

  afterEach(async () => {
    await isolated?.cleanup();
    isolated = undefined;
  });

  it('declares evidence confidence as a floating-point type, like its siblings', async () => {
    const result = await db.query(
      `SELECT table_name, column_name, data_type FROM information_schema.columns
       WHERE (table_name = 'fact_evidences' AND column_name = 'confidence')
          OR (table_name = 'facts' AND column_name = 'confidence')
          OR (table_name = 'fact_sources' AND column_name = 'credibility')
       ORDER BY table_name`,
    );

    const rows = result.rows as {
      table_name: string;
      column_name: string;
      data_type: string;
    }[];

    expect(rows).toHaveLength(3);
    for (const row of rows) {
      // Loose on purpose — see the note in commerce's money-fields lane: the
      // manifest's pre-rendered `ddl` lands float4 while the structured
      // strategy would emit float8. "Not INTEGER" is the assertion (#2358).
      expect(row.data_type, `${row.table_name}.${row.column_name}`).toMatch(
        /double precision|real|numeric/,
      );
    }
  });

  it('round-trips a fractional evidence confidence score', async () => {
    const fact = await facts.create({
      textRefined: 'Council approved the capital plan.',
      type: 'assertion',
      status: 'active',
      confidence: 0.91,
    });

    const record = await evidence.upsertEvidence({
      factId: fact.id as string,
      sourceKind: 'content-reference',
      sourceId: 'agenda-1',
      sourceTitle: 'Agenda',
      quote: 'Capital plan approval',
      locator: 'page 4',
      extractionMethod: 'ai-reference-fact',
      confidence: 0.82,
    });

    expect((await evidence.get(record.id))?.confidence).toBeCloseTo(0.82, 6);
    expect((await facts.get(fact.id as string))?.confidence).toBeCloseTo(
      0.91,
      6,
    );
  });

  it('round-trips a fractional source credibility', async () => {
    const fact = await facts.create({
      textRefined: 'Budget was tabled on the 4th.',
      type: 'assertion',
      status: 'active',
    });

    const source = await sources.create({
      factId: fact.id as string,
      sourceTitle: 'City clerk',
      credibility: 0.73,
    });

    expect((await sources.get(source.id))?.credibility).toBeCloseTo(0.73, 6);
  });
});
