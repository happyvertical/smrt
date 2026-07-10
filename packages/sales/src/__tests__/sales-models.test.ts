import { describe, expect, it } from 'vitest';
import {
  Lead,
  Opportunity,
  PipelineStage,
  SalesActivity,
} from '../models/index.js';

describe('sales models', () => {
  it('preserves append-only acquisition history and returns defensive copies', () => {
    const lead = new Lead({ tenantId: 'tenant-1', name: 'Ada' });
    lead.recordAcquisition({
      source: 'website',
      occurredAt: '2026-07-01T00:00:00Z',
      campaign: 'launch',
    });
    lead.recordAcquisition({
      source: 'conference',
      occurredAt: '2026-07-02T00:00:00Z',
    });
    const first = lead.getAcquisitionHistory();
    const firstEvent = first[0];
    expect(firstEvent).toBeDefined();
    if (!firstEvent) throw new Error('Expected an acquisition event');
    firstEvent.source = 'changed';
    expect(lead.getAcquisitionHistory().map((event) => event.source)).toEqual([
      'website',
      'conference',
    ]);
  });

  it('moves opportunities only within their configured pipeline and applies outcomes', () => {
    const opportunity = new Opportunity({
      tenantId: 'tenant-1',
      pipelineId: 'pipeline-1',
      stageId: 'new',
      expectedValue: 1250.0,
    });
    const won = new PipelineStage({
      tenantId: 'tenant-1',
      pipelineId: 'pipeline-1',
      key: 'closed_won',
      terminal: true,
      outcome: 'won',
    });
    won.id = 'won';
    opportunity.moveTo(won);
    expect(opportunity.outcome).toBe('won');
    expect(opportunity.closedAt).toBeInstanceOf(Date);
    const foreign = new PipelineStage({
      tenantId: 'tenant-1',
      pipelineId: 'pipeline-2',
    });
    foreign.id = 'foreign';
    expect(() => opportunity.moveTo(foreign)).toThrow('different pipeline');
  });

  it('parses activity details without surfacing corrupt JSON', () => {
    const activity = new SalesActivity({ details: '{broken' });
    expect(activity.getDetails()).toEqual({});
    activity.setDetails({ from: 'new', to: 'qualified' });
    expect(activity.getDetails()).toEqual({ from: 'new', to: 'qualified' });
  });
});
