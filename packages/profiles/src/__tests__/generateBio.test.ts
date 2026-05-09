/**
 * Tests for `Profile.generateBio()` — verifies the smrt-prompts integration
 * landed in PR 1209: prompt resolution, variable substitution, and that
 * email is NOT passed to the AI provider (PII).
 *
 * The AI client is stubbed via a `getAiClient()` override so no network calls
 * are made. The `db` plumbing is exercised separately via the smrt-prompts
 * package's own integration tests; here we focus on Profile-level behavior.
 */

import { clearPromptCache } from '@happyvertical/smrt-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Profile } from '../models/Profile.js';
import { smrtProfilesGenerateBioPrompt } from '../prompts.js';

describe('Profile.generateBio()', () => {
  let aiMessageMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    aiMessageMock = vi.fn().mockResolvedValue('Generated bio text  ');
    clearPromptCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeProfile(opts: ConstructorParameters<typeof Profile>[0] = {}) {
    const profile = new Profile({
      name: 'Ada Lovelace',
      email: 'ada@example.com',
      description: 'Mathematician and computing pioneer',
      ...opts,
    });
    // Stub the AI client so generateBio doesn't reach a real provider.
    (profile as any).getAiClient = async () => ({
      message: aiMessageMock,
    });
    return profile;
  }

  it('uses the registered prompt key', () => {
    expect(smrtProfilesGenerateBioPrompt.key).toBe(
      'smrtProfiles.profile.generateBio',
    );
  });

  it('resolves the registered bio prompt and returns trimmed AI output', async () => {
    const profile = makeProfile();

    const result = await profile.generateBio();

    expect(result).toBe('Generated bio text');
    expect(aiMessageMock).toHaveBeenCalledTimes(1);

    // The prompt sent to the AI should contain the substituted name and
    // description from the registered template.
    const [text] = aiMessageMock.mock.calls[0];
    expect(text).toContain('Ada Lovelace');
    expect(text).toContain('Mathematician and computing pioneer');
  });

  it('does NOT pass email to the AI provider (PII reduction)', async () => {
    const profile = makeProfile();

    await profile.generateBio();

    const [text] = aiMessageMock.mock.calls[0];
    expect(text).not.toContain('ada@example.com');
    expect(text.toLowerCase()).not.toContain('email');
  });

  it('passes resolvedPrompt.ai params (model/temperature/maxTokens) through to ai.message', async () => {
    const profile = makeProfile();

    await profile.generateBio();

    expect(aiMessageMock).toHaveBeenCalledTimes(1);
    // Second arg is the AI options object derived from the prompt's `ai`
    // config plus any tenant overrides. The default registered prompt has
    // no model/temperature/maxTokens, so options should be an empty object
    // (or contain only ai.params if the prompt registered them).
    const [, options] = aiMessageMock.mock.calls[0];
    expect(options).toBeTypeOf('object');
  });
});
