<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { invoicePreparationMessages as M } from '../invoices/messages.js';
import type { InvoicePreparationReview } from '../invoices/types.js';

/** Caller-authoritative approval/review presentation, without mutation actions. */
export interface Props {
  /** Server snapshot, including caller-localized unknown states. */
  review: InvoicePreparationReview;
}
let { review }: Props = $props();
const { t } = useI18n();
</script>

<section aria-label={t(M['commerce.preparation.review'])} class="invoice-review" aria-live="polite" data-smrt-component="InvoiceReview">
  <strong>{review.label}</strong>
  {#if review.message}<p>{review.message}</p>{/if}
</section>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .invoice-review { padding: var(--smrt-spacing-3); border: 1px solid var(--smrt-color-outline); border-radius: var(--smrt-radius-small); overflow-wrap: anywhere; }
  p { margin-block: var(--smrt-spacing-2) 0; }
}
</style>
