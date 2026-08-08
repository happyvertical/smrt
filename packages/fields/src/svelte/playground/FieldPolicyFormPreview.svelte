<script lang="ts">
/**
 * Playground preview (#2048 AC1): a hand-written widget form that adopts
 * PolicyField on a subset of its fields WITHOUT giving up its markup.
 *
 * The resolved policy is passed as a prop (the headless contract — the app
 * supplies the policy, no smrt-web import). Two fields adopt PolicyField
 * (name, sku) to gain help hints + required markers + prefill; the remaining
 * fields stay as raw hand-written markup, proving "unwrapped fields keep
 * working untouched" and "no layout change".
 *
 * The Basic/Advanced switch + disclosure + form help demonstrate the mode UX
 * and glossary affordances layered over the same hand-written form.
 */
import { Input, Textarea } from '@happyvertical/smrt-ui/forms';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { ResolvedObjectFieldPolicy } from '../../types.js';
import {
  AdvancedFields,
  FieldPolicyProvider,
  FormHelp,
  ModeSwitch,
  PolicyField,
} from '../index.js';

/**
 * A resolved policy shaped exactly like `resolveFieldPolicy()` / the
 * `resolveBatch` endpoint response. In a real app this comes from the server
 * or the batch endpoint; here it is a static fixture for the mock playground.
 */
const resolvedPolicy: ResolvedObjectFieldPolicy = {
  objectRef: '@happyvertical/smrt-products:Product',
  fields: {
    name: {
      fieldName: 'name',
      hasDefault: false,
      defaultValue: undefined,
      visibility: 'basic',
      help: 'The customer-facing product name. Keep it short and unique.',
      label: 'Product name',
      order: 1,
      group: null,
      locked: false,
      required: true,
    },
    sku: {
      fieldName: 'sku',
      hasDefault: true,
      defaultValue: 'SKU-0000',
      visibility: 'basic',
      help: 'Stock-keeping unit. Auto-prefilled from the code default.',
      label: 'SKU',
      order: 2,
      group: null,
      locked: false,
      required: false,
    },
    wholesalePrice: {
      fieldName: 'wholesalePrice',
      hasDefault: true,
      defaultValue: 0,
      visibility: 'advanced',
      help: 'Per-unit price for wholesale channels. Hidden in basic mode.',
      label: 'Wholesale price',
      order: 3,
      group: 'pricing',
      locked: false,
      required: false,
    },
    reorderPoint: {
      fieldName: 'reorderPoint',
      hasDefault: false,
      defaultValue: undefined,
      visibility: 'advanced',
      help: 'Inventory level that triggers a reorder suggestion.',
      label: 'Reorder point',
      order: 4,
      group: 'inventory',
      locked: false,
      required: false,
    },
  },
};

let name = $state('');
let sku = $state('');
let wholesalePrice = $state('');
let reorderPoint = $state('');
// A raw, unwrapped field — deliberately NOT wrapped in PolicyField.
let rawNotes = $state('');

let submitted = $state<string | null>(null);

function handleSubmit() {
  submitted = `Saved "${name || '(unnamed)'}" (sku: ${sku || '(auto)'})`;
}
</script>

<section class="field-policy-preview">
  <header class="preview-header">
    <h2>Hand-written form adopting PolicyField</h2>
    <p class="preview-desc">
      A developer-authored product form. Two fields (name, SKU) adopt
      PolicyField for help, defaults, and progressive disclosure; the rest stay
      hand-written. Toggle the mode switch to reveal advanced-tier fields.
    </p>
    <FormHelp
      objectDescription="A sellable catalog product with wholesale pricing and inventory controls."
    />
  </header>

  <FieldPolicyProvider policy={resolvedPolicy} mode="basic">
    <div class="toolbar">
      <ModeSwitch />
    </div>

    <form class="widget-form" onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
      <!-- Adopted field: gets label, help hint, required marker from the policy -->
      <PolicyField name="name">
        <Input id="name" name="name" bind:value={name} placeholder="Widget Deluxe" />
      </PolicyField>

      <!-- Adopted field: prefilled with the resolved default on new records -->
      <PolicyField name="sku">
        <Input id="sku" name="sku" bind:value={sku} />
      </PolicyField>

      <!-- Unwrapped hand-written field — keeps working untouched -->
      <div class="raw-field">
        <label for="rawNotes">Notes (unwrapped, hand-written)</label>
        <Textarea
          id="rawNotes"
          name="rawNotes"
          bind:value={rawNotes}
          placeholder="Free-form notes, no policy wrapping"
        />
      </div>

      <!-- Advanced-tier fields live in the disclosure -->
      <AdvancedFields>
        <PolicyField name="wholesalePrice">
          <Input id="wholesalePrice" name="wholesalePrice" type="number" bind:value={wholesalePrice} />
        </PolicyField>
        <PolicyField name="reorderPoint">
          <Input id="reorderPoint" name="reorderPoint" type="number" bind:value={reorderPoint} />
        </PolicyField>
      </AdvancedFields>

      <div class="actions">
        <Button type="submit">Save product</Button>
      </div>
    </form>

    {#if submitted}
      <p class="status" role="status">{submitted}</p>
    {/if}
  </FieldPolicyProvider>
</section>

<style>
  .field-policy-preview {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4, 1rem);
    max-width: 40rem;
  }

  .preview-header h2 {
    font: var(--smrt-typography-headline-small-font, inherit);
    margin: 0 0 var(--smrt-spacing-1, 0.25rem);
  }

  .preview-desc {
    font: var(--smrt-typography-body-medium-font, inherit);
    color: var(--smrt-color-on-surface-variant, currentColor);
    margin: 0 0 var(--smrt-spacing-2, 0.5rem);
  }

  .toolbar {
    display: flex;
    justify-content: flex-end;
    margin-bottom: var(--smrt-spacing-3, 0.75rem);
  }

  .widget-form {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-3, 0.75rem);
  }

  .raw-field {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-1, 0.25rem);
  }

  .raw-field label {
    font: var(--smrt-typography-label-large-font, inherit);
    color: var(--smrt-color-on-surface, currentColor);
  }

  .actions {
    display: flex;
    gap: var(--smrt-spacing-2, 0.5rem);
    padding-top: var(--smrt-spacing-2, 0.5rem);
  }

  .status {
    font: var(--smrt-typography-body-medium-font, inherit);
    color: var(--smrt-color-primary, #6750a4);
  }
</style>
