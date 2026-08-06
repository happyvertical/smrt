<script lang="ts">
/**
 * ModeSwitch — a Basic/Advanced toggle built on SegmentedControl.
 *
 * An optional composition for PolicyField-wrapped forms. Reads and writes the
 * provider's reactive mode state. Must be used inside a FieldPolicyProvider.
 *
 * Uses `@happyvertical/smrt-ui/forms`'s SegmentedControl (exported from there,
 * not `./ui` — see the plan-review addendum in #2048).
 */

import type { SegmentedControlOption } from '@happyvertical/smrt-ui/forms';
import { SegmentedControl } from '@happyvertical/smrt-ui/forms';
import { getFieldPolicyContext } from '../context.svelte.js';

export interface Props {
  /** Accessible label for the segmented control. */
  label?: string;
  /** Additional class. */
  class?: string;
}

let { label = 'View mode', class: className = '' }: Props = $props();

const context = getFieldPolicyContext();

const options: SegmentedControlOption[] = [
  { value: 'basic', label: 'Basic' },
  { value: 'advanced', label: 'Advanced' },
];

function onValueChange(value: string | number): void {
  context.mode.set(value as 'basic' | 'advanced');
}
</script>

<SegmentedControl
  {options}
  {label}
  value={context.mode.current}
  onvaluechange={onValueChange}
  class={className}
/>
