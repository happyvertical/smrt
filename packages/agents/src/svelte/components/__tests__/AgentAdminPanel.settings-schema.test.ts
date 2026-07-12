// @vitest-environment jsdom
import { createUIRegistry } from '@happyvertical/smrt-agents/ui';
import { render, screen } from '@testing-library/svelte';
import { describe, expect, it, vi } from 'vitest';
import AgentAdminPanel from '../AgentAdminPanel.svelte';

const slot = {
  id: 'settings',
  label: 'Settings',
  settingsSchema: {
    version: 1,
    fields: [{ id: 'name', label: 'Display name', type: 'string' as const }],
  },
};

function renderPanel(onSave?: (config: unknown) => Promise<void>) {
  return render(AgentAdminPanel, {
    props: {
      registry: createUIRegistry(),
      agentClass: 'Praeco',
      slotId: slot.id,
      slot,
      config: { name: 'Current name' },
      onSave,
    },
  });
}

describe('AgentAdminPanel schema fallback', () => {
  it('is read-only when the host does not provide a save handler', () => {
    renderPanel();

    expect(screen.getByLabelText('Display name')).toBeDisabled();
    expect(
      screen.queryByRole('button', { name: 'Save settings' }),
    ).not.toBeInTheDocument();
  });

  it('remains editable when the host provides a save handler', () => {
    renderPanel(vi.fn().mockResolvedValue(undefined));

    expect(screen.getByLabelText('Display name')).toBeEnabled();
    expect(
      screen.getByRole('button', { name: 'Save settings' }),
    ).toBeInTheDocument();
  });
});
