<script lang="ts">
/**
 * EmailFilterManager - Combined whitelist/blacklist management
 *
 * Reusable component for managing email allow/block lists.
 * Works with any backend via callback props.
 */
import { Input, Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { M } from '../i18n.js';
import type { BlacklistEntry, WhitelistEntry } from '../types.js';

const { t } = useI18n();

export interface Props {
  /** Array of allowed email addresses, domains, or patterns. */
  whitelist: WhitelistEntry[];
  /** Array of blocked email addresses, domains, or patterns. */
  blacklist: BlacklistEntry[];
  /** Disables editing and deletion when true; view-only mode. */
  readonly?: boolean;
  /** Called when user adds an address to the whitelist. */
  onaddwhitelist?: (data: Omit<WhitelistEntry, 'id'>) => Promise<void>;
  /** Called when user removes an address from the whitelist. */
  onremovewhitelist?: (entry: WhitelistEntry) => Promise<void>;
  /** Called when user adds an address to the blacklist. */
  onaddblacklist?: (data: Omit<BlacklistEntry, 'id'>) => Promise<void>;
  /** Called when user removes an address from the blacklist. */
  onremoveblacklist?: (entry: BlacklistEntry) => Promise<void>;
}

const {
  whitelist,
  blacklist,
  readonly: isReadonly = false,
  onaddwhitelist,
  onremovewhitelist,
  onaddblacklist,
  onremoveblacklist,
}: Props = $props();

type ActiveSection = 'whitelist' | 'blacklist';
let activeSection = $state<ActiveSection>('whitelist');
let filterError = $state<string | null>(null);

function toErrorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

// Whitelist form state
let showWhitelistForm = $state(false);
let savingWhitelist = $state(false);
let wlPattern = $state('');
let wlType = $state<'email' | 'domain' | 'regex'>('email');
let wlCategory = $state('');
let wlDescription = $state('');

// Blacklist form state
let showBlacklistForm = $state(false);
let savingBlacklist = $state(false);
let blPattern = $state('');
let blType = $state<'email' | 'domain' | 'regex'>('email');
let blReason = $state('');
let blAutoArchive = $state(true);

function resetWhitelistForm() {
  wlPattern = '';
  wlType = 'email';
  wlCategory = '';
  wlDescription = '';
  showWhitelistForm = false;
}

function resetBlacklistForm() {
  blPattern = '';
  blType = 'email';
  blReason = '';
  blAutoArchive = true;
  showBlacklistForm = false;
}

async function saveWhitelistEntry() {
  if (!wlPattern.trim() || !onaddwhitelist) return;
  try {
    savingWhitelist = true;
    filterError = null;
    await onaddwhitelist({
      pattern: wlPattern.trim(),
      type: wlType,
      category: wlCategory.trim() || null,
      description: wlDescription.trim(),
    });
    resetWhitelistForm();
  } catch (e) {
    filterError = toErrorMessage(e);
  } finally {
    savingWhitelist = false;
  }
}

async function removeWhitelistEntry(entry: WhitelistEntry) {
  if (isReadonly || !onremovewhitelist) return;
  try {
    filterError = null;
    await onremovewhitelist(entry);
  } catch (e) {
    filterError = toErrorMessage(e);
  }
}

async function saveBlacklistEntry() {
  if (!blPattern.trim() || !onaddblacklist) return;
  try {
    savingBlacklist = true;
    filterError = null;
    await onaddblacklist({
      pattern: blPattern.trim(),
      type: blType,
      reason: blReason.trim(),
      autoArchive: blAutoArchive,
    });
    resetBlacklistForm();
  } catch (e) {
    filterError = toErrorMessage(e);
  } finally {
    savingBlacklist = false;
  }
}

async function removeBlacklistEntry(entry: BlacklistEntry) {
  if (isReadonly || !onremoveblacklist) return;
  try {
    filterError = null;
    await onremoveblacklist(entry);
  } catch (e) {
    filterError = toErrorMessage(e);
  }
}

function getTypeIcon(type: string): string {
  switch (type) {
    case 'email':
      return '@';
    case 'domain':
      return '*.';
    case 'regex':
      return '/r/';
    default:
      return '?';
  }
}

function getPatternPlaceholder(type: string): string {
  switch (type) {
    case 'email':
      return 'user@example.com';
    case 'domain':
      return 'example.com';
    case 'regex':
      return '.*@example\\.com';
    default:
      return '';
  }
}
</script>

<div class="smrt-email-filter-manager__root" data-smrt-component="EmailFilterManager">
  <div class="smrt-email-filter-manager__toggle" data-smrt-part="trigger">
    <Button
      variant={activeSection === 'whitelist' ? 'primary' : 'ghost'}
      size="sm"
      class="section-btn"
      onclick={() => activeSection = 'whitelist'}
    >
      Whitelist
      <span class="smrt-email-filter-manager__count" data-smrt-part="count">{whitelist.length}</span>
    </Button>
    <Button
      variant={activeSection === 'blacklist' ? 'primary' : 'ghost'}
      size="sm"
      class="section-btn"
      onclick={() => activeSection = 'blacklist'}
    >
      Blacklist
      <span class="smrt-email-filter-manager__count" data-smrt-part="count">{blacklist.length}</span>
    </Button>
  </div>

  {#if filterError}
    <div class="smrt-email-filter-manager__error" data-smrt-part="error" role="alert" aria-live="assertive">
      {filterError}
      <Button
        variant="ghost"
        size="sm"
        class="dismiss-btn"
        aria-label={t(M['messages.email_filter_manager.dismiss_error'])}
        onclick={() => filterError = null}
      >&times;</Button>
    </div>
  {/if}

  <!-- Whitelist Section -->
  {#if activeSection === 'whitelist'}
    <div class="smrt-email-filter-manager__content" data-smrt-part="body">
      <div class="smrt-email-filter-manager__header" data-smrt-part="header">
        <div class="smrt-email-filter-manager__description" data-smrt-part="description">
          {t(M['messages.email_filter_manager.whitelist_description'])}
        </div>
        {#if !isReadonly && onaddwhitelist}
          <Button
            variant="secondary"
            size="sm"
            class="add-btn"
            onclick={() => { resetWhitelistForm(); showWhitelistForm = true; }}
          >+ Add</Button>
        {/if}
      </div>

      {#if showWhitelistForm}
        <div class="smrt-email-filter-manager__form" data-smrt-part="field">
          <div class="smrt-email-filter-manager__form-title" data-smrt-part="title">{t(M['messages.email_filter_manager.add_whitelist_entry'])}</div>
          <div class="smrt-email-filter-manager__row" data-smrt-part="row">
            <div class="smrt-email-filter-manager__field" data-smrt-part="field" style="flex: 0 0 120px;">
              <label class="smrt-email-filter-manager__label" data-smrt-part="label" for="wl-type">Type</label>
              <Select id="wl-type" class="form-select" bind:value={wlType}>
                <option value="email">Email</option>
                <option value="domain">Domain</option>
                <option value="regex">Regex</option>
              </Select>
            </div>
            <div class="smrt-email-filter-manager__field" data-smrt-part="field" style="flex: 1;">
              <label class="smrt-email-filter-manager__label" data-smrt-part="label" for="wl-pattern">Pattern</label>
              <Input
                id="wl-pattern"
                class="form-input"
                type="text"
                bind:value={wlPattern}
                placeholder={getPatternPlaceholder(wlType)}
              />
            </div>
          </div>
          <div class="smrt-email-filter-manager__row" data-smrt-part="row">
            <div class="smrt-email-filter-manager__field" data-smrt-part="field" style="flex: 1;">
              <label class="smrt-email-filter-manager__label" data-smrt-part="label" for="wl-category">Category <span class="smrt-email-filter-manager__optional" data-smrt-part="meta">(optional)</span></label>
              <Input
                id="wl-category"
                class="form-input"
                type="text"
                bind:value={wlCategory}
                placeholder={t(M['messages.email_filter_manager.category_placeholder'])}
              />
            </div>
            <div class="smrt-email-filter-manager__field" data-smrt-part="field" style="flex: 2;">
              <label class="smrt-email-filter-manager__label" data-smrt-part="label" for="wl-desc">Description</label>
              <Input
                id="wl-desc"
                class="form-input"
                type="text"
                bind:value={wlDescription}
                placeholder={t(M['messages.email_filter_manager.whitelist_description_placeholder'])}
              />
            </div>
          </div>
          <div class="smrt-email-filter-manager__actions" data-smrt-part="actions">
            <Button variant="secondary" size="sm" class="cancel-btn" onclick={resetWhitelistForm} disabled={savingWhitelist}>Cancel</Button>
            <Button variant="primary" size="sm" class="save-btn" onclick={saveWhitelistEntry} disabled={savingWhitelist || !wlPattern.trim()}>
              {savingWhitelist ? 'Saving...' : 'Add'}
            </Button>
          </div>
        </div>
      {/if}

      {#if whitelist.length === 0 && !showWhitelistForm}
        <p class="smrt-email-filter-manager__empty" data-smrt-part="empty">{t(M['messages.email_filter_manager.no_whitelist_entries'])}</p>
      {:else}
        <div class="smrt-email-filter-manager__list" data-smrt-part="list">
          {#each whitelist as entry}
            <div class="smrt-email-filter-manager__entry smrt-email-filter-manager__allow" data-smrt-part="item">
              <div class="smrt-email-filter-manager__body" data-smrt-part="body">
                <span class="smrt-email-filter-manager__icon" data-smrt-part="icon" title={entry.type}>{getTypeIcon(entry.type)}</span>
                <div class="smrt-email-filter-manager__meta" data-smrt-part="meta">
                  <span class="smrt-email-filter-manager__pattern" data-smrt-part="value">{entry.pattern}</span>
                  {#if entry.description}
                    <span class="smrt-email-filter-manager__entry-description" data-smrt-part="description">{entry.description}</span>
                  {/if}
                </div>
                {#if entry.category}
                  <span class="smrt-email-filter-manager__category-tag" data-smrt-part="meta">{entry.category}</span>
                {/if}
              </div>
              {#if !isReadonly && onremovewhitelist}
                <Button
                  variant="ghost"
                  size="sm"
                  class="delete-btn"
                  onclick={() => removeWhitelistEntry(entry)}
                  title={t(M['messages.email_filter_manager.whitelist_remove'])}
                >&times;</Button>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>

  <!-- Blacklist Section -->
  {:else}
    <div class="smrt-email-filter-manager__content" data-smrt-part="body">
      <div class="smrt-email-filter-manager__header" data-smrt-part="header">
        <div class="smrt-email-filter-manager__description" data-smrt-part="description">
          {t(M['messages.email_filter_manager.blacklist_description'])}
        </div>
        {#if !isReadonly && onaddblacklist}
          <Button
            variant="secondary"
            size="sm"
            class="add-btn"
            onclick={() => { resetBlacklistForm(); showBlacklistForm = true; }}
          >+ Add</Button>
        {/if}
      </div>

      {#if showBlacklistForm}
        <div class="smrt-email-filter-manager__form" data-smrt-part="field">
          <div class="smrt-email-filter-manager__form-title" data-smrt-part="title">{t(M['messages.email_filter_manager.add_blacklist_entry'])}</div>
          <div class="smrt-email-filter-manager__row" data-smrt-part="row">
            <div class="smrt-email-filter-manager__field" data-smrt-part="field" style="flex: 0 0 120px;">
              <label class="smrt-email-filter-manager__label" data-smrt-part="label" for="bl-type">Type</label>
              <Select id="bl-type" class="form-select" bind:value={blType}>
                <option value="email">Email</option>
                <option value="domain">Domain</option>
                <option value="regex">Regex</option>
              </Select>
            </div>
            <div class="smrt-email-filter-manager__field" data-smrt-part="field" style="flex: 1;">
              <label class="smrt-email-filter-manager__label" data-smrt-part="label" for="bl-pattern">Pattern</label>
              <Input
                id="bl-pattern"
                class="form-input"
                type="text"
                bind:value={blPattern}
                placeholder={getPatternPlaceholder(blType)}
              />
            </div>
          </div>
          <div class="smrt-email-filter-manager__row" data-smrt-part="row">
            <div class="smrt-email-filter-manager__field" data-smrt-part="field" style="flex: 1;">
              <label class="smrt-email-filter-manager__label" data-smrt-part="label" for="bl-reason">Reason</label>
              <Input
                id="bl-reason"
                class="form-input"
                type="text"
                bind:value={blReason}
                placeholder={t(M['messages.email_filter_manager.reason_placeholder'])}
              />
            </div>
            <div class="smrt-email-filter-manager__field smrt-email-filter-manager__checkbox-field" data-smrt-part="field">
              <label class="smrt-email-filter-manager__label smrt-email-filter-manager__checkbox-label" data-smrt-part="label">
                <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
                <input type="checkbox" bind:checked={blAutoArchive} />
                Auto-archive
              </label>
            </div>
          </div>
          <div class="smrt-email-filter-manager__actions" data-smrt-part="actions">
            <Button variant="secondary" size="sm" class="cancel-btn" onclick={resetBlacklistForm} disabled={savingBlacklist}>Cancel</Button>
            <Button variant="primary" size="sm" class="save-btn" onclick={saveBlacklistEntry} disabled={savingBlacklist || !blPattern.trim()}>
              {savingBlacklist ? 'Saving...' : 'Add'}
            </Button>
          </div>
        </div>
      {/if}

      {#if blacklist.length === 0 && !showBlacklistForm}
        <p class="smrt-email-filter-manager__empty" data-smrt-part="empty">{t(M['messages.email_filter_manager.no_blacklist_entries'])}</p>
      {:else}
        <div class="smrt-email-filter-manager__list" data-smrt-part="list">
          {#each blacklist as entry}
            <div class="smrt-email-filter-manager__entry smrt-email-filter-manager__block" data-smrt-part="item">
              <div class="smrt-email-filter-manager__body" data-smrt-part="body">
                <span class="smrt-email-filter-manager__icon" data-smrt-part="icon" title={entry.type}>{getTypeIcon(entry.type)}</span>
                <div class="smrt-email-filter-manager__meta" data-smrt-part="meta">
                  <span class="smrt-email-filter-manager__pattern" data-smrt-part="value">{entry.pattern}</span>
                  {#if entry.reason}
                    <span class="smrt-email-filter-manager__entry-description" data-smrt-part="description">{entry.reason}</span>
                  {/if}
                </div>
                {#if entry.autoArchive}
                  <span class="smrt-email-filter-manager__auto-archive-tag" data-smrt-part="meta">auto-archive</span>
                {/if}
              </div>
              {#if !isReadonly && onremoveblacklist}
                <Button
                  variant="ghost"
                  size="sm"
                  class="delete-btn"
                  onclick={() => removeBlacklistEntry(entry)}
                  title={t(M['messages.email_filter_manager.blacklist_remove'])}
                >&times;</Button>
              {/if}
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-email-filter-manager__root {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .smrt-email-filter-manager__toggle {
    display: flex;
    gap: 0.25rem;
    padding: 0.25rem;
  }
  /*
  * The whitelist/blacklist toggle now renders through smrt-ui's <Button>,
  * driven by `variant={active ? 'primary' : 'ghost'}` (a plain class:active view
  * toggle, not an ARIA tablist). The variants own background/color/hover;
  * `.smrt-email-filter-manager__toggle :global(.section-btn)` only re-asserts the row layout
  * (flex/gap/radius) inside the pierced Button child scope (issue #1589).
  */
  .smrt-email-filter-manager__toggle :global(.section-btn) {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }
  .smrt-email-filter-manager__count {
    padding: 0.0625rem 0.375rem;
  }
  .smrt-email-filter-manager__content {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .smrt-email-filter-manager__header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  /*
  * The add button now renders through smrt-ui's <Button variant="secondary">.
  * The variant owns the outlined-primary look + hover; `.smrt-email-filter-manager__header
  * :global(.add-btn)` only re-asserts radius and flex-shrink (issue #1589).
  */
  .smrt-email-filter-manager__header :global(.add-btn) {
    flex-shrink: 0;
  }
  .smrt-email-filter-manager__form {
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .smrt-email-filter-manager__row {
    display: flex;
    gap: 0.75rem;
    align-items: flex-end;
  }
  .smrt-email-filter-manager__field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  /*
  * The form fields now render through smrt-ui's <Input> / <Select>, which bring
  * their own tokenised border / background / focus / placeholder styling and
  * honor prefers-reduced-motion themselves. The old `.form-input` / `.form-select`
  * rules (and their :focus / ::placeholder overrides) are dropped as dead — they
  * targeted the raw elements that now live inside the primitive child scopes
  * (issue #1589).
  */
  .smrt-email-filter-manager__checkbox-field {
    justify-content: flex-end;
    padding-bottom: 0.5rem;
  }
  .smrt-email-filter-manager__checkbox-label {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    cursor: pointer;
    white-space: nowrap;
  }
  .smrt-email-filter-manager__actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    padding-top: 0.25rem;
  }
  .smrt-email-filter-manager__list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }
  .smrt-email-filter-manager__entry {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 0.75rem 1rem;
  }
  .smrt-email-filter-manager__body {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex: 1;
    min-width: 0;
  }
  .smrt-email-filter-manager__icon {
    padding: 0.25rem 0.5rem;
    flex-shrink: 0;
    min-width: 2rem;
  }
  .smrt-email-filter-manager__meta {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    flex: 1;
    min-width: 0;
  }
  .smrt-email-filter-manager__pattern {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .smrt-email-filter-manager__category-tag {
    padding: 0.125rem 0.5rem;
    flex-shrink: 0;
  }
  .smrt-email-filter-manager__auto-archive-tag {
    padding: 0.125rem 0.5rem;
    flex-shrink: 0;
  }
  /*
  * The remove button now renders through smrt-ui's <Button variant="ghost">.
  * `.smrt-email-filter-manager__entry :global(.delete-btn)` anchors on the real `.smrt-email-filter-manager__entry` element
  * and pierces the Button child scope to keep the round icon button and its
  * red-on-hover affordance (issue #1589).
  */
  .smrt-email-filter-manager__entry :global(.delete-btn) {
    padding: 0.125rem 0.5rem;
    flex-shrink: 0;
  }
  .smrt-email-filter-manager__empty {
    padding: 2rem;
  }
  .smrt-email-filter-manager__error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
  }
  /*
  * The dismiss button now renders through smrt-ui's <Button variant="ghost">.
  * `.smrt-email-filter-manager__error :global(.dismiss-btn)` anchors on the real `.smrt-email-filter-manager__error`
  * element and pierces the Button child scope. `color: inherit` keeps the icon
  * matching the error banner color (issue #1589).
  */
  .smrt-email-filter-manager__error :global(.dismiss-btn) {
    padding: 0 0.25rem;
  }
}

@layer smrt.theme {
  .smrt-email-filter-manager__toggle {
    background: var(--smrt-color-surface-container);
    border-radius: var(--smrt-radius-md);
  }
  /*
  * The whitelist/blacklist toggle now renders through smrt-ui's <Button>,
  * driven by `variant={active ? 'primary' : 'ghost'}` (a plain class:active view
  * toggle, not an ARIA tablist). The variants own background/color/hover;
  * `.smrt-email-filter-manager__toggle :global(.section-btn)` only re-asserts the row layout
  * (flex/gap/radius) inside the pierced Button child scope (issue #1589).
  */
  .smrt-email-filter-manager__toggle :global(.section-btn) {
    border-radius: var(--smrt-radius-md);
    font-size: var(--smrt-typography-label-large-size, 0.8125rem);
  }
  .smrt-email-filter-manager__count {
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    background: var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-full);
  }
  .smrt-email-filter-manager__description {
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
    color: var(--smrt-color-on-surface-variant);
  }
  /*
  * The add button now renders through smrt-ui's <Button variant="secondary">.
  * The variant owns the outlined-primary look + hover; `.smrt-email-filter-manager__header
  * :global(.add-btn)` only re-asserts radius and flex-shrink (issue #1589).
  */
  .smrt-email-filter-manager__header :global(.add-btn) {
    border-radius: var(--smrt-radius-md);
  }
  .smrt-email-filter-manager__form {
    background: var(--smrt-color-surface-container);
    border: 1px solid var(--smrt-color-primary);
    border-radius: var(--smrt-radius-md);
  }
  .smrt-email-filter-manager__form-title {
    font-size: var(--smrt-typography-title-small-size, 0.875rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    color: var(--smrt-color-primary);
  }
  .smrt-email-filter-manager__label {
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    font-weight: var(--smrt-typography-weight-medium, 500);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-email-filter-manager__optional {
    font-weight: var(--smrt-typography-weight-normal, 400);
    opacity: 0.7;
  }
  .smrt-email-filter-manager__checkbox-label {
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
    color: var(--smrt-color-on-surface);
  }
  .smrt-email-filter-manager__checkbox-label input[type="checkbox"] {
    accent-color: var(--smrt-color-primary);
  }
  /*
  * Cancel/Save now use Button's secondary/primary variants (dead bespoke CSS
  * removed). `.smrt-email-filter-manager__actions :global(...)` only re-asserts the rounded radius;
  * Cancel's neutral outline override keeps it from picking up secondary's
  * primary border color (issue #1589).
  */
  .smrt-email-filter-manager__actions :global(.cancel-btn),
  .smrt-email-filter-manager__actions :global(.save-btn) {
    border-radius: var(--smrt-radius-md);
  }
  .smrt-email-filter-manager__actions :global(.cancel-btn) {
    border-color: var(--smrt-hairline-color);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-email-filter-manager__entry {
    background: var(--smrt-color-surface-container);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-md);
    transition: background 150ms ease, border-color 150ms ease;
  }
  .smrt-email-filter-manager__entry:hover {
    background: var(--smrt-color-surface-container-high);
  }
  .smrt-email-filter-manager__entry.smrt-email-filter-manager__allow:hover {
    border-color: var(--smrt-color-success);
  }
  .smrt-email-filter-manager__entry.smrt-email-filter-manager__block:hover {
    border-color: var(--smrt-color-error);
  }
  .smrt-email-filter-manager__icon {
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
    font-family: var(--smrt-font-family-mono, monospace);
    background: var(--smrt-color-surface);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-sm);
    text-align: center;
  }
  .smrt-email-filter-manager__pattern {
    font-weight: var(--smrt-typography-weight-medium, 500);
    font-size: var(--smrt-typography-title-small-size, 0.875rem);
  }
  .smrt-email-filter-manager__entry-description {
    font-size: var(--smrt-typography-body-small-size, 0.75rem);
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-email-filter-manager__category-tag {
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    color: var(--smrt-color-tertiary);
    background: var(--smrt-color-tertiary-container);
    border-radius: var(--smrt-radius-full);
  }
  .smrt-email-filter-manager__auto-archive-tag {
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    color: var(--smrt-color-warning);
    background: var(--smrt-color-warning-container);
    border-radius: var(--smrt-radius-full);
  }
  /*
  * The remove button now renders through smrt-ui's <Button variant="ghost">.
  * `.smrt-email-filter-manager__entry :global(.delete-btn)` anchors on the real `.smrt-email-filter-manager__entry` element
  * and pierces the Button child scope to keep the round icon button and its
  * red-on-hover affordance (issue #1589).
  */
  .smrt-email-filter-manager__entry :global(.delete-btn) {
    font-size: var(--smrt-typography-body-large-size, 1rem);
    line-height: 1;
    border-radius: var(--smrt-radius-full);
    border: 1px solid transparent;
    background: transparent;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-email-filter-manager__entry :global(.delete-btn):hover {
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-error);
    border-color: var(--smrt-color-error);
  }
  .smrt-email-filter-manager__empty {
    text-align: center;
    color: var(--smrt-color-on-surface-variant);
    background: var(--smrt-color-surface-container);
    border-radius: var(--smrt-radius-md);
  }
  .smrt-email-filter-manager__error {
    border-radius: var(--smrt-radius-md);
    background: var(--smrt-color-error-container);
    color: var(--smrt-color-error);
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
  }
  /*
  * The dismiss button now renders through smrt-ui's <Button variant="ghost">.
  * `.smrt-email-filter-manager__error :global(.dismiss-btn)` anchors on the real `.smrt-email-filter-manager__error`
  * element and pierces the Button child scope. `color: inherit` keeps the icon
  * matching the error banner color (issue #1589).
  */
  .smrt-email-filter-manager__error :global(.dismiss-btn) {
    background: transparent;
    border: none;
    font-size: var(--smrt-typography-body-large-size, 1rem);
    color: inherit;
  }
}

</style>
