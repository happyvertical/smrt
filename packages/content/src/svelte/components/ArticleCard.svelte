<script lang="ts">
/**
 * ArticleCard - Displays an article preview card
 *
 * Shows article title, excerpt, metadata, and tags in a card format.
 * Links to the full article page.
 */
import { Badge, Card } from '@happyvertical/smrt-ui/ui';
import type { Article } from '../types.js';

export interface Props {
  /** Article data to display */
  article: Article;
  /** Show article excerpt/description */
  showExcerpt?: boolean;
  /** Show publication date */
  showDate?: boolean;
  /** Show author name */
  showAuthor?: boolean;
  /** Show tags */
  showTags?: boolean;
}

const {
  article,
  showExcerpt = true,
  showDate = true,
  showAuthor = true,
  showTags = false,
}: Props = $props();

const _formattedDate = $derived(
  article.publish_date
    ? new Date(article.publish_date).toLocaleDateString('en-US', {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : null,
);

const _tags = $derived.by(() => {
  if (!article.tags) return [];
  // Handle JSON array (as string or actual array)
  if (Array.isArray(article.tags)) return article.tags.filter(Boolean);
  if (typeof article.tags === 'string') {
    // Try parsing as JSON first
    if (article.tags.startsWith('[')) {
      try {
        const parsed = JSON.parse(article.tags);
        return Array.isArray(parsed) ? parsed.filter(Boolean) : [];
      } catch {
        // Fall through to comma-separated
      }
    }
    // Comma-separated string
    return article.tags
      .split(',')
      .map((t: string) => t.trim())
      .filter(Boolean);
  }
  return [];
});
</script>

<a 
  href="/articles/{article.slug}" 
  class="smrt-article-card__root" data-smrt-component="ArticleCard"
>
  <Card hoverable>
    <article>
      <h3 class="smrt-article-card__title" data-smrt-part="title">{article.title}</h3>

      {#if showExcerpt && article.description}
        <p class="smrt-article-card__excerpt" data-smrt-part="body">{article.description}</p>
      {/if}

      <div class="smrt-article-card__meta" data-smrt-part="meta">
        {#if showDate && _formattedDate}
          <time datetime={article.publish_date}>{_formattedDate}</time>
        {/if}

        {#if showAuthor && article.author}
          <span class="smrt-article-card__author" data-smrt-part="item">By {article.author}</span>
        {/if}
      </div>

      {#if showTags && _tags.length > 0}
        <div class="smrt-article-card__tags" data-smrt-part="list">
          {#each _tags as tag}
            <Badge size="sm">{tag}</Badge>
          {/each}
        </div>
      {/if}
    </article>
  </Card>
</a>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-article-card__root {
    display: block;
  }
  article {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-md, 1rem);
  }
  .smrt-article-card__title {
    margin: 0;
  }
  .smrt-article-card__excerpt {
    margin: 0;
  }
  .smrt-article-card__meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-md, 1rem);
    align-items: center;
  }
  .smrt-article-card__tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-sm, 0.5rem);
  }
}

@layer smrt.theme {
  .smrt-article-card__root {
    text-decoration: none;
    color: inherit;
  }
  .smrt-article-card__title {
    font: var(--smrt-typography-title-large-font, 600 1.375rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface);
    transition: color var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }
  .smrt-article-card__root:hover .smrt-article-card__title {
    color: var(--smrt-color-primary);
  }
  .smrt-article-card__root:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: 2px;
    border-radius: var(--smrt-radius-medium, 0.5rem);
  }
  .smrt-article-card__excerpt {
    color: var(--smrt-color-on-surface-variant);
    line-height: var(--smrt-typography-body-large-line-height, 1.5);
  }
  .smrt-article-card__meta {
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-article-card__author {
    font-style: italic;
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-article-card__title {
      transition: none;
    }
  }
}

</style>
