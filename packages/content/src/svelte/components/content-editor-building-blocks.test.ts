// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('@happyvertical/smrt-images/svelte', async () => ({
  ImageUploader: (await import('../../../test-stubs/ImageUploaderStub.svelte'))
    .default,
}));

import ContentImageBrowser from './ContentImageBrowser.svelte';
import ContentMetadataFields from './ContentMetadataFields.svelte';
import ContentReferencesPanel from './ContentReferencesPanel.svelte';
import ContentReviewStatusTray from './ContentReviewStatusTray.svelte';
import ContentStatusFields from './ContentStatusFields.svelte';

const mountedComponents: Array<ReturnType<typeof mount>> = [];

function renderComponent(component: any, props: Record<string, unknown> = {}) {
  const target = document.createElement('div');
  document.body.appendChild(target);

  const mounted = mount(component, {
    target,
    props,
  });

  mountedComponents.push(mounted);
  flushSync();

  return target;
}

function setInputValue(
  element: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement,
  value: string,
  eventName = 'input',
) {
  element.value = value;
  element.dispatchEvent(new Event(eventName, { bubbles: true }));
  flushSync();
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

describe('content editor building block components', () => {
  it('emits normalized metadata field changes', () => {
    const onChange = vi.fn();
    const target = renderComponent(ContentMetadataFields, {
      data: {
        author: 'Reporter',
        description: 'Summary',
        tags: ['news'],
      },
      onChange,
    });

    const tagsInput = target.querySelector(
      'input[placeholder="e.g. news, tech"]',
    ) as HTMLInputElement;
    setInputValue(tagsInput, 'council, budget');

    expect(onChange).toHaveBeenCalledWith({
      tags: ['council', 'budget'],
    });
  });

  it('emits status field changes', () => {
    const onChange = vi.fn();
    const target = renderComponent(ContentStatusFields, {
      data: {
        type: 'article',
        state: 'active',
        status: 'draft',
        publish_date: '',
      },
      onChange,
    });

    const statusSelect = target.querySelectorAll('select')[2] as
      | HTMLSelectElement
      | undefined;
    if (!statusSelect) {
      throw new Error('Expected status select to be rendered');
    }
    setInputValue(statusSelect, 'published', 'change');

    expect(onChange).toHaveBeenCalledWith({ status: 'published' });
  });

  it('renders safe reference links and labels the add-reference input', () => {
    const onReferenceIdsChange = vi.fn();
    const target = renderComponent(ContentReferencesPanel, {
      referenceIds: ['safe-ref'],
      references: [
        {
          id: 'safe-ref',
          title: 'Safe reference',
          url: 'https://example.com/ref',
        },
        { id: 'bad-ref', title: 'Bad reference', url: 'javascript:alert(1)' },
      ],
      onReferenceIdsChange,
    });

    const links = Array.from(target.querySelectorAll('a')).map((link) =>
      link.getAttribute('href'),
    );
    expect(links).toEqual(['https://example.com/ref']);
    expect(
      target.querySelector('input[aria-label="Add reference by ID or URL"]'),
    ).toBeTruthy();
  });

  it('adds typed reference input values', () => {
    const onReferenceIdsChange = vi.fn();
    const target = renderComponent(ContentReferencesPanel, {
      referenceIds: ['ref-1'],
      references: [],
      onReferenceIdsChange,
    });

    const input = target.querySelector(
      'input[aria-label="Add reference by ID or URL"]',
    ) as HTMLInputElement;
    const addButton = Array.from(target.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === 'Add',
    );

    setInputValue(input, 'https://example.com/minutes');
    addButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();

    expect(onReferenceIdsChange).toHaveBeenCalledWith([
      'ref-1',
      'https://example.com/minutes',
    ]);
  });

  it('renders image assets and lazy-loads previews', () => {
    const target = renderComponent(ContentImageBrowser, {
      assets: [
        {
          id: 'asset-1',
          name: 'Main image',
          sourceUri: 'https://example.com/image.jpg',
        },
      ],
    });

    const image = target.querySelector('img') as HTMLImageElement;
    expect(image.getAttribute('src')).toBe('https://example.com/image.jpg');
    expect(image.getAttribute('loading')).toBe('lazy');
    expect(image.getAttribute('decoding')).toBe('async');
  });

  it('can show the image uploader initially', () => {
    const target = renderComponent(ContentImageBrowser, {
      apiBaseUrl: '/tenant/api/v1',
      showUploaderInitially: true,
      onSelectImage: vi.fn(),
    });

    const uploader = target.querySelector(
      '[data-testid="image-uploader-stub"]',
    ) as HTMLElement | null;
    expect(uploader?.dataset.apiBaseUrl).toBe('/tenant/api/v1');
  });

  it('represents review tray items as pressed buttons, not tabs', () => {
    const onSelect = vi.fn();
    const target = renderComponent(ContentReviewStatusTray, {
      activeId: 'facts',
      open: true,
      items: [
        {
          id: 'content',
          icon: 'content',
          label: 'Content',
          tone: 'neutral',
          status: 'Ready',
        },
        {
          id: 'facts',
          icon: 'facts',
          label: 'Facts',
          tone: 'warning',
          status: 'Review needed',
        },
      ],
      onSelect,
    });

    expect(target.querySelector('[role="tablist"]')).toBeNull();
    expect(target.querySelector('[role="tab"]')).toBeNull();
    expect(target.querySelector('[role="group"]')).toBeTruthy();

    const buttons = Array.from(target.querySelectorAll('button'));
    expect(
      buttons.map((button) => button.getAttribute('aria-pressed')),
    ).toEqual(['false', 'true']);

    buttons[1].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();

    expect(onSelect).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'facts' }),
    );
  });
});
