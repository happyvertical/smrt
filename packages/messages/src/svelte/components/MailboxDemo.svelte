<script lang="ts">
import { Button } from '@happyvertical/smrt-ui/ui';
import type { AccountData, ComposeState, MessageData } from '../types.js';
import ComposeForm from './ComposeForm.svelte';
import MessageDetail from './MessageDetail.svelte';
import MessageList from './MessageList.svelte';

const accounts: AccountData[] = [
  {
    id: 'demo-account',
    name: 'Demo Inbox',
    providerType: 'email',
    email: 'you@example.com',
    isActive: true,
  },
];
let messages = $state<MessageData[]>([
  {
    id: 'demo-welcome',
    type: 'email',
    accountId: 'demo-account',
    subject: 'Welcome to your mailbox',
    body: 'Open this message, or compose a mock reply. Nothing leaves this browser.',
    senderName: 'Demo colleague',
    senderAddress: 'colleague@example.com',
    recipientAddresses: [{ address: 'you@example.com' }],
    date: '2026-01-01T12:00:00Z',
    isRead: false,
    isFlagged: false,
    hasAttachments: false,
  },
]);
let selected = $state<MessageData | null>(null);
let composing = $state(false);
let status = $state('');
function send(state: ComposeState) {
  status = `Mock send complete: ${state.subject}. No email was delivered.`;
  composing = false;
}
function open(message: MessageData) {
  selected = { ...message, isRead: true };
  messages = messages.map((row) => (row.id === message.id ? selected! : row));
}
</script>
<p>Demo mailbox. Sending is mocked; no mail server is contacted.</p>
<Button onclick={() => { composing = true; status = ''; }}>Compose</Button>
{#if status}<p role="status">{status}</p>{/if}
{#if composing}
  <ComposeForm {accounts} onsend={send} ondiscard={() => (composing = false)} />
{:else if selected}
  <Button onclick={() => (selected = null)}>Back to mailbox</Button>
  <MessageDetail message={selected} account={accounts[0]} onreply={() => (composing = true)} />
{:else}
  <MessageList {messages} {accounts} onmessageclick={open} />
{/if}
