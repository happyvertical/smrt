<script lang="ts">
import { getThemeContext } from '../context.svelte.js';
import ThemeProvider from '../ThemeProvider.svelte';
import type { ColorScheme } from '../types.js';
import HostHandle from './theme-provider-follow-parent-handle.fixture.svelte';

let {
  hostScheme = 'system',
  innerScheme = 'system',
  innerPreset = 'glass',
  innerPrimary,
  onhost,
}: {
  hostScheme?: ColorScheme;
  innerScheme?: ColorScheme;
  innerPreset?: 'glass' | 'material';
  innerPrimary?: string;
  onhost?: (context: ReturnType<typeof getThemeContext>) => void;
} = $props();
</script>

<ThemeProvider preset="smrt" colorScheme={hostScheme} storageKey="host-theme">
  <HostHandle {onhost} />
  <ThemeProvider preset={innerPreset} colorScheme={innerScheme} primaryColor={innerPrimary}>
    <span>inner</span>
  </ThemeProvider>
</ThemeProvider>
