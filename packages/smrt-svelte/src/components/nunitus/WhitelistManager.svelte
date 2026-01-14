<script lang="ts">
/**
 * WhitelistManager - Manage whitelist entries for email routing
 *
 * Features:
 * - List all whitelist entries
 * - Add new whitelist patterns
 * - Delete whitelist entries
 * - Pattern type selection (email, domain, regex)
 * - Category filtering (global or specific category)
 * - Pattern validation
 */

interface WhitelistEntry {
  id: string;
  pattern: string;
  type: 'email' | 'domain' | 'regex';
  category: string | null;
  description: string;
  createdAt: Date;
}

interface Props {
  entries: WhitelistEntry[];
  onAdd?: (entry: Omit<WhitelistEntry, 'id' | 'createdAt'>) => void;
  onDelete?: (entryId: string) => void;
}

let { entries = [], onAdd, onDelete }: Props = $props();

// Form state
let showForm = $state(false);
let formData = $state({
  pattern: '',
  type: 'email' as 'email' | 'domain' | 'regex',
  category: '',
  description: '',
});

// Validation errors
let errors = $state<Record<string, string>>({});

// Filters
let filters = $state({
  category: '',
  type: '',
  search: '',
});

// Filtered entries
let filteredEntries = $derived(
  entries.filter((entry) => {
    if (filters.category && entry.category !== filters.category) return false;
    if (filters.type && entry.type !== filters.type) return false;
    if (filters.search) {
      const search = filters.search.toLowerCase();
      return (
        entry.pattern.toLowerCase().includes(search) ||
        entry.description.toLowerCase().includes(search)
      );
    }
    return true;
  }),
);

// Categories
const categories = [
  { value: '', label: 'All Categories (Global)' },
  { value: 'support', label: 'Support' },
  { value: 'sales', label: 'Sales' },
  { value: 'legal', label: 'Legal' },
  { value: 'ops', label: 'Operations' },
  { value: 'dev', label: 'Development' },
  { value: 'product', label: 'Product' },
  { value: 'content', label: 'Content' },
];

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

  errors = newErrors;
  return Object.keys(newErrors).length === 0;
}

function handleSubmit() {
  if (validateForm()) {
    onAdd?.({
      pattern: formData.pattern,
      type: formData.type,
      category: formData.category || null,
      description: formData.description,
    });

    // Reset form
    formData = {
      pattern: '',
      type: 'email',
      category: '',
      description: '',
    };
    showForm = false;
    errors = {};
  }
}

function handleDelete(entryId: string, pattern: string) {
  if (confirm(`Remove whitelist entry for "${pattern}"?`)) {
    onDelete?.(entryId);
  }
}

function handleCancel() {
  showForm = false;
  formData = {
    pattern: '',
    type: 'email',
    category: '',
    description: '',
  };
  errors = {};
}

function clearFilters() {
  filters = { category: '', type: '', search: '' };
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleString();
}
</script>

<div class="whitelist-manager">
  <div class="manager-header">
    <h2>Whitelist Management</h2>
    <button class="btn-primary" onclick={() => (showForm = !showForm)}>
      {showForm ? 'Cancel' : '+ Add Entry'}
    </button>
  </div>

  {#if showForm}
    <div class="add-form">
      <h3>Add Whitelist Entry</h3>
      <form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}>
        <div class="form-row">
          <div class="form-group">
            <label for="pattern">Pattern *</label>
            <input
              id="pattern"
              type="text"
              bind:value={formData.pattern}
              class:error={errors.pattern}
              placeholder={formData.type === 'email' ? 'user@example.com' : formData.type === 'domain' ? 'example.com' : '.*@example\\.com'}
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

        <div class="form-row">
          <div class="form-group">
            <label for="category">Category</label>
            <select id="category" bind:value={formData.category}>
              {#each categories as cat}
                <option value={cat.value}>{cat.label}</option>
              {/each}
            </select>
            <span class="field-hint">
              Leave as "All Categories" for global whitelist
            </span>
          </div>

          <div class="form-group">
            <label for="description">Description</label>
            <input
              id="description"
              type="text"
              bind:value={formData.description}
              placeholder="e.g., VIP customer"
            />
          </div>
        </div>

        <div class="form-actions">
          <button type="button" class="btn-secondary" onclick={handleCancel}>Cancel</button>
          <button type="submit" class="btn-primary">Add to Whitelist</button>
        </div>
      </form>
    </div>
  {/if}

  <!-- Filters -->
  <div class="filters">
    <input
      type="text"
      bind:value={filters.search}
      placeholder="Search patterns..."
      class="search-input"
    />

    <select bind:value={filters.type}>
      <option value="">All Types</option>
      <option value="email">Email</option>
      <option value="domain">Domain</option>
      <option value="regex">Regex</option>
    </select>

    <select bind:value={filters.category}>
      <option value="">All Categories</option>
      <option value="null">Global Only</option>
      {#each categories.slice(1) as cat}
        <option value={cat.value}>{cat.label}</option>
      {/each}
    </select>

    <button class="btn-secondary" onclick={clearFilters}>Clear</button>
  </div>

  <!-- Entries List -->
  <div class="entries-container">
    {#if filteredEntries.length === 0}
      <div class="empty-state">
        <p>No whitelist entries found.</p>
      </div>
    {:else}
      <div class="entries-list">
        {#each filteredEntries as entry (entry.id)}
          <div class="entry-card">
            <div class="entry-header">
              <div class="entry-info">
                <span class="entry-pattern">{entry.pattern}</span>
                <div class="entry-badges">
                  <span class="badge badge-type">{entry.type}</span>
                  {#if entry.category}
                    <span class="badge badge-category">{entry.category}</span>
                  {:else}
                    <span class="badge badge-global">Global</span>
                  {/if}
                </div>
              </div>
              <button
                class="btn-delete"
                onclick={() => handleDelete(entry.id, entry.pattern)}
                title="Remove from whitelist"
              >
                🗑️
              </button>
            </div>

            {#if entry.description}
              <div class="entry-description">{entry.description}</div>
            {/if}

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
  .whitelist-manager {
    width: 100%;
  }

  .manager-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1.5rem;
  }

  .manager-header h2 {
    margin: 0;
    font-size: 1.5rem;
    color: #333;
  }

  .add-form {
    background: white;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    padding: 1.5rem;
    margin-bottom: 1.5rem;
  }

  .add-form h3 {
    margin: 0 0 1rem 0;
    font-size: 1.125rem;
    color: #333;
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
    border-color: #4a90e2;
  }

  input.error {
    border-color: #e74c3c;
  }

  .error-message {
    margin-top: 0.25rem;
    font-size: 0.85rem;
    color: #e74c3c;
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

  .filters {
    display: grid;
    grid-template-columns: 2fr 1fr 1fr auto;
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

  .entries-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .entry-card {
    background: white;
    border: 1px solid #e0e0e0;
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
    color: #333;
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
    background: #e3f2fd;
    color: #1565c0;
  }

  .badge-category {
    background: #e8f5e9;
    color: #2e7d32;
  }

  .badge-global {
    background: #fff3e0;
    color: #e65100;
  }

  .entry-description {
    color: #666;
    font-size: 0.9rem;
    margin-bottom: 0.75rem;
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
