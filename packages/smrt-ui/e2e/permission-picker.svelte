<script lang="ts">
import '../src/themes/styles/smrt.css';
import PermissionPicker from '../src/components/permissions/PermissionPicker.svelte';

let { scheme = 'light' }: { scheme?: 'light' | 'dark' } = $props();
const longSlug = `construction.${'extraordinarily_long_unbroken_permission_segment_'.repeat(4)}manage`;
const permissions = [
  { slug: 'projects.read', name: 'Read projects', category: 'Projects' },
  { slug: longSlug, name: 'Manage specialist construction records', category: 'Construction' },
];
</script>

<main data-theme="smrt" data-color-scheme={scheme}>
  <form aria-label="Role grants">
    <PermissionPicker {permissions} selected={[longSlug]} />
  </form>
</main>

<style>
  :global(html, body) { margin: 0; }
  main { min-block-size: 100vh; padding: var(--smrt-spacing-4); color: var(--smrt-color-on-surface); background: var(--smrt-color-surface); font-family: var(--smrt-font-family); }
</style>
