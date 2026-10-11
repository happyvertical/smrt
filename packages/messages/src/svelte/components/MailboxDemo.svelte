<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../i18n.messages.js';
import type { AccountData, ComposeState, MessageData } from '../types.js';
import ComposeForm from './ComposeForm.svelte';
import MessageDetail from './MessageDetail.svelte';
import MessageList from './MessageList.svelte';

const { t } = useI18n();
const accounts = $state<AccountData[]>([
  {
    id: 'demo-account',
    name: t(M['messages.mailbox_demo.inbox']),
    providerType: 'email',
    email: 'you@example.com',
    isActive: true,
  },
]);
$effect(() => {
  accounts[0].name = t(M['messages.mailbox_demo.inbox']);
});
let wasRead = $state(false);
const messages = $derived<MessageData[]>([
  {
    id: 'demo-welcome',
    type: 'email',
    accountId: 'demo-account',
    subject: t(M['messages.mailbox_demo.subject']),
    body: t(M['messages.mailbox_demo.body']),
    senderName: t(M['messages.mailbox_demo.sender']),
    senderAddress: 'colleague@example.com',
    recipientAddresses: [{ address: 'you@example.com' }],
    date: '2026-01-01T12:00:00Z',
    isRead: wasRead,
    isFlagged: false,
    hasAttachments: false,
  },
]);
let selectedId = $state<string | null>(null);
const selected = $derived(
  messages.find((message) => message.id === selectedId),
);
let composing = $state(false);
let sentSubject = $state<string | null>(null);
function send(state: ComposeState) {
  sentSubject = state.subject;
  composing = false;
}
function open(message: MessageData) {
  selectedId = message.id;
  wasRead = true;
}
</script>
<p>{t(M['messages.mailbox_demo.disclaimer'])}</p>
<Button onclick={() => { composing = true; sentSubject = null; }}>{t(M['messages.mailbox_demo.compose'])}</Button>
{#if sentSubject !== null}<p role="status">{t(M['messages.mailbox_demo.sent'], { subject: sentSubject })}</p>{/if}
{#if composing}
  <ComposeForm {accounts} onsend={send} ondiscard={() => (composing = false)} />
{:else if selected}
  <Button onclick={() => (selectedId = null)}>{t(M['messages.mailbox_demo.back'])}</Button>
  <MessageDetail message={selected} account={accounts[0]} onreply={() => (composing = true)} />
{:else}
  <MessageList {messages} {accounts} onmessageclick={open} />
{/if}
