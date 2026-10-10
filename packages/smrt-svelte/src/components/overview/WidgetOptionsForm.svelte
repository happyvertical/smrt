<script lang="ts">
/**
 * WidgetOptionsForm - edits one widget's options (#3727). A widget's options
 * are plain fields, so this reads like the generated record forms: smrt-ui
 * form controls driven by the option field descriptors (label, help,
 * required, type), with the same save/cancel bar. It validates through the
 * widget's schema (via `onsave`) and shows each problem beside its field.
 */
import { Alert } from '@happyvertical/smrt-ui/feedback';
import {
  Checkbox,
  Form,
  FormActionBar,
  FormGroup,
  Input,
  Select,
  Textarea,
} from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { untrack } from 'svelte';
import { M } from '../../i18n/strings.overview.js';
import type { WidgetOptionsFormProps } from './grid-types.js';
import type { OverviewOptions, WidgetOptionField } from './types.js';

let { definition, initial, models, onsave, oncancel }: WidgetOptionsFormProps =
  $props();

const { t } = useI18n();

const fields = $derived(definition.options);

function seed(): {
  text: Record<string, string>;
  flags: Record<string, boolean>;
} {
  const text: Record<string, string> = {};
  const flags: Record<string, boolean> = {};
  for (const field of definition.options) {
    const value = initial[field.key];
    if (field.type === 'boolean') flags[field.key] = value === true;
    else
      text[field.key] =
        value === undefined || value === null ? '' : String(value);
  }
  return { text, flags };
}

const seeded = untrack(seed);
let text = $state<Record<string, string>>(seeded.text);
let flags = $state<Record<string, boolean>>(seeded.flags);
let issues = $state<Record<string, string>>({});
let failed = $state(false);

function toOptions(): OverviewOptions {
  const options: OverviewOptions = {};
  for (const field of fields) {
    if (field.type === 'boolean') {
      options[field.key] = flags[field.key] === true;
      continue;
    }
    const raw = text[field.key] ?? '';
    if (field.type === 'markdown') {
      options[field.key] = raw;
    } else if (raw.trim() === '') {
    } else if (field.type === 'integer' || field.type === 'number') {
      // NaN is not a primitive option: it fails validation as an invalid type.
      options[field.key] = Number(raw);
    } else {
      options[field.key] = raw.trim();
    }
  }
  return options;
}

const ISSUE_TEXT: Record<string, string> = {
  required: M['ui.overview.issue_required'],
  invalid_type: M['ui.overview.issue_invalid_type'],
  too_long: M['ui.overview.issue_too_long'],
  out_of_range: M['ui.overview.issue_out_of_range'],
  not_in_choices: M['ui.overview.issue_not_in_choices'],
  invalid_format: M['ui.overview.issue_invalid_format'],
  not_allowed: M['ui.overview.issue_not_allowed'],
  unknown_option: M['ui.overview.issue_unknown_option'],
};

function issueText(code: string): string {
  return t(ISSUE_TEXT[code] ?? M['ui.overview.issue_invalid_type']);
}

function submit(): void {
  const options = toOptions();
  const problems = onsave(options);
  if (problems === null) return;
  const next: Record<string, string> = {};
  for (const problem of problems) {
    next[problem.key] ??= issueText(problem.code);
  }
  issues = next;
  failed = true;
}

const label = (field: WidgetOptionField): string => t(field.label);
const hint = (field: WidgetOptionField): string | undefined =>
  field.help ? t(field.help) : undefined;
const optionalChoice = (field: WidgetOptionField): boolean =>
  !field.required && (field.default === undefined || field.default === null);
const modelValues = $derived(
  new Set((models ?? []).map((model) => model.value)),
);
</script>

<Form onsubmit={submit} novalidate>
  {#if failed}
    <Alert variant="error">{t(M['ui.overview.options_failed'])}</Alert>
  {/if}
  {#if fields.length === 0}
    <p class="smrt-widget-form__none">{t(M['ui.overview.options_none'])}</p>
  {/if}
  {#each fields as field (field.key)}
    {#if field.type === 'boolean'}
      <div class="smrt-widget-form__check">
        <Checkbox
          name={field.key}
          label={label(field)}
          bind:checked={() => flags[field.key] === true, (v) => (flags[field.key] = v)}
        />
        {#if hint(field)}<small class="smrt-widget-form__hint">{hint(field)}</small>{/if}
        {#if issues[field.key]}<small class="smrt-widget-form__error" role="alert">{issues[field.key]}</small>{/if}
      </div>
    {:else}
      <FormGroup label={label(field)} hint={hint(field)} error={issues[field.key]} required={field.required}>
        {#if field.type === 'markdown'}
          <Textarea
            name={field.key}
            rows={6}
            bind:value={() => text[field.key] ?? '', (v) => (text[field.key] = v)}
          />
        {:else if field.type === 'enum'}
          <Select
            name={field.key}
            bind:value={() => text[field.key] ?? '', (v) => (text[field.key] = v)}
          >
            {#if optionalChoice(field)}
              <option value="">{t(M['ui.overview.options_choose'])}</option>
            {/if}
            {#each field.choices ?? [] as choice (choice.value)}
              <option value={choice.value}>{t(choice.label)}</option>
            {/each}
          </Select>
        {:else if field.type === 'model' && models && models.length > 0}
          <Select
            name={field.key}
            bind:value={() => text[field.key] ?? '', (v) => (text[field.key] = v)}
          >
            <option value="">{t(M['ui.overview.options_choose'])}</option>
            {#if text[field.key] && !modelValues.has(text[field.key])}
              <option value={text[field.key]}>{text[field.key]}</option>
            {/if}
            {#each models as model (model.value)}
              <option value={model.value}>{model.label}</option>
            {/each}
          </Select>
        {:else}
          <Input
            name={field.key}
            type={field.type === 'integer' || field.type === 'number' ? 'number' : 'text'}
            step={field.type === 'integer' ? '1' : field.type === 'number' ? 'any' : undefined}
            min={field.min}
            max={field.max}
            maxlength={field.type === 'text' ? (field.maxLength ?? 200) : undefined}
            bind:value={() => text[field.key] ?? '', (v) => (text[field.key] = String(v))}
          />
        {/if}
      </FormGroup>
    {/if}
  {/each}
  <FormActionBar>
    <Button type="button" variant="ghost" onclick={oncancel}>
      {t(M['ui.overview.options_cancel'])}
    </Button>
    <Button type="submit" variant="primary">
      {t(M['ui.overview.options_save'])}
    </Button>
  </FormActionBar>
</Form>

<style>
  .smrt-widget-form__check { display: flex; flex-direction: column; gap: var(--smrt-spacing-1); }
  .smrt-widget-form__hint { color: var(--smrt-color-on-surface-variant); }
  .smrt-widget-form__error { color: var(--smrt-color-error); }
  .smrt-widget-form__none { margin: 0; color: var(--smrt-color-on-surface-variant); }
</style>
