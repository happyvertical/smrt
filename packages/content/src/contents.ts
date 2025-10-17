import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { AIClientOptions } from '@have/ai';
import { fetchDocument } from '@have/documents';
import { ensureDirectoryExists } from '@have/files';
import { makeSlug } from '@have/utils';
import type { SmrtCollectionOptions } from '@smrt/core';
import { SmrtCollection } from '@smrt/core';
import YAML from 'yaml';
import { Content } from './content';

/**
 * Configuration options for Contents collection
 */
export interface ContentsOptions extends SmrtCollectionOptions {
  /**
   * AI client configuration options
   */
  ai?: AIClientOptions;

  /**
   * Directory to store content files
   */
  contentDir?: string;
}

/**
 * Collection for managing Content objects
 *
 * The Contents collection provides functionality for managing and manipulating
 * collections of Content objects, including saving to the filesystem and
 * mirroring content from remote URLs.
 */
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
   * Cache of loaded content by key
   */
  private loaded: Map<string, any>;

  /**
   * Creates a new Contents collection
   *
   * Use the static `create()` method inherited from SmrtCollection for proper initialization.
   *
   * @param options - Configuration options
   */
  constructor(options: ContentsOptions) {
    super(options);
    this.options = options; //needed cause redeclare above i think ?
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
      console.error(error);
      throw new Error(`Invalid URL provided: ${options.url}`);
    }
    const existing = await this.get({ url: options.url });
    if (existing) {
      return existing;
    }

    // Fetch and process the document using @have/documents
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

    // Format body as markdown if it's plain text
    let formattedBody = body || '';
    if (body && !this.isMarkdown(body)) {
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

  // public async list(options: {
  //   where?: object;
  //   filter?: object;
  //   offset?: number;
  //   limit?: number;
  // }): Promise<Content[]> {
  //   const { where, filter, offset, limit } = options;

  //   const replacements: any[] = [];
  //   let currIndex = 1;

  //   let whereSql = '';
  //   if (where) {
  //     whereSql = 'where ';
  //     for (const [key, value] of Object.entries(where)) {
  //       whereSql += ` AND ${key} = $${currIndex++}`;
  //       replacements.push(value);
  //     }
  //   }

  //   let whereNotSql = '';
  //   if (filter) {
  //     if (whereSql) {
  //       whereNotSql = ' and ';
  //     } else {
  //       whereNotSql += ' where ';
  //     }
  //     for (const [key, value] of Object.entries(filter)) {
  //       whereNotSql += `${key} != $${currIndex++}`;
  //       replacements.push(value);
  //     }
  //   }

  //   const { rows } = await this._db.query(
  //     `SELECT * FROM contents ${whereSql} ${whereNotSql} LIMIT ${limit} OFFSET ${offset}`,
  //     replacements,
  //   );

  //   return Promise.all(rows.map((row: any) => this.create(row)));
  // }
}
