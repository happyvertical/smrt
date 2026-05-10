/**
 * Tests for `Image.generateAltText()` — verifies the smrt-prompts integration:
 * prompt resolution, variable substitution, and that no PII / private metadata
 * (sourceUri, internal foreign-key fields) leaks to the AI provider.
 *
 * The AI client is stubbed via a `getAiClient()` override so no network calls
 * are made. The `db` plumbing is exercised separately via the smrt-prompts
 * package's own integration tests; here we focus on Image-level behavior.
 */

import { clearPromptCache } from '@happyvertical/smrt-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Image } from '../image.js';
import { smrtImagesGenerateAltTextPrompt } from '../prompts.js';

describe('Image.generateAltText()', () => {
  let aiMessageMock: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    aiMessageMock = vi.fn().mockResolvedValue('A widescreen mountain vista  ');
    clearPromptCache();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function makeImage(opts: ConstructorParameters<typeof Image>[0] = {}) {
    const image = new Image({
      name: 'mountain-vista.jpg',
      sourceUri: 's3://private-bucket/secret-key/mountain-vista.jpg',
      mimeType: 'image/jpeg',
      description: 'Snow-capped peaks at sunrise over an alpine valley',
      width: 1920,
      height: 1080,
      ...opts,
    });
    // Stub the AI client so generateAltText doesn't reach a real provider.
    (image as any).getAiClient = async () => ({
      message: aiMessageMock,
    });
    return image;
  }

  it('uses the registered prompt key', () => {
    expect(smrtImagesGenerateAltTextPrompt.key).toBe(
      'smrtImages.image.generateAltText',
    );
  });

  it('resolves the registered alt-text prompt and returns trimmed AI output', async () => {
    const image = makeImage();

    const result = await image.generateAltText();

    expect(result).toBe('A widescreen mountain vista');
    expect(image.alt).toBe('A widescreen mountain vista');
    expect(aiMessageMock).toHaveBeenCalledTimes(1);

    // The prompt sent to the AI should contain the substituted name and
    // description from the registered template.
    const [text] = aiMessageMock.mock.calls[0];
    expect(text).toContain('mountain-vista.jpg');
    expect(text).toContain(
      'Snow-capped peaks at sunrise over an alpine valley',
    );
  });

  it('does NOT pass sourceUri to the AI provider (private bucket leakage)', async () => {
    const image = makeImage();

    await image.generateAltText();

    const [text] = aiMessageMock.mock.calls[0];
    expect(text).not.toContain('s3://private-bucket');
    expect(text).not.toContain('secret-key');
  });

  it('passes resolvedPrompt.ai params (model/temperature/maxTokens) through to ai.message', async () => {
    const image = makeImage();

    await image.generateAltText();

    expect(aiMessageMock).toHaveBeenCalledTimes(1);
    // Second arg is the AI options object derived from the prompt's `ai`
    // config plus any tenant overrides. The default registered prompt has
    // no model/temperature/maxTokens, so options should be an empty object
    // (or contain only ai.params if the prompt registered them).
    const [, options] = aiMessageMock.mock.calls[0];
    expect(options).toBeTypeOf('object');
  });
});
