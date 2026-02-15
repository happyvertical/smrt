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

    try {
      const jsonMatch = text.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        return JSON.parse(jsonMatch[0]) as CategoryResult;
      }
    } catch {
      // Fall through to default
    }

    return {
      tags: [],
      description: image.description || image.name,
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

    // Add tags via the asset collection
    for (const tag of result.tags) {
      await assetCollection.addTag(image.id!, tag);
    }
  }
}
