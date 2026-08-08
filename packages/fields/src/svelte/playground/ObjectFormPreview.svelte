<script lang="ts">
/** Generated-form showcase for ObjectForm, including a custom field snippet. */
import { Input } from '@happyvertical/smrt-ui/forms';
import type { ResolvedObjectFieldPolicy } from '../../types.js';
import {
  ObjectForm,
  ObjectFormSourceProvider,
  ObjectFormSourceRegistry,
} from '../index.js';
import type {
  ObjectFormFieldDefinition,
  ObjectFormFieldSnippetProps,
} from '../types.js';

const fields: Record<string, ObjectFormFieldDefinition> = {
  name: { type: 'text', required: true },
  sku: { type: 'text' },
  price: { type: 'decimal', ui: { group: 'Pricing', order: 3 } },
  active: { type: 'boolean', ui: { group: 'Publishing', order: 4 } },
  metadata: { type: 'json', ui: { group: 'Publishing', order: 5 } },
};

const policy: ResolvedObjectFieldPolicy = {
  objectRef: '@happyvertical/smrt-products:Product',
  fields: {
    name: {
      fieldName: 'name',
      hasDefault: false,
      defaultValue: undefined,
      visibility: 'basic',
      help: 'A customer-facing product name.',
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
      help: 'Uses a custom snippet renderer.',
      label: 'SKU',
      order: 2,
      group: null,
      locked: false,
      required: false,
    },
    price: {
      fieldName: 'price',
      hasDefault: false,
      defaultValue: undefined,
      visibility: 'advanced',
      help: null,
      label: 'Price',
      order: 3,
      group: 'Pricing',
      locked: false,
      required: false,
    },
    active: {
      fieldName: 'active',
      hasDefault: true,
      defaultValue: true,
      visibility: 'advanced',
      help: null,
      label: 'Active',
      order: 4,
      group: 'Publishing',
      locked: false,
      required: false,
    },
    metadata: {
      fieldName: 'metadata',
      hasDefault: false,
      defaultValue: undefined,
      visibility: 'advanced',
      help: 'Structured publishing metadata.',
      label: 'Metadata',
      order: 5,
      group: 'Publishing',
      locked: false,
      required: false,
    },
  },
};

const source = new ObjectFormSourceRegistry({
  resolveBatch: async () => ({ policies: { [policy.objectRef]: policy } }),
});
source.register({ objectRef: policy.objectRef, fields });

let record = $state<Record<string, unknown>>({});
</script>

{#snippet skuRenderer(props: ObjectFormFieldSnippetProps)}
  <Input
    id="sku"
    name="sku"
    value={String(props.value ?? '')}
    disabled={props.disabled}
    aria-label="Custom SKU"
    oninput={(event) => props.setValue((event.currentTarget as HTMLInputElement).value.toUpperCase())}
  />
{/snippet}

<section class="object-form-preview">
  <h2>Generated ObjectForm</h2>
  <p>
    This single form is driven by browser-safe fields and resolved policy. Basic
    fields render immediately; advanced grouped fields appear after switching mode.
    SKU is a per-field custom snippet.
  </p>
  <ObjectFormSourceProvider {source}>
    <ObjectForm
      objectRef={policy.objectRef}
      bind:value={record}
      renderers={{ sku: skuRenderer }}
    />
  </ObjectFormSourceProvider>
  <output class="record-preview">{JSON.stringify(record)}</output>
</section>

<style>
  .object-form-preview { display: grid; gap: var(--smrt-spacing-3, 0.75rem); max-width: 40rem; }
  h2, p { margin: 0; }
  .record-preview { font: var(--smrt-typography-body-small-font, monospace); color: var(--smrt-color-on-surface-variant, currentColor); overflow-wrap: anywhere; }
</style>
