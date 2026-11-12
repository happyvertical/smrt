<script lang="ts">
import type { Snippet } from 'svelte';
import type { HTMLAttributes } from 'svelte/elements';

type MaxWidth = 'sm' | 'md' | 'lg' | 'xl' | 'full';

interface Props extends Omit<HTMLAttributes<HTMLDivElement>, 'class'> {
  /** Maximum width constraint for the container. */
  maxWidth?: MaxWidth;
  /** The container content. */
  children?: Snippet;
}

const { maxWidth = 'lg', children, ...rest }: Props = $props();
</script>

<div class="smrt-container__root smrt-container__max-w-{maxWidth}" {...rest} data-smrt-component="Container">
  {@render children?.()}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-container__root {
    box-sizing: border-box;
    width: 100%;
    margin: 0 auto;
    padding-left: var(--smrt-spacing-4);
    padding-right: var(--smrt-spacing-4);
  }
  .smrt-container__max-w-sm {
    max-width: 640px;
  }
  .smrt-container__max-w-md {
    max-width: 768px;
  }
  .smrt-container__max-w-lg {
    max-width: 1024px;
  }
  .smrt-container__max-w-xl {
    max-width: 1280px;
  }
  .smrt-container__max-w-full {
    max-width: 100%;
  }
  @media (min-width: 640px) {
    .smrt-container__root {
      padding-left: var(--smrt-spacing-6);
      padding-right: var(--smrt-spacing-6);
    }
  }
}

@layer smrt.theme {
}

</style>
