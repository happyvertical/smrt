<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { Snippet } from 'svelte';
import { Q } from '../quote-i18n.js';
import { type QuoteRevision, quoteMinorText } from '../quote-types.js';
/** Read-only revision evidence, in caller-provided order. */
export interface Props {
  /** Immutable summaries, including unknown caller status labels. */
  revisions: QuoteRevision[];
  /** Optional localized heading. */
  title?: string;
  /** Optional authorized evidence/details for each revision. */
  evidence?: Snippet<[QuoteRevision]>;
}
let { revisions, title, evidence }: Props = $props();
const { t } = useI18n();
</script>
<section class="quote-history" aria-label={title ?? t(Q['commerce.quote.history'])}>
  <h2>{title ?? t(Q['commerce.quote.history'])}</h2>
  <ol>
    {#each revisions as revision (revision.id)}
      <li>
        <article>
          <h3>{revision.label}</h3>
          <p>{t(Q[revision.kind === 'vendor-quotation' ? 'commerce.quote.vendor' : 'commerce.quote.estimate'])} · {revision.counterparty}</p>
          <p>{revision.status}{#if revision.recordedAt} · {revision.recordedAt}{/if}</p>
          <p>{quoteMinorText(revision.total) ?? t(Q['commerce.quote.unknown'])} {revision.total.currency}</p>
          {#if revision.reason}<p>{revision.reason}</p>{/if}
          {#if revision.scope}<p>{revision.scope}</p>{/if}
          {@render evidence?.(revision)}
          {#if revision.href}<Button href={revision.href} variant="secondary" density="touch">{t(Q['commerce.quote.view'])}</Button>{/if}
        </article>
      </li>
    {:else}<li>{t(Q['commerce.quote.empty_history'])}</li>{/each}
  </ol>
</section>
<style>
.quote-history { min-width: 0; color: var(--smrt-color-on-surface); overflow-wrap: anywhere; }
ol { padding-inline-start: var(--smrt-spacing-6, 1.5rem); }
li { margin-block: var(--smrt-spacing-4, 1rem); }
article { padding: var(--smrt-spacing-4, 1rem); border: 1px solid var(--smrt-color-outline-variant); border-radius: var(--smrt-radius-md, 0.5rem); }
</style>
