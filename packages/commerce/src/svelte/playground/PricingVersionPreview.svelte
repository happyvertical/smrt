<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';
import PricingVersionDecision from '../components/PricingVersionDecision.svelte';
import QuoteRevisionComparison from '../components/QuoteRevisionComparison.svelte';
import type { PricingVersionData } from '../pricing-types.js';

let readOnly = $state(false);
let error = $state('');
let reason = $state('Retain the revised source scope.');
let outcome = $state('');
const previous: PricingVersionData = {
  id: 'estimate-v1',
  kind: 'customer-estimate',
  label: 'Estimate 1',
  status: 'Superseded',
  counterparty: 'Riverstone Newsroom',
  total: { currency: 'CAD', minorUnitDigits: 2, amountMinor: 125000 },
};
const version: PricingVersionData = {
  id: 'estimate-v2',
  kind: 'customer-estimate',
  label: 'Estimate 2',
  status: 'Awaiting decision',
  counterparty: 'Riverstone Newsroom',
  total: { currency: 'CAD', minorUnitDigits: 2, amountMinor: 145000 },
  reason: 'Additional agreed scope',
  sources: [
    {
      id: 'source-1',
      label: 'Editorial systems quote',
      amountMinor: 145000,
      description: 'Implementation and training; hosting excluded.',
    },
  ],
};
function submit(event: SubmitEvent & { currentTarget: HTMLFormElement }) {
  event.preventDefault();
  const data = new FormData(event.currentTarget, event.submitter);
  reason = String(data.get('reason') ?? '');
  if (data.get('intent') === 'simulate-rejection') {
    error =
      'The source changed. Your reason and request identity are retained for review.';
    outcome = '';
  } else {
    error = '';
    outcome = `Preview decision: ${data.get('intent')}. This example does not save or authorize a financial action.`;
  }
}
</script>
<Button variant="secondary" onclick={() => { readOnly = !readOnly; }}>{readOnly ? 'Show decision controls' : 'Show read-only view'}</Button>
<QuoteRevisionComparison {previous} current={version} />
<PricingVersionDecision {version} action="?pricing-preview" {readOnly} {reason} {error} onsubmit={submit}
  hiddenFields={[{ name: 'requestId', value: 'preview-retained-request' }, { name: 'versionId', value: version.id }]}
  actions={[{ label: 'Preview acceptance', name: 'intent', value: 'accept' }, { label: 'Preview rejection recovery', name: 'intent', value: 'simulate-rejection' }]} />
{#if outcome}<p role="status">{outcome}</p>{/if}
