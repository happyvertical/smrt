/**
 * Thumbnail Generator for Content
 *
 * Generates thumbnail images for content using various strategies:
 * - headline-card: Draws article title on branded background
 * - static-map: Uses static maps API for location-based content
 * - ai-generate: Uses AI image generation for creative thumbnails
 */

import type { AIClient, AIClientOptions } from '@happyvertical/ai';
import { fetchStaticMap, type StaticMapProvider } from '@happyvertical/geo';
import {
  generateHeadlineCard,
  type HeadlineCardTemplate,
} from '@happyvertical/images';
import type { DatabaseConfig } from '@happyvertical/smrt-core';
import type { Image } from '@happyvertical/smrt-images';
import { ImageCollection } from '@happyvertical/smrt-images';
import { resolvePrompt } from '@happyvertical/smrt-prompts';
import type { Content } from './content';
import { smrtContentThumbnailAIGeneratePrompt } from './content-prompts';

// ============================================================================
// Types
// ============================================================================

/**
 * Available thumbnail generation strategies
 */
export type ThumbnailStrategy = 'headline-card' | 'static-map' | 'ai-generate';

/**
 * Base options for all strategies
 */
interface BaseThumbnailOptions {
  /**
   * Generation strategy
   */
  strategy: ThumbnailStrategy;

  /**
   * Width in pixels
   * @default 1200
   */
  width?: number;

  /**
   * Height in pixels
   * @default 630
   */
  height?: number;
}

/**
 * Options for headline card strategy
 */
export interface HeadlineCardThumbnailOptions extends BaseThumbnailOptions {
  strategy: 'headline-card';

  /**
   * Primary brand color (hex)
   * @default '#3b82f6'
   */
  brandColor?: string;

  /**
   * Background color (hex)
   * @default '#ffffff'
   */
  backgroundColor?: string;

  /**
   * Optional subtitle/category text
   */
  subtitle?: string;

  /**
   * Optional logo URL
   */
  logoUrl?: string;

  /**
   * Template style
   * @default 'default'
   */
  template?: HeadlineCardTemplate;
}

/**
 * Options for static map strategy
 */
export interface StaticMapThumbnailOptions extends BaseThumbnailOptions {
  strategy: 'static-map';

  /**
   * Map provider
   * @default 'mapbox'
   */
  mapProvider?: StaticMapProvider;

  /**
   * Zoom level (1-20)
   * @default 14
   */
  zoom?: number;

  /**
   * Marker color
   * @default 'e74c3c'
   */
  markerColor?: string;

  /**
   * Mapbox style (if using mapbox provider)
   */
  mapboxStyle?: string;

  /**
   * Google map type (if using google provider)
   */
  googleMapType?: 'roadmap' | 'satellite' | 'terrain' | 'hybrid';
}

/**
 * Options for AI generation strategy
 */
export interface AIGenerateThumbnailOptions extends BaseThumbnailOptions {
  strategy: 'ai-generate';

  /**
   * AI provider configuration
   */
  ai?: AIClientOptions | AIClient;

  /**
   * Custom prompt for image generation
   * If not provided, generates based on content title/body
   */
  prompt?: string;

  /**
   * Style hint for image generation
   * @default 'photorealistic'
   */
  style?: 'photorealistic' | 'illustration' | 'abstract' | 'minimal';
}

/**
 * Union type for all thumbnail options
 */
export type ThumbnailOptions =
  | HeadlineCardThumbnailOptions
  | StaticMapThumbnailOptions
  | AIGenerateThumbnailOptions;

// ============================================================================
// Generator Class
// ============================================================================

/**
 * Options for ThumbnailGenerator
 */
export interface ThumbnailGeneratorOptions {
  /**
   * Database configuration for storing generated images
   */
  db?: DatabaseConfig;

  /**
   * Alias for `db` — mirrors the `SmrtClassOptions.persistence` alias so
   * callers can pass the same options shape they use for SmrtObject/Collection.
   *
   * @deprecated Prefer `db`. Retained for parity with `SmrtClassOptions`.
   */
  persistence?: DatabaseConfig;

  /**
   * AI client configuration for AI-generated thumbnails
   */
  ai?: AIClientOptions | AIClient;
}

interface ImageGenerationClient {
  generateImage(
    prompt: string,
    options?: Record<string, unknown>,
  ): Promise<{
    images?: Array<{ data?: Buffer | string }>;
  }>;
}

function isImageGenerationClient(
  value: AIClientOptions | AIClient,
): value is AIClient & ImageGenerationClient {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as Record<string, unknown>).generateImage === 'function'
  );
}

function isAIClientOptions(
  value: AIClientOptions | AIClient,
): value is AIClientOptions {
  return (
    !!value && typeof value === 'object' && !isImageGenerationClient(value)
  );
}

/**
 * ThumbnailGenerator creates thumbnails for content using various strategies
 */
export class ThumbnailGenerator {
  constructor(
    private content: Content,
    private options: ThumbnailGeneratorOptions = {},
  ) {}

  /**
   * Generate a thumbnail using the specified strategy
   */
  async generate(options: ThumbnailOptions): Promise<Image> {
    switch (options.strategy) {
      case 'headline-card':
        return this.generateHeadlineCard(options);
      case 'static-map':
        return this.generateStaticMap(options);
      case 'ai-generate':
        return this.generateWithAI(options);
      default:
        throw new Error(
          `Unknown thumbnail strategy: ${(options as any).strategy}`,
        );
    }
  }

  /**
   * Generate a headline card thumbnail
   */
  private async generateHeadlineCard(
    options: HeadlineCardThumbnailOptions,
  ): Promise<Image> {
    const title = this.content.title || this.content.name || 'Untitled';

    const result = await generateHeadlineCard(title, {
      width: options.width ?? 1200,
      height: options.height ?? 630,
      brandColor: options.brandColor,
      backgroundColor: options.backgroundColor,
      subtitle: options.subtitle ?? this.content.category ?? undefined,
      logoUrl: options.logoUrl,
      template: options.template,
    });

    return this.createImageFromBuffer(result.buffer, {
      width: result.width,
      height: result.height,
      mimeType: result.mimeType,
      name: `${this.content.id}-headline.png`,
    });
  }

  /**
   * Generate a static map thumbnail
   */
  private async generateStaticMap(
    options: StaticMapThumbnailOptions,
  ): Promise<Image> {
    const rawLatitude =
      this.content.metadata?.latitude ?? this.content.metadata?.lat;
    const rawLongitude =
      this.content.metadata?.longitude ??
      this.content.metadata?.lng ??
      this.content.metadata?.lon;

    if (rawLatitude == null || rawLongitude == null) {
      throw new Error(
        'Content metadata must contain latitude and longitude for static-map strategy',
      );
    }

    // Parse and validate coordinates
    // Use unary + for strict parsing (rejects "45invalid" unlike parseFloat)
    const latitude =
      typeof rawLatitude === 'string' ? +rawLatitude : rawLatitude;
    const longitude =
      typeof rawLongitude === 'string' ? +rawLongitude : rawLongitude;

    if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
      throw new Error(
        `Invalid latitude value "${rawLatitude}" in content metadata; expected a number between -90 and 90.`,
      );
    }

    if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
      throw new Error(
        `Invalid longitude value "${rawLongitude}" in content metadata; expected a number between -180 and 180.`,
      );
    }

    type FetchStaticMapOptions = NonNullable<
      Parameters<typeof fetchStaticMap>[2]
    >;
    const mapboxStyle = options.mapboxStyle as
      | FetchStaticMapOptions['mapboxStyle']
      | undefined;

    const result = await fetchStaticMap(latitude, longitude, {
      provider: options.mapProvider ?? 'mapbox',
      width: options.width ?? 1200,
      height: options.height ?? 630,
      zoom: options.zoom ?? 14,
      markerColor: options.markerColor,
      mapboxStyle,
      googleMapType: options.googleMapType,
    });

    return this.createImageFromBuffer(result.buffer, {
      width: result.width,
      height: result.height,
      mimeType: result.mimeType,
      name: `${this.content.id}-map.png`,
    });
  }

  /**
   * Generate a thumbnail using AI image generation
   */
  private async generateWithAI(
    options: AIGenerateThumbnailOptions,
  ): Promise<Image> {
    // Dynamic import to avoid requiring AI package when not using this strategy
    const { getAI } = await import('@happyvertical/ai');

    const aiInput = options.ai ?? this.options.ai;
    if (!aiInput) {
      throw new Error(
        'AI configuration required for ai-generate strategy. Provide via options.ai or constructor options.',
      );
    }

    const ai = isImageGenerationClient(aiInput)
      ? aiInput
      : isAIClientOptions(aiInput)
        ? await getAI(aiInput)
        : (() => {
            throw new Error(
              'AI client does not support image generation for ai-generate thumbnails.',
            );
          })();

    // Generate prompt if not provided
    const prompt =
      options.prompt ??
      (await this.buildAIPrompt(options.style ?? 'photorealistic'));

    // Generate the image using the new API signature
    const width = options.width ?? 1200;
    const height = options.height ?? 630;
    const result = await ai.generateImage(prompt, {
      size: `${width}x${height}`,
      outputFormat: 'buffer',
    });

    if (!result.images || result.images.length === 0) {
      throw new Error('AI image generation returned no results');
    }

    // Handle buffer or base64 responses
    let buffer: Buffer;
    const imageData = result.images[0].data;
    if (Buffer.isBuffer(imageData)) {
      buffer = imageData;
    } else if (typeof imageData === 'string') {
      // Could be base64 or URL - try base64 first
      if (imageData.startsWith('http')) {
        const response = await fetch(imageData);
        buffer = Buffer.from(await response.arrayBuffer());
      } else {
        buffer = Buffer.from(imageData, 'base64');
      }
    } else {
      throw new Error('AI image generation returned unexpected format');
    }

    return this.createImageFromBuffer(buffer, {
      width: options.width ?? 1200,
      height: options.height ?? 630,
      mimeType: 'image/png',
      name: `${this.content.id}-ai.png`,
    });
  }

  /**
   * Build a prompt for AI image generation based on content.
   *
   * Resolves via `@happyvertical/smrt-prompts` so tenants can override the
   * template/profile/model/params at runtime. Only non-PII content fields
   * (title, description) and the caller-supplied style hint are passed.
   * Internal IDs and the freeform `metadata` blob are intentionally excluded.
   */
  private async buildAIPrompt(style: string): Promise<string> {
    const title = this.content.title || 'Untitled';
    const description = this.content.description || '';

    const stylePrompts: Record<string, string> = {
      photorealistic:
        'photorealistic, high quality, professional photography, 8k resolution',
      illustration:
        'digital illustration, clean vector art, modern design, vibrant colors',
      abstract:
        'abstract art, geometric shapes, modern minimalist, artistic interpretation',
      minimal:
        'minimalist design, simple shapes, clean composition, subtle colors',
    };

    const styleHint = stylePrompts[style] || stylePrompts.photorealistic;

    const resolved = await resolvePrompt(
      smrtContentThumbnailAIGeneratePrompt.key,
      {
        db: this.options.db ?? this.options.persistence,
        tenantId: this.content.tenantId,
        variables: {
          style,
          title,
          styleHint,
          descriptionClause: description
            ? `The article is about: ${description}. `
            : '',
        },
      },
    );

    return resolved.text;
  }

  /**
   * Create an Image object from a buffer
   */
  private async createImageFromBuffer(
    buffer: Buffer,
    metadata: {
      width: number;
      height: number;
      mimeType: string;
      name: string;
    },
  ): Promise<Image> {
    const images = await (ImageCollection as any).create({
      db: this.options.db,
    });

    // Create the image record
    const image = await images.create({
      name: metadata.name,
      mimeType: metadata.mimeType,
      width: metadata.width,
      height: metadata.height,
      sourceUri: `data:${metadata.mimeType};base64,${buffer.toString('base64')}`,
    });

    await image.save();

    return image;
  }
}
