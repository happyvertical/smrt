// @vitest-environment jsdom
/**
 * Regression (#3304): boolean settings render the smrt-ui Checkbox rather than
 * a raw `<input type="checkbox">`, and toggling updates the saved draft.
 */
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import AgentSettingsForm from '../AgentSettingsForm.svelte';

const schema = {
  version: 1,
  fields: [{ id: 'enabled', label: 'Enabled', type: 'boolean' as const }],
};

describe('AgentSettingsForm boolean field', () => {
  it('renders the smrt-ui checkbox and saves the toggled value', async () => {
    const onSave = vi.fn().mockResolvedValue(undefined);
    const { container } = render(AgentSettingsForm, {
      props: { config: { enabled: false }, schema, onSave },
    });
    const box = screen.getByRole('checkbox', { name: 'Enabled' });
    expect(box).not.toBeChecked();
    expect(container.querySelector('[class*="smrt-checkbox"]')).not.toBeNull();

    await userEvent.click(box);
    expect(box).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: /save/i }));
    await waitFor(() =>
      expect(onSave).toHaveBeenCalledWith(
        expect.objectContaining({ enabled: true }),
      ),
    );
  });
});
