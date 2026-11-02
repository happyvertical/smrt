<script lang="ts">
import ThemeProvider from '../ThemeProvider.svelte';
</script>

<ThemeProvider preset="smrt" colorScheme="dark" scope="local" persist={false}>
  <ThemeProvider preset="material" colorScheme="light" density="touch" scope="document" persist={false}>
    <span>nested</span>
  </ThemeProvider>
</ThemeProvider>
