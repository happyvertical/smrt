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
  whitelist: WhitelistEntry[];
  blacklist: BlacklistEntry[];
  readonly?: boolean;
  onaddwhitelist?: (data: Omit<WhitelistEntry, 'id'>) => Promise<void>;
  onremovewhitelist?: (entry: WhitelistEntry) => Promise<void>;
  onaddblacklist?: (data: Omit<BlacklistEntry, 'id'>) => Promise<void>;
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

<div class="email-filter-manager">
  <div class="section-toggle">
    <Button
      variant={activeSection === 'whitelist' ? 'primary' : 'ghost'}
      size="sm"
      class="section-btn"
      onclick={() => activeSection = 'whitelist'}
    >
      Whitelist
      <span class="count">{whitelist.length}</span>
    </Button>
    <Button
      variant={activeSection === 'blacklist' ? 'primary' : 'ghost'}
      size="sm"
      class="section-btn"
      onclick={() => activeSection = 'blacklist'}
    >
      Blacklist
      <span class="count">{blacklist.length}</span>
    </Button>
  </div>

  {#if filterError}
    <div class="filter-error" role="alert" aria-live="assertive">
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
    <div class="section-content">
      <div class="section-header-row">
        <div class="section-description">
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
        <div class="entry-form">
          <div class="form-title">{t(M['messages.email_filter_manager.add_whitelist_entry'])}</div>
          <div class="form-row">
            <div class="form-field" style="flex: 0 0 120px;">
              <label class="form-label" for="wl-type">Type</label>
              <Select id="wl-type" class="form-select" bind:value={wlType}>
                <option value="email">Email</option>
                <option value="domain">Domain</option>
                <option value="regex">Regex</option>
              </Select>
            </div>
            <div class="form-field" style="flex: 1;">
              <label class="form-label" for="wl-pattern">Pattern</label>
              <Input
                id="wl-pattern"
                class="form-input"
                type="text"
                bind:value={wlPattern}
                placeholder={getPatternPlaceholder(wlType)}
              />
            </div>
          </div>
          <div class="form-row">
            <div class="form-field" style="flex: 1;">
              <label class="form-label" for="wl-category">Category <span class="optional">(optional)</span></label>
              <Input
                id="wl-category"
                class="form-input"
                type="text"
                bind:value={wlCategory}
                placeholder={t(M['messages.email_filter_manager.category_placeholder'])}
              />
            </div>
            <div class="form-field" style="flex: 2;">
              <label class="form-label" for="wl-desc">Description</label>
              <Input
                id="wl-desc"
                class="form-input"
                type="text"
                bind:value={wlDescription}
                placeholder={t(M['messages.email_filter_manager.whitelist_description_placeholder'])}
              />
            </div>
          </div>
          <div class="form-actions">
            <Button variant="secondary" size="sm" class="cancel-btn" onclick={resetWhitelistForm} disabled={savingWhitelist}>Cancel</Button>
            <Button variant="primary" size="sm" class="save-btn" onclick={saveWhitelistEntry} disabled={savingWhitelist || !wlPattern.trim()}>
              {savingWhitelist ? 'Saving...' : 'Add'}
            </Button>
          </div>
        </div>
      {/if}

      {#if whitelist.length === 0 && !showWhitelistForm}
        <p class="placeholder">{t(M['messages.email_filter_manager.no_whitelist_entries'])}</p>
      {:else}
        <div class="entries-list">
          {#each whitelist as entry}
            <div class="entry-card allow">
              <div class="entry-main">
                <span class="type-badge" title={entry.type}>{getTypeIcon(entry.type)}</span>
                <div class="entry-info">
                  <span class="entry-pattern">{entry.pattern}</span>
                  {#if entry.description}
                    <span class="entry-description">{entry.description}</span>
                  {/if}
                </div>
                {#if entry.category}
                  <span class="category-tag">{entry.category}</span>
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
    <div class="section-content">
      <div class="section-header-row">
        <div class="section-description">
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
        <div class="entry-form">
          <div class="form-title">{t(M['messages.email_filter_manager.add_blacklist_entry'])}</div>
          <div class="form-row">
            <div class="form-field" style="flex: 0 0 120px;">
              <label class="form-label" for="bl-type">Type</label>
              <Select id="bl-type" class="form-select" bind:value={blType}>
                <option value="email">Email</option>
                <option value="domain">Domain</option>
                <option value="regex">Regex</option>
              </Select>
            </div>
            <div class="form-field" style="flex: 1;">
              <label class="form-label" for="bl-pattern">Pattern</label>
              <Input
                id="bl-pattern"
                class="form-input"
                type="text"
                bind:value={blPattern}
                placeholder={getPatternPlaceholder(blType)}
              />
            </div>
          </div>
          <div class="form-row">
            <div class="form-field" style="flex: 1;">
              <label class="form-label" for="bl-reason">Reason</label>
              <Input
                id="bl-reason"
                class="form-input"
                type="text"
                bind:value={blReason}
                placeholder={t(M['messages.email_filter_manager.reason_placeholder'])}
              />
            </div>
            <div class="form-field checkbox-field">
              <label class="form-label checkbox-label">
                <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
                <input type="checkbox" bind:checked={blAutoArchive} />
                Auto-archive
              </label>
            </div>
          </div>
          <div class="form-actions">
            <Button variant="secondary" size="sm" class="cancel-btn" onclick={resetBlacklistForm} disabled={savingBlacklist}>Cancel</Button>
            <Button variant="primary" size="sm" class="save-btn" onclick={saveBlacklistEntry} disabled={savingBlacklist || !blPattern.trim()}>
              {savingBlacklist ? 'Saving...' : 'Add'}
            </Button>
          </div>
        </div>
      {/if}

      {#if blacklist.length === 0 && !showBlacklistForm}
        <p class="placeholder">{t(M['messages.email_filter_manager.no_blacklist_entries'])}</p>
      {:else}
        <div class="entries-list">
          {#each blacklist as entry}
            <div class="entry-card block">
              <div class="entry-main">
                <span class="type-badge" title={entry.type}>{getTypeIcon(entry.type)}</span>
                <div class="entry-info">
                  <span class="entry-pattern">{entry.pattern}</span>
                  {#if entry.reason}
                    <span class="entry-description">{entry.reason}</span>
                  {/if}
                </div>
                {#if entry.autoArchive}
                  <span class="auto-archive-tag">auto-archive</span>
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
  .email-filter-manager {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .section-toggle {
    display: flex;
    gap: 0.25rem;
    background: var(--smrt-color-surface-container, #f0f1f9);
    padding: 0.25rem;
    border-radius: var(--smrt-radius-md, 8px);
  }

  /*
   * The whitelist/blacklist toggle now renders through smrt-ui's <Button>,
   * driven by `variant={active ? 'primary' : 'ghost'}` (a plain class:active view
   * toggle, not an ARIA tablist). The variants own background/color/hover;
   * `.section-toggle :global(.section-btn)` only re-asserts the row layout
   * (flex/gap/radius) inside the pierced Button child scope (issue #1589).
   */
  .section-toggle :global(.section-btn) {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    border-radius: var(--smrt-radius-md, 8px);
    font-size: var(--smrt-typography-label-large-size, 0.8125rem);
  }

  .count {
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    background: var(--smrt-color-outline-variant, #c2c7cf);
    padding: 0.0625rem 0.375rem;
    border-radius: var(--smrt-radius-full, 9999px);
  }

  .section-content {
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

  /*
   * The add button now renders through smrt-ui's <Button variant="secondary">.
   * The variant owns the outlined-primary look + hover; `.section-header-row
   * :global(.add-btn)` only re-asserts radius and flex-shrink (issue #1589).
   */
  .section-header-row :global(.add-btn) {
    border-radius: var(--smrt-radius-md, 8px);
    flex-shrink: 0;
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

  .optional {
    font-weight: var(--smrt-typography-weight-normal, 400);
    opacity: 0.7;
  }

  /*
   * The form fields now render through smrt-ui's <Input> / <Select>, which bring
   * their own tokenised border / background / focus / placeholder styling and
   * honor prefers-reduced-motion themselves. The old `.form-input` / `.form-select`
   * rules (and their :focus / ::placeholder overrides) are dropped as dead — they
   * targeted the raw elements that now live inside the primitive child scopes
   * (issue #1589).
   */
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

  /*
   * Cancel/Save now use Button's secondary/primary variants (dead bespoke CSS
   * removed). `.form-actions :global(...)` only re-asserts the rounded radius;
   * Cancel's neutral outline override keeps it from picking up secondary's
   * primary border color (issue #1589).
   */
  .form-actions :global(.cancel-btn),
  .form-actions :global(.save-btn) {
    border-radius: var(--smrt-radius-md, 8px);
  }

  .form-actions :global(.cancel-btn) {
    border-color: var(--smrt-color-outline-variant, #c2c7cf);
    color: var(--smrt-color-on-surface-variant, #43474e);
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
    transition: background 150ms ease, border-color 150ms ease;
  }

  .entry-card:hover {
    background: var(--smrt-color-surface-container-high, #e6e7ef);
  }

  .entry-card.allow:hover {
    border-color: var(--smrt-color-success, #16a34a);
  }

  .entry-card.block:hover {
    border-color: var(--smrt-color-error, #ba1a1a);
  }

  .entry-main {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex: 1;
    min-width: 0;
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

  .category-tag {
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    color: var(--smrt-color-tertiary, #6b5778);
    background: var(--smrt-color-tertiary-container, #f2daff);
    padding: 0.125rem 0.5rem;
    border-radius: var(--smrt-radius-full, 9999px);
    flex-shrink: 0;
  }

  .auto-archive-tag {
    font-size: var(--smrt-typography-label-small-size, 0.6875rem);
    color: var(--smrt-color-warning, #ca8a04);
    background: var(--smrt-color-warning-container, #fef9c3);
    padding: 0.125rem 0.5rem;
    border-radius: var(--smrt-radius-full, 9999px);
    flex-shrink: 0;
  }

  /*
   * The remove button now renders through smrt-ui's <Button variant="ghost">.
   * `.entry-card :global(.delete-btn)` anchors on the real `.entry-card` element
   * and pierces the Button child scope to keep the round icon button and its
   * red-on-hover affordance (issue #1589).
   */
  .entry-card :global(.delete-btn) {
    font-size: var(--smrt-typography-body-large-size, 1rem);
    line-height: 1;
    padding: 0.125rem 0.5rem;
    border-radius: var(--smrt-radius-full, 9999px);
    border: 1px solid transparent;
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #43474e);
    flex-shrink: 0;
  }

  .entry-card :global(.delete-btn):hover {
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

  .filter-error {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
    padding: 0.5rem 0.75rem;
    border-radius: var(--smrt-radius-md, 8px);
    background: var(--smrt-color-error-container, #fce4ec);
    color: var(--smrt-color-error, #ba1a1a);
    font-size: var(--smrt-typography-body-medium-size, 0.8125rem);
  }

  /*
   * The dismiss button now renders through smrt-ui's <Button variant="ghost">.
   * `.filter-error :global(.dismiss-btn)` anchors on the real `.filter-error`
   * element and pierces the Button child scope. `color: inherit` keeps the icon
   * matching the error banner color (issue #1589).
   */
  .filter-error :global(.dismiss-btn) {
    background: transparent;
    border: none;
    font-size: var(--smrt-typography-body-large-size, 1rem);
    color: inherit;
    padding: 0 0.25rem;
  }
</style>
