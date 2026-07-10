<script lang="ts">
export interface Props {
  label?: string;
  size?: 'sm' | 'md' | 'lg';
  class?: string;
}
let { label = 'Loading', size = 'md', class: className = '' }: Props = $props();
</script>
<span class="spinner spinner--{size} {className}" role="status"><span class="spinner__ring" aria-hidden="true"></span><span class="visually-hidden">{label}</span></span>
<style>
  .spinner { display: inline-flex; }
  .spinner__ring { width: 1.5rem; height: 1.5rem; border: 2px solid var(--smrt-color-surface-container-highest); border-top-color: var(--smrt-color-primary); border-radius: 50%; animation: spin .75s linear infinite; }
  .spinner--sm .spinner__ring { width: 1rem; height: 1rem; } .spinner--lg .spinner__ring { width: 2.5rem; height: 2.5rem; border-width: 3px; }
  .visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0,0,0,0); white-space: nowrap; border: 0; }
  @keyframes spin { to { transform: rotate(360deg); } }
  @media (prefers-reduced-motion: reduce) { .spinner__ring { animation-duration: 1.5s; } }
</style>
