<script lang="ts">
// biome-ignore lint/style/useNamingConvention: Database column names use snake_case
interface Article {
  id: string;
  slug: string;
  title: string;
  description: string | null;
  publish_date: string | null;
  author: string | null;
  tags: string;
}

interface Props {
  article: Article;
  showExcerpt?: boolean;
  showDate?: boolean;
  showAuthor?: boolean;
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

const _tags = $derived(
  article.tags
    ? article.tags
        .split(',')
        .map((t) => t.trim())
        .filter(Boolean)
    : [],
);
</script>

<a href="/articles/{article.slug}" class="article-link">
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
    gap: var(--spacing-md);
  }

  .title {
    margin: 0;
    font-size: var(--font-size-xl);
    font-weight: var(--font-weight-semibold);
    line-height: var(--line-height-tight);
    color: var(--color-text-primary);
    transition: color var(--transition-fast);
  }

  .article-link:hover .title {
    color: var(--color-primary-main);
  }

  .excerpt {
    color: var(--color-text-secondary);
    line-height: var(--line-height-normal);
    margin: 0;
  }

  .meta {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-md);
    align-items: center;
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }

  .author {
    font-style: italic;
  }

  .tags {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-sm);
  }
</style>
