<script lang="ts">
/**
 * MessageDetailView - Full detailed view of a processed message
 *
 * Features:
 * - Full email content display
 * - Extracted AI analysis data
 * - Matched rule details
 * - Sender information
 * - Job tracking
 * - Manual re-categorization
 * - Create rule from message
 * - Feedback notes
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

  // Feedback tracking
  manualCategoryOverride: string | null;
  overriddenBy: string | null;
  overriddenAt: Date | null;
  feedbackNotes: string | null;
}

interface Email {
  id: string;
  subject: string;
  fromAddress: string;
  fromName: string;
  toAddress: string;
  textBody: string;
  htmlBody?: string;
  receivedAt: Date;
  headers?: Record<string, string>;
}

interface Props {
  message: ProcessedMessage;
  email: Email;
  onClose?: () => void;
  onRecategorize?: (
    messageId: string,
    newCategory: string,
    notes: string,
  ) => void;
  onCreateRule?: (message: ProcessedMessage, email: Email) => void;
  onViewJob?: (jobId: string) => void;
}

let {
  message,
  email,
  onClose,
  onRecategorize,
  onCreateRule,
  onViewJob,
}: Props = $props();

// Re-categorization state
let showRecategorize = $state(false);
let newCategory = $state(message.manualCategoryOverride || message.category);
let feedbackNotes = $state('');

// View mode
let viewMode = $state<'text' | 'html'>('text');

// Categories
const categories = [
  { value: 'support', label: 'Support' },
  { value: 'sales', label: 'Sales' },
  { value: 'legal', label: 'Legal' },
  { value: 'ops', label: 'Operations' },
  { value: 'dev', label: 'Development' },
  { value: 'product', label: 'Product' },
  { value: 'content', label: 'Content' },
];

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

function getCategoryColor(category: string): string {
  return categoryColors[category] || 'bg-gray-100 text-gray-800';
}

function formatDate(date: Date): string {
  return new Date(date).toLocaleString();
}

function handleRecategorize() {
  if (newCategory === message.category && !message.manualCategoryOverride) {
    alert('Please select a different category');
    return;
  }

  if (!feedbackNotes.trim()) {
    alert('Please provide a reason for re-categorization');
    return;
  }

  onRecategorize?.(message.id, newCategory, feedbackNotes);
  showRecategorize = false;
  feedbackNotes = '';
}

function handleCreateRule() {
  onCreateRule?.(message, email);
}

function handleViewJob(jobId: string) {
  onViewJob?.(jobId);
}

function handleClose() {
  onClose?.();
}
</script>

<div class="detail-view">
  <div class="detail-header">
    <div class="header-content">
      <h2>Message Details</h2>
      <div class="header-badges">
        <span class="badge {getCategoryColor(message.category)}">
          {message.category}
        </span>
        {#if message.manualCategoryOverride}
          <span class="badge bg-orange-100 text-orange-800">
            ✏️ Overridden
          </span>
        {/if}
        {#if message.requiresEscalation}
          <span class="badge bg-red-100 text-red-800">
            ⚠️ Escalated
          </span>
        {/if}
      </div>
    </div>
    <button class="btn-close" onclick={handleClose}>✕</button>
  </div>

  <div class="detail-body">
    <!-- Email Content Section -->
    <div class="section">
      <div class="section-header">
        <h3>Email Content</h3>
        {#if email.htmlBody}
          <div class="view-toggle">
            <button
              class="toggle-btn"
              class:active={viewMode === 'text'}
              onclick={() => (viewMode = 'text')}
            >
              Text
            </button>
            <button
              class="toggle-btn"
              class:active={viewMode === 'html'}
              onclick={() => (viewMode = 'html')}
            >
              HTML
            </button>
          </div>
        {/if}
      </div>

      <div class="email-meta">
        <div class="meta-row">
          <span class="meta-label">From:</span>
          <span class="meta-value">{email.fromName} &lt;{email.fromAddress}&gt;</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">To:</span>
          <span class="meta-value">{email.toAddress}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Subject:</span>
          <span class="meta-value subject">{email.subject}</span>
        </div>
        <div class="meta-row">
          <span class="meta-label">Received:</span>
          <span class="meta-value">{formatDate(email.receivedAt)}</span>
        </div>
      </div>

      <div class="email-body">
        {#if viewMode === 'text'}
          <pre class="email-text">{email.textBody}</pre>
        {:else if email.htmlBody}
          <div class="email-html">
            {@html email.htmlBody}
          </div>
        {/if}
      </div>
    </div>

    <!-- AI Analysis Section -->
    <div class="section">
      <h3>AI Analysis</h3>
      <div class="analysis-grid">
        <div class="analysis-item">
          <span class="analysis-label">Intent:</span>
          <span class="analysis-value">{message.intent}</span>
        </div>
        <div class="analysis-item">
          <span class="analysis-label">Sentiment:</span>
          <span class="analysis-value sentiment-{message.sentiment}">{message.sentiment}</span>
        </div>
        <div class="analysis-item">
          <span class="analysis-label">Urgency:</span>
          <span class="analysis-value urgency-{message.urgency}">{message.urgency}</span>
        </div>
        <div class="analysis-item">
          <span class="analysis-label">Status:</span>
          <span class="analysis-value">{message.status}</span>
        </div>
      </div>

      {#if Object.keys(message.entities).length > 0}
        <div class="entities">
          <h4>Extracted Entities</h4>
          <div class="entities-list">
            {#each Object.entries(message.entities) as [key, value]}
              <div class="entity">
                <span class="entity-key">{key}:</span>
                <span class="entity-value">{JSON.stringify(value)}</span>
              </div>
            {/each}
          </div>
        </div>
      {/if}
    </div>

    <!-- Routing Information -->
    <div class="section">
      <h3>Routing Information</h3>
      <div class="routing-info">
        {#if message.matchedRuleName}
          <div class="info-row">
            <span class="info-label">Matched Rule:</span>
            <span class="info-value">{message.matchedRuleName}</span>
          </div>
        {:else}
          <div class="info-row">
            <span class="info-label">Matched Rule:</span>
            <span class="info-value">No rule matched (default category)</span>
          </div>
        {/if}

        {#if message.isWhitelisted}
          <div class="info-row">
            <span class="badge bg-green-100 text-green-800">✓ Whitelisted</span>
          </div>
        {/if}

        {#if message.isBlacklisted}
          <div class="info-row">
            <span class="badge bg-red-100 text-red-800">✕ Blacklisted</span>
          </div>
        {/if}

        {#if message.userId || message.profileId}
          <div class="info-row">
            <span class="info-label">Known Contact:</span>
            <span class="info-value">
              {message.userId ? `User: ${message.userId}` : `Profile: ${message.profileId}`}
            </span>
          </div>
        {/if}
      </div>
    </div>

    <!-- Job Tracking -->
    {#if message.jobIds && message.jobIds.length > 0}
      <div class="section">
        <h3>Spawned Jobs ({message.jobIds.length})</h3>
        <div class="jobs-list">
          {#each message.jobIds as jobId}
            <button class="job-item" onclick={() => handleViewJob(jobId)}>
              <span class="job-icon">⚙️</span>
              <span class="job-id">{jobId}</span>
              <span class="job-action">→</span>
            </button>
          {/each}
        </div>
      </div>
    {/if}

    <!-- Feedback Tracking -->
    {#if message.manualCategoryOverride}
      <div class="section feedback-section">
        <h3>Feedback History</h3>
        <div class="feedback-info">
          <div class="info-row">
            <span class="info-label">Original Category:</span>
            <span class="info-value">{message.category}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Override Category:</span>
            <span class="info-value">{message.manualCategoryOverride}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Overridden By:</span>
            <span class="info-value">{message.overriddenBy}</span>
          </div>
          <div class="info-row">
            <span class="info-label">Overridden At:</span>
            <span class="info-value">{message.overriddenAt ? formatDate(message.overriddenAt) : 'N/A'}</span>
          </div>
          {#if message.feedbackNotes}
            <div class="info-row">
              <span class="info-label">Notes:</span>
              <span class="info-value">{message.feedbackNotes}</span>
            </div>
          {/if}
        </div>
      </div>
    {/if}

    <!-- Re-categorization Form -->
    {#if showRecategorize}
      <div class="section recategorize-section">
        <h3>Re-categorize Message</h3>
        <form onsubmit={(e) => { e.preventDefault(); handleRecategorize(); }}>
          <div class="form-group">
            <label for="new-category">New Category</label>
            <select id="new-category" bind:value={newCategory}>
              {#each categories as cat}
                <option value={cat.value}>{cat.label}</option>
              {/each}
            </select>
          </div>

          <div class="form-group">
            <label for="feedback-notes">Reason for Change *</label>
            <textarea
              id="feedback-notes"
              bind:value={feedbackNotes}
              placeholder="Explain why this message should be in a different category..."
              rows="3"
              required
            ></textarea>
          </div>

          <div class="form-actions">
            <button type="button" class="btn-secondary" onclick={() => (showRecategorize = false)}>
              Cancel
            </button>
            <button type="submit" class="btn-primary">Save Re-categorization</button>
          </div>
        </form>
      </div>
    {/if}
  </div>

  <!-- Action Bar -->
  <div class="action-bar">
    {#if !showRecategorize}
      <button class="btn-secondary" onclick={() => (showRecategorize = true)}>
        ✏️ Re-categorize
      </button>
    {/if}
    <button class="btn-secondary" onclick={handleCreateRule}>
      ➕ Create Rule from This
    </button>
  </div>
</div>

<style>
  .detail-view {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: white;
    border-radius: 8px;
    overflow: hidden;
  }

  .detail-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    padding: 1.5rem;
    border-bottom: 1px solid #e0e0e0;
    background: #f9f9f9;
  }

  .header-content {
    flex: 1;
  }

  .header-content h2 {
    margin: 0 0 0.5rem 0;
    font-size: 1.5rem;
    color: #333;
  }

  .header-badges {
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

  .bg-blue-100 { background: #e3f2fd; }
  .text-blue-800 { color: #1565c0; }
  .bg-green-100 { background: #e8f5e9; }
  .text-green-800 { color: #2e7d32; }
  .bg-red-100 { background: #ffebee; }
  .text-red-800 { color: #c62828; }
  .bg-orange-100 { background: #fff3e0; }
  .text-orange-800 { color: #e65100; }
  .bg-gray-100 { background: #f5f5f5; }
  .text-gray-800 { color: #424242; }
  .bg-purple-100 { background: #f3e5f5; }
  .text-purple-800 { color: #6a1b9a; }
  .bg-yellow-100 { background: #fff9c4; }
  .text-yellow-800 { color: #f57f17; }
  .bg-pink-100 { background: #fce4ec; }
  .text-pink-800 { color: #ad1457; }
  .bg-indigo-100 { background: #e8eaf6; }
  .text-indigo-800 { color: #283593; }

  .btn-close {
    background: none;
    border: none;
    font-size: 1.5rem;
    cursor: pointer;
    color: #666;
    padding: 0.25rem 0.5rem;
  }

  .btn-close:hover {
    color: #333;
  }

  .detail-body {
    flex: 1;
    overflow-y: auto;
    padding: 1.5rem;
  }

  .section {
    margin-bottom: 2rem;
    padding-bottom: 2rem;
    border-bottom: 1px solid #f0f0f0;
  }

  .section:last-child {
    border-bottom: none;
  }

  .section h3 {
    margin: 0 0 1rem 0;
    font-size: 1.125rem;
    color: #333;
  }

  .section h4 {
    margin: 1rem 0 0.5rem 0;
    font-size: 0.9rem;
    color: #666;
    font-weight: 600;
  }

  .section-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 1rem;
  }

  .view-toggle {
    display: flex;
    gap: 0.25rem;
    background: #f0f0f0;
    border-radius: 4px;
    padding: 0.25rem;
  }

  .toggle-btn {
    padding: 0.25rem 0.75rem;
    background: transparent;
    border: none;
    border-radius: 3px;
    cursor: pointer;
    font-size: 0.85rem;
    transition: all 0.2s;
  }

  .toggle-btn.active {
    background: white;
    font-weight: 500;
  }

  .email-meta {
    background: #f9f9f9;
    border-radius: 4px;
    padding: 1rem;
    margin-bottom: 1rem;
  }

  .meta-row {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.5rem;
  }

  .meta-row:last-child {
    margin-bottom: 0;
  }

  .meta-label {
    font-weight: 600;
    color: #666;
    min-width: 80px;
    font-size: 0.9rem;
  }

  .meta-value {
    color: #333;
    font-size: 0.9rem;
  }

  .meta-value.subject {
    font-weight: 500;
  }

  .email-body {
    background: white;
    border: 1px solid #e0e0e0;
    border-radius: 4px;
    padding: 1rem;
    max-height: 400px;
    overflow-y: auto;
  }

  .email-text {
    font-family: 'Courier New', monospace;
    font-size: 0.9rem;
    white-space: pre-wrap;
    word-wrap: break-word;
    margin: 0;
    color: #333;
  }

  .email-html {
    font-family: inherit;
    font-size: 0.9rem;
    line-height: 1.5;
  }

  .analysis-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .analysis-item {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .analysis-label {
    font-weight: 600;
    color: #666;
    font-size: 0.85rem;
  }

  .analysis-value {
    color: #333;
    font-size: 0.95rem;
  }

  .analysis-value.sentiment-positive {
    color: #2e7d32;
  }

  .analysis-value.sentiment-negative {
    color: #c62828;
  }

  .analysis-value.urgency-critical,
  .analysis-value.urgency-high {
    color: #e65100;
    font-weight: 500;
  }

  .entities {
    margin-top: 1rem;
    padding: 1rem;
    background: #f9f9f9;
    border-radius: 4px;
  }

  .entities-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .entity {
    display: flex;
    gap: 0.5rem;
    font-size: 0.85rem;
  }

  .entity-key {
    font-weight: 600;
    color: #666;
  }

  .entity-value {
    color: #333;
  }

  .routing-info,
  .feedback-info {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .info-row {
    display: flex;
    gap: 0.5rem;
    align-items: center;
  }

  .info-label {
    font-weight: 600;
    color: #666;
    font-size: 0.9rem;
  }

  .info-value {
    color: #333;
    font-size: 0.9rem;
  }

  .jobs-list {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .job-item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.75rem;
    background: #f9f9f9;
    border: 1px solid #e0e0e0;
    border-radius: 4px;
    cursor: pointer;
    transition: all 0.2s;
  }

  .job-item:hover {
    background: #f0f0f0;
    border-color: #4a90e2;
  }

  .job-icon {
    font-size: 1.25rem;
  }

  .job-id {
    flex: 1;
    font-family: monospace;
    font-size: 0.85rem;
    color: #333;
  }

  .job-action {
    color: #4a90e2;
    font-weight: 600;
  }

  .feedback-section {
    background: #fff9e6;
    border: 1px solid #ffd54f;
    border-radius: 8px;
    padding: 1.5rem;
  }

  .recategorize-section {
    background: #f0f8ff;
    border: 1px solid #4a90e2;
    border-radius: 8px;
    padding: 1.5rem;
  }

  .form-group {
    margin-bottom: 1rem;
  }

  label {
    display: block;
    margin-bottom: 0.5rem;
    font-weight: 500;
    color: #333;
    font-size: 0.9rem;
  }

  select,
  textarea {
    width: 100%;
    padding: 0.5rem;
    border: 1px solid #ddd;
    border-radius: 4px;
    font-size: 0.9rem;
    font-family: inherit;
  }

  select:focus,
  textarea:focus {
    outline: none;
    border-color: #4a90e2;
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

  .action-bar {
    display: flex;
    justify-content: flex-start;
    gap: 0.5rem;
    padding: 1rem 1.5rem;
    border-top: 1px solid #e0e0e0;
    background: #f9f9f9;
  }

  /* Responsive design */
  @media (max-width: 768px) {
    .analysis-grid {
      grid-template-columns: 1fr;
    }

    .detail-header {
      flex-direction: column;
      gap: 1rem;
    }
  }
</style>
