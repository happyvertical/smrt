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
  <p class="smrt-employee-list__empty" data-smrt-component="EmployeeList" data-smrt-part="empty">
    {emptyMessage ?? t(M['human_resources.employee_list.empty'])}
  </p>
{:else}
  <div class="smrt-employee-list__root" data-smrt-component="EmployeeList">
    <table class="smrt-employee-list__table">
      <caption class="smrt-employee-list__caption" data-smrt-part="caption">{t(M['human_resources.employee_list.caption'])}</caption>
      <thead data-smrt-part="header">
        <tr>
          <th scope="col">{t(M['human_resources.employee_list.name'])}</th>
          <th scope="col">{t(M['human_resources.employee_list.employee_number'])}</th>
          <th scope="col">{t(M['human_resources.employee_list.position'])}</th>
          <th scope="col">{t(M['human_resources.employee_list.worker_type'])}</th>
          <th scope="col">{t(M['human_resources.employee_list.status'])}</th>
          <th scope="col">{t(M['human_resources.employee_list.started_on'])}</th>
        </tr>
      </thead>
      <tbody data-smrt-part="body">
        {#each employees as employee (employee.id)}
          <tr data-smrt-part="row">
            <th scope="row" class="smrt-employee-list__name">
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
            <td class="smrt-employee-list__number">{employee.employeeNumber}</td>
            <td>
              {#if employee.position}
                {employee.position}
              {:else}
                <span class="smrt-employee-list__none">{t(M['human_resources.employee_list.none'])}</span>
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
                <span class="smrt-employee-list__last-day">
                  {t(M['human_resources.employee_list.last_day'], { date: employee.endsOn })}
                </span>
              {/if}
            </td>
            <td>
              {#if employee.startedOn}
                <time datetime={employee.startedOn}>{employee.startedOn}</time>
              {:else}
                <span class="smrt-employee-list__none">{t(M['human_resources.employee_list.none'])}</span>
              {/if}
            </td>
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{/if}

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-employee-list__root {
    overflow-x: auto;
  }
  .smrt-employee-list__table {
    width: 100%;
  }
  .smrt-employee-list__caption {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  .smrt-employee-list__table th,
  .smrt-employee-list__table td {
    padding: 0.5rem 0.75rem;
  }
  .smrt-employee-list__last-day {
    margin-left: 0.5rem;
    white-space: nowrap;
  }
  .smrt-employee-list__empty {
    padding: 1rem 0;
  }
}

@layer smrt.theme {
  .smrt-employee-list__table {
    border-collapse: collapse;
  }
  .smrt-employee-list__table th,
  .smrt-employee-list__table td {
    text-align: left;
    border-bottom: var(--smrt-hairline);
  }
  .smrt-employee-list__table thead th {
    font-size: 0.75rem;
    font-weight: 500;
    color: var(--smrt-color-on-surface-variant, inherit);
  }
  .smrt-employee-list__name {
    font-weight: 500;
  }
  .smrt-employee-list__number {
    font-variant-numeric: tabular-nums;
  }
  .smrt-employee-list__last-day {
    font-size: 0.75rem;
    color: var(--smrt-color-on-surface-variant, inherit);
  }
  .smrt-employee-list__none,
  .smrt-employee-list__empty {
    color: var(--smrt-color-on-surface-variant, inherit);
  }
}

</style>
