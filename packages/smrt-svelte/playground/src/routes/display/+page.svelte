<script lang="ts">
import {
  ConfidenceBadge,
  CurrencyDisplay,
  DateDisplay,
  StatusBadge,
} from '@happyvertical/smrt-ui';

// Sample dates for DateDisplay
const now = new Date();
const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
const lastWeek = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
const nextWeek = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
</script>

<h1>Display Components</h1>
<p class="description">Read-only presentation components for formatting and displaying data.</p>

<section>
  <h2>ConfidenceBadge</h2>
  <p class="section-desc">Shows AI confidence levels with color-coded visual indicators.</p>

  <div class="demo-row">
    <div class="demo-item">
      <ConfidenceBadge confidence={95} />
      <span class="label">High (95%)</span>
    </div>
    <div class="demo-item">
      <ConfidenceBadge confidence={65} />
      <span class="label">Medium (65%)</span>
    </div>
    <div class="demo-item">
      <ConfidenceBadge confidence={30} />
      <span class="label">Low (30%)</span>
    </div>
  </div>

  <h3>Sizes</h3>
  <div class="demo-row">
    <div class="demo-item">
      <ConfidenceBadge confidence={85} size="sm" />
      <span class="label">sm</span>
    </div>
    <div class="demo-item">
      <ConfidenceBadge confidence={85} size="md" />
      <span class="label">md</span>
    </div>
    <div class="demo-item">
      <ConfidenceBadge confidence={85} size="lg" />
      <span class="label">lg</span>
    </div>
  </div>
</section>

<section>
  <h2>CurrencyDisplay</h2>
  <p class="section-desc">Formats monetary values with proper locale formatting. Amounts are in cents.</p>

  <div class="demo-col">
    <div class="demo-row">
      <div class="demo-item">
        <CurrencyDisplay amount={12500} />
        <span class="label">$125.00 CAD</span>
      </div>
      <div class="demo-item">
        <CurrencyDisplay amount={9999} currency="USD" />
        <span class="label">$99.99 USD</span>
      </div>
    </div>
  </div>

  <h3>Highlighting</h3>
  <div class="demo-row">
    <div class="demo-item">
      <CurrencyDisplay amount={5000} highlightPositive />
      <span class="label">Positive</span>
    </div>
    <div class="demo-item">
      <CurrencyDisplay amount={-2500} highlightNegative />
      <span class="label">Negative</span>
    </div>
    <div class="demo-item">
      <CurrencyDisplay amount={7500} showSign />
      <span class="label">With Sign</span>
    </div>
  </div>

  <h3>Sizes</h3>
  <div class="demo-row">
    <div class="demo-item">
      <CurrencyDisplay amount={15000} size="sm" />
      <span class="label">sm</span>
    </div>
    <div class="demo-item">
      <CurrencyDisplay amount={15000} size="md" />
      <span class="label">md</span>
    </div>
    <div class="demo-item">
      <CurrencyDisplay amount={15000} size="lg" />
      <span class="label">lg</span>
    </div>
  </div>
</section>

<section>
  <h2>DateDisplay</h2>
  <p class="section-desc">Formats and displays dates in various formats including relative time.</p>

  <h3>Formats</h3>
  <div class="demo-col">
    <div class="demo-row">
      <div class="demo-item">
        <DateDisplay date={now} format="short" />
        <span class="label">short</span>
      </div>
      <div class="demo-item">
        <DateDisplay date={now} format="medium" />
        <span class="label">medium</span>
      </div>
      <div class="demo-item">
        <DateDisplay date={now} format="long" />
        <span class="label">long</span>
      </div>
    </div>
  </div>

  <h3>Relative Time</h3>
  <div class="demo-col">
    <div class="demo-row">
      <div class="demo-item">
        <DateDisplay date={now} format="relative" />
        <span class="label">now</span>
      </div>
      <div class="demo-item">
        <DateDisplay date={yesterday} format="relative" />
        <span class="label">yesterday</span>
      </div>
      <div class="demo-item">
        <DateDisplay date={lastWeek} format="relative" />
        <span class="label">last week</span>
      </div>
      <div class="demo-item">
        <DateDisplay date={nextWeek} format="relative" />
        <span class="label">next week</span>
      </div>
    </div>
  </div>

  <h3>With Time</h3>
  <div class="demo-row">
    <div class="demo-item">
      <DateDisplay date={now} format="medium" showTime />
      <span class="label">showTime</span>
    </div>
  </div>

  <h3>Fallback</h3>
  <div class="demo-row">
    <div class="demo-item">
      <DateDisplay date={null} fallback="Not set" />
      <span class="label">null date</span>
    </div>
  </div>
</section>

<section>
  <h2>StatusBadge</h2>
  <p class="section-desc">Status indicator with pre-defined color schemes for different domains.</p>

  <h3>Default Status</h3>
  <div class="demo-row">
    <StatusBadge status="active" />
    <StatusBadge status="inactive" />
    <StatusBadge status="pending" />
    <StatusBadge status="error" />
    <StatusBadge status="success" />
    <StatusBadge status="warning" />
  </div>

  <h3>Invoice Status</h3>
  <div class="demo-row">
    <StatusBadge status="draft" type="invoice" />
    <StatusBadge status="sent" type="invoice" />
    <StatusBadge status="viewed" type="invoice" />
    <StatusBadge status="paid" type="invoice" />
    <StatusBadge status="overdue" type="invoice" />
  </div>

  <h3>Project Status</h3>
  <div class="demo-row">
    <StatusBadge status="lead" type="project" />
    <StatusBadge status="quoted" type="project" />
    <StatusBadge status="active" type="project" />
    <StatusBadge status="on_hold" type="project" />
    <StatusBadge status="completed" type="project" />
  </div>

  <h3>Sizes</h3>
  <div class="demo-row">
    <div class="demo-item">
      <StatusBadge status="active" size="sm" />
      <span class="label">sm</span>
    </div>
    <div class="demo-item">
      <StatusBadge status="active" size="md" />
      <span class="label">md</span>
    </div>
    <div class="demo-item">
      <StatusBadge status="active" size="lg" />
      <span class="label">lg</span>
    </div>
  </div>

  <h3>Variants</h3>
  <div class="demo-row">
    <div class="demo-item">
      <StatusBadge status="active" variant="filled" />
      <span class="label">filled</span>
    </div>
    <div class="demo-item">
      <StatusBadge status="active" variant="outline" />
      <span class="label">outline</span>
    </div>
  </div>
</section>

<section>
  <h2>Props Reference</h2>

  <h3>ConfidenceBadge</h3>
  <table class="props-table">
    <thead>
      <tr><th>Prop</th><th>Type</th><th>Default</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>confidence</code></td><td><code>number</code></td><td>required</td><td>Value 0-100</td></tr>
      <tr><td><code>showPercent</code></td><td><code>boolean</code></td><td><code>true</code></td><td>Show percentage value</td></tr>
      <tr><td><code>size</code></td><td><code>'sm' | 'md' | 'lg'</code></td><td><code>'md'</code></td><td>Size variant</td></tr>
    </tbody>
  </table>

  <h3>CurrencyDisplay</h3>
  <table class="props-table">
    <thead>
      <tr><th>Prop</th><th>Type</th><th>Default</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>amount</code></td><td><code>number</code></td><td>required</td><td>Amount in cents</td></tr>
      <tr><td><code>currency</code></td><td><code>'CAD' | 'USD'</code></td><td><code>'CAD'</code></td><td>Currency code</td></tr>
      <tr><td><code>showSign</code></td><td><code>boolean</code></td><td><code>false</code></td><td>Show +/- sign</td></tr>
      <tr><td><code>highlightNegative</code></td><td><code>boolean</code></td><td><code>false</code></td><td>Red for negative</td></tr>
      <tr><td><code>highlightPositive</code></td><td><code>boolean</code></td><td><code>false</code></td><td>Green for positive</td></tr>
    </tbody>
  </table>

  <h3>DateDisplay</h3>
  <table class="props-table">
    <thead>
      <tr><th>Prop</th><th>Type</th><th>Default</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>date</code></td><td><code>Date | string | number | null</code></td><td>required</td><td>Date to display</td></tr>
      <tr><td><code>format</code></td><td><code>'short' | 'medium' | 'long' | 'relative'</code></td><td><code>'medium'</code></td><td>Display format</td></tr>
      <tr><td><code>fallback</code></td><td><code>string</code></td><td><code>'N/A'</code></td><td>Text when null</td></tr>
      <tr><td><code>showTime</code></td><td><code>boolean</code></td><td><code>false</code></td><td>Include time</td></tr>
    </tbody>
  </table>

  <h3>StatusBadge</h3>
  <table class="props-table">
    <thead>
      <tr><th>Prop</th><th>Type</th><th>Default</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>status</code></td><td><code>string</code></td><td>required</td><td>Status value</td></tr>
      <tr><td><code>type</code></td><td><code>'default' | 'invoice' | 'project' | 'expense' | 'time' | 'compliance' | 'estimate'</code></td><td><code>'default'</code></td><td>Color scheme</td></tr>
      <tr><td><code>size</code></td><td><code>'sm' | 'md' | 'lg'</code></td><td><code>'md'</code></td><td>Size</td></tr>
      <tr><td><code>variant</code></td><td><code>'filled' | 'outline'</code></td><td><code>'filled'</code></td><td>Visual style</td></tr>
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

  .demo-row {
    display: flex;
    align-items: center;
    gap: 24px;
    flex-wrap: wrap;
  }

  .demo-col {
    display: flex;
    flex-direction: column;
    gap: 16px;
  }

  .demo-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
  }

  .label {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant);
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
