<script lang="ts">
import { Icon, ripple } from '@happyvertical/smrt-svelte';
</script>

<h1>Foundation & Infrastructure</h1>

<section>
  <h2>Ripple Effect</h2>
  <div class="demo-grid">
    <button use:ripple class="btn-primary">Primary Button</button>
    <button use:ripple class="btn-secondary">Secondary Button</button>
    <div use:ripple class="surface">Click me (Surface)</div>
  </div>
</section>

<section>
  <h2>Icons (M3 Presets)</h2>
  <div class="icon-grid">
    <div class="icon-item"><Icon name="menu" /> <span>menu</span></div>
    <div class="icon-item"><Icon name="search" /> <span>search</span></div>
    <div class="icon-item"><Icon name="close" /> <span>close</span></div>
    <div class="icon-item"><Icon name="check" /> <span>check</span></div>
    <div class="icon-item"><Icon name="add" /> <span>add</span></div>
    <div class="icon-item"><Icon name="chevron-right" /> <span>chevron-right</span></div>
  </div>
</section>

<style>
  section {
    margin-bottom: 40px;
  }
  h2 {
    font-size: 1.25rem;
    margin-bottom: 16px;
    color: var(--md-sys-color-primary);
  }
  .demo-grid {
    display: flex;
    gap: 16px;
  }
  .btn-primary {
    background: var(--md-sys-color-primary);
    color: var(--md-sys-color-on-primary);
    border: none;
    padding: 10px 20px;
    border-radius: 20px;
    cursor: pointer;
  }
  .btn-secondary {
    background: var(--md-sys-color-secondary-container);
    color: var(--md-sys-color-on-secondary-container);
    border: none;
    padding: 10px 20px;
    border-radius: 20px;
    cursor: pointer;
  }
  .surface {
    width: 150px;
    height: 100px;
    background: var(--md-sys-color-surface-container);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 12px;
    cursor: pointer;
  }
  .icon-grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(100px, 1fr));
    gap: 16px;
  }
  .icon-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 16px;
    background: var(--md-sys-color-surface-container-low);
    border-radius: 8px;
  }
  .icon-item span {
    font-size: 0.75rem;
  }
</style>
