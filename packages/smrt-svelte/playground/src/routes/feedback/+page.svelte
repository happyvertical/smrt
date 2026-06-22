<script lang="ts">
import { ConfirmDialog, Modal, ProgressBar } from '@happyvertical/smrt-ui';

// Dialog state
let showBasicDialog = $state(false);
let showDestructiveDialog = $state(false);
let showLoadingDialog = $state(false);
let isLoading = $state(false);

// Modal state
let showBasicModal = $state(false);
let showLargeModal = $state(false);
let showFooterModal = $state(false);

function handleConfirm() {
  showBasicDialog = false;
  alert('Confirmed!');
}

function handleDestructiveConfirm() {
  showDestructiveDialog = false;
  alert('Item deleted!');
}

async function handleLoadingConfirm() {
  isLoading = true;
  await new Promise((resolve) => setTimeout(resolve, 2000));
  isLoading = false;
  showLoadingDialog = false;
  alert('Operation completed!');
}
</script>

<h1>Feedback Components</h1>
<p class="description">Components for user feedback and status indicators.</p>

<section>
  <h2>ProgressBar</h2>
  <p class="section-desc">Visual progress indicator with status-based coloring.</p>

  <h3>Basic Progress</h3>
  <div class="demo-col">
    <div class="progress-demo">
      <span class="progress-label">0%</span>
      <ProgressBar value={0} />
    </div>
    <div class="progress-demo">
      <span class="progress-label">25%</span>
      <ProgressBar value={25} />
    </div>
    <div class="progress-demo">
      <span class="progress-label">50%</span>
      <ProgressBar value={50} />
    </div>
    <div class="progress-demo">
      <span class="progress-label">75%</span>
      <ProgressBar value={75} />
    </div>
    <div class="progress-demo">
      <span class="progress-label">100%</span>
      <ProgressBar value={100} />
    </div>
  </div>

  <h3>Auto Status (Budget Tracking)</h3>
  <p class="hint">Colors automatically based on percentage: green (0-75%), yellow (75-90%), red (90%+)</p>
  <div class="demo-col">
    <div class="progress-demo">
      <ProgressBar value={45} max={100} showLabel />
    </div>
    <div class="progress-demo">
      <ProgressBar value={78} max={100} showLabel />
    </div>
    <div class="progress-demo">
      <ProgressBar value={95} max={100} showLabel />
    </div>
    <div class="progress-demo">
      <ProgressBar value={115} max={100} showLabel />
    </div>
  </div>

  <h3>With Value Display</h3>
  <div class="demo-col">
    <ProgressBar value={7500} max={10000} showValue />
    <ProgressBar value={12500} max={10000} showValue />
  </div>

  <h3>Custom Status</h3>
  <div class="demo-col">
    <div class="progress-demo">
      <span class="progress-label">Healthy</span>
      <ProgressBar value={60} status="healthy" />
    </div>
    <div class="progress-demo">
      <span class="progress-label">Warning</span>
      <ProgressBar value={60} status="warning" />
    </div>
    <div class="progress-demo">
      <span class="progress-label">Critical</span>
      <ProgressBar value={60} status="critical" />
    </div>
    <div class="progress-demo">
      <span class="progress-label">Over</span>
      <ProgressBar value={60} status="over" />
    </div>
  </div>

  <h3>Sizes</h3>
  <div class="demo-col">
    <div class="progress-demo">
      <span class="progress-label">sm</span>
      <ProgressBar value={65} size="sm" />
    </div>
    <div class="progress-demo">
      <span class="progress-label">md</span>
      <ProgressBar value={65} size="md" />
    </div>
    <div class="progress-demo">
      <span class="progress-label">lg</span>
      <ProgressBar value={65} size="lg" />
    </div>
  </div>
</section>

<section>
  <h2>ConfirmDialog</h2>
  <p class="section-desc">Modal confirmation dialog for important actions.</p>

  <h3>Basic Confirmation</h3>
  <div class="demo-box">
    <button class="btn-primary" onclick={() => showBasicDialog = true}>
      Open Confirm Dialog
    </button>
  </div>

  <ConfirmDialog
    open={showBasicDialog}
    title="Confirm Action"
    message="Are you sure you want to proceed with this action? This will apply the changes immediately."
    onconfirm={handleConfirm}
    oncancel={() => showBasicDialog = false}
  />

  <h3>Destructive Action</h3>
  <div class="demo-box">
    <button class="btn-danger" onclick={() => showDestructiveDialog = true}>
      Delete Item
    </button>
  </div>

  <ConfirmDialog
    open={showDestructiveDialog}
    title="Delete Item"
    message="Are you sure you want to delete this item? This action cannot be undone."
    confirmLabel="Delete"
    destructive
    onconfirm={handleDestructiveConfirm}
    oncancel={() => showDestructiveDialog = false}
  />

  <h3>With Loading State</h3>
  <div class="demo-box">
    <button class="btn-primary" onclick={() => showLoadingDialog = true}>
      Submit with Loading
    </button>
  </div>

  <ConfirmDialog
    open={showLoadingDialog}
    title="Submit Form"
    message="This will submit your form data to the server. Continue?"
    confirmLabel="Submit"
    loading={isLoading}
    onconfirm={handleLoadingConfirm}
    oncancel={() => showLoadingDialog = false}
  />
</section>

<section>
  <h2>Modal</h2>
  <p class="section-desc">Accessible dialog component using native dialog element.</p>

  <h3>Basic Modal</h3>
  <div class="demo-box">
    <button class="btn-primary" onclick={() => showBasicModal = true}>
      Open Modal
    </button>
  </div>

  <Modal
    bind:open={showBasicModal}
    title="Basic Modal"
  >
    {#snippet children()}
      <p>This is a basic modal with a title and close button.</p>
      <p>Click outside or press Escape to close.</p>
    {/snippet}
  </Modal>

  <h3>Large Modal with Footer</h3>
  <div class="demo-box">
    <button class="btn-primary" onclick={() => showLargeModal = true}>
      Open Large Modal
    </button>
  </div>

  <Modal
    bind:open={showLargeModal}
    title="Large Modal"
    size="lg"
  >
    {#snippet children()}
      <p>This is a larger modal with more content space.</p>
      <p>It's great for forms, detailed information, or complex interactions.</p>
      <p>Lorem ipsum dolor sit amet, consectetur adipiscing elit. Sed do eiusmod tempor incididunt ut labore et dolore magna aliqua.</p>
    {/snippet}
    {#snippet footer()}
      <button class="btn-secondary" onclick={() => showLargeModal = false}>Cancel</button>
      <button class="btn-primary" onclick={() => showLargeModal = false}>Save Changes</button>
    {/snippet}
  </Modal>

  <h3>Size Variants</h3>
  <div class="demo-box size-demos">
    <button class="btn-secondary" onclick={() => {}}>SM (24rem)</button>
    <button class="btn-secondary" onclick={() => {}}>MD (32rem)</button>
    <button class="btn-secondary" onclick={() => {}}>LG (48rem)</button>
    <button class="btn-secondary" onclick={() => {}}>XL (64rem)</button>
    <button class="btn-secondary" onclick={() => {}}>Full</button>
  </div>
</section>

<section>
  <h2>Props Reference</h2>

  <h3>ProgressBar</h3>
  <table class="props-table">
    <thead>
      <tr><th>Prop</th><th>Type</th><th>Default</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>value</code></td><td><code>number</code></td><td>required</td><td>Current value</td></tr>
      <tr><td><code>max</code></td><td><code>number</code></td><td><code>100</code></td><td>Maximum value</td></tr>
      <tr><td><code>status</code></td><td><code>'default' | 'healthy' | 'warning' | 'critical' | 'over'</code></td><td><code>'default'</code></td><td>Color status (auto if default)</td></tr>
      <tr><td><code>showLabel</code></td><td><code>boolean</code></td><td><code>false</code></td><td>Show percentage</td></tr>
      <tr><td><code>showValue</code></td><td><code>boolean</code></td><td><code>false</code></td><td>Show value/max</td></tr>
      <tr><td><code>label</code></td><td><code>string</code></td><td>-</td><td>Custom label text</td></tr>
      <tr><td><code>size</code></td><td><code>'sm' | 'md' | 'lg'</code></td><td><code>'md'</code></td><td>Size variant</td></tr>
    </tbody>
  </table>

  <h3>ConfirmDialog</h3>
  <table class="props-table">
    <thead>
      <tr><th>Prop</th><th>Type</th><th>Default</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>open</code></td><td><code>boolean</code></td><td>required</td><td>Dialog visibility</td></tr>
      <tr><td><code>title</code></td><td><code>string</code></td><td>required</td><td>Dialog title</td></tr>
      <tr><td><code>message</code></td><td><code>string</code></td><td>required</td><td>Dialog message</td></tr>
      <tr><td><code>confirmLabel</code></td><td><code>string</code></td><td><code>'Confirm'</code></td><td>Confirm button text</td></tr>
      <tr><td><code>cancelLabel</code></td><td><code>string</code></td><td><code>'Cancel'</code></td><td>Cancel button text</td></tr>
      <tr><td><code>destructive</code></td><td><code>boolean</code></td><td><code>false</code></td><td>Red confirm button</td></tr>
      <tr><td><code>loading</code></td><td><code>boolean</code></td><td><code>false</code></td><td>Loading state</td></tr>
      <tr><td><code>onconfirm</code></td><td><code>() => void</code></td><td>-</td><td>Confirm handler</td></tr>
      <tr><td><code>oncancel</code></td><td><code>() => void</code></td><td>-</td><td>Cancel handler</td></tr>
    </tbody>
  </table>

  <h3>Modal</h3>
  <table class="props-table">
    <thead>
      <tr><th>Prop</th><th>Type</th><th>Default</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>open</code></td><td><code>boolean</code></td><td><code>false</code></td><td>Dialog visibility (bindable)</td></tr>
      <tr><td><code>title</code></td><td><code>string</code></td><td>-</td><td>Modal title</td></tr>
      <tr><td><code>size</code></td><td><code>'sm' | 'md' | 'lg' | 'xl' | 'full'</code></td><td><code>'md'</code></td><td>Size variant</td></tr>
      <tr><td><code>closeOnBackdrop</code></td><td><code>boolean</code></td><td><code>true</code></td><td>Close on backdrop click</td></tr>
      <tr><td><code>closeOnEscape</code></td><td><code>boolean</code></td><td><code>true</code></td><td>Close on Escape key</td></tr>
      <tr><td><code>showClose</code></td><td><code>boolean</code></td><td><code>true</code></td><td>Show close button</td></tr>
      <tr><td><code>onClose</code></td><td><code>() => void</code></td><td>-</td><td>Close callback</td></tr>
      <tr><td><code>header</code></td><td><code>Snippet</code></td><td>-</td><td>Custom header</td></tr>
      <tr><td><code>footer</code></td><td><code>Snippet</code></td><td>-</td><td>Custom footer</td></tr>
      <tr><td><code>children</code></td><td><code>Snippet</code></td><td>-</td><td>Modal content</td></tr>
    </tbody>
  </table>
</section>

<style>
  h1 {
    font-size: 1.75rem;
    margin-bottom: 8px;
  }

  .description {
    color: var(--smrt-color-on-surface-variant);
    margin-bottom: 32px;
  }

  section {
    margin-bottom: 48px;
  }

  h2 {
    font-size: 1.25rem;
    color: var(--smrt-color-on-surface);
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  h3 {
    font-size: 0.875rem;
    color: var(--smrt-color-on-surface-variant);
    margin: 24px 0 12px;
    font-weight: 500;
  }

  .section-desc {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.875rem;
    margin-bottom: 16px;
  }

  .hint {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant);
    margin-bottom: 12px;
  }

  .demo-box {
    background: var(--smrt-color-surface-container);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-md, 8px);
    padding: 16px;
    margin-bottom: 16px;
  }

  .demo-col {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .progress-demo {
    display: flex;
    align-items: center;
    gap: 16px;
  }

  .progress-demo .progress-label {
    width: 60px;
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant);
    text-align: right;
  }

  .progress-demo :global(.progress-container) {
    flex: 1;
  }

  .btn-primary {
    padding: 8px 16px;
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    border: none;
    border-radius: var(--smrt-radius-md, 8px);
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }

  .btn-primary:hover {
    background: var(--smrt-color-primary);
  }

  .btn-danger {
    padding: 8px 16px;
    background: var(--smrt-color-error);
    color: var(--smrt-color-on-error);
    border: none;
    border-radius: var(--smrt-radius-md, 8px);
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }

  .btn-danger:hover {
    background: var(--smrt-color-error);
  }

  .btn-secondary {
    padding: 8px 16px;
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-md, 8px);
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }

  .btn-secondary:hover {
    background: var(--smrt-color-surface-container-high);
  }

  .size-demos {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }

  .props-table {
    width: 100%;
    border-collapse: collapse;
    font-size: 0.875rem;
    margin-top: 8px;
    margin-bottom: 24px;
  }

  .props-table th,
  .props-table td {
    text-align: left;
    padding: 8px 12px;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }

  .props-table th {
    background: var(--smrt-color-surface-container);
    font-weight: 500;
  }

  code {
    background: var(--smrt-color-surface-container);
    padding: 2px 6px;
    border-radius: var(--smrt-radius-sm, 4px);
    font-size: 0.8rem;
  }
</style>
