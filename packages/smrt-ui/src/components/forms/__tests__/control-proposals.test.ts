import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { describe, expect, it } from 'vitest';
import { createControlInteractionRegistry } from '../control-interaction.js';
import {
  controlProposalInputSchema,
  controlProposalToolName,
  stageControlProposals,
} from '../control-proposals.js';
import Fixture from './composite-registration.fixture.svelte';

describe('useControlRegistration (public) and control proposals', () => {
  it('registers a composite as one control with its declared value schema', async () => {
    const registry = createControlInteractionRegistry();
    render(Fixture, { props: { registry } });
    await tick();
    const ids = registry
      .list('new-site')
      .map((snapshot) => snapshot.identity.controlId);
    expect(ids).toEqual(expect.arrayContaining(['name', 'place', 'password']));
    const place = registry.get({ formId: 'new-site', controlId: 'place' });
    expect(place?.metadata.label).toBe('Town location');
    expect(place?.metadata.valueSchema).toMatchObject({ type: 'object' });
  });

  it('builds a proposal schema from every proposable control, never secrets', async () => {
    const registry = createControlInteractionRegistry();
    render(Fixture, { props: { registry } });
    await tick();
    const schema = controlProposalInputSchema(registry, 'new-site') as {
      properties: Record<string, Record<string, unknown>>;
    };
    expect(Object.keys(schema.properties).sort()).toEqual(['name', 'place']);
    expect(schema.properties.name).toEqual({
      type: 'string',
      title: 'Site name',
    });
    expect(schema.properties.place).toMatchObject({
      type: 'object',
      title: 'Town location',
    });
    expect(
      controlProposalInputSchema(registry, 'new-site', { exclude: ['name'] }),
    ).toMatchObject({ properties: { place: expect.any(Object) } });
  });

  it('stages proposals for review without changing values', async () => {
    const registry = createControlInteractionRegistry();
    render(Fixture, { props: { registry } });
    await tick();
    const result = await stageControlProposals(
      registry,
      'new-site',
      {
        name: 'Lacombe',
        place: { name: 'Lacombe', latitude: 52.46, longitude: -113.73 },
        password: 'hunter2',
        nope: 1,
      },
      { actorId: 'assistant' },
    );
    expect(result).toEqual({
      ok: true,
      staged: 2,
      rejected: [],
      skipped: ['password', 'nope'],
    });
    expect(screen.getByTestId('place')).toHaveTextContent('none');
    const staged = registry.get({ formId: 'new-site', controlId: 'place' });
    expect(staged?.state.staged?.provenance).toMatchObject({
      source: 'agent',
      actorId: 'assistant',
    });
  });

  it('names the tool with tool-safe characters', () => {
    expect(controlProposalToolName('setup-network')).toBe(
      'setup_network_stage_changes',
    );
    expect(controlProposalToolName('--')).toBe('form_stage_changes');
  });
});
