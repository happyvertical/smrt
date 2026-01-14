<script lang="ts">
/**
 * MessageDashboard - Monitor processed messages and routing activity
 *
 * Features:
 * - List all processed messages
 * - Filter by category, intent, status
 * - View email details
 * - Show routing decisions and matched rules
 * - Display sender information
 * - View job tracking information
 * - Real-time status updates
 */

interface ProcessedMessage {
  id: string;
  emailId: string;
  intent: string;
  category: string;
  sentiment: string;
  urgency: string;
  senderEmail: string;
  senderName: string;
  userId: string | null;
  profileId: string | null;
  matchedRuleId: string | null;
  matchedRuleName?: string;
  status: string;
  isWhitelisted: boolean;
  isBlacklisted: boolean;
  requiresEscalation: boolean;
  jobIds: string[];
  createdAt: Date;
  entities: Record<string, any>;
}

interface Email {
  id: string;
  subject: string;
  fromAddress: string;
  fromName: string;
  textBody: string;
  receivedAt: Date;
}

interface Props {
  messages: ProcessedMessage[];
  onViewEmail?: (emailId: string) => void;
  onReprocess?: (messageId: string) => void;
  onViewJob?: (jobId: string) => void;
}

let { messages = [], onViewEmail, onReprocess, onViewJob }: Props = $props();

// Filters
let filters = $state({
  category: '',
  intent: '',
  status: '',
  search: '',
});

// View mode
let viewMode = $state<'list' | 'grid'>('list');

// Filtered messages
let filteredMessages = $derived(
  messages.filter((msg) => {
    if (filters.category && msg.category !== filters.category) return false;
    if (filters.intent && msg.intent !== filters.intent) return false;
    if (filters.status && msg.status !== filters.status) return false;
    if (filters.search) {
      const search = filters.search.toLowerCase();
      return (
        msg.senderEmail.toLowerCase().includes(search) ||
        msg.senderName.toLowerCase().includes(search) ||
        msg.intent.toLowerCase().includes(search)
      );
    }
    return true;
  }),
);

// Statistics
let stats = $derived({
  total: messages.length,
  pending: messages.filter((m) => m.status === 'pending').length,
  dispatched: messages.filter((m) => m.status === 'dispatched').length,
  handled: messages.filter((m) => m.status === 'handled').length,
  failed: messages.filter((m) => m.status === 'failed').length,
  whitelisted: messages.filter((m) => m.isWhitelisted).length,
  blacklisted: messages.filter((m) => m.isBlacklisted).length,
  escalated: messages.filter((m) => m.requiresEscalation).length,
});

// Category colors
const categoryColors: Record<string, string> = {
  support: 'bg-blue-100 text-blue-800',
  sales: 'bg-green-100 text-green-800',
  legal: 'bg-red-100 text-red-800',
  ops: 'bg-purple-100 text-purple-800',
  dev: 'bg-yellow-100 text-yellow-800',
  product: 'bg-pink-100 text-pink-800',
  content: 'bg-indigo-100 text-indigo-800',
};

// Status colors
const statusColors: Record<string, string> = {
  pending: 'bg-yellow-100 text-yellow-800',
  dispatched: 'bg-blue-100 text-blue-800',
  handled: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
};

// Urgency colors
const urgencyColors: Record<string, string> = {
  low: 'bg-gray-100 text-gray-800',
  medium: 'bg-yellow-100 text-yellow-800',
  high: 'bg-orange-100 text-orange-800',
  critical: 'bg-red-100 text-red-800',
};

function getCategoryColor(category: string): string {
  return categoryColors[category] || 'bg-gray-100 text-gray-800';
}

function getStatusColor(status: string): string {
  return statusColors[status] || 'bg-gray-100 text-gray-800';
}

function getUrgencyColor(urgency: string): string {
  return urgencyColors[urgency] || 'bg-gray-100 text-gray-800';
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleString();
}

function handleViewEmail(emailId: string) {
  onViewEmail?.(emailId);
}

function handleReprocess(messageId: string) {
  if (confirm('Reprocess this message?')) {
    onReprocess?.(messageId);
  }
}

function handleViewJob(jobId: string) {
  onViewJob?.(jobId);
}

function clearFilters() {
  filters = { category: '', intent: '', status: '', search: '' };
}
</script>

<div class="message-dashboard">
  <!-- Statistics Bar -->
  <div class="stats-bar">
    <div class="stat-card">
      <span class="stat-label">Total</span>
      <span class="stat-value">{stats.total}</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">Pending</span>
      <span class="stat-value stat-warning">{stats.pending}</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">Handled</span>
      <span class="stat-value stat-success">{stats.handled}</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">Failed</span>
      <span class="stat-value stat-danger">{stats.failed}</span>
    </div>
    <div class="stat-card">
      <span class="stat-label">Escalated</span>
      <span class="stat-value stat-danger">{stats.escalated}</span>
    </div>
  </div>

  <!-- Filters -->
  <div class="filters">
    <div class="filter-row">
      <input
        type="text"
        bind:value={filters.search}
        placeholder="Search by sender or intent..."
        class="search-input"
      />

      <select bind:value={filters.category}>
        <option value="">All Categories</option>
        <option value="support">Support</option>
        <option value="sales">Sales</option>
        <option value="legal">Legal</option>
        <option value="ops">Operations</option>
        <option value="dev">Development</option>
        <option value="product">Product</option>
        <option value="content">Content</option>
      </select>

      <select bind:value={filters.status}>
        <option value="">All Statuses</option>
        <option value="pending">Pending</option>
        <option value="dispatched">Dispatched</option>
        <option value="handled">Handled</option>
        <option value="failed">Failed</option>
      </select>

      <button class="btn-secondary" onclick={clearFilters}>Clear Filters</button>
    </div>
  </div>

  <!-- Messages List -->
  <div class="messages-container">
    {#if filteredMessages.length === 0}
      <div class="empty-state">
        <p>No messages found matching your filters.</p>
      </div>
    {:else}
      <div class="messages-list">
        {#each filteredMessages as message (message.id)}
          <div class="message-card">
            <div class="message-header">
              <div class="message-title-row">
                <div class="sender-info">
                  <span class="sender-name">{message.senderName || 'Unknown'}</span>
                  <span class="sender-email">&lt;{message.senderEmail}&gt;</span>
                </div>
                <div class="badges">
                  <span class="badge {getCategoryColor(message.category)}">
                    {message.category}
                  </span>
                  <span class="badge {getStatusColor(message.status)}">
                    {message.status}
                  </span>
                  {#if message.isWhitelisted}
                    <span class="badge bg-green-100 text-green-800">Whitelisted</span>
                  {/if}
                  {#if message.isBlacklisted}
                    <span class="badge bg-red-100 text-red-800">Blacklisted</span>
                  {/if}
                  {#if message.requiresEscalation}
                    <span class="badge bg-orange-100 text-orange-800">⚠️ Escalated</span>
                  {/if}
                </div>
              </div>
            </div>

            <div class="message-body">
              <div class="message-details">
                <div class="detail-row">
                  <span class="detail-label">Intent:</span>
                  <span class="detail-value">{message.intent}</span>
                </div>

                <div class="detail-row">
                  <span class="detail-label">Sentiment:</span>
                  <span class="detail-value">{message.sentiment}</span>
                </div>

                <div class="detail-row">
                  <span class="detail-label">Urgency:</span>
                  <span class="badge {getUrgencyColor(message.urgency)}">
                    {message.urgency}
                  </span>
                </div>

                {#if message.matchedRuleName}
                  <div class="detail-row">
                    <span class="detail-label">Matched Rule:</span>
                    <span class="detail-value">{message.matchedRuleName}</span>
                  </div>
                {/if}

                {#if message.userId || message.profileId}
                  <div class="detail-row">
                    <span class="detail-label">Known Contact:</span>
                    <span class="detail-value">
                      {message.userId ? 'User' : 'Profile'} ID: {message.userId || message.profileId}
                    </span>
                  </div>
                {/if}

                {#if message.jobIds && message.jobIds.length > 0}
                  <div class="detail-row">
                    <span class="detail-label">Jobs:</span>
                    <div class="job-badges">
                      {#each message.jobIds as jobId}
                        <button
                          class="job-badge"
                          onclick={() => handleViewJob(jobId)}
                          title="View job details"
                        >
                          {jobId.substring(0, 8)}...
                        </button>
                      {/each}
                    </div>
                  </div>
                {/if}

                <div class="detail-row">
                  <span class="detail-label">Processed:</span>
                  <span class="detail-value">{formatDate(message.createdAt)}</span>
                </div>
              </div>

              {#if Object.keys(message.entities).length > 0}
                <div class="entities">
                  <span class="entities-label">Extracted Entities:</span>
                  <div class="entities-list">
                    {#each Object.entries(message.entities) as [key, value]}
                      <span class="entity">
                        <strong>{key}:</strong> {JSON.stringify(value)}
                      </span>
                    {/each}
                  </div>
                </div>
              {/if}
            </div>

            <div class="message-actions">
              <button class="btn-icon" onclick={() => handleViewEmail(message.emailId)} title="View email">
                📧 View Email
              </button>
              {#if message.status === 'failed'}
                <button class="btn-icon" onclick={() => handleReprocess(message.id)} title="Reprocess">
                  🔄 Reprocess
                </button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  </div>
</div>

<style>
  .message-dashboard {
    width: 100%;
  }

  .stats-bar {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 1rem;
    margin-bottom: 1.5rem;
  }

  .stat-card {
    background: white;
    padding: 1rem;
    border-radius: 8px;
    border: 1px solid #e0e0e0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.5rem;
  }

  .stat-label {
    font-size: 0.85rem;
    color: #666;
    font-weight: 500;
  }

  .stat-value {
    font-size: 1.75rem;
    font-weight: 600;
    color: #333;
  }

  .stat-value.stat-warning {
    color: #f39c12;
  }

  .stat-value.stat-success {
    color: #27ae60;
  }

  .stat-value.stat-danger {
    color: #e74c3c;
  }

  .filters {
    background: white;
    padding: 1rem;
    border-radius: 8px;
    border: 1px solid #e0e0e0;
    margin-bottom: 1.5rem;
  }

  .filter-row {
    display: grid;
    grid-template-columns: 2fr 1fr 1fr auto;
    gap: 1rem;
    align-items: center;
  }

  .search-input,
  select {
    padding: 0.5rem;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 0.9rem;
  }

  .search-input {
    min-width: 0;
  }

  .btn-secondary {
    padding: 0.5rem 1rem;
    background: #f5f5f5;
    border: 1px solid #ddd;
    border-radius: 4px;
    cursor: pointer;
    font-size: 0.9rem;
    transition: all 0.2s;
  }

  .btn-secondary:hover {
    background: #e0e0e0;
  }

  .empty-state {
    padding: 3rem;
    text-align: center;
    color: #666;
    background: #f5f5f5;
    border-radius: 8px;
  }

  .messages-list {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .message-card {
    background: white;
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    padding: 1rem;
    transition: all 0.2s;
  }

  .message-card:hover {
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }

  .message-header {
    margin-bottom: 1rem;
    padding-bottom: 0.75rem;
    border-bottom: 1px solid #f0f0f0;
  }

  .message-title-row {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
  }

  .sender-info {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .sender-name {
    font-size: 1rem;
    font-weight: 600;
    color: #333;
  }

  .sender-email {
    font-size: 0.85rem;
    color: #666;
  }

  .badges {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .badge {
    padding: 0.25rem 0.75rem;
    border-radius: 12px;
    font-size: 0.75rem;
    font-weight: 500;
    white-space: nowrap;
  }

  .bg-blue-100 { background: #e3f2fd; }
  .text-blue-800 { color: #1565c0; }
  .bg-green-100 { background: #e8f5e9; }
  .text-green-800 { color: #2e7d32; }
  .bg-red-100 { background: #ffebee; }
  .text-red-800 { color: #c62828; }
  .bg-purple-100 { background: #f3e5f5; }
  .text-purple-800 { color: #6a1b9a; }
  .bg-yellow-100 { background: #fff9c4; }
  .text-yellow-800 { color: #f57f17; }
  .bg-pink-100 { background: #fce4ec; }
  .text-pink-800 { color: #ad1457; }
  .bg-indigo-100 { background: #e8eaf6; }
  .text-indigo-800 { color: #283593; }
  .bg-gray-100 { background: #f5f5f5; }
  .text-gray-800 { color: #424242; }
  .bg-orange-100 { background: #fff3e0; }
  .text-orange-800 { color: #e65100; }

  .message-body {
    margin-bottom: 1rem;
  }

  .message-details {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 0.75rem;
  }

  .detail-row {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .detail-label {
    font-weight: 600;
    color: #666;
    font-size: 0.85rem;
  }

  .detail-value {
    color: #333;
    font-size: 0.85rem;
  }

  .job-badges {
    display: flex;
    gap: 0.25rem;
    flex-wrap: wrap;
  }

  .job-badge {
    padding: 0.125rem 0.5rem;
    background: #e3f2fd;
    color: #1565c0;
    border: 1px solid #90caf9;
    border-radius: 4px;
    font-size: 0.75rem;
    font-family: monospace;
    cursor: pointer;
    transition: all 0.2s;
  }

  .job-badge:hover {
    background: #bbdefb;
  }

  .entities {
    margin-top: 1rem;
    padding: 0.75rem;
    background: #f9f9f9;
    border-radius: 4px;
    border-left: 3px solid #4a90e2;
  }

  .entities-label {
    display: block;
    font-weight: 600;
    font-size: 0.85rem;
    margin-bottom: 0.5rem;
    color: #333;
  }

  .entities-list {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .entity {
    font-size: 0.8rem;
    color: #555;
  }

  .message-actions {
    display: flex;
    gap: 0.5rem;
    padding-top: 0.75rem;
    border-top: 1px solid #f0f0f0;
  }

  .btn-icon {
    background: none;
    border: 1px solid #ddd;
    border-radius: 4px;
    padding: 0.5rem 0.75rem;
    cursor: pointer;
    font-size: 0.85rem;
    transition: all 0.2s;
  }

  .btn-icon:hover {
    background: #f5f5f5;
    border-color: #aaa;
  }

  /* Responsive design */
  @media (max-width: 768px) {
    .filter-row {
      grid-template-columns: 1fr;
    }

    .message-title-row {
      flex-direction: column;
    }

    .message-details {
      grid-template-columns: 1fr;
    }

    .stats-bar {
      grid-template-columns: repeat(2, 1fr);
    }
  }
</style>
