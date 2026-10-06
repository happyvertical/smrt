// @vitest-environment jsdom
import { render, screen } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it } from 'vitest';
import { formatCurrency } from '../utils.js';
import TimeEntryExtensionsFixture from './fixtures/TimeEntryExtensionsFixture.svelte';

describe('time entry display extensions', () => {
  it('preserves exact caller hours, evidence, and native decision identity', () => {
    const { container } = render(TimeEntryExtensionsFixture);
    expect(screen.getAllByText('1.0005h')).toHaveLength(4);
    expect(screen.getByText(/Package walls · revision 4/u)).toBeInTheDocument();
    expect(screen.getByText(/List evidence · superseded/u)).toBeInTheDocument();
    expect(screen.getByText('Queue evidence · manual')).toBeInTheDocument();
    expect(container.querySelector('form[method="POST"]')).toBeInTheDocument();
    expect(container.querySelector('input[name="requestId"]')).toHaveValue(
      'request-original',
    );
    expect(
      container.querySelector('input[name="expectedTenantId"]'),
    ).toHaveValue('tenant-1');
    expect(
      screen.getByRole('button', { name: 'Approve retained evidence' }),
    ).toHaveValue('approved');
    expect(
      screen.getByRole('button', { name: 'Request correction' }),
    ).toHaveValue('correction');
    expect(screen.queryByText(/\/hr/u)).not.toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Approve time entry/u }),
    ).not.toBeInTheDocument();
  });

  it.each([
    ['JPY', '1,001'],
    ['CAD', '10.01'],
    ['KWD', '1.001'],
  ])('formats 1001 minor units with the %s exponent', (currency, amount) => {
    expect(formatCurrency(1001, currency)).toContain(amount);
  });
});
