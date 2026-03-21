<script lang="ts">
import ContentGovernanceManager from '../../svelte/components/ContentGovernanceManager.svelte';
</script>

<div class="page">
  <div class="page-header">
    <h1>🛡️ Content Governance</h1>
    <p>Manage review policies, editorial profiles, and content type governance assignments.</p>
  </div>

  <div class="page-card">
    <ContentGovernanceManager />
  </div>
</div>

<style>
  .page {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  .page-header {
    text-align: center;
    padding: 1rem 0;
  }

  .page-header h1 {
    margin: 0 0 0.5rem 0;
    font-size: 2rem;
    font-weight: 800;
    color: var(--smrt-color-on-background, #1a1c1e);
  }

  .page-header p {
    margin: 0;
    color: var(--smrt-color-on-surface-variant, #43474e);
    font-size: 1.05rem;
    max-width: 600px;
    margin: 0 auto;
  }

  .page-card {
    background: var(--smrt-color-surface, #fff);
    border: 1px solid var(--smrt-color-outline-variant, #c4c6d0);
    border-radius: 1rem;
    padding: 1.5rem;
    box-shadow: 0 2px 8px rgba(0,0,0,0.04);
  }
</style>
