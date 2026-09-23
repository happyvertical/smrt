<script lang="ts">
/**
 * Test harness: owns the `features` prop so a suite can replace it after an
 * operator edit and assert that unsaved edits do not survive the change.
 */
import { untrack } from 'svelte';
import type {
  FeatureSettingsChange,
  FeatureSettingsView,
} from '../../types.js';
import FeatureSettingsPanel from '../FeatureSettingsPanel.svelte';

interface Props {
  initial: FeatureSettingsView[];
  contextKey?: unknown;
  onSave?: (change: FeatureSettingsChange) => void;
}

const { initial, contextKey: initialContextKey, onSave }: Props = $props();

let features = $state(untrack(() => initial));
let contextKey = $state(untrack(() => initialContextKey));

export function setFeatures(next: FeatureSettingsView[]): void {
  features = next;
}

export function setContextKey(next: unknown): void {
  contextKey = next;
}
</script>

<FeatureSettingsPanel {features} {contextKey} {onSave} />
