<script lang="ts">
import { Form, FormGroup, Input, Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { HTMLFormAttributes } from 'svelte/elements';
import { P } from '../purchasing-i18n.js';
import type { PurchaseSourceOption } from '../purchasing-types.js';
/** Native source discovery; choosing a source never records a purchase or award. */
export interface Props {
  /** Authorized source options with caller-owned availability and labels. */
  sources: PurchaseSourceOption[];
  /** Selected source ID retained after a failed action. */
  value?: string;
  /** Native source-selection endpoint. */
  action: string;
  /** Field name expected by the caller's route. */
  name?: string;
  /** Caller-owned search/context fields. */
  hiddenFields?: { name: string; value: string }[];
  /** Presentation-only disabled capability. */
  disabled?: boolean;
  /** Optional field validation error. */
  error?: string;
  /** Optional localized field label. */
  label?: string;
  /** Optional caller enhancement; native GET remains enabled by default. */
  onsubmit?: HTMLFormAttributes['onsubmit'];
}
let {
  sources,
  value = '',
  action,
  name = 'source',
  hiddenFields = [],
  disabled = false,
  error,
  label,
  onsubmit,
}: Props = $props();
const { t } = useI18n();
</script>
<div class="purchase-source">
 <Form {action} {onsubmit} method="get" preventDefault={false}>
  {#each hiddenFields as field}<Input type="hidden" name={field.name} value={field.value} />{/each}
  <FormGroup label={label ?? t(P['commerce.purchase.source'])} {error} required>
   <Select {name} {value} disabled={disabled || sources.every(source=>source.disabled)} required density="touch">
    <option value="">{t(P['commerce.purchase.choose'])}</option>
    {#if value && !sources.some(source=>source.id===value)}<option value={value} disabled>{value}</option>{/if}
    {#each sources as source}<option value={source.id} disabled={source.disabled}>{source.vendor} — {source.label}{source.notice ? ` (${source.notice})` : ''}</option>{/each}
   </Select>
  </FormGroup>
  {#if sources.length===0}<p>{t(P['commerce.purchase.empty_sources'])}</p>{/if}
  <Button type="submit" disabled={disabled || sources.every(source=>source.disabled)} density="touch">{t(P['commerce.purchase.use'])}</Button>
 </Form>
</div>
<style>.purchase-source{max-width:48rem;min-width:0;overflow-wrap:anywhere;color:var(--smrt-color-on-surface)}</style>
