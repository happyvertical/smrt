/**
 * Content subclasses for STI (Single Table Inheritance)
 *
 * These classes inherit from Content and automatically use the shared
 * contents table with _meta_type discriminator.
 */

import { smrt } from '@happyvertical/smrt-core';
import { Content, type ContentOptions } from './content';

/**
 * Article content type
 *
 * Represents editorial content like blog posts, news articles, and written pieces.
 */
@smrt({
  tableStrategy: 'sti',
  api: false,
  mcp: false,
  cli: false,
})
export class Article extends Content {
  constructor(options: ContentOptions = {}) {
    super(options);
    // Article-specific initialization can go here
  }
}

/**
 * ContentDocument content type
 *
 * Represents structured documents like PDFs, reports, and technical documentation.
 */
@smrt({
  tableStrategy: 'sti',
  api: false,
  mcp: false,
  cli: false,
})
export class ContentDocument extends Content {
  constructor(options: ContentOptions = {}) {
    super(options);
    // ContentDocument-specific initialization can go here
  }
}

/**
 * Mirror content type
 *
 * Represents mirrored/cached content from external sources.
 */
@smrt({
  tableStrategy: 'sti',
  api: false,
  mcp: false,
  cli: false,
})
export class Mirror extends Content {
  constructor(options: ContentOptions = {}) {
    super(options);
    // Mirror-specific initialization can go here
  }
}

/**
 * FactualContent type
 *
 * Opt-in base class for apps that want fact-linked authoring, reviews,
 * and correction workflows without forcing every Content record into it.
 */
@smrt({
  tableStrategy: 'sti',
  api: false,
  mcp: false,
  cli: false,
})
export class FactualContent extends Content {
  constructor(options: ContentOptions = {}) {
    super({
      ...options,
      metadata: {
        ...(options.metadata || {}),
        factual: true,
        governance: {
          ...((options.metadata as any)?.governance || {}),
          enabled: true,
          factual: true,
        },
      },
    });
  }

  override isFactual(): boolean {
    return true;
  }
}
