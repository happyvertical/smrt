<script lang="ts">
/**
 * RuleList - Display and manage routing rules
 *
 * Features:
 * - List all routing rules with priority ordering
 * - Enable/disable rules
 * - Delete rules
 * - Show match statistics
 */

interface Rule {
  id: string;
  name: string;
  description: string;
  enabled: boolean;
  priority: number;
  category: string;
  signalType: string;
  matchCount: number;
  lastMatchedAt: Date | null;
  regexPatterns: {
    subject?: string;
    from?: string;
    body?: string;
  };
  aiCondition: string;
}

interface Props {
  rules: Rule[];
  onToggle?: (ruleId: string, enabled: boolean) => void;
  onDelete?: (ruleId: string) => void;
  onEdit?: (ruleId: string) => void;
}

let { rules = [], onToggle, onDelete, onEdit }: Props = $props();

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

function handleToggle(rule: Rule) {
  onToggle?.(rule.id, !rule.enabled);
}

function handleDelete(rule: Rule) {
  if (confirm(`Delete rule "${rule.name}"?`)) {
    onDelete?.(rule.id);
  }
}

function handleEdit(rule: Rule) {
  onEdit?.(rule.id);
}
</script>

<div class="rule-list">
  {#if rules.length === 0}
    <div class="empty-state">
      <p>No routing rules found. Create your first rule to get started.</p>
    </div>
  {:else}
    <div class="rules-container">
      {#each rules as rule (rule.id)}
        <div class="rule-card" class:disabled={!rule.enabled}>
          <div class="rule-header">
            <div class="rule-title-row">
              <h3 class="rule-name">{rule.name}</h3>
              <span class="category-badge {getCategoryColor(rule.category)}">
                {rule.category}
              </span>
            </div>
            <div class="rule-actions">
              <button
                class="btn-icon"
                onclick={() => handleToggle(rule)}
                title={rule.enabled ? 'Disable rule' : 'Enable rule'}
              >
                {rule.enabled ? '✓' : '○'}
              </button>
              {#if onEdit}
                <button
                  class="btn-icon"
                  onclick={() => handleEdit(rule)}
                  title="Edit rule"
                >
                  ✏️
                </button>
              {/if}
              {#if onDelete}
                <button
                  class="btn-icon btn-danger"
                  onclick={() => handleDelete(rule)}
                  title="Delete rule"
                >
                  🗑️
                </button>
              {/if}
            </div>
          </div>

          <div class="rule-body">
            {#if rule.description}
              <p class="rule-description">{rule.description}</p>
            {/if}

            <div class="rule-details">
              <div class="detail-item">
                <span class="detail-label">Priority:</span>
                <span class="detail-value">{rule.priority}</span>
              </div>

              <div class="detail-item">
                <span class="detail-label">Signal:</span>
                <span class="detail-value">{rule.signalType}</span>
              </div>

              <div class="detail-item">
                <span class="detail-label">Matches:</span>
                <span class="detail-value">{rule.matchCount}</span>
              </div>

              {#if rule.lastMatchedAt}
                <div class="detail-item">
                  <span class="detail-label">Last matched:</span>
                  <span class="detail-value">
                    {new Date(rule.lastMatchedAt).toLocaleString()}
                  </span>
                </div>
              {/if}
            </div>

            {#if rule.regexPatterns.subject || rule.regexPatterns.from || rule.regexPatterns.body}
              <div class="patterns">
                <p class="patterns-label">Regex Patterns:</p>
                {#if rule.regexPatterns.subject}
                  <div class="pattern-item">
                    <span class="pattern-label">Subject:</span>
                    <code>{rule.regexPatterns.subject}</code>
                  </div>
                {/if}
                {#if rule.regexPatterns.from}
                  <div class="pattern-item">
                    <span class="pattern-label">From:</span>
                    <code>{rule.regexPatterns.from}</code>
                  </div>
                {/if}
                {#if rule.regexPatterns.body}
                  <div class="pattern-item">
                    <span class="pattern-label">Body:</span>
                    <code>{rule.regexPatterns.body}</code>
                  </div>
                {/if}
              </div>
            {/if}

            {#if rule.aiCondition}
              <div class="ai-condition">
                <p class="ai-condition-label">AI Condition:</p>
                <p class="ai-condition-text">{rule.aiCondition}</p>
              </div>
            {/if}
          </div>
        </div>
      {/each}
    </div>
  {/if}
</div>

<style>
  .rule-list {
    width: 100%;
  }

  .empty-state {
    padding: 2rem;
    text-align: center;
    color: #666;
    background: #f5f5f5;
    border-radius: 8px;
  }

  .rules-container {
    display: flex;
    flex-direction: column;
    gap: 1rem;
  }

  .rule-card {
    border: 1px solid #ddd;
    border-radius: 8px;
    padding: 1rem;
    background: white;
    transition: all 0.2s;
  }

  .rule-card:hover {
    box-shadow: 0 2px 8px rgba(0, 0, 0, 0.1);
  }

  .rule-card.disabled {
    opacity: 0.6;
    background: #f9f9f9;
  }

  .rule-header {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    margin-bottom: 0.75rem;
  }

  .rule-title-row {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex: 1;
  }

  .rule-name {
    font-size: 1.125rem;
    font-weight: 600;
    margin: 0;
    color: #333;
  }

  .category-badge {
    padding: 0.25rem 0.75rem;
    border-radius: 12px;
    font-size: 0.75rem;
    font-weight: 500;
  }

  .rule-actions {
    display: flex;
    gap: 0.5rem;
  }

  .btn-icon {
    background: none;
    border: 1px solid #ddd;
    border-radius: 4px;
    padding: 0.25rem 0.5rem;
    cursor: pointer;
    font-size: 1rem;
    transition: all 0.2s;
  }

  .btn-icon:hover {
    background: #f5f5f5;
    border-color: #aaa;
  }

  .btn-danger:hover {
    background: #fee;
    border-color: #faa;
  }

  .rule-body {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .rule-description {
    color: #666;
    margin: 0;
    font-size: 0.9rem;
  }

  .rule-details {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: 0.5rem;
    padding: 0.75rem;
    background: #f9f9f9;
    border-radius: 4px;
  }

  .detail-item {
    display: flex;
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

  .patterns {
    padding: 0.75rem;
    background: #fafafa;
    border-radius: 4px;
    border-left: 3px solid #4a90e2;
  }

  .patterns-label {
    font-weight: 600;
    margin: 0 0 0.5rem 0;
    font-size: 0.85rem;
    color: #333;
  }

  .pattern-item {
    display: flex;
    gap: 0.5rem;
    margin-bottom: 0.25rem;
  }

  .pattern-label {
    font-weight: 500;
    color: #666;
    font-size: 0.85rem;
    min-width: 60px;
  }

  code {
    background: #f0f0f0;
    padding: 0.125rem 0.375rem;
    border-radius: 3px;
    font-size: 0.8rem;
    font-family: 'Courier New', monospace;
  }

  .ai-condition {
    padding: 0.75rem;
    background: #f0f8ff;
    border-radius: 4px;
    border-left: 3px solid #50c878;
  }

  .ai-condition-label {
    font-weight: 600;
    margin: 0 0 0.5rem 0;
    font-size: 0.85rem;
    color: #333;
  }

  .ai-condition-text {
    color: #555;
    font-size: 0.85rem;
    margin: 0;
    font-style: italic;
  }

  /* Responsive design */
  @media (max-width: 768px) {
    .rule-details {
      grid-template-columns: 1fr;
    }

    .rule-header {
      flex-direction: column;
      gap: 0.75rem;
    }

    .rule-actions {
      align-self: flex-start;
    }
  }
</style>
