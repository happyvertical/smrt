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
import GovernedContentEditor from './GovernedContentEditor.svelte';

const mountedComponents: Array<ReturnType<typeof mount>> = [];

function renderEditor(
  props: {
    apiBaseUrl?: string;
    content?: any;
    contentId?: string;
    factAudit?: any;
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
      factAudit: props.factAudit,
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

function renderGovernedEditor(props: {
  content?: any;
  contentId?: string;
  hideChat?: boolean;
  onSave?: (data: any) => void;
  onCancel?: () => void;
}) {
  const target = document.createElement('div');
  document.body.appendChild(target);

  const component = mount(GovernedContentEditor, {
    target,
    props: {
      content: props.content,
      contentId: props.contentId ?? 'new',
      hideChat: props.hideChat,
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
  it('renders governed content facts with the facts drawer open', () => {
    const target = renderGovernedEditor({
      contentId: 'content-1',
      content: {
        id: 'content-1',
        title: 'Governed Article',
        body: 'Governed body',
        type: 'article',
        status: 'published',
        state: 'active',
        factIds: ['fact-1'],
        facts: [
          {
            id: 'fact-1',
            textRefined: 'Council approved the waterline phase two work.',
            status: 'verified',
            confidence: 0.92,
          },
        ],
        referenceIds: [],
        assetIds: [],
        assets: [],
      },
      hideChat: true,
    });

    expect(target.textContent).toContain(
      'Council approved the waterline phase two work.',
    );
    const factsDrawer = Array.from(target.querySelectorAll('details')).find(
      (detail) => detail.textContent?.includes('Manually linked facts'),
    ) as HTMLDetailsElement | undefined;
    expect(factsDrawer?.open).toBe(true);
  });

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

  it('shows resource claims with their related reference', async () => {
    const target = renderEditor({
      content: {
        title: 'Test Article',
        referenceIds: ['ref-1'],
        references: [
          {
            id: 'ref-1',
            title: 'Meeting minutes',
            url: 'https://example.com/minutes.pdf',
          },
        ],
        assetIds: [],
        assets: [],
      },
      factAudit: {
        counts: {
          total: 0,
          supported: 0,
          unsupported: 0,
          contradicted: 0,
          needs_review: 0,
        },
        claims: [],
        resourceClaims: [
          {
            id: 'fact-1',
            sourceId: 'ref-1',
            sourceTitle: 'Meeting minutes',
            quote: 'Council approved the project.',
            fact: {
              id: 'fact-1',
              textRefined: 'Council approved the project.',
            },
          },
        ],
        warnings: [],
        generatedBy: 'content.factAudit',
        latestAuditRunId: 'audit-1',
      },
    });

    expect(target.textContent).toContain('Meeting minutes');
    expect(target.textContent).toContain('1 evidence claim');
    expect(target.textContent).toContain('Council approved the project.');
  });

  it('expands long resource claim lists in references', async () => {
    const resourceClaims = Array.from({ length: 8 }, (_, index) => {
      const claimNumber = index + 1;
      return {
        id: `fact-${claimNumber}`,
        sourceId: 'ref-1',
        sourceTitle: 'Meeting minutes',
        quote: `Source quote ${claimNumber}`,
        fact: {
          id: `fact-${claimNumber}`,
          textRefined: `Resource claim ${claimNumber}`,
        },
      };
    });

    const target = renderEditor({
      content: {
        title: 'Test Article',
        referenceIds: ['ref-1'],
        references: [
          {
            id: 'ref-1',
            title: 'Meeting minutes',
          },
        ],
        assetIds: [],
        assets: [],
      },
      factAudit: {
        counts: {
          total: 0,
          supported: 0,
          unsupported: 0,
          contradicted: 0,
          needs_review: 0,
        },
        claims: [],
        resourceClaims,
        warnings: [],
        generatedBy: 'content.factAudit',
        latestAuditRunId: 'audit-1',
      },
    });

    expect(target.textContent).toContain('Resource claim 6');
    expect(target.textContent).not.toContain('Resource claim 7');

    const expandButton = Array.from(target.querySelectorAll('button')).find(
      (button) => button.textContent?.trim() === '+ 2 more',
    );
    expandButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();

    expect(target.textContent).toContain('Resource claim 7');
    expect(target.textContent).toContain('Resource claim 8');
    expect(target.textContent).toContain('Show fewer');
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

  it('removes the chat sidebar container and layout column when hidden', () => {
    const target = renderEditor({ hideChat: true });

    expect(target.querySelector('.editor-sidebar-col')).toBeNull();
    expect(
      target.querySelector(
        '[data-testid="content-editor-agent-chat-disabled"]',
      ),
    ).toBeNull();
    expect(
      target
        .querySelector('.editor-grid')
        ?.classList.contains('editor-grid--with-sidebar'),
    ).toBe(false);
  });
});
