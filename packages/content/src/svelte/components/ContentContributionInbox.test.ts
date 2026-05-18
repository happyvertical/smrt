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

  it('emits approve and request-changes actions with the current note', () => {
    const onApprove = vi.fn();
    const onRequestChanges = vi.fn();

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
  });
});
