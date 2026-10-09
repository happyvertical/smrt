<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';
import type { HelperStyleSetupProps } from '../registry.js';

let { onsaved, oncancel }: HelperStyleSetupProps = $props();
const offering = {
  id: 'photo:2',
  label: 'Cedar · saved today',
  styleId: 'photo-cutout',
  source: 'saved' as const,
  assetId: '2',
};
</script>

<Button type="button" onclick={() => onsaved(offering)}>Save photo</Button>
<Button type="button" variant="secondary" onclick={oncancel}>Cancel photo</Button>
