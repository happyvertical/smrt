<script lang="ts">
/**
 * BlacklistManager - Manage blacklist entries for email routing
 *
 * Features:
 * - List all blacklist entries
 * - Add new blacklist patterns
 * - Delete blacklist entries
 * - Pattern type selection (email, domain, regex)
 * - Reason tracking
 * - Auto-archive configuration
 * - Pattern validation
 */

interface BlacklistEntry {
  id: string;
  pattern: string;
  type: 'email' | 'domain' | 'regex';
  reason: string;
  autoArchive: boolean;
  createdAt: Date;
}

interface Props {
  entries: BlacklistEntry[];
  onAdd?: (entry: Omit<BlacklistEntry, 'id' | 'createdAt'>) => void;
  onDelete?: (entryId: string) => void;
  onToggleAutoArchive?: (entryId: string, autoArchive: boolean) => void;
}

let { entries = [], onAdd, onDelete, onToggleAutoArchive }: Props = $props();

// Form state
let showForm = $state(false);
let formData = $state({
  pattern: '',
  type: 'email' as 'email' | 'domain' | 'regex',
  reason: '',
  autoArchive: true,
});

// Validation errors
let errors = $state<Record<string, string>>({});

// Filters
let filters = $state({
  type: '',
  search: '',
});

// Filtered entries
let filteredEntries = $derived(
  entries.filter((entry) => {
    if (filters.type && entry.type !== filters.type) return false;
    if (filters.search) {
      const search = filters.search.toLowerCase();
      return (
        entry.pattern.toLowerCase().includes(search) ||
        entry.reason.toLowerCase().includes(search)
      );
    }
    return true;
  }),
);

function validateForm(): boolean {
  const newErrors: Record<string, string> = {};

  if (!formData.pattern.trim()) {
    newErrors.pattern = 'Pattern is required';
  } else {
    // Validate pattern based on type
    if (formData.type === 'email') {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(formData.pattern)) {
        newErrors.pattern = 'Invalid email format';
      }
    } else if (formData.type === 'domain') {
      const domainRegex =
        /^[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?(\.[a-zA-Z0-9]([a-zA-Z0-9-]*[a-zA-Z0-9])?)*$/;
      if (!domainRegex.test(formData.pattern)) {
        newErrors.pattern = 'Invalid domain format';
      }
    } else if (formData.type === 'regex') {
      try {
        new RegExp(formData.pattern);
      } catch (e) {
        newErrors.pattern = `Invalid regex: ${e.message}`;
      }
    }
  }

  if (!formData.reason.trim()) {
    newErrors.reason = 'Reason is required';
  }

  errors = newErrors;
  return Object.keys(newErrors).length === 0;
}

function handleSubmit() {
  if (validateForm()) {
    onAdd?.({
      pattern: formData.pattern,
      type: formData.type,
      reason: formData.reason,
      autoArchive: formData.autoArchive,
    });

    // Reset form
    formData = {
      pattern: '',
      type: 'email',
      reason: '',
      autoArchive: true,
    };
    showForm = false;
    errors = {};
  }
}

function handleDelete(entryId: string, pattern: string) {
  if (confirm(`Remove blacklist entry for "${pattern}"?`)) {
    onDelete?.(entryId);
  }
}

function handleToggleAutoArchive(entryId: string, currentValue: boolean) {
  onToggleAutoArchive?.(entryId, !currentValue);
}

function handleCancel() {
  showForm = false;
  formData = {
    pattern: '',
    type: 'email',
    reason: '',
    autoArchive: true,
  };
  errors = {};
}

function clearFilters() {
  filters = { type: '', search: '' };
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleString();
}
</script>

<div class="blacklist-manager">
  <div class="manager-header">
    <div class="header-content">
      <h2>Blacklist Management</h2>
      <p class="header-description">Block unwanted senders and patterns</p>
    </div>
    <button class="btn-primary" onclick={() => (showForm = !showForm)}>
      {showForm ? 'Cancel' : '+ Add Entry'}
    </button>
  </div>

  {#if showForm}
    <div class="add-form">
      <h3>Add Blacklist Entry</h3>
      <form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
        <div class="form-row">
          <div class="form-group">
            <label for="pattern">Pattern *</label>
            <input
              id="pattern"
              type="text"
              bind:value={formData.pattern}
              class:error={errors.pattern}
              placeholder={formData.type === 'email' ? 'spam@example.com' : formData.type === 'domain' ? 'spam-domain.com' : '.*spam.*'}
            />
            {#if errors.pattern}
              <span class="error-message">{errors.pattern}</span>
            {/if}
          </div>

          <div class="form-group">
            <label for="type">Type *</label>
            <select id="type" bind:value={formData.type}>
              <option value="email">Email Address</option>
              <option value="domain">Domain</option>
              <option value="regex">Regex Pattern</option>
            </select>
          </div>
        </div>

        <div class="form-group">
          <label for="reason">Reason *</label>
          <input
            id="reason"
            type="text"
            bind:value={formData.reason}
            class:error={errors.reason}
            placeholder="e.g., Known spammer, Phishing attempts, etc."
          />
          {#if errors.reason}
            <span class="error-message">{errors.reason}</span>
          {/if}
        </div>

        <div class="form-group">
          <label for="auto-archive">
            <input id="auto-archive" type="checkbox" bind:checked={formData.autoArchive} />
            Automatically archive matching emails
          </label>
          <span class="field-hint">
            When enabled, emails matching this pattern will be auto-archived without processing
          </span>
        </div>

        <div class="form-actions">
          <button type="button" class="btn-secondary" onclick={handleCancel}>Cancel</button>
          <button type="submit" class="btn-danger">Add to Blacklist</button>
        </div>
      </form>
    </div>
  {/if}

  <!-- Filters -->
  <div class="filters">
    <input
      type="text"
      bind:value={filters.search}
      placeholder="Search patterns or reasons..."
      class="search-input"
    />

    <select bind:value={filters.type}>
      <option value="">All Types</option>
      <option value="email">Email</option>
      <option value="domain">Domain</option>
      <option value="regex">Regex</option>
    </select>

    <button class="btn-secondary" onclick={clearFilters}>Clear</button>
  </div>

  <!-- Entries List -->
  <div class="entries-container">
    {#if filteredEntries.length === 0}
      <div class="empty-state">
        <p>No blacklist entries found.</p>
        <p class="empty-hint">Add patterns to block unwanted senders.</p>
      </div>
    {:else}
      <div class="entries-list">
        {#each filteredEntries as entry (entry.id)}
          <div class="entry-card">
            <div class="entry-header">
              <div class="entry-info">
                <span class="entry-pattern">🚫 {entry.pattern}</span>
                <div class="entry-badges">
                  <span class="badge badge-type">{entry.type}</span>
                  {#if entry.autoArchive}
                    <span class="badge badge-archive">Auto-Archive</span>
                  {/if}
                </div>
              </div>
              <button
                class="btn-delete"
                onclick={() => handleDelete(entry.id, entry.pattern)}
                title="Remove from blacklist"
              >
                🗑️
              </button>
            </div>

            <div class="entry-body">
              <div class="entry-reason">
                <span class="reason-label">Reason:</span>
                <span class="reason-text">{entry.reason}</span>
              </div>

              <div class="entry-actions">
                <button
                  class="btn-toggle"
                  onclick={() => handleToggleAutoArchive(entry.id, entry.autoArchive)}
                  title={entry.autoArchive ? 'Disable auto-archive' : 'Enable auto-archive'}
                >
                  {entry.autoArchive ? '📦 Auto-Archive ON' : '📭 Auto-Archive OFF'}
                </button>
              </div>
            </div>

            <div class="entry-meta">
              <span class="meta-text">Added: {formatDate(entry.createdAt)}</span>
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .blacklist-manager {
    width: 100%;
  }

  .manager-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 1.5rem;
  }

  .header-content h2 {
    margin: 0 0 0.25rem 0;
    font-size: 1.5rem;
    color: #333;
  }

  .header-description {
    margin: 0;
    font-size: 0.9rem;
    color: #666;
  }

  .add-form {
    background: white;
    border: 2px solid #e74c3c;
    border-radius: 8px;
    padding: 1.5rem;
    margin-bottom: 1.5rem;
  }

  .add-form h3 {
    margin: 0 0 1rem 0;
    font-size: 1.125rem;
    color: #e74c3c;
  }

  .form-row {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .form-group {
    display: flex;
    flex-direction: column;
  }

  label {
    margin-bottom: 0.5rem;
    font-weight: 500;
    color: #333;
    font-size: 0.9rem;
  }

  input[type='text'],
  select {
    padding: 0.5rem;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 0.9rem;
    font-family: inherit;
  }

  input[type='text']:focus,
  select:focus {
    outline: none;
    border-color: #e74c3c;
  }

  input.error {
    border-color: #c0392b;
  }

  input[type='checkbox'] {
    margin-right: 0.5rem;
  }

  .error-message {
    margin-top: 0.25rem;
    font-size: 0.85rem;
    color: #c0392b;
  }

  .field-hint {
    margin-top: 0.25rem;
    font-size: 0.8rem;
    color: #666;
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
    margin-top: 1rem;
  }

  button {
    padding: 0.5rem 1rem;
    border: none;
    border-radius: 4px;
    font-size: 0.9rem;
    font-weight: 500;
    cursor: pointer;
    transition: all 0.2s;
  }

  .btn-primary {
    background: #4a90e2;
    color: white;
  }

  .btn-primary:hover {
    background: #357abd;
  }

  .btn-danger {
    background: #e74c3c;
    color: white;
  }

  .btn-danger:hover {
    background: #c0392b;
  }

  .btn-secondary {
    background: #f5f5f5;
    color: #333;
    border: 1px solid #ddd;
  }

  .btn-secondary:hover {
    background: #e0e0e0;
  }

  .btn-delete {
    background: none;
    border: 1px solid #ddd;
    border-radius: 4px;
    padding: 0.25rem 0.5rem;
    font-size: 1rem;
  }

  .btn-delete:hover {
    background: #fee;
    border-color: #faa;
  }

  .btn-toggle {
    background: #f5f5f5;
    border: 1px solid #ddd;
    font-size: 0.85rem;
    padding: 0.375rem 0.75rem;
  }

  .btn-toggle:hover {
    background: #e0e0e0;
  }

  .filters {
    display: grid;
    grid-template-columns: 2fr 1fr auto;
    gap: 1rem;
    margin-bottom: 1.5rem;
    background: white;
    padding: 1rem;
    border-radius: 8px;
    border: 1px solid #e0e0e0;
  }

  .search-input {
    padding: 0.5rem;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 0.9rem;
  }

  .empty-state {
    padding: 3rem;
    text-align: center;
    color: #666;
    background: #f5f5f5;
    border-radius: 8px;
  }

  .empty-state p {
    margin: 0.5rem 0;
  }

  .empty-hint {
    font-size: 0.9rem;
    color: #999;
  }

  .entries-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .entry-card {
    background: white;
    border: 1px solid #e0e0e0;
    border-left: 4px solid #e74c3c;
    border-radius: 8px;
    padding: 1rem;
    transition: all 0.2s;
  }

  .entry-card:hover {
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }

  .entry-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 0.75rem;
  }

  .entry-info {
    flex: 1;
  }

  .entry-pattern {
    display: block;
    font-size: 1rem;
    font-weight: 600;
    color: #c0392b;
    margin-bottom: 0.5rem;
    font-family: monospace;
  }

  .entry-badges {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .badge {
    padding: 0.25rem 0.75rem;
    border-radius: 12px;
    font-size: 0.75rem;
    font-weight: 500;
  }

  .badge-type {
    background: #ffebee;
    color: #c62828;
  }

  .badge-archive {
    background: #e8f5e9;
    color: #2e7d32;
  }

  .entry-body {
    margin-bottom: 0.75rem;
  }

  .entry-reason {
    padding: 0.75rem;
    background: #fff9f9;
    border-radius: 4px;
    margin-bottom: 0.75rem;
  }

  .reason-label {
    font-weight: 600;
    color: #666;
    font-size: 0.85rem;
    margin-right: 0.5rem;
  }

  .reason-text {
    color: #333;
    font-size: 0.85rem;
  }

  .entry-actions {
    display: flex;
    gap: 0.5rem;
  }

  .entry-meta {
    padding-top: 0.75rem;
    border-top: 1px solid #f0f0f0;
  }

  .meta-text {
    font-size: 0.8rem;
    color: #999;
  }

  /* Responsive design */
  @media (max-width: 768px) {
    .form-row {
      grid-template-columns: 1fr;
    }

    .filters {
      grid-template-columns: 1fr;
    }

    .manager-header {
      flex-direction: column;
      gap: 1rem;
      align-items: stretch;
    }
  }
</style>
