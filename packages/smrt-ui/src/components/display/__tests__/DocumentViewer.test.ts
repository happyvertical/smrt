/**
 * DocumentViewer: fake fetch and fake PDF opener (smrt#3463).
 */
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { expectNoA11yViolations } from '../../../test-support/a11y.js';
import DocumentViewer from '../DocumentViewer.svelte';
import { createPdfJsOpener, type PdfJsLike } from '../pdf-opener.js';
import { type OpenPdf, PdfEngineUnavailableError } from '../pdf-types.js';

function reply(body: BodyInit, type: string, ok = true): Response {
  return new Response(body, {
    status: ok ? 200 : 500,
    headers: { 'content-type': type },
  });
}

function fakePdf(pages = 3) {
  const renderPage = vi.fn(async () => ({ width: 600, height: 800 }));
  const destroy = vi.fn(async () => undefined);
  const openPdf = vi.fn<OpenPdf>(async () => ({ pages, renderPage, destroy }));
  return { openPdf, renderPage, destroy };
}

const root = (c: HTMLElement) =>
  c.querySelector('[data-smrt-component="DocumentViewer"]') as HTMLElement;
const btn = (name: string) => screen.getByRole('button', { name });

let created: string[];
let revoked: string[];
beforeEach(() => {
  // jsdom has no ResizeObserver, which `bind:clientWidth` needs.
  vi.stubGlobal(
    'ResizeObserver',
    class {
      observe() {}
      unobserve() {}
      disconnect() {}
    },
  );
  created = [];
  revoked = [];
  URL.createObjectURL = vi.fn(() => {
    const url = `blob:test/${created.length}`;
    created.push(url);
    return url;
  });
  URL.revokeObjectURL = vi.fn((url: string) => {
    revoked.push(url);
  });
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('DocumentViewer PDF', () => {
  it('goes loading -> ready, reads through the injected fetch, and renders page 1', async () => {
    const { openPdf, renderPage } = fakePdf();
    const fetch = vi.fn(async () => reply('%PDF', 'application/pdf'));
    const { container } = render(DocumentViewer, {
      props: {
        src: '/files/a.pdf',
        mimeType: 'application/pdf',
        label: 'Print A',
        fetch,
        openPdf,
      },
    });
    expect(root(container)).toHaveAttribute('data-state', 'loading');
    expect(screen.getByText('Loading the document…')).toBeInTheDocument();
    await waitFor(() =>
      expect(root(container)).toHaveAttribute('data-state', 'ready'),
    );
    expect(fetch).toHaveBeenCalledWith(
      '/files/a.pdf',
      expect.objectContaining({ credentials: 'same-origin' }),
    );
    expect(openPdf).toHaveBeenCalledTimes(1);
    expect(openPdf.mock.calls[0]?.[0]).toBeInstanceOf(Uint8Array);
    await waitFor(() =>
      expect(renderPage).toHaveBeenCalledWith(
        1,
        expect.any(HTMLCanvasElement),
        800,
      ),
    );
    expect(screen.getByText('Page 1 of 3')).toBeInTheDocument();
    // Never an <img>/<iframe> on the API.
    expect(container.querySelector('iframe, img, [src]')).toBeNull();
    await expectNoA11yViolations(container);
  });

  it('bounds page navigation at both ends', async () => {
    const { openPdf, renderPage } = fakePdf(2);
    render(DocumentViewer, {
      props: {
        src: '/a.pdf',
        mimeType: 'application/pdf',
        label: 'A',
        fetch: async () => reply('x', 'application/pdf'),
        openPdf,
      },
    });
    await waitFor(() =>
      expect(screen.getByText('Page 1 of 2')).toBeInTheDocument(),
    );
    expect(btn('Previous page')).toBeDisabled();
    await fireEvent.click(btn('Next page'));
    expect(screen.getByText('Page 2 of 2')).toBeInTheDocument();
    expect(btn('Next page')).toBeDisabled();
    await waitFor(() =>
      expect(renderPage).toHaveBeenLastCalledWith(
        2,
        expect.any(HTMLCanvasElement),
        800,
      ),
    );
    await fireEvent.click(btn('Previous page'));
    expect(screen.getByText('Page 1 of 2')).toBeInTheDocument();
  });

  it('hides page navigation for a single page', async () => {
    const { openPdf } = fakePdf(1);
    render(DocumentViewer, {
      props: {
        src: '/a.pdf',
        mimeType: 'application/pdf',
        label: 'A',
        fetch: async () => reply('x', 'application/pdf'),
        openPdf,
      },
    });
    await waitFor(() => expect(btn('Zoom in')).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();
  });

  it('zooms through the steps, stops at the bounds, and Fit resets', async () => {
    const { openPdf, renderPage } = fakePdf(1);
    const { container } = render(DocumentViewer, {
      props: {
        src: '/a.pdf',
        mimeType: 'application/pdf',
        label: 'A',
        fetch: async () => reply('x', 'application/pdf'),
        openPdf,
      },
    });
    await waitFor(() => expect(btn('Zoom in')).toBeEnabled());
    const sheet = () =>
      container.querySelector('[data-smrt-part="sheet"]') as HTMLElement;
    expect(btn('Zoom out')).toBeDisabled();
    expect(btn('Fit')).toBeDisabled();
    await fireEvent.click(btn('Zoom in'));
    expect(sheet()).toHaveAttribute('data-zoom', '1.5');
    await waitFor(() =>
      expect(renderPage).toHaveBeenLastCalledWith(
        1,
        expect.any(HTMLCanvasElement),
        1200,
      ),
    );
    for (let i = 0; i < 6; i++) {
      if (!(btn('Zoom in') as HTMLButtonElement).disabled)
        await fireEvent.click(btn('Zoom in'));
    }
    expect(sheet()).toHaveAttribute('data-zoom', '5');
    expect(btn('Zoom in')).toBeDisabled();
    await fireEvent.click(btn('Zoom out'));
    expect(sheet()).toHaveAttribute('data-zoom', '4');
    await fireEvent.click(btn('Fit'));
    expect(sheet()).toHaveAttribute('data-zoom', '1');
    expect(btn('Fit')).toBeDisabled();
  });

  it('pinch zoom commits when the second finger lifts', async () => {
    const { openPdf } = fakePdf(1);
    const { container } = render(DocumentViewer, {
      props: {
        src: '/a.pdf',
        mimeType: 'application/pdf',
        label: 'A',
        fetch: async () => reply('x', 'application/pdf'),
        openPdf,
      },
    });
    await waitFor(() => expect(btn('Zoom in')).toBeInTheDocument());
    const sheet = container.querySelector(
      '[data-smrt-part="sheet"]',
    ) as HTMLElement;
    await fireEvent.pointerDown(sheet, {
      pointerId: 1,
      clientX: 0,
      clientY: 0,
    });
    await fireEvent.pointerDown(sheet, {
      pointerId: 2,
      clientX: 100,
      clientY: 0,
    });
    await fireEvent.pointerMove(sheet, {
      pointerId: 2,
      clientX: 200,
      clientY: 0,
    });
    await fireEvent.pointerUp(sheet, { pointerId: 2 });
    await fireEvent.pointerUp(sheet, { pointerId: 1 });
    expect(sheet).toHaveAttribute('data-zoom', '2');
  });

  it('shows failed on a bad response and recovers with Try again', async () => {
    const { openPdf } = fakePdf(1);
    const fetch = vi
      .fn()
      .mockResolvedValueOnce(reply('no', 'text/plain', false))
      .mockResolvedValue(reply('x', 'application/pdf'));
    const { container } = render(DocumentViewer, {
      props: {
        src: '/a.pdf',
        mimeType: 'application/pdf',
        label: 'A',
        fetch,
        openPdf,
      },
    });
    await waitFor(() =>
      expect(root(container)).toHaveAttribute('data-state', 'failed'),
    );
    expect(screen.getByRole('alert')).toHaveTextContent('could not be opened');
    await expectNoA11yViolations(container);
    await fireEvent.click(btn('Try again'));
    await waitFor(() =>
      expect(root(container)).toHaveAttribute('data-state', 'ready'),
    );
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it('fails when the opener rejects', async () => {
    const openPdf = vi.fn<OpenPdf>(async () => {
      throw new Error('corrupt');
    });
    const { container } = render(DocumentViewer, {
      props: {
        src: '/a.pdf',
        mimeType: 'application/pdf',
        label: 'A',
        fetch: async () => reply('x', 'application/pdf'),
        openPdf,
      },
    });
    await waitFor(() =>
      expect(root(container)).toHaveAttribute('data-state', 'failed'),
    );
  });

  it('shows unsupported when the PDF engine is not installed', async () => {
    const openPdf = vi.fn<OpenPdf>(async () => {
      throw new PdfEngineUnavailableError();
    });
    const { container } = render(DocumentViewer, {
      props: {
        src: '/a.pdf',
        mimeType: 'application/pdf',
        label: 'A',
        fetch: async () => reply('x', 'application/pdf'),
        openPdf,
      },
    });
    await waitFor(() =>
      expect(root(container)).toHaveAttribute('data-state', 'unsupported'),
    );
  });

  it('destroys the opened document on cleanup', async () => {
    const { openPdf, destroy } = fakePdf(1);
    const { unmount, container } = render(DocumentViewer, {
      props: {
        src: '/a.pdf',
        mimeType: 'application/pdf',
        label: 'A',
        fetch: async () => reply('x', 'application/pdf'),
        openPdf,
      },
    });
    await waitFor(() =>
      expect(root(container)).toHaveAttribute('data-state', 'ready'),
    );
    unmount();
    expect(destroy).toHaveBeenCalledTimes(1);
  });
});

describe('DocumentViewer image', () => {
  it('shows a blob URL image, zooms its width, and revokes the URL on cleanup', async () => {
    const fetch = vi.fn(async () => reply('png', 'image/png'));
    const { container, unmount } = render(DocumentViewer, {
      props: { src: '/p.png', mimeType: 'image/png', label: 'Photo', fetch },
    });
    const image = await screen.findByRole('img', { name: 'Photo' });
    expect(image).toHaveAttribute('src', created[0]);
    expect(screen.queryByRole('button', { name: 'Next page' })).toBeNull();
    await fireEvent.click(btn('Zoom in'));
    expect(image).toHaveStyle({ width: '150%' });
    await expectNoA11yViolations(container);
    expect(revoked).toEqual([]);
    unmount();
    expect(revoked).toEqual([created[0]]);
  });

  it('revokes the previous blob URL when src changes', async () => {
    const fetch = vi.fn(async () => reply('png', 'image/png'));
    const { rerender } = render(DocumentViewer, {
      props: { src: '/1.png', mimeType: 'image/png', label: 'One', fetch },
    });
    await screen.findByRole('img', { name: 'One' });
    await rerender({
      src: '/2.png',
      mimeType: 'image/png',
      label: 'Two',
      fetch,
    });
    await screen.findByRole('img', { name: 'Two' });
    expect(revoked).toEqual([created[0]]);
  });

  it('uses the response Content-Type when mimeType is omitted', async () => {
    render(DocumentViewer, {
      props: {
        src: '/p',
        label: 'Photo',
        fetch: async () => reply('png', 'image/jpeg'),
      },
    });
    expect(
      await screen.findByRole('img', { name: 'Photo' }),
    ).toBeInTheDocument();
  });
});

describe('DocumentViewer unsupported type', () => {
  it('shows unsupported without fetching', async () => {
    const fetch = vi.fn();
    const { container } = render(DocumentViewer, {
      props: {
        src: '/a.docx',
        mimeType: 'application/msword',
        label: 'Doc',
        fetch,
      },
    });
    expect(root(container)).toHaveAttribute('data-state', 'unsupported');
    expect(screen.getByText(/cannot be shown here/)).toBeInTheDocument();
    expect(fetch).not.toHaveBeenCalled();
    expect(screen.queryByRole('button', { name: 'Zoom in' })).toBeNull();
  });

  it('shows unsupported for an unknown response Content-Type', async () => {
    const { container } = render(DocumentViewer, {
      props: {
        src: '/a',
        label: 'Doc',
        fetch: async () => reply('x', 'text/html'),
      },
    });
    await waitFor(() =>
      expect(root(container)).toHaveAttribute('data-state', 'unsupported'),
    );
  });
});

describe('DocumentViewer labels', () => {
  it('applies overrides', async () => {
    render(DocumentViewer, {
      props: {
        src: '/p.png',
        mimeType: 'image/png',
        label: 'Photo',
        fetch: async () => reply('png', 'image/png'),
        labels: { fit: 'Ajustar' },
      },
    });
    await screen.findByRole('img');
    expect(btn('Ajustar')).toBeInTheDocument();
  });
});

describe('createPdfJsOpener', () => {
  function fakeLibrary() {
    const task = { promise: Promise.resolve(), cancel: vi.fn() };
    const proxy = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render: vi.fn(() => task),
    };
    const loading = {
      promise: Promise.resolve({ numPages: 4, getPage: async () => proxy }),
      destroy: vi.fn(async () => undefined),
    };
    const library: PdfJsLike = {
      GlobalWorkerOptions: { workerSrc: '' },
      getDocument: vi.fn(() => loading),
    };
    return { library, proxy, loading };
  }

  it('sets workerSrc, copies the bytes, and renders sized to the css width', async () => {
    const { library, proxy, loading } = fakeLibrary();
    const open = createPdfJsOpener({
      workerSrc: '/pdf.worker.mjs',
      loadLibrary: async () => library,
    });
    const bytes = new Uint8Array([1, 2, 3]);
    const doc = await open(bytes);
    expect(library.GlobalWorkerOptions.workerSrc).toBe('/pdf.worker.mjs');
    expect(doc.pages).toBe(4);
    const data = (library.getDocument as ReturnType<typeof vi.fn>).mock
      .calls[0]?.[0].data;
    expect(data).not.toBe(bytes);
    const canvas = document.createElement('canvas');
    await doc.renderPage(2, canvas, 900);
    expect(canvas.style.width).toBe('900px');
    expect(canvas.style.height).toBe('1200px');
    expect(proxy.render).toHaveBeenCalled();
    await doc.destroy();
    expect(loading.destroy).toHaveBeenCalled();
  });

  it('reports a missing engine as PdfEngineUnavailableError', async () => {
    const open = createPdfJsOpener({
      loadLibrary: async () => {
        throw new Error('Cannot find package pdfjs-dist');
      },
    });
    await expect(open(new Uint8Array())).rejects.toBeInstanceOf(
      PdfEngineUnavailableError,
    );
  });
});

describe('createPdfJsOpener overlapping renders', () => {
  it('a superseded renderPage never draws', async () => {
    const pending: Array<(page: unknown) => void> = [];
    const render = vi.fn(() => ({
      promise: Promise.resolve(),
      cancel: vi.fn(),
    }));
    const page = {
      getViewport: ({ scale }: { scale: number }) => ({
        width: 600 * scale,
        height: 800 * scale,
      }),
      render,
    };
    const library: PdfJsLike = {
      GlobalWorkerOptions: { workerSrc: 'x' },
      getDocument: () => ({
        promise: Promise.resolve({
          numPages: 2,
          getPage: () => new Promise((resolve) => pending.push(resolve)),
        }),
        destroy: async () => undefined,
      }),
    };
    const doc = await createPdfJsOpener({ loadLibrary: async () => library })(
      new Uint8Array(),
    );
    const canvas = document.createElement('canvas');
    const first = doc.renderPage(1, canvas, 800);
    const second = doc.renderPage(2, canvas, 800);
    pending[0]?.(page);
    pending[1]?.(page);
    await Promise.all([first, second]);
    expect(render).toHaveBeenCalledTimes(1);
  });
});

describe('DocumentViewer pinch capture', () => {
  it('captures the pointer and keeps pinching when a finger leaves the sheet', async () => {
    const { openPdf } = fakePdf(1);
    const { container } = render(DocumentViewer, {
      props: {
        src: '/a.pdf',
        mimeType: 'application/pdf',
        label: 'A',
        fetch: async () => reply('x', 'application/pdf'),
        openPdf,
      },
    });
    await waitFor(() => expect(btn('Zoom in')).toBeInTheDocument());
    const sheet = container.querySelector(
      '[data-smrt-part="sheet"]',
    ) as HTMLElement;
    const capture = vi.fn();
    sheet.setPointerCapture = capture;
    await fireEvent.pointerDown(sheet, {
      pointerId: 1,
      clientX: 0,
      clientY: 0,
    });
    await fireEvent.pointerDown(sheet, {
      pointerId: 2,
      clientX: 100,
      clientY: 0,
    });
    expect(capture).toHaveBeenCalledWith(1);
    expect(capture).toHaveBeenCalledWith(2);
    await fireEvent.pointerLeave(sheet, { pointerId: 2 });
    await fireEvent.pointerMove(sheet, {
      pointerId: 2,
      clientX: 200,
      clientY: 0,
    });
    await fireEvent.pointerUp(sheet, { pointerId: 2 });
    expect(sheet).toHaveAttribute('data-zoom', '2');
  });
});
