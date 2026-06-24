<script lang="ts">
/**
 * AgentScheduleForm - Create or edit an agent schedule
 */

import { Form, Input, Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button, Card } from '@happyvertical/smrt-ui/ui';
import { M } from '../i18n.js';
import type { ScheduleFormData } from '../types.js';

const { t } = useI18n();

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

function getInitialFormState(data: Partial<ScheduleFormData> = {}) {
  return {
    agentType: data.agentType ?? '',
    agentId: data.agentId ?? '',
    cron: data.cron ?? '',
    timezone: data.timezone ?? 'UTC',
    enabled: data.enabled ?? true,
    maxConcurrent: data.maxConcurrent ?? 1,
    timeout: data.timeout ?? 3600000,
    method: data.method ?? 'run',
  };
}

let agentType = $state('');
let agentId = $state('');
let cron = $state('');
let timezone = $state('UTC');
let enabled = $state(true);
let maxConcurrent = $state(1);
let timeout = $state(3600000);
let method = $state('run');
let appliedInitialData: Partial<ScheduleFormData> | undefined;

$effect(() => {
  if (appliedInitialData === initialData) {
    return;
  }

  appliedInitialData = initialData;

  const next = getInitialFormState(initialData);
  agentType = next.agentType;
  agentId = next.agentId;
  cron = next.cron;
  timezone = next.timezone;
  enabled = next.enabled;
  maxConcurrent = next.maxConcurrent;
  timeout = next.timeout;
  method = next.method;
});

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

function handleSubmit() {
  // The Form primitive calls event.preventDefault() before invoking onsubmit.
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

  <div class="schedule-form-shell">
  <Form class="schedule-form" onsubmit={handleSubmit}>
    <div class="form-grid">
      <!-- Agent Type -->
      <div class="form-field">
        <label for="agentType">{t(M['agents.schedule_form.agent_type'])}</label>
        {#if agentTypes.length > 0}
          <Select id="agentType" bind:value={agentType} required disabled={loading}>
            <option value="">{t(M['agents.schedule_form.select_agent_type'])}</option>
            {#each agentTypes as type}
              <option value={type}>{type}</option>
            {/each}
          </Select>
        {:else}
          <Input
            type="text"
            id="agentType"
            bind:value={agentType}
            placeholder={t(M['agents.schedule_form.agent_type_placeholder'])}
            required
            disabled={loading}
          />
        {/if}
      </div>

      <!-- Agent ID (optional) -->
      <div class="form-field">
        <label for="agentId">{t(M['agents.schedule_form.agent_id'])}</label>
        <Input
          type="text"
          id="agentId"
          bind:value={agentId}
          placeholder={t(M['agents.schedule_form.agent_id_placeholder'])}
          disabled={loading}
        />
        <small>{t(M['agents.schedule_form.agent_id_hint'])}</small>
      </div>

      <!-- Method -->
      <div class="form-field">
        <label for="method">Method</label>
        <Input
          type="text"
          id="method"
          bind:value={method}
          placeholder={t(M['agents.schedule_form.method_placeholder'])}
          disabled={loading}
        />
        <small>{t(M['agents.schedule_form.method_hint'])}</small>
      </div>

      <!-- Cron Expression -->
      <div class="form-field form-field--full">
        <label for="cron">{t(M['agents.schedule_form.cron_schedule'])}</label>
        <Input
          type="text"
          id="cron"
          bind:value={cron}
          placeholder="0 2 * * *"
          required
          disabled={loading}
        />
        <div class="cron-presets">
          {#each cronPresets as preset}
            <Button
              variant="secondary"
              size="sm"
              onclick={() => handleCronPreset(preset.value)}
              disabled={loading}
            >
              {preset.label}
            </Button>
          {/each}
        </div>
        <small>{t(M['agents.schedule_form.cron_hint'])}</small>
      </div>

      <!-- Timezone -->
      <div class="form-field">
        <label for="timezone">Timezone</label>
        <Select id="timezone" bind:value={timezone} disabled={loading}>
          {#each timezones as tz}
            <option value={tz}>{tz}</option>
          {/each}
        </Select>
      </div>

      <!-- Max Concurrent -->
      <div class="form-field">
        <label for="maxConcurrent">{t(M['agents.schedule_form.max_concurrent'])}</label>
        <Input
          type="number"
          id="maxConcurrent"
          bind:value={maxConcurrent}
          min="1"
          max="10"
          disabled={loading}
        />
        <small>{t(M['agents.schedule_form.max_concurrent_hint'])}</small>
      </div>

      <!-- Timeout -->
      <div class="form-field">
        <label for="timeout">Timeout (ms)</label>
        <Input
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
          <!-- raw-primitive-allow: native checkbox; no Provider-free checkbox primitive (Toggle is a switch with different semantics, CheckboxInput requires a Provider) -->
          <input type="checkbox" bind:checked={enabled} disabled={loading} />
          {t(M['agents.schedule_form.enable_schedule_immediately'])}
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
  </Form>
  </div>
</Card>

<style>
  .schedule-form-shell :global(.schedule-form) {
    padding: var(--smrt-spacing-sm, 0.5rem) 0;
  }

  .form-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(250px, 1fr));
    gap: var(--smrt-spacing-md, 1rem);
  }

  .form-field {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-xs, 0.25rem);
  }

  .form-field--full {
    grid-column: 1 / -1;
  }

  .form-field--checkbox {
    flex-direction: row;
    align-items: center;
    gap: var(--smrt-spacing-sm, 0.5rem);
  }

  .form-field--checkbox label {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-sm, 0.5rem);
    cursor: pointer;
  }

  .form-field label {
    font-weight: var(--smrt-typography-weight-medium, 500);
    font: var(--smrt-typography-body-medium-font, 0.875rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface, #1a1c1e);
  }

  .form-field small {
    font: var(--smrt-typography-body-small-font, 0.75rem / 1.25 sans-serif);
    color: var(--smrt-color-on-surface-variant, #43474e);
  }

  .cron-presets {
    display: flex;
    flex-wrap: wrap;
    gap: var(--smrt-spacing-xs, 0.25rem);
    margin-top: var(--smrt-spacing-xs, 0.25rem);
  }

  .form-actions {
    display: flex;
    justify-content: flex-end;
    gap: var(--smrt-spacing-sm, 0.5rem);
    margin-top: var(--smrt-spacing-lg, 1.5rem);
    padding-top: var(--smrt-spacing-md, 1rem);
    border-top: 1px solid var(--smrt-color-outline-variant, #c4c6cf);
  }
</style>
