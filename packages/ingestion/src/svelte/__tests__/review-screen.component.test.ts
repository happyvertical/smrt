import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ProposalCatalogEntry } from '../../proposal-dto.js';
import type { ItemReviewView, ReviewAction } from '../../review-dto.js';
import { argumentFields } from '../argument-fields.js';
import { IntakeInbox, IntakeReview } from '../index.js';
import { displayEntries } from '../view-utils.js';
import { entry, host, view } from './review-fixtures.js';

afterEach(cleanup);
const HANDLER = 'teamworks:vendor-bill.record';
function catalogEntry(
  extra: Partial<ProposalCatalogEntry> = {},
): ProposalCatalogEntry {
  return {
    id: HANDLER,
    version: '1',
    description: 'Record a vendor bill',
    kind: 'operation',
    capability: null,
    argsSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['vendorId', 'total'],
      properties: {
        vendorId: { type: 'string' },
        memo: { type: 'string', title: 'Memo' },
        total: { type: 'integer', title: 'Total (cents)' },
        paid: { type: 'boolean', title: 'Paid' },
        dueOn: { type: 'string', format: 'date', title: 'Due' },
        currency: { type: 'string', enum: ['CAD', 'USD'], title: 'Currency' },
        lines: { type: 'array', items: { type: 'object' } },
      },
    },
    references: { vendorId: { kind: 'candidate', model: 'Vendor' } },
    operation: { model: 'Bill', action: 'create', version: '1' },
    ...extra,
  };
}
function action(extra: Partial<ReviewAction> = {}): ReviewAction {
  return {
    review: {
      actionId: 'action',
      proposalId: 'proposal',
      revision: 2,
      reviewVersion: 4,
      bindingHash: 'binding',
      display: { Vendor: 'Acme Supply', Total: '$12.50', Lines: 2 } as never,
      state: 'waiting_review',
    },
    args: { vendorId: 'vendor-uuid', total: 1250, currency: 'CAD' },
    handlerId: HANDLER,
    handlerVersion: '1',
    ...extra,
  };
}
function reviewView(
  options: { label?: string; schema?: boolean; act?: ReviewAction } = {},
): ItemReviewView {
  const current = view('item', 'waiting');
  const handler =
    options.schema === false
      ? catalogEntry({ argsSchema: {}, references: {} })
      : catalogEntry();
  current.catalog = [
    { ...handler, ...(options.label ? { label: options.label } : {}) },
  ];
  current.generation!.offered = [
    {
      handler,
      candidates: [
        {
          key: 'vendor-key',
          model: 'Vendor',
          id: 'vendor-uuid',
          revision: '1',
          label: 'Acme Supply',
        },
      ],
    },
  ];
  current.generation!.suggestions = [
    {
      handlerId: HANDLER,
      handlerVersion: '1',
      args: { vendorId: 'vendor-uuid', total: 1250 },
      evidence: [],
      alternatives: [],
      missingFields: [],
      explanation: 'A vendor bill.',
      disposition: 'ready_for_review',
    },
  ];
  current.reviews.actions = [options.act ?? action()];
  return current;
}
const advanced = () =>
  screen.getByRole('textbox', {
    name: 'Exact arguments (JSON)',
  }) as HTMLTextAreaElement;

describe('handler display labels (#4503)', () => {
  it('draws the catalog label in the proposal heading, the action heading and the start select', async () => {
    const callbacks = host(() => reviewView({ label: 'Record vendor bill' }), {
      startAction: vi.fn(async () => {}),
    });
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    expect(
      await screen.findAllByRole('heading', { name: 'Record vendor bill' }),
    ).toHaveLength(2);
    expect(screen.queryByRole('heading', { name: HANDLER })).toBeNull();
    expect(
      screen.getByRole('option', { name: 'Record vendor bill' }),
    ).toBeTruthy();
  });
  it('falls back to the handler id', async () => {
    render(IntakeReview, { host: host(() => reviewView()), itemId: 'item' });
    expect(
      await screen.findAllByRole('heading', { name: HANDLER }),
    ).toHaveLength(2);
  });
});

describe('state labels (#4503)', () => {
  it('draws review states and generation outcomes through i18n keys, raw only when unknown', async () => {
    render(IntakeReview, { host: host(() => reviewView()), itemId: 'item' });
    expect((await screen.findByTestId('review-state')).textContent).toBe(
      'State: Waiting for review',
    );
    expect(screen.getByTestId('generation-outcome').textContent).toBe(
      'Suggestions ready',
    );
    cleanup();
    const odd = action();
    odd.review.state = 'some_new_state';
    render(IntakeReview, {
      host: host(() => reviewView({ act: odd })),
      itemId: 'item',
    });
    expect((await screen.findByTestId('review-state')).textContent).toBe(
      'State: some_new_state',
    );
  });
});

describe('arguments as fields (#4503)', () => {
  it('derives fields from supported top-level schema properties', () => {
    expect(
      argumentFields(catalogEntry().argsSchema, catalogEntry().references),
    ).toEqual([
      {
        name: 'vendorId',
        title: 'vendorId',
        required: true,
        kind: 'candidate',
        model: 'Vendor',
      },
      { name: 'memo', title: 'Memo', required: false, kind: 'text' },
      {
        name: 'total',
        title: 'Total (cents)',
        required: true,
        kind: 'integer',
      },
      { name: 'paid', title: 'Paid', required: false, kind: 'boolean' },
      { name: 'dueOn', title: 'Due', required: false, kind: 'date' },
      {
        name: 'currency',
        title: 'Currency',
        required: false,
        kind: 'enum',
        options: ['CAD', 'USD'],
      },
    ]);
    expect(
      argumentFields({
        properties: {
          at: { type: ['string', 'null'], format: 'date-time' },
          rate: { type: 'number', minimum: 0 },
        },
      }),
    ).toEqual([
      { name: 'at', title: 'at', required: false, kind: 'date-time' },
      {
        name: 'rate',
        title: 'rate',
        required: false,
        kind: 'number',
        minimum: 0,
      },
    ]);
    expect(argumentFields({})).toEqual([]);
  });
  it('edits the arguments through fields, keeps JSON under a collapsed Advanced, and labels references', async () => {
    const callbacks = host(() => reviewView());
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const fields = await screen.findByTestId('argument-fields');
    const details = screen.getByTestId(
      'advanced-arguments',
    ) as HTMLDetailsElement;
    expect(details.open).toBe(false);
    expect(within(details).getByRole('textbox')).toBe(advanced());
    // The reference shows the candidate's label, not its UUID.
    expect(
      (
        within(fields).getByRole('combobox', {
          name: 'vendorId *',
        }) as HTMLInputElement
      ).value,
    ).toBe('Acme Supply');
    const total = within(fields).getByRole('spinbutton', {
      name: 'Total (cents) *',
    }) as HTMLInputElement;
    expect(total.value).toBe('1250');
    await fireEvent.input(total, { target: { value: '1300' } });
    await fireEvent.input(
      within(fields).getByRole('textbox', { name: 'Memo' }),
      {
        target: { value: 'March' },
      },
    );
    await fireEvent.click(
      within(fields).getByRole('checkbox', { name: 'Paid' }),
    );
    await fireEvent.input(within(fields).getByLabelText('Due'), {
      target: { value: '2026-11-30' },
    });
    await fireEvent.change(
      within(fields).getByRole('combobox', { name: 'Currency' }),
      {
        target: { value: 'USD' },
      },
    );
    await waitFor(() =>
      expect(JSON.parse(advanced().value)).toEqual({
        vendorId: 'vendor-uuid',
        total: 1300,
        currency: 'USD',
        memo: 'March',
        paid: true,
        dueOn: '2026-11-30',
      }),
    );
    // Edited arguments need a new review, sent as corrected arguments.
    await fireEvent.click(
      screen.getByRole('button', { name: 'Save edits for new review' }),
    );
    await waitFor(() =>
      expect(callbacks.decide).toHaveBeenCalledWith(
        expect.objectContaining({
          decision: 'correct',
          correctedArgs: expect.objectContaining({ total: 1300, paid: true }),
        }),
      ),
    );
  });
  it('searches a reference field and stores the chosen id', async () => {
    const callbacks = host(() => reviewView());
    vi.mocked(callbacks.candidates).mockResolvedValue({
      items: [
        {
          key: 'k2',
          model: 'Vendor',
          id: 'other-uuid',
          revision: '1',
          label: 'Bolt Hardware',
        },
        {
          key: 'k3',
          model: 'Customer',
          id: 'customer-uuid',
          revision: '1',
          label: 'Not a vendor',
        },
      ],
      truncated: false,
    });
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const vendor = (await screen.findByRole('combobox', {
      name: 'vendorId *',
    })) as HTMLInputElement;
    await fireEvent.input(vendor, { target: { value: 'Bol' } });
    await waitFor(() =>
      expect(callbacks.candidates).toHaveBeenCalledWith({
        itemId: 'item',
        handlerId: HANDLER,
        handlerVersion: '1',
        query: 'Bol',
      }),
    );
    expect(screen.queryByRole('option', { name: 'Not a vendor' })).toBeNull();
    await fireEvent.click(
      await screen.findByRole('option', { name: 'Bolt Hardware' }),
    );
    await waitFor(() =>
      expect(JSON.parse(advanced().value).vendorId).toBe('other-uuid'),
    );
    expect(vendor.value).toBe('Bolt Hardware');
  });
  it('keeps the plain JSON textarea when the schema declares no fields', async () => {
    render(IntakeReview, {
      host: host(() => reviewView({ schema: false })),
      itemId: 'item',
    });
    await screen.findByRole('textbox', { name: 'Exact arguments (JSON)' });
    expect(screen.queryByTestId('argument-fields')).toBeNull();
    expect(screen.queryByTestId('advanced-arguments')).toBeNull();
  });
});

describe('effects view (#4503)', () => {
  it('flattens the framework display shape to the handler preview fields', () => {
    expect(
      displayEntries({
        preview: { Vendor: 'Acme', Lines: 2 },
        dependencies: [],
      }),
    ).toEqual([
      ['Vendor', 'Acme'],
      ['Lines', '2'],
    ]);
    expect(
      displayEntries({
        step: { preview: { Vendor: 'Acme' }, dependencies: [{ field: 'x' }] },
        plan: { Steps: '2' },
      }),
    ).toEqual([
      ['Vendor', 'Acme'],
      ['dependencies', '[{"field":"x"}]'],
      ['plan', '{"Steps":"2"}'],
    ]);
    // A preview field named like framework metadata keeps its name; the
    // metadata row is qualified so the rendered list keys stay unique.
    expect(
      displayEntries({
        step: { preview: { plan: 'Monthly' }, dependencies: [] },
        plan: { Steps: '2' },
      }),
    ).toEqual([
      ['plan', 'Monthly'],
      ['metadata.plan', '{"Steps":"2"}'],
    ]);
    expect(
      displayEntries({
        preview: { dependencies: 'none' },
        dependencies: [{ field: 'x' }],
      }).map(([name]) => name),
    ).toEqual(['dependencies', 'metadata.dependencies']);
    expect(displayEntries({})).toEqual([]);
    expect(displayEntries(undefined)).toEqual([]);
  });
  it('draws display as a definition list', async () => {
    render(IntakeReview, { host: host(() => reviewView()), itemId: 'item' });
    const list = await screen.findByTestId('effects');
    expect(list.tagName).toBe('DL');
    expect(
      [...list.querySelectorAll('dt')].map((node) => node.textContent),
    ).toEqual(['Vendor', 'Total', 'Lines']);
    expect(
      [...list.querySelectorAll('dd')].map((node) => node.textContent),
    ).toEqual(['Acme Supply', '$12.50', '2']);
  });
});

describe('feedback state (#4503)', () => {
  it('presses the loaded judgment and supersedes it on a second judgment', async () => {
    const judged = reviewView({
      act: action({
        feedback: {
          id: 'feedback-1',
          judgment: 'correct',
          recordedAt: '2026-10-30T00:00:00.000Z',
        },
      }),
    });
    const callbacks = host(() => judged, {
      feedback: vi.fn(async () => ({
        id: 'feedback-2',
        digest: 'd',
        kind: 'interpretation' as const,
      })),
    });
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    const correct = await screen.findByRole('button', { name: 'Correct' });
    const incorrect = screen.getByRole('button', { name: 'Incorrect' });
    expect(correct.getAttribute('aria-pressed')).toBe('true');
    expect(incorrect.getAttribute('aria-pressed')).toBe('false');
    expect(screen.queryByTestId('feedback-sent')).toBeNull();
    await fireEvent.click(incorrect);
    await waitFor(() =>
      expect(callbacks.feedback).toHaveBeenCalledWith(
        expect.objectContaining({
          judgment: 'incorrect',
          supersedesId: 'feedback-1',
        }),
      ),
    );
    expect((await screen.findByTestId('feedback-sent')).textContent).toBe(
      'Feedback sent.',
    );
  });
  it('without loaded state, the sent judgment is pressed and the receipt is superseded next', async () => {
    const callbacks = host(() => reviewView(), {
      feedback: vi.fn(async () => ({
        id: 'receipt-1',
        digest: 'd',
        kind: 'interpretation' as const,
      })),
    });
    render(IntakeReview, { host: callbacks, itemId: 'item' });
    await fireEvent.click(
      await screen.findByRole('button', { name: 'Correct' }),
    );
    await screen.findByTestId('feedback-sent');
    expect(
      screen
        .getByRole('button', { name: 'Correct' })
        .getAttribute('aria-pressed'),
    ).toBe('true');
    expect(vi.mocked(callbacks.feedback!).mock.calls[0][0]).not.toHaveProperty(
      'supersedesId',
    );
    await fireEvent.click(screen.getByRole('button', { name: 'Incorrect' }));
    await waitFor(() =>
      expect(vi.mocked(callbacks.feedback!).mock.calls[1][0]).toMatchObject({
        judgment: 'incorrect',
        supersedesId: 'receipt-1',
      }),
    );
  });
});

describe('confidence (#4503)', () => {
  it('draws nothing when the provider reports no confidence', async () => {
    render(IntakeReview, { host: host(() => reviewView()), itemId: 'item' });
    await screen.findByTestId('generation-outcome');
    expect(screen.queryByText('Confidence unavailable')).toBeNull();
    expect(screen.queryByText(/Reported confidence/)).toBeNull();
  });
});

describe('assignee picker (#4503)', () => {
  it('searches the host and assigns the chosen id; free text without the callback', async () => {
    const assignees = vi.fn(async (query: string) => [
      { id: 'user-7', label: `Pat ${query}`.trim() },
    ]);
    const callbacks = host(view, {
      list: vi.fn(async () => ({ items: [entry('a')] })),
      assignees,
    });
    render(IntakeInbox, { host: callbacks });
    const picker = (await screen.findByRole('combobox', {
      name: 'Assignee: Row a',
    })) as HTMLInputElement;
    expect(
      screen.queryByRole('textbox', { name: 'Assignee ID: Row a' }),
    ).toBeNull();
    await fireEvent.input(picker, { target: { value: 'Ro' } });
    await waitFor(() => expect(assignees).toHaveBeenCalledWith('Ro'));
    await fireEvent.click(
      await screen.findByRole('option', { name: 'Pat Ro' }),
    );
    expect(picker.value).toBe('Pat Ro');
    await fireEvent.click(
      screen.getByRole('button', { name: 'Save assignment' }),
    );
    await waitFor(() =>
      expect(callbacks.assign).toHaveBeenCalledWith(
        expect.objectContaining({ itemId: 'a', assigneeId: 'user-7' }),
      ),
    );
    cleanup();
    render(IntakeInbox, {
      host: host(view, { list: vi.fn(async () => ({ items: [entry('a')] })) }),
    });
    expect(
      await screen.findByRole('textbox', { name: 'Assignee ID: Row a' }),
    ).toBeTruthy();
    expect(
      screen.queryByRole('combobox', { name: 'Assignee: Row a' }),
    ).toBeNull();
  });
});
