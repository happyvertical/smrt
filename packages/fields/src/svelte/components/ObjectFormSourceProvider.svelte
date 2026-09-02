<script lang="ts">
/** Provides one app-local generated ObjectForm source to descendant forms. */
import type { Snippet } from 'svelte';
import { setObjectFormSource } from '../object-form-source-context.svelte.js';
import type { ObjectFormSource } from '../types.js';

interface Props {
  /** Transport for loading object form definitions. */
  source: ObjectFormSource;
  children?: Snippet;
}

let { source, children }: Props = $props();
// Context is established once, but the wrapper reads the current app source
// when a descendant loads so a host may replace its transport configuration.
setObjectFormSource({ load: (objectRef) => source.load(objectRef) });
</script>

{@render children?.()}
