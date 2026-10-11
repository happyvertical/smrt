<script lang="ts">
import { type I18nStore, setI18nContext } from '@happyvertical/smrt-ui/i18n';
import { untrack } from 'svelte';
import MailboxDemo from '../../../../messages/src/svelte/components/MailboxDemo.svelte';
import NotificationBell from './NotificationBell.svelte';
import type { NotificationProvider } from './types.js';

interface Props {
  store: I18nStore;
  provider?: NotificationProvider;
  mailbox?: boolean;
}
let { store, provider, mailbox = false }: Props = $props();
setI18nContext(untrack(() => store));
</script>
{#if mailbox}<MailboxDemo />{:else if provider}<NotificationBell {provider} />{/if}
