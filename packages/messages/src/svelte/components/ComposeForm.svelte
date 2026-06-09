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
  import RecipientInput from './RecipientInput.svelte';
  import AttachmentUpload from './AttachmentUpload.svelte';

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

  function handleSend() {
    if (isSending) return;

    isSending = true;
    onsend?.(getCurrentState());
  }

  function handleSaveDraft() {
    onsavedraft?.(getCurrentState());
  }
</script>

<form class="compose-form" onsubmit={(e) => { e.preventDefault(); handleSend(); }}>
  {#if accounts.length > 1}
    <div class="field">
      <label class="field-label" for="compose-account">From</label>
      <select
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
      </select>
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
          <button type="button" class="link-btn" onclick={() => showCc = true}>Cc</button>
        {/if}
        {#if !showBcc}
          <button type="button" class="link-btn" onclick={() => showBcc = true}>Bcc</button>
        {/if}
      </div>
    {/if}

    <div class="field">
      <label class="field-label" for="compose-subject">Subject</label>
      <input
        id="compose-subject"
        type="text"
        class="text-input"
        bind:value={subject}
        oninput={markDirty}
        placeholder="Subject"
      />
    </div>
  {:else if type === 'slack'}
    <div class="field">
      <label class="field-label" for="compose-channel">Channel</label>
      <input
        id="compose-channel"
        type="text"
        class="text-input"
        bind:value={channelId}
        oninput={markDirty}
        placeholder="Channel ID"
      />
    </div>
  {/if}

  <div class="body-field">
    <textarea
      class="body-input"
      bind:value={body}
      oninput={markDirty}
      placeholder={type === 'tweet' ? "What's happening?" : 'Write your message...'}
      rows={type === 'tweet' ? 4 : 10}
    ></textarea>
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

  <div class="actions">
    <button
      type="submit"
      class="btn-primary"
      disabled={isSending || isOverLimit}
    >
      {isSending ? 'Sending...' : 'Send'}
    </button>
    <button type="button" class="btn-secondary" onclick={handleSaveDraft}>
      Save Draft
    </button>
    <button type="button" class="btn-text" onclick={() => ondiscard?.()}>
      Discard
    </button>
  </div>
</form>

<style>
  .compose-form {
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

  .select,
  .text-input {
    flex: 1;
    border: none;
    outline: none;
    font-family: inherit;
    font-size: var(--smrt-typography-body-medium-size, 14px);
    padding: var(--smrt-spacing-2, 8px) 0;
    background: transparent;
    color: var(--smrt-color-on-surface, #1c1b1f);
  }

  .cc-toggles {
    display: flex;
    gap: var(--smrt-spacing-2, 8px);
    justify-content: flex-end;
  }

  .link-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--smrt-color-primary, #6750a4);
    font-size: var(--smrt-typography-label-large-size, 13px);
    text-decoration: underline;
  }

  .body-field {
    position: relative;
  }

  .body-input {
    width: 100%;
    border: 1px solid var(--smrt-color-outline-variant, #cac4d0);
    border-radius: var(--smrt-radius-md, 12px);
    padding: var(--smrt-spacing-3, 12px);
    font-family: var(--smrt-font-family, system-ui);
    font-size: var(--smrt-typography-body-medium-size, 14px);
    resize: vertical;
    background: var(--smrt-color-surface, #fffbfe);
    color: var(--smrt-color-on-surface, #1c1b1f);
    box-sizing: border-box;
  }

  .body-input:focus {
    outline: 2px solid var(--smrt-color-primary, #6750a4);
    outline-offset: -1px;
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

  .actions {
    display: flex;
    gap: var(--smrt-spacing-2, 8px);
    padding-top: var(--smrt-spacing-2, 8px);
  }

  .btn-primary {
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-6, 24px);
    border-radius: var(--smrt-radius-full, 20px);
    border: none;
    background: var(--smrt-color-primary, #6750a4);
    color: var(--smrt-color-on-primary, #fff);
    font-family: var(--smrt-font-family, system-ui);
    font-size: var(--smrt-typography-label-large-size, 14px);
    cursor: pointer;
  }

  .btn-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn-secondary {
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-4, 16px);
    border-radius: var(--smrt-radius-full, 20px);
    border: 1px solid var(--smrt-color-outline, #79747e);
    background: transparent;
    color: var(--smrt-color-primary, #6750a4);
    font-family: var(--smrt-font-family, system-ui);
    font-size: var(--smrt-typography-label-large-size, 14px);
    cursor: pointer;
  }

  .btn-text {
    padding: var(--smrt-spacing-2, 8px) var(--smrt-spacing-4, 16px);
    border: none;
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #49454f);
    font-family: var(--smrt-font-family, system-ui);
    font-size: var(--smrt-typography-label-large-size, 14px);
    cursor: pointer;
  }
</style>
