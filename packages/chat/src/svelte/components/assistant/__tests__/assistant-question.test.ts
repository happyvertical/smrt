// @vitest-environment jsdom
/**
 * Structured questions (#4100): an assistant message can carry a question
 * that the dock renders as a small form; submitting answers it through the
 * transport (no message round-trip), or as a message when the transport has
 * no `answerQuestion`; a typed reply resolves against the options.
 */
import { createDataSurfaceRegistry } from '@happyvertical/smrt-ui/data-surface';
import { render, screen, userEvent } from '@happyvertical/smrt-vitest/svelte';
import { describe, expect, it } from 'vitest';
import AssistantDock from '../AssistantDock.svelte';
import {
  type AssistantAnswerQuestionInput,
  type AssistantQuestion,
  assistantQuestionFromMessage,
  describeAssistantQuestionAnswer,
  matchAssistantQuestionText,
  parseAssistantQuestion,
} from '../assistant-question.js';
import type {
  AssistantMessage,
  AssistantSendMessageInput,
  AssistantTransport,
} from '../assistant-transport.js';
import type { createAssistantDockController } from '../create-assistant-dock-controller.svelte.js';

const QUESTION: AssistantQuestion = {
  kind: 'assistant-question',
  id: 'q1',
  prompt: 'Group invoices by…',
  fields: [
    {
      name: 'groupBy',
      label: 'Group by',
      type: 'choice',
      options: [
        {
          value: 'issueDate:month',
          label: 'Issue date by month',
          keywords: ['monthly'],
        },
        { value: 'issueDate:week', label: 'Issue date by week' },
        { value: 'status', label: 'Status' },
        { value: 'customerId', label: 'Customer' },
      ],
      default: 'issueDate:month',
    },
  ],
};

function message(
  id: string,
  role: AssistantMessage['role'],
  content: string,
  toolCallData?: unknown,
): AssistantMessage {
  return {
    id,
    threadId: 't1',
    role,
    content,
    createdAt: new Date(0).toISOString(),
    ...(toolCallData ? { toolCallData } : {}),
  };
}

function transport(withAnswer: boolean) {
  const sent: AssistantSendMessageInput[] = [];
  const answered: AssistantAnswerQuestionInput[] = [];
  const base: AssistantTransport = {
    async listThreads() {
      return [{ id: 't1', title: 'T', isResolved: false, messageCount: 0 }];
    },
    async loadMessages() {
      return [];
    },
    async sendMessage(input) {
      sent.push(input);
      return {
        inProgress: false,
        userMessage: message(`u${sent.length}`, 'user', input.content),
        assistantMessage: message(
          `a${sent.length}`,
          'assistant',
          sent.length === 1 ? 'How should I group them?' : 'Here it is.',
          sent.length === 1 ? [{ other: true }, QUESTION] : undefined,
        ),
      };
    },
    ...(withAnswer
      ? {
          async answerQuestion(input: AssistantAnswerQuestionInput) {
            answered.push(input);
            return {
              inProgress: false,
              assistantMessage: message('a-answer', 'assistant', 'Grouped.'),
            };
          },
        }
      : {}),
  };
  return { transport: base, sent, answered };
}

async function until(check: () => boolean) {
  for (let i = 0; i < 50 && !check(); i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function mount(withAnswer: boolean) {
  const t = transport(withAnswer);
  let controller: ReturnType<typeof createAssistantDockController> | undefined;
  render(AssistantDock, {
    props: {
      transport: t.transport,
      registry: createDataSurfaceRegistry(),
      oncontroller: (c: ReturnType<typeof createAssistantDockController>) => {
        controller = c;
      },
    },
  });
  await until(() => Boolean(controller));
  await controller?.openThread('t1');
  await controller?.send('sales report');
  await until(
    () => screen.queryByRole('group', { name: /Group invoices/ }) !== null,
  );
  return { ...t, controller };
}

describe('question helpers', () => {
  it('validates question data and finds it among tool data', () => {
    expect(parseAssistantQuestion({ ...QUESTION, kind: 'other' })).toBeNull();
    expect(
      parseAssistantQuestion({
        ...QUESTION,
        fields: [{ ...QUESTION.fields[0], options: [] }],
      }),
    ).toBeNull();
    expect(
      assistantQuestionFromMessage({ toolCallData: [{ x: 1 }, QUESTION] })?.id,
    ).toBe('q1');
  });

  it('resolves typed replies against the options', () => {
    const match = (text: string) =>
      matchAssistantQuestionText(QUESTION, text)?.groupBy;
    expect(match('the date month')).toBe('issueDate:month');
    expect(match('monthly')).toBe('issueDate:month');
    expect(match('by issue date')).toBe('issueDate:month');
    expect(match('weeks')).toBe('issueDate:week');
    expect(match('status')).toBe('status');
    expect(match('by customers please')).toBe('customerId');
    expect(matchAssistantQuestionText(QUESTION, 'banana')).toBeNull();
  });

  it('describes an answer in one line', () => {
    expect(
      describeAssistantQuestionAnswer(QUESTION, { groupBy: 'status' }),
    ).toBe('Group by: Status');
  });
});

describe('dock question form', () => {
  it('renders a fieldset with the default chosen and focus in the form', async () => {
    await mount(true);
    const form = screen.getByRole('group', { name: /Group invoices/ });
    expect(form.tagName).toBe('FIELDSET');
    const monthly = screen.getByRole('radio', { name: 'Issue date by month' });
    expect((monthly as HTMLInputElement).checked).toBe(true);
    await until(() => document.activeElement === monthly);
    expect(document.activeElement).toBe(monthly);
  });

  it('submits through answerQuestion, not as a message, then shows a summary', async () => {
    const { sent, answered } = await mount(true);
    await userEvent.click(screen.getByRole('radio', { name: 'Status' }));
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await until(() => answered.length > 0);
    expect(answered[0]).toMatchObject({
      messageId: 'a1',
      questionId: 'q1',
      values: { groupBy: 'status' },
    });
    expect(sent).toHaveLength(1);
    await until(() => screen.queryByText('Grouped.') !== null);
    expect(screen.queryByRole('radio')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent('Group by: Status');
  });

  it('sends the answer as a message when the transport cannot take it', async () => {
    const { sent } = await mount(false);
    await userEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await until(() => sent.length > 1);
    expect(sent[1].content).toBe('Group by: Issue date by month');
  });
});
