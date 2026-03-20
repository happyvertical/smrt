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
    content?: any;
    contentId?: string;
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
      content: props.content,
      contentId: props.contentId ?? 'new',
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
});

beforeEach(() => {
  vi.stubGlobal('fetch', vi.fn());
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
});
