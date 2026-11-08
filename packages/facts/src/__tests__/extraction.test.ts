import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { clearPromptCache } from '@happyvertical/smrt-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FactCollection } from '../facts';

describe('FactCollection.extractCandidatesFromText()', () => {
  it('extracts atomic fact candidates from fenced JSON responses', async () => {
    const prompts: string[] = [];
    const collection = new FactCollection({
      ai: {
        message: async (prompt: string) => {
          prompts.push(prompt);
          return `\`\`\`json
{
  "facts": [
    {
      "statement": "The agenda scheduled a public hearing for Bylaw 255-2025.",
      "type": "event",
      "sourceExcerpt": "Public Hearing Agenda Bylaw 255-2025",
      "confidence": 0.91
    }
  ]
}
\`\`\``;
        },
      },
    } as any);

    const facts = await collection.extractCandidatesFromText(
      'Public Hearing Agenda Bylaw 255-2025',
      {
        sourceType: 'agenda',
        domain: 'municipal-governance',
        context: 'Meeting: Regular Council Meeting',
      },
    );

    expect(prompts[0]).toContain('source_type');
    expect(prompts[0]).toContain('agenda');
    expect(facts).toEqual([
      {
        statement: 'The agenda scheduled a public hearing for Bylaw 255-2025.',
        type: 'event',
        sourceExcerpt: 'Public Hearing Agenda Bylaw 255-2025',
        confidence: 0.91,
        metadata: undefined,
      },
    ]);
  });

  it('uses smrt-prompts runtime overrides and AI params', async () => {
    const calls: Array<{ prompt: string; options?: Record<string, unknown> }> =
      [];
    const collection = new FactCollection({
      ai: {
        message: async (prompt: string, options?: Record<string, unknown>) => {
          calls.push({ prompt, options });
          return '[{"statement":"Council received the report.","type":"assertion"}]';
        },
      },
    } as any);

    const facts = await collection.extractCandidatesFromText('Report item', {
      maxFacts: 1,
      promptOverride: {
        template: 'Override extraction for {sourceText} as {sourceType}',
        profile: 'test',
        model: 'test-model',
        params: { temperature: 0.2 },
      },
    });

    expect(calls[0]).toEqual({
      prompt: 'Override extraction for Report item as source',
      options: {
        model: 'test-model',
        temperature: 0.2,
        // Prompt-run usage tags (#4751): the runtime override supplied the
        // template, so the layer is `runtime`.
        usageTags: {
          promptKey: 'smrtFacts.extractCandidates',
          promptLayer: 'runtime',
          templateHash: expect.stringMatching(/^[0-9a-f]{12}$/),
        },
      },
    });
    expect(facts[0].statement).toBe('Council received the report.');
  });

  it('extracts material article claims with the article-claim prompt', async () => {
    const prompts: string[] = [];
    const collection = new FactCollection({
      ai: {
        message: async (prompt: string) => {
          prompts.push(prompt);
          return JSON.stringify({
            facts: [
              {
                statement: 'Council approved Bylaw 255-2025.',
                type: 'event',
                sourceExcerpt: 'Council approved Bylaw 255-2025',
                confidence: 0.88,
              },
            ],
          });
        },
      },
    } as any);

    const claims = await collection.extractArticleClaims(
      'Council approved Bylaw 255-2025 after a public hearing.',
      { maxFacts: 3 },
    );

    expect(prompts[0]).toContain('article_text');
    expect(claims[0]).toMatchObject({
      statement: 'Council approved Bylaw 255-2025.',
      type: 'event',
      sourceExcerpt: 'Council approved Bylaw 255-2025',
      confidence: 0.88,
    });
  });

  it('assesses article claim support against candidate facts', async () => {
    const collection = new FactCollection({
      ai: {
        message: async () =>
          JSON.stringify({
            status: 'supported',
            matchedFactIds: ['fact-1'],
            matchedEvidenceIds: ['evidence-1'],
            rationale: 'The agenda fact supports the claim.',
            confidence: 0.92,
          }),
      },
    } as any);

    const assessment = await collection.assessClaimSupport(
      'Council scheduled a public hearing.',
      [
        {
          id: 'fact-1',
          statement: 'The agenda lists a public hearing.',
          evidence: [{ id: 'evidence-1', quote: 'public hearing' }],
        },
      ],
    );

    expect(assessment).toEqual({
      status: 'supported',
      matchedFactIds: ['fact-1'],
      matchedEvidenceIds: ['evidence-1'],
      rationale: 'The agenda fact supports the claim.',
      confidence: 0.92,
    });
  });
});

beforeEach(() => {
  setConfig({
    packages: {
      prompts: {
        profiles: {
          test: { provider: 'test', model: 'test-default-model' },
        },
        allowedModels: ['test-model', 'test-default-model'],
      },
    },
  });
});

afterEach(() => {
  clearCache();
  clearPromptCache();
});

describe('prompt-run usage tags reach the AI call (#4751)', () => {
  const defaultTags = (promptKey: string) => ({
    promptKey,
    promptLayer: 'default',
    templateHash: expect.stringMatching(/^[0-9a-f]{12}$/),
  });

  function capturingCollection(reply: string) {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const message = async (
      _prompt: string,
      options?: Record<string, unknown>,
    ) => {
      calls.push(options);
      return reply;
    };
    const collection = new FactCollection({ ai: { message } } as any);
    return { collection, calls, message };
  }

  beforeEach(() => {
    clearPromptCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('extractCandidatesFromText forwards smrtFacts.extractCandidates', async () => {
    const { collection, calls } = capturingCollection('[]');
    await collection.extractCandidatesFromText('Report item');
    expect(calls[0]?.usageTags).toEqual(
      defaultTags('smrtFacts.extractCandidates'),
    );
  });

  it('extractArticleClaims forwards smrtFacts.extractArticleClaims', async () => {
    const { collection, calls } = capturingCollection('{"facts":[]}');
    await collection.extractArticleClaims('Council approved Bylaw 255-2025.');
    expect(calls[0]?.usageTags).toEqual(
      defaultTags('smrtFacts.extractArticleClaims'),
    );
  });

  it('assessClaimSupport forwards smrtFacts.assessClaimSupport', async () => {
    const { collection, calls } = capturingCollection(
      '{"status":"unsupported","matchedFactIds":[],"matchedEvidenceIds":[],"rationale":"","confidence":0.1}',
    );
    await collection.assessClaimSupport('A claim.', [
      { id: 'fact-1', statement: 'A fact.', evidence: [] },
    ]);
    expect(calls[0]?.usageTags).toEqual(
      defaultTags('smrtFacts.assessClaimSupport'),
    );
  });

  it('binds the tier for an injected client core adopts (#4755)', async () => {
    const calls: Array<Record<string, unknown> | undefined> = [];
    const client = {
      embed: async () => [],
      message: async (_prompt: string, options?: Record<string, unknown>) => {
        calls.push(options);
        return '{"status":"unsupported","matchedFactIds":[],"matchedEvidenceIds":[],"rationale":"","confidence":0.1}';
      },
    };
    const collection = new FactCollection({
      ai: client,
      inference: { tiers: { cheap: { model: 'mini' } } },
    } as any);
    await collection.assessClaimSupport('A claim.', [
      { id: 'fact-1', statement: 'A fact.', evidence: [] },
    ]);
    expect(calls[0]).toMatchObject({
      model: 'mini',
      usageTags: {
        ...defaultTags('smrtFacts.assessClaimSupport'),
        tierRequested: 'cheap',
        tierResolved: 'cheap',
      },
    });
    expect(calls[0]).not.toHaveProperty('tier');
  });

  it('reconcile disambiguation forwards smrtFacts.reconcile on the legacy text route', async () => {
    const { collection, calls, message } = capturingCollection('merge');
    // Legacy route: no typed-decision client, so the text call runs on `ai`.
    (collection as any)._ai = { message };
    vi.spyOn(collection as any, 'attemptDecision').mockResolvedValue(undefined);

    const decision = await (collection as any)._disambiguateWithAI(
      'The sky looks blue',
      { textRefined: 'The sky is blue' },
    );

    expect(decision).toBe('merge');
    // The legacy text route binds the prompt's tier (#4755).
    expect(calls[0]?.usageTags).toEqual({
      ...defaultTags('smrtFacts.reconcile'),
      tierRequested: 'great',
      tierResolved: 'great',
    });
  });
});
