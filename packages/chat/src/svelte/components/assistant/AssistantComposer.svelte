<script lang="ts">
/**
 * AssistantComposer - text + attachment composer for AssistantDock (#2904).
 * Reuses `../shared/FileUpload.svelte` for attachment staging rather than
 * reimplementing drag-and-drop/size-validation.
 */
import FileUpload from '../shared/FileUpload.svelte';
import type { AssistantAttachmentRef } from './assistant-transport.js';

export interface Props {
  onsend: (content: string, attachments: AssistantAttachmentRef[]) => void;
  onupload: (files: FileList) => Promise<AssistantAttachmentRef[]>;
  disabled?: boolean;
  placeholder?: string;
}

const {
  onsend,
  onupload,
  disabled = false,
  placeholder = 'Ask the assistant…',
}: Props = $props();

let content = $state('');
let stagedAttachments = $state<AssistantAttachmentRef[]>([]);
let uploading = $state(false);

async function handleUpload(files: FileList) {
  uploading = true;
  try {
    const uploaded = await onupload(files);
    stagedAttachments = [...stagedAttachments, ...uploaded];
  } finally {
    uploading = false;
  }
}

function handleSend() {
  const trimmed = content.trim();
  if (!trimmed || disabled) return;
  onsend(trimmed, stagedAttachments);
  content = '';
  stagedAttachments = [];
}

function handleKeydown(event: KeyboardEvent) {
  if (event.key === 'Enter' && !event.shiftKey) {
    event.preventDefault();
    handleSend();
  }
}

function removeAttachment(id: string) {
  stagedAttachments = stagedAttachments.filter((a) => a.id !== id);
}
</script>

<div class="assistant-composer">
  {#if stagedAttachments.length > 0}
    <ul class="assistant-composer-attachments">
      {#each stagedAttachments as attachment (attachment.id)}
        <li>
          <span>{attachment.name}</span>
          <button type="button" onclick={() => removeAttachment(attachment.id)}>×</button>
        </li>
      {/each}
    </ul>
  {/if}
  <div class="assistant-composer-row">
    <FileUpload onupload={handleUpload} disabled={disabled || uploading} />
    <textarea
      bind:value={content}
      onkeydown={handleKeydown}
      {placeholder}
      disabled={disabled || uploading}
    ></textarea>
    <button type="button" onclick={handleSend} disabled={disabled || uploading || !content.trim()}>
      Send
    </button>
  </div>
</div>

<style>
  .assistant-composer-row {
    display: flex;
    align-items: flex-end;
    gap: 0.5rem;
  }
  .assistant-composer-row textarea {
    flex: 1;
    resize: none;
  }
  .assistant-composer-attachments {
    list-style: none;
    display: flex;
    gap: 0.5rem;
    margin: 0 0 0.5rem;
    padding: 0;
  }
</style>
