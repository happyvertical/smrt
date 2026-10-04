<script lang="ts">
import {
  CurrencySelect,
  Form,
  FormGroup,
  Input,
  Select,
  Textarea,
} from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { expenseMessages as M } from '../messages.js';
import type { ExpenseDraftValues, ExpenseFormProps } from '../types.js';
/** Native expense entry preserving every caller-owned submitted value. */
export interface Props extends ExpenseFormProps {}
let {
  action,
  values,
  id,
  title,
  canEdit = true,
  correcting = false,
  vendors = [],
  commitments = [],
  currencyOptions,
  fields = {},
  errors = {},
  message,
  hiddenFields = [],
  intentField = 'intent',
  intent = 'save',
  submitLabel,
  pending = false,
  retryStatus = 'idle',
  children,
  onsubmit,
}: Props = $props();
const i18n = useI18n();
const { t } = i18n;
const instanceId = $props.id();
const formId = $derived(id ?? `expense-form-${instanceId}`);
const busy = $derived(
  pending || retryStatus === 'submitting' || retryStatus === 'busy',
);
const textFields: (keyof ExpenseDraftValues)[] = [
  'amount',
  'currency',
  'incurredOn',
  'category',
  'paidByProfileId',
];
function name(field: keyof ExpenseDraftValues) {
  return fields[field] ?? field;
}
</script>
<section class="expense-form" aria-labelledby={`${formId}-title`}>
  <h2 id={`${formId}-title`}>{title ?? t(M['expenses.form.title'])}</h2>
  {#if !canEdit}<p>{t(M['expenses.form.readonly'])}</p>{/if}
  <Form id={formId} {action} method="post" preventDefault={false} {onsubmit} aria-busy={busy}>
    <div class="fields">
      {#each hiddenFields as field}<Input type="hidden" name={field.name} value={field.value} interaction={false} />{/each}
      {#if message}<p role="alert">{message}</p>{/if}
      {#if retryStatus === 'transport-error'}<p role="status">{t(M['expenses.form.uncertain'])}</p>{/if}
      <fieldset disabled={!canEdit}>
        {#each textFields as field}
          <FormGroup id={`${formId}-${field}`} label={t(M[`expenses.form.${field}`])} error={errors[field]} hint={field === 'amount' ? t(M['expenses.form.amount_help']) : field === 'incurredOn' ? t(M['expenses.form.date_help']) : undefined}>
            {#if field === 'currency'}
              <CurrencySelect name={name(field)} value={values[field]} options={currencyOptions} locale={i18n.locale} readOnly={!canEdit} />
            {:else}
              <Input name={name(field)} value={values[field]} inputmode={field === 'amount' ? 'decimal' : undefined} />
            {/if}
          </FormGroup>
        {/each}
        <FormGroup id={`${formId}-description`} label={t(M['expenses.form.description'])} error={errors.description}>
          <Textarea name={name('description')} value={values.description} />
        </FormGroup>
        {#each ['vendorId', 'commitmentId'] as reference}
          {@const field = reference as 'vendorId' | 'commitmentId'}
          {@const options = field === 'vendorId' ? vendors : commitments}
          <FormGroup id={`${formId}-${field}`} label={t(M[`expenses.form.${field}`])} error={errors[field]}>
            <Select name={name(field)} value={values[field]}>
              <option value="">{t(M['expenses.form.choose'])}</option>
              {#if values[field] && !options.some(option => option.id === values[field])}<option value={values[field]}>{t(M['expenses.form.retained'], { reference: values[field] })}</option>{/if}
              {#each options as option}<option value={option.id}>{option.label}</option>{/each}
            </Select>
          </FormGroup>
        {/each}
        <FormGroup id={`${formId}-paidBy`} label={t(M['expenses.form.paidBy'])} error={errors.paidBy}>
          <Select name={name('paidBy')} value={values.paidBy}>
            {#if !['company', 'person'].includes(values.paidBy)}<option value={values.paidBy}>{values.paidBy}</option>{/if}
            <option value="company">{t(M['expenses.form.company'])}</option>
            <option value="person">{t(M['expenses.form.person'])}</option>
          </Select>
        </FormGroup>
        {#if correcting}
          <FormGroup id={`${formId}-correctionReason`} label={t(M['expenses.form.correctionReason'])} error={errors.correctionReason}>
            <Textarea name={name('correctionReason')} value={values.correctionReason} />
          </FormGroup>
        {:else}<Input type="hidden" name={name('correctionReason')} value={values.correctionReason} interaction={false} />{/if}
        {@render children?.()}
      </fieldset>
      {#if canEdit}<div><Button type="submit" name={intentField} value={intent} disabled={busy}>{submitLabel ?? t(M[correcting ? 'expenses.form.correct' : 'expenses.form.save'])}</Button></div>{/if}
    </div>
  </Form>
</section>
<style>
  .expense-form, .fields { display: grid; gap: var(--smrt-spacing-4); min-width: 0; }
  .expense-form { max-width: 48rem; overflow-wrap: anywhere; }
  fieldset { min-width: 0; border: 0; padding: 0; margin: 0; }
  h2, p { margin: 0; }
</style>
