<script lang="ts">
import Grid from '../layout/Grid.svelte';
import ArticleCard from './ArticleCard.svelte';

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
  articles: Article[];
  columns?: number | 'auto';
  showExcerpt?: boolean;
  showDate?: boolean;
  showAuthor?: boolean;
  showTags?: boolean;
  emptyMessage?: string;
}

// biome-ignore lint/correctness/noUnusedVariables: Variables used in Svelte template
const {
  articles,
  columns = 'auto',
  showExcerpt = true,
  showDate = true,
  showAuthor = true,
  showTags = false,
  emptyMessage = 'No articles published yet. Check back soon for updates!',
}: Props = $props();
</script>

{#if articles.length === 0}
  <div class="empty-state">
    <p>{emptyMessage}</p>
  </div>
{:else}
  <Grid {columns}>
    {#each articles as article (article.id)}
      <ArticleCard
        {article}
        {showExcerpt}
        {showDate}
        {showAuthor}
        {showTags}
      />
    {/each}
  </Grid>
{/if}

<style>
  .empty-state {
    text-align: center;
    padding: var(--spacing-3xl);
    color: var(--color-text-secondary);
  }

  .empty-state p {
    font-size: var(--font-size-lg);
    line-height: var(--line-height-normal);
  }
</style>
