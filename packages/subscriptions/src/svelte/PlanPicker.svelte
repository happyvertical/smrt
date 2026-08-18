<script lang="ts">
/**
 * Serializable plan shape accepted by PlanPicker. `SubscriptionPlan` model
 * instances satisfy it structurally, but it can also be plain data returned
 * from a SvelteKit `load` — models lose their methods across serialization,
 * so components must not *require* them. `featureKeys` is accepted as an
 * explicit view-model field; `features` supports the framework's normal
 * serialized model shape; and model instances can still use getFeatureKeys().
 */
type SerializedFeatureGrant =
  | string
  | { featureKey?: string; enabled?: boolean };

export interface PlanPickerPlan {
  id?: string;
  planKey: string;
  name: string;
  description?: string | null;
  /** Integer minor units of `currency` — `$19.99` is `1999` (#2401). */
  priceAmount: number;
  currency: string;
  billingInterval: string;
  featureKeys?: string[];
  features?: string | SerializedFeatureGrant[];
  getFeatureKeys?: () => string[];
}

/**
 * Render `priceAmount` for display.
 *
 * The stored value is integer minor units (#2401), and `Intl.NumberFormat`
 * expects major units, so the scale has to be undone here — without it a
 * $10.00 plan renders as $1,000.00.
 *
 * Uses the currency's own minor-unit exponent rather than a hard-coded 100, so
 * zero-decimal currencies (JPY, KRW) are not divided by anything.
 */
function formatPrice(plan: PlanPickerPlan): string {
  const format = new Intl.NumberFormat(undefined, {
    style: 'currency',
    currency: plan.currency,
  });
  const digits = format.resolvedOptions().maximumFractionDigits ?? 2;
  return format.format(plan.priceAmount / 10 ** digits);
}

function featureCount(plan: PlanPickerPlan): number {
  if (plan.featureKeys) return plan.featureKeys.length;
  if (plan.getFeatureKeys) return plan.getFeatureKeys().length;

  try {
    const features =
      typeof plan.features === 'string'
        ? (JSON.parse(plan.features) as unknown)
        : plan.features;
    if (!Array.isArray(features)) return 0;
    return features.filter(
      (feature) =>
        typeof feature === 'string' ||
        (feature !== null &&
          typeof feature === 'object' &&
          'featureKey' in feature &&
          typeof feature.featureKey === 'string' &&
          feature.enabled !== false),
    ).length;
  } catch {
    return 0;
  }
}

let {
  plans = [],
  selectedPlanKey = null,
  onSelect,
}: {
  plans?: PlanPickerPlan[];
  selectedPlanKey?: string | null;
  onSelect?: (plan: PlanPickerPlan) => void;
} = $props();
</script>

<div class="smrt-plan-picker">
  {#each plans as plan (plan.planKey)}
    <!-- raw-primitive-allow: pressable selection card (aria-pressed toggle with multi-line plan summary), not a standard action button -->
    <button
      aria-pressed={plan.planKey === selectedPlanKey}
      class:selected={plan.planKey === selectedPlanKey}
      class="smrt-plan-picker__plan"
      type="button"
      onclick={() => onSelect?.(plan)}
    >
      <span class="smrt-plan-picker__name">{plan.name}</span>
      <span class="smrt-plan-picker__price">
        {formatPrice(plan)}
        <small>/ {plan.billingInterval}</small>
      </span>
      {#if plan.description}
        <span class="smrt-plan-picker__description">{plan.description}</span>
      {/if}
      <span class="smrt-plan-picker__features">
        {featureCount(plan)} features
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
    background: var(--smrt-color-surface, #fff);
    border: 1px solid var(--smrt-color-outline-variant, #d8dde6);
    border-radius: var(--smrt-radius-md, 8px);
    color: inherit;
    cursor: pointer;
    display: grid;
    gap: 0.45rem;
    padding: 1rem;
    text-align: left;
  }

  .smrt-plan-picker__plan.selected {
    border-color: var(--smrt-color-primary, #2563eb);
    box-shadow: 0 0 0 1px var(--smrt-color-primary, #2563eb);
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
    color: var(--smrt-color-on-surface-variant, #64748b);
    font-size: var(--smrt-typography-body-medium-size, 0.875rem);
  }
</style>
