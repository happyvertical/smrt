<script lang="ts">
  import { ShellSettingsPanel } from '@happyvertical/smrt-svelte/workspace';

  // This page renders inside the root layout's <AdminShell>, so the shell
  // context set by AdminShell is available to descendants — ShellSettingsPanel
  // reads it via useAdminShell() with no extra wiring. It lets users toggle
  // panel visibility and remap the WASD hotkeys; changes persist through the
  // shell's `storageKey` (localStorage), applied client-side after mount.
</script>

<svelte:head>
  <title>Settings · SMRT App</title>
</svelte:head>

<section class="settings">
  <header>
    <h1>Settings</h1>
    <p>Adjust the workspace shell — panel layout and keyboard shortcuts.</p>
  </header>

  <ShellSettingsPanel />
</section>

<style>
  .settings {
    display: grid;
    gap: var(--smrt-spacing-6, 1.5rem);
    max-width: 720px;
    padding: var(--smrt-spacing-8, 2rem);
  }

  .settings header {
    display: grid;
    gap: var(--smrt-spacing-2, 0.5rem);
  }

  .settings h1,
  .settings p {
    margin: 0;
  }
</style>
