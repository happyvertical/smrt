<script lang="ts">
import type { SubscriptionPlan } from '../models/SubscriptionPlan.js';

let {
  plans = [],
  selectedPlanKey = null,
  onSelect,
}: {
  plans?: SubscriptionPlan[];
  selectedPlanKey?: string | null;
  onSelect?: (plan: SubscriptionPlan) => void;
} = $props();
</script>

<div class="smrt-plan-picker">
  {#each plans as plan (plan.id)}
    <button
      aria-pressed={plan.planKey === selectedPlanKey}
      class:selected={plan.planKey === selectedPlanKey}
      class="smrt-plan-picker__plan"
      type="button"
      onclick={() => onSelect?.(plan)}
    >
      <span class="smrt-plan-picker__name">{plan.name}</span>
      <span class="smrt-plan-picker__price">
        {new Intl.NumberFormat(undefined, {
          style: 'currency',
          currency: plan.currency,
        }).format(plan.priceAmount)}
        <small>/ {plan.billingInterval}</small>
      </span>
      {#if plan.description}
        <span class="smrt-plan-picker__description">{plan.description}</span>
      {/if}
      <span class="smrt-plan-picker__features">
        {plan.getFeatureKeys().length} features
      </span>
    </button>
  {/each}
</div>

<style>
  .smrt-plan-picker {
    display: grid;
    gap: 0.75rem;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
  }

  .smrt-plan-picker__plan {
    align-items: flex-start;
    background: var(--smrt-surface, #fff);
    border: 1px solid var(--smrt-border, #d8dde6);
    border-radius: var(--smrt-radius-md, 8px);
    color: inherit;
    cursor: pointer;
    display: grid;
    gap: 0.45rem;
    padding: 1rem;
    text-align: left;
  }

  .smrt-plan-picker__plan.selected {
    border-color: var(--smrt-primary, #2563eb);
    box-shadow: 0 0 0 1px var(--smrt-primary, #2563eb);
  }

  .smrt-plan-picker__name {
    font-weight: var(--smrt-typography-weight-bold, 650);
  }

  .smrt-plan-picker__price {
    font-size: var(--smrt-typography-title-large-size, 1.25rem);
    font-weight: var(--smrt-typography-weight-bold, 700);
  }

  .smrt-plan-picker__price small,
  .smrt-plan-picker__description,
  .smrt-plan-picker__features {
    color: var(--smrt-muted, #64748b);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }
</style>
