<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Q } from '../quote-i18n.js';
import {
  type QuoteRevision,
  quoteMinorText,
  quoteRevisionDelta,
} from '../quote-types.js';
import QuoteRevisionHistory from './QuoteRevisionHistory.svelte';
/** Compare retained versions without selecting prices, accepting estimates or awarding work. */
export interface Props {
  /** Earlier retained version. */
  previous: QuoteRevision;
  /** Later retained version. */
  current: QuoteRevision;
  /** Optional localized heading. */
  title?: string;
}
let { previous, current, title }: Props = $props();
const { t } = useI18n();
const delta = $derived(quoteRevisionDelta(previous, current));
</script>
<section class="quote-comparison" aria-label={title ?? t(Q['commerce.quote.compare'])}>
  <h2>{title ?? t(Q['commerce.quote.compare'])}</h2>
  <div class="versions">
    <QuoteRevisionHistory revisions={[previous]} title={t(Q['commerce.quote.before'])} />
    <QuoteRevisionHistory revisions={[current]} title={t(Q['commerce.quote.after'])} />
  </div>
  {#if delta}<p>{t(Q['commerce.quote.delta'])}: {quoteMinorText(delta)} {delta.currency}</p>
  {:else}<p>{t(Q['commerce.quote.incomparable'])}</p>{/if}
</section>
<style>
.quote-comparison { min-width: 0; color: var(--smrt-color-on-surface); overflow-wrap: anywhere; }
.versions { display: grid; grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr)); gap: var(--smrt-spacing-4, 1rem); }
</style>
