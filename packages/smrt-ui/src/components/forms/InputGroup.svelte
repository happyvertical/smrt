<script lang="ts">
import type { Snippet } from 'svelte';
export interface Props {
  /** Optional snippet to render as a left adornment. */
  prefix?: Snippet;
  /** Optional snippet to render as a right adornment. */
  suffix?: Snippet;
  /** Input control or custom content inside the group. */
  children: Snippet;
  /** CSS class to apply to the input group. */
  class?: string;
}
let { prefix, suffix, children, class: className = '' }: Props = $props();
</script>
<div class="smrt-input-group__root {className}" data-smrt-component="InputGroup">{#if prefix}<span class="smrt-input-group__adornment" data-smrt-part="adornment">{@render prefix()}</span>{/if}<div class="smrt-input-group__control" data-smrt-part="control">{@render children()}</div>{#if suffix}<span class="smrt-input-group__adornment" data-smrt-part="adornment">{@render suffix()}</span>{/if}</div>
<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-input-group__root {
    display: flex;
    align-items: stretch;
    width: 100%;
    overflow: hidden;
  }
  .smrt-input-group__adornment {
    display: inline-flex;
    align-items: center;
    padding: 0 var(--smrt-spacing-3);
  }
  .smrt-input-group__control {
    flex: 1;
    min-width: 0;
  }
}

@layer smrt.theme {
  .smrt-input-group__root {
    border: var(--smrt-hairline-strong);
    border-radius: var(--smrt-radius-small);
    background: var(--smrt-color-surface);
  }
  .smrt-input-group__adornment {
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-input-group__root .smrt-input-group__control :global(input), .smrt-input-group__root .smrt-input-group__control :global(select), .smrt-input-group__root .smrt-input-group__control :global(textarea) {
    border: 0;
    border-radius: 0;
    box-shadow: none;
  }
  .smrt-input-group__root:focus-within {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
}

</style>
