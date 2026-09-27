import { describe, expect, it, vi } from 'vitest';
import { SmrtCollection } from '../collection';
import { field } from '../decorators';
import type {
  DecisionClient,
  DecisionConfig,
  DecisionRequest,
  EvaluateOptions,
  EvaluationResult,
} from '../index';
import { executeDecision } from '../index';
import { SmrtObject } from '../object';
import { smrt } from '../registry';

const exportedDecisionConfig: DecisionConfig = { type: 'typesafe' };
const exportedEvaluateOptions: EvaluateOptions = { threshold: 0.5 };
const exportedEvaluationResult: EvaluationResult = {
  result: true,
  route: 'decision',
};
const exportedDecisionClient: DecisionClient = {
  getCapabilities: async () => ({ decisions: true }),
  decide: async () => ({
    model: 'test',
    provenance: { provider: 'test', model: 'test' },
    answers: {},
  }),
};
const exportedDecisionRequest: DecisionRequest = {
  state: { content: 'explicitly bounded state' },
  questions: {
    result: { type: 'predicate', instructions: 'is this valid?' },
  },
};
const incompleteDecisionClient: DecisionClient = { decide: async () => ({}) };
void [
  exportedDecisionConfig,
  exportedEvaluateOptions,
  exportedEvaluationResult,
  exportedDecisionClient,
  exportedDecisionRequest,
  incompleteDecisionClient,
];

@smrt()
class DecisionProduct extends SmrtObject {
  @field({ type: 'text' })
  name = '';

  @field({ type: 'text', sensitive: true })
  apiKey = '';
}

class DecisionProductCollection extends SmrtCollection<DecisionProduct> {
  static _itemClass = DecisionProduct;

  async decide(
    request: DecisionRequest,
  ): ReturnType<DecisionProductCollection['attemptDecision']> {
    return await this.attemptDecision(request);
  }
}

function makeGenerativeClient(reply = '{"result": true}') {
  const message = vi.fn(async () => reply);
  return { client: { embed: vi.fn(), message } as any, message };
}

function makeDecisionClient(probability: number) {
  const decide = vi.fn(async () => ({
    model: 'jev-test',
    provenance: { provider: 'typesafe', model: 'jev-test' },
    usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
    answers: { result: { type: 'predicate' as const, probability } },
  }));
  return {
    client: {
      getCapabilities: async () => ({ decisions: true }),
      decide,
    },
    decide,
  };
}

function makeProduct(
  probability?: number,
  generativeReply?: string,
): ReturnType<typeof makeProductWithClients> {
  const decision =
    probability === undefined ? undefined : makeDecisionClient(probability);
  const generative = makeGenerativeClient(generativeReply);
  return makeProductWithClients(generative, decision);
}

function makeProductWithClients(
  generative: ReturnType<typeof makeGenerativeClient>,
  decision?: ReturnType<typeof makeDecisionClient>,
) {
  const product = new DecisionProduct({
    ai: generative.client,
    ...(decision ? { decisions: decision.client } : {}),
  });
  product.name = 'Public product';
  product.apiKey = 'secret-decision-key';
  return { product, generative, decision };
}

describe('SmrtObject.evaluate typed decisions (#3153)', () => {
  it('shares one SDK-typed choice and score batch with collections over explicit state', async () => {
    const decision = {
      getCapabilities: vi.fn(async () => ({ decisions: true })),
      decide: vi.fn(async () => ({
        model: 'jev-test',
        provenance: { provider: 'typesafe', model: 'jev-test' },
        usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
        answers: {
          sentiment: {
            type: 'choice' as const,
            choice: 'positive',
            probabilities: { positive: 0.8, negative: 0.1, neutral: 0.1 },
            confidence: 0.8,
          },
          priority: {
            type: 'score' as const,
            score: 1,
            probabilities: { 0: 0.2, 1: 0.8 },
            confidence: 0.8,
            levels: ['low', 'high'],
          },
        },
      })),
    };
    const request: DecisionRequest = {
      state: { title: 'A bounded title', labels: ['feedback'] },
      questions: {
        sentiment: {
          type: 'choice',
          instructions: 'Choose the sentiment.',
          criteria: { positive: null, negative: null, neutral: null },
        },
        priority: {
          type: 'score',
          instructions: 'Score the priority.',
          criteria: ['low', 'high'],
        },
      },
    };

    await expect(executeDecision(decision, request)).resolves.toMatchObject({
      answers: { sentiment: { choice: 'positive' }, priority: { score: 1 } },
    });

    const collection = new DecisionProductCollection({ decisions: decision });
    await expect(collection.decide(request)).resolves.toMatchObject({
      answers: { sentiment: { choice: 'positive' }, priority: { score: 1 } },
    });
    expect(decision.decide).toHaveBeenCalledTimes(2);
    expect(collection.getAiUsageSnapshot()?.totalCalls).toBe(1);
  });

  it('rejects malformed injected decision answers instead of silently choosing a fallback', async () => {
    const request: DecisionRequest = {
      state: {},
      questions: {
        category: {
          type: 'choice',
          instructions: 'Choose one.',
          criteria: { expected: null },
        },
      },
    };
    const malformed: DecisionClient = {
      getCapabilities: async () => ({ decisions: true }),
      decide: async () => ({
        model: 'jev-test',
        provenance: { provider: 'typesafe', model: 'jev-test' },
        answers: {
          category: {
            type: 'choice',
            choice: 'unexpected',
            probabilities: { unexpected: 1 },
            confidence: 1,
          },
        },
      }),
    };

    await expect(executeDecision(malformed, request)).rejects.toThrow(
      /not a requested option/,
    );
  });

  it('keeps legacy injected predicate responses compatible with provenance-only models and extra answers', async () => {
    const client: DecisionClient = {
      getCapabilities: async () => ({ decisions: true }),
      decide: async () => ({
        model: 'redundant-but-different-model',
        provenance: { provider: 'legacy-injected', model: 'provenance-model' },
        answers: {
          result: { type: 'predicate', probability: 1 },
          retainedLegacyAnswer: { type: 'predicate', probability: 0 },
        },
      }),
    };

    const product = new DecisionProduct({
      ai: makeGenerativeClient().client,
      decisions: client,
    });
    await expect(product.evaluate('is compatible?')).resolves.toMatchObject({
      result: true,
      provenance: { provider: 'legacy-injected', model: 'provenance-model' },
    });
    await expect(
      executeDecision(client, {
        state: {},
        questions: {
          result: { type: 'predicate', instructions: 'is compatible?' },
        },
      }),
    ).resolves.toMatchObject({ model: 'provenance-model' });
  });

  it('reports the documented unsupported-capability error when an injected client omits the optional probe', async () => {
    const request: DecisionRequest = {
      state: {},
      questions: { result: { type: 'predicate', instructions: 'Check it.' } },
    };
    await expect(
      executeDecision({ decide: async () => ({}) }, request),
    ).rejects.toThrow('does not support typed decisions');
  });

  it.each([
    {
      answer: {
        type: 'choice' as const,
        choice: 'expected',
        probabilities: { expected: 0.6 },
        confidence: 0.6,
      },
      message: /must sum to 1/,
    },
    {
      answer: {
        type: 'score' as const,
        score: 2,
        probabilities: { 0: 0.5, 1: 0.5 },
        confidence: 0.5,
        levels: ['low', 'high'],
      },
      message: /outside the requested rubric/,
    },
    {
      answer: {
        type: 'score' as const,
        score: 1,
        probabilities: { 0: 0.5, 1: 0.5 },
        confidence: 0.5,
        levels: ['different', 'high'],
      },
      message: /does not match the requested rubric/,
    },
  ])('rejects malformed injected decision distributions', async ({
    answer,
    message,
  }) => {
    const isChoice = answer.type === 'choice';
    const request: DecisionRequest = {
      state: {},
      questions: {
        answer: isChoice
          ? {
              type: 'choice',
              instructions: 'Choose one.',
              criteria: { expected: null },
            }
          : {
              type: 'score',
              instructions: 'Score one.',
              criteria: ['low', 'high'],
            },
      },
    };
    const client: DecisionClient = {
      getCapabilities: async () => ({ decisions: true }),
      decide: async () => ({
        model: 'jev-test',
        provenance: { provider: 'typesafe', model: 'jev-test' },
        answers: { answer },
      }),
    };

    await expect(executeDecision(client, request)).rejects.toThrow(message);
  });

  it('drives evaluate through the installed SDK adapter with controlled HTTP', async () => {
    const generative = makeGenerativeClient();
    const product = new DecisionProduct({
      ai: generative.client,
      decisions: {
        type: 'typesafe',
        apiKey: 'test-only-key',
        baseUrl: 'https://typesafe.test/v1',
        defaultModel: 'jev-default',
      },
    });
    product.name = 'Public installed product';
    product.apiKey = 'linked-secret';
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    try {
      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: 'jev-actual',
            answers: { result: { type: 'noul', noul: 0.75 } },
            usage: { input_tokens: 4, output_tokens: 2 },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );

      await expect(
        product.evaluate('is suitable?', {
          model: 'jev-override',
          timeout: 250,
        }),
      ).resolves.toEqual({
        result: true,
        probability: 0.75,
        provenance: { provider: 'typesafe', model: 'jev-actual' },
        usage: { promptTokens: 4, completionTokens: 2, totalTokens: 6 },
        route: 'decision',
      });
      expect(fetchMock).toHaveBeenCalledWith(
        'https://typesafe.test/v1/systemone',
        expect.objectContaining({
          method: 'POST',
          signal: expect.anything(),
        }),
      );
      expect(JSON.parse(fetchMock.mock.calls[0]?.[1]?.body)).toEqual({
        state: { content: expect.stringContaining('Public installed product') },
        model: 'jev-override',
        questions: {
          result: { type: 'noul', instructions: 'is suitable?' },
        },
      });
      expect(fetchMock.mock.calls[0]?.[1]?.body).not.toContain('linked-secret');

      fetchMock.mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            model: 'jev-actual',
            answers: { result: { type: 'noul', noul: 2 } },
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } },
        ),
      );
      await expect(product.evaluate('is suitable?')).rejects.toThrow(
        /between 0 and 1/,
      );

      fetchMock.mockRejectedValueOnce(new Error('controlled transport error'));
      await expect(product.evaluate('is suitable?')).rejects.toThrow(
        /Network error calling TypeSafe System One: controlled transport error/,
      );
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('returns typed probability, provenance, and usage at the inclusive threshold', async () => {
    const { product, decision } = makeProduct(0.5);

    await expect(
      product.evaluate('is suitable?', { threshold: 0.5 }),
    ).resolves.toEqual({
      result: true,
      probability: 0.5,
      provenance: { provider: 'typesafe', model: 'jev-test' },
      usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      route: 'decision',
    });
    const request = decision?.decide.mock.calls[0]?.[0];
    expect(request.state.content).toContain('Public product');
    expect(request.state.content).not.toContain('secret-decision-key');
  });

  it('keeps a confident false on the decision route', async () => {
    const { product, generative } = makeProduct(0.1, '{"result": true}');

    await expect(
      product.evaluate('is suitable?', {
        threshold: 0.5,
        uncertaintyFallback: { band: 0.1 },
      }),
    ).resolves.toMatchObject({ result: false, route: 'decision' });
    expect(generative.message).not.toHaveBeenCalled();
  });

  it.each([
    0.45, 0.55,
  ])('uses generative evaluation at the inclusive uncertainty endpoint %s', async (probability) => {
    const { product, generative } = makeProduct(
      probability,
      '{"result": false}',
    );

    await expect(
      product.evaluate('is suitable?', {
        threshold: 0.5,
        uncertaintyFallback: { band: 0.05 },
      }),
    ).resolves.toEqual({
      result: false,
      route: 'generative',
      fallback: 'generative',
      initialDecision: {
        probability,
        provenance: { provider: 'typesafe', model: 'jev-test' },
        usage: { promptTokens: 3, completionTokens: 2, totalTokens: 5 },
      },
    });
    expect(generative.message).toHaveBeenCalledOnce();
  });

  it('preserves is model overrides when uncertainty falls back to generation', async () => {
    const { product, generative } = makeProduct(0.5, '{"result": true}');

    await expect(
      product.is('is suitable?', {
        model: 'legacy-generation-model',
        uncertaintyFallback: { band: 0 },
      }),
    ).resolves.toBe(true);
    expect(generative.message.mock.calls[0]?.[1]).toMatchObject({
      model: 'legacy-generation-model',
    });
  });

  it('routes registered tools through the generative client instead of dropping them', async () => {
    const { product, decision, generative } = makeProduct(
      1,
      '{"result": true}',
    );
    vi.spyOn(product, 'getAvailableTools').mockReturnValue([{} as any]);
    const getDecisionClient = vi.spyOn(product as any, 'getDecisionClient');

    await expect(
      product.evaluate('is suitable?', {
        model: 'jev-decision',
        generativeModel: 'generation-model',
      }),
    ).resolves.toMatchObject({ result: true, route: 'generative' });
    expect(decision?.decide).not.toHaveBeenCalled();
    expect(getDecisionClient).not.toHaveBeenCalled();
    expect(generative.message.mock.calls[0]?.[1]?.tools).toHaveLength(1);
    expect(generative.message.mock.calls[0]?.[1]).toMatchObject({
      model: 'generation-model',
    });
  });

  it('does not initialize an invalid decision configuration when tools select generation', async () => {
    const generative = makeGenerativeClient('{"result": true}');
    const product = new DecisionProduct({
      ai: generative.client,
      decisions: { type: 'invalid' } as any,
    });
    vi.spyOn(product, 'getAvailableTools').mockReturnValue([{} as any]);

    await expect(product.evaluate('is suitable?')).resolves.toMatchObject({
      result: true,
      route: 'generative',
    });
    await expect(
      product.is('is suitable?', {
        model: 'legacy-generation-model',
        threshold: 0.7,
        uncertaintyFallback: { band: 0 },
        generativeModel: 'ignored-generation-model',
      } as any),
    ).resolves.toBe(true);
    const isOptions = generative.message.mock.calls[1]?.[1] as Record<
      string,
      unknown
    >;
    expect(isOptions).toMatchObject({ model: 'legacy-generation-model' });
    expect(isOptions).not.toHaveProperty('threshold');
    expect(isOptions).not.toHaveProperty('uncertaintyFallback');
    expect(isOptions).not.toHaveProperty('generativeModel');
  });

  it('rejects malformed decision responses and never treats them as false', async () => {
    const { product, decision } = makeProduct(1);
    decision?.decide.mockResolvedValueOnce({
      model: 'jev-test',
      provenance: { provider: 'typesafe', model: 'jev-test' },
      answers: { result: { type: 'predicate', probability: Number.NaN } },
    } as any);

    await expect(product.evaluate('is suitable?')).rejects.toThrow(
      /Decision probability/,
    );
  });

  it('never invokes an uncertainty fallback for a decision-provider failure', async () => {
    const { product, decision, generative } = makeProduct(1, '{"result":true}');
    decision?.decide.mockRejectedValueOnce(new Error('provider unavailable'));

    await expect(
      product.evaluate('is suitable?', {
        uncertaintyFallback: { band: 1 },
      }),
    ).rejects.toThrow(/provider unavailable/);
    expect(generative.message).not.toHaveBeenCalled();
  });

  it('keeps legacy is() behavior when no decision client is configured', async () => {
    const { product } = makeProduct(undefined, '{"result":"maybe"}');

    await expect(product.is('is suitable?')).resolves.toBeUndefined();
  });

  it('uses the strict detailed generative contract when decisions are absent', async () => {
    const { product } = makeProduct(undefined, '{"result":false}');

    await expect(product.evaluate('is suitable?')).resolves.toEqual({
      result: false,
      route: 'generative',
    });
  });

  it('does not forward decision controls to the generative route', async () => {
    const { product, generative } = makeProduct(undefined, '{"result":true}');

    await product.evaluate('is suitable?', {
      threshold: 0.7,
      uncertaintyFallback: { band: 0.1 },
      maxDataLength: 12,
    });
    const options = generative.message.mock.calls[0]?.[1] as Record<
      string,
      unknown
    >;
    expect(options).not.toHaveProperty('threshold');
    expect(options).not.toHaveProperty('uncertaintyFallback');
    expect(options).not.toHaveProperty('maxDataLength');
  });
});
