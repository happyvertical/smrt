<script lang="ts">
import { ConnectAi } from '@happyvertical/smrt-svelte/connect-ai';
import { refreshAssistantStatus } from '$lib/ui/layout';
import {
  createShellConnectAiClient,
  type OnboardingInfo,
} from '$lib/ui/onboarding-client';

interface Props {
  variant?: 'welcome' | 'settings';
  advancedHref?: string;
  onchange?: (info: OnboardingInfo, ready: boolean) => void;
}
const {
  variant = 'welcome',
  advancedHref = '/settings/inference?from=welcome',
  onchange,
}: Props = $props();
let lastStatus = '';
const client = createShellConnectAiClient({
  onchange: (info, ready) => {
    const key = `${info.engine}:${ready}`;
    if (key !== lastStatus) {
      lastStatus = key;
      refreshAssistantStatus();
    }
    onchange?.(info, ready);
  },
});
</script>

<ConnectAi {client} apiKeyHref={advancedHref} variant={variant === 'welcome' ? 'onboarding' : 'settings'} presentation="compact" />
