<script lang="ts">
import { Form, FormGroup, Input, Textarea } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { Snippet } from 'svelte';
import type { HTMLFormAttributes } from 'svelte/elements';
import { PRICING_MESSAGES as M } from '../pricing-i18n.js';
import type {
  PricingDecisionAction,
  PricingHiddenField,
  PricingVersionData,
} from '../pricing-types.js';
import PricingVersionSummary from './PricingVersionSummary.svelte';

export interface Props {
  /** Authorized immutable version snapshot; displaying it records no decision. */
  version: PricingVersionData;
  /** Caller-owned native form destination. */
  action: string;
  /** Explicit available decisions; no acceptance/award action is inferred. */
  actions: readonly PricingDecisionAction[];
  /** Ordered exact hidden values, including caller-owned version/request/tenant tokens. */
  hiddenFields?: readonly PricingHiddenField[];
  /** Retained reason text, including text returned after a rejected action. */
  reason?: string;
  /** Native field name for the reason; omit to use reason. */
  reasonName?: string;
  /** Localized reason label override. */
  reasonLabel?: string;
  /** Whether the server requires a reason for these decisions. */
  reasonRequired?: boolean;
  /** Caller-returned form error; does not reset text or hidden identity. */
  error?: string;
  /** Hide mutation controls for a viewer; this is not server authorization. */
  readOnly?: boolean;
  /** Disable decisions while an application-controlled submission is in flight. */
  busy?: boolean;
  /** Optional progressive enhancement; native submission remains the default. */
  onsubmit?: HTMLFormAttributes['onsubmit'];
  /** Additional caller-owned native fields or decision context within the form. */
  children?: Snippet;
}
const {
  version,
  action,
  actions,
  hiddenFields = [],
  reason = '',
  reasonName = 'reason',
  reasonLabel,
  reasonRequired = false,
  error,
  readOnly = false,
  busy = false,
  onsubmit,
  children,
}: Props = $props();
const { t } = useI18n();
const id = $props.id();
</script>

<section class="pricing-decision">
  <PricingVersionSummary {version} />
  {#if error}<p role="alert">{error}</p>{/if}
  {#if readOnly}
    <p>{t(M['commerce.pricing.read_only'])}</p>
    {#if reason}<p>{reason}</p>{/if}
  {:else if !actions.length}
    <p>{t(M['commerce.pricing.no_actions'])}</p>
  {:else}
    <Form method="POST" {action} preventDefault={false} {onsubmit}>
      {#each hiddenFields as field}<Input type="hidden" name={field.name} value={field.value} />{/each}
      <FormGroup label={reasonLabel ?? t(M['commerce.pricing.reason'])} id={`${id}-reason`}>
        <Textarea id={`${id}-reason`} name={reasonName} value={reason} required={reasonRequired} readonly={busy} />
      </FormGroup>
      {#if children}{@render children()}{/if}
      <div class="decisions">{#each actions as decision}
        <Button type="submit" name={decision.name} value={decision.value} formaction={decision.formAction} disabled={busy || decision.disabled}>{decision.label}</Button>
      {/each}</div>
    </Form>
  {/if}
</section>

<style>
.pricing-decision { min-width: 0; overflow-wrap: anywhere; }
.decisions { display: flex; flex-wrap: wrap; gap: var(--smrt-spacing-3); margin-top: var(--smrt-spacing-3); }
.decisions :global(button) { max-width: 100%; white-space: normal; }
</style>
