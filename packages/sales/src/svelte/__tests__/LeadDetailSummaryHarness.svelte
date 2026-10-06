<script lang="ts">
import LeadDetail from '../components/LeadDetail.svelte';
import type { LeadLinkedOpportunityView } from '../types.js';

interface Props {
  opportunity: LeadLinkedOpportunityView;
}

let { opportunity }: Props = $props();
</script>

<LeadDetail lead={{ id: 'lead-slot', name: 'Slot lead', status: 'qualified' }} {opportunity}>
  {#snippet opportunitySummary(item)}
    <strong data-testid="host-opportunity-summary">Host summary: {item.name} ({item.stageName})</strong>
  {/snippet}
</LeadDetail>
