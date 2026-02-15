/**
 * ImageDeriver - Creates new images from source images + AI prompts
 *
 * Combines multiple source images with creative prompts to generate
 * new derivative images, tracking provenance via AssetAssociation.
 */

import type { AIClientOptions } from '@happyvertical/ai';
import type {
  AssetAssociationCollection,
  AssetStore,
} from '@happyvertical/smrt-assets';
import type { Image } from './image';
import type { ImageCollection } from './images';
import type { DeriveOptions } from './types';

export class ImageDeriver {
  constructor(
    private readonly store: AssetStore,
    private readonly collection: ImageCollection,
    private readonly options: { ai: AIClientOptions },
  ) {}

  /**
   * Derive new images from source images and a creative prompt
   *
   * @param sources - One or more source images
   * @param prompt - Creative instructions for generation
   * @param deriveOptions - Generation options (count, size, style)
   * @returns Array of newly created derivative Images
   */
  async derive(
    sources: Image[],
    prompt: string,
    deriveOptions: DeriveOptions = {},
  ): Promise<Image[]> {
    if (sources.length === 0) {
      throw new Error('At least one source image is required');
    }

    const { getAI } = await import('@happyvertical/ai');
    const ai = await getAI(this.options.ai);

    const count = deriveOptions.count ?? 1;
    const results: Image[] = [];

    const fullPrompt = [
      prompt,
      deriveOptions.style ? `Style: ${deriveOptions.style}` : '',
      deriveOptions.size ? `Output size: ${deriveOptions.size}` : '',
      `Source images: ${sources.map((s) => s.name).join(', ')}`,
    ]
      .filter(Boolean)
      .join('\n');

    for (let i = 0; i < count; i++) {
      const response = await ai.generateImage(fullPrompt, {
        size: deriveOptions.size,
      });

      const imageData = response.images[0]?.data;
      if (!imageData || !(imageData instanceof Buffer)) {
        throw new Error('AI did not return image data as Buffer');
      }
      const result = imageData;

      const derived = (await this.collection.create({
        name: `derived-${sources[0].name}-${i + 1}`,
        mimeType: 'image/png',
        sourceUri: '',
        parentId: sources[0].id,
        typeSlug: 'image',
        description: `Derived: ${prompt}`,
      })) as Image;

      const sourceUri = await this.store.storeFile(derived, result, {
        mimeType: 'image/png',
        typeSlug: 'image',
      });
      derived.sourceUri = sourceUri;
      await derived.save();

      results.push(derived);
    }

    return results;
  }

  /**
   * Derive images and link all sources via AssetAssociation
   *
   * @param sources - Source images
   * @param prompt - Creative instructions
   * @param associations - AssetAssociationCollection for linking
   * @param deriveOptions - Generation options
   * @returns Array of newly created derivative Images
   */
  async deriveWithAssociations(
    sources: Image[],
    prompt: string,
    associations: AssetAssociationCollection,
    deriveOptions: DeriveOptions = {},
  ): Promise<Image[]> {
    const results = await this.derive(sources, prompt, deriveOptions);

    // Link all source images to each derived image
    for (const derived of results) {
      for (const source of sources) {
        await associations.associate(
          source.id!,
          'Image',
          derived.id!,
          'derivation-source',
        );
      }
    }

    return results;
  }
}
