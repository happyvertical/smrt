/**
 * Tests for `AnalyticsProperty.analyzePerformance()` — verifies the
 * smrt-prompts integration: prompt resolution, variable substitution,
 * and that internal/PII-adjacent fields (`externalId`, `apiSecret`,
 * `measurementId`, `providerMetadata`) are NOT passed to the AI provider.
 *
 * The AI client is stubbed via a `getAiClient()` override so no network
 * calls are made. Mirrors the structural template established in
 * `packages/properties/src/__tests__/summarize.test.ts`.
 */

import { clearPromptCache } from '@happyvertical/smrt-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyticsProperty } from '../models/AnalyticsProperty.js';
import {
  promptMessageOptions,
  smrtAnalyticsAnalyzePerformancePrompt,
} from '../prompts.js';
import { AnalyticsProvider } from '../types/index.js';

describe('AnalyticsProperty.analyzePerformance()', () => {
  let aiMessageMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    aiMessageMock = vi.fn().mockResolvedValue('Performance analysis text  ');
    clearPromptCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeProperty() {
    const property = new AnalyticsProperty({
      name: 'properties/123456789',
      displayName: 'Oak Creek News GA4',
      provider: AnalyticsProvider.GA4,
      // Internal/PII-adjacent fields that should NOT reach the AI provider:
      externalId: 'properties/123456789',
      measurementId: 'G-PRIVATE-MID-1234',
      apiSecret: 'super-secret-ga4-token',
      siteDomain: 'private-site.example.com',
      providerMetadata: JSON.stringify({
        accountId: 'accounts/9999999',
        privateKey: 'do-not-leak',
      }),
    });
    // Stub AI client so analyzePerformance doesn't reach a real provider.
    (property as any).getAiClient = async () => ({
      message: aiMessageMock,
    });
    return property;
  }

  it('uses the registered prompt key', () => {
    expect(smrtAnalyticsAnalyzePerformancePrompt.key).toBe(
      'smrtAnalytics.property.analyzePerformance',
    );
  });

  it('resolves the registered analyzePerformance prompt and returns trimmed analysis', async () => {
    const property = makeProperty();

    const result = await property.analyzePerformance({ period: '14 days' });

    expect(result.action).toBe('analyzePerformance');
    expect(result.period).toBe('14 days');
    expect(result.analysis).toBe('Performance analysis text');
    expect(aiMessageMock).toHaveBeenCalledTimes(1);

    // The prompt sent to the AI should contain the substituted display name,
    // provider, and period from the registered template.
    const [text] = aiMessageMock.mock.calls[0];
    expect(text).toContain('Oak Creek News GA4');
    expect(text).toContain('ga4');
    expect(text).toContain('14 days');
  });

  it('defaults the period to "30 days" when not provided', async () => {
    const property = makeProperty();

    const result = await property.analyzePerformance();

    expect(result.period).toBe('30 days');
    const [text] = aiMessageMock.mock.calls[0];
    expect(text).toContain('30 days');
  });

  it('does NOT pass internal/PII-adjacent fields to the AI provider', async () => {
    const property = makeProperty();

    await property.analyzePerformance();

    const [text] = aiMessageMock.mock.calls[0];
    // Provider identifiers and credentials must never leak into prompts.
    expect(text).not.toContain('properties/123456789');
    expect(text).not.toContain('G-PRIVATE-MID-1234');
    expect(text).not.toContain('super-secret-ga4-token');
    expect(text).not.toContain('private-site.example.com');
    // The providerMetadata blob may carry account IDs / private keys.
    expect(text).not.toContain('accounts/9999999');
    expect(text).not.toContain('do-not-leak');
  });

  it('passes empty AI options for the default registered prompt (no ai config)', async () => {
    const property = makeProperty();

    await property.analyzePerformance();

    expect(aiMessageMock).toHaveBeenCalledTimes(1);
    const [, options] = aiMessageMock.mock.calls[0];
    expect(options).toEqual({});
  });

  it('forwards model/temperature/maxTokens from a runtime ai override via promptMessageOptions', () => {
    // Drive promptMessageOptions directly with a synthetic ResolvedPromptAI
    // shape — the same helper analyzePerformance() routes through.
    const options = promptMessageOptions({
      profile: null,
      model: 'gpt-test-1',
      temperature: 0.42,
      maxTokens: 512,
      params: { topP: 0.95 },
    });

    expect(options).toEqual({
      topP: 0.95,
      model: 'gpt-test-1',
      temperature: 0.42,
      maxTokens: 512,
    });
  });
});
