<script lang="ts">
import type { CategoryData } from '../types';

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
    <h2>Category Manager</h2>
    <p>Manage product categories</p>
  </div>
  
  <div class="placeholder-content">
    <p>Category management feature coming soon...</p>
    <p>This will include:</p>
    <ul>
      <li>Create and edit categories</li>
      <li>Organize category hierarchy</li>
      <li>Manage category permissions</li>
      <li>Category analytics</li>
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
    color: #1f2937;
    font-size: 1.5rem;
    font-weight: 600;
  }
  
  .manager-header p {
    margin: 0;
    color: #6b7280;
  }
  
  .placeholder-content {
    background: #f9fafb;
    border: 1px solid #e2e8f0;
    border-radius: 8px;
    padding: 2rem;
    text-align: center;
  }
  
  .placeholder-content p {
    margin: 0 0 1rem 0;
    color: #6b7280;
  }
  
  .placeholder-content ul {
    margin: 1rem 0 0 0;
    text-align: left;
    display: inline-block;
    color: #6b7280;
  }
</style>