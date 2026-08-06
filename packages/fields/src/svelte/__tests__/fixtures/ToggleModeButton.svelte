<script lang="ts">
/**
 * Test helper: a button rendered inside a FieldPolicyProvider that toggles
 * the provider's mode state. Captures the context during component
 * initialisation (getContext is only valid there in Svelte 5).
 */
import { getFieldPolicyContext } from '../../context.svelte.js';

const context = getFieldPolicyContext();
</script>

<button onclick={() => context.mode.toggle()}>
  Toggle Mode
</button>
