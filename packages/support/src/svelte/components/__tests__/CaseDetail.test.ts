// @vitest-environment jsdom
/**
 * Component coverage for CaseDetail via the shared S11 harness (#1416).
 */
import {
  expectNoA11yViolations,
  render,
  screen,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it } from 'vitest';
import type {
  CaseTimelineItemView,
  SupportCaseView,
  SupportWorkLinkView,
} from '../../types.js';
import CaseDetail from '../CaseDetail.svelte';

const caseView: SupportCaseView = {
  id: 'case-1',
  caseNumber: 'SUP-9',
  subject: 'Checkout errors under load',
  status: 'escalated',
  priority: 'urgent',
  severity: 'sev1',
  channelKind: 'email',
  clientProfileId: 'client-1',
  projectId: 'shop-rebuild',
  assignedSpecialistId: 'spec-2',
  assignedSpecialistName: 'Grace',
  reopenCount: 1,
  createdAt: '2026-07-01T09:00:00.000Z',
  updatedAt: '2026-07-03T16:00:00.000Z',
  resolutionSummary: '',
};

const timeline: CaseTimelineItemView[] = [
  {
    kind: 'interaction',
    occurredAt: '2026-07-01T09:00:00.000Z',
    actorKind: 'client',
    summary: 'inbound email',
    body: 'Checkout is failing for many users.',
    direction: 'inbound',
    channelKind: 'email',
    eventType: null,
  },
  {
    kind: 'event',
    occurredAt: '2026-07-01T09:05:00.000Z',
    actorKind: 'system',
    summary: 'Status new → triaged',
    body: '',
    direction: null,
    channelKind: null,
    eventType: 'transition',
  },
];

const workLinks: SupportWorkLinkView[] = [
  {
    id: 'link-1',
    linkKind: 'development_work_item',
    targetLabel: 'shop#101: fix checkout race',
    externalUrl: 'https://github.com/acme/shop/issues/101',
    status: 'in_progress',
  },
];

describe('CaseDetail', () => {
  it('renders header, meta, linked work, and the merged timeline', async () => {
    const { container } = render(CaseDetail, {
      props: { caseView, timeline, workLinks },
    });

    expect(screen.getByText('SUP-9')).toBeInTheDocument();
    expect(screen.getByText('Checkout errors under load')).toBeInTheDocument();
    expect(screen.getByText('escalated')).toBeInTheDocument();
    expect(screen.getByText('reopened ×1')).toBeInTheDocument();
    expect(screen.getByText('Grace')).toBeInTheDocument();
    expect(screen.getByText('shop-rebuild')).toBeInTheDocument();

    expect(
      screen.getByRole('link', { name: 'shop#101: fix checkout race' }),
    ).toHaveAttribute('href', 'https://github.com/acme/shop/issues/101');

    expect(
      screen.getByText('Checkout is failing for many users.'),
    ).toBeInTheDocument();
    expect(screen.getByText('Status new → triaged')).toBeInTheDocument();

    await expectNoA11yViolations(container);
  });

  it('shows the empty history state and resolution when present', () => {
    render(CaseDetail, {
      props: {
        caseView: {
          ...caseView,
          status: 'resolved',
          resolutionSummary: 'Scaled the checkout workers.',
        },
        timeline: [],
      },
    });
    expect(screen.getByText('No activity yet')).toBeInTheDocument();
    expect(
      screen.getByText('Scaled the checkout workers.'),
    ).toBeInTheDocument();
  });
});
