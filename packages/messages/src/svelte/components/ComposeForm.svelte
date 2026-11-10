<script lang="ts" module>
import type {
  AccountData,
  AttachmentData,
  ComposeState,
  RecipientEntry,
} from '../types.js';

export interface Props {
  /** Message type to compose: email, Slack message, or tweet. */
  type?: 'email' | 'slack' | 'tweet';
  /** Available accounts to select as sender. */
  accounts?: AccountData[];
  /** Pre-fill the form with these values. */
  initialState?: Partial<ComposeState>;
  /** Called when user sends the message. */
  onsend?: (state: ComposeState) => void;
  /** Called when user saves the draft. */
  onsavedraft?: (state: ComposeState) => void;
  /** Called when user discards the compose. */
  ondiscard?: () => void;
}
</script>

<script lang="ts">
  import { useI18n } from '@happyvertical/smrt-ui/i18n';
  import { Form, Input, Select, Textarea } from '@happyvertical/smrt-ui/forms';
  import { Button } from '@happyvertical/smrt-ui/ui';
  import { M } from '../i18n.js';
  import RecipientInput from './RecipientInput.svelte';
  import AttachmentUpload from './AttachmentUpload.svelte';

  const { t } = useI18n();

  let {
    type = 'email',
    accounts = [],
    initialState,
    onsend,
    onsavedraft,
    ondiscard,
  }: Props = $props();

  function createComposeState(
    nextInitialState: Partial<ComposeState> | undefined,
    nextAccounts: AccountData[],
  ): ComposeState {
    return {
      accountId: nextInitialState?.accountId ?? nextAccounts[0]?.id ?? '',
      to: nextInitialState?.to ?? [],
      cc: nextInitialState?.cc ?? [],
      bcc: nextInitialState?.bcc ?? [],
      subject: nextInitialState?.subject ?? '',
      body: nextInitialState?.body ?? '',
      attachments: nextInitialState?.attachments ?? [],
      channelId: nextInitialState?.channelId ?? '',
      isDirty: false,
      isSending: false,
    };
  }

  let accountId = $state('');
  let toRecipients = $state([] as RecipientEntry[]);
  let ccRecipients = $state([] as RecipientEntry[]);
  let bccRecipients = $state([] as RecipientEntry[]);
  let subject = $state('');
  let body = $state('');
  let attachments = $state([] as AttachmentData[]);
  let channelId = $state('');
  let isDirty = $state(false);
  let isSending = $state(false);
  let sendError = $state<string | null>(null);
  let showCc = $state(false);
  let showBcc = $state(false);
  let appliedInitialState: Partial<ComposeState> | undefined;
  let appliedAccounts: AccountData[] | undefined;

  $effect(() => {
    if (
      appliedInitialState === initialState &&
      appliedAccounts === accounts
    ) {
      return;
    }

    appliedInitialState = initialState;
    appliedAccounts = accounts;
    const nextState = createComposeState(initialState, accounts);

    accountId = nextState.accountId;
    toRecipients = nextState.to;
    ccRecipients = nextState.cc;
    bccRecipients = nextState.bcc;
    subject = nextState.subject;
    body = nextState.body;
    attachments = nextState.attachments;
    channelId = nextState.channelId ?? '';
    isDirty = nextState.isDirty;
    isSending = nextState.isSending;
    sendError = null;
    showCc = ccRecipients.length > 0;
    showBcc = bccRecipients.length > 0;
  });

  function getCurrentState(): ComposeState {
    return {
      accountId,
      to: toRecipients,
      cc: ccRecipients,
      bcc: bccRecipients,
      subject,
      body,
      attachments,
      channelId,
      isDirty,
      isSending,
    };
  }

  const charCount = $derived(body.length);
  const isOverLimit = $derived(type === 'tweet' && charCount > 280);

  function markDirty() {
    isDirty = true;
  }

  async function handleSend() {
    if (isSending) return;

    isSending = true;
    sendError = null;
    try {
      // onsend may be sync or async; awaiting handles both a thrown error and a
      // rejected promise so the form never latches in the "Sending…" state.
      await onsend?.(getCurrentState());
    } catch (e) {
      sendError = e instanceof Error ? e.message : String(e);
    } finally {
      isSending = false;
    }
  }

  function handleSaveDraft() {
    onsavedraft?.(getCurrentState());
  }
</script>

<div class="smrt-compose-form__root" data-smrt-component="ComposeForm">
<Form class="compose-form" onsubmit={handleSend}>
  {#if accounts.length > 1}
    <div class="smrt-compose-form__field" data-smrt-part="field">
      <label class="smrt-compose-form__label" data-smrt-part="label" for="compose-account">From</label>
      <Select
        id="compose-account"
        class="select"
        bind:value={accountId}
        onchange={markDirty}
      >
        {#each accounts as account}
          <option value={account.id}>
            {account.name}{account.email ? ` <${account.email}>` : ''}
          </option>
        {/each}
      </Select>
    </div>
  {/if}

  {#if type === 'email'}
    <RecipientInput
      label="To"
      recipients={toRecipients}
      onchange={(r) => { toRecipients = r; markDirty(); }}
    />

    {#if showCc}
      <RecipientInput
        label="Cc"
        recipients={ccRecipients}
        onchange={(r) => { ccRecipients = r; markDirty(); }}
      />
    {/if}

    {#if showBcc}
      <RecipientInput
        label="Bcc"
        recipients={bccRecipients}
        onchange={(r) => { bccRecipients = r; markDirty(); }}
      />
    {/if}

    {#if !showCc || !showBcc}
      <div class="smrt-compose-form__toggles" data-smrt-part="toggles">
        {#if !showCc}
          <Button variant="ghost" size="sm" class="link-btn" onclick={() => showCc = true}>Cc</Button>
        {/if}
        {#if !showBcc}
          <Button variant="ghost" size="sm" class="link-btn" onclick={() => showBcc = true}>Bcc</Button>
        {/if}
      </div>
    {/if}

    <div class="smrt-compose-form__field" data-smrt-part="field">
      <label class="smrt-compose-form__label" data-smrt-part="label" for="compose-subject">Subject</label>
      <Input
        id="compose-subject"
        type="text"
        class="text-input"
        bind:value={subject}
        oninput={markDirty}
        placeholder={t(M['messages.compose_form.subject_placeholder'])}
      />
    </div>
  {:else if type === 'slack'}
    <div class="smrt-compose-form__field" data-smrt-part="field">
      <label class="smrt-compose-form__label" data-smrt-part="label" for="compose-channel">Channel</label>
      <Input
        id="compose-channel"
        type="text"
        class="text-input"
        bind:value={channelId}
        oninput={markDirty}
        placeholder={t(M['messages.compose_form.channel_id_placeholder'])}
      />
    </div>
  {/if}

  <div class="smrt-compose-form__body" data-smrt-part="body">
    <Textarea
      bind:value={body}
      oninput={markDirty}
      placeholder={type === 'tweet' ? "What's happening?" : 'Write your message...'}
      rows={type === 'tweet' ? 4 : 10}
    />
    {#if type === 'tweet'}
      <div class="smrt-compose-form__count" class:smrt-compose-form__over-limit={isOverLimit} data-smrt-part="count">
        {charCount}/280
      </div>
    {/if}
  </div>

  {#if type === 'email'}
    <AttachmentUpload
      {attachments}
      onattach={(files: File[]) => {
        const newAttachments: AttachmentData[] = files.map((f) => ({
          id: crypto.randomUUID(),
          filename: f.name,
          contentType: f.type,
          size: f.size,
        }));
        attachments = [...attachments, ...newAttachments];
        markDirty();
      }}
      onremove={(i: number) => {
        attachments = attachments.filter(
          (_attachment, attachmentIndex: number) => attachmentIndex !== i,
        );
        markDirty();
      }}
    />
  {/if}

  {#if sendError}
    <div class="smrt-compose-form__message" role="alert" aria-live="assertive">
      {sendError}
    </div>
  {/if}

  <div class="smrt-compose-form__actions" data-smrt-part="actions">
    <Button
      type="submit"
      variant="primary"
      disabled={isSending || isOverLimit}
    >
      {isSending ? 'Sending...' : 'Send'}
    </Button>
    <Button variant="secondary" onclick={handleSaveDraft}>
      {t(M['messages.compose_form.save_draft'])}
    </Button>
    <Button variant="ghost" class="btn-text" onclick={() => ondiscard?.()}>
      Discard
    </Button>
  </div>
</Form>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  /*
  * The form now renders through smrt-ui's <Form> (Provider-free base `<form>`).
  * `class="compose-form"` lands on the real `<form>` inside the Form child, so
  * `.smrt-compose-form__root :global(.compose-form)` anchors on the wrapper and
  * pierces the child scope to keep the column layout / padding (issue #1589).
  */
  .smrt-compose-form__root :global(.compose-form) {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-4);
  }
  .smrt-compose-form__field {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
    padding: var(--smrt-spacing-1) 0;
  }
  .smrt-compose-form__label {
    min-width: 56px;
  }
  /*
  * The From <Select> and Subject/Channel <Input>s now render through smrt-ui's
  * form primitives. These are naked, borderless inline fields that sit on the
  * `.smrt-compose-form__field` row's bottom-border, so `.smrt-compose-form__field :global([data-smrt-component="Select"])` /
  * `.smrt-compose-form__field :global(.text-input)` pierce the child scopes to strip the
  * primitives' border / background / focus box-shadow and restore the flush
  * inline look. `appearance: auto` brings back the Select's native arrow (the
  * primitive paints a chevron on its own background, which we've cleared) —
  * issue #1589.
  */
  .smrt-compose-form__field :global([data-smrt-component="Select"]),
  .smrt-compose-form__field :global(.text-input) {
    flex: 1;
    padding: var(--smrt-spacing-2) 0;
  }
  .smrt-compose-form__field :global([data-smrt-component="Select"]) {
    cursor: pointer;
  }
  .smrt-compose-form__toggles {
    display: flex;
    gap: var(--smrt-spacing-2);
    justify-content: flex-end;
  }
  .smrt-compose-form__body {
    position: relative;
  }
  .smrt-compose-form__count {
    padding-top: var(--smrt-spacing-1);
  }
  .smrt-compose-form__message {
    padding: var(--smrt-spacing-2) var(--smrt-spacing-3);
  }
  .smrt-compose-form__actions {
    display: flex;
    gap: var(--smrt-spacing-2);
    padding-top: var(--smrt-spacing-2);
  }
}

@layer smrt.theme {
  /*
  * The form now renders through smrt-ui's <Form> (Provider-free base `<form>`).
  * `class="compose-form"` lands on the real `<form>` inside the Form child, so
  * `.smrt-compose-form__root :global(.compose-form)` anchors on the wrapper and
  * pierces the child scope to keep the column layout / padding (issue #1589).
  */
  .smrt-compose-form__root :global(.compose-form) {
    font-family: var(--smrt-font-family, system-ui);
  }
  .smrt-compose-form__field {
    border-bottom: var(--smrt-hairline);
  }
  .smrt-compose-form__label {
    font-size: var(--smrt-typography-label-large-size);
    color: var(--smrt-color-on-surface-variant);
  }
  /*
  * The From <Select> and Subject/Channel <Input>s now render through smrt-ui's
  * form primitives. These are naked, borderless inline fields that sit on the
  * `.smrt-compose-form__field` row's bottom-border, so `.smrt-compose-form__field :global([data-smrt-component="Select"])` /
  * `.smrt-compose-form__field :global(.text-input)` pierce the child scopes to strip the
  * primitives' border / background / focus box-shadow and restore the flush
  * inline look. `appearance: auto` brings back the Select's native arrow (the
  * primitive paints a chevron on its own background, which we've cleared) —
  * issue #1589.
  */
  .smrt-compose-form__field :global([data-smrt-component="Select"]),
  .smrt-compose-form__field :global(.text-input) {
    border: none;
    outline: none;
    box-shadow: none;
    font-family: inherit;
    font-size: var(--smrt-typography-body-medium-size);
    background: transparent;
    color: var(--smrt-color-on-surface);
  }
  .smrt-compose-form__field :global([data-smrt-component="Select"]) {
    appearance: auto;
  }
  .smrt-compose-form__field :global([data-smrt-component="Select"]):focus,
  .smrt-compose-form__field :global(.text-input):focus {
    border: none;
    box-shadow: none;
  }
  /*
  * The Cc/Bcc toggles now render through smrt-ui's <Button variant="ghost">.
  * `.smrt-compose-form__toggles :global(.link-btn)` anchors on the real `.smrt-compose-form__toggles` element
  * and pierces the Button child scope to keep the underlined text-link look
  * (issue #1589).
  */
  .smrt-compose-form__toggles :global(.link-btn) {
    background: none;
    border: none;
    color: var(--smrt-color-primary);
    font-size: var(--smrt-typography-label-large-size);
    text-decoration: underline;
  }
  .smrt-compose-form__count {
    text-align: right;
    font-size: var(--smrt-typography-label-medium-size);
    color: var(--smrt-color-outline);
  }
  .smrt-compose-form__count.smrt-compose-form__over-limit {
    color: var(--smrt-color-error);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-compose-form__message {
    border-radius: var(--smrt-radius-sm);
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-on-error-container);
    font-size: var(--smrt-typography-body-small-size);
  }
  /*
  * Send/Save-draft now use Button's primary/secondary variants directly (dead
  * .btn-primary/.btn-secondary CSS removed). The Discard button keeps its
  * neutral on-surface-variant text via `.smrt-compose-form__actions :global(.btn-text)` (Button's
  * ghost uses the primary color) — issue #1589.
  */
  .smrt-compose-form__actions :global(.btn-text) {
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>
