<script lang="ts">
import { ConfirmDialog, ProgressBar } from '@happyvertical/smrt-svelte';

// Dialog state
let showBasicDialog = $state(false);
let showDestructiveDialog = $state(false);
let showLoadingDialog = $state(false);
let isLoading = $state(false);

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
</section>

<style>
  h1 {
    font-size: 1.75rem;
    margin-bottom: 8px;
  }

  .description {
    color: #666;
    margin-bottom: 32px;
  }

  section {
    margin-bottom: 48px;
  }

  h2 {
    font-size: 1.25rem;
    color: #333;
    margin-bottom: 8px;
    padding-bottom: 8px;
    border-bottom: 1px solid #eee;
  }

  h3 {
    font-size: 0.875rem;
    color: #666;
    margin: 24px 0 12px;
    font-weight: 500;
  }

  .section-desc {
    color: #666;
    font-size: 0.875rem;
    margin-bottom: 16px;
  }

  .hint {
    font-size: 0.75rem;
    color: #888;
    margin-bottom: 12px;
  }

  .demo-box {
    background: #f9fafb;
    border: 1px solid #e5e7eb;
    border-radius: 8px;
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
    color: #666;
    text-align: right;
  }

  .progress-demo :global(.progress-container) {
    flex: 1;
  }

  .btn-primary {
    padding: 8px 16px;
    background: #3b82f6;
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }

  .btn-primary:hover {
    background: #2563eb;
  }

  .btn-danger {
    padding: 8px 16px;
    background: #dc2626;
    color: white;
    border: none;
    border-radius: 6px;
    font-size: 0.875rem;
    font-weight: 500;
    cursor: pointer;
  }

  .btn-danger:hover {
    background: #b91c1c;
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
    border-bottom: 1px solid #eee;
  }

  .props-table th {
    background: #f9f9f9;
    font-weight: 500;
  }

  code {
    background: #f3f4f6;
    padding: 2px 6px;
    border-radius: 4px;
    font-size: 0.8rem;
  }
</style>
