<!--
  A PDF or picture, readable on a touch screen (smrt#3463).

  The file is read through `fetch` (inject the app's own authenticated one) and
  shown from a blob: never an <img src> or <iframe src> on the API, because an
  embedded WebView may only authenticate through the app's fetch and often has
  no built-in PDF viewer. A PDF is drawn page by page onto a canvas by an
  `OpenPdf` (default: pdf.js through `createPdfJsOpener()`, an optional peer
  dependency; images need nothing).

  Controls are at least 4rem: previous / next with "Page N of M", zoom out /
  Fit / zoom in (1, 1.5, 2, 3, 4, 5), and a two-finger pinch does the same. A
  zoomed document scrolls inside its sheet. States: loading, failed (with
  Try again), unsupported type, and unsupported engine.

  Ported from teamworks-os `PrintViewer.svelte`.
-->
<script lang="ts">
import { M, useI18n } from '../../i18n/index.js';
import { renderTemplate } from '../../i18n/render.js';
import {
  clampPage,
  clampPinchScale,
  commitPinchZoom,
  isImageType,
  isPdfType,
  MAX_ZOOM,
  MIN_ZOOM,
  stepZoom,
} from './document-viewer-logic.js';
import {
  type OpenPdf,
  type PdfDocument,
  PdfEngineUnavailableError,
} from './pdf-types.js';
import type { DocumentViewerLabels } from './types.js';

export interface Props {
  /** URL of the file; read with `fetch`. */
  src: string;
  /** `application/pdf` or `image/*`. Omitted, the response's Content-Type decides. */
  mimeType?: string;
  /** Names the document for assistive technology (the image alt, the page canvas). */
  label: string;
  /** Reads the file; inject the app's authenticated fetch. Default: global `fetch`. */
  fetch?: typeof globalThis.fetch;
  /** Opens PDF bytes. Default: pdf.js via `createPdfJsOpener()`. */
  openPdf?: OpenPdf;
  /** Text overrides; defaults come from the `ui` i18n catalog. */
  labels?: Partial<DocumentViewerLabels>;
  /** DOM id of the component root. */
  id?: string;
  /** CSS class to apply to the component root. */
  class?: string;
}

let {
  src,
  mimeType,
  label,
  fetch: fetchImpl,
  openPdf,
  labels,
  id,
  class: className = '',
}: Props = $props();

const { t } = useI18n();
const text = $derived<DocumentViewerLabels>({
  region: t(M['ui.document_viewer.region']),
  pages: t(M['ui.document_viewer.pages']),
  zoom: t(M['ui.document_viewer.zoom']),
  previousPage: t(M['ui.document_viewer.previous_page']),
  nextPage: t(M['ui.document_viewer.next_page']),
  pageOf: t(M['ui.document_viewer.page_of']),
  pageLabel: t(M['ui.document_viewer.page_label']),
  zoomOut: t(M['ui.document_viewer.zoom_out']),
  zoomIn: t(M['ui.document_viewer.zoom_in']),
  fit: t(M['ui.document_viewer.fit']),
  loading: t(M['ui.document_viewer.loading']),
  failed: t(M['ui.document_viewer.failed']),
  retry: t(M['ui.document_viewer.retry']),
  unsupported: t(M['ui.document_viewer.unsupported']),
  ...labels,
});

type Status = 'loading' | 'ready' | 'failed' | 'unsupported';

let status = $state<Status>('loading');
let kind = $state<'pdf' | 'image' | null>(null);
let imageUrl = $state<string | null>(null);
let pdf = $state.raw<PdfDocument | null>(null);
let page = $state(1);
let zoom = $state(MIN_ZOOM);
/** Live scale while two fingers pinch; committed to `zoom` when they lift. */
let pinchScale = $state(1);
let attempt = $state(0);
let width = $state(0);
let canvas = $state<HTMLCanvasElement | null>(null);

function kindOf(type: string | null | undefined): 'pdf' | 'image' | null {
  if (!type) return null;
  if (isPdfType(type)) return 'pdf';
  if (isImageType(type)) return 'image';
  return null;
}

async function defaultOpenPdf(bytes: Uint8Array): Promise<PdfDocument> {
  // Loaded on demand so a consumer without pdfjs-dist never pulls it in.
  try {
    const { createPdfJsOpener } = await import('./pdf-opener.js');
    openerFallback ??= createPdfJsOpener();
  } catch (error) {
    throw new PdfEngineUnavailableError(
      error instanceof Error ? error.message : undefined,
    );
  }
  return openerFallback(bytes);
}
let openerFallback: OpenPdf | undefined;

// Read the file whenever the source (or a retry) changes; release the last one.
$effect(() => {
  const href = src;
  const declared = mimeType;
  const reader = fetchImpl ?? globalThis.fetch.bind(globalThis);
  const open = openPdf ?? defaultOpenPdf;
  void attempt;
  let live = true;
  let url: string | null = null;
  let opened: PdfDocument | null = null;
  status = 'loading';
  imageUrl = null;
  pdf = null;
  kind = kindOf(declared);
  page = 1;
  zoom = MIN_ZOOM;
  pinchScale = 1;
  if (declared !== undefined && kindOf(declared) === null) {
    status = 'unsupported';
    return;
  }
  void (async () => {
    try {
      const response = await reader(href, {
        credentials: 'same-origin',
        cache: 'no-store',
      });
      if (!response.ok) throw new Error(String(response.status));
      const resolved =
        kindOf(declared) ?? kindOf(response.headers?.get('content-type'));
      if (!live) return;
      if (resolved === null) {
        status = 'unsupported';
        return;
      }
      kind = resolved;
      if (resolved === 'pdf') {
        const bytes = new Uint8Array(await response.arrayBuffer());
        if (!live) return;
        opened = await open(bytes);
        if (!live) {
          void opened.destroy();
          opened = null;
          return;
        }
        pdf = opened;
      } else {
        const blob = await response.blob();
        if (!live) return;
        url = URL.createObjectURL(blob);
        imageUrl = url;
      }
      status = 'ready';
    } catch (error) {
      if (!live) return;
      status =
        error instanceof PdfEngineUnavailableError ? 'unsupported' : 'failed';
    }
  })();
  return () => {
    live = false;
    if (url) URL.revokeObjectURL(url);
    if (opened) void opened.destroy();
  };
});

// Draw the page at the sheet's width times the zoom.
$effect(() => {
  const doc = pdf;
  const target = canvas;
  const at = page;
  const cssWidth = (width || 800) * zoom;
  if (!doc || !target) return;
  doc.renderPage(at, target, cssWidth).catch(() => {
    if (pdf === doc) status = 'failed';
  });
});

function step(delta: number): void {
  if (!pdf) return;
  page = clampPage(page, delta, pdf.pages);
}

// Pinch: two pointers on the sheet; the distance between them scales the file.
const pointers = new Map<number, { x: number; y: number }>();
let pinchStart = 0;
function distance(): number {
  const [a, b] = [...pointers.values()];
  return a && b ? Math.hypot(a.x - b.x, a.y - b.y) : 0;
}
function pointerDown(event: PointerEvent): void {
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  // Keep receiving moves when a finger drifts outside the sheet.
  (event.currentTarget as HTMLElement | null)?.setPointerCapture?.(
    event.pointerId,
  );
  if (pointers.size === 2) pinchStart = distance();
}
function pointerMove(event: PointerEvent): void {
  if (!pointers.has(event.pointerId)) return;
  pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
  if (pointers.size === 2 && pinchStart > 0) {
    pinchScale = clampPinchScale(zoom, distance() / pinchStart);
  }
}
function pointerUp(event: PointerEvent): void {
  pointers.delete(event.pointerId);
  if (pointers.size < 2 && pinchStart > 0) {
    zoom = commitPinchZoom(zoom, pinchScale);
    pinchScale = 1;
    pinchStart = 0;
  }
}
</script>

<div
  id={id}
  class="document-viewer {className}"
  role="group"
  aria-label={label}
  data-state={status}
  data-kind={kind ?? undefined}
  data-smrt-component="DocumentViewer"
>
  <div class="controls" data-smrt-part="controls">
    {#if pdf && pdf.pages > 1}
      <div class="group" role="group" aria-label={text.pages}>
        <button
          type="button"
          class="ctl"
          data-smrt-part="control"
          data-control="previous"
          aria-label={text.previousPage}
          disabled={page <= 1}
          onclick={() => step(-1)}
        >
          <span aria-hidden="true">◀</span>
        </button>
        <span class="where" data-smrt-part="page-indicator" aria-live="polite">
          {renderTemplate(text.pageOf, { page, pages: pdf.pages })}
        </span>
        <button
          type="button"
          class="ctl"
          data-smrt-part="control"
          data-control="next"
          aria-label={text.nextPage}
          disabled={page >= pdf.pages}
          onclick={() => step(1)}
        >
          <span aria-hidden="true">▶</span>
        </button>
      </div>
    {/if}
    {#if status === 'ready'}
      <div class="group" role="group" aria-label={text.zoom}>
        <button
          type="button"
          class="ctl"
          data-smrt-part="control"
          data-control="zoom-out"
          aria-label={text.zoomOut}
          disabled={zoom <= MIN_ZOOM}
          onclick={() => (zoom = stepZoom(zoom, -1))}
        >
          <span aria-hidden="true">−</span>
        </button>
        <button
          type="button"
          class="ctl fit"
          data-smrt-part="control"
          data-control="fit"
          disabled={zoom === MIN_ZOOM}
          onclick={() => (zoom = MIN_ZOOM)}
        >
          {text.fit}
        </button>
        <button
          type="button"
          class="ctl"
          data-smrt-part="control"
          data-control="zoom-in"
          aria-label={text.zoomIn}
          disabled={zoom >= MAX_ZOOM}
          onclick={() => (zoom = stepZoom(zoom, 1))}
        >
          <span aria-hidden="true">+</span>
        </button>
      </div>
    {/if}
  </div>

  <!-- svelte-ignore a11y_no_static_element_interactions (pinch is a shortcut; zoom out / Fit / zoom in are the controls) -->
  <div
    class="sheet"
    data-smrt-part="sheet"
    data-zoom={zoom}
    bind:clientWidth={width}
    onpointerdown={pointerDown}
    onpointermove={pointerMove}
    onpointerup={pointerUp}
    onpointercancel={pointerUp}
  >
    {#if status === 'loading'}
      <p class="hold" data-smrt-part="loading" role="status">{text.loading}</p>
    {:else if status === 'failed'}
      <div class="hold" data-smrt-part="failed">
        <p role="alert">{text.failed}</p>
        <button
          type="button"
          class="ctl retry"
          data-smrt-part="control"
          data-control="retry"
          onclick={() => (attempt += 1)}
        >
          {text.retry}
        </button>
      </div>
    {:else if status === 'unsupported'}
      <p class="hold" data-smrt-part="unsupported" role="status">{text.unsupported}</p>
    {:else if kind === 'pdf'}
      <canvas
        bind:this={canvas}
        aria-label={renderTemplate(text.pageLabel, { label, page })}
        style:transform={pinchScale === 1 ? null : `scale(${pinchScale})`}
      ></canvas>
    {:else if kind === 'image' && imageUrl}
      <img
        src={imageUrl}
        alt={label}
        style:width="{zoom * 100}%"
        style:transform={pinchScale === 1 ? null : `scale(${pinchScale})`}
      />
    {/if}
  </div>
</div>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
  .document-viewer {
    display: grid;
    gap: var(--smrt-spacing-3);
    color: var(--smrt-color-on-surface);
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: var(--smrt-spacing-3);
  }
  .group {
    display: flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
  }
  /* Glove-size: at least 4rem square, whatever the density token says. */
  .ctl {
    min-width: max(4rem, var(--smrt-touch-target-min));
    min-height: max(4rem, var(--smrt-touch-target-min));
    padding: 0 var(--smrt-spacing-4);
    border: var(--smrt-hairline-strong);
    border-radius: var(--smrt-radius-medium);
    background: var(--smrt-color-surface-container-highest);
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-headline-large-font);
    cursor: pointer;
    touch-action: manipulation;
  }
  .ctl.fit,
  .ctl.retry {
    font: var(--smrt-typography-title-large-font);
  }
  .ctl:focus-visible {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
  .ctl:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }
  .where {
    min-width: 8rem;
    text-align: center;
    font: var(--smrt-typography-title-large-font);
  }
  /* The document's own sheet: scrolls when zoomed past its width. Paper stays
     light in every scheme (a document is content, not chrome). */
  .sheet {
    display: grid;
    justify-items: start;
    align-items: start;
    min-height: 24rem;
    max-height: 70vh;
    overflow: auto;
    border: var(--smrt-hairline-strong);
    border-radius: var(--smrt-radius-small);
    background: var(--smrt-color-surface-container-lowest);
    touch-action: pan-x pan-y;
  }
  canvas,
  img {
    display: block;
    transform-origin: 0 0;
  }
  img {
    max-width: none;
    height: auto;
  }
  .hold {
    display: grid;
    gap: var(--smrt-spacing-4);
    place-items: center;
    align-self: center;
    justify-self: center;
    margin: 0;
    padding: var(--smrt-spacing-8);
    text-align: center;
    font: var(--smrt-typography-title-large-font);
  }
}
</style>
