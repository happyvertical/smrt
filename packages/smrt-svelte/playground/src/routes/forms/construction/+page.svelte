<script lang="ts">
import type {
  AddressValue,
  DateRangeValue,
  MeasurementValue,
  SelectOption,
  STTAdapterType,
} from '@happyvertical/smrt-svelte';
import {
  AddressInput,
  DateRangeInput,
  Form,
  MeasurementInput,
  MoneyInput,
  NumberInput,
  SelectInput,
  TextInput,
} from '@happyvertical/smrt-svelte';

// Form state
let projectName = $state('');
let budget = $state<number | null>(null);
let address = $state<Partial<AddressValue>>({});
let projectDates = $state<DateRangeValue>({ startDate: '', endDate: '' });
let squareFootage = $state<number | null>(null);
let squareFootageUnit = $state<'ft' | 'in' | 'm' | 'cm'>('ft');
let ceilingHeight = $state<number | null>(null);
let ceilingHeightUnit = $state<'ft' | 'in' | 'm' | 'cm'>('ft');
let projectType = $state('');
let laborCost = $state<number | null>(null);
let materialCost = $state<number | null>(null);

let submittedData = $state<Record<string, unknown> | null>(null);

const projectTypes: SelectOption[] = [
  { value: 'residential', label: 'Residential' },
  { value: 'commercial', label: 'Commercial' },
  { value: 'industrial', label: 'Industrial' },
  { value: 'renovation', label: 'Renovation' },
  { value: 'addition', label: 'Addition' },
];

// Control panel state
let sttAdapter = $state<STTAdapterType>('whisper-wasm');

function handleSubmit(data: Record<string, unknown>) {
  submittedData = data;
  console.log('Form submitted:', data);
}

function clearForm() {
  projectName = '';
  budget = null;
  address = {};
  projectDates = { startDate: '', endDate: '' };
  squareFootage = null;
  ceilingHeight = null;
  projectType = '';
  laborCost = null;
  materialCost = null;
  submittedData = null;
}

// Calculate total cost
const totalCost = $derived((laborCost ?? 0) + (materialCost ?? 0));
</script>

<div class="page">
  <h1>Construction Project Form</h1>
  <p class="description">
    Specialized form components for construction project management.
    Toggle to <strong>Smrt</strong> mode to enable voice input.
  </p>

  <div class="control-panel">
    <h2>Settings</h2>
    <div class="control-row">
      <button type="button" class="clear-btn" onclick={clearForm}>
        Clear Form
      </button>
    </div>
  </div>

  <div class="demo-section">
    <h2>New Construction Project</h2>

    <Form onsubmit={handleSubmit} {sttAdapter}>
      <div class="form-section">
        <h3>Project Details</h3>

        <TextInput
          name="projectName"
          label="Project Name"
          description="Name of the construction project"
          placeholder="Enter project name..."
          bind:value={projectName}
          required
        />

        <SelectInput
          name="projectType"
          label="Project Type"
          description="Type of construction project"
          options={projectTypes}
          bind:value={projectType}
          required
        />

        <MoneyInput
          name="budget"
          label="Project Budget"
          description="Total budget for the project in dollars"
          bind:value={budget}
          currency="CAD"
          min={0}
        />
      </div>

      <div class="form-section">
        <h3>Job Site Location</h3>

        <AddressInput
          name="jobSite"
          label="Job Site Address"
          description="Physical address of the construction site"
          bind:value={address}
          fields={['street', 'city', 'province', 'postalCode']}
          required
        />
      </div>

      <div class="form-section">
        <h3>Project Timeline</h3>

        <DateRangeInput
          name="timeline"
          label="Project Duration"
          description="Start and end dates for the project"
          bind:startDate={projectDates.startDate}
          bind:endDate={projectDates.endDate}
          startPlaceholder="Project start"
          endPlaceholder="Project end"
          required
        />
      </div>

      <div class="form-section">
        <h3>Dimensions</h3>

        <div class="two-column">
          <MeasurementInput
            name="squareFootage"
            label="Square Footage"
            description="Total square footage of the project area"
            bind:value={squareFootage}
            bind:unit={squareFootageUnit}
            units={['ft', 'm']}
            min={0}
          />

          <MeasurementInput
            name="ceilingHeight"
            label="Ceiling Height"
            description="Height of ceilings in the project"
            bind:value={ceilingHeight}
            bind:unit={ceilingHeightUnit}
            units={['ft', 'in', 'm', 'cm']}
            min={0}
          />
        </div>
      </div>

      <div class="form-section">
        <h3>Cost Breakdown</h3>

        <div class="two-column">
          <MoneyInput
            name="laborCost"
            label="Labor Costs"
            description="Total cost for labor"
            bind:value={laborCost}
            currency="CAD"
            min={0}
          />

          <MoneyInput
            name="materialCost"
            label="Material Costs"
            description="Total cost for materials"
            bind:value={materialCost}
            currency="CAD"
            min={0}
          />
        </div>

        {#if totalCost > 0}
          <div class="total-cost">
            <span class="total-label">Total Cost:</span>
            <span class="total-value">${(totalCost / 100).toFixed(2)} CAD</span>
          </div>
        {/if}
      </div>

      <div class="form-actions">
        <button type="submit" class="submit-btn">
          Create Project
        </button>
      </div>
    </Form>

    {#if submittedData}
      <div class="submitted-data">
        <h3>Submitted Data:</h3>
        <pre>{JSON.stringify(submittedData, null, 2)}</pre>
      </div>
    {/if}
  </div>

  <div class="demo-section">
    <h2>Voice Commands</h2>
    <div class="examples">
      <p><strong>Try these voice commands in Smrt mode:</strong></p>
      <h4>Money</h4>
      <ul>
        <li>"one hundred fifty thousand dollars"</li>
        <li>"twenty five fifty" (for $25.50)</li>
        <li>"fifty bucks"</li>
      </ul>
      <h4>Address</h4>
      <ul>
        <li>"123 Main Street Calgary Alberta T2P 1A1"</li>
      </ul>
      <h4>Date Range</h4>
      <ul>
        <li>"from January 15th to March 30th"</li>
        <li>"between April 1st and December 31st"</li>
      </ul>
      <h4>Measurements</h4>
      <ul>
        <li>"twelve feet six inches"</li>
        <li>"two hundred fifty square feet"</li>
        <li>"nine point five meters"</li>
      </ul>
    </div>
  </div>
</div>

<style>
  .page {
    max-width: 900px;
  }

  h1 {
    font-size: 1.75rem;
    color: #1f2937;
    margin-bottom: 8px;
  }

  h2 {
    font-size: 1.25rem;
    color: #374151;
    margin-bottom: 16px;
  }

  h3 {
    font-size: 1rem;
    color: #4b5563;
    margin-bottom: 12px;
    padding-bottom: 8px;
    border-bottom: 1px solid #e5e7eb;
  }

  h4 {
    font-size: 0.875rem;
    color: #6b7280;
    margin-top: 12px;
    margin-bottom: 4px;
  }

  .description {
    color: #6b7280;
    margin-bottom: 32px;
  }

  .control-panel {
    background: linear-gradient(135deg, #059669 0%, #047857 100%);
    color: white;
    border-radius: 12px;
    padding: 24px;
    margin-bottom: 24px;
  }

  .control-panel h2 {
    color: white;
    margin-bottom: 16px;
    font-size: 1rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .control-row {
    display: flex;
    gap: 12px;
  }

  .clear-btn {
    padding: 8px 16px;
    background: rgba(255, 255, 255, 0.2);
    color: white;
    border: 1px solid rgba(255, 255, 255, 0.3);
    border-radius: 6px;
    font-size: 0.875rem;
    cursor: pointer;
    transition: background 0.2s;
  }

  .clear-btn:hover {
    background: rgba(255, 255, 255, 0.3);
  }

  .demo-section {
    background: #fff;
    border: 1px solid #e5e7eb;
    border-radius: 12px;
    padding: 24px;
    margin-bottom: 24px;
  }

  .form-section {
    margin-bottom: 24px;
    padding-bottom: 16px;
    border-bottom: 1px solid #f3f4f6;
  }

  .form-section:last-of-type {
    border-bottom: none;
    margin-bottom: 0;
  }

  .two-column {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 16px;
  }

  @media (max-width: 600px) {
    .two-column {
      grid-template-columns: 1fr;
    }
  }

  .total-cost {
    display: flex;
    justify-content: flex-end;
    align-items: center;
    gap: 12px;
    margin-top: 16px;
    padding: 12px 16px;
    background: #f0fdf4;
    border-radius: 8px;
  }

  .total-label {
    font-weight: 500;
    color: #166534;
  }

  .total-value {
    font-size: 1.25rem;
    font-weight: 600;
    color: #166534;
  }

  .form-actions {
    margin-top: 24px;
    display: flex;
    justify-content: flex-end;
  }

  .submit-btn {
    padding: 12px 32px;
    background: #059669;
    color: white;
    border: none;
    border-radius: 8px;
    font-size: 1rem;
    font-weight: 500;
    cursor: pointer;
    transition: background 0.2s;
  }

  .submit-btn:hover {
    background: #047857;
  }

  .submitted-data {
    margin-top: 24px;
    padding: 16px;
    background: #f0fdf4;
    border: 1px solid #bbf7d0;
    border-radius: 8px;
  }

  .submitted-data h3 {
    color: #166534;
    margin-bottom: 8px;
    border-bottom: none;
    padding-bottom: 0;
  }

  .submitted-data pre {
    background: #fff;
    padding: 12px;
    border-radius: 4px;
    font-size: 0.875rem;
    overflow-x: auto;
  }

  .examples {
    font-size: 0.875rem;
    color: #4b5563;
  }

  .examples ul {
    margin: 4px 0 12px;
    padding-left: 20px;
  }

  .examples li {
    margin: 4px 0;
    font-family: monospace;
    background: #f3f4f6;
    padding: 4px 8px;
    border-radius: 4px;
    display: inline-block;
    margin-right: 8px;
    margin-bottom: 4px;
  }
</style>
