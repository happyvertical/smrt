// @vitest-environment jsdom
/**
 * JobList ordering: rows keep the order they are supplied in until the host
 * passes a `sort` or the person activates a header — adding header sorting
 * must not silently reorder an existing host's list.
 */
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it } from 'vitest';
import JobList from '../JobList.svelte';
import type { JobData } from '../types.js';

function job(id: string, createdAt: string, queue = 'default'): JobData {
  return {
    id,
    queue,
    objectType: 'Thing',
    objectId: null,
    method: 'run',
    args: {},
    status: 'pending',
    priority: 0,
    attempts: 0,
    maxAttempts: 3,
    timeout: 0,
    timeoutBehavior: 'fail',
    runAt: createdAt,
    startedAt: null,
    completedAt: null,
    lastError: null,
    resultPointer: null,
    workerId: null,
    createdAt,
    updatedAt: createdAt,
  } as JobData;
}

// Supplied oldest first, as a host that orders by queue position might.
const jobs = [
  job('a', '2026-09-01T00:00:00Z', 'q-a'),
  job('b', '2026-09-03T00:00:00Z', 'q-b'),
  job('c', '2026-09-02T00:00:00Z', 'q-c'),
];

const queues = () =>
  Array.from(document.querySelectorAll('.job-list__cell--queue')).map((cell) =>
    cell.textContent?.trim(),
  );

describe('JobList ordering', () => {
  it('renders rows in the supplied order when no sort is given', () => {
    render(JobList, { props: { jobs, showActions: false } });
    expect(queues()).toEqual(['q-a', 'q-b', 'q-c']);
  });

  it('sorts when the host passes a sort', () => {
    render(JobList, {
      props: {
        jobs,
        showActions: false,
        sort: { columnId: 'createdAt', direction: 'desc' },
      },
    });
    expect(queues()).toEqual(['q-b', 'q-c', 'q-a']);
  });

  it('sorts once the person activates a header', async () => {
    render(JobList, { props: { jobs, showActions: false } });
    await userEvent.click(screen.getByRole('button', { name: /Queue/ }));
    expect(queues()).toEqual(['q-a', 'q-b', 'q-c']);
    await userEvent.click(screen.getByRole('button', { name: /Queue/ }));
    expect(queues()).toEqual(['q-c', 'q-b', 'q-a']);
  });
});
