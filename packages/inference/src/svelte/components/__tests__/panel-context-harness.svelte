<script lang="ts">
/**
 * Test harness: owns `contextKey` and `tiers` so a suite can switch the
 * editing context after an unsaved edit.
 */
import { untrack } from 'svelte';
import type { InferenceTierChange, InferenceTierView } from '../../types.js';
import InferenceSettingsPanel from '../InferenceSettingsPanel.svelte';

interface Props {
  initial: InferenceTierView[];
  contextKey?: unknown;
  onSaveTier?: (change: InferenceTierChange) => void;
}

const { initial, contextKey: initialContextKey, onSaveTier }: Props = $props();

let tiers = $state(untrack(() => initial));
let contextKey = $state(untrack(() => initialContextKey));

export function setTiers(next: InferenceTierView[]): void {
  tiers = next;
}

export function setContextKey(next: unknown): void {
  contextKey = next;
}
</script>

<InferenceSettingsPanel {tiers} {contextKey} {onSaveTier} advancedOpen />
