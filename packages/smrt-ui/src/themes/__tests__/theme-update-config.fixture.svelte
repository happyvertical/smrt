<script lang="ts">
import ThemeProvider from '../ThemeProvider.svelte';
import ThemeUpdateConfigChild from './theme-update-config-child.fixture.svelte';
</script>

<ThemeProvider preset="smrt" persist={false}>
  <ThemeUpdateConfigChild />
</ThemeProvider>
