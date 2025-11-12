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
@smrt()
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
@smrt()
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
@smrt()
export class Mirror extends Content {
  constructor(options: ContentOptions = {}) {
    super(options);
    // Mirror-specific initialization can go here
  }
}
