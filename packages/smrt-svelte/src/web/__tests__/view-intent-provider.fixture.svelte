<script lang="ts">
import type { ControlInteractionRegistry } from '@happyvertical/smrt-ui/forms';
import type { ViewIntent } from '@happyvertical/smrt-web';
import Provider from '../../Provider.svelte';
import type { ViewIntentIdentity } from '../view-intent.svelte.js';
import ViewIntentFixture from './view-intent.fixture.svelte';

let {
  intent,
  identity,
  providerRegistry,
  effects,
}: {
  intent: ViewIntent;
  identity: ViewIntentIdentity;
  providerRegistry: ControlInteractionRegistry;
  effects?: readonly ('read' | 'write' | 'destructive')[];
} = $props();
</script>

<Provider
  webmcp={{
    ...(effects ? { effects } : {}),
    ui: { controlRegistry: providerRegistry },
  }}
>
  <ViewIntentFixture {intent} {identity} />
</Provider>
