<script lang="ts">
/**
 * ArticleList - Displays a grid of article cards
 *
 * Renders articles in a responsive grid layout with configurable columns.
 */

import { useI18n } from '@happyvertical/smrt-svelte/i18n';
import { Grid } from '@happyvertical/smrt-svelte/layout';
import { M } from '../i18n.contribution.js';
import type { Article } from '../types.js';
import ArticleCard from './ArticleCard.svelte';

const { t } = useI18n();

export interface Props {
  /** Array of articles to display */
  articles: Article[];
  /** Number of columns in grid (or 'auto') */
  columns?: number | 'auto';
  /** Show article excerpts */
  showExcerpt?: boolean;
  /** Show publication dates */
  showDate?: boolean;
  /** Show author names */
  showAuthor?: boolean;
  /** Show tags */
  showTags?: boolean;
  /** Message when no articles */
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
  <div class="empty-state" role="status" aria-live="polite">
    <p>{emptyMessage}</p>
  </div>
{:else}
  <Grid {columns} role="list" aria-label={t(M['content.article_list.aria_label'])}>
    {#each articles as article (article.id)}
      <div role="listitem">
        <ArticleCard
          {article}
          {showExcerpt}
          {showDate}
          {showAuthor}
          {showTags}
        />
      </div>
    {/each}
  </Grid>
{/if}

<style>
  .empty-state {
    text-align: center;
    padding: var(--smrt-spacing-3xl, 3rem);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .empty-state p {
    font: var(--smrt-typography-body-large-font, 1.125rem / 1.5 sans-serif);
  }
</style>
