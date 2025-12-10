<script lang="ts">
  import type { PageData } from './$types';
  import { Pagination } from '@happyvertical/svelte';

  let { data }: { data: PageData } = $props();
  const { articles, pagination, siteConfig } = data;

  function formatDate(dateString: string): string {
    return new Date(dateString).toLocaleDateString('en-CA', {
      year: 'numeric',
      month: 'long',
      day: 'numeric',
    });
  }
</script>

<svelte:head>
  <title>{siteConfig.name} - Local News & Weather</title>
  <meta name="description" content={siteConfig.description} />
</svelte:head>

<div class="home">
  <section class="articles">
    <h1>Latest News</h1>

    {#if articles.length === 0}
      <div class="empty-state">
        <p>No articles yet. Run <code>pnpm workflow:praeco</code> to generate content from council meetings.</p>
      </div>
    {:else}
      <div class="article-list">
        {#each articles as article}
          <article class="article-card">
            <a href="/{article.category}/{article.slug}/">
              <h2>{article.title}</h2>
              <p class="description">{article.description}</p>
              <time datetime={article.publish_date}>{formatDate(article.publish_date)}</time>
            </a>
          </article>
        {/each}
      </div>

      {#if pagination.totalPages > 1}
        <Pagination
          currentPage={pagination.currentPage}
          totalPages={pagination.totalPages}
          baseUrl="/page"
        />
      {/if}
    {/if}
  </section>
</div>

<style>
  .home {
    max-width: 800px;
  }

  h1 {
    font-size: var(--font-size-2xl);
    margin-bottom: var(--spacing-lg);
    color: var(--color-neutral-gray900);
  }

  .empty-state {
    padding: var(--spacing-xl);
    background: var(--color-neutral-gray100);
    border-radius: var(--radius-md);
    text-align: center;
  }

  .empty-state code {
    background: var(--color-neutral-gray200);
    padding: var(--spacing-xs) var(--spacing-sm);
    border-radius: var(--radius-sm);
    font-family: monospace;
  }

  .article-list {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-lg);
  }

  .article-card {
    border-bottom: 1px solid var(--color-neutral-gray200);
    padding-bottom: var(--spacing-lg);
  }

  .article-card:last-child {
    border-bottom: none;
  }

  .article-card a {
    text-decoration: none;
    color: inherit;
  }

  .article-card h2 {
    font-size: var(--font-size-xl);
    margin-bottom: var(--spacing-sm);
    color: var(--color-primary);
  }

  .article-card:hover h2 {
    text-decoration: underline;
  }

  .description {
    color: var(--color-neutral-gray700);
    margin-bottom: var(--spacing-sm);
  }

  time {
    font-size: var(--font-size-sm);
    color: var(--color-neutral-gray500);
  }
</style>
