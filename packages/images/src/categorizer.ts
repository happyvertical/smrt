/**
 * ImageCategorizer - AI-powered image categorization
 *
 * Uses @happyvertical/ai to analyze image content and suggest
 * tags, descriptions, and subject classifications.
 */

import type { AIClientOptions } from '@happyvertical/ai';
import type { AssetCollection } from '@happyvertical/smrt-assets';
import type { Image } from './image';
import type { CategoryResult } from './types';

/**
 * Extract the first balanced top-level JSON object substring from arbitrary
 * model output. Unlike a greedy `/\{[\s\S]*\}/` (which spans from the first
 * `{` to the *last* `}` and so swallows trailing prose or a second object,
 * producing invalid JSON), this scans brace depth from the first `{` and stops
 * at its matching `}`, skipping braces that appear inside string literals.
 *
 * @returns the balanced `{...}` substring, or `null` if none is found.
 */
function extractFirstJsonObject(text: string): string | null {
  const start = text.indexOf('{');
  if (start === -1) return null;

  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const ch = text[i];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }

    if (ch === '"') {
      inString = true;
    } else if (ch === '{') {
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0) {
        return text.slice(start, i + 1);
      }
    }
  }

  return null;
}

/**
 * Coerce an arbitrary parsed value into a well-formed `CategoryResult`,
 * defaulting each field so a malformed or partial AI response can never
 * produce a non-iterable `tags`/`subjects` or a missing `description`.
 */
function normalizeCategoryResult(
  parsed: unknown,
  fallbackDescription: string,
): CategoryResult {
  const p = (parsed ?? {}) as Record<string, unknown>;
  return {
    tags: Array.isArray(p.tags) ? (p.tags as string[]) : [],
    description:
      typeof p.description === 'string' && p.description
        ? p.description
        : fallbackDescription,
    confidence: typeof p.confidence === 'number' ? p.confidence : 0,
    subjects: Array.isArray(p.subjects) ? (p.subjects as string[]) : [],
  };
}

export class ImageCategorizer {
  constructor(private readonly options: { ai: AIClientOptions }) {}

  /**
   * Categorize an image using AI vision analysis
   *
   * @param image - The Image instance to categorize
   * @param buffer - Optional raw image data for vision analysis
   * @returns Categorization results with tags, description, and subjects
   */
  async categorize(image: Image, buffer?: Buffer): Promise<CategoryResult> {
    const { getAI } = await import('@happyvertical/ai');
    const ai = await getAI(this.options.ai);

    // TODO: When AI vision API is available, pass buffer for visual analysis
    void buffer;

    const prompt = `Analyze this image and provide categorization.
Image name: ${image.name}
Image description: ${image.description}
MIME type: ${image.mimeType}
Dimensions: ${image.width}x${image.height}

Respond in JSON format:
{
  "tags": ["tag1", "tag2", ...],
  "description": "Brief description of the image content",
  "confidence": 0.0-1.0,
  "subjects": ["subject1", "subject2", ...]
}`;

    const response = await ai.chat([{ role: 'user', content: prompt }]);
    const text = response.content;

    const fallbackDescription = image.description || image.name;

    const jsonText = extractFirstJsonObject(text);
    if (jsonText) {
      try {
        return normalizeCategoryResult(
          JSON.parse(jsonText),
          fallbackDescription,
        );
      } catch {
        // Malformed JSON — fall through to default below.
      }
    }

    return {
      tags: [],
      description: fallbackDescription,
      confidence: 0,
      subjects: [],
    };
  }

  /**
   * Run categorization and apply results to the image
   *
   * @param image - The Image to categorize and update
   * @param assetCollection - AssetCollection for tag management
   */
  async autoTag(image: Image, assetCollection: AssetCollection): Promise<void> {
    const result = await this.categorize(image);

    if (result.description && !image.description) {
      image.description = result.description;
    }

    if (!image.alt && result.description) {
      image.alt = result.description.slice(0, 125);
    }

    await image.save();

    // Add tags via the asset collection. Guard against a non-array `tags`
    // (e.g. a hand-built CategoryResult or future code path that bypasses
    // `normalizeCategoryResult`) so the loop never throws "not iterable".
    for (const tag of result.tags ?? []) {
      await assetCollection.addTag(image.id!, tag);
    }
  }
}
