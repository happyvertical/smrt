/**
 * Image model - Asset subclass for image files
 *
 * Represents an image asset with dimensions and accessibility text.
 * Uses STI (Single Table Inheritance) - stored in the assets table with _meta_type='Image'.
 *
 * For semantic search on images, use the centralized embedding system:
 * @smrt({ embeddings: { fields: ['alt', 'description'] } })
 */

import { Asset } from '@happyvertical/smrt-assets';
import { field, smrt } from '@happyvertical/smrt-core';
import { resolvePrompt } from '@happyvertical/smrt-prompts';
import { TenantScoped } from '@happyvertical/smrt-tenancy';
import {
  promptMessageOptions,
  smrtImagesGenerateAltTextPrompt,
} from './prompts';
import type { ImageOptions } from './types';

// The @TenantScoped decorator registers only the exact class name it's applied
// to — it does NOT propagate to STI subclasses. Asset is `@TenantScoped`, but
// without re-declaring it here `isTenantScopedClass('Image')` is false, so the
// tenancy interceptor would neither tenant-filter Image's `list()` queries nor
// guard its raw SQL. Re-declaring it (matching Asset's `mode: 'optional'`)
// registers Image too, so the interceptor scopes Image collection reads by
// tenant. The inherited `tenantId` field needs no re-declaration. (#1407)
@TenantScoped({ mode: 'optional' })
@smrt({
  api: { include: ['list', 'get', 'create', 'update', 'delete'] },
  mcp: { include: ['list', 'get', 'create', 'update', 'generateAltText'] },
  cli: true,
})
export class Image extends Asset {
  // Core image dimensions (regular columns for querying)
  @field()
  width: number = 0;
  @field()
  height: number = 0;

  // Accessibility text
  @field()
  alt: string = '';

  constructor(options: ImageOptions = {}) {
    super(options);
    if (options.width !== undefined) this.width = options.width;
    if (options.height !== undefined) this.height = options.height;
    if (options.alt !== undefined) this.alt = options.alt;
  }

  /**
   * Calculate aspect ratio from dimensions
   */
  get aspectRatio(): number {
    if (this.height === 0) return 0;
    return this.width / this.height;
  }

  /**
   * Helper to get URL from sourceUri for frontend components
   */
  get url(): string {
    return this.sourceUri;
  }

  /**
   * Check if dimensions indicate landscape orientation
   */
  get isLandscape(): boolean {
    return this.width > this.height;
  }

  /**
   * Check if dimensions indicate portrait orientation
   */
  get isPortrait(): boolean {
    return this.height > this.width;
  }

  /**
   * Check if dimensions indicate square aspect ratio
   */
  get isSquare(): boolean {
    return this.width === this.height && this.width > 0;
  }

  /**
   * Validate that the asset is an image based on MIME type
   */
  isValidImageFormat(): boolean {
    return this.mimeType.startsWith('image/');
  }

  /**
   * Check if this image is high resolution (4K+)
   */
  isHighResolution(): boolean {
    return this.width >= 3840 || this.height >= 2160;
  }

  /**
   * AI-powered: Generate accessibility alt text for this image.
   *
   * Uses the `smrtImages.image.generateAltText` prompt registered via
   * `@happyvertical/smrt-prompts`, allowing tenant- or instance-level
   * overrides of the template, model, and parameters at runtime.
   *
   * Only non-PII metadata fields (name, description) are sent to the AI
   * provider. Source URIs, internal foreign-key fields, and the
   * extensible `metadata` blob are intentionally excluded — source URIs
   * may embed signed/private bucket paths and metadata may contain EXIF
   * GPS data or tenant-private configuration.
   *
   * @returns AI-generated alt text describing the image
   */
  async generateAltText(): Promise<string> {
    // Resolve `db` from either the canonical `db` option or its `persistence`
    // alias. SmrtClass maps `persistence → db` lazily during `initialize()`,
    // so on a freshly-constructed Image that has not yet been initialized,
    // `this.options.db` may be undefined while `this.options.persistence` is
    // set. Falling back here ensures stored app- and tenant-level prompt
    // overrides in `_smrt_prompt_overrides` are honored on the first call —
    // before `getAiClient()` triggers full initialization further below.
    const db = this.options.db ?? this.options.persistence;

    const resolvedPrompt = await resolvePrompt(
      smrtImagesGenerateAltTextPrompt.key,
      {
        db,
        tenantId: this.tenantId,
        variables: {
          imageName: this.name || '',
          imageDescription: this.description || '',
        },
      },
    );

    const ai = await this.getAiClient();
    const response = await ai.message(
      resolvedPrompt.text,
      promptMessageOptions(resolvedPrompt.ai),
    );

    const altText = response.trim();
    this.alt = altText;
    return altText;
  }
}
