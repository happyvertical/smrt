import { resolveWorkProfile } from '@happyvertical/smrt-inference';
import { expectNoA11yViolations } from '@happyvertical/smrt-ui/test-support/a11y';
import { render, screen, waitFor, within } from '@testing-library/svelte';
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
  it('shows verified human strength and effort with exact models and limits folded away', async () => {
    const profiles = (['design', 'assist', 'background'] as const).map(
      (profile) => resolveWorkProfile({ profile, engine: 'claude-code' }),
    );
    const { container } = render(WorkProfileSettings, {
      props: {
        settings: {},
        resolved: profiles,
        onsave: vi.fn(),
        onreset: vi.fn(),
      },
    });
    expect(screen.getByRole('heading', { name: 'Assistant' })).toBeVisible();
    expect(
      screen.getByText('Claude Code · strongest model · maximum effort'),
    ).toBeVisible();
    expect(
      screen.queryByText(/claude-code · fable · max/),
    ).not.toBeInTheDocument();
    const details = container.querySelector('details');
    expect(details).not.toHaveAttribute('open');
    expect(screen.getAllByLabelText('Model')[0]).not.toBeVisible();
    await userEvent.setup().click(screen.getAllByText('Advanced')[0]);
    expect(details).toHaveAttribute('open');
    expect(screen.getAllByLabelText('Model')[0]).toBeVisible();
    expect(within(details as HTMLElement).getAllByText('fable')).toHaveLength(
      2,
    );
    expect(
      screen.getAllByLabelText('Reply time limit (seconds)')[0],
    ).toBeVisible();
    expect(
      screen.queryByText(/milliseconds|Structured output repair attempts/),
    ).not.toBeInTheDocument();
    await expectNoA11yViolations(container);
  });

  it('never calls a custom, unknown or remembered fallback model strongest', async () => {
    const profile = resolveWorkProfile({
      profile: 'design',
      engine: 'claude-code',
    });
    const { rerender, container } = render(WorkProfileSettings, {
      props: {
        settings: {},
        resolved: [
          {
            ...profile,
            modelSelection: {
              kind: 'fallback',
              requestedModel: 'fable',
              resolvedModel: 'opus',
            },
          },
        ],
        onsave: vi.fn(),
        onreset: vi.fn(),
      },
    });
    expect(
      screen.getByText('Claude Code · fallback model · maximum effort'),
    ).toBeVisible();
    expect(screen.queryByText(/strongest model/)).not.toBeInTheDocument();
    await userEvent.setup().click(screen.getByText('Advanced'));
    expect(
      within(container.querySelector('details') as HTMLElement).getByText(
        'opus',
      ),
    ).toBeVisible();
    expect(
      within(container.querySelector('details') as HTMLElement).getByText(
        'fable',
      ),
    ).toBeVisible();
    await rerender({
      resolved: [
        resolveWorkProfile({
          profile: 'design',
          engine: 'claude-code',
          settings: { model: 'my-model' },
        }),
      ],
    });
    expect(
      screen.getByText('Claude Code · custom model · maximum effort'),
    ).toBeVisible();
    await rerender({ resolved: [{ ...profile, modelSelection: undefined }] });
    expect(
      screen.getByText('Claude Code · configured model · maximum effort'),
    ).toBeVisible();
    await rerender({
      resolved: [resolveWorkProfile({ profile: 'design', engine: 'api' })],
    });
    expect(
      screen.getByText('your API key · provider default · maximum effort'),
    ).toBeVisible();
    expect(screen.queryByText(/strongest model/)).not.toBeInTheDocument();
  });

  it.each([
    [12345, '12.345'],
    [1001, '1.001'],
    [Number.MAX_SAFE_INTEGER, '9007199254740.991'],
  ] as const)('round trips %i stored milliseconds through human seconds exactly', async (milliseconds, seconds) => {
    const onsave = vi.fn(async () => {});
    render(WorkProfileSettings, {
      props: {
        settings: { design: { budgets: { requestTimeoutMs: milliseconds } } },
        resolved,
        onsave,
        onreset: vi.fn(),
      },
    });
    const user = userEvent.setup();
    await user.click(screen.getAllByText('Advanced')[0]);
    const input = screen.getAllByLabelText(
      'Reply time limit (seconds)',
    )[0] as HTMLInputElement;
    expect(input.value).toBe(seconds);
    await user.clear(input);
    await user.type(input, seconds);
    await user.tab();
    await user.click(
      screen.getByRole('button', { name: 'Save assistant settings' }),
    );
    expect(onsave).toHaveBeenCalledExactlyOnceWith({
      design: { budgets: { requestTimeoutMs: milliseconds } },
    });
  });

  it.each([
    '0.0001',
    'not a time',
  ])('refuses invalid duration %s without rounding or saving a different owner budget', async (invalidValue) => {
    const onsave = vi.fn(async () => {});
    render(WorkProfileSettings, {
      props: { settings: {}, resolved, onsave, onreset: vi.fn() },
    });
    const user = userEvent.setup();
    await user.click(screen.getAllByText('Advanced')[0]);
    const input = screen.getAllByLabelText('Reply time limit (seconds)')[0];
    await user.clear(input);
    await user.type(input, invalidValue);
    await user.tab();
    expect(screen.getByRole('alert')).toHaveTextContent(
      'at most three decimal places',
    );
    expect(
      screen.getByRole('button', { name: 'Save assistant settings' }),
    ).toBeDisabled();
    expect(onsave).not.toHaveBeenCalled();
    await user.clear(input);
    await user.type(input, '1.001');
    await user.tab();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    await user.click(
      screen.getByRole('button', { name: 'Save assistant settings' }),
    );
    expect(onsave).toHaveBeenCalledExactlyOnceWith({
      design: { budgets: { requestTimeoutMs: 1001 } },
    });
  });

  it('saves untouched recommendations without materializing a fixed pass count', async () => {
    const onsave = vi.fn(async () => {});
    render(WorkProfileSettings, {
      props: { settings: {}, resolved, onsave, onreset: vi.fn() },
    });
    await userEvent
      .setup()
      .click(screen.getByRole('button', { name: 'Save assistant settings' }));
    expect(onsave).toHaveBeenCalledExactlyOnceWith({});
  });

  it('keeps unrelated effort and preview edits sparse for host sizing', async () => {
    const onsave = vi.fn(async () => {});
    render(WorkProfileSettings, {
      props: { settings: {}, resolved, onsave, onreset: vi.fn() },
    });
    const user = userEvent.setup();
    await user.click(screen.getAllByText('Advanced')[0]);
    await user.selectOptions(
      screen.getAllByRole('combobox', { name: 'Reasoning effort' })[0],
      'high',
    );
    await user.click(
      screen.getAllByRole('checkbox', {
        name: 'Preview before applying design changes',
      })[0],
    );
    await user.click(
      screen.getByRole('button', { name: 'Save assistant settings' }),
    );
    expect(onsave).toHaveBeenCalledExactlyOnceWith({
      design: { effort: 'high', previewBeforeApply: false },
    });
  });

  it.each([
    2, 4,
  ])('preserves an explicit %i-pass override across an unrelated edit', async (passes) => {
    const onsave = vi.fn(async () => {});
    render(WorkProfileSettings, {
      props: {
        settings: { design: { budgets: { passes } } },
        resolved,
        onsave,
        onreset: vi.fn(),
      },
    });
    const user = userEvent.setup();
    await user.click(
      screen.getAllByRole('checkbox', {
        name: 'Preview before applying design changes',
      })[0],
    );
    await user.click(
      screen.getByRole('button', { name: 'Save assistant settings' }),
    );
    expect(onsave).toHaveBeenCalledExactlyOnceWith({
      design: { budgets: { passes }, previewBeforeApply: false },
    });
  });

  it('saves sparse recommendations after the authorized reset returns no overrides', async () => {
    const onsave = vi.fn(async () => {});
    const onreset = vi.fn(async () => {});
    const { rerender } = render(WorkProfileSettings, {
      props: {
        settings: { design: { budgets: { passes: 2 } } },
        resolved,
        onsave,
        onreset,
      },
    });
    const user = userEvent.setup();
    await user.click(
      screen.getByRole('button', { name: 'Reset to recommended' }),
    );
    expect(onreset).toHaveBeenCalledOnce();
    await rerender({ settings: {}, resolved, onsave, onreset });
    await user.click(
      screen.getByRole('button', { name: 'Save assistant settings' }),
    );
    expect(onsave).toHaveBeenCalledExactlyOnceWith({});
  });

  it('edits budgets and escalation, saves overrides and resets recommendations', async () => {
    const onsave = vi.fn(async () => {});
    const onreset = vi.fn(async () => {});
    const { container } = render(WorkProfileSettings, {
      props: { settings: {}, resolved, onsave, onreset },
    });
    const user = userEvent.setup();
    await user.click(screen.getAllByText('Advanced')[0]);
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
      screen.getByRole('button', { name: 'Save assistant settings' }),
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
      .click(screen.getByRole('button', { name: 'Save assistant settings' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(
      'The change could not be saved.',
    );
    expect(screen.queryByText('private')).not.toBeInTheDocument();
  });
});
