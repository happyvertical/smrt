// @vitest-environment jsdom
import {
  expectNoA11yViolations,
  render,
  screen,
  userEvent,
} from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it, vi } from 'vitest';
import ProjectQuestionsAndDecisions from '../../ProjectQuestionsAndDecisions.svelte';

describe('ProjectQuestionsAndDecisions', () => {
  it('submits owner answers and decisions with optimistic revisions', async () => {
    const onanswer = vi.fn();
    const ondecide = vi.fn();
    const { container } = render(ProjectQuestionsAndDecisions, {
      props: {
        questions: [
          {
            id: 'q1',
            prompt: 'Who owns launch approval?',
            status: 'open',
            ownerLabel: 'Alex',
            revision: 3,
            canResolve: true,
            contextReferences: [
              { kind: 'spec', ref: 'launch', label: 'Launch section' },
            ],
          },
        ],
        decisions: [
          {
            id: 'd1',
            question: 'How should customers authenticate?',
            status: 'open',
            revision: 5,
            canResolve: true,
            options: [
              { id: 'magic-link', label: 'Magic link' },
              { id: 'password', label: 'Password' },
            ],
          },
        ],
        onanswer,
        ondecide,
      },
    });

    await userEvent.type(
      screen.getByLabelText('Answer'),
      'The delivery owner.',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Save answer' }));
    expect(onanswer).toHaveBeenCalledWith({
      id: 'q1',
      answer: 'The delivery owner.',
      expectedRevision: 3,
    });

    await userEvent.selectOptions(
      screen.getByLabelText('Outcome'),
      'magic-link',
    );
    await userEvent.type(screen.getByLabelText('Rationale'), 'Lower friction.');
    await userEvent.click(
      screen.getByRole('button', { name: 'Record decision' }),
    );
    expect(ondecide).toHaveBeenCalledWith({
      id: 'd1',
      outcome: 'magic-link',
      rationale: 'Lower friction.',
      expectedRevision: 5,
    });
    await expectNoA11yViolations(container);
  });

  it('shows recorded outcomes without offering actions to unauthorized viewers', () => {
    render(ProjectQuestionsAndDecisions, {
      props: {
        questions: [
          {
            id: 'q1',
            prompt: 'What is the launch date?',
            answer: 'November 1',
            status: 'answered',
            revision: 2,
          },
        ],
        decisions: [
          {
            id: 'd1',
            question: 'Which authentication method?',
            outcome: 'magic-link',
            rationale: 'Lower friction.',
            status: 'decided',
            revision: 2,
            options: [{ id: 'magic-link', label: 'Magic link' }],
          },
        ],
      },
    });
    expect(screen.getByText('November 1')).toBeVisible();
    expect(screen.getByText('Magic link')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Save answer' })).toBeNull();
    expect(
      screen.queryByRole('button', { name: 'Record decision' }),
    ).toBeNull();
  });
});

it('automatically emits static analytics only after persisted question/decision status updates', async () => {
  const emit = vi.fn();
  const questions = [
    {
      id: 'private-q',
      prompt: 'Private prompt',
      status: 'open' as const,
      revision: 1,
    },
  ];
  const decisions = [
    {
      id: 'private-d',
      question: 'Private question',
      status: 'open' as const,
      revision: 1,
    },
  ];
  const view = render(ProjectQuestionsAndDecisions, {
    props: { questions, decisions },
    context: new Map([[Symbol.for('@happyvertical/smrt-ui/analytics'), emit]]),
  });
  expect(emit).not.toHaveBeenCalled();
  await view.rerender({ questions, decisions, busy: false });
  expect(emit).not.toHaveBeenCalled();
  const answered = questions.map((row) => ({
    ...row,
    status: 'answered' as const,
    answer: 'Private answer',
    revision: 2,
  }));
  const decided = decisions.map((row) => ({
    ...row,
    status: 'decided' as const,
    outcome: 'Private outcome',
    revision: 2,
  }));
  await view.rerender({ questions: answered, decisions: decided });
  await view.rerender({ questions: answered, decisions: decided });
  expect(emit.mock.calls).toEqual([
    ['project_question_answered', undefined],
    ['project_decision_resolved', undefined],
  ]);
});

it('requires explicit choice, displays recommendation only, and always offers Other text', async () => {
  const onanswer = vi.fn();
  const { container } = render(ProjectQuestionsAndDecisions, {
    props: {
      questions: [
        {
          id: 'choices',
          prompt: 'How often?',
          status: 'open',
          revision: 1,
          canResolve: true,
          options: [
            { id: '15min', label: '15 minutes', recommended: true },
            { id: 'hourly', label: 'Hourly' },
          ],
        },
      ],
      onanswer,
    },
  });
  const radios = screen.getAllByRole('radio') as HTMLInputElement[];
  expect(radios).toHaveLength(3);
  expect(radios.every((radio) => !radio.checked)).toBe(true);
  expect(screen.getByLabelText('Other answer')).toBeVisible();
  expect(screen.getByText('Recommended')).toBeVisible();
  expect(onanswer).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Save answer' }));
  expect(onanswer).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('radio', { name: /15 minutes/ }));
  expect(onanswer).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Save answer' }));
  expect(onanswer).toHaveBeenLastCalledWith({
    id: 'choices',
    answer: '15 minutes',
    selectedOptionId: '15min',
    expectedRevision: 1,
  });
  onanswer.mockClear();
  await userEvent.click(
    screen.getByRole('radio', { name: 'Other', exact: true }),
  );
  await userEvent.click(screen.getByRole('button', { name: 'Save answer' }));
  expect(onanswer).not.toHaveBeenCalled();
  await userEvent.type(screen.getByLabelText('Other answer'), 'Twice daily');
  await userEvent.click(screen.getByRole('button', { name: 'Save answer' }));
  expect(onanswer).toHaveBeenCalledWith({
    id: 'choices',
    answer: 'Twice daily',
    selectedOptionId: 'other',
    expectedRevision: 1,
  });
  await expectNoA11yViolations(container);
});
