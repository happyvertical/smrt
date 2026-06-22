<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';
import type { CategoryData } from '../types';

const { t } = useI18n();

interface Props {
  readonly?: boolean;
}

const { readonly = false }: Props = $props();

// Placeholder for category management
const _categories = $state<CategoryData[]>([]);
const _loading = $state(false);
</script>

<div class="category-manager">
  <div class="manager-header">
    <h2>{t(M['products.category_manager.title'])}</h2>
    <p>{t(M['products.category_manager.subtitle'])}</p>
  </div>

  <div class="placeholder-content">
    <p>{t(M['products.category_manager.coming_soon'])}</p>
    <p>{t(M['products.category_manager.will_include'])}</p>
    <ul>
      <li>{t(M['products.category_manager.create_edit'])}</li>
      <li>{t(M['products.category_manager.organize_hierarchy'])}</li>
      <li>{t(M['products.category_manager.manage_permissions'])}</li>
      <li>{t(M['products.category_manager.analytics'])}</li>
    </ul>
  </div>
</div>

<style>
  .category-manager {
    max-width: 800px;
    margin: 0 auto;
    padding: 1rem;
  }
  
  .manager-header {
    text-align: center;
    margin-bottom: 2rem;
  }
  
  .manager-header h2 {
    margin: 0 0 0.5rem 0;
    color: var(--smrt-color-on-surface, #1f2937);
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }

  .manager-header p {
    margin: 0;
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }

  .placeholder-content {
    background: var(--smrt-color-surface-container-low, #f9fafb);
    border: 1px solid var(--smrt-color-outline-variant, #e2e8f0);
    border-radius: var(--smrt-radius-md, 8px);
    padding: 2rem;
    text-align: center;
  }

  .placeholder-content p {
    margin: 0 0 1rem 0;
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }

  .placeholder-content ul {
    margin: 1rem 0 0 0;
    text-align: left;
    display: inline-block;
    color: var(--smrt-color-on-surface-variant, #6b7280);
  }
</style>