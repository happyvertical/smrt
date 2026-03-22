<script lang="ts">
/**
 * EmailFilterManager - Combined whitelist/blacklist management
 *
 * Reusable component for managing email allow/block lists.
 * Works with any backend via callback props.
 */
import type { BlacklistEntry, WhitelistEntry } from '../types.js';

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
    await onaddwhitelist({
      pattern: wlPattern.trim(),
      type: wlType,
      category: wlCategory.trim() || null,
      description: wlDescription.trim(),
    });
    resetWhitelistForm();
  } catch (e) {
    console.error('Failed to add whitelist entry:', e);
  } finally {
    savingWhitelist = false;
  }
}

async function removeWhitelistEntry(entry: WhitelistEntry) {
  if (isReadonly || !onremovewhitelist) return;
  try {
    await onremovewhitelist(entry);
  } catch (e) {
    console.error('Failed to remove whitelist entry:', e);
  }
}

async function saveBlacklistEntry() {
  if (!blPattern.trim() || !onaddblacklist) return;
  try {
    savingBlacklist = true;
    await onaddblacklist({
      pattern: blPattern.trim(),
      type: blType,
      reason: blReason.trim(),
      autoArchive: blAutoArchive,
    });
    resetBlacklistForm();
  } catch (e) {
    console.error('Failed to add blacklist entry:', e);
  } finally {
    savingBlacklist = false;
  }
}

async function removeBlacklistEntry(entry: BlacklistEntry) {
  if (isReadonly || !onremoveblacklist) return;
  try {
    await onremoveblacklist(entry);
  } catch (e) {
    console.error('Failed to remove blacklist entry:', e);
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
    <button
      class="section-btn"
      class:active={activeSection === 'whitelist'}
      onclick={() => activeSection = 'whitelist'}
    >
      Whitelist
      <span class="count">{whitelist.length}</span>
    </button>
    <button
      class="section-btn"
      class:active={activeSection === 'blacklist'}
      onclick={() => activeSection = 'blacklist'}
    >
      Blacklist
      <span class="count">{blacklist.length}</span>
    </button>
  </div>

  <!-- Whitelist Section -->
  {#if activeSection === 'whitelist'}
    <div class="section-content">
      <div class="section-header-row">
        <div class="section-description">
          Whitelisted senders bypass blacklist checks and are always allowed through.
        </div>
        {#if !isReadonly && onaddwhitelist}
          <button
            class="add-btn"
            onclick={() => { resetWhitelistForm(); showWhitelistForm = true; }}
          >+ Add</button>
        {/if}
      </div>

      {#if showWhitelistForm}
        <div class="entry-form">
          <div class="form-title">Add Whitelist Entry</div>
          <div class="form-row">
            <div class="form-field" style="flex: 0 0 120px;">
              <label class="form-label" for="wl-type">Type</label>
              <select id="wl-type" class="form-select" bind:value={wlType}>
                <option value="email">Email</option>
                <option value="domain">Domain</option>
                <option value="regex">Regex</option>
              </select>
            </div>
            <div class="form-field" style="flex: 1;">
              <label class="form-label" for="wl-pattern">Pattern</label>
              <input
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
              <input
                id="wl-category"
                class="form-input"
                type="text"
                bind:value={wlCategory}
                placeholder="e.g. support, sales"
              />
            </div>
            <div class="form-field" style="flex: 2;">
              <label class="form-label" for="wl-desc">Description</label>
              <input
                id="wl-desc"
                class="form-input"
                type="text"
                bind:value={wlDescription}
                placeholder="Why is this entry whitelisted?"
              />
            </div>
          </div>
          <div class="form-actions">
            <button class="cancel-btn" onclick={resetWhitelistForm} disabled={savingWhitelist}>Cancel</button>
            <button class="save-btn" onclick={saveWhitelistEntry} disabled={savingWhitelist || !wlPattern.trim()}>
              {savingWhitelist ? 'Saving...' : 'Add'}
            </button>
          </div>
        </div>
      {/if}

      {#if whitelist.length === 0 && !showWhitelistForm}
        <p class="placeholder">No whitelist entries yet.</p>
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
                <button
                  class="delete-btn"
                  onclick={() => removeWhitelistEntry(entry)}
                  title="Remove"
                >&times;</button>
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
          Blacklisted senders are automatically blocked or archived.
        </div>
        {#if !isReadonly && onaddblacklist}
          <button
            class="add-btn"
            onclick={() => { resetBlacklistForm(); showBlacklistForm = true; }}
          >+ Add</button>
        {/if}
      </div>

      {#if showBlacklistForm}
        <div class="entry-form">
          <div class="form-title">Add Blacklist Entry</div>
          <div class="form-row">
            <div class="form-field" style="flex: 0 0 120px;">
              <label class="form-label" for="bl-type">Type</label>
              <select id="bl-type" class="form-select" bind:value={blType}>
                <option value="email">Email</option>
                <option value="domain">Domain</option>
                <option value="regex">Regex</option>
              </select>
            </div>
            <div class="form-field" style="flex: 1;">
              <label class="form-label" for="bl-pattern">Pattern</label>
              <input
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
              <input
                id="bl-reason"
                class="form-input"
                type="text"
                bind:value={blReason}
                placeholder="Why is this entry blocked?"
              />
            </div>
            <div class="form-field checkbox-field">
              <label class="form-label checkbox-label">
                <input type="checkbox" bind:checked={blAutoArchive} />
                Auto-archive
              </label>
            </div>
          </div>
          <div class="form-actions">
            <button class="cancel-btn" onclick={resetBlacklistForm} disabled={savingBlacklist}>Cancel</button>
            <button class="save-btn" onclick={saveBlacklistEntry} disabled={savingBlacklist || !blPattern.trim()}>
              {savingBlacklist ? 'Saving...' : 'Add'}
            </button>
          </div>
        </div>
      {/if}

      {#if blacklist.length === 0 && !showBlacklistForm}
        <p class="placeholder">No blacklist entries yet.</p>
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
                <button
                  class="delete-btn"
                  onclick={() => removeBlacklistEntry(entry)}
                  title="Remove"
                >&times;</button>
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
    border-radius: 8px;
  }

  .section-btn {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.375rem 0.75rem;
    border: none;
    border-radius: 6px;
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #43474e);
    font-size: 0.8125rem;
    font-family: inherit;
    cursor: pointer;
    transition: all 150ms ease;
  }

  .section-btn.active {
    background: var(--smrt-color-primary-container, #d8e2ff);
    color: var(--smrt-color-primary, #005ac1);
  }

  .section-btn:hover:not(.active) {
    background: var(--smrt-color-surface-container-high, #e6e7ef);
  }

  .count {
    font-size: 0.6875rem;
    background: var(--smrt-color-outline-variant, #c2c7cf);
    padding: 0.0625rem 0.375rem;
    border-radius: 9999px;
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
    font-size: 0.8125rem;
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .add-btn {
    padding: 0.375rem 0.75rem;
    border-radius: 6px;
    border: 1px solid var(--smrt-color-primary, #005ac1);
    background: transparent;
    color: var(--smrt-color-primary, #005ac1);
    cursor: pointer;
    font-size: 0.8125rem;
    font-family: inherit;
    font-weight: 500;
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
    border-radius: 8px;
    padding: 1rem;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .form-title {
    font-size: 0.875rem;
    font-weight: 600;
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
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .optional {
    font-weight: 400;
    opacity: 0.7;
  }

  .form-input,
  .form-select {
    padding: 0.5rem 0.625rem;
    border-radius: 6px;
    border: 1px solid var(--smrt-color-outline-variant, #c2c7cf);
    background: var(--smrt-color-surface, #fefbff);
    color: var(--smrt-color-on-surface, #1a1c1e);
    font-size: 0.8125rem;
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
    font-size: 0.8125rem;
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
    border-radius: 6px;
    border: 1px solid var(--smrt-color-outline-variant, #c2c7cf);
    background: transparent;
    color: var(--smrt-color-on-surface-variant, #43474e);
    cursor: pointer;
    font-size: 0.8125rem;
    font-family: inherit;
    transition: all 150ms ease;
  }

  .cancel-btn:hover {
    background: var(--smrt-color-surface-container-high, #e6e7ef);
  }

  .save-btn {
    padding: 0.375rem 0.75rem;
    border-radius: 6px;
    border: 1px solid var(--smrt-color-primary, #005ac1);
    background: var(--smrt-color-primary, #005ac1);
    color: var(--smrt-color-on-primary, #fff);
    cursor: pointer;
    font-size: 0.8125rem;
    font-family: inherit;
    font-weight: 500;
    transition: all 150ms ease;
  }

  .save-btn:hover:not(:disabled) {
    opacity: 0.9;
  }

  .save-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
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
    border-radius: 8px;
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
    font-size: 0.6875rem;
    font-weight: 600;
    font-family: monospace;
    background: var(--smrt-color-surface, #fefbff);
    border: 1px solid var(--smrt-color-outline-variant, #c2c7cf);
    padding: 0.25rem 0.5rem;
    border-radius: 4px;
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
    font-weight: 500;
    font-size: 0.875rem;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .entry-description {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .category-tag {
    font-size: 0.6875rem;
    color: var(--smrt-color-tertiary, #6b5778);
    background: var(--smrt-color-tertiary-container, #f2daff);
    padding: 0.125rem 0.5rem;
    border-radius: 9999px;
    flex-shrink: 0;
  }

  .auto-archive-tag {
    font-size: 0.6875rem;
    color: var(--smrt-color-warning, #ca8a04);
    background: var(--smrt-color-warning-container, #fef9c3);
    padding: 0.125rem 0.5rem;
    border-radius: 9999px;
    flex-shrink: 0;
  }

  .delete-btn {
    font-size: 1rem;
    line-height: 1;
    padding: 0.125rem 0.5rem;
    border-radius: 9999px;
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
    border-radius: 8px;
  }
</style>
