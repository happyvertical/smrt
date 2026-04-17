// @vitest-environment jsdom

import { flushSync, mount, unmount } from 'svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('./ContentAgentChat.svelte', async () => ({
  default: (await import('../../../test-stubs/ContentAgentChatStub.svelte'))
    .default,
}));

vi.mock('@happyvertical/smrt-images/svelte', async () => ({
  ImageUploader: (await import('../../../test-stubs/ImageUploaderStub.svelte'))
    .default,
}));

import ContentEditor from './ContentEditor.svelte';

const mountedComponents: Array<ReturnType<typeof mount>> = [];

function renderEditor(
  props: {
    apiBaseUrl?: string;
    content?: any;
    contentId?: string;
    saveDisabled?: boolean;
    saveNotice?: string | null;
    agentChatEnabled?: boolean;
    agentChatNotice?: string | null;
    hideActions?: boolean;
    hideChat?: boolean;
    onChange?: (data: any) => void;
    onSave?: (data: any) => void;
    onCancel?: () => void;
  } = {},
) {
  const target = document.createElement('div');
  document.body.appendChild(target);

  const component = mount(ContentEditor, {
    target,
    props: {
      apiBaseUrl: props.apiBaseUrl,
      content: props.content,
      contentId: props.contentId ?? 'new',
      saveDisabled: props.saveDisabled,
      saveNotice: props.saveNotice,
      agentChatEnabled: props.agentChatEnabled,
      agentChatNotice: props.agentChatNotice,
      hideActions: props.hideActions,
      hideChat: props.hideChat,
      onChange: props.onChange ?? vi.fn(),
      onSave: props.onSave ?? vi.fn(),
      onCancel: props.onCancel ?? vi.fn(),
    },
  });

  mountedComponents.push(component);
  flushSync();

  return target;
}

function createDropEvent(dataTransfer: {
  files?: File[];
  getData: (type: string) => string;
}) {
  const event = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(event, 'dataTransfer', {
    value: {
      files: dataTransfer.files ?? [],
      getData: dataTransfer.getData,
    },
  });
  return event;
}

afterEach(() => {
  while (mountedComponents.length > 0) {
    const component = mountedComponents.pop();
    if (component) {
      unmount(component);
    }
  }

  vi.unstubAllGlobals();
  vi.clearAllMocks();
  document.body.innerHTML = '';

  // Restore original Element.prototype.animate
  if (originalAnimate !== undefined) {
    Object.defineProperty(Element.prototype, 'animate', {
      configurable: true,
      writable: true,
      value: originalAnimate,
    });
  }
});

let originalAnimate: typeof Element.prototype.animate | undefined;

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
  originalAnimate = Element.prototype.animate;
  Object.defineProperty(Element.prototype, 'animate', {
    configurable: true,
    writable: true,
    value: () => ({
      cancel: vi.fn(),
      finished: Promise.resolve(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    }),
  });
});

describe('ContentEditor component', () => {
  it('adds dropped plain-text references to the reference list', async () => {
    const target = renderEditor({
      content: {
        title: 'Test Article',
        referenceIds: [],
        assetIds: [],
        assets: [],
      },
    });

    const refZone = target.querySelectorAll('.drop-zone')[1] as HTMLElement;

    refZone.dispatchEvent(
      createDropEvent({
        getData: (type) => (type === 'text/plain' ? 'ref-content-123' : ''),
      }),
    );
    flushSync();

    await vi.waitFor(() =>
      expect(target.textContent).toContain('ref-content-123'),
    );
  });

  it('uploads dropped image URLs and renders them in the media gallery', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'image-123',
        name: 'Dropped Image',
        sourceUri: 'https://example.com/image.jpg',
      }),
    } as Response);

    const target = renderEditor({
      content: {
        title: 'Test Article',
        referenceIds: [],
        assetIds: [],
        assets: [],
      },
    });

    const imageZone = target.querySelectorAll('.drop-zone')[0] as HTMLElement;

    imageZone.dispatchEvent(
      createDropEvent({
        getData: (type) =>
          type === 'text/plain' ? 'https://example.com/image.jpg' : '',
      }),
    );

    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/v1/images',
        expect.objectContaining({
          method: 'POST',
        }),
      ),
    );

    await vi.waitFor(() => {
      const image = target.querySelector(
        '.media-item-image',
      ) as HTMLImageElement | null;
      expect(image).not.toBeNull();
      expect(image?.getAttribute('src')).toBe('https://example.com/image.jpg');
      expect(target.textContent).toContain('Thumbnail');
    });
  });

  it('uses a custom apiBaseUrl for uploads and nested shared components', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'image-tenant-123',
        name: 'Dropped Image',
        sourceUri: 'https://example.com/image.jpg',
      }),
    } as Response);

    const target = renderEditor({
      apiBaseUrl: '/tenant/api/v2',
      content: {
        title: 'Tenant Article',
        referenceIds: [],
        assetIds: [],
        assets: [],
      },
    });

    const addImageButton = Array.from(target.querySelectorAll('button')).find(
      (button) => button.textContent?.includes('Add Image'),
    );
    addImageButton?.click();
    flushSync();

    const imageUploader = target.querySelector(
      '[data-testid="image-uploader-stub"]',
    ) as HTMLElement | null;
    expect(imageUploader?.dataset.apiBaseUrl).toBe('/tenant/api/v2');

    const chatStub = target.querySelector(
      '[data-testid="content-agent-chat-stub"]',
    ) as HTMLElement | null;
    expect(chatStub?.dataset.apiBaseUrl).toBe('/tenant/api/v2');

    const imageZone = target.querySelectorAll('.drop-zone')[0] as HTMLElement;

    imageZone.dispatchEvent(
      createDropEvent({
        getData: (type) =>
          type === 'text/plain' ? 'https://example.com/image.jpg' : '',
      }),
    );

    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/tenant/api/v2/images',
        expect.objectContaining({
          method: 'POST',
        }),
      ),
    );
  });

  it('creates placeholder reference records for dropped files without storing data URLs', async () => {
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'reference-upload-1',
      }),
    } as Response);

    const target = renderEditor({
      content: {
        title: 'Test Article',
        referenceIds: [],
        assetIds: [],
        assets: [],
      },
    });

    const refZone = target.querySelectorAll('.drop-zone')[1] as HTMLElement;
    const file = new File(['reference body'], 'source.pdf', {
      type: 'application/pdf',
    });

    refZone.dispatchEvent(
      createDropEvent({
        files: [file],
        getData: () => '',
      }),
    );

    await vi.waitFor(() =>
      expect(fetch).toHaveBeenCalledWith(
        '/api/v1/contents',
        expect.objectContaining({
          method: 'POST',
        }),
      ),
    );

    const payload = JSON.parse(
      (vi.mocked(fetch).mock.calls[0]?.[1] as RequestInit).body as string,
    );
    expect(payload.name).toBe('source.pdf');
    expect(payload.fileKey).toBe('source.pdf');
    expect(payload.body).toContain('does not upload the file contents');
    expect(payload.metadata.upload).toMatchObject({
      fileName: 'source.pdf',
      mimeType: 'application/pdf',
    });
    expect(payload.fileKey).not.toContain('data:');
  });

  it('parses the tags input into formData.tags on save', () => {
    const onSave = vi.fn();
    const target = renderEditor({
      content: {
        title: 'Tagged Article',
        referenceIds: [],
        assetIds: [],
        assets: [],
        tags: [],
      },
      onSave,
    });

    const tagsInput = Array.from(
      target.querySelectorAll('input[type="text"]'),
    ).find((input) =>
      (input as HTMLInputElement).placeholder.includes('e.g. news, tech'),
    ) as HTMLInputElement | undefined;
    const form = target.querySelector('#content-edit-form');

    expect(tagsInput).toBeDefined();
    if (!tagsInput) {
      throw new Error('Expected tags input to be rendered');
    }

    tagsInput.value = 'news, tech, updates';
    tagsInput.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    form?.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        tags: ['news', 'tech', 'updates'],
      }),
    );
  });

  it('submits publish_date under the persisted field name', () => {
    const onSave = vi.fn();
    const target = renderEditor({
      content: {
        title: 'Scheduled Article',
        referenceIds: [],
        assetIds: [],
        assets: [],
        publish_date: '2026-04-15T12:30:00.000Z',
      },
      onSave,
    });

    const publishDateInput = target.querySelector(
      '#publish-date-input',
    ) as HTMLInputElement | null;
    const form = target.querySelector('#content-edit-form');

    expect(publishDateInput).not.toBeNull();
    if (!publishDateInput) {
      throw new Error('Expected publish date input to be rendered');
    }

    publishDateInput.value = '2026-04-18T09:45';
    publishDateInput.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    form?.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        publish_date: new Date('2026-04-18T09:45').toISOString(),
      }),
    );
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty('publishDate');
  });

  it('preserves type changes in the save payload', () => {
    const onSave = vi.fn();
    const target = renderEditor({
      content: {
        title: 'Reference Document',
        type: 'article',
        referenceIds: [],
        assetIds: [],
        assets: [],
      },
      onSave,
    });

    const typeSelect = target.querySelector(
      '#type-select',
    ) as HTMLSelectElement | null;
    const form = target.querySelector('#content-edit-form');

    expect(typeSelect).not.toBeNull();
    if (!typeSelect) {
      throw new Error('Expected type select to be rendered');
    }

    typeSelect.value = 'document';
    typeSelect.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();

    form?.dispatchEvent(
      new Event('submit', { bubbles: true, cancelable: true }),
    );

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        type: 'document',
      }),
    );
  });

  it('renders the save notice when provided', () => {
    const target = renderEditor({
      saveDisabled: true,
      saveNotice: 'Publish readiness is blocked until review passes.',
    });

    expect(target.textContent).toContain(
      'Publish readiness is blocked until review passes.',
    );
  });

  it('renders the disabled chat state when agent chat is unavailable', () => {
    const target = renderEditor({
      agentChatEnabled: false,
      agentChatNotice: 'Agent chat is temporarily offline.',
    });

    const disabledState = target.querySelector(
      '[data-testid="content-editor-agent-chat-disabled"]',
    );

    expect(disabledState).not.toBeNull();
    expect(target.textContent).toContain('Agent chat is temporarily offline.');
  });
});
