<script lang="ts">
import Card from '../ui/Card.svelte';

export interface Reference {
  title: string;
  url: string;
  type?: 'agenda' | 'minutes' | 'video' | 'document' | 'external';
  description?: string;
}

interface Props {
  references: Reference[];
  title?: string;
}

const { references, title = 'References' }: Props = $props();

const _getIcon = (type?: string) => {
  switch (type) {
    case 'agenda':
      return '📋';
    case 'minutes':
      return '📝';
    case 'video':
      return '🎬';
    case 'document':
      return '📄';
    case 'external':
      return '🔗';
    default:
      return '📎';
  }
};

const _getFileType = (url: string) => {
  const ext = url.split('.').pop()?.toLowerCase();
  if (ext === 'pdf') return 'PDF';
  if (ext === 'doc' || ext === 'docx') return 'Word';
  if (ext === 'mp4' || ext === 'webm') return 'Video';
  return '';
};
</script>

{#if references.length > 0}
  <section class="references">
    <Card>
      <h3 class="references-title">{title}</h3>
      <ul class="reference-list">
        {#each references as ref}
          <li class="reference-item">
            <a href={ref.url} class="reference-link" target="_blank" rel="noopener noreferrer">
              <span class="reference-icon">{_getIcon(ref.type)}</span>
              <span class="reference-content">
                <span class="reference-name">{ref.title}</span>
                {#if ref.description}
                  <span class="reference-description">{ref.description}</span>
                {/if}
              </span>
              {#if _getFileType(ref.url)}
                <span class="reference-badge">{_getFileType(ref.url)}</span>
              {/if}
            </a>
          </li>
        {/each}
      </ul>
    </Card>
  </section>
{/if}

<style>
  .references {
    margin-top: var(--spacing-xl);
  }

  .references-title {
    margin: 0 0 var(--spacing-md) 0;
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-semibold);
    color: var(--color-text-primary);
    border-bottom: 2px solid var(--color-primary-main);
    padding-bottom: var(--spacing-sm);
  }

  .reference-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: var(--spacing-sm);
  }

  .reference-item {
    border-bottom: 1px solid var(--color-neutral-gray200);
    padding-bottom: var(--spacing-sm);
  }

  .reference-item:last-child {
    border-bottom: none;
    padding-bottom: 0;
  }

  .reference-link {
    display: flex;
    align-items: flex-start;
    gap: var(--spacing-md);
    padding: var(--spacing-sm);
    border-radius: var(--radius-sm);
    text-decoration: none;
    color: inherit;
    transition: background-color var(--transition-fast);
  }

  .reference-link:hover {
    background-color: var(--color-neutral-gray100);
  }

  .reference-icon {
    font-size: var(--font-size-xl);
    flex-shrink: 0;
  }

  .reference-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xs);
  }

  .reference-name {
    font-weight: var(--font-weight-medium);
    color: var(--color-primary-main);
  }

  .reference-link:hover .reference-name {
    text-decoration: underline;
  }

  .reference-description {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }

  .reference-badge {
    font-size: var(--font-size-xs);
    font-weight: var(--font-weight-medium);
    padding: var(--spacing-xs) var(--spacing-sm);
    background-color: var(--color-neutral-gray200);
    color: var(--color-text-secondary);
    border-radius: var(--radius-sm);
    text-transform: uppercase;
    flex-shrink: 0;
  }
</style>
