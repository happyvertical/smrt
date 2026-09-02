<script lang="ts">
import type { DataSurfaceRegistry } from '@happyvertical/smrt-ui/data';
import type { ControlInteractionRegistry } from '@happyvertical/smrt-ui/forms';
import type { ViewIntent } from '@happyvertical/smrt-web';
import type {
  UseViewIntentOptions,
  ViewIntentIdentity,
} from '../view-intent.svelte.js';
import { useViewIntent } from '../view-intent.svelte.js';

let {
  intent,
  identity,
  controlRegistry,
  dataSurfaceRegistry,
  effects,
}: {
  intent: ViewIntent;
  identity: ViewIntentIdentity;
  controlRegistry?: ControlInteractionRegistry;
  dataSurfaceRegistry?: DataSurfaceRegistry;
  effects?: UseViewIntentOptions['effects'];
} = $props();

useViewIntent(intent, {
  identity,
  ...(controlRegistry ? { controlRegistry } : {}),
  ...(dataSurfaceRegistry ? { dataSurfaceRegistry } : {}),
  ...(effects ? { effects } : {}),
});
</script>

<span>{intent.id}</span>
