import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { clearPromptCache, resolvePrompt } from '@happyvertical/smrt-prompts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
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
});
