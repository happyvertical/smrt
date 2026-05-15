<script lang="ts">
/**
 * Fixture for the typed tool-component pattern documented on
 * `ToolDef.component`. The dock erases tool-specific types at registration,
 * but the tool component itself locally annotates `context` with the
 * narrowed `ToolsDockContext<TData, TActions>` shape — see
 * `register-typed-tool.ts` for the registration site that must accept this
 * component without a cast.
 *
 * If any of the type assertions below fail at `svelte-check` / `tsc` time,
 * either the `ToolDef.component` erasure relaxation or the
 * `ToolsDockContext` action-map constraint regressed.
 */
import type { ToolsDockApi, ToolsDockContext } from '../../types.js';
import type { MyActions, MyData } from './typed-tool-types.js';

let {
  context,
  dock,
}: {
  context: ToolsDockContext<MyData, MyActions> | null;
  dock: ToolsDockApi;
} = $props();

// These reads must compile — they exercise the typed `data` / `actions`
// surface that motivated the U3/U4/U5 work.
const slug = $derived(context?.data?.siteSlug ?? '');
const onSave = () => context?.actions?.triggerSave();
const onReview = () => context?.actions?.triggerReview('manual');

// Dock reference must still be usable.
const isOpen = $derived(dock.isOpen);
</script>

<section data-tool="typed-tool" data-slug={slug} data-open={isOpen}>
  <button type="button" onclick={onSave}>Save</button>
  <button type="button" onclick={onReview}>Review</button>
</section>
