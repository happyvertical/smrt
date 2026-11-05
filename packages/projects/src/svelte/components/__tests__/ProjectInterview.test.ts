// @vitest-environment jsdom
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ProjectInterview from '../../ProjectInterview.svelte';
import type {
  ProjectDecisionView,
  ProjectQuestionView,
} from '../../project-governance-types.js';

const question = (
  id: string,
  prompt: string,
  extra: Partial<ProjectQuestionView> = {},
): ProjectQuestionView => ({
  id,
  prompt,
  status: 'open',
  revision: 1,
  canResolve: true,
  ...extra,
});

const decision = (
  id: string,
  text: string,
  extra: Partial<ProjectDecisionView> = {},
): ProjectDecisionView => ({
  id,
  question: text,
  status: 'open',
  revision: 4,
  canResolve: true,
  ...extra,
});

function mockMatchMedia(reduce: boolean) {
  vi.stubGlobal(
    'matchMedia',
    vi.fn((query: string) => ({
      matches: query.includes('reduce') ? reduce : !reduce,
      media: query,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('ProjectInterview', () => {
  it('asks one record at a time with framing, recommended option first, and advances after the host persists', async () => {
    const onanswer = vi.fn();
    const onadvance = vi.fn();
    const questions = [
      question('q1', 'Who approves the launch?'),
      question('q2', 'How often should we report?', {
        options: [
          { id: 'monthly', label: 'Monthly' },
          { id: 'weekly', label: 'Weekly' },
        ],
      }),
    ];
    const view = render(ProjectInterview, {
      props: {
        questions,
        framing: {
          q1: {
            why: 'Launch needs one owner.',
            unblocks: ['Launch checklist'],
          },
          q2: { recommendedOptionId: 'weekly' },
        },
        onanswer,
        onadvance,
      },
    });

    expect(
      screen.getByRole('heading', { name: 'Who approves the launch?' }),
    ).toBeVisible();
    expect(screen.queryByText('How often should we report?')).toBeNull();
    expect(screen.getByText('Launch needs one owner.')).toBeVisible();
    expect(
      screen.getByRole('list', { name: 'What this unblocks' }),
    ).toHaveTextContent('Launch checklist');
    expect(screen.getByText(/Question 1 of 2/)).toBeVisible();
    await expectNoA11yViolations(view.container);

    await userEvent.type(screen.getByLabelText('Your answer'), 'Priya');
    await userEvent.click(
      screen.getByRole('button', { name: 'Save and continue' }),
    );
    expect(onanswer).toHaveBeenCalledWith({
      id: 'q1',
      answer: 'Priya',
      expectedRevision: 1,
    });
    // Still on q1 until the host reports the persisted status.
    expect(
      screen.getByRole('heading', { name: 'Who approves the launch?' }),
    ).toBeVisible();

    await view.rerender({
      questions: [
        { ...questions[0], status: 'answered', answer: 'Priya', revision: 2 },
        questions[1],
      ],
    });
    const next = await screen.findByRole('heading', {
      name: 'How often should we report?',
    });
    await vi.waitFor(() => expect(next).toHaveFocus());
    expect(onadvance).toHaveBeenLastCalledWith({
      index: 1,
      total: 2,
      id: 'q2',
      kind: 'question',
      reason: 'answered',
    });
    expect(screen.getByText(/1 of 2 answered/)).toBeVisible();
    const radios = screen.getAllByRole('radio') as HTMLInputElement[];
    expect(radios.map((radio) => radio.value)).toEqual([
      'weekly',
      'monthly',
      'other',
    ]);
    expect(radios.every((radio) => !radio.checked)).toBe(true);
    expect(screen.getByText('Recommended')).toBeVisible();
    await expectNoA11yViolations(view.container);
  });

  it('skips without answering, goes back, and offers skipped records from the remaining state', async () => {
    const onanswer = vi.fn();
    const ondecide = vi.fn();
    const onadvance = vi.fn();
    render(ProjectInterview, {
      props: {
        questions: [question('q1', 'First question?')],
        decisions: [
          decision('d1', 'Which login method?', {
            options: [
              { id: 'password', label: 'Password' },
              { id: 'magic', label: 'Magic link' },
            ],
          }),
        ],
        framing: { d1: { recommendedOptionId: 'magic' } },
        onanswer,
        ondecide,
        onadvance,
      },
    });

    await userEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(onanswer).not.toHaveBeenCalled();
    expect(
      screen.getByRole('heading', { name: 'Which login method?' }),
    ).toHaveFocus();
    expect(
      (screen.getAllByRole('radio') as HTMLInputElement[]).map((r) => r.value),
    ).toEqual(['magic', 'password']);

    await userEvent.click(screen.getByRole('button', { name: 'Back' }));
    expect(
      screen.getByRole('heading', { name: 'First question?' }),
    ).toHaveFocus();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();

    await userEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    await userEvent.click(screen.getByRole('radio', { name: /Magic link/ }));
    await userEvent.type(
      screen.getByLabelText('Anything to add? (optional)'),
      'Fewer passwords.',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Save and continue' }),
    );
    expect(ondecide).toHaveBeenCalledWith({
      id: 'd1',
      outcome: 'magic',
      rationale: 'Fewer passwords.',
      expectedRevision: 4,
    });

    await userEvent.click(screen.getByRole('button', { name: 'Skip for now' }));
    expect(screen.getByRole('heading', { name: 'Almost there' })).toHaveFocus();
    expect(
      screen.getByText('2 skipped and still waiting for an answer.'),
    ).toBeVisible();
    expect(onadvance).toHaveBeenLastCalledWith({
      index: 2,
      total: 2,
      id: null,
      kind: null,
      reason: 'skip',
    });

    await userEvent.click(
      screen.getByRole('button', { name: 'Answer skipped questions' }),
    );
    expect(
      screen.getByRole('heading', { name: 'First question?' }),
    ).toHaveFocus();
  });

  it('is keyboard operable end to end and reaches the completion state', async () => {
    const onanswer = vi.fn();
    const q = question('q1', 'Pick a colour', {
      options: [
        { id: 'blue', label: 'Blue' },
        { id: 'green', label: 'Green', recommended: true },
      ],
    });
    const view = render(ProjectInterview, {
      props: { questions: [q], onanswer },
    });

    // Tab into the radio group; the recommended option is first.
    await userEvent.tab();
    expect(screen.getByRole('radio', { name: /Green/ })).toHaveFocus();
    await userEvent.keyboard(' ');
    expect(screen.getByRole('radio', { name: /Green/ })).toBeChecked();
    await userEvent.keyboard('{Enter}');
    expect(onanswer).toHaveBeenCalledWith({
      id: 'q1',
      answer: 'Green',
      selectedOptionId: 'green',
      expectedRevision: 1,
    });

    await view.rerender({
      questions: [{ ...q, status: 'answered', answer: 'Green', revision: 2 }],
    });
    const done = await screen.findByRole('heading', { name: 'All done' });
    await vi.waitFor(() => expect(done).toHaveFocus());
    expect(screen.getByText(/1 of 1 answered/)).toBeVisible();
    await userEvent.tab();
    expect(screen.getByRole('button', { name: 'Back' })).toHaveFocus();
    await userEvent.keyboard('{Enter}');
    expect(
      screen.getByRole('heading', { name: 'Pick a colour' }),
    ).toHaveFocus();
    expect(screen.getByText('Green')).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Save and continue' }),
    ).toBeNull();
    await expectNoA11yViolations(view.container);
  });

  it('honours startIndex, shows read-only records the viewer cannot resolve, and respects busy', () => {
    render(ProjectInterview, {
      props: {
        questions: [
          question('q1', 'First?'),
          question('q2', 'Second?', { canResolve: false }),
        ],
        startIndex: 1,
        busy: true,
      },
    });
    expect(screen.getByRole('heading', { name: 'Second?' })).toBeVisible();
    expect(
      screen.getByText('Someone else on the project answers this one.'),
    ).toBeVisible();
    expect(
      screen.queryByRole('button', { name: 'Save and continue' }),
    ).toBeNull();
    expect(screen.getByRole('button', { name: 'Back' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Skip for now' })).toBeDisabled();
  });

  it('keeps a decision option whose id is other selectable', async () => {
    const ondecide = vi.fn();
    render(ProjectInterview, {
      props: {
        decisions: [
          decision('d1', 'Which hosting?', {
            options: [
              { id: 'cloud', label: 'Cloud' },
              { id: 'other', label: 'Something else' },
            ],
          }),
        ],
        ondecide,
      },
    });
    await userEvent.click(
      screen.getByRole('radio', { name: 'Something else' }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Save and continue' }),
    );
    expect(ondecide).toHaveBeenCalledWith({
      id: 'd1',
      outcome: 'other',
      rationale: '',
      expectedRevision: 4,
    });
  });

  it('resumes from the latest position when the host removes earlier and then submitted records', async () => {
    const onanswer = vi.fn();
    const q1 = question('q1', 'One?');
    const q2 = question('q2', 'Two?');
    const q3 = question('q3', 'Three?');
    const view = render(ProjectInterview, {
      props: { questions: [q1, q2, q3], startIndex: 1, onanswer },
    });
    expect(screen.getByRole('heading', { name: 'Two?' })).toBeVisible();
    await view.rerender({ questions: [q2, q3] });
    await userEvent.type(screen.getByLabelText('Your answer'), 'Yes');
    await userEvent.click(
      screen.getByRole('button', { name: 'Save and continue' }),
    );
    expect(onanswer).toHaveBeenCalledTimes(1);
    await view.rerender({ questions: [q3] });
    expect(
      await screen.findByRole('heading', { name: 'Three?' }),
    ).toBeVisible();
  });

  it('shows an empty state with no records', () => {
    render(ProjectInterview, { props: {} });
    expect(
      screen.getByText('There is nothing to answer right now.'),
    ).toBeVisible();
  });

  it('enables motion only when the browser has no reduced-motion preference', () => {
    mockMatchMedia(true);
    const reduced = render(ProjectInterview, {
      props: { questions: [question('q1', 'Q?')] },
    });
    expect(
      reduced.container.querySelector(
        '[data-smrt-component="ProjectInterview"]',
      ),
    ).toHaveAttribute('data-motion', 'off');
    reduced.unmount();

    mockMatchMedia(false);
    const motion = render(ProjectInterview, {
      props: { questions: [question('q1', 'Q?')] },
    });
    expect(
      motion.container.querySelector(
        '[data-smrt-component="ProjectInterview"]',
      ),
    ).toHaveAttribute('data-motion', 'on');
  });
});
