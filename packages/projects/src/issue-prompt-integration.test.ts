import { getAI } from '@happyvertical/ai';
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { getTestDatabase } from '@happyvertical/smrt-core';
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
      }),
    );

    const promptText = messageSpy.mock.calls[0]?.[0];
    expect(promptText).toContain(
      '- alice: Please add analytics instrumentation.',
    );
    expect(promptText).toContain('- bob: Clarify the rollout plan.');
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
  });
});
