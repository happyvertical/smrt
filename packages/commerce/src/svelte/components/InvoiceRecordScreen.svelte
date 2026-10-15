<script lang="ts">
/**
 * InvoiceRecordScreen composes the published generic record screen with
 * commerce's stored-money projection and host-authorized credit-note action.
 * The host loads `data` server-side with `loadInvoiceRecordScreenData()`.
 */
import {
  RecordScreen,
  type RecordScreenProps,
} from '@happyvertical/smrt-svelte/screens';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { InvoiceRecordScreenData } from '../../invoice-record-screen.js';

export interface InvoiceRecordScreenProps {
  /** Generic record-screen wiring owned by the host application. */
  screen: Omit<
    RecordScreenProps,
    'lineItemStoredTotals' | 'extraActions' | 'children'
  >;
  /** Tenant-scoped persisted invoice facts from `loadInvoiceRecordScreenData`. */
  data: InvoiceRecordScreenData;
  /** Result of the host's server-side authorization check. */
  canCreateCreditNote?: boolean;
  /** Host-owned navigation or mutation after an authorized click. */
  onCreateCreditNote?: () => void;
}

let {
  screen,
  data,
  canCreateCreditNote = false,
  onCreateCreditNote,
}: InvoiceRecordScreenProps = $props();

const showCreditAction = $derived(
  data.kind === 'invoice' &&
    canCreateCreditNote &&
    onCreateCreditNote !== undefined,
);
</script>

{#snippet relatedCredits()}
  {#if data.creditNotes.length > 0}
    <section class="invoice-record-screen__credits" aria-label="Credit notes">
      <h2>Credit notes</h2>
      <ul>
        {#each data.creditNotes as credit (credit.id)}
          <li>
            <strong>{credit.invoiceNumber}</strong>
            <span>{credit.status}</span>
            <time datetime={credit.issueDate}>{credit.issueDate.slice(0, 10)}</time>
          </li>
        {/each}
      </ul>
    </section>
  {/if}
{/snippet}

{#if showCreditAction}
  <RecordScreen {...screen} lineItemStoredTotals={() => data.storedTotals}>
    {#snippet extraActions()}
      <Button variant="secondary" onclick={onCreateCreditNote}>
        Create credit note
      </Button>
    {/snippet}
    {#snippet children()}
      {@render relatedCredits()}
    {/snippet}
  </RecordScreen>
{:else}
  <RecordScreen {...screen} lineItemStoredTotals={() => data.storedTotals}>
    {#snippet children()}
      {@render relatedCredits()}
    {/snippet}
  </RecordScreen>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .invoice-record-screen__credits {
    display: grid;
    gap: var(--smrt-spacing-sm, 0.5rem);
    margin-block-start: var(--smrt-spacing-md, 1rem);
  }
  .invoice-record-screen__credits h2 { margin: 0; font: var(--smrt-typography-title-small); }
  .invoice-record-screen__credits ul { display: grid; gap: var(--smrt-spacing-xs, 0.25rem); margin: 0; padding-inline-start: 1.25rem; }
  .invoice-record-screen__credits li { display: flex; flex-wrap: wrap; gap: var(--smrt-spacing-sm, 0.5rem); color: var(--smrt-color-on-surface); }
  .invoice-record-screen__credits li span, .invoice-record-screen__credits time { color: var(--smrt-color-on-surface-variant); }
}
</style>
