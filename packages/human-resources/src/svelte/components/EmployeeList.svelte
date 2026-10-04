<script lang="ts">
/**
 * EmployeeList — a table of employees: name, employee number, position,
 * worker type, status (with the last day employed once an end is recorded)
 * and start date. Presentational: the host loads
 * employments through `EmploymentService`, adds each person's name (HR holds
 * no identity data) and adapts rows with `toEmployeeView`.
 */

import { Button, StatusBadge } from '@happyvertical/smrt-ui';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../i18n.js';
import {
  type EmployeeView,
  employmentStatusBadgeKey,
  employmentStatusLabelKey,
} from '../types.js';

const { t } = useI18n();

export interface EmployeeListProps {
  /** Employees to show, in the host's order. */
  employees: EmployeeView[];
  /** Invoked with the employment id when a name is activated. */
  onselect?: (id: string) => void;
  /** Message shown when there are no employees. */
  emptyMessage?: string;
}

const { employees, onselect, emptyMessage }: EmployeeListProps = $props();
</script>

{#if employees.length === 0}
  <p class="employee-list-empty">
    {emptyMessage ?? t(M['human_resources.employee_list.empty'])}
  </p>
{:else}
  <div class="employee-list-scroll">
    <table class="employee-list">
      <caption class="employee-list-caption">{t(M['human_resources.employee_list.caption'])}</caption>
      <thead>
        <tr>
          <th scope="col">{t(M['human_resources.employee_list.name'])}</th>
          <th scope="col">{t(M['human_resources.employee_list.employee_number'])}</th>
          <th scope="col">{t(M['human_resources.employee_list.position'])}</th>
          <th scope="col">{t(M['human_resources.employee_list.worker_type'])}</th>
          <th scope="col">{t(M['human_resources.employee_list.status'])}</th>
          <th scope="col">{t(M['human_resources.employee_list.started_on'])}</th>
        </tr>
      </thead>
      <tbody>
        {#each employees as employee (employee.id)}
          <tr>
            <th scope="row" class="employee-list-name">
              {#if onselect}
                <Button
                  variant="ghost"
                  size="sm"
                  onclick={() => onselect(employee.id)}
                  aria-label={t(M['human_resources.employee_list.select_aria'], { name: employee.displayName })}
                >
                  {employee.displayName}
                </Button>
              {:else}
                {employee.displayName}
              {/if}
            </th>
            <td class="employee-list-number">{employee.employeeNumber}</td>
            <td>
              {#if employee.position}
                {employee.position}
              {:else}
                <span class="employee-list-none">{t(M['human_resources.employee_list.none'])}</span>
              {/if}
            </td>
            <td>{employee.workerType}</td>
            <td>
              <StatusBadge
                status={employmentStatusBadgeKey(employee.status)}
                label={t(employmentStatusLabelKey(employee.status))}
                size="sm"
              />
              {#if employee.endsOn}
                <span class="employee-list-last-day">
                  {t(M['human_resources.employee_list.last_day'], { date: employee.endsOn })}
                </span>
              {/if}
            </td>
            <td>
              {#if employee.startedOn}
                <time datetime={employee.startedOn}>{employee.startedOn}</time>
              {:else}
                <span class="employee-list-none">{t(M['human_resources.employee_list.none'])}</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
  .employee-list-scroll {
    overflow-x: auto;
  }

  .employee-list {
    width: 100%;
    border-collapse: collapse;
  }

  .employee-list-caption {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }

  .employee-list th,
  .employee-list td {
    padding: 0.5rem 0.75rem;
    text-align: left;
    border-bottom: 1px solid var(--smrt-color-outline-variant, transparent);
  }

  .employee-list thead th {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .employee-list-name {
    font-weight: 500;
  }

  .employee-list-number {
    font-variant-numeric: tabular-nums;
  }

  .employee-list-last-day {
    margin-left: 0.5rem;
    font-size: 0.75rem;
    white-space: nowrap;
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .employee-list-none,
  .employee-list-empty {
    color: var(--smrt-color-on-surface-variant, inherit);
  }

  .employee-list-empty {
    padding: 1rem 0;
  }
</style>
