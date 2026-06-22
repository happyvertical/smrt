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
  class="article-link"
>
  <Card hoverable>
    <article>
      <h3 class="title">{article.title}</h3>

      {#if showExcerpt && article.description}
        <p class="excerpt">{article.description}</p>
      {/if}

      <div class="meta">
        {#if showDate && _formattedDate}
          <time datetime={article.publish_date}>{_formattedDate}</time>
        {/if}

        {#if showAuthor && article.author}
          <span class="author">By {article.author}</span>
        {/if}
      </div>

      {#if showTags && _tags.length > 0}
        <div class="tags">
          {#each _tags as tag}
            <Badge size="sm">{tag}</Badge>
          {/each}
        </div>
      {/if}
    </article>
  </Card>
</a>

<style>
  .article-link {
    text-decoration: none;
    color: inherit;
    display: block;
  }

  article {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-md, 1rem);
  }

  .title {
    margin: 0;
    font: var(--smrt-typography-title-large-font, 600 1.375rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
    transition: color var(--smrt-duration-short2, 150ms) var(--smrt-easing-standard, ease);
  }

  .article-link:hover .title {
    color: var(--smrt-color-primary, #005ac1);
  }

  .article-link:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: 2px;
    border-radius: var(--smrt-radius-medium, 0.5rem);
  }

  .excerpt {
    color: var(--smrt-color-on-surface-variant, #43474e);
    line-height: var(--smrt-typography-body-large-line-height, 1.5);
    margin: 0;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-md, 1rem);
    align-items: center;
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .author {
    font-style: italic;
  }

  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-sm, 0.5rem);
  }

  @media (prefers-reduced-motion: reduce) {
    .title {
      transition: none;
    }
  }
</style>
