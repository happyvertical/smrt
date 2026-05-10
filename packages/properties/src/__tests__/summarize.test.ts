/**
 * Tests for `Property.summarize()` — verifies the smrt-prompts integration:
 * prompt resolution, variable substitution, trimmed AI output, and that
 * internal/PII-adjacent fields (ownerId, repositoryId, tenantId, metadata)
 * are NOT passed to the AI provider.
 *
 * The AI client is stubbed via a `getAiClient()` override so no network calls
 * are made. The `db` plumbing is exercised separately via the smrt-prompts
 * package's own integration tests; here we focus on Property-level behavior.
 */

import { clearPromptCache } from '@happyvertical/smrt-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Property } from '../models/Property.js';
import { smrtPropertiesSummarizePrompt } from '../prompts.js';

describe('Property.summarize()', () => {
  let aiMessageMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    aiMessageMock = vi.fn().mockResolvedValue('Generated summary text  ');
    clearPromptCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeProperty(opts: ConstructorParameters<typeof Property>[0] = {}) {
    const property = new Property({
      name: 'Oak Creek News',
      domain: 'oakcreeknews.com',
      url: 'https://oakcreeknews.com',
      description: 'Local community news for Oak Creek',
      status: 'active',
      // Internal/PII-adjacent fields that should NOT reach the AI provider:
      ownerId: 'owner-profile-uuid-1234',
      repositoryId: 'repo-uuid-5678',
      tenantId: 'tenant-uuid-9999',
      metadata: {
        analyticsId: 'UA-PRIVATE-12345',
        secretKey: 'do-not-leak',
      },
      ...opts,
    });
    // Stub the AI client so summarize doesn't reach a real provider.
    (property as any).getAiClient = async () => ({
      message: aiMessageMock,
    });
    // Stub getZones so we don't need a real DB for this focused test.
    (property as any).getZones = async () => [];
    return property;
  }

  it('uses the registered prompt key', () => {
    expect(smrtPropertiesSummarizePrompt.key).toBe(
      'smrtProperties.property.summarize',
    );
  });

  it('resolves the registered summarize prompt and returns trimmed AI output', async () => {
    const property = makeProperty();

    const result = await property.summarize();

    expect(result).toBe('Generated summary text');
    expect(aiMessageMock).toHaveBeenCalledTimes(1);

    // The prompt sent to the AI should contain the substituted name,
    // domain, description, and status from the registered template.
    const [text] = aiMessageMock.mock.calls[0];
    expect(text).toContain('Oak Creek News');
    expect(text).toContain('oakcreeknews.com');
    expect(text).toContain('Local community news for Oak Creek');
    expect(text).toContain('active');
  });

  it('does NOT pass internal/PII-adjacent fields to the AI provider', async () => {
    const property = makeProperty();

    await property.summarize();

    const [text] = aiMessageMock.mock.calls[0];
    // Foreign-key references that link to identifying records.
    expect(text).not.toContain('owner-profile-uuid-1234');
    expect(text).not.toContain('repo-uuid-5678');
    expect(text).not.toContain('tenant-uuid-9999');
    // Extensible metadata may contain analytics IDs, secrets, or other
    // tenant-private configuration — must not leak into prompts.
    expect(text).not.toContain('UA-PRIVATE-12345');
    expect(text).not.toContain('do-not-leak');
  });

  it('substitutes zone aggregates without leaking zone metadata', async () => {
    const property = makeProperty();
    // Override getZones with a few fake zones to exercise the aggregate
    // substitution path. Zone names are intentionally non-PII labels.
    (property as any).getZones = async () => [
      { id: 'z1', name: 'Home', parentId: null },
      { id: 'z2', name: 'About', parentId: null },
      { id: 'z3', name: 'Header Slot', parentId: 'z1' },
    ];

    await property.summarize();

    const [text] = aiMessageMock.mock.calls[0];
    expect(text).toContain('Total zones: 3');
    expect(text).toContain('Home');
    expect(text).toContain('About');
    // Children of a parent zone should not be listed as top-level entries.
    // The slot is a child of `z1`, so it must not appear in the comma-
    // separated top-level zones list rendered by the template.
    expect(text).toMatch(/Top-level zones:[^\n]*\bHome\b/);
    expect(text).toMatch(/Top-level zones:[^\n]*\bAbout\b/);
    expect(text).not.toMatch(/Top-level zones:[^\n]*\bHeader Slot\b/);
  });

  it('passes empty AI options for the default registered prompt (no ai config)', async () => {
    const property = makeProperty();

    await property.summarize();

    expect(aiMessageMock).toHaveBeenCalledTimes(1);
    // The default registered prompt has no model/temperature/maxTokens/params,
    // so the options object derived by promptMessageOptions should be empty.
    const [, options] = aiMessageMock.mock.calls[0];
    expect(options).toEqual({});
  });

  it('forwards model/temperature/maxTokens from a runtime ai override to ai.message', async () => {
    // Drive promptMessageOptions directly with a synthetic ResolvedPromptAI
    // shape — this exercises the same helper Property.summarize calls and
    // documents the contract for tenant overrides that set ai-config fields.
    const { promptMessageOptions } = await import('../prompts.js');

    const options = promptMessageOptions({
      profile: null,
      model: 'gpt-test-1',
      temperature: 0.42,
      maxTokens: 256,
      params: { topP: 0.9 },
    });

    expect(options).toEqual({
      topP: 0.9,
      model: 'gpt-test-1',
      temperature: 0.42,
      maxTokens: 256,
    });
  });
});
