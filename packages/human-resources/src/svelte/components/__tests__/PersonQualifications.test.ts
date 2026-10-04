// @vitest-environment jsdom
/**
 * Component coverage for PersonQualifications via the shared S11 harness
 * (#1416): rendering from props, every expiry state as a text label, the
 * expiring-soon boundary, the empty state, `onselect`, and accessibility.
 */
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import type { PersonQualificationView } from '../../types.js';
import PersonQualifications from '../PersonQualifications.svelte';

function held(
  overrides: Partial<PersonQualificationView> = {},
): PersonQualificationView {
  return {
    id: 'held-1',
    name: 'First aid',
    kind: 'certification',
    issuingBody: 'Red Cross',
    certificateNumber: 'FA-77',
    issuedOn: '2025-11-01',
    expiresOn: '2027-11-01',
    status: 'valid',
    daysUntilExpiry: 394,
    ...overrides,
  };
}

function stateOf(container: HTMLElement, id: number): string | undefined {
  return container.querySelectorAll<HTMLElement>('.person-qualification')[id]
    ?.dataset.state;
}

describe('PersonQualifications', () => {
  it('shows name, kind, issuing body, certificate number, dates and state', () => {
    render(PersonQualifications, { props: { qualifications: [held()] } });
    expect(screen.getByText('First aid')).toBeInTheDocument();
    expect(screen.getByText('Certification')).toBeInTheDocument();
    expect(screen.getByText('Red Cross')).toBeInTheDocument();
    expect(screen.getByText('Certificate FA-77')).toBeInTheDocument();
    expect(screen.getByText('Issued 2025-11-01')).toBeInTheDocument();
    expect(screen.getByText('Expires 2027-11-01')).toBeInTheDocument();
    expect(screen.getByText('In 394 days')).toBeInTheDocument();
    expect(screen.getByText('Valid')).toBeInTheDocument();
  });

  it('writes every state out as text', () => {
    render(PersonQualifications, {
      props: {
        qualifications: [
          held({ id: 'a', status: 'expired', daysUntilExpiry: -3 }),
          held({ id: 'b', status: 'suspended' }),
          held({ id: 'c', status: 'revoked' }),
          held({ id: 'd', status: 'not-yet-issued' }),
          held({ id: 'e', expiresOn: null, daysUntilExpiry: null }),
        ],
      },
    });
    expect(screen.getByText('Expired')).toBeInTheDocument();
    expect(screen.getByText('3 days ago')).toBeInTheDocument();
    expect(screen.getByText('Suspended')).toBeInTheDocument();
    expect(screen.getByText('Revoked')).toBeInTheDocument();
    expect(screen.getByText('Not yet issued')).toBeInTheDocument();
    expect(screen.getByText('Does not expire')).toBeInTheDocument();
    expect(screen.getByText('Valid')).toBeInTheDocument();
  });

  it('flags a valid qualification on the last day of the default 30-day window, not the day after', () => {
    const { container } = render(PersonQualifications, {
      props: {
        qualifications: [
          held({ id: 'in', daysUntilExpiry: 30 }),
          held({ id: 'out', daysUntilExpiry: 31 }),
          held({ id: 'today', daysUntilExpiry: 0 }),
        ],
      },
    });
    expect(stateOf(container, 0)).toBe('expiring-soon');
    expect(stateOf(container, 1)).toBe('valid');
    expect(stateOf(container, 2)).toBe('expiring-soon');
    expect(screen.getAllByText('Expiring soon')).toHaveLength(2);
    expect(screen.getByText('Today')).toBeInTheDocument();
  });

  it('honours a custom expiringSoonDays window', () => {
    const { container } = render(PersonQualifications, {
      props: {
        qualifications: [
          held({ id: 'in', daysUntilExpiry: 60 }),
          held({ id: 'out', daysUntilExpiry: 61 }),
        ],
        expiringSoonDays: 60,
      },
    });
    expect(stateOf(container, 0)).toBe('expiring-soon');
    expect(stateOf(container, 1)).toBe('valid');
  });

  it('never flags a suspended qualification as expiring soon', () => {
    render(PersonQualifications, {
      props: {
        qualifications: [held({ status: 'suspended', daysUntilExpiry: 5 })],
      },
    });
    expect(screen.getByText('Suspended')).toBeInTheDocument();
    expect(screen.queryByText('Expiring soon')).not.toBeInTheDocument();
  });

  it('shows the default and a custom empty message', () => {
    const { unmount } = render(PersonQualifications, {
      props: { qualifications: [] },
    });
    expect(screen.getByText('No qualifications')).toBeInTheDocument();
    unmount();
    render(PersonQualifications, {
      props: { qualifications: [], emptyMessage: 'Nothing on file' },
    });
    expect(screen.getByText('Nothing on file')).toBeInTheDocument();
  });

  it('calls onselect with the held-qualification id', async () => {
    const onselect = vi.fn();
    render(PersonQualifications, {
      props: {
        qualifications: [held(), held({ id: 'held-2', name: 'Forklift' })],
        onselect,
      },
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Open qualification: Forklift' }),
    );
    expect(onselect).toHaveBeenCalledExactlyOnceWith('held-2');
  });

  it('is axe-clean', async () => {
    const { container } = render(PersonQualifications, {
      props: {
        qualifications: [
          held(),
          held({ id: 'b', daysUntilExpiry: 5 }),
          held({ id: 'c', status: 'revoked' }),
        ],
        onselect: vi.fn(),
      },
    });
    await expectNoA11yViolations(container);
  });
});
