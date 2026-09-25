<script lang="ts">
/**
 * Test harness: owns the `prompts` prop so a suite can replace it after an
 * operator edit and assert that unsaved edits do not survive the change.
 */
import { untrack } from 'svelte';
import type { PromptSettingsChange, PromptSettingsView } from '../../types.js';
import PromptSettingsPanel from '../PromptSettingsPanel.svelte';

interface Props {
  initial: PromptSettingsView[];
  contextKey?: unknown;
  onSave?: (change: PromptSettingsChange) => void;
}

const { initial, contextKey: initialContextKey, onSave }: Props = $props();

let prompts = $state(untrack(() => initial));
let contextKey = $state(untrack(() => initialContextKey));

export function setPrompts(next: PromptSettingsView[]): void {
  prompts = next;
}

export function setContextKey(next: unknown): void {
  contextKey = next;
}
</script>

<PromptSettingsPanel {prompts} {contextKey} {onSave} />
