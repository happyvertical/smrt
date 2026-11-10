<script lang="ts">
/**
 * EmailAccountManager - Manage IMAP/SMTP email accounts
 *
 * Reusable component for adding, editing, testing, and removing
 * email accounts. Works with any backend via callback props.
 */
import { Input, Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../i18n.js';
import type { EmailAccountData } from '../types.js';

const { t } = useI18n();

export interface Props {
  /** Array of email accounts to display and manage. */
  accounts: EmailAccountData[];
  /** Disables editing and deletion when true; view-only mode. */
  readonly?: boolean;
  /** Called when user saves an account's settings. */
  onsave?: (data: Partial<EmailAccountData>, id?: string) => Promise<void>;
  /** Called when user deletes an account. */
  ondelete?: (account: EmailAccountData) => Promise<void>;
  /** Called when user tests account credentials. */
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
let actionError = $state<string | null>(null);

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
  actionError = null;
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
  // Never echo the stored secret into the DOM. Leave the password blank on edit
  // ('(unchanged)' placeholder); save() only writes a new password when one is
  // typed (see the `!editingId || maPassword` guard).
  maPassword = '';
  editingId = acct.id;
  showForm = true;
  testResult = null;
  actionError = null;
}

async function save() {
  if (!maName.trim() || !maEmail.trim() || !onsave) return;
  try {
    saving = true;
    actionError = null;
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
    actionError = e instanceof Error ? e.message : String(e);
  } finally {
    saving = false;
  }
}

async function remove(acct: EmailAccountData) {
  if (isReadonly || !ondelete) return;
  try {
    actionError = null;
    await ondelete(acct);
    if (editingId === acct.id) resetForm();
  } catch (e) {
    actionError = e instanceof Error ? e.message : String(e);
  }
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

<div class="smrt-email-account-manager__root" data-smrt-component="EmailAccountManager">
  <div class="smrt-email-account-manager__header" data-smrt-part="header">
    <div class="smrt-email-account-manager__description" data-smrt-part="description">
      {t(M['messages.email_account_manager.section_description'])}
    </div>
    {#if !isReadonly && onsave}
      <Button
        variant="secondary"
        size="sm"
        class="add-btn"
        onclick={() => { resetForm(); showForm = true; }}
      >{t(M['messages.email_account_manager.add_account'])}</Button>
    {/if}
  </div>

  {#if showForm}
    <div class="smrt-email-account-manager__form" data-smrt-part="field">
      <div class="smrt-email-account-manager__form-title" data-smrt-part="title">{editingId ? 'Edit' : 'Add'} {t(M['messages.email_account_manager.mail_account'])}</div>

      <div class="smrt-email-account-manager__row" data-smrt-part="row">
        <div class="smrt-email-account-manager__field" data-smrt-part="field" style="flex: 1;">
          <label class="smrt-email-account-manager__label" data-smrt-part="label" for="ea-name">{t(M['messages.email_account_manager.account_name'])}</label>
          <Input id="ea-name" class="form-input" type="text" bind:value={maName} placeholder={t(M['messages.email_account_manager.account_name_placeholder'])} />
        </div>
        <div class="smrt-email-account-manager__field" data-smrt-part="field" style="flex: 1;">
          <label class="smrt-email-account-manager__label" data-smrt-part="label" for="ea-email">{t(M['messages.email_account_manager.email_address'])}</label>
          <Input id="ea-email" class="form-input" type="email" bind:value={maEmail} placeholder={t(M['messages.email_account_manager.email_placeholder'])} />
        </div>
        <div class="smrt-email-account-manager__field" data-smrt-part="field" style="flex: 0 0 130px;">
          <label class="smrt-email-account-manager__label" data-smrt-part="label" for="ea-provider">Provider</label>
          <Select id="ea-provider" class="form-select" bind:value={maProviderType}>
            <option value="imap">IMAP</option>
            <option value="gmail">Gmail</option>
            <option value="outlook">Outlook</option>
            <option value="exchange">Exchange</option>
          </Select>
        </div>
      </div>

      <div class="smrt-email-account-manager__group-title" data-smrt-part="title">{t(M['messages.email_account_manager.incoming_mail'])}</div>
      <div class="smrt-email-account-manager__row" data-smrt-part="row">
        <div class="smrt-email-account-manager__field" data-smrt-part="field" style="flex: 2;">
          <label class="smrt-email-account-manager__label" data-smrt-part="label" for="ea-imap-host">Host</label>
          <Input id="ea-imap-host" class="form-input" type="text" bind:value={maImapHost} placeholder={t(M['messages.email_account_manager.imap_host_placeholder'])} />
        </div>
        <div class="smrt-email-account-manager__field" data-smrt-part="field" style="flex: 0 0 90px;">
          <label class="smrt-email-account-manager__label" data-smrt-part="label" for="ea-imap-port">Port</label>
          <Input id="ea-imap-port" class="form-input" type="number" bind:value={maImapPort} />
        </div>
        <div class="smrt-email-account-manager__field" data-smrt-part="field" style="flex: 0 0 120px;">
          <label class="smrt-email-account-manager__label" data-smrt-part="label" for="ea-imap-sec">Security</label>
          <Select id="ea-imap-sec" class="form-select" bind:value={maImapSecurity}>
            <option value="ssl">SSL/TLS</option>
            <option value="starttls">STARTTLS</option>
            <option value="none">None</option>
          </Select>
        </div>
      </div>

      <div class="smrt-email-account-manager__group-title" data-smrt-part="title">{t(M['messages.email_account_manager.outgoing_mail'])}</div>
      <div class="smrt-email-account-manager__row" data-smrt-part="row">
        <div class="smrt-email-account-manager__field" data-smrt-part="field" style="flex: 2;">
          <label class="smrt-email-account-manager__label" data-smrt-part="label" for="ea-smtp-host">Host</label>
          <Input id="ea-smtp-host" class="form-input" type="text" bind:value={maSmtpHost} placeholder={t(M['messages.email_account_manager.smtp_host_placeholder'])} />
        </div>
        <div class="smrt-email-account-manager__field" data-smrt-part="field" style="flex: 0 0 90px;">
          <label class="smrt-email-account-manager__label" data-smrt-part="label" for="ea-smtp-port">Port</label>
          <Input id="ea-smtp-port" class="form-input" type="number" bind:value={maSmtpPort} />
        </div>
        <div class="smrt-email-account-manager__field" data-smrt-part="field" style="flex: 0 0 120px;">
          <label class="smrt-email-account-manager__label" data-smrt-part="label" for="ea-smtp-sec">Security</label>
          <Select id="ea-smtp-sec" class="form-select" bind:value={maSmtpSecurity}>
            <option value="ssl">SSL/TLS</option>
            <option value="starttls">STARTTLS</option>
            <option value="none">None</option>
          </Select>
        </div>
      </div>

      <div class="smrt-email-account-manager__group-title" data-smrt-part="title">Credentials</div>
      <div class="smrt-email-account-manager__row" data-smrt-part="row">
        <div class="smrt-email-account-manager__field" data-smrt-part="field" style="flex: 1;">
          <label class="smrt-email-account-manager__label" data-smrt-part="label" for="ea-username">Username</label>
          <Input id="ea-username" class="form-input" type="text" bind:value={maUsername} placeholder={t(M['messages.email_account_manager.username_placeholder'])} />
        </div>
        <div class="smrt-email-account-manager__field" data-smrt-part="field" style="flex: 1;">
          <label class="smrt-email-account-manager__label" data-smrt-part="label" for="ea-password">Password</label>
          <Input id="ea-password" class="form-input" type="password" bind:value={maPassword} placeholder={editingId ? '(unchanged)' : ''} />
        </div>
        <div class="smrt-email-account-manager__field smrt-email-account-manager__checkbox-field" data-smrt-part="field">
          <label class="smrt-email-account-manager__label smrt-email-account-manager__checkbox-label" data-smrt-part="label">
            <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
            <input type="checkbox" bind:checked={maIsActive} />
            Active
          </label>
        </div>
      </div>

      <div class="smrt-email-account-manager__actions" data-smrt-part="actions">
        <Button variant="secondary" size="sm" class="cancel-btn" onclick={resetForm} disabled={saving}>Cancel</Button>
        <Button variant="primary" size="sm" class="save-btn" onclick={save} disabled={saving || !maName.trim() || !maEmail.trim()}>
          {saving ? 'Saving...' : editingId ? 'Update' : 'Add Account'}
        </Button>
      </div>
    </div>
  {/if}

  {#if actionError}
    <div class="smrt-email-account-manager__test-result smrt-email-account-manager__failure" data-smrt-part="message" role="alert" aria-live="assertive">
      {actionError}
      <Button
        variant="ghost"
        size="sm"
        class="dismiss-btn"
        aria-label={t(M['messages.email_account_manager.dismiss_error'])}
        onclick={() => actionError = null}
      >&times;</Button>
    </div>
  {/if}

  {#if testResult}
    <div class="smrt-email-account-manager__test-result" class:smrt-email-account-manager__success={testResult.success} class:smrt-email-account-manager__failure={!testResult.success} data-smrt-part="message">
      {#if testResult.success}
        {t(M['messages.email_account_manager.connection_successful'])}
      {:else}
        {t(M['messages.email_account_manager.connection_failed'])} {testResult.error ?? 'Unknown error'}
      {/if}
      <Button variant="ghost" size="sm" class="dismiss-btn" onclick={() => testResult = null}>&times;</Button>
    </div>
  {/if}

  {#if accounts.length === 0 && !showForm}
    <p class="smrt-email-account-manager__empty" data-smrt-part="empty">{t(M['messages.email_account_manager.empty'])}</p>
  {:else}
    <div class="smrt-email-account-manager__list" data-smrt-part="list">
      {#each accounts as acct}
        <div
          class="smrt-email-account-manager__entry smrt-email-account-manager__mail-account"
          class:smrt-email-account-manager__editing={editingId === acct.id}
          class:smrt-email-account-manager__inactive={!acct.isActive}
          data-smrt-part="item"
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
          <div class="smrt-email-account-manager__entry-main" data-smrt-part="body">
            <span class="smrt-email-account-manager__type-badge smrt-email-account-manager__provider" data-smrt-part="badge" title={acct.providerType}>{getProviderLabel(acct.providerType)}</span>
            <div class="smrt-email-account-manager__entry-info" data-smrt-part="meta">
              <span class="smrt-email-account-manager__entry-pattern" data-smrt-part="title">{acct.name}</span>
              <span class="smrt-email-account-manager__entry-description" data-smrt-part="description">{acct.email}</span>
            </div>
            {#if acct.imapHost}
              <span class="smrt-email-account-manager__host-tag" data-smrt-part="body" title={t(M['messages.email_account_manager.imap_host_title'], { host: acct.imapHost, port: acct.imapPort })}>{acct.imapHost}</span>
            {/if}
            {#if !acct.isActive}
              <span class="smrt-email-account-manager__inactive-tag" data-smrt-part="badge">inactive</span>
            {/if}
          </div>
          {#if !isReadonly}
            <div class="smrt-email-account-manager__entry-actions" data-smrt-part="actions">
              {#if ontest}
                <Button
                  variant="ghost"
                  size="sm"
                  class="test-btn"
                  onclick={(e) => { e.stopPropagation(); testConnection(acct); }}
                  disabled={testingId === acct.id}
                  title={t(M['messages.email_account_manager.test_connection'])}
                >
                  {testingId === acct.id ? '...' : 'Test'}
                </Button>
              {/if}
              {#if ondelete}
                <Button
                  variant="ghost"
                  size="sm"
                  class="delete-btn"
                  onclick={(e) => { e.stopPropagation(); remove(acct); }}
                  title={t(M['messages.email_account_manager.remove'])}
                >&times;</Button>
              {/if}
            </div>
          {/if}
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-email-account-manager__root {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .smrt-email-account-manager__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  /*
  * The add button now renders through smrt-ui's <Button variant="secondary">.
  * The variant owns the outlined-primary look + hover; `.smrt-email-account-manager__header
  * :global(.add-btn)` only re-asserts radius and the flex-shrink so the button
  * keeps its place in the header row (issue #1589).
  */
  .smrt-email-account-manager__header :global(.add-btn) {
    flex-shrink: 0;
  }
  .smrt-email-account-manager__form {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .smrt-email-account-manager__group-title {
    padding-top: 0.25rem;
  }
  .smrt-email-account-manager__row {
    display: flex;
    gap: 0.75rem;
    align-items: flex-end;
  }
  .smrt-email-account-manager__field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  /*
  * The account-form fields now render through smrt-ui's <Input> / <Select>,
  * which bring their own tokenised border / background / focus / placeholder
  * styling and honor prefers-reduced-motion themselves. The old `.form-input` /
  * `.form-select` rules (and their :focus / ::placeholder overrides) are dropped
  * as dead — they targeted the raw elements that now live inside the primitive
  * child scopes (issue #1589).
  */
  .smrt-email-account-manager__checkbox-field {
    justify-content: flex-end;
    padding-bottom: 0.5rem;
  }
  .smrt-email-account-manager__checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .smrt-email-account-manager__actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding-top: 0.25rem;
  }
  .smrt-email-account-manager__test-result {
    padding: 0.5rem 0.75rem;
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  /*
  * The dismiss button now renders through smrt-ui's <Button variant="ghost">.
  * `.smrt-email-account-manager__test-result :global(.dismiss-btn)` anchors on the real `.smrt-email-account-manager__test-result`
  * element and pierces the Button child scope. `color: inherit` keeps the icon
  * matching the success/failure banner color (issue #1589).
  */
  .smrt-email-account-manager__test-result :global(.dismiss-btn) {
    padding: 0 0.25rem;
  }
  .smrt-email-account-manager__list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .smrt-email-account-manager__entry {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
    cursor: pointer;
  }
  .smrt-email-account-manager__entry-main {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex: 1;
    min-width: 0;
  }
  .smrt-email-account-manager__entry-actions {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    flex-shrink: 0;
  }
  .smrt-email-account-manager__type-badge {
    padding: 0.25rem 0.5rem;
    flex-shrink: 0;
    min-width: 2rem;
  }
  .smrt-email-account-manager__type-badge.smrt-email-account-manager__provider {
    min-width: 3rem;
  }
  .smrt-email-account-manager__entry-info {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    flex: 1;
    min-width: 0;
  }
  .smrt-email-account-manager__entry-pattern {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-email-account-manager__host-tag {
    padding: 0.125rem 0.5rem;
    flex-shrink: 0;
  }
  .smrt-email-account-manager__inactive-tag {
    padding: 0.125rem 0.5rem;
    flex-shrink: 0;
  }
  /*
  * The test and delete buttons now render through smrt-ui's <Button
  * variant="ghost">. The <button> is emitted inside the Button child, so
  * `.smrt-email-account-manager__entry-actions :global(...)` anchors on the real `.smrt-email-account-manager__entry-actions` element
  * and pierces the child scope to keep the original outlined-pill styling and
  * the delete button's red-on-hover affordance (issue #1589).
  */
  .smrt-email-account-manager__entry-actions :global(.test-btn) {
    padding: 0.25rem 0.5rem;
  }
  .smrt-email-account-manager__entry-actions :global(.delete-btn) {
    padding: 0.125rem 0.5rem;
    flex-shrink: 0;
  }
  .smrt-email-account-manager__empty {
    padding: 2rem;
  }
}

@layer smrt.theme {
  .smrt-email-account-manager__description {
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
    color: var(--smrt-color-on-surface-variant);
  }
  /*
  * The add button now renders through smrt-ui's <Button variant="secondary">.
  * The variant owns the outlined-primary look + hover; `.smrt-email-account-manager__header
  * :global(.add-btn)` only re-asserts radius and the flex-shrink so the button
  * keeps its place in the header row (issue #1589).
  */
  .smrt-email-account-manager__header :global(.add-btn) {
    border-radius: var(--smrt-radius-md);
  }
  .smrt-email-account-manager__form {
    background: var(--smrt-color-surface-container);
    border: 1px solid var(--smrt-color-primary);
    border-radius: var(--smrt-radius-md);
  }
  .smrt-email-account-manager__form-title {
    font-size: var(--smrt-typography-title-small-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-primary);
  }
  .smrt-email-account-manager__group-title {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-on-surface-variant);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-medium-tracking, 0.05em);
  }
  .smrt-email-account-manager__label {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-email-account-manager__checkbox-label {
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
    color: var(--smrt-color-on-surface);
  }
  .smrt-email-account-manager__checkbox-label input[type="checkbox"] {
    accent-color: var(--smrt-color-primary);
  }
  /*
  * Cancel/Save now use Button's secondary/primary variants (dead bespoke CSS
  * removed). `.smrt-email-account-manager__actions :global(...)` only re-asserts the rounded radius so
  * they match the form's other controls (issue #1589). Cancel's neutral outline
  * color override keeps it from picking up secondary's primary border color.
  */
  .smrt-email-account-manager__actions :global(.cancel-btn),
  .smrt-email-account-manager__actions :global(.save-btn) {
    border-radius: var(--smrt-radius-md);
  }
  .smrt-email-account-manager__actions :global(.cancel-btn) {
    border-color: var(--smrt-hairline-color);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-email-account-manager__test-result {
    border-radius: var(--smrt-radius-md);
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
  }
  .smrt-email-account-manager__test-result.smrt-email-account-manager__success {
    background: var(--smrt-color-success-container);
    color: var(--smrt-color-success);
  }
  .smrt-email-account-manager__test-result.smrt-email-account-manager__failure {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-error);
  }
  /*
  * The dismiss button now renders through smrt-ui's <Button variant="ghost">.
  * `.smrt-email-account-manager__test-result :global(.dismiss-btn)` anchors on the real `.smrt-email-account-manager__test-result`
  * element and pierces the Button child scope. `color: inherit` keeps the icon
  * matching the success/failure banner color (issue #1589).
  */
  .smrt-email-account-manager__test-result :global(.dismiss-btn) {
    background: transparent;
    border: none;
    font-size: var(--smrt-typography-body-large-size, 1rem);
    color: inherit;
  }
  .smrt-email-account-manager__entry {
    background: var(--smrt-color-surface-container);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-md);
    transition: background 150ms ease, border-color 150ms ease;
  }
  .smrt-email-account-manager__entry:hover {
    background: var(--smrt-color-surface-container-high);
  }
  .smrt-email-account-manager__entry.smrt-email-account-manager__mail-account:hover {
    border-color: var(--smrt-color-primary);
  }
  .smrt-email-account-manager__entry.smrt-email-account-manager__editing {
    border-color: var(--smrt-color-primary);
    background: var(--smrt-color-surface-container-high);
  }
  .smrt-email-account-manager__entry.smrt-email-account-manager__inactive {
    opacity: 0.5;
  }
  .smrt-email-account-manager__type-badge {
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    font-family: var(--smrt-font-family-mono, monospace);
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-sm);
    text-align: center;
  }
  .smrt-email-account-manager__type-badge.smrt-email-account-manager__provider {
    font-family: inherit;
    font-size: var(--smrt-typography-label-small-size, 0.625rem);
    text-transform: uppercase;
    letter-spacing: var(--smrt-typography-label-small-tracking, 0.05em);
    background: var(--smrt-color-primary-container);
    color: var(--smrt-color-primary);
    border-color: transparent;
  }
  .smrt-email-account-manager__entry-pattern {
    font-weight: var(--smrt-typography-weight-medium, 500);
    font-size: var(--smrt-typography-title-small-size, 0.875rem);
  }
  .smrt-email-account-manager__entry-description {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-email-account-manager__host-tag {
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    font-family: var(--smrt-font-family-mono, monospace);
    color: var(--smrt-color-on-surface-variant);
    background: var(--smrt-color-surface);
    border-radius: var(--smrt-radius-sm);
  }
  .smrt-email-account-manager__inactive-tag {
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    color: var(--smrt-color-on-surface-variant);
    background: var(--smrt-color-surface-container-high);
    border-radius: var(--smrt-radius-full);
  }
  /*
  * The test and delete buttons now render through smrt-ui's <Button
  * variant="ghost">. The <button> is emitted inside the Button child, so
  * `.smrt-email-account-manager__entry-actions :global(...)` anchors on the real `.smrt-email-account-manager__entry-actions` element
  * and pierces the child scope to keep the original outlined-pill styling and
  * the delete button's red-on-hover affordance (issue #1589).
  */
  .smrt-email-account-manager__entry-actions :global(.test-btn) {
    border-radius: var(--smrt-radius-sm);
    border: var(--smrt-hairline);
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
  }
  .smrt-email-account-manager__entry-actions :global(.test-btn):hover:not(:disabled) {
    border-color: var(--smrt-color-primary);
    color: var(--smrt-color-primary);
  }
  .smrt-email-account-manager__entry-actions :global(.delete-btn) {
    font-size: var(--smrt-typography-body-large-size, 1rem);
    line-height: 1;
    border-radius: var(--smrt-radius-full);
    border: 1px solid transparent;
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-email-account-manager__entry-actions :global(.delete-btn):hover {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-error);
    border-color: var(--smrt-color-error);
  }
  .smrt-email-account-manager__empty {
    text-align: center;
    color: var(--smrt-color-on-surface-variant);
    background: var(--smrt-color-surface-container);
    border-radius: var(--smrt-radius-md);
  }
}

</style>
