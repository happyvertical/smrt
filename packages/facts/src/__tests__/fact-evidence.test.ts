import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FactEvidenceCollection } from '../fact-evidences';
import { FactCollection } from '../facts';

describe('FactEvidenceCollection', () => {
  let tempDir: string;
  let facts: FactCollection;
  let evidence: FactEvidenceCollection;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'smrt-fact-evidence-test-'));
    const db = {
      type: 'sqlite' as const,
      url: join(tempDir, 'facts.db'),
    };
    facts = await FactCollection.create({ db });
    evidence = await FactEvidenceCollection.create({ db });
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('upserts evidence idempotently and looks it up by fact and source', async () => {
    const fact = await facts.create({
      textRefined: 'Council approved the capital plan.',
      type: 'assertion',
      status: 'active',
      tenantId: 'tenant-1',
    });

    const first = await evidence.upsertEvidence({
      factId: fact.id as string,
      sourceKind: 'content-reference',
      sourceId: 'agenda-1',
      sourceTitle: 'Agenda',
      quote: 'Capital plan approval',
      locator: 'page 4',
      extractionMethod: 'ai-reference-fact',
      confidence: 0.82,
      tenantId: 'tenant-1',
      metadata: { auditRunId: 'audit-1' },
    });
    const second = await evidence.upsertEvidence({
      factId: fact.id as string,
      sourceKind: 'content-reference',
      sourceId: 'agenda-1',
      sourceTitle: 'Agenda package',
      quote: 'Capital plan approval',
      locator: 'page 4',
      extractionMethod: 'ai-reference-fact',
      confidence: 0.9,
      tenantId: 'tenant-1',
      metadata: { auditRunId: 'audit-2' },
    });

    expect(second.id).toBe(first.id);
    expect(second.sourceTitle).toBe('Agenda package');
    expect(second.confidence).toBe(0.9);
    expect(second.getMetadata()).toEqual({ auditRunId: 'audit-2' });
    await expect(evidence.getForFact(fact.id as string)).resolves.toHaveLength(
      1,
    );
    await expect(
      evidence.getForSource('content-reference', 'agenda-1'),
    ).resolves.toHaveLength(1);
  });
});
