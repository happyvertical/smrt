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
    onAssistantContextChange?: (registration: any) => void;
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
      onAssistantContextChange: props.onAssistantContextChange,
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
  onAssistantContextChange?: (registration: any) => void;
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
      onAssistantContextChange: props.onAssistantContextChange,
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

  it('saves the inferred HTML body format for legacy HTML records', () => {
    const onSave = vi.fn();
    const target = renderEditor({
      content: {
        title: 'HTML Article',
        body: '<p>Existing HTML</p>',
        referenceIds: [],
        assetIds: [],
        assets: [],
      },
      onSave,
    });

    target
      .querySelector('#content-edit-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        bodyFormat: 'html',
      }),
    );
  });

  it('can switch the body save format to markdown', async () => {
    const onSave = vi.fn();
    const target = renderEditor({
      content: {
        title: 'HTML Article',
        body: '<p>Existing <strong>HTML</strong></p>',
        bodyFormat: 'html',
        referenceIds: [],
        assetIds: [],
        assets: [],
      },
      onSave,
    });

    await vi.waitFor(() =>
      expect(target.querySelector('.body-editor-surface')?.innerHTML).toContain(
        'Existing',
      ),
    );

    const formatSelect = target.querySelector(
      '.format-select select',
    ) as HTMLSelectElement | null;
    expect(formatSelect).not.toBeNull();
    if (!formatSelect) {
      throw new Error('Expected body format select to be rendered');
    }

    formatSelect.value = 'markdown';
    formatSelect.dispatchEvent(new Event('change', { bubbles: true }));
    flushSync();

    target
      .querySelector('#content-edit-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        bodyFormat: 'markdown',
        body: expect.stringContaining('Existing **HTML**'),
      }),
    );
  });

  it('drops image URLs into the body editor and chooses the first image as thumbnail', async () => {
    const onSave = vi.fn();
    vi.mocked(fetch).mockResolvedValue({
      ok: true,
      json: async () => ({
        id: 'image-inline-1',
        name: 'Inline Image',
        sourceUri: 'https://example.com/inline.jpg',
      }),
    } as Response);

    const target = renderEditor({
      content: {
        title: 'Inline Article',
        body: '<p>Intro</p>',
        bodyFormat: 'html',
        referenceIds: [],
        assetIds: [],
        assets: [],
      },
      onSave,
    });

    const bodySurface = target.querySelector(
      '.body-editor-surface',
    ) as HTMLElement | null;
    expect(bodySurface).not.toBeNull();
    if (!bodySurface) {
      throw new Error('Expected body editor surface to be rendered');
    }

    bodySurface.dispatchEvent(
      createDropEvent({
        getData: (type) =>
          type === 'text/plain' ? 'https://example.com/inline.jpg' : '',
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

    await vi.waitFor(() =>
      expect(bodySurface.querySelector('img')?.getAttribute('src')).toBe(
        'https://example.com/inline.jpg',
      ),
    );

    target
      .querySelector('#content-edit-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        thumbnailAssetId: 'image-inline-1',
        assetIds: ['image-inline-1'],
        body: expect.stringContaining('data-smrt-asset-id="image-inline-1"'),
      }),
    );
    expect(onSave.mock.calls[0]?.[0].body).toContain(
      'data-smrt-inline-image="true"',
    );
    expect(onSave.mock.calls[0]?.[0].body).not.toContain('<figure');
  });

  it('drops gallery image payloads into the body editor', async () => {
    const onSave = vi.fn();
    const target = renderEditor({
      content: {
        title: 'Gallery Drag Article',
        body: '<p>Intro</p>',
        bodyFormat: 'html',
        referenceIds: [],
        assetIds: [],
        assets: [],
      },
      onSave,
    });

    const bodySurface = target.querySelector(
      '.body-editor-surface',
    ) as HTMLElement | null;
    expect(bodySurface).not.toBeNull();
    if (!bodySurface) {
      throw new Error('Expected body editor surface to be rendered');
    }

    bodySurface.dispatchEvent(
      createDropEvent({
        getData: (type) =>
          type === 'application/x-smrt-image'
            ? JSON.stringify({
                id: 'asset-inline-1',
                name: 'Gallery Asset',
                sourceUri: 'https://example.com/gallery.jpg',
                alt: 'Gallery alt',
              })
            : '',
      }),
    );

    await vi.waitFor(() =>
      expect(bodySurface.querySelector('img')?.getAttribute('src')).toBe(
        'https://example.com/gallery.jpg',
      ),
    );

    target
      .querySelector('#content-edit-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        thumbnailAssetId: 'asset-inline-1',
        assetIds: ['asset-inline-1'],
        body: expect.stringContaining('data-smrt-asset-id="asset-inline-1"'),
      }),
    );
  });

  it('drags attached media images into the body editor', async () => {
    const asset = {
      id: 'asset-attached-1',
      name: 'Attached Asset',
      sourceUri: 'https://example.com/attached.jpg',
      alt: 'Attached alt',
    };
    const target = renderEditor({
      content: {
        title: 'Attached Image Drag Article',
        body: '<p>Intro</p>',
        bodyFormat: 'html',
        thumbnailAssetId: asset.id,
        referenceIds: [],
        assetIds: [asset.id],
        assets: [asset],
      },
    });

    const mediaItem = target.querySelector('.media-item') as HTMLElement | null;
    const bodySurface = target.querySelector(
      '.body-editor-surface',
    ) as HTMLElement | null;
    expect(mediaItem).not.toBeNull();
    expect(bodySurface).not.toBeNull();
    if (!mediaItem || !bodySurface) {
      throw new Error('Expected media item and body editor surface');
    }

    const dragData = new Map<string, string>();
    const dataTransfer = {
      effectAllowed: 'none',
      files: [],
      setData: vi.fn((type: string, value: string) => {
        dragData.set(type, value);
      }),
      getData: vi.fn((type: string) => dragData.get(type) || ''),
    };
    const dragStart = new Event('dragstart', {
      bubbles: true,
      cancelable: true,
    });
    Object.defineProperty(dragStart, 'dataTransfer', {
      value: dataTransfer,
    });

    mediaItem.dispatchEvent(dragStart);
    expect(dataTransfer.effectAllowed).toBe('copy');
    expect(dataTransfer.setData).toHaveBeenCalledWith(
      'application/x-smrt-image',
      expect.any(String),
    );
    expect(dragData.get('text/plain')).toBe(asset.sourceUri);

    bodySurface.dispatchEvent(
      createDropEvent({
        getData: (type) => dragData.get(type) || '',
      }),
    );

    await vi.waitFor(() =>
      expect(bodySurface.querySelector('img')?.getAttribute('src')).toBe(
        asset.sourceUri,
      ),
    );
  });

  it('cycles body images with the inline image chooser arrows', async () => {
    const target = renderEditor({
      content: {
        title: 'Gallery Article',
        body: '<p>Intro</p><img src="https://example.com/a.jpg" alt="A"><img src="https://example.com/b.jpg" alt="B">',
        bodyFormat: 'html',
        referenceIds: [],
        assetIds: [],
        assets: [],
      },
    });

    await vi.waitFor(() =>
      expect(target.querySelectorAll('.body-editor-surface img').length).toBe(
        2,
      ),
    );

    const nextButton = Array.from(target.querySelectorAll('button')).find(
      (button) => button.getAttribute('aria-label') === 'Next body image',
    );
    expect(nextButton).toBeDefined();
    nextButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();

    const selected = target.querySelector(
      '.body-editor-surface img[data-smrt-selected="true"]',
    ) as HTMLImageElement | null;
    expect(selected?.getAttribute('src')).toBe('https://example.com/b.jpg');
  });

  it('adds image placement, resize, primary, and remove controls for HTML bodies', () => {
    const onSave = vi.fn();
    const target = renderEditor({
      content: {
        title: 'Image Controls Article',
        body: '<p>Intro text that should wrap.</p><figure data-smrt-inline-image="true" data-smrt-placement="block"><img src="https://example.com/body.jpg" alt="Body" data-smrt-asset-id="asset-body"></figure><p>More copy.</p>',
        bodyFormat: 'html',
        thumbnailAssetId: null,
        referenceIds: [],
        assetIds: ['asset-body'],
        assets: [
          {
            id: 'asset-body',
            name: 'Body',
            sourceUri: 'https://example.com/body.jpg',
          },
        ],
      },
      onSave,
    });

    const bodyImage = target.querySelector(
      '.body-editor-surface img',
    ) as HTMLImageElement | null;
    expect(bodyImage).not.toBeNull();
    bodyImage?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    flushSync();

    const wrapRightButton = Array.from(target.querySelectorAll('button')).find(
      (button) => button.getAttribute('title') === 'Wrap text on left',
    );
    const largerButton = Array.from(target.querySelectorAll('button')).find(
      (button) => button.getAttribute('title') === 'Make larger',
    );
    const primaryButton = Array.from(target.querySelectorAll('button')).find(
      (button) => button.getAttribute('title') === 'Use as primary image',
    );
    expect(wrapRightButton).toBeDefined();
    expect(largerButton).toBeDefined();
    expect(primaryButton).toBeDefined();

    wrapRightButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    largerButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    primaryButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();

    target
      .querySelector('#content-edit-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        thumbnailAssetId: 'asset-body',
        bodyFormat: 'html',
        body: expect.stringContaining('data-smrt-placement="right"'),
      }),
    );
    expect(onSave.mock.calls[0]?.[0].body).toMatch(/data-smrt-width="\d+"/);

    const removeButton = Array.from(target.querySelectorAll('button')).find(
      (button) => button.getAttribute('title') === 'Remove image',
    );
    removeButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();

    target
      .querySelector('#content-edit-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(onSave.mock.calls[1]?.[0].body).not.toContain(
      'https://example.com/body.jpg',
    );
  });

  it('keeps the caret in text after clearing a selected body image', () => {
    const target = renderEditor({
      content: {
        title: 'Image Caret Article',
        body: '<p>Intro text.</p><figure data-smrt-inline-image="true" data-smrt-placement="left"><img src="https://example.com/body.jpg" alt="Body"></figure><p>More copy after the image.</p>',
        bodyFormat: 'html',
        referenceIds: [],
        assetIds: [],
        assets: [],
      },
    });

    const bodySurface = target.querySelector(
      '.body-editor-surface',
    ) as HTMLElement | null;
    const bodyImage = bodySurface?.querySelector(
      'img',
    ) as HTMLImageElement | null;
    const textParagraph = Array.from(
      bodySurface?.querySelectorAll('p') || [],
    ).find((paragraph) =>
      paragraph.textContent?.includes('More copy after the image.'),
    );

    expect(bodyImage).not.toBeNull();
    expect(textParagraph).toBeDefined();

    bodyImage?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    flushSync();

    expect(bodyImage?.getAttribute('data-smrt-selected')).toBe('true');

    textParagraph?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    flushSync();

    expect(bodyImage?.hasAttribute('data-smrt-selected')).toBe(false);

    bodySurface?.dispatchEvent(new Event('input', { bubbles: true }));
    flushSync();

    expect(bodyImage?.hasAttribute('data-smrt-selected')).toBe(false);
  });

  it('keeps markdown saves as markdown when image layout controls are used', () => {
    const onSave = vi.fn();
    const target = renderEditor({
      content: {
        title: 'Markdown Image Controls',
        body: 'Intro\n\n![Body](https://example.com/body.jpg)\n\nMore copy.',
        bodyFormat: 'markdown',
        referenceIds: [],
        assetIds: [],
        assets: [],
      },
      onSave,
    });

    const bodyImage = target.querySelector(
      '.body-editor-surface img',
    ) as HTMLImageElement | null;
    expect(bodyImage).not.toBeNull();
    bodyImage?.dispatchEvent(
      new MouseEvent('click', { bubbles: true, cancelable: true }),
    );
    flushSync();

    const wrapLeftButton = Array.from(target.querySelectorAll('button')).find(
      (button) => button.getAttribute('title') === 'Wrap text on right',
    );
    const smallerButton = Array.from(target.querySelectorAll('button')).find(
      (button) => button.getAttribute('title') === 'Make smaller',
    );
    wrapLeftButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    smallerButton?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    flushSync();

    target
      .querySelector('#content-edit-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    const saved = onSave.mock.calls[0]?.[0];
    expect(saved.bodyFormat).toBe('markdown');
    expect(saved.body).toContain('![Body](https://example.com/body.jpg)');
    expect(saved.body).not.toContain('data-smrt-placement');
    expect(saved.body).not.toContain('data-smrt-width');
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

  it('omits hydrated assets and references from the save payload', () => {
    const onSave = vi.fn();
    const target = renderEditor({
      content: {
        title: 'Hydrated Article',
        referenceIds: ['ref-1'],
        references: [{ id: 'ref-1', title: 'Minutes' }],
        assetIds: ['asset-1'],
        assets: [{ id: 'asset-1', sourceUri: 'https://example.com/a.jpg' }],
      },
      onSave,
    });

    target
      .querySelector('#content-edit-form')
      ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

    expect(onSave).toHaveBeenCalledWith(
      expect.objectContaining({
        referenceIds: ['ref-1'],
        assetIds: ['asset-1'],
      }),
    );
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty('references');
    expect(onSave.mock.calls[0]?.[0]).not.toHaveProperty('assets');
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

  it('publishes assistant context and actions when the chat sidebar is hidden', () => {
    const onAssistantContextChange = vi.fn();
    renderEditor({
      hideChat: true,
      contentId: 'content-1',
      content: {
        id: 'content-1',
        title: 'Assistant Article',
        description: 'Draft deck',
        body: 'Initial body',
        type: 'article',
        status: 'draft',
        state: 'active',
        referenceIds: ['ref-1'],
        assetIds: [],
        assets: [],
      },
      onAssistantContextChange,
    });

    const registration = onAssistantContextChange.mock.calls
      .map(([value]) => value)
      .filter(Boolean)
      .at(-1);

    expect(registration?.context).toMatchObject({
      type: 'content.editor',
      title: 'Assistant Article',
      data: {
        contentId: 'content-1',
        contentType: 'article',
        editorKind: 'content',
        currentEditorState: 'Initial body',
        referenceIds: ['ref-1'],
        fields: {
          title: 'Assistant Article',
          description: 'Draft deck',
          type: 'article',
          status: 'draft',
          state: 'active',
          body: 'Initial body',
        },
      },
    });
    expect(registration?.actions.triggerSave).toEqual(expect.any(Function));
    expect(registration?.actions.applyFieldUpdates).toEqual(
      expect.any(Function),
    );

    registration.actions.applyFieldUpdates({ title: 'AI title' });
    flushSync();

    const updatedRegistration = onAssistantContextChange.mock.calls
      .map(([value]) => value)
      .filter(Boolean)
      .at(-1);
    expect(updatedRegistration?.context.title).toBe('AI title');
    expect(updatedRegistration?.context.data.fields.title).toBe('AI title');
    expect(
      onAssistantContextChange.mock.calls.some(([value]) => value === null),
    ).toBe(false);
  });

  it('adds governance and review actions to governed assistant context', () => {
    const onAssistantContextChange = vi.fn();
    renderGovernedEditor({
      hideChat: true,
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
          },
        ],
        referenceIds: [],
        assetIds: [],
        assets: [],
      },
      onAssistantContextChange,
    });

    const registration = onAssistantContextChange.mock.calls
      .map(([value]) => value)
      .filter(Boolean)
      .at(-1);

    expect(registration?.context.data).toMatchObject({
      contentId: 'content-1',
      editorKind: 'governed',
      facts: {
        factIds: ['fact-1'],
        factCount: 1,
      },
      governance: {
        reviewProfileKey: 'publication',
        enforcePublishReadiness: false,
      },
    });
    expect(registration?.actions.triggerSave).toEqual(expect.any(Function));
    expect(registration?.actions.triggerReview).toEqual(expect.any(Function));
  });
});
