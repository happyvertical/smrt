/**
 * Confidence scoring tests - recalculateConfidence
 *
 * Tests that confidence is properly calculated from source data
 * using the calculateConfidence formula from utils.ts.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FactSourceCollection } from '../fact-sources';
import { FactCollection } from '../facts';
import { calculateConfidence } from '../utils';

describe('recalculateConfidence', () => {
  let tempDir: string;
  let dbPath: string;
  let facts: FactCollection;
  let sources: FactSourceCollection;

  beforeEach(async () => {
    tempDir = mkdtempSync(join(tmpdir(), 'smrt-confidence-test-'));
    dbPath = join(tempDir, 'facts.db');

    facts = await FactCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
    sources = await FactSourceCollection.create({
      db: { type: 'sqlite', url: dbPath },
    });
  });

  afterEach(() => {
    try {
      rmSync(tempDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  });

  it('should calculate confidence with no sources', async () => {
    const fact = await facts.create({
      textRefined: 'A fact with no sources',
      confidence: 0.0,
    });

    const confidence = await facts.recalculateConfidence(fact.id as string);

    // With no sources: base 0.5 + source(0/10=0) + credibility(0.5*0.2=0.1) + recency(0.1) + corroboration(0)
    // = 0.7
    const expected = calculateConfidence({
      sourceCount: 0,
      avgSourceCredibility: 0.5,
      daysSinceLastSource: 0,
      corroborationScore: 0,
    });
    expect(confidence).toBeCloseTo(expected, 2);
  });

  it('should calculate confidence with multiple sources', async () => {
    const fact = await facts.create({
      textRefined: 'Well-sourced fact',
      confidence: 0.0,
    });
    const factId = fact.id as string;

    // Add sources with varying credibility
    await sources.create({
      factId,
      sourceType: 'web',
      credibility: 0.9,
      extractedAt: new Date(),
    });
    await sources.create({
      factId,
      sourceType: 'document',
      credibility: 0.7,
      extractedAt: new Date(),
    });
    await sources.create({
      factId,
      sourceType: 'api',
      credibility: 0.8,
      extractedAt: new Date(),
    });

    const confidence = await facts.recalculateConfidence(factId);

    expect(confidence).toBeGreaterThan(0.5);
    expect(confidence).toBeLessThanOrEqual(1.0);

    // Verify the fact was updated
    const reloaded = await facts.get({ id: factId });
    expect(reloaded?.confidence).toBeCloseTo(confidence, 5);
    expect(reloaded?.sourceCount).toBe(3);
  });

  it('should increase confidence with more sources', async () => {
    const fact = await facts.create({
      textRefined: 'Fact gaining sources',
      confidence: 0.0,
    });
    const factId = fact.id as string;

    // Start with one source
    await sources.create({
      factId,
      sourceType: 'web',
      credibility: 0.5,
      extractedAt: new Date(),
    });
    const conf1 = await facts.recalculateConfidence(factId);

    // Add more sources
    await sources.create({
      factId,
      sourceType: 'document',
      credibility: 0.5,
      extractedAt: new Date(),
    });
    await sources.create({
      factId,
      sourceType: 'api',
      credibility: 0.5,
      extractedAt: new Date(),
    });
    const conf3 = await facts.recalculateConfidence(factId);

    // More sources should increase confidence
    expect(conf3).toBeGreaterThan(conf1);
  });

  it('should factor in credibility', async () => {
    // Create two facts with different source credibility
    const lowCredFact = await facts.create({
      textRefined: 'Low credibility fact',
    });
    const highCredFact = await facts.create({
      textRefined: 'High credibility fact',
    });

    await sources.create({
      factId: lowCredFact.id as string,
      sourceType: 'web',
      credibility: 0.1,
      extractedAt: new Date(),
    });
    await sources.create({
      factId: highCredFact.id as string,
      sourceType: 'web',
      credibility: 0.9,
      extractedAt: new Date(),
    });

    const lowConf = await facts.recalculateConfidence(lowCredFact.id as string);
    const highConf = await facts.recalculateConfidence(
      highCredFact.id as string,
    );

    expect(highConf).toBeGreaterThan(lowConf);
  });

  it('should use corroboration score from metadata', async () => {
    const fact = await facts.create({
      textRefined: 'Corroborated fact',
      metadata: { corroborationScore: 0.8 },
    });

    await sources.create({
      factId: fact.id as string,
      sourceType: 'web',
      credibility: 0.5,
      extractedAt: new Date(),
    });

    const confidence = await facts.recalculateConfidence(fact.id as string);

    // With corroboration score, confidence should be higher
    const withoutCorroboration = calculateConfidence({
      sourceCount: 1,
      avgSourceCredibility: 0.5,
      daysSinceLastSource: 0,
      corroborationScore: 0,
    });

    expect(confidence).toBeGreaterThan(withoutCorroboration);
  });

  it('should throw for nonexistent fact', async () => {
    await expect(facts.recalculateConfidence('nonexistent-id')).rejects.toThrow(
      'Fact not found',
    );
  });

  it('should clamp confidence to [0, 1]', async () => {
    const fact = await facts.create({
      textRefined: 'Max sources fact',
    });
    const factId = fact.id as string;

    // Add many high-credibility sources to push confidence high
    for (let i = 0; i < 15; i++) {
      await sources.create({
        factId,
        sourceType: 'web',
        credibility: 1.0,
        extractedAt: new Date(),
      });
    }

    const confidence = await facts.recalculateConfidence(factId);
    expect(confidence).toBeLessThanOrEqual(1.0);
    expect(confidence).toBeGreaterThanOrEqual(0.0);
  });
});

describe('calculateConfidence utility', () => {
  it('should return base confidence with no inputs', () => {
    const conf = calculateConfidence({ sourceCount: 0 });
    // base(0.5) + source(0) + credibility(0.5*0.2=0.1) + recency(0.1) + corroboration(0) = 0.7
    expect(conf).toBeCloseTo(0.7, 5);
  });

  it('should cap source boost at 0.3', () => {
    const conf10 = calculateConfidence({ sourceCount: 10 });
    const conf20 = calculateConfidence({ sourceCount: 20 });
    // Source boost is capped at 0.3 (10/10), so 20 sources should not add more
    expect(conf10).toBeCloseTo(conf20, 5);
  });

  it('should scale credibility boost', () => {
    const lowCred = calculateConfidence({
      sourceCount: 1,
      avgSourceCredibility: 0.1,
    });
    const highCred = calculateConfidence({
      sourceCount: 1,
      avgSourceCredibility: 1.0,
    });
    expect(highCred).toBeGreaterThan(lowCred);
  });

  it('should decay recency over time', () => {
    const recent = calculateConfidence({
      sourceCount: 1,
      daysSinceLastSource: 0,
    });
    const old = calculateConfidence({
      sourceCount: 1,
      daysSinceLastSource: 15,
    });
    expect(recent).toBeGreaterThan(old);
  });

  it('should add corroboration boost', () => {
    const noCorr = calculateConfidence({
      sourceCount: 1,
      corroborationScore: 0,
    });
    const highCorr = calculateConfidence({
      sourceCount: 1,
      corroborationScore: 1.0,
    });
    expect(highCorr).toBeGreaterThan(noCorr);
  });

  it('should clamp to [0, 1]', () => {
    const maxConf = calculateConfidence({
      sourceCount: 100,
      avgSourceCredibility: 1.0,
      daysSinceLastSource: 0,
      corroborationScore: 1.0,
    });
    expect(maxConf).toBeLessThanOrEqual(1.0);
    expect(maxConf).toBeGreaterThanOrEqual(0.0);
  });
});
