import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AIClientOptions } from '@happyvertical/ai';
import { fetchDocument } from '@happyvertical/documents';
import { ensureDirectoryExists } from '@happyvertical/files';
import { createLogger } from '@happyvertical/logger';
import type { SmrtCollectionOptions } from '@happyvertical/smrt-core';
import { SmrtCollection, smrt } from '@happyvertical/smrt-core';
import type { Image } from '@happyvertical/smrt-images';
import { makeSlug } from '@happyvertical/utils';
import YAML from 'yaml';
import { htmlToMarkdown, resolveBodyFormat } from './body-format';
import { Content } from './content';
import {
  getEffectiveContentGovernanceConfig,
  loadPersistedContentGovernanceDefinitions,
  resolveEffectiveContentGovernance,
} from './content-governance';
import { serializeContent, serializeFact } from './serialization';
import type {
  ThumbnailOptions,
  ThumbnailStrategy,
} from './thumbnail-generator';

const logger = createLogger({ level: 'info' });

/**
 * Configuration options for Contents collection
 */
export interface ContentsOptions extends SmrtCollectionOptions {
  /**
   * Directory to store content files
   */
  contentDir?: string;
}

function isAIClientOptions(
  ai: SmrtCollectionOptions['ai'],
): ai is AIClientOptions {
  return (
    !!ai &&
    typeof ai === 'object' &&
    !('embed' in ai) &&
    !('generateImage' in ai)
  );
}

/**
 * Collection for managing Content objects
 *
 * The Contents collection provides functionality for managing and manipulating
 * collections of Content objects, including saving to the filesystem and
 * mirroring content from remote URLs.
 */
@smrt({
  api: {
    include: [
      'browseFacts',
      'getBySlug',
      'getGovernanceDefinitionsAction',
      'resolveGovernanceAction',
    ],
    routes: {
      browseFacts: {
        scope: 'collection',
        method: 'GET',
        path: 'facts',
      },
      getBySlug: {
        scope: 'collection',
        method: 'GET',
        path: 'by-slug',
      },
      getGovernanceDefinitionsAction: {
        scope: 'collection',
        method: 'GET',
        path: 'governance',
      },
      resolveGovernanceAction: {
        scope: 'collection',
        method: 'GET',
        path: 'governance/resolve',
      },
    },
  },
  mcp: false,
  cli: false,
})
export class Contents extends SmrtCollection<Content> {
  /**
   * Class constructor for collection items
   */
  static _itemClass = Content;

  /**
   * Configuration options
   */
  public options: ContentsOptions = {} as ContentsOptions;

  /**
   * Directory to store content files
   */
  public contentDir?: string;

  /**
   * Cache for loaded content
   */
  public loaded: Map<string, Content>;

  /**
   * Creates a new Contents collection
   *
   * Use the static `create()` method inherited from SmrtCollection for proper initialization.
   *
   * @param options - Configuration options
   */
  constructor(options: ContentsOptions = {}) {
    super(options);
    this.options = options;
    this.loaded = new Map();
  }

  /**
   * Gets the database interface
   *
   * @returns Database interface
   */
  getDb() {
    return this._db;
  }

  /**
   * Initializes the collection
   *
   * @returns Promise that resolves to this instance
   */
  public async initialize(): Promise<this> {
    await super.initialize();
    return this;
  }

  private async getFactCollection() {
    const { FactCollection } = await import('@happyvertical/smrt-facts');
    return FactCollection.create(this.options);
  }

  public async browseFacts(
    options: {
      q?: string;
      query?: string;
      limit?: number | string;
      offset?: number | string;
      minSimilarity?: number | string;
      includeSuperseded?: boolean | string;
      latestOnly?: boolean | string;
      tenantId?: string | null;
    } = {},
  ) {
    try {
      const facts = await this.getFactCollection();
      const query = options.query || options.q || '';
      const limit =
        options.limit !== undefined ? Number(options.limit) : undefined;
      const offset =
        options.offset !== undefined ? Number(options.offset) : undefined;
      const minSimilarity =
        options.minSimilarity !== undefined
          ? Number(options.minSimilarity)
          : undefined;
      const includeSuperseded =
        options.includeSuperseded === true ||
        options.includeSuperseded === 'true';
      const latestOnly =
        options.latestOnly === undefined
          ? true
          : options.latestOnly === true || options.latestOnly === 'true';

      const results = await facts.browseCatalog(query, {
        limit: Number.isFinite(limit) ? limit : undefined,
        offset: Number.isFinite(offset) ? offset : undefined,
        minSimilarity: Number.isFinite(minSimilarity)
          ? minSimilarity
          : undefined,
        includeSuperseded,
        latestOnly,
        tenantId: options.tenantId ?? null,
      });

      return results.map(serializeFact);
    } catch (error: any) {
      // Gracefully handle missing facts table (cross-package dependency)
      if (error?.code === 'DB_SCHEMA_MISSING') {
        return [];
      }
      throw error;
    }
  }

  public async getBySlug(
    options: { slug?: string; context?: string; status?: string } = {},
  ) {
    if (!options.slug) {
      throw new Error('slug is required');
    }

    const content = await this.get({
      slug: options.slug,
      context: options.context || '',
    });

    if (!content) {
      return null;
    }

    if (options.status && content.status !== options.status) {
      return null;
    }

    return serializeContent(content);
  }

  public async getGovernanceDefinitionsAction() {
    const [effective, persisted] = await Promise.all([
      getEffectiveContentGovernanceConfig({ db: this.db }),
      loadPersistedContentGovernanceDefinitions({ db: this.db }),
    ]);

    return {
      effective: {
        policies: effective.policies.map((policy) => ({
          ...policy,
          ...(persisted.policies.find((item) => item.key === policy.key) || {}),
        })),
        profiles: effective.profiles.map((profile) => ({
          ...profile,
          ...(persisted.profiles.find((item) => item.key === profile.key) ||
            {}),
        })),
        assignments: effective.assignments.map((assignment) => ({
          ...assignment,
          ...(persisted.assignments.find(
            (item) => item.key === assignment.key,
          ) || {}),
        })),
      },
      persisted: {
        policies: persisted.policies,
        profiles: persisted.profiles,
        assignments: persisted.assignments,
      },
    };
  }

  public async resolveGovernanceAction(
    options: { type?: string; variant?: string | null } = {},
  ) {
    return resolveEffectiveContentGovernance({
      contentType: options.type || null,
      contentVariant: options.variant || null,
      db: this.db,
    });
  }

  /**
   * Mirrors content from a remote URL
   *
   * Downloads and stores content from a remote URL, extracting text
   * and saving it as a Content object.
   *
   * @param options - Mirror options
   * @param options.url - URL to mirror
   * @param options.mirrorDir - Directory for caching mirrored files
   * @param options.context - Context for the mirrored content
   * @returns Promise resolving to the mirrored Content object
   * @throws Error if URL is invalid or missing
   */
  public async mirror(options: {
    url: string;
    mirrorDir?: string;
    context?: string;
  }) {
    if (!options.url) {
      throw new Error('No URL provided');
    }
    let url: URL;
    try {
      // const url = new URL(options.url);
      // const existing = await this.db
      //   .oO`SELECT * FROM contents WHERE url = ${options.url}`;
      url = new URL(options.url); // validate url
    } catch (error) {
      logger.error('Invalid URL provided', { error, url: options.url });
      throw new Error(`Invalid URL provided: ${options.url}`);
    }
    const existing = await this.get({ url: options.url });
    if (existing) {
      return existing;
    }

    // Fetch and process the document using @happyvertical/documents
    const doc = await fetchDocument(options.url, {
      cacheDir: options?.mirrorDir,
    });

    const filename = url.pathname.split('/').pop();
    const nameWithoutExtension = filename?.replace(/\.[^/.]+$/, '');
    const title = nameWithoutExtension?.replace(/[-_]/g, ' ');
    const slug = makeSlug(title as string);

    // Extract text from all document parts
    const body = doc.parts.map((part) => part.content).join('\n\n');
    if (body) {
      const content = new Content({
        url: options.url,
        type: 'mirror',
        title,
        slug,
        context: options.context || '',
        body,
      } as any);
      await content.initialize();
      await content.save();
      return content;
    }
  }

  /**
   * Writes a Content object to the filesystem as a markdown file
   *
   * @param options - Options for writing the content file
   * @param options.content - Content object to write
   * @param options.contentDir - Directory to write the file to
   * @returns Promise that resolves when the file is written
   * @throws Error if contentDir is not provided
   */
  public async writeContentFile(options: {
    content: Content;
    contentDir: string;
  }) {
    const { content, contentDir } = options;
    if (!contentDir) {
      throw new Error('No content dir provided');
    }

    const { body } = content;
    const frontMatter = {
      title: content.title,
      slug: content.slug,
      context: content.context,
      author: content.author,
      publish_date: content.publish_date,
    };

    let output = '';
    if (frontMatter && Object.keys(frontMatter).length > 0) {
      output += '---\n';
      output += YAML.stringify(frontMatter);
      output += '---\n';
    }

    // Filesystem exports are markdown regardless of the editor save format.
    let formattedBody = body || '';
    const bodyFormat = resolveBodyFormat(content.bodyFormat, body);
    if (bodyFormat === 'html') {
      formattedBody = htmlToMarkdown(body || '');
    } else if (body && !this.isMarkdown(body)) {
      formattedBody = this.formatAsMarkdown(body);
    }
    output += formattedBody;

    const pathParts = [
      contentDir,
      content.context || '', // if empty, use empty string
      content.slug,
      'index.md',
    ].filter(Boolean); // remove empty strings

    const outputFile = path.join(...(pathParts as string[]));
    await ensureDirectoryExists(path.dirname(outputFile));
    await writeFile(outputFile, output);
  }

  /**
   * Checks if text appears to be in markdown format
   *
   * @param text - Text to check
   * @returns Boolean indicating if the text contains markdown syntax
   */
  private isMarkdown(text: string): boolean {
    // Basic check for common markdown indicators
    const markdownIndicators = [
      /^#\s/m, // Headers
      /\*\*.+\*\*/, // Bold
      /\*.+\*/, // Italic
      /\[.+\]\(.+\)/, // Links
      /^\s*[-*+]\s/m, // Lists
      /^\s*\d+\.\s/m, // Numbered lists
      /```[\s\S]*```/, // Code blocks
      /^\s*>/m, // Blockquotes
    ];

    return markdownIndicators.some((indicator) => indicator.test(text));
  }

  /**
   * Formats plain text as simple markdown
   *
   * @param text - Plain text to format
   * @returns Text formatted as basic markdown
   */
  private formatAsMarkdown(text: string): string {
    // Basic formatting of plain text to markdown
    return text
      .split(/\n\n+/)
      .map((paragraph) => paragraph.trim())
      .filter(Boolean)
      .join('\n\n');
  }

  /**
   * Synchronizes content to the filesystem
   *
   * Writes all article-type Content objects to the filesystem
   * as markdown files.
   *
   * @param options - Sync options
   * @param options.contentDir - Directory to write content files to
   * @returns Promise that resolves when synchronization is complete
   */
  public async syncContentDir(options: { contentDir?: string }) {
    const contentFilter = {
      type: 'article',
    };

    const contents = await this.list({ where: contentFilter });
    for (const content of contents) {
      await this.writeContentFile({
        content,
        contentDir: options.contentDir || this.options.contentDir || '',
      });
    }
  }

  /**
   * Generate thumbnails for content that doesn't have one
   *
   * @param options - Options for bulk thumbnail generation
   * @returns Promise resolving to result object with generated images and failed content IDs
   *
   * @example Generate headline cards for all published articles
   * ```typescript
   * const result = await contents.generateMissingThumbnails({
   *   strategy: 'headline-card',
   *   where: { type: 'article', status: 'published' },
   *   brandColor: '#1a56db'
   * });
   * console.log(`Generated ${result.images.length} thumbnails`);
   * if (result.failed.length > 0) {
   *   console.warn(`Failed to generate ${result.failed.length} thumbnails`);
   * }
   * ```
   */
  public async generateMissingThumbnails(options: {
    /**
     * Thumbnail generation strategy
     */
    strategy: ThumbnailStrategy;

    /**
     * Optional filter for content to process
     */
    where?: Record<string, any>;

    /**
     * Maximum number of thumbnails to generate
     */
    limit?: number;

    // Headline card options
    brandColor?: string;
    backgroundColor?: string;
    logoUrl?: string;
    template?: 'default' | 'news' | 'minimal';

    // Static map options
    mapProvider?: 'mapbox' | 'google';
    zoom?: number;

    // AI options
    style?: 'photorealistic' | 'illustration' | 'abstract' | 'minimal';

    // Common options
    width?: number;
    height?: number;
  }): Promise<{
    images: Image[];
    failed: Array<{ contentId: string; error: string }>;
  }> {
    // Merge with thumbnail config from smrt.config.js (passed via constructor)
    // This allows CLI users to configure defaults in smrt.config.js:
    //   thumbnail: { strategy: 'headline-card', brandColor: '#1976d2' }
    const configDefaults = (this.options as any)?.thumbnail || {};
    const mergedOptions = {
      ...configDefaults,
      ...options,
    };

    // Build query for content missing thumbnails
    const whereClause = {
      ...mergedOptions.where,
      thumbnailAssetId: null,
    };

    const contents = await this.list({
      where: whereClause,
      limit: mergedOptions.limit,
    });

    const generatedImages: Image[] = [];
    const failed: Array<{ contentId: string; error: string }> = [];

    for (const content of contents) {
      try {
        // Build thumbnail options based on strategy
        let thumbnailOptions: ThumbnailOptions;

        switch (mergedOptions.strategy) {
          case 'headline-card':
            thumbnailOptions = {
              strategy: 'headline-card',
              brandColor: mergedOptions.brandColor,
              backgroundColor: mergedOptions.backgroundColor,
              logoUrl: mergedOptions.logoUrl,
              template: mergedOptions.template,
              width: mergedOptions.width,
              height: mergedOptions.height,
            };
            break;

          case 'static-map':
            thumbnailOptions = {
              strategy: 'static-map',
              mapProvider: mergedOptions.mapProvider,
              zoom: mergedOptions.zoom,
              width: mergedOptions.width,
              height: mergedOptions.height,
            };
            break;

          case 'ai-generate':
            thumbnailOptions = {
              strategy: 'ai-generate',
              style: mergedOptions.style,
              width: mergedOptions.width,
              height: mergedOptions.height,
              ai: isAIClientOptions(this.options.ai)
                ? this.options.ai
                : undefined,
            };
            break;

          default:
            throw new Error(`Unknown strategy: ${mergedOptions.strategy}`);
        }

        const image = await content.generateThumbnail(thumbnailOptions);
        generatedImages.push(image);
      } catch (error) {
        const errorMessage =
          error instanceof Error ? error.message : String(error);
        logger.error(
          `Failed to generate thumbnail for content ${content.id}: ${errorMessage}`,
        );
        failed.push({
          contentId: content.id ?? 'unknown',
          error: errorMessage,
        });
      }
    }

    return { images: generatedImages, failed };
  }

  // ============================================
  // Tenant Helper Methods
  // ============================================

  /**
   * Find all content belonging to a specific tenant
   *
   * @param tenantId - The tenant ID to filter by
   * @returns Promise resolving to array of Content objects for the tenant
   *
   * @example
   * ```typescript
   * const tenantContent = await contents.findByTenant('tenant-123');
   * ```
   */
  async findByTenant(tenantId: string): Promise<Content[]> {
    return this.list({ where: { tenantId } });
  }

  /**
   * Find all global content (not associated with any tenant)
   *
   * @returns Promise resolving to array of global Content objects
   *
   * @example
   * ```typescript
   * const globalContent = await contents.findGlobal();
   * ```
   */
  async findGlobal(): Promise<Content[]> {
    return this.list({ where: { tenantId: null } });
  }

  /**
   * Find content for a tenant including global content
   *
   * This returns both tenant-specific content and global content (tenantId is null),
   * useful for showing a tenant their content plus any shared/global resources.
   *
   * @param tenantId - The tenant ID to include
   * @returns Promise resolving to array of Content objects (tenant + global)
   *
   * @example
   * ```typescript
   * const allAccessibleContent = await contents.findWithGlobals('tenant-123');
   * ```
   */
  async findWithGlobals(tenantId: string): Promise<Content[]> {
    return this.query(
      `SELECT * FROM ${this.tableName} WHERE tenant_id = ? OR tenant_id IS NULL`,
      [tenantId],
    );
  }
}
