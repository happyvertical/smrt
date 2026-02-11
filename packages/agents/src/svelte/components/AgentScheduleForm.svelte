<script lang="ts">
/**
 * AgentScheduleForm - Create or edit an agent schedule
 */

import { Button, Card } from '@happyvertical/smrt-svelte/ui';
import type { ScheduleFormData } from './types.js';

export interface Props {
  /** Initial form data (for editing) */
  initialData?: Partial<ScheduleFormData>;
  /** Available agent types */
  agentTypes?: string[];
  /** Submit callback */
  onSubmit?: (data: ScheduleFormData) => void;
  /** Cancel callback */
  onCancel?: () => void;
  /** Loading state */
  loading?: boolean;
  /** Edit mode */
  editMode?: boolean;
}

let {
  initialData = {},
  agentTypes = [],
  onSubmit,
  onCancel,
  loading = false,
  editMode = false,
}: Props = $props();

// Form state
let agentType = $state(initialData.agentType ?? '');
let agentId = $state(initialData.agentId ?? '');
let cron = $state(initialData.cron ?? '');
let timezone = $state(initialData.timezone ?? 'UTC');
let enabled = $state(initialData.enabled ?? true);
let maxConcurrent = $state(initialData.maxConcurrent ?? 1);
let timeout = $state(initialData.timeout ?? 3600000);
let method = $state(initialData.method ?? 'run');

// Common cron presets
const cronPresets = [
  { label: 'Every hour', value: '0 * * * *' },
  { label: 'Every 15 minutes', value: '*/15 * * * *' },
  { label: 'Daily at midnight', value: '0 0 * * *' },
  { label: 'Daily at 2 AM', value: '0 2 * * *' },
  { label: 'Weekly on Sunday', value: '0 0 * * 0' },
  { label: 'Monthly on 1st', value: '0 0 1 * *' },
];

// Common timezones
const timezones = [
  'UTC',
  'America/New_York',
  'America/Chicago',
  'America/Denver',
  'America/Los_Angeles',
  'Europe/London',
  'Europe/Paris',
  'Asia/Tokyo',
  'Australia/Sydney',
];

// Validation
const isValid = $derived(agentType.trim() !== '' && cron.trim() !== '');

function handleSubmit(event: Event) {
  event.preventDefault();
  if (!isValid || loading) return;

  const data: ScheduleFormData = {
    agentType: agentType.trim(),
    cron: cron.trim(),
    timezone,
    enabled,
    maxConcurrent,
    timeout,
    method: method.trim() || 'run',
  };

  if (agentId.trim()) {
    data.agentId = agentId.trim();
  }

  onSubmit?.(data);
}

function handleCronPreset(preset: string) {
  cron = preset;
}
</script>

<Card>
  {#snippet header()}
    <h2>{editMode ? 'Edit Schedule' : 'Create Schedule'}</h2>
  {/snippet}

  <form class="schedule-form" onsubmit={handleSubmit}>
    <div class="form-grid">
      <!-- Agent Type -->
      <div class="form-field">
        <label for="agentType">Agent Type *</label>
        {#if agentTypes.length > 0}
          <select id="agentType" bind:value={agentType} required disabled={loading}>
            <option value="">Select agent type...</option>
            {#each agentTypes as type}
              <option value={type}>{type}</option>
            {/each}
          </select>
        {:else}
          <input
            type="text"
            id="agentType"
            bind:value={agentType}
            placeholder="e.g., Praeco, Scraper"
            required
            disabled={loading}
          />
        {/if}
      </div>

      <!-- Agent ID (optional) -->
      <div class="form-field">
        <label for="agentId">Agent ID (optional)</label>
        <input
          type="text"
          id="agentId"
          bind:value={agentId}
          placeholder="Specific instance ID"
          disabled={loading}
        />
        <small>Leave empty to create a new instance for each run</small>
      </div>

      <!-- Method -->
      <div class="form-field">
        <label for="method">Method</label>
        <input
          type="text"
          id="method"
          bind:value={method}
          placeholder="run"
          disabled={loading}
        />
        <small>Method to call on the agent (default: run)</small>
      </div>

      <!-- Cron Expression -->
      <div class="form-field form-field--full">
        <label for="cron">Cron Schedule *</label>
        <input
          type="text"
          id="cron"
          bind:value={cron}
          placeholder="0 2 * * *"
          required
          disabled={loading}
        />
        <div class="cron-presets">
          {#each cronPresets as preset}
            <button
              type="button"
              class="preset-btn"
              onclick={() => handleCronPreset(preset.value)}
              disabled={loading}
            >
              {preset.label}
            </button>
          {/each}
        </div>
        <small>Standard 5-field cron format: minute hour day-of-month month day-of-week</small>
      </div>

      <!-- Timezone -->
      <div class="form-field">
        <label for="timezone">Timezone</label>
        <select id="timezone" bind:value={timezone} disabled={loading}>
          {#each timezones as tz}
            <option value={tz}>{tz}</option>
          {/each}
        </select>
      </div>

      <!-- Max Concurrent -->
      <div class="form-field">
        <label for="maxConcurrent">Max Concurrent</label>
        <input
          type="number"
          id="maxConcurrent"
          bind:value={maxConcurrent}
          min="1"
          max="10"
          disabled={loading}
        />
        <small>Maximum concurrent runs (prevents overlapping)</small>
      </div>

      <!-- Timeout -->
      <div class="form-field">
        <label for="timeout">Timeout (ms)</label>
        <input
          type="number"
          id="timeout"
          bind:value={timeout}
          min="60000"
          step="60000"
          disabled={loading}
        />
        <small>{(timeout / 60000).toFixed(0)} minutes</small>
      </div>

      <!-- Enabled -->
      <div class="form-field form-field--checkbox">
        <label>
          <input type="checkbox" bind:checked={enabled} disabled={loading} />
          Enable schedule immediately
        </label>
      </div>
    </div>

    <div class="form-actions">
      {#if onCancel}
        <Button variant="secondary" onclick={onCancel} disabled={loading}>
          Cancel
        </Button>
      {/if}
      <Button type="submit" disabled={!isValid || loading}>
        {loading ? 'Saving...' : editMode ? 'Update Schedule' : 'Create Schedule'}
      </Button>
    </div>
  </form>
</Card>

<style>
  .schedule-form {
    padding: var(--spacing-sm, 0.5rem) 0;
  }

  .form-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: var(--spacing-md, 1rem);
  }

  .form-field {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xs, 0.25rem);
  }

  .form-field--full {
    grid-column: 1 / -1;
  }

  .form-field--checkbox {
    flex-direction: row;
    align-items: center;
    gap: var(--spacing-sm, 0.5rem);
  }

  .form-field--checkbox label {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm, 0.5rem);
    cursor: pointer;
  }

  .form-field label {
    font-weight: 500;
    font-size: var(--font-size-sm, 0.875rem);
    color: var(--color-text-primary, #111827);
  }

  .form-field input,
  .form-field select {
    padding: var(--spacing-sm, 0.5rem);
    border: 1px solid var(--color-neutral-gray300, #d1d5db);
    border-radius: var(--radius-md, 0.375rem);
    font-size: var(--font-size-sm, 0.875rem);
    transition: border-color 150ms ease;
  }

  .form-field input:focus,
  .form-field select:focus {
    outline: none;
    border-color: var(--color-primary, #3b82f6);
    box-shadow: 0 0 0 3px var(--color-primary-light, rgba(59, 130, 246, 0.1));
  }

  .form-field input:disabled,
  .form-field select:disabled {
    background: var(--color-neutral-gray100, #f3f4f6);
    cursor: not-allowed;
  }

  .form-field small {
    font-size: var(--font-size-xs, 0.75rem);
    color: var(--color-text-secondary, #6b7280);
  }

  .cron-presets {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-xs, 0.25rem);
    margin-top: var(--spacing-xs, 0.25rem);
  }

  .preset-btn {
    padding: 0.125rem var(--spacing-sm, 0.5rem);
    border: 1px solid var(--color-neutral-gray300, #d1d5db);
    border-radius: var(--radius-sm, 0.25rem);
    background: var(--color-neutral-white, #ffffff);
    font-size: var(--font-size-xs, 0.75rem);
    cursor: pointer;
    transition: all 150ms ease;
  }

  .preset-btn:hover:not(:disabled) {
    background: var(--color-neutral-gray100, #f3f4f6);
    border-color: var(--color-primary, #3b82f6);
  }

  .preset-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--spacing-sm, 0.5rem);
    margin-top: var(--spacing-lg, 1.5rem);
    padding-top: var(--spacing-md, 1rem);
    border-top: 1px solid var(--color-neutral-gray200, #e5e7eb);
  }
</style>
