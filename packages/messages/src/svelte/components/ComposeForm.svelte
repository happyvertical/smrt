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
    seed: Partial<ComposeState> | undefined,
    availableAccounts: AccountData[],
  ): ComposeState {
    return {
      accountId: seed?.accountId || availableAccounts[0]?.id || '',
      to: [...(seed?.to || [])],
      cc: [...(seed?.cc || [])],
      bcc: [...(seed?.bcc || [])],
      subject: seed?.subject || '',
      body: seed?.body || '',
      attachments: [...(seed?.attachments || [])],
      channelId: seed?.channelId || '',
      isDirty: false,
      isSending: false,
    };
  }

  let composeState = $state<ComposeState>(createComposeState(undefined, []));
  let showCc = $state(false);
  let showBcc = $state(false);
  let lastInitialState: Partial<ComposeState> | undefined = undefined;
  let lastAccounts: AccountData[] | undefined = undefined;

  $effect(() => {
    if (initialState !== lastInitialState || accounts !== lastAccounts) {
      lastInitialState = initialState;
      lastAccounts = accounts;
      composeState = createComposeState(initialState, accounts);
      showCc = Boolean(initialState?.cc?.length);
      showBcc = Boolean(initialState?.bcc?.length);
    }
  });

  const charCount = $derived(composeState.body.length);
  const isOverLimit = $derived(type === 'tweet' && charCount > 280);

  function markDirty() {
    composeState.isDirty = true;
  }

  function handleSend() {
    if (composeState.isSending) return;
    composeState.isSending = true;
    onsend?.(composeState);
  }

  function handleSaveDraft() {
    onsavedraft?.(composeState);
  }
</script>

<form class="compose-form" onsubmit={(e) => { e.preventDefault(); handleSend(); }}>
  {#if accounts.length > 1}
    <div class="field">
      <label class="field-label" for="compose-account">From</label>
      <select
        id="compose-account"
        class="select"
        bind:value={composeState.accountId}
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
      recipients={composeState.to}
      onchange={(r) => { composeState.to = r; markDirty(); }}
    />

    {#if showCc}
      <RecipientInput
        label="Cc"
        recipients={composeState.cc}
        onchange={(r) => { composeState.cc = r; markDirty(); }}
      />
    {/if}

    {#if showBcc}
      <RecipientInput
        label="Bcc"
        recipients={composeState.bcc}
        onchange={(r) => { composeState.bcc = r; markDirty(); }}
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
        bind:value={composeState.subject}
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
        bind:value={composeState.channelId}
        oninput={markDirty}
        placeholder="Channel ID"
      />
    </div>
  {/if}

  <div class="body-field">
    <textarea
      class="body-input"
      bind:value={composeState.body}
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
      attachments={composeState.attachments}
      onattach={(files) => {
        const newAttachments: AttachmentData[] = files.map((f) => ({
          id: crypto.randomUUID(),
          filename: f.name,
          contentType: f.type,
          size: f.size,
        }));
        composeState.attachments = [
          ...composeState.attachments,
          ...newAttachments,
        ];
        markDirty();
      }}
      onremove={(i) => {
        composeState.attachments = composeState.attachments.filter(
          (_attachment, idx) => idx !== i,
        );
        markDirty();
      }}
    />
  {/if}

  <div class="actions">
    <button
      type="submit"
      class="btn-primary"
      disabled={composeState.isSending || isOverLimit}
    >
      {composeState.isSending ? 'Sending...' : 'Send'}
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
    gap: 8px;
    padding: 16px;
    font-family: var(--smrt-typography-body, system-ui);
  }

  .field {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 0;
    border-bottom: 1px solid var(--smrt-color-outline-variant, #cac4d0);
  }

  .field-label {
    font-size: 14px;
    color: var(--smrt-color-on-surface-variant, #49454f);
    min-width: 56px;
  }

  .select,
  .text-input {
    flex: 1;
    border: none;
    outline: none;
    font-family: inherit;
    font-size: 14px;
    padding: 6px 0;
    background: transparent;
    color: var(--smrt-color-on-surface, #1c1b1f);
  }

  .cc-toggles {
    display: flex;
    gap: 8px;
    justify-content: flex-end;
  }

  .link-btn {
    background: none;
    border: none;
    cursor: pointer;
    color: var(--smrt-color-primary, #6750a4);
    font-size: 13px;
    text-decoration: underline;
  }

  .body-field {
    position: relative;
  }

  .body-input {
    width: 100%;
    border: 1px solid var(--smrt-color-outline-variant, #cac4d0);
    border-radius: var(--smrt-radius-md, 12px);
    padding: 12px;
    font-family: var(--smrt-typography-body, system-ui);
    font-size: 14px;
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
    font-size: 12px;
    color: var(--smrt-color-outline, #79747e);
    padding-top: 4px;
  }

  .char-count.over-limit {
    color: var(--smrt-color-error, #ba1a1a);
    font-weight: 600;
  }

  .actions {
    display: flex;
    gap: 8px;
    padding-top: 8px;
  }

  .btn-primary {
    padding: 8px 24px;
    border-radius: var(--smrt-radius-full, 20px);
    border: none;
    background: var(--smrt-color-primary, #6750a4);
    color: var(--smrt-color-on-primary, #fff);
    font-family: var(--smrt-typography-label, system-ui);
    font-size: 14px;
    cursor: pointer;
  }

  .btn-primary:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .btn-secondary {
    padding: 8px 16px;
    border-radius: var(--smrt-radius-full, 20px);
    border: 1px solid var(--smrt-color-outline, #79747e);
    background: transparent;
    color: var(--smrt-color-primary, #6750a4);
    font-family: var(--smrt-typography-label, system-ui);
    font-size: 14px;
    cursor: pointer;
  }

  .btn-text {
    padding: 8px 16px;
    border: none;
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #49454f);
    font-family: var(--smrt-typography-label, system-ui);
    font-size: 14px;
    cursor: pointer;
  }
</style>
