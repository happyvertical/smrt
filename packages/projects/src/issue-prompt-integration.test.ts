import { getAI } from '@happyvertical/ai';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import {
  getTestDatabase,
  setInferenceResolver,
} from '@happyvertical/smrt-core';
import {
  clearPromptCache,
  PromptOverrideCollection,
  PromptRegistry,
} from '@happyvertical/smrt-prompts';
import type { DatabaseInterface } from '@happyvertical/sql';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Issue } from './models/Issue';
import { issueIncorporateFeedbackPrompt } from './prompts';

vi.mock('@happyvertical/ai', () => ({
  getAI: vi.fn(),
}));

describe('Issue prompt integration', () => {
  let db: DatabaseInterface;
  let overrides: PromptOverrideCollection;

  beforeEach(async () => {
    clearCache();
    clearPromptCache();
    PromptRegistry.clear();
    PromptRegistry.register(issueIncorporateFeedbackPrompt as any);
    vi.mocked(getAI).mockReset();

    setConfig({
      packages: {
        prompts: {
          profiles: {
            deep: { provider: 'anthropic', model: 'claude-3-5-haiku' },
          },
          allowedModels: ['claude-3-5-haiku'],
        },
      },
    });

    db = await getTestDatabase({
      type: 'sqlite',
      url: ':memory:',
      classes: ['PromptOverride'],
    });
    overrides = await PromptOverrideCollection.create({ db });
  });

  afterEach(async () => {
    clearCache();
    clearPromptCache();
    PromptRegistry.clear();
    vi.restoreAllMocks();

    if (typeof (db as any)?.close === 'function') {
      await (db as any).close();
    }
  });

  it('uses app-level prompt overrides when incorporating issue feedback', async () => {
    await overrides.create({
      key: issueIncorporateFeedbackPrompt.key,
      tenantId: null,
      template:
        'App override spec:\n{body}\n\nFeedback summary:\n{comments}\n\nReturn the revised spec only.',
      profile: 'deep',
      params: {
        temperature: 0.4,
        maxTokens: 333,
      },
    });

    const issue = new Issue({
      db,
      tenantId: null,
      body: 'Current specification body',
    });

    vi.spyOn(issue, 'getComments').mockResolvedValue([
      {
        author: 'alice',
        body: 'Please add analytics instrumentation.',
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
      },
      {
        author: 'bob',
        body: 'Clarify the rollout plan.',
        createdAt: new Date('2026-01-03T00:00:00.000Z'),
      },
    ] as any);

    const messageSpy = vi.fn(async () => 'Updated spec body');
    vi.mocked(getAI).mockResolvedValue({
      message: messageSpy,
    } as any);

    const result = await issue.incorporateFeedback();

    expect(result).toMatchObject({
      synthesized: 'Updated spec body',
      applied: false,
      commentsAnalyzed: 2,
      previousBody: 'Current specification body',
    });

    expect(getAI).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'anthropic',
        type: 'anthropic',
        model: 'claude-3-5-haiku',
        defaultModel: 'claude-3-5-haiku',
      }),
    );

    expect(messageSpy).toHaveBeenCalledWith(
      expect.stringContaining('App override spec:\nCurrent specification body'),
      expect.objectContaining({
        model: 'claude-3-5-haiku',
        temperature: 0.4,
        maxTokens: 333,
        // Prompt-run usage tags (#4751): the app override supplied the template.
        usageTags: {
          promptKey: issueIncorporateFeedbackPrompt.key,
          promptLayer: 'app',
          templateHash: expect.stringMatching(/^[0-9a-f]{12}$/),
        },
      }),
    );

    const promptText = messageSpy.mock.calls[0]?.[0];
    expect(promptText).toContain(
      '- alice: Please add analytics instrumentation.',
    );
    expect(promptText).toContain('- bob: Clarify the rollout plan.');
  });

  it('takes a stored inference binding over the prompt provider (#4756)', async () => {
    await overrides.create({
      key: issueIncorporateFeedbackPrompt.key,
      tenantId: null,
      template: 'Spec:\n{body}\n{comments}',
      profile: 'deep',
    });
    setInferenceResolver({
      resolve: (request) => ({
        tierResolved: request.tier === 'auto' ? 'good' : request.tier,
        target: {
          provider: 'openai',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'sk-user-binding',
          model: 'user/model',
          source: 'byo',
        },
        via: 'resolver',
      }),
    });
    try {
      const issue = new Issue({ db, tenantId: null, body: 'Body' });
      vi.spyOn(issue, 'getComments').mockResolvedValue([
        { author: 'a', body: 'x', createdAt: new Date() },
      ] as any);
      const messageSpy = vi.fn(async () => 'Updated');
      vi.mocked(getAI).mockResolvedValue({ message: messageSpy } as any);

      await issue.incorporateFeedback();

      expect(getAI).toHaveBeenCalledWith(
        expect.objectContaining({
          provider: 'openai',
          baseUrl: 'https://openrouter.ai/api/v1',
          apiKey: 'sk-user-binding',
          model: 'user/model',
          onUsage: expect.any(Function),
        }),
      );
      expect(messageSpy).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ model: 'user/model' }),
      );
    } finally {
      setInferenceResolver(undefined);
    }
  });

  it('keeps an explicitly injected AI client as the highest-precedence runtime override', async () => {
    await overrides.create({
      key: issueIncorporateFeedbackPrompt.key,
      tenantId: null,
      profile: 'deep',
    });

    const explicitMessage = vi.fn(async () => 'Explicit client synthesis');
    const issue = new Issue({
      db,
      tenantId: null,
      body: 'Current specification body',
      ai: {
        embed: vi.fn(),
        message: explicitMessage,
      } as any,
    });

    vi.spyOn(issue, 'getComments').mockResolvedValue([
      {
        author: 'alice',
        body: 'Please add analytics instrumentation.',
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ] as any);

    const result = await issue.incorporateFeedback();

    expect(result.synthesized).toBe('Explicit client synthesis');
    expect(explicitMessage).toHaveBeenCalledTimes(1);
    expect(getAI).not.toHaveBeenCalled();
    const [, explicitOptions] = explicitMessage.mock.calls[0] as unknown as [
      string,
      Record<string, unknown>,
    ];
    expect(explicitOptions.usageTags).toEqual({
      promptKey: issueIncorporateFeedbackPrompt.key,
      promptLayer: 'default',
      templateHash: expect.stringMatching(/^[0-9a-f]{12}$/),
    });
  });

  it('forwards the usage tags on the do() fallback when no provider resolves (#4751)', async () => {
    const issue = new Issue({
      db,
      tenantId: null,
      body: 'Current specification body',
    });
    vi.spyOn(issue, 'getComments').mockResolvedValue([
      {
        author: 'alice',
        body: 'Please add analytics instrumentation.',
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ] as any);
    const message = vi.fn(
      async (_prompt: string, _options?: Record<string, unknown>) =>
        'Fallback synthesis',
    );
    vi.spyOn(issue as any, 'getAiClient').mockResolvedValue({ message });

    const result = await issue.incorporateFeedback();

    expect(result.synthesized).toBe('Fallback synthesis');
    expect(getAI).not.toHaveBeenCalled();
    expect(message).toHaveBeenCalledTimes(1);
    expect(message.mock.calls[0][1]?.usageTags).toEqual({
      promptKey: issueIncorporateFeedbackPrompt.key,
      promptLayer: 'default',
      templateHash: expect.stringMatching(/^[0-9a-f]{12}$/),
      tierRequested: 'great',
      tierResolved: 'great',
    });
  });

  it('keeps incorporateFeedback curated (no object-dump injection) so the body is not duplicated (#1567)', async () => {
    // No `template` override → the default feedback template is used, which
    // interpolates only {body} and {comments}. Setting `profile: 'deep'`
    // resolves a provider so the synthesis routes through sendPromptMessage().
    await overrides.create({
      key: issueIncorporateFeedbackPrompt.key,
      tenantId: null,
      profile: 'deep',
    });

    const issue = new Issue({
      db,
      tenantId: null,
      title: 'Quarterly Analytics Rollout',
      body: 'Current specification body',
      state: 'open',
    });

    vi.spyOn(issue, 'getComments').mockResolvedValue([
      {
        author: 'alice',
        body: 'Please add analytics instrumentation.',
        createdAt: new Date('2026-01-02T00:00:00.000Z'),
      },
    ] as any);

    const messageSpy = vi.fn(async () => 'Updated spec body');
    vi.mocked(getAI).mockResolvedValue({ message: messageSpy } as any);

    await issue.incorporateFeedback();

    expect(messageSpy).toHaveBeenCalledTimes(1);
    const promptText = messageSpy.mock.calls[0]?.[0] as string;

    // The curated template (body once + comments) is present...
    expect(promptText).toContain('Current specification body');
    expect(promptText).toContain(
      '- alice: Please add analytics instrumentation.',
    );
    // ...but the object is NOT dumped on top. The template already curates the
    // relevant fields, so there is no `toPublicJSON()` content body (which would
    // duplicate the body and leak unrelated fields like `title`).
    expect(promptText).not.toContain('--- Beginning of content ---');
    expect(promptText).not.toContain('Quarterly Analytics Rollout');
    // The body appears exactly once (no duplication from a content-body dump).
    expect(promptText.split('Current specification body')).toHaveLength(2);
  });
});
