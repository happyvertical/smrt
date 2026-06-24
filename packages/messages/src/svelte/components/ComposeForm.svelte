<script lang="ts" module>
import type {
  AccountData,
  AttachmentData,
  ComposeState,
  RecipientEntry,
} from '../types.js';

export interface Props {
  type?: 'email' | 'slack' | 'tweet';
  accounts?: AccountData[];
  initialState?: Partial<ComposeState>;
  onsend?: (state: ComposeState) => void;
  onsavedraft?: (state: ComposeState) => void;
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

<div class="compose-form-shell">
<Form class="compose-form" onsubmit={handleSend}>
  {#if accounts.length > 1}
    <div class="field">
      <label class="field-label" for="compose-account">From</label>
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
      <div class="cc-toggles">
        {#if !showCc}
          <Button variant="ghost" size="sm" class="link-btn" onclick={() => showCc = true}>Cc</Button>
        {/if}
        {#if !showBcc}
          <Button variant="ghost" size="sm" class="link-btn" onclick={() => showBcc = true}>Bcc</Button>
        {/if}
      </div>
    {/if}

    <div class="field">
      <label class="field-label" for="compose-subject">Subject</label>
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
    <div class="field">
      <label class="field-label" for="compose-channel">Channel</label>
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

  <div class="body-field">
    <Textarea
      bind:value={body}
      oninput={markDirty}
      placeholder={type === 'tweet' ? "What's happening?" : 'Write your message...'}
      rows={type === 'tweet' ? 4 : 10}
    />
    {#if type === 'tweet'}
      <div class="char-count" class:over-limit={isOverLimit}>
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
    <div class="send-error" role="alert" aria-live="assertive">
      {sendError}
    </div>
  {/if}

  <div class="actions">
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
  /*
   * The form now renders through smrt-ui's <Form> (Provider-free base `<form>`).
   * `class="compose-form"` lands on the real `<form>` inside the Form child, so
   * `.compose-form-shell :global(.compose-form)` anchors on the wrapper and
   * pierces the child scope to keep the column layout / padding (issue #1589).
   */
  .compose-form-shell :global(.compose-form) {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-2, 8px);
    padding: var(--smrt-spacing-4, 16px);
    font-family: var(--smrt-font-family, system-ui);
  }

  .field {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2, 8px);
    padding: var(--smrt-spacing-1, 4px) 0;
    border-bottom: 1px solid var(--smrt-color-outline-variant, #cac4d0);
  }

  .field-label {
    font-size: var(--smrt-typography-label-large-size, 14px);
    color: var(--smrt-color-on-surface-variant, #49454f);
    min-width: 56px;
  }

  /*
   * The From <Select> and Subject/Channel <Input>s now render through smrt-ui's
   * form primitives. These are naked, borderless inline fields that sit on the
   * `.field` row's bottom-border, so `.field :global(.select)` /
   * `.field :global(.text-input)` pierce the child scopes to strip the
   * primitives' border / background / focus box-shadow and restore the flush
   * inline look. `appearance: auto` brings back the Select's native arrow (the
   * primitive paints a chevron on its own background, which we've cleared) —
   * issue #1589.
   */
  .field :global(.select),
  .field :global(.text-input) {
    flex: 1;
    border: none;
    outline: none;
    box-shadow: none;
    font-family: inherit;
    font-size: var(--smrt-typography-body-medium-size, 14px);
    padding: var(--smrt-spacing-2, 8px) 0;
    background: transparent;
    color: var(--smrt-color-on-surface, #1c1b1f);
  }

  .field :global(.select) {
    appearance: auto;
    cursor: pointer;
  }

  .field :global(.select):focus,
  .field :global(.text-input):focus {
    border: none;
    box-shadow: none;
  }

  .cc-toggles {
    display: flex;
    gap: var(--smrt-spacing-2, 8px);
    justify-content: flex-end;
  }

  /*
   * The Cc/Bcc toggles now render through smrt-ui's <Button variant="ghost">.
   * `.cc-toggles :global(.link-btn)` anchors on the real `.cc-toggles` element
   * and pierces the Button child scope to keep the underlined text-link look
   * (issue #1589).
   */
  .cc-toggles :global(.link-btn) {
    background: none;
    border: none;
    color: var(--smrt-color-primary, #6750a4);
    font-size: var(--smrt-typography-label-large-size, 13px);
    text-decoration: underline;
  }

  .body-field {
    position: relative;
  }

  .char-count {
    text-align: right;
    font-size: var(--smrt-typography-label-medium-size, 12px);
    color: var(--smrt-color-outline, #79747e);
    padding-top: var(--smrt-spacing-1, 4px);
  }

  .char-count.over-limit {
    color: var(--smrt-color-error, #ba1a1a);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .send-error {
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-3, 12px);
    border-radius: var(--smrt-radius-sm, 8px);
    background: var(--smrt-color-error-container, #ffdad6);
    color: var(--smrt-color-on-error-container, #410002);
    font-size: var(--smrt-typography-body-small-size, 12px);
  }

  .actions {
    display: flex;
    gap: var(--smrt-spacing-2, 8px);
    padding-top: var(--smrt-spacing-2, 8px);
  }

  /*
   * Send/Save-draft now use Button's primary/secondary variants directly (dead
   * .btn-primary/.btn-secondary CSS removed). The Discard button keeps its
   * neutral on-surface-variant text via `.actions :global(.btn-text)` (Button's
   * ghost uses the primary color) — issue #1589.
   */
  .actions :global(.btn-text) {
    color: var(--smrt-color-on-surface-variant, #49454f);
  }
</style>
