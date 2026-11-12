import { resolveWorkProfile } from '@happyvertical/smrt-inference';
import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen, waitFor } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import WorkProfileSettings from '../WorkProfileSettings.svelte';

const resolved = (['design', 'assist', 'background'] as const).map((profile) =>
  resolveWorkProfile({
    profile,
    engine: 'codex',
    catalog: [{ id: 'gpt-6.1', intelligenceRank: 10 }],
  }),
);
describe('WorkProfileSettings', () => {
  it('edits budgets and escalation, saves overrides and resets recommendations', async () => {
    const onsave = vi.fn(async () => {});
    const onreset = vi.fn(async () => {});
    const { container } = render(WorkProfileSettings, {
      props: { settings: {}, resolved, onsave, onreset },
    });
    const user = userEvent.setup();
    const steps = screen.getAllByRole('spinbutton', {
      name: 'Tool steps per pass',
    })[0];
    await user.clear(steps);
    await user.type(steps, '80');
    await user.tab();
    await user.click(
      screen.getByRole('checkbox', {
        name: 'Automatically use system design for structure changes',
      }),
    );
    await user.click(
      screen.getByRole('button', { name: 'Save assistant quality' }),
    );
    await waitFor(() =>
      expect(onsave).toHaveBeenCalledWith({
        design: { budgets: { maxSteps: 80 } },
        assist: { autoEscalate: false },
      }),
    );
    await user.click(
      screen.getByRole('button', { name: 'Reset to recommended' }),
    );
    expect(onreset).toHaveBeenCalledOnce();
    await expectNoA11yViolations(container);
  });
  it('keeps unavailable profiles editable and reports a refused save', async () => {
    render(WorkProfileSettings, {
      props: {
        settings: {},
        resolved: resolved.map((profile) => ({
          ...profile,
          unavailable: true,
        })),
        onsave: async () => {
          throw new Error('private');
        },
        onreset: vi.fn(),
      },
    });
    expect(screen.getAllByText(/This connection is unavailable/)).toHaveLength(
      3,
    );
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Save assistant quality' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The change could not be saved.',
    );
    expect(screen.queryByText('private')).not.toBeInTheDocument();
  });
});
