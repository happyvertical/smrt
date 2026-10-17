<script lang="ts">
/**
 * AssistantQuestionForm — a structured assistant question (see
 * `./assistant-question.ts`) as a small form in the chat (#4100).
 *
 * One fieldset whose legend is the question. A single choice is a radio group
 * (a select past six options), several choices are checkboxes, defaults are
 * preselected, and one submit button sends the values. Once answered it
 * collapses to a read-only summary line. With `autofocus` the first control
 * takes focus when the form appears, so a keyboard user can answer at once.
 */

import {
  Checkbox,
  Fieldset,
  Radio,
  RadioGroup,
  Select,
} from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../../i18n.js';
import {
  type AssistantQuestion,
  type AssistantQuestionAnswer,
  assistantQuestionDefaults,
  describeAssistantQuestionAnswer,
  validateAssistantQuestionAnswer,
} from './assistant-question.js';

export interface Props {
  question: AssistantQuestion;
  /** The answer, when given (from the question itself or the host). */
  answered?: AssistantQuestionAnswer | null;
  /** Called once with the chosen values; the host continues the turn. */
  onsubmit: (values: AssistantQuestionAnswer) => void | Promise<void>;
  /** Move focus into the form when it appears (the newest message). */
  autofocus?: boolean;
  disabled?: boolean;
}

const {
  question,
  answered = null,
  onsubmit,
  autofocus = false,
  disabled = false,
}: Props = $props();
const { t } = useI18n();
const RADIO_LIMIT = 6;
const formId = $props.id();

// Seeded once from the question's defaults; the person edits from there.
let values = $state<AssistantQuestionAnswer>(
  assistantQuestionDefaults((() => question)()),
);
let submitting = $state(false);
let submitted = $state<AssistantQuestionAnswer | null>(null);
let form = $state<HTMLFormElement | null>(null);

const answer = $derived(answered ?? question.answer ?? submitted);
const valid = $derived(validateAssistantQuestionAnswer(question, values));

$effect(() => {
  if (autofocus && form && !answer) {
    form
      .querySelector<HTMLElement>('input:not(:disabled), select:not(:disabled)')
      ?.focus();
  }
});

function setSingle(name: string, value: string) {
  values = { ...values, [name]: value };
}

function toggle(name: string, value: string, on: boolean) {
  const current = values[name];
  const list = Array.isArray(current) ? current : current ? [current] : [];
  values = {
    ...values,
    [name]: on
      ? [...new Set([...list, value])]
      : list.filter((v) => v !== value),
  };
}

const isChecked = (name: string, value: string) => {
  const current = values[name];
  return Array.isArray(current) ? current.includes(value) : current === value;
};

async function submit(event: SubmitEvent) {
  event.preventDefault();
  const chosen = validateAssistantQuestionAnswer(question, values);
  if (!chosen || submitting || answer) return;
  submitting = true;
  try {
    await onsubmit(chosen);
    submitted = chosen;
  } catch {
    // The host surfaced the failure; the form stays answerable.
  } finally {
    submitting = false;
  }
}
</script>

<div class="assistant-question" data-smrt-component="AssistantQuestionForm">
  {#if answer}
    <p class="assistant-question-summary" role="status">
      <span class="assistant-question-prompt">{question.prompt}</span>
      {describeAssistantQuestionAnswer(question, answer)}
    </p>
  {:else}
    <form bind:this={form} onsubmit={submit} aria-label={question.prompt}>
      <Fieldset legend={question.prompt} stack>
        {#snippet children()}
          {#each question.fields as field (field.name)}
            {#if field.multiple}
              <Fieldset legend={field.label} stack>
                {#snippet children()}
                  {#each field.options as option (option.value)}
                    <Checkbox
                      name={`${formId}-${field.name}`}
                      value={option.value}
                      label={option.label}
                      checked={isChecked(field.name, option.value)}
                      {disabled}
                      onchange={(e: Event & { currentTarget: HTMLInputElement }) =>
                        toggle(field.name, option.value, e.currentTarget.checked)}
                    />
                  {/each}
                {/snippet}
              </Fieldset>
            {:else if field.options.length > RADIO_LIMIT}
              <label class="assistant-question-select">
                <span>{field.label}</span>
                <Select
                  name={`${formId}-${field.name}`}
                  value={typeof values[field.name] === 'string' ? (values[field.name] as string) : ''}
                  required={field.required}
                  {disabled}
                  interaction={false}
                  onchange={(e: Event & { currentTarget: HTMLSelectElement }) =>
                    setSingle(field.name, e.currentTarget.value)}
                >
                  {#snippet children()}
                    {#if values[field.name] === undefined}
                      <option value="" disabled>{t(M['chat.assistant_question.choose'])}</option>
                    {/if}
                    {#each field.options as option (option.value)}
                      <option value={option.value}>{option.label}</option>
                    {/each}
                  {/snippet}
                </Select>
              </label>
            {:else}
              <RadioGroup
                name={`${formId}-${field.name}`}
                label={field.label}
                value={typeof values[field.name] === 'string' ? (values[field.name] as string) : ''}
                required={field.required}
                {disabled}
                interaction={false}
                onvaluechange={(value) => setSingle(field.name, value)}
              >
                {#snippet children()}
                  {#each field.options as option (option.value)}
                    <Radio value={option.value} label={option.label} />
                  {/each}
                {/snippet}
              </RadioGroup>
            {/if}
          {/each}
        {/snippet}
      </Fieldset>
      <div class="assistant-question-actions">
        <Button type="submit" disabled={disabled || submitting || !valid}>
          {question.submitLabel ?? t(M['chat.assistant_question.submit'])}
        </Button>
      </div>
    </form>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .assistant-question {
    margin-block-start: var(--smrt-spacing-2);
  }

  .assistant-question form {
    display: grid;
    gap: var(--smrt-spacing-3);
  }

  .assistant-question-select {
    display: grid;
    gap: var(--smrt-spacing-1);
    font: var(--smrt-typography-label-large-font);
  }

  .assistant-question-actions {
    display: flex;
    justify-content: flex-start;
  }

  .assistant-question-summary {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font: var(--smrt-typography-body-small-font);
  }

  .assistant-question-prompt {
    display: block;
    color: var(--smrt-color-on-surface);
  }
}
</style>
