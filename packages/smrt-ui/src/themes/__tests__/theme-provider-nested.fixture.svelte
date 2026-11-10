<script lang="ts">
import ThemeProvider from '../ThemeProvider.svelte';
</script>

<ThemeProvider preset="smrt" colorScheme="dark" persist={false}>
  <ThemeProvider preset="material" colorScheme="light" density="touch" persist={false}>
    <span>nested</span>
  </ThemeProvider>
</ThemeProvider>
