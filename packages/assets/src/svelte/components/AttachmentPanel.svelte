<script lang="ts">
import type { AttachmentPanelProps } from '../attachments/types.js';
import AttachmentList from './AttachmentList.svelte';
import AttachmentUpload from './AttachmentUpload.svelte';
/** Composes authorized attachment display and optional native upload. */
export interface Props extends AttachmentPanelProps {}
let { upload, ...list }: Props = $props();
</script>
<div class="attachment-panel">
  <AttachmentList {...list} />
  {#if upload}<AttachmentUpload {...upload} />{/if}
</div>
<style>.attachment-panel { display: grid; gap: var(--smrt-spacing-4); min-width: 0; }</style>
