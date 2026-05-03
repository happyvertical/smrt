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
    expect(first.status).toBe('supports');
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

  it('updates status in bulk and lists evidence for multiple sources', async () => {
    const fact = await facts.create({
      textRefined: 'Council approved the capital plan.',
      type: 'assertion',
      status: 'active',
      tenantId: 'tenant-1',
    });

    const agendaEvidence = await evidence.upsertEvidence({
      factId: fact.id as string,
      sourceKind: 'content-reference',
      sourceId: 'agenda-1',
      quote: 'Capital plan approval',
      locator: 'page 4',
      tenantId: 'tenant-1',
    });
    const minutesEvidence = await evidence.upsertEvidence({
      factId: fact.id as string,
      sourceKind: 'content-reference',
      sourceId: 'minutes-1',
      quote: 'Capital plan passed',
      locator: 'page 7',
      tenantId: 'tenant-1',
    });

    await evidence.bulkUpdateStatus(
      [agendaEvidence.id as string, minutesEvidence.id as string],
      'invalid',
      { reason: 'OCR was unreadable', reviewedBy: 'editor-1' },
    );

    const listed = await evidence.getForSources([
      { sourceKind: 'content-reference', sourceId: 'agenda-1' },
      { sourceKind: 'content-reference', sourceId: 'minutes-1' },
    ]);

    expect(listed).toHaveLength(2);
    expect(listed.every((entry) => entry.status === 'invalid')).toBe(true);
    expect(listed[0].getMetadata()).toMatchObject({
      evidenceStatusReason: 'OCR was unreadable',
      evidenceStatusReviewedBy: 'editor-1',
    });
  });

  it('replaces generated evidence for selected sources and preserves manual evidence', async () => {
    const fact = await facts.create({
      textRefined: 'Council approved the capital plan.',
      type: 'assertion',
      status: 'active',
      tenantId: 'tenant-1',
    });

    const generated = await evidence.upsertEvidence({
      factId: fact.id as string,
      sourceKind: 'content-reference',
      sourceId: 'agenda-1',
      quote: 'Generated excerpt',
      tenantId: 'tenant-1',
      metadata: { generatedBy: 'content.factAudit', contentId: 'article-1' },
    });
    const manual = await evidence.upsertEvidence({
      factId: fact.id as string,
      sourceKind: 'content-reference',
      sourceId: 'agenda-1',
      quote: 'Manual excerpt',
      tenantId: 'tenant-1',
      metadata: { generatedBy: 'editor' },
    });
    const otherTenantGenerated = await evidence.upsertEvidence({
      factId: fact.id as string,
      sourceKind: 'content-reference',
      sourceId: 'agenda-1',
      quote: 'Generated excerpt for another tenant',
      tenantId: 'tenant-2',
      metadata: { generatedBy: 'content.factAudit', contentId: 'article-1' },
    });
    await evidence.upsertEvidence({
      factId: fact.id as string,
      sourceKind: 'content-reference',
      sourceId: 'minutes-1',
      quote: 'Generated excerpt',
      tenantId: 'tenant-1',
      metadata: { generatedBy: 'content.factAudit', contentId: 'article-1' },
    });

    const result = await evidence.replaceGeneratedForSources(
      [{ sourceKind: 'content-reference', sourceId: 'agenda-1' }],
      {
        generatedBy: 'content.factAudit',
        contentId: 'article-1',
        tenantId: 'tenant-1',
      },
    );

    expect(result.deletedEvidenceIds).toEqual([generated.id]);
    const remainingAgendaEvidence = await evidence.getForSource(
      'content-reference',
      'agenda-1',
    );
    expect(remainingAgendaEvidence.map((entry) => entry.id).sort()).toEqual(
      [manual.id, otherTenantGenerated.id].sort(),
    );
    await expect(
      evidence.getForSource('content-reference', 'minutes-1'),
    ).resolves.toHaveLength(1);
  });
});
