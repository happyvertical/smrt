# @happyvertical/smrt-content

Content processing module for SMRT framework - handles documents, web content, and media.

## Svelte Components

This package includes Svelte 5 UI components for content display.

### Installation

```bash
npm install @happyvertical/smrt-content
```

### Usage

```typescript
import {
  ArticleCard,
  ArticleList,
  Markdown,
} from '@happyvertical/smrt-content/svelte';
```

### Components

- **ArticleCard** - Article preview card with title, excerpt, and metadata
- **ArticleList** - Grid or list of article cards
- **Markdown** - Markdown content renderer

### Types

```typescript
import type {
  Article,
  ArticleCardProps,
  ArticleListProps,
  MarkdownProps,
} from '@happyvertical/smrt-content/svelte';
```

### Auto-registration

Importing from `/svelte` auto-registers components with `ModuleUIRegistry`:

```typescript
import '@happyvertical/smrt-content/svelte'; // Auto-registers all components

// Later, retrieve from registry
const Component = ModuleUIRegistry.get('@happyvertical/smrt-content', 'article-card');
```
