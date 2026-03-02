# @happyvertical/smrt-content

STI content types (Article, ContentDocument, Mirror) with thumbnail generation, asset associations, and markdown serialization.

## Installation

```bash
pnpm add @happyvertical/smrt-content
```

## Usage

```typescript
import { Content, Contents, Article, Mirror } from '@happyvertical/smrt-content';
import { contentToString, stringToContent } from '@happyvertical/smrt-content';

// Initialize collection
const contents = await Contents.create({
  db: { url: 'sqlite:./content.db' },
});

// Create and save content
const article = new Article({
  title: 'AI in Content Processing',
  body: 'Large language models have revolutionized...',
  status: 'published',
  tags: ['ai', 'nlp'],
  category: 'technology/ai',
});
await article.initialize();
await article.save();

// Mirror content from a URL (idempotent -- returns existing if already mirrored)
const mirrored = await contents.mirror({
  url: 'https://example.com/article.html',
  context: 'research',
  mirrorDir: './cache',
});

// Upsert by slug + context
const doc = await contents.getOrUpsert({
  slug: 'project-notes',
  context: 'docs',
  title: 'Project Notes',
  body: 'Notes content...',
});

// Thumbnail generation (three strategies)
await contents.generateMissingThumbnails({
  strategy: 'headline-card',
  db: { url: 'sqlite:./content.db' },
});

// Export to markdown with YAML frontmatter
const markdown = contentToString(article);
const parsed = stringToContent(markdown);

// Batch export articles as markdown files
await contents.syncContentDir({ contentDir: './blog-posts' });
```

## API

### Classes

| Export | Description |
|--------|------------|
| `Content` | STI base model. Fields: `type`, `variant`, `status`, `state`, `category`, `tags`, `metadata`, `thumbnailAssetId` |
| `Article` | STI subclass for editorial content |
| `ContentDocument` | STI subclass for structured documents |
| `Mirror` | STI subclass for mirrored/cached external content |
| `Contents` | Collection with `mirror()`, `syncContentDir()`, `generateMissingThumbnails()`, `findWithGlobals()`, `getOrUpsert()` |
| `ThumbnailGenerator` | Generates thumbnails via `headline-card`, `static-map`, or `ai-generate` strategies |

### Types

| Export | Description |
|--------|------------|
| `ContentOptions` | Options for `Content` constructor |
| `ContentsOptions` | Options for `Contents.create()` |
| `ThumbnailStrategy` | `'headline-card' \| 'static-map' \| 'ai-generate'` |
| `ThumbnailOptions` | Union of strategy-specific option types |
| `HeadlineCardThumbnailOptions` | Options for headline-card strategy |
| `StaticMapThumbnailOptions` | Options for static-map strategy |
| `AIGenerateThumbnailOptions` | Options for ai-generate strategy |

### Utilities

| Export | Description |
|--------|------------|
| `contentToString(content)` | Serialize content to markdown with YAML frontmatter |
| `stringToContent(str)` | Parse markdown with frontmatter back to content data |

## Dependencies

| Package | Purpose |
|---------|---------|
| `@happyvertical/smrt-core` | ORM base (SmrtObject, SmrtCollection) |
| `@happyvertical/smrt-assets` | Asset association support |
| `@happyvertical/smrt-images` | Image/thumbnail creation |
| `@happyvertical/smrt-tenancy` | Optional tenant scoping |
| `@happyvertical/documents` | Document fetching and text extraction |
| `@happyvertical/files` | Filesystem operations |
| `@happyvertical/geo` | Static map thumbnails |
| `@happyvertical/images` | Headline card rendering |
| `yaml` | YAML frontmatter parsing |
