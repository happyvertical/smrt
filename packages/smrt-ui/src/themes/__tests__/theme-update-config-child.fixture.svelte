<script lang="ts">
import { getThemeContext } from '../context.svelte.js';

// The #3873 repro: keep the provider's overrides in sync from a child effect.
const theme = getThemeContext();
$effect(() => {
  if (theme.state.config.overrides?.['--smrt-color-primary'] !== 'red') {
    theme.updateConfig({
      overrides: { '--smrt-color-primary': 'red' },
      storageKey: 'child-theme',
    });
  }
});
</script>

<output data-testid="config">{JSON.stringify({
  overrides: theme.state.config.overrides,
  storageKey: theme.state.config.storageKey,
})}</output>
