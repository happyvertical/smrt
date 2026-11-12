<script lang="ts">
export interface Props {
  /** Accessibility label for screen readers. */
  label?: string;
  /** Spinner size: sm (small), md (medium), or lg (large). */
  size?: 'sm' | 'md' | 'lg';
  /** CSS class to apply to the spinner container. */
  class?: string;
}
let { label = 'Loading', size = 'md', class: className = '' }: Props = $props();
</script>
<span class="smrt-spinner__root smrt-spinner__{size} {className}" role="status" data-smrt-component="Spinner"><span class="smrt-spinner__ring" data-smrt-part="indicator" aria-hidden="true"></span><span class="smrt-spinner__visually-hidden" data-smrt-part="label">{label}</span></span>
<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-spinner__root {
    display: inline-flex;
  }
  .smrt-spinner__ring {
    width: 1.5rem;
    height: 1.5rem;
  }
  .smrt-spinner__sm .smrt-spinner__ring {
    width: 1rem;
    height: 1rem;
  }
  .smrt-spinner__lg .smrt-spinner__ring {
    width: 2.5rem;
    height: 2.5rem;
  }
  .smrt-spinner__visually-hidden {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0,0,0,0);
    white-space: nowrap;
  }
}

@layer smrt.theme {
  .smrt-spinner__ring {
    border: 2px solid var(--smrt-color-surface-container-highest);
    border-top-color: var(--smrt-color-primary);
    border-radius: 50%;
    animation: spin .75s linear infinite;
  }
  .smrt-spinner__lg .smrt-spinner__ring {
    border-width: 3px;
  }
  .smrt-spinner__visually-hidden {
    border: 0;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .smrt-spinner__ring {
      animation-duration: 1.5s;
    }
  }
}

</style>
