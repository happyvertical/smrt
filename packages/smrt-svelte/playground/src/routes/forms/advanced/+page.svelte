<script lang="ts">
import type { AddressValue, MeasurementUnit } from '@happyvertical/smrt-svelte';
import {
  AddressInput,
  DateRangeInput,
  MeasurementInput,
  MoneyInput,
} from '@happyvertical/smrt-svelte';

// State for demos
let dateStart = $state('');
let dateEnd = $state('');

let address = $state<Partial<AddressValue>>({
  street: '',
  city: '',
  province: 'AB',
  postalCode: '',
  country: 'CA',
});

let moneyValue = $state<number | null>(null);
let moneyValueCents = $state<number | null>(15000); // $150.00

let measureValue = $state<number | null>(12);
let measureUnit = $state<MeasurementUnit>('ft');
</script>

<h1>Advanced Form Inputs</h1>
<p class="description">Specialized form inputs for complex data types with voice input support.</p>

<section>
  <h2>DateRangeInput</h2>
  <p class="section-desc">Date range picker with natural language voice input support (e.g., "next week" or "from Monday to Friday").</p>

  <div class="demo-box">
    <DateRangeInput
      name="dateRange"
      label="Project Duration"
      description="When the project should run"
      bind:startDate={dateStart}
      bind:endDate={dateEnd}
    />

    <div class="value-display">
      <span>Start: <code>{dateStart || 'not set'}</code></span>
      <span>End: <code>{dateEnd || 'not set'}</code></span>
    </div>
  </div>

  <h3>With Constraints</h3>
  <div class="demo-box">
    <DateRangeInput
      name="futureRange"
      label="Booking Window"
      description="Available dates for booking"
      minDate={new Date().toISOString().split('T')[0]}
      required
    />
  </div>
</section>

<section>
  <h2>AddressInput</h2>
  <p class="section-desc">Full address input with province/country selectors.</p>

  <div class="demo-box">
    <AddressInput
      name="address"
      label="Shipping Address"
      description="Where to deliver the package"
      bind:value={address}
    />

    <div class="value-display">
      <pre>{JSON.stringify(address, null, 2)}</pre>
    </div>
  </div>

  <h3>Partial Address (Select Fields)</h3>
  <div class="demo-box">
    <AddressInput
      name="partialAddress"
      label="City & Province Only"
      fields={['city', 'province']}
    />
  </div>
</section>

<section>
  <h2>MoneyInput</h2>
  <p class="section-desc">Currency input that stores value in cents for precision. Voice input supports natural phrases like "fifty dollars" or "$25.50".</p>

  <div class="demo-box">
    <MoneyInput
      name="amount"
      label="Invoice Amount"
      description="The total amount to charge"
      bind:value={moneyValue}
      currency="CAD"
    />

    <div class="value-display">
      <span>Value (cents): <code>{moneyValue ?? 'null'}</code></span>
      <span>Display: <code>{moneyValue ? `$${(moneyValue / 100).toFixed(2)}` : 'not set'}</code></span>
    </div>
  </div>

  <h3>With Initial Value</h3>
  <div class="demo-box">
    <MoneyInput
      name="preset"
      label="Pre-filled Amount"
      bind:value={moneyValueCents}
      currency="USD"
    />
    <p class="hint">Pre-set to $150.00 USD</p>
  </div>

  <h3>With Constraints</h3>
  <div class="demo-box">
    <MoneyInput
      name="constrained"
      label="Payment Amount"
      min={1000}
      max={1000000}
      placeholder="10.00 - 10,000.00"
      required
    />
    <p class="hint">Min: $10.00, Max: $10,000.00</p>
  </div>
</section>

<section>
  <h2>MeasurementInput</h2>
  <p class="section-desc">Numeric input with unit selector. Supports natural language like "twelve feet" or "2.5 meters".</p>

  <div class="demo-box">
    <MeasurementInput
      name="length"
      label="Room Length"
      description="The length of the room"
      bind:value={measureValue}
      bind:unit={measureUnit}
      units={['ft', 'in', 'm', 'cm']}
    />

    <div class="value-display">
      <span>Value: <code>{measureValue ?? 'null'}</code></span>
      <span>Unit: <code>{measureUnit}</code></span>
    </div>
  </div>

  <h3>Limited Units</h3>
  <div class="demo-box">
    <MeasurementInput
      name="fabric"
      label="Fabric Length"
      units={['yd', 'ft', 'in']}
      placeholder="Enter length"
    />
  </div>

  <h3>With Constraints</h3>
  <div class="demo-box">
    <MeasurementInput
      name="height"
      label="Ceiling Height"
      min={6}
      max={30}
      step={0.5}
      units={['ft', 'm']}
      required
    />
    <p class="hint">Min: 6, Max: 30, Step: 0.5</p>
  </div>
</section>

<section>
  <h2>Props Reference</h2>

  <h3>DateRangeInput</h3>
  <table class="props-table">
    <thead>
      <tr><th>Prop</th><th>Type</th><th>Default</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>name</code></td><td><code>string</code></td><td>required</td><td>Field name</td></tr>
      <tr><td><code>label</code></td><td><code>string</code></td><td>-</td><td>Field label</td></tr>
      <tr><td><code>startDate</code></td><td><code>string</code></td><td><code>''</code></td><td>Start date (YYYY-MM-DD)</td></tr>
      <tr><td><code>endDate</code></td><td><code>string</code></td><td><code>''</code></td><td>End date (YYYY-MM-DD)</td></tr>
      <tr><td><code>minDate</code></td><td><code>string</code></td><td>-</td><td>Minimum selectable date</td></tr>
      <tr><td><code>maxDate</code></td><td><code>string</code></td><td>-</td><td>Maximum selectable date</td></tr>
      <tr><td><code>required</code></td><td><code>boolean</code></td><td><code>false</code></td><td>Required field</td></tr>
    </tbody>
  </table>

  <h3>AddressInput</h3>
  <table class="props-table">
    <thead>
      <tr><th>Prop</th><th>Type</th><th>Default</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>name</code></td><td><code>string</code></td><td>required</td><td>Field name prefix</td></tr>
      <tr><td><code>label</code></td><td><code>string</code></td><td>-</td><td>Field label</td></tr>
             <tr><td><code>value</code></td><td><code>Partial&lt;AddressValue&gt;</code></td><td><code>{'{}'}</code></td><td>Address value object</td></tr>      <tr><td><code>fields</code></td><td><code>AddressField[]</code></td><td>all fields</td><td>Which fields to show</td></tr>
      <tr><td><code>countries</code></td><td><code>SelectOption[]</code></td><td>CA, US</td><td>Country options</td></tr>
      <tr><td><code>provinces</code></td><td><code>SelectOption[]</code></td><td>Canadian/US</td><td>Province/state options</td></tr>
    </tbody>
  </table>

  <h3>MoneyInput</h3>
  <table class="props-table">
    <thead>
      <tr><th>Prop</th><th>Type</th><th>Default</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>name</code></td><td><code>string</code></td><td>required</td><td>Field name</td></tr>
      <tr><td><code>label</code></td><td><code>string</code></td><td>-</td><td>Field label</td></tr>
      <tr><td><code>value</code></td><td><code>number | null</code></td><td><code>null</code></td><td>Value in cents</td></tr>
      <tr><td><code>currency</code></td><td><code>'CAD' | 'USD'</code></td><td><code>'CAD'</code></td><td>Currency code</td></tr>
      <tr><td><code>min</code></td><td><code>number</code></td><td>-</td><td>Minimum (cents)</td></tr>
      <tr><td><code>max</code></td><td><code>number</code></td><td>-</td><td>Maximum (cents)</td></tr>
    </tbody>
  </table>

  <h3>MeasurementInput</h3>
  <table class="props-table">
    <thead>
      <tr><th>Prop</th><th>Type</th><th>Default</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>name</code></td><td><code>string</code></td><td>required</td><td>Field name</td></tr>
      <tr><td><code>label</code></td><td><code>string</code></td><td>-</td><td>Field label</td></tr>
      <tr><td><code>value</code></td><td><code>number | null</code></td><td><code>null</code></td><td>Numeric value</td></tr>
      <tr><td><code>unit</code></td><td><code>MeasurementUnit</code></td><td><code>'ft'</code></td><td>Selected unit</td></tr>
      <tr><td><code>units</code></td><td><code>MeasurementUnit[]</code></td><td>all</td><td>Available units</td></tr>
      <tr><td><code>min</code></td><td><code>number</code></td><td>-</td><td>Minimum value</td></tr>
      <tr><td><code>max</code></td><td><code>number</code></td><td>-</td><td>Maximum value</td></tr>
      <tr><td><code>step</code></td><td><code>number</code></td><td>-</td><td>Step increment</td></tr>
    </tbody>
  </table>

  <h3>MeasurementUnit Type</h3>
  <table class="props-table">
    <thead>
      <tr><th>Value</th><th>Description</th></tr>
    </thead>
    <tbody>
      <tr><td><code>'ft'</code></td><td>Feet</td></tr>
      <tr><td><code>'in'</code></td><td>Inches</td></tr>
      <tr><td><code>'m'</code></td><td>Meters</td></tr>
      <tr><td><code>'cm'</code></td><td>Centimeters</td></tr>
      <tr><td><code>'mm'</code></td><td>Millimeters</td></tr>
      <tr><td><code>'yd'</code></td><td>Yards</td></tr>
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

  .demo-box {
    background: var(--smrt-color-surface-container);
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 8px;
    padding: 20px;
    margin-bottom: 16px;
  }

  .value-display {
    margin-top: 16px;
    padding-top: 16px;
    border-top: 1px dashed var(--smrt-color-outline-variant);
    display: flex;
    gap: 24px;
    font-size: 0.875rem;
    color: var(--smrt-color-on-surface-variant);
  }

  .value-display pre {
    margin: 0;
    font-size: 0.75rem;
    background: var(--smrt-color-surface-container);
    padding: 12px;
    border-radius: 4px;
    overflow-x: auto;
  }

  .hint {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant);
    margin-top: 8px;
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
    border-radius: 4px;
    font-size: 0.8rem;
  }
</style>
