<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';
import MailboxDemo from '../../messages/src/svelte/components/MailboxDemo.svelte';
import NotificationBell from '../src/components/notifications/NotificationBell.svelte';
import type { NotificationProvider } from '../src/components/notifications/types.js';

function makeProvider(title: string): NotificationProvider {
  let read = false;
  return {
    getUnreadCount: async () => (read ? 0 : 1),
    list: async () => [
      {
        id: title,
        title,
        occurredAt: '2026-01-01',
        readAt: read ? '2026-01-02' : null,
      },
    ],
    markRead: async () => {
      read = true;
    },
    markAllRead: async () => {
      read = true;
    },
  };
}
let provider = $state(makeProvider('First user notification'));
</script>
<NotificationBell {provider} />
<Button onclick={() => (provider = makeProvider('Second user notification'))}>Switch user</Button>

<MailboxDemo />
