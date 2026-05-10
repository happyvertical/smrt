/**
 * Focused tests for thumbnail AI-prompt registration & resolution.
 *
 * Covers:
 * - registered key correctness
 * - variable substitution (non-PII subset only)
 * - end-to-end flow: AI client receives the substituted prompt, output
 *   surfaces back to the caller
 */
import { clearCache, setConfig } from '@happyvertical/smrt-config';
import { clearPromptCache, resolvePrompt } from '@happyvertical/smrt-prompts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { generateImageMock } = vi.hoisted(() => ({
  generateImageMock: vi.fn(),
}));

const { imageCollectionCreateMock, imageCreateMock, imageSaveMock } =
  vi.hoisted(() => ({
    imageCollectionCreateMock: vi.fn(),
    imageCreateMock: vi.fn(),
    imageSaveMock: vi.fn(),
  }));

vi.mock('@happyvertical/smrt-images', () => ({
  ImageCollection: {
    create: imageCollectionCreateMock,
  },
}));

vi.mock('@happyvertical/ai', () => ({
  // direct-client path is used in these tests, so getAI never resolves a config
  getAI: vi.fn(),
}));

import { smrtContentThumbnailAIGeneratePrompt } from './content-prompts';
import { ThumbnailGenerator } from './thumbnail-generator';

describe('thumbnail AI-prompt registration', () => {
  beforeEach(() => {
    setConfig({
      packages: {
        prompts: {
          profiles: {
            test: { provider: 'test', model: 'test-default-model' },
          },
        },
      },
    });

    imageSaveMock.mockResolvedValue(undefined);
    imageCreateMock.mockResolvedValue({
      id: 'image-1',
      save: imageSaveMock,
    });
    imageCollectionCreateMock.mockResolvedValue({
      create: imageCreateMock,
    });
    generateImageMock.mockResolvedValue({
      images: [{ data: Buffer.from('ai-generated') }],
    });
  });

  afterEach(() => {
    clearCache();
    clearPromptCache();
    generateImageMock.mockReset();
    imageCollectionCreateMock.mockReset();
    imageCreateMock.mockReset();
    imageSaveMock.mockReset();
    vi.restoreAllMocks();
  });

  it('registers the smrtContent.thumbnail.aiGenerate key', () => {
    expect(smrtContentThumbnailAIGeneratePrompt.key).toBe(
      'smrtContent.thumbnail.aiGenerate',
    );
  });

  it('substitutes non-sensitive content variables (no metadata or ids)', async () => {
    const resolved = await resolvePrompt(
      smrtContentThumbnailAIGeneratePrompt.key,
      {
        variables: {
          style: 'photorealistic',
          title: 'Bridge Update',
          styleHint:
            'photorealistic, high quality, professional photography, 8k resolution',
          descriptionClause: 'The article is about: New crossing opens. ',
        },
      },
    );

    expect(resolved.text).toContain('photorealistic');
    expect(resolved.text).toContain('Bridge Update');
    expect(resolved.text).toContain('high quality');
    expect(resolved.text).toContain('New crossing opens');
    // Sanity: the template should not reference any internal/PII fields
    expect(resolved.template).not.toContain('{tenantId}');
    expect(resolved.template).not.toContain('{id}');
    expect(resolved.template).not.toContain('{metadata}');
  });

  it('omits the description clause when content has no description', async () => {
    const resolved = await resolvePrompt(
      smrtContentThumbnailAIGeneratePrompt.key,
      {
        variables: {
          style: 'illustration',
          title: 'Untitled',
          styleHint: 'digital illustration, clean vector art',
          descriptionClause: '',
        },
      },
    );

    expect(resolved.text).toContain('illustration');
    expect(resolved.text).toContain('Untitled');
    expect(resolved.text).not.toContain('The article is about');
  });

  it('honours runtime template overrides at the registered key', async () => {
    const resolved = await resolvePrompt(
      smrtContentThumbnailAIGeneratePrompt.key,
      {
        variables: { style: 'minimal', title: 'Override Test' },
        override: {
          template: 'Generate a {style} cover for "{title}".',
          profile: 'test',
        },
      },
    );

    expect(resolved.text).toBe('Generate a minimal cover for "Override Test".');
    expect(resolved.ai).toMatchObject({ model: 'test-default-model' });
  });

  it('flows the resolved prompt through ThumbnailGenerator to the AI client', async () => {
    const directClient = {
      generateImage: generateImageMock,
    };

    const generator = new ThumbnailGenerator(
      {
        id: 'content-7',
        title: 'Election Guide',
        description: 'Candidates and voting',
        tenantId: null,
      } as any,
      {},
    );

    const image = await generator.generate({
      strategy: 'ai-generate',
      style: 'illustration',
      ai: directClient as any,
    });

    expect(generateImageMock).toHaveBeenCalledTimes(1);
    const [promptArg, optionsArg] = generateImageMock.mock.calls[0];

    // The AI client should receive a prompt assembled by resolvePrompt that
    // contains the substituted title, description, style and styleHint.
    expect(promptArg).toContain('illustration');
    expect(promptArg).toContain('Election Guide');
    expect(promptArg).toContain('Candidates and voting');
    expect(promptArg).toContain('digital illustration');
    expect(promptArg).toContain(
      'suitable for a news article or blog post thumbnail',
    );
    expect(optionsArg).toMatchObject({
      size: '1200x630',
      outputFormat: 'buffer',
    });
    expect(image).toMatchObject({ id: 'image-1' });
  });

  it('respects custom prompts and skips registry resolution when provided', async () => {
    const directClient = { generateImage: generateImageMock };
    const generator = new ThumbnailGenerator(
      {
        id: 'content-8',
        title: 'Should Not Appear',
        description: 'Should not appear either',
        tenantId: null,
      } as any,
      {},
    );

    await generator.generate({
      strategy: 'ai-generate',
      ai: directClient as any,
      prompt: 'Custom prompt — render exactly this',
    });

    expect(generateImageMock).toHaveBeenCalledWith(
      'Custom prompt — render exactly this',
      expect.any(Object),
    );
  });
});
