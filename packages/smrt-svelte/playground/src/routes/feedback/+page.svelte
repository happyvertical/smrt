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
<p class="smrt-feedback-page__description" data-smrt-component="FeedbackPage">Components for user feedback and status indicators.</p>

<section>
  <h2>ProgressBar</h2>
  <p class="smrt-feedback-page__section-desc" data-smrt-part="description">Visual progress indicator with status-based coloring.</p>

  <h3>Basic Progress</h3>
  <div class="smrt-feedback-page__demo-col" data-smrt-part="group">
    <div class="smrt-feedback-page__progress-demo" data-smrt-part="indicator">
      <span class="smrt-feedback-page__progress-label" data-smrt-part="label">0%</span>
      <ProgressBar value={0} />
    </div>
    <div class="smrt-feedback-page__progress-demo" data-smrt-part="indicator">
      <span class="smrt-feedback-page__progress-label" data-smrt-part="label">25%</span>
      <ProgressBar value={25} />
    </div>
    <div class="smrt-feedback-page__progress-demo" data-smrt-part="indicator">
      <span class="smrt-feedback-page__progress-label" data-smrt-part="label">50%</span>
      <ProgressBar value={50} />
    </div>
    <div class="smrt-feedback-page__progress-demo" data-smrt-part="indicator">
      <span class="smrt-feedback-page__progress-label" data-smrt-part="label">75%</span>
      <ProgressBar value={75} />
    </div>
    <div class="smrt-feedback-page__progress-demo" data-smrt-part="indicator">
      <span class="smrt-feedback-page__progress-label" data-smrt-part="label">100%</span>
      <ProgressBar value={100} />
    </div>
  </div>

  <h3>Auto Status (Budget Tracking)</h3>
  <p class="smrt-feedback-page__hint" data-smrt-part="description">Colors automatically based on percentage: green (0-75%), yellow (75-90%), red (90%+)</p>
  <div class="smrt-feedback-page__demo-col" data-smrt-part="group">
    <div class="smrt-feedback-page__progress-demo" data-smrt-part="indicator">
      <ProgressBar value={45} max={100} showLabel />
    </div>
    <div class="smrt-feedback-page__progress-demo" data-smrt-part="indicator">
      <ProgressBar value={78} max={100} showLabel />
    </div>
    <div class="smrt-feedback-page__progress-demo" data-smrt-part="indicator">
      <ProgressBar value={95} max={100} showLabel />
    </div>
    <div class="smrt-feedback-page__progress-demo" data-smrt-part="indicator">
      <ProgressBar value={115} max={100} showLabel />
    </div>
  </div>

  <h3>With Value Display</h3>
  <div class="smrt-feedback-page__demo-col" data-smrt-part="group">
    <ProgressBar value={7500} max={10000} showValue />
    <ProgressBar value={12500} max={10000} showValue />
  </div>

  <h3>Custom Status</h3>
  <div class="smrt-feedback-page__demo-col" data-smrt-part="group">
    <div class="smrt-feedback-page__progress-demo" data-smrt-part="indicator">
      <span class="smrt-feedback-page__progress-label" data-smrt-part="label">Healthy</span>
      <ProgressBar value={60} status="healthy" />
    </div>
    <div class="smrt-feedback-page__progress-demo" data-smrt-part="indicator">
      <span class="smrt-feedback-page__progress-label" data-smrt-part="label">Warning</span>
      <ProgressBar value={60} status="warning" />
    </div>
    <div class="smrt-feedback-page__progress-demo" data-smrt-part="indicator">
      <span class="smrt-feedback-page__progress-label" data-smrt-part="label">Critical</span>
      <ProgressBar value={60} status="critical" />
    </div>
    <div class="smrt-feedback-page__progress-demo" data-smrt-part="indicator">
      <span class="smrt-feedback-page__progress-label" data-smrt-part="label">Over</span>
      <ProgressBar value={60} status="over" />
    </div>
  </div>

  <h3>Sizes</h3>
  <div class="smrt-feedback-page__demo-col" data-smrt-part="group">
    <div class="smrt-feedback-page__progress-demo" data-smrt-part="indicator">
      <span class="smrt-feedback-page__progress-label" data-smrt-part="label">sm</span>
      <ProgressBar value={65} size="sm" />
    </div>
    <div class="smrt-feedback-page__progress-demo" data-smrt-part="indicator">
      <span class="smrt-feedback-page__progress-label" data-smrt-part="label">md</span>
      <ProgressBar value={65} size="md" />
    </div>
    <div class="smrt-feedback-page__progress-demo" data-smrt-part="indicator">
      <span class="smrt-feedback-page__progress-label" data-smrt-part="label">lg</span>
      <ProgressBar value={65} size="lg" />
    </div>
  </div>
</section>

<section>
  <h2>ConfirmDialog</h2>
  <p class="smrt-feedback-page__section-desc" data-smrt-part="description">Modal confirmation dialog for important actions.</p>

  <h3>Basic Confirmation</h3>
  <div class="smrt-feedback-page__demo-box" data-smrt-part="group">
    <button class="smrt-feedback-page__btn-primary" onclick={() => showBasicDialog = true} data-smrt-part="trigger">
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
  <div class="smrt-feedback-page__demo-box" data-smrt-part="group">
    <button class="smrt-feedback-page__btn-danger" onclick={() => showDestructiveDialog = true} data-smrt-part="trigger">
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
  <div class="smrt-feedback-page__demo-box" data-smrt-part="group">
    <button class="smrt-feedback-page__btn-primary" onclick={() => showLoadingDialog = true} data-smrt-part="trigger">
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
  <p class="smrt-feedback-page__section-desc" data-smrt-part="description">Accessible dialog component using native dialog element.</p>

  <h3>Basic Modal</h3>
  <div class="smrt-feedback-page__demo-box" data-smrt-part="group">
    <button class="smrt-feedback-page__btn-primary" onclick={() => showBasicModal = true} data-smrt-part="trigger">
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
  <div class="smrt-feedback-page__demo-box" data-smrt-part="group">
    <button class="smrt-feedback-page__btn-primary" onclick={() => showLargeModal = true} data-smrt-part="trigger">
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
      <button class="smrt-feedback-page__btn-secondary" onclick={() => showLargeModal = false} data-smrt-part="trigger">Cancel</button>
      <button class="smrt-feedback-page__btn-primary" onclick={() => showLargeModal = false} data-smrt-part="trigger">Save Changes</button>
    {/snippet}
  </Modal>

  <h3>Size Variants</h3>
  <div class="smrt-feedback-page__demo-box smrt-feedback-page__size-demos" data-smrt-part="group">
    <button class="smrt-feedback-page__btn-secondary" onclick={() => {}} data-smrt-part="trigger">SM (24rem)</button>
    <button class="smrt-feedback-page__btn-secondary" onclick={() => {}} data-smrt-part="trigger">MD (32rem)</button>
    <button class="smrt-feedback-page__btn-secondary" onclick={() => {}} data-smrt-part="trigger">LG (48rem)</button>
    <button class="smrt-feedback-page__btn-secondary" onclick={() => {}} data-smrt-part="trigger">XL (64rem)</button>
    <button class="smrt-feedback-page__btn-secondary" onclick={() => {}} data-smrt-part="trigger">Full</button>
  </div>
</section>

<section>
  <h2>Props Reference</h2>

  <h3>ProgressBar</h3>
  <table class="smrt-feedback-page__props-table" data-smrt-part="table">
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
  <table class="smrt-feedback-page__props-table" data-smrt-part="table">
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
  <table class="smrt-feedback-page__props-table" data-smrt-part="table">
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
@layer smrt.reset, smrt.structure, smrt.theme;

@layer smrt.structure {
  h1 {
    margin-bottom: 8px;
  }
  .smrt-feedback-page__description {
    margin-bottom: 32px;
  }
  section {
    margin-bottom: 48px;
  }
  h2 {
    margin-bottom: 8px;
    padding-bottom: 8px;
  }
  h3 {
    margin: 24px 0 12px;
  }
  .smrt-feedback-page__section-desc {
    margin-bottom: 16px;
  }
  .smrt-feedback-page__hint {
    margin-bottom: 12px;
  }
  .smrt-feedback-page__demo-box {
    padding: 16px;
    margin-bottom: 16px;
  }
  .smrt-feedback-page__demo-col {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }
  .smrt-feedback-page__progress-demo {
    display: flex;
    align-items: center;
    gap: 16px;
  }
  .smrt-feedback-page__progress-demo .smrt-feedback-page__progress-label {
    width: 60px;
  }
  .smrt-feedback-page__progress-demo :global([data-smrt-component="ProgressBar"]) {
    flex: 1;
  }
  .smrt-feedback-page__btn-primary {
    padding: 8px 16px;
    cursor: pointer;
  }
  .smrt-feedback-page__btn-danger {
    padding: 8px 16px;
    cursor: pointer;
  }
  .smrt-feedback-page__btn-secondary {
    padding: 8px 16px;
    cursor: pointer;
  }
  .smrt-feedback-page__size-demos {
    display: flex;
    gap: 8px;
    flex-wrap: wrap;
  }
  .smrt-feedback-page__props-table {
    width: 100%;
    margin-top: 8px;
    margin-bottom: 24px;
  }
  .smrt-feedback-page__props-table th,
  .smrt-feedback-page__props-table td {
    padding: 8px 12px;
  }
  code {
    padding: 2px 6px;
  }
}

@layer smrt.theme {
  h1 {
    font-size: 1.75rem;
  }
  .smrt-feedback-page__description {
    color: var(--smrt-color-on-surface-variant);
  }
  h2 {
    font-size: 1.25rem;
    color: var(--smrt-color-on-surface);
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }
  h3 {
    font-size: 0.875rem;
    color: var(--smrt-color-on-surface-variant);
    font-weight: 500;
  }
  .smrt-feedback-page__section-desc {
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.875rem;
  }
  .smrt-feedback-page__hint {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-feedback-page__demo-box {
    background: var(--smrt-color-surface-container);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-md, 8px);
  }
  .smrt-feedback-page__progress-demo .smrt-feedback-page__progress-label {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant);
    text-align: right;
  }
  .smrt-feedback-page__btn-primary {
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    border: none;
    border-radius: var(--smrt-radius-md, 8px);
    font-size: 0.875rem;
    font-weight: 500;
  }
  .smrt-feedback-page__btn-primary:hover {
    background: var(--smrt-color-primary);
  }
  .smrt-feedback-page__btn-danger {
    background: var(--smrt-color-error);
    color: var(--smrt-color-on-error);
    border: none;
    border-radius: var(--smrt-radius-md, 8px);
    font-size: 0.875rem;
    font-weight: 500;
  }
  .smrt-feedback-page__btn-danger:hover {
    background: var(--smrt-color-error);
  }
  .smrt-feedback-page__btn-secondary {
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-on-surface);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-md, 8px);
    font-size: 0.875rem;
    font-weight: 500;
  }
  .smrt-feedback-page__btn-secondary:hover {
    background: var(--smrt-color-surface-container-high);
  }
  .smrt-feedback-page__props-table {
    border-collapse: collapse;
    font-size: 0.875rem;
  }
  .smrt-feedback-page__props-table th,
  .smrt-feedback-page__props-table td {
    text-align: left;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
  }
  .smrt-feedback-page__props-table th {
    background: var(--smrt-color-surface-container);
    font-weight: 500;
  }
  code {
    background: var(--smrt-color-surface-container);
    border-radius: var(--smrt-radius-sm, 4px);
    font-size: 0.8rem;
  }
}

</style>
