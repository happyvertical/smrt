<script lang="ts">
/**
 * ModelPicker - AI model selector
 *
 * Extracted from `@happyvertical/smrt-content`'s `ContentAgentChat.svelte`
 * (its `AI_MODELS` constant + `availableAIModels`/`allowedModelIds` filtering,
 * `packages/content/src/svelte/components/ContentAgentChat.svelte:28-121`) for
 * reuse by AssistantDock (#2904). `ContentAgentChat` itself is NOT migrated to
 * this component in this change — that is a separate, behavior-preserving
 * follow-up (docs/assistant-dock.md "Gaps").
 */
import { Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../i18n.js';

export interface ModelOption {
  id: string;
  label: string;
}

export const DEFAULT_MODEL_OPTIONS: ModelOption[] = [
  { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
  { id: 'claude-3-5-sonnet-latest', label: 'Claude 3.5 Sonnet' },
  { id: 'claude-3-5-haiku-latest', label: 'Claude 3.5 Haiku' },
  { id: 'gpt-4o', label: 'GPT-4o' },
  { id: 'gpt-4o-mini', label: 'GPT-4o Mini' },
];

export interface Props {
  /** Full candidate model catalog; defaults to `DEFAULT_MODEL_OPTIONS`. */
  models?: ModelOption[];
  /** Allow-list of model ids; empty/omitted means all `models` are offered. */
  allowedModelIds?: string[];
  /** The selected model id; bindable. */
  value: string;
  /** Fired with the newly selected model id. */
  onchange?: (modelId: string) => void;
  /** Accessible name for the underlying `<select>` (#2904 review, cycle-3
   * second final F2 — the control previously had no aria-label, id, or
   * wrapping `FormGroup`, so axe/screen readers saw an unnamed combobox).
   * Defaults to an i18n'd "Model" label; override when a host embeds this
   * picker somewhere the generic default isn't descriptive enough. */
  ariaLabel?: string;
}

let {
  models = DEFAULT_MODEL_OPTIONS,
  allowedModelIds = [],
  value = $bindable(),
  onchange,
  ariaLabel,
}: Props = $props();

const { t } = useI18n();

const availableModels = $derived(
  allowedModelIds.length > 0
    ? [
        ...models.filter((model) => allowedModelIds.includes(model.id)),
        ...allowedModelIds
          .filter((id) => !models.some((model) => model.id === id))
          .map((id) => ({ id, label: id })),
      ]
    : models,
);

function handleChange(event: Event) {
  const next = (event.target as HTMLSelectElement).value;
  value = next;
  onchange?.(next);
}
</script>

<Select
  class="smrt-select model-picker-select"
  bind:value
  onchange={handleChange}
  aria-label={ariaLabel ?? t(M['chat.model_picker.label'])}
>
  {#each availableModels as model (model.id)}
    <option value={model.id}>{model.label}</option>
  {/each}
</Select>
