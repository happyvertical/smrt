// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import ContentContributionInbox from './ContentContributionInbox.svelte';

const mountedComponents: Array<ReturnType<typeof mount>> = [];

function renderInbox(props: Record<string, any>) {
  const target = document.createElement('div');
  document.body.appendChild(target);
  const component = mount(ContentContributionInbox, {
    target,
    props,
  });
  mountedComponents.push(component);
  flushSync();
  return target;
}

afterEach(() => {
  while (mountedComponents.length > 0) {
    const component = mountedComponents.pop();
    if (component) {
      unmount(component);
    }
  }

  document.body.innerHTML = '';
  vi.clearAllMocks();
});

describe('ContentContributionInbox', () => {
  it('keeps intake decision separate from the primary workflow status', () => {
    const target = renderInbox({
      contributions: [
        {
          id: 'contribution-1',
          title: 'Letter',
          contributorEmail: 'reader@example.com',
          status: 'submitted',
          intakeDecision: 'accepted',
        },
      ],
    });

    const pills = Array.from(target.querySelectorAll('.pill')).map((pill) =>
      pill.textContent?.trim(),
    );

    expect(pills).toContain('submitted');
    expect(pills.filter((text) => text === 'submitted')).toHaveLength(2);
    expect(pills).not.toContain('accepted');
    expect(target.textContent).toContain('Intake decision');
    expect(target.textContent).toContain('accepted');
  });

  it('labels submitted contribution approval as approve and promote', () => {
    const target = renderInbox({
      contributions: [
        {
          id: 'contribution-1',
          title: 'Letter',
          contributorEmail: 'reader@example.com',
          status: 'submitted',
          intakeDecision: 'accepted',
        },
      ],
      onApprove: vi.fn(),
    });

    const buttons = Array.from(target.querySelectorAll('button'));

    expect(
      buttons.some(
        (button) => button.textContent?.trim() === 'Approve and promote',
      ),
    ).toBe(true);
  });

  it('labels already approved contribution approval as promote', () => {
    const target = renderInbox({
      contributions: [
        {
          id: 'contribution-1',
          title: 'Letter',
          contributorEmail: 'reader@example.com',
          status: 'approved',
          intakeDecision: 'accepted',
        },
      ],
      onApprove: vi.fn(),
    });

    const buttons = Array.from(target.querySelectorAll('button'));

    expect(
      buttons.some((button) => button.textContent?.trim() === 'Promote'),
    ).toBe(true);
    expect(
      buttons.some(
        (button) => button.textContent?.trim() === 'Approve and promote',
      ),
    ).toBe(false);
  });

  it('renders workflow controls as a native POST form when an action is provided', () => {
    const target = renderInbox({
      workflowFormAction: '?/reviewContribution',
      contributions: [
        {
          id: 'contribution-1',
          title: 'Letter',
          contributorEmail: 'reader@example.com',
          status: 'submitted',
          intakeDecision: 'accepted',
          revisionCount: 1,
        },
      ],
    });

    const form = target.querySelector('form') as HTMLFormElement;
    const buttons = Array.from(form.querySelectorAll('button'));

    expect(form).toBeTruthy();
    expect(form.method).toBe('post');
    expect(form.getAttribute('action')).toBe('?/reviewContribution');
    expect(
      form.querySelector('input[name="contributionId"]')?.getAttribute('value'),
    ).toBe('contribution-1');
    expect(form.querySelector('textarea[name="editorNote"]')).toBeTruthy();
    expect(form.querySelector('select[name="targetStatus"]')).toBeTruthy();
    expect(buttons.map((button) => button.type)).toEqual([
      'submit',
      'submit',
      'submit',
    ]);
    expect(buttons.map((button) => button.getAttribute('name'))).toEqual([
      'intent',
      'intent',
      'intent',
    ]);
    expect(buttons.map((button) => button.getAttribute('value'))).toEqual([
      'approve',
      'request-changes',
      'reject',
    ]);
  });

  it('allows native workflow form submission when no callback is registered', () => {
    const target = renderInbox({
      workflowFormAction: '?/reviewContribution',
      contributions: [
        {
          id: 'contribution-1',
          title: 'Letter',
          contributorEmail: 'reader@example.com',
          status: 'submitted',
        },
      ],
    });

    const form = target.querySelector('form') as HTMLFormElement;
    const button = form.querySelector(
      'button[value="approve"]',
    ) as HTMLButtonElement;
    const event = new Event('submit', {
      bubbles: true,
      cancelable: true,
    }) as SubmitEvent;
    Object.defineProperty(event, 'submitter', {
      value: button,
      configurable: true,
    });

    form.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(false);
  });

  it('prevents browser submission when a workflow callback handles the intent', () => {
    const onApprove = vi.fn();
    const target = renderInbox({
      workflowFormAction: '?/reviewContribution',
      contributions: [
        {
          id: 'contribution-1',
          title: 'Letter',
          contributorEmail: 'reader@example.com',
          status: 'submitted',
        },
      ],
      onApprove,
    });

    const form = target.querySelector('form') as HTMLFormElement;
    const button = form.querySelector(
      'button[value="approve"]',
    ) as HTMLButtonElement;
    const event = new Event('submit', {
      bubbles: true,
      cancelable: true,
    }) as SubmitEvent;
    Object.defineProperty(event, 'submitter', {
      value: button,
      configurable: true,
    });

    form.dispatchEvent(event);

    expect(event.defaultPrevented).toBe(true);
    expect(onApprove).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'contribution-1' }),
      {
        targetStatus: 'draft',
        note: '',
      },
    );
  });

  it('disables native workflow buttons when the selected contribution has no id', () => {
    const target = renderInbox({
      workflowFormAction: '?/reviewContribution',
      contributions: [
        {
          id: '',
          title: 'Letter',
          contributorEmail: 'reader@example.com',
          status: 'submitted',
        },
      ],
    });

    const form = target.querySelector('form') as HTMLFormElement;
    const buttons = Array.from(form.querySelectorAll('button'));

    expect(form.querySelector('input[name="contributionId"]')).toBeNull();
    expect(buttons.map((button) => button.disabled)).toEqual([
      true,
      true,
      true,
    ]);
  });

  it('emits approve, request-changes, and reject actions with the current note', () => {
    const onApprove = vi.fn();
    const onRequestChanges = vi.fn();
    const onReject = vi.fn();

    const target = renderInbox({
      contributions: [
        {
          id: 'contribution-1',
          title: 'Letter',
          contributorEmail: 'reader@example.com',
          status: 'submitted',
          intakeDecision: 'accepted',
          revisionCount: 1,
        },
      ],
      onApprove,
      onRequestChanges,
      onReject,
    });

    const textarea = target.querySelector('textarea') as HTMLTextAreaElement;
    textarea.value = 'Please tighten the opening.';
    textarea.dispatchEvent(new Event('input', { bubbles: true }));

    const select = target.querySelector('select') as HTMLSelectElement;
    select.value = 'review';
    select.dispatchEvent(new Event('change', { bubbles: true }));

    const buttons = Array.from(target.querySelectorAll('button'));
    buttons
      .find((button) => button.textContent?.includes('Approve and promote'))
      ?.click();
    buttons
      .find((button) => button.textContent?.includes('Request changes'))
      ?.click();
    buttons.find((button) => button.textContent?.includes('Reject'))?.click();

    expect(onApprove).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'contribution-1' }),
      {
        targetStatus: 'review',
        note: 'Please tighten the opening.',
      },
    );
    expect(onRequestChanges).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'contribution-1' }),
      {
        note: 'Please tighten the opening.',
      },
    );
    expect(onReject).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'contribution-1' }),
      {
        note: 'Please tighten the opening.',
      },
    );
  });
});
