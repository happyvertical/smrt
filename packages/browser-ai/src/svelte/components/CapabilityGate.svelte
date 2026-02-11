<script lang="ts">
import { useAppState } from '@happyvertical/smrt-svelte';
import type { Snippet } from 'svelte';

export interface Props {
  /** Require 'smrt' mode to be enabled */
  requireSmrt?: boolean;
  /** Require specific capability */
  require?: 'stt' | 'tts' | 'llm' | 'webgpu';
  /** Content to show when requirements are met */
  children: Snippet;
  /** Fallback content when requirements are not met */
  fallback?: Snippet;
}

const { requireSmrt = false, require, children, fallback }: Props = $props();

const app = useAppState();

const hasCapability = $derived.by(() => {
  const caps = app.state.capabilities;
  if (!caps) return false;

  switch (require) {
    case 'stt':
      return caps.stt.browserSpeechAPI || caps.stt.whisperWasm;
    case 'tts':
      return caps.tts.browserSynthesisAPI || caps.tts.transformersTTS;
    case 'llm':
      return caps.llm.webllm || caps.llm.transformersLLM;
    case 'webgpu':
      return caps.llm.webgpu;
    default:
      return true;
  }
});

const shouldShow = $derived.by(() => {
  // Check mode requirement
  if (requireSmrt && app.state.mode !== 'smrt') {
    return false;
  }

  // Check capability requirement
  if (require && !hasCapability) {
    return false;
  }

  return true;
});
</script>

{#if shouldShow}
  {@render children()}
{:else if fallback}
  {@render fallback()}
{/if}
