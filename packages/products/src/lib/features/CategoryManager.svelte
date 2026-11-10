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

<div class="smrt-category-manager__root" data-smrt-component="CategoryManager">
  <div class="smrt-category-manager__header" data-smrt-part="header">
    <h2>{t(M['products.category_manager.title'])}</h2>
    <p>{t(M['products.category_manager.subtitle'])}</p>
  </div>

  <div class="smrt-category-manager__content" data-smrt-part="content">
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
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-category-manager__root {
    max-width: 800px;
    margin: 0 auto;
    padding: 1rem;
  }
  .smrt-category-manager__header {
    margin-bottom: 2rem;
  }
  .smrt-category-manager__header h2 {
    margin: 0 0 0.5rem 0;
  }
  .smrt-category-manager__header p {
    margin: 0;
  }
  .smrt-category-manager__content {
    padding: 2rem;
  }
  .smrt-category-manager__content p {
    margin: 0 0 1rem 0;
  }
  .smrt-category-manager__content ul {
    margin: 1rem 0 0 0;
    display: inline-block;
  }
}

@layer smrt.theme {
  .smrt-category-manager__header {
    text-align: center;
  }
  .smrt-category-manager__header h2 {
    color: var(--smrt-color-on-surface);
    font-size: var(--smrt-typography-headline-small-size, 1.5rem);
    font-weight: var(--smrt-typography-weight-semibold, 600);
  }
  .smrt-category-manager__header p {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-category-manager__content {
    background: var(--smrt-color-surface-container-low);
    border: var(--smrt-hairline);
    border-radius: var(--smrt-radius-md);
    text-align: center;
  }
  .smrt-category-manager__content p {
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-category-manager__content ul {
    text-align: left;
    color: var(--smrt-color-on-surface-variant);
  }
}

</style>