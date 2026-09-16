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
  value: string;
  onchange?: (modelId: string) => void;
}

let {
  models = DEFAULT_MODEL_OPTIONS,
  allowedModelIds = [],
  value = $bindable(),
  onchange,
}: Props = $props();

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

<Select class="smrt-select model-picker-select" bind:value onchange={handleChange}>
  {#each availableModels as model (model.id)}
    <option value={model.id}>{model.label}</option>
  {/each}
</Select>
