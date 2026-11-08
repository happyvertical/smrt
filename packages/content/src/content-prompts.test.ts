import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { clearPromptCache, resolvePrompt } from '@happyvertical/smrt-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Content } from './content';
import {
  smrtContentApplyCorrectionPrompt,
  smrtContentReviewPrompt,
} from './content-prompts';

describe('content prompt definitions', () => {
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

  it('resolves review prompt runtime overrides', async () => {
    const resolved = await resolvePrompt(smrtContentReviewPrompt.key, {
      variables: {
        contentTitle: 'Budget Update',
        reviewPrompt: 'Legacy review prompt',
      },
      override: {
        template: 'Review {contentTitle}: {reviewPrompt}',
        profile: 'test',
        model: 'test-model',
        params: { temperature: 0.1 },
      },
    });

    expect(resolved.text).toBe('Review Budget Update: Legacy review prompt');
    expect(resolved.ai).toMatchObject({
      model: 'test-model',
      params: { temperature: 0.1 },
    });
  });

  it('renders the default review prompt with structured content variables', async () => {
    const resolved = await resolvePrompt(smrtContentReviewPrompt.key, {
      variables: {
        contentBody: 'The draft body.',
        contentDescription: 'A draft description.',
        contentId: 'content-1',
        contentTitle: 'Budget Update',
        kind: 'facts',
        policyKey: 'facts',
        reviewPrompt: 'Legacy review prompt',
      },
    });

    expect(resolved.text).toContain('Content ID: content-1');
    expect(resolved.text).toContain('Review kind: facts');
    expect(resolved.text).toContain('Policy key: facts');
    expect(resolved.text).toContain('Title: Budget Update');
    expect(resolved.text).toContain('Description: A draft description.');
    expect(resolved.text).toContain('The draft body.');
    expect(resolved.text).toContain('Legacy review prompt');
  });

  it('resolves apply-correction prompt variables', async () => {
    const resolved = await resolvePrompt(smrtContentApplyCorrectionPrompt.key, {
      variables: {
        body: 'The old claim.',
        correctedText: 'The corrected claim.',
        incorrectText: 'The old claim.',
        summary: 'Fix the claim.',
      },
    });

    expect(resolved.text).toContain('The old claim.');
    expect(resolved.text).toContain('The corrected claim.');
  });

  it('forwards the apply-correction usage tags to the AI call (#4751)', async () => {
    const message = vi.fn().mockResolvedValue('The corrected body.');
    const content = new Content({
      title: 'Budget Update',
      body: 'A body that does not contain the incorrect text.',
    } as any);
    (content as any)._ai = { message };

    const draft = await (content as any).buildCorrectionDraftSnapshot(
      {
        summary: 'Fix the claim.',
        correctedText: 'The corrected claim.',
        incorrectText: 'Absent text.',
      },
      '',
    );

    expect(draft.metadata.generationMethod).toBe('ai');
    expect(message).toHaveBeenCalledTimes(1);
    expect(message.mock.calls[0][1]?.usageTags).toEqual({
      promptKey: 'smrtContent.applyCorrection',
      promptLayer: 'default',
      templateHash: expect.stringMatching(/^[0-9a-f]{12}$/),
      tierRequested: 'great',
      tierResolved: 'great',
    });
  });
});
