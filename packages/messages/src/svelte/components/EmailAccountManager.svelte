<script lang="ts">
/**
 * EmailAccountManager - Manage IMAP/SMTP email accounts
 *
 * Reusable component for adding, editing, testing, and removing
 * email accounts. Works with any backend via callback props.
 */
import type { EmailAccountData } from '../types.js';

export interface Props {
  accounts: EmailAccountData[];
  readonly?: boolean;
  onsave?: (data: Partial<EmailAccountData>, id?: string) => Promise<void>;
  ondelete?: (account: EmailAccountData) => Promise<void>;
  ontest?: (
    account: EmailAccountData,
  ) => Promise<{ success: boolean; error?: string }>;
}

const {
  accounts,
  readonly: isReadonly = false,
  onsave,
  ondelete,
  ontest,
}: Props = $props();

let showForm = $state(false);
let editingId = $state<string | null>(null);
let saving = $state(false);
let testingId = $state<string | null>(null);
let testResult = $state<{ success: boolean; error?: string } | null>(null);

// Form state
let maName = $state('');
let maEmail = $state('');
let maProviderType = $state<'imap' | 'exchange' | 'gmail' | 'outlook'>('imap');
let maIsActive = $state(true);
let maImapHost = $state('');
let maImapPort = $state(993);
let maImapSecurity = $state<'ssl' | 'starttls' | 'none'>('ssl');
let maSmtpHost = $state('');
let maSmtpPort = $state(465);
let maSmtpSecurity = $state<'ssl' | 'starttls' | 'none'>('ssl');
let maUsername = $state('');
let maPassword = $state('');

function resetForm() {
  maName = '';
  maEmail = '';
  maProviderType = 'imap';
  maIsActive = true;
  maImapHost = '';
  maImapPort = 993;
  maImapSecurity = 'ssl';
  maSmtpHost = '';
  maSmtpPort = 465;
  maSmtpSecurity = 'ssl';
  maUsername = '';
  maPassword = '';
  editingId = null;
  showForm = false;
  testResult = null;
}

function startEdit(acct: EmailAccountData) {
  if (isReadonly) return;
  maName = acct.name;
  maEmail = acct.email;
  maProviderType = acct.providerType;
  maIsActive = acct.isActive;
  maImapHost = acct.imapHost ?? '';
  maImapPort = acct.imapPort ?? 993;
  maImapSecurity = acct.imapSecurity ?? 'ssl';
  maSmtpHost = acct.smtpHost ?? '';
  maSmtpPort = acct.smtpPort ?? 465;
  maSmtpSecurity = acct.smtpSecurity ?? 'ssl';
  maUsername = acct.username ?? '';
  maPassword = acct.password ?? '';
  editingId = acct.id;
  showForm = true;
  testResult = null;
}

async function save() {
  if (!maName.trim() || !maEmail.trim() || !onsave) return;
  try {
    saving = true;
    const data: Partial<EmailAccountData> = {
      name: maName.trim(),
      email: maEmail.trim(),
      providerType: maProviderType,
      isActive: maIsActive,
      imapHost: maImapHost.trim(),
      imapPort: maImapPort,
      imapSecurity: maImapSecurity,
      smtpHost: maSmtpHost.trim(),
      smtpPort: maSmtpPort,
      smtpSecurity: maSmtpSecurity,
      username: maUsername.trim(),
    };
    if (!editingId || maPassword) {
      data.password = maPassword;
    }
    await onsave(data, editingId ?? undefined);
    resetForm();
  } catch (e) {
  } finally {
    saving = false;
  }
}

async function remove(acct: EmailAccountData) {
  if (isReadonly || !ondelete) return;
  try {
    await ondelete(acct);
    if (editingId === acct.id) resetForm();
  } catch (e) {}
}

async function testConnection(acct: EmailAccountData) {
  if (!ontest) return;
  try {
    testingId = acct.id;
    testResult = null;
    testResult = await ontest(acct);
  } catch (e) {
    testResult = {
      success: false,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    testingId = null;
  }
}

function getProviderLabel(type: string): string {
  switch (type) {
    case 'imap':
      return 'IMAP';
    case 'exchange':
      return 'Exchange';
    case 'gmail':
      return 'Gmail';
    case 'outlook':
      return 'Outlook';
    default:
      return type;
  }
}
</script>

<div class="email-account-manager">
  <div class="section-header-row">
    <div class="section-description">
      Configure email accounts for mailbox access and message routing.
    </div>
    {#if !isReadonly && onsave}
      <button
        class="add-btn"
        onclick={() => { resetForm(); showForm = true; }}
      >+ Add Account</button>
    {/if}
  </div>

  {#if showForm}
    <div class="entry-form">
      <div class="form-title">{editingId ? 'Edit' : 'Add'} Mail Account</div>

      <div class="form-row">
        <div class="form-field" style="flex: 1;">
          <label class="form-label" for="ea-name">Account Name</label>
          <input id="ea-name" class="form-input" type="text" bind:value={maName} placeholder="e.g. Work, Personal" />
        </div>
        <div class="form-field" style="flex: 1;">
          <label class="form-label" for="ea-email">Email Address</label>
          <input id="ea-email" class="form-input" type="email" bind:value={maEmail} placeholder="user@example.com" />
        </div>
        <div class="form-field" style="flex: 0 0 130px;">
          <label class="form-label" for="ea-provider">Provider</label>
          <select id="ea-provider" class="form-select" bind:value={maProviderType}>
            <option value="imap">IMAP</option>
            <option value="gmail">Gmail</option>
            <option value="outlook">Outlook</option>
            <option value="exchange">Exchange</option>
          </select>
        </div>
      </div>

      <div class="form-section-label">Incoming Mail (IMAP)</div>
      <div class="form-row">
        <div class="form-field" style="flex: 2;">
          <label class="form-label" for="ea-imap-host">Host</label>
          <input id="ea-imap-host" class="form-input" type="text" bind:value={maImapHost} placeholder="imap.example.com" />
        </div>
        <div class="form-field" style="flex: 0 0 90px;">
          <label class="form-label" for="ea-imap-port">Port</label>
          <input id="ea-imap-port" class="form-input" type="number" bind:value={maImapPort} />
        </div>
        <div class="form-field" style="flex: 0 0 120px;">
          <label class="form-label" for="ea-imap-sec">Security</label>
          <select id="ea-imap-sec" class="form-select" bind:value={maImapSecurity}>
            <option value="ssl">SSL/TLS</option>
            <option value="starttls">STARTTLS</option>
            <option value="none">None</option>
          </select>
        </div>
      </div>

      <div class="form-section-label">Outgoing Mail (SMTP)</div>
      <div class="form-row">
        <div class="form-field" style="flex: 2;">
          <label class="form-label" for="ea-smtp-host">Host</label>
          <input id="ea-smtp-host" class="form-input" type="text" bind:value={maSmtpHost} placeholder="smtp.example.com" />
        </div>
        <div class="form-field" style="flex: 0 0 90px;">
          <label class="form-label" for="ea-smtp-port">Port</label>
          <input id="ea-smtp-port" class="form-input" type="number" bind:value={maSmtpPort} />
        </div>
        <div class="form-field" style="flex: 0 0 120px;">
          <label class="form-label" for="ea-smtp-sec">Security</label>
          <select id="ea-smtp-sec" class="form-select" bind:value={maSmtpSecurity}>
            <option value="ssl">SSL/TLS</option>
            <option value="starttls">STARTTLS</option>
            <option value="none">None</option>
          </select>
        </div>
      </div>

      <div class="form-section-label">Credentials</div>
      <div class="form-row">
        <div class="form-field" style="flex: 1;">
          <label class="form-label" for="ea-username">Username</label>
          <input id="ea-username" class="form-input" type="text" bind:value={maUsername} placeholder="user@example.com" />
        </div>
        <div class="form-field" style="flex: 1;">
          <label class="form-label" for="ea-password">Password</label>
          <input id="ea-password" class="form-input" type="password" bind:value={maPassword} placeholder={editingId ? '(unchanged)' : ''} />
        </div>
        <div class="form-field checkbox-field">
          <label class="form-label checkbox-label">
            <input type="checkbox" bind:checked={maIsActive} />
            Active
          </label>
        </div>
      </div>

      <div class="form-actions">
        <button class="cancel-btn" onclick={resetForm} disabled={saving}>Cancel</button>
        <button class="save-btn" onclick={save} disabled={saving || !maName.trim() || !maEmail.trim()}>
          {saving ? 'Saving...' : editingId ? 'Update' : 'Add Account'}
        </button>
      </div>
    </div>
  {/if}

  {#if testResult}
    <div class="test-result" class:success={testResult.success} class:failure={!testResult.success}>
      {#if testResult.success}
        Connection successful
      {:else}
        Connection failed: {testResult.error ?? 'Unknown error'}
      {/if}
      <button class="dismiss-btn" onclick={() => testResult = null}>&times;</button>
    </div>
  {/if}

  {#if accounts.length === 0 && !showForm}
    <p class="placeholder">No mail accounts configured yet.</p>
  {:else}
    <div class="entries-list">
      {#each accounts as acct}
        <div
          class="entry-card mail-account"
          class:editing={editingId === acct.id}
          class:inactive={!acct.isActive}
          role="button"
          tabindex="0"
          onclick={() => startEdit(acct)}
          onkeydown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              startEdit(acct);
            }
          }}
        >
          <div class="entry-main">
            <span class="type-badge provider" title={acct.providerType}>{getProviderLabel(acct.providerType)}</span>
            <div class="entry-info">
              <span class="entry-pattern">{acct.name}</span>
              <span class="entry-description">{acct.email}</span>
            </div>
            {#if acct.imapHost}
              <span class="host-tag" title="IMAP: {acct.imapHost}:{acct.imapPort}">{acct.imapHost}</span>
            {/if}
            {#if !acct.isActive}
              <span class="inactive-tag">inactive</span>
            {/if}
          </div>
          {#if !isReadonly}
            <div class="entry-actions">
              {#if ontest}
                <button
                  class="test-btn"
                  onclick={(e) => { e.stopPropagation(); testConnection(acct); }}
                  disabled={testingId === acct.id}
                  title="Test connection"
                >
                  {testingId === acct.id ? '...' : 'Test'}
                </button>
              {/if}
              {#if ondelete}
                <button
                  class="delete-btn"
                  onclick={(e) => { e.stopPropagation(); remove(acct); }}
                  title="Remove"
                >&times;</button>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .email-account-manager {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .section-header-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }

  .section-description {
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .add-btn {
    padding: 0.375rem 0.75rem;
    border-radius: var(--smrt-radius-md, 8px);
    border: 1px solid var(--smrt-color-primary, #005ac1);
    background: transparent;
    color: var(--smrt-color-primary, #005ac1);
    cursor: pointer;
    font-size: var(--smrt-typography-label-large-size, 0.8125rem);
    font-family: inherit;
    font-weight: var(--smrt-typography-weight-medium, 500);
    transition: all 150ms ease;
    flex-shrink: 0;
  }

  .add-btn:hover {
    background: var(--smrt-color-primary, #005ac1);
    color: var(--smrt-color-on-primary, #fff);
  }

  .entry-form {
    background: var(--smrt-color-surface-container, #f0f1f9);
    border: 1px solid var(--smrt-color-primary, #005ac1);
    border-radius: var(--smrt-radius-md, 8px);
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .form-title {
    font-size: var(--smrt-typography-title-small-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-primary, #005ac1);
  }

  .form-section-label {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface-variant, #43474e);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.05em);
    padding-top: 0.25rem;
  }

  .form-row {
    display: flex;
    gap: 0.75rem;
    align-items: flex-end;
  }

  .form-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .form-label {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .form-input,
  .form-select {
    padding: 0.5rem 0.625rem;
    border-radius: var(--smrt-radius-md, 8px);
    border: 1px solid var(--smrt-color-outline-variant, #c2c7cf);
    background: var(--smrt-color-surface, #fefbff);
    color: var(--smrt-color-on-surface, #1a1c1e);
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
    font-family: inherit;
    transition: border-color 150ms ease;
  }

  .form-input:focus,
  .form-select:focus {
    outline: none;
    border-color: var(--smrt-color-primary, #005ac1);
  }

  .form-input::placeholder {
    color: var(--smrt-color-on-surface-variant, #43474e);
    opacity: 0.5;
  }

  .checkbox-field {
    justify-content: flex-end;
    padding-bottom: 0.5rem;
  }

  .checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
    color: var(--smrt-color-on-surface, #1a1c1e);
    white-space: nowrap;
  }

  .checkbox-label input[type="checkbox"] {
    accent-color: var(--smrt-color-primary, #005ac1);
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding-top: 0.25rem;
  }

  .cancel-btn {
    padding: 0.375rem 0.75rem;
    border-radius: var(--smrt-radius-md, 8px);
    border: 1px solid var(--smrt-color-outline-variant, #c2c7cf);
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #43474e);
    cursor: pointer;
    font-size: var(--smrt-typography-label-large-size, 0.8125rem);
    font-family: inherit;
    transition: all 150ms ease;
  }

  .cancel-btn:hover {
    background: var(--smrt-color-surface-container-high, #e6e7ef);
  }

  .save-btn {
    padding: 0.375rem 0.75rem;
    border-radius: var(--smrt-radius-md, 8px);
    border: 1px solid var(--smrt-color-primary, #005ac1);
    background: var(--smrt-color-primary, #005ac1);
    color: var(--smrt-color-on-primary, #fff);
    cursor: pointer;
    font-size: var(--smrt-typography-label-large-size, 0.8125rem);
    font-family: inherit;
    font-weight: var(--smrt-typography-weight-medium, 500);
    transition: all 150ms ease;
  }

  .save-btn:hover:not(:disabled) {
    opacity: 0.9;
  }

  .save-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .test-result {
    padding: 0.5rem 0.75rem;
    border-radius: var(--smrt-radius-md, 8px);
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .test-result.success {
    background: var(--smrt-color-success-container, #dcfce7);
    color: var(--smrt-color-success, #16a34a);
  }

  .test-result.failure {
    background: var(--smrt-color-error-container, #fce4ec);
    color: var(--smrt-color-error, #ba1a1a);
  }

  .dismiss-btn {
    background: transparent;
    border: none;
    font-size: var(--smrt-typography-body-large-size, 1rem);
    cursor: pointer;
    color: inherit;
    padding: 0 0.25rem;
  }

  .entries-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .entry-card {
    display: flex;
    align-items: center;
    justify-content: space-between;
    background: var(--smrt-color-surface-container, #f0f1f9);
    border: 1px solid var(--smrt-color-outline-variant, #c2c7cf);
    border-radius: var(--smrt-radius-md, 8px);
    padding: 0.75rem 1rem;
    cursor: pointer;
    transition: background 150ms ease, border-color 150ms ease;
  }

  .entry-card:hover {
    background: var(--smrt-color-surface-container-high, #e6e7ef);
  }

  .entry-card.mail-account:hover {
    border-color: var(--smrt-color-primary, #005ac1);
  }

  .entry-card.editing {
    border-color: var(--smrt-color-primary, #005ac1);
    background: var(--smrt-color-surface-container-high, #e6e7ef);
  }

  .entry-card.inactive {
    opacity: 0.5;
  }

  .entry-main {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex: 1;
    min-width: 0;
  }

  .entry-actions {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex-shrink: 0;
  }

  .type-badge {
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    font-family: var(--smrt-font-family-mono, monospace);
    background: var(--smrt-color-surface, #fefbff);
    border: 1px solid var(--smrt-color-outline-variant, #c2c7cf);
    padding: 0.25rem 0.5rem;
    border-radius: var(--smrt-radius-sm, 4px);
    flex-shrink: 0;
    min-width: 2rem;
    text-align: center;
  }

  .type-badge.provider {
    font-family: inherit;
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-small-tracking, 0.05em);
    background: var(--smrt-color-primary-container, #d8e2ff);
    color: var(--smrt-color-primary, #005ac1);
    border-color: transparent;
    min-width: 3rem;
  }

  .entry-info {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    flex: 1;
    min-width: 0;
  }

  .entry-pattern {
    font-weight: var(--smrt-typography-weight-medium, 500);
    font-size: var(--smrt-typography-title-small-size, 0.875rem);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .entry-description {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .host-tag {
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    font-family: var(--smrt-font-family-mono, monospace);
    color: var(--smrt-color-on-surface-variant, #43474e);
    background: var(--smrt-color-surface, #fefbff);
    padding: 0.125rem 0.5rem;
    border-radius: var(--smrt-radius-sm, 4px);
    flex-shrink: 0;
  }

  .inactive-tag {
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    color: var(--smrt-color-on-surface-variant, #43474e);
    background: var(--smrt-color-surface-container-high, #e6e7ef);
    padding: 0.125rem 0.5rem;
    border-radius: var(--smrt-radius-full, 9999px);
    flex-shrink: 0;
  }

  .test-btn {
    padding: 0.25rem 0.5rem;
    border-radius: var(--smrt-radius-sm, 4px);
    border: 1px solid var(--smrt-color-outline-variant, #c2c7cf);
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #43474e);
    cursor: pointer;
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    font-family: inherit;
    transition: all 150ms ease;
  }

  .test-btn:hover:not(:disabled) {
    border-color: var(--smrt-color-primary, #005ac1);
    color: var(--smrt-color-primary, #005ac1);
  }

  .test-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .delete-btn {
    font-size: var(--smrt-typography-body-large-size, 1rem);
    line-height: 1;
    padding: 0.125rem 0.5rem;
    border-radius: var(--smrt-radius-full, 9999px);
    border: 1px solid transparent;
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #43474e);
    cursor: pointer;
    font-family: inherit;
    transition: all 150ms ease;
    flex-shrink: 0;
  }

  .delete-btn:hover {
    background: var(--smrt-color-error-container, #fce4ec);
    color: var(--smrt-color-error, #ba1a1a);
    border-color: var(--smrt-color-error, #ba1a1a);
  }

  .placeholder {
    padding: 2rem;
    text-align: center;
    color: var(--smrt-color-on-surface-variant, #43474e);
    background: var(--smrt-color-surface-container, #f0f1f9);
    border-radius: var(--smrt-radius-md, 8px);
  }
</style>
