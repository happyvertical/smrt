<script lang="ts">
import type { ImageLike } from '@happyvertical/smrt-images/svelte';
import { Select } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import {
  bodyToEditorHtml,
  type ContentBodyFormat,
  type ContentBodyImage,
  type ContentBodyImagePlacement,
  editorHtmlToBody,
  extractBodyImages,
  type ImageAssetLike,
  imageAssetToHtml,
  normalizeEditorHtml,
  resolveBodyFormat,
} from '../../body-format';
import { M } from '../i18n.editor.js';

const { t } = useI18n();

export interface ContentBodyEditorChange {
  body: string;
  bodyFormat: ContentBodyFormat;
  images: ContentBodyImage[];
}

export interface Props {
  value: string;
  format?: ContentBodyFormat | null;
  placeholder?: string;
  selectedImageIndex?: number;
  onChange?: (change: ContentBodyEditorChange) => void;
  onOpenImageChooser?: () => void;
  onSelectImage?: (index: number) => void;
  onUseImageAsThumbnail?: (assetId: string) => void;
  onResolveImage?: (
    selected: ImageLike | File | string,
  ) => Promise<unknown> | unknown;
}

let {
  value,
  format = null,
  placeholder = 'Start writing...',
  selectedImageIndex = -1,
  onChange = undefined,
  onOpenImageChooser = undefined,
  onSelectImage = undefined,
  onUseImageAsThumbnail = undefined,
  onResolveImage = undefined,
}: Props = $props();

const MIN_IMAGE_WIDTH = 120;
const IMAGE_WIDTH_STEP = 80;
const INPUT_CHANGE_DEBOUNCE_MS = 120;
const ELEMENT_NODE = 1;
const TEXT_NODE = 3;
const EDITOR_TEXT_BLOCK_TAGS = new Set([
  'P',
  'DIV',
  'LI',
  'H1',
  'H2',
  'H3',
  'H4',
  'H5',
  'H6',
  'BLOCKQUOTE',
  'PRE',
]);

type ImageBox = {
  top: number;
  left: number;
  width: number;
  height: number;
};

let editorElement = $state<HTMLDivElement | null>(null);
let rootElement = $state<HTMLDivElement | null>(null);
let currentFormat = $state<ContentBodyFormat>('html');
let editorHtml = $state('');
let lastExternalKey = $state('');
let isFocused = $state(false);
let isDragging = $state(false);
let selectedImageIndexState = $state(-1);
let selectedImageBox = $state<ImageBox | null>(null);
let selectedImagePlacement = $state<ContentBodyImagePlacement>('block');
let selectedImageAssetId = $state<string | null>(null);
let savedRange: Range | null = null;
let movingImageIndex: number | null = null;
let resizeState: {
  frame: HTMLElement;
  startX: number;
  startWidth: number;
} | null = null;
let moveState: {
  imageIndex: number;
  frame: HTMLElement;
} | null = null;
let lastAppliedSelectedImageIndex: number | null = null;
let inputChangeTimer: ReturnType<typeof setTimeout> | null = null;

function makeExternalKey(body: string, bodyFormat: ContentBodyFormat) {
  return `${bodyFormat}\u0000${body || ''}`;
}

$effect(() => {
  const resolvedFormat = resolveBodyFormat(format, value);
  const externalKey = makeExternalKey(value || '', resolvedFormat);
  if (externalKey === lastExternalKey) {
    return;
  }

  currentFormat = resolvedFormat;
  editorHtml = bodyToEditorHtml(value || '', resolvedFormat);
  lastExternalKey = externalKey;

  if (editorElement && !isFocused && editorElement.innerHTML !== editorHtml) {
    editorElement.innerHTML = editorHtml;
  }
});

$effect(() => {
  const nextSelectedImageIndex = selectedImageIndex;
  if (nextSelectedImageIndex === lastAppliedSelectedImageIndex) {
    return;
  }

  lastAppliedSelectedImageIndex = nextSelectedImageIndex;
  if (nextSelectedImageIndex >= 0) {
    focusImage(nextSelectedImageIndex);
  } else {
    clearImageSelection({ notify: false });
  }
});

$effect(() => {
  if (typeof window === 'undefined') {
    return;
  }

  const update = () => {
    if (selectedImageIndexState < 0) {
      return;
    }
    refreshSelectedImageChrome();
  };
  window.addEventListener('resize', update);
  window.addEventListener('scroll', update, true);

  return () => {
    window.removeEventListener('resize', update);
    window.removeEventListener('scroll', update, true);
  };
});

$effect(() => {
  return () => clearPendingInputChange();
});

function saveSelection() {
  if (typeof window === 'undefined' || !editorElement) {
    return;
  }

  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return;
  }

  const range = selection.getRangeAt(0);
  if (editorElement.contains(range.commonAncestorContainer)) {
    savedRange = range.cloneRange();
  }
}

function restoreSelection() {
  if (typeof window === 'undefined' || !editorElement) {
    return;
  }

  editorElement.focus();
  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  selection.removeAllRanges();
  if (savedRange) {
    selection.addRange(savedRange);
    return;
  }

  const range = document.createRange();
  range.selectNodeContents(editorElement);
  range.collapse(false);
  selection.addRange(range);
  savedRange = range.cloneRange();
}

function getElementFromNode(node: Node | null): HTMLElement | null {
  if (!node) {
    return null;
  }

  if (node.nodeType === ELEMENT_NODE) {
    return node as HTMLElement;
  }

  return node.parentElement;
}

function findEditableBlock(node: Node | null): HTMLElement | null {
  let element = getElementFromNode(node);

  while (element && element !== editorElement) {
    if (EDITOR_TEXT_BLOCK_TAGS.has(element.tagName)) {
      return element;
    }

    element = element.parentElement;
  }

  return null;
}

function isImageOnlyBlock(element: HTMLElement): boolean {
  if (!EDITOR_TEXT_BLOCK_TAGS.has(element.tagName)) {
    return false;
  }

  if (element.querySelectorAll('img').length !== 1) {
    return false;
  }

  return Array.from(element.childNodes).every((child) => {
    if (child.nodeType === TEXT_NODE) {
      return !child.textContent?.trim();
    }

    if (child.nodeType !== ELEMENT_NODE) {
      return true;
    }

    const childElement = child as HTMLElement;
    return childElement.tagName === 'IMG' || childElement.tagName === 'BR';
  });
}

function isEmptyEditableBlock(element: HTMLElement): boolean {
  return (
    EDITOR_TEXT_BLOCK_TAGS.has(element.tagName) &&
    !element.textContent?.trim() &&
    !element.querySelector('img, video, iframe, table')
  );
}

function getInsertionAnchor(block: HTMLElement): HTMLElement {
  if (block.tagName === 'LI') {
    const list = block.closest('ul, ol') as HTMLElement | null;
    if (list && editorElement?.contains(list)) {
      return list;
    }
  }

  return block;
}

function createTrailingTextBlock(): HTMLParagraphElement {
  const paragraph = document.createElement('p');
  paragraph.appendChild(document.createElement('br'));
  return paragraph;
}

function insertNodesAtEditableRange(range: Range, nodes: Node[]) {
  const activeBlock = findEditableBlock(range.commonAncestorContainer);

  if (activeBlock) {
    const anchor = getInsertionAnchor(activeBlock);
    if (isEmptyEditableBlock(activeBlock) && activeBlock === anchor) {
      activeBlock.replaceWith(...nodes);
    } else {
      anchor.after(...nodes);
    }
    return;
  }

  const fragment = document.createDocumentFragment();
  fragment.append(...nodes);
  range.insertNode(fragment);
}

function setCaretInsideElement(element: HTMLElement, atStart = true) {
  if (typeof window === 'undefined') {
    return;
  }

  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(atStart);
  selection.removeAllRanges();
  selection.addRange(range);
  savedRange = range.cloneRange();
}

function setCaretAfterNode(node: Node) {
  if (typeof window === 'undefined') {
    return;
  }

  const selection = window.getSelection();
  if (!selection) {
    return;
  }

  const range = document.createRange();
  range.setStartAfter(node);
  range.collapse(true);
  selection.removeAllRanges();
  selection.addRange(range);
  savedRange = range.cloneRange();
}

function getEditorImages(): HTMLImageElement[] {
  if (!editorElement) {
    return [];
  }

  return Array.from(editorElement.querySelectorAll('img'));
}

function getImageFrame(image: HTMLImageElement): HTMLElement {
  const figure = image.closest(
    'figure[data-smrt-inline-image]',
  ) as HTMLElement | null;

  if (figure && editorElement?.contains(figure)) {
    return figure;
  }

  return image;
}

function getImageLayoutRoot(image: HTMLImageElement): HTMLElement {
  const frame = getImageFrame(image);
  if (frame.tagName === 'FIGURE') {
    return frame;
  }

  const block = findEditableBlock(frame);
  return block && isImageOnlyBlock(block) ? block : frame;
}

function getSelectedImage(): HTMLImageElement | null {
  const images = getEditorImages();
  return selectedImageIndexState >= 0
    ? images[selectedImageIndexState] || null
    : null;
}

function getImagePlacement(frame: HTMLElement): ContentBodyImagePlacement {
  const placement = frame.getAttribute('data-smrt-placement');
  return placement === 'left' ||
    placement === 'right' ||
    placement === 'center' ||
    placement === 'full' ||
    placement === 'block'
    ? placement
    : 'block';
}

function getImageWidth(frame: HTMLElement): number {
  const attributeWidth = Number(frame.getAttribute('data-smrt-width'));
  if (Number.isFinite(attributeWidth) && attributeWidth > 0) {
    return attributeWidth;
  }

  const rectWidth = Math.round(frame.getBoundingClientRect().width);
  if (rectWidth > 0) {
    return rectWidth;
  }

  return 360;
}

function getMaxImageWidth(): number {
  const editorWidth = editorElement?.getBoundingClientRect().width || 720;
  return Math.max(MIN_IMAGE_WIDTH, Math.round(editorWidth - 32));
}

function setImageWidth(frame: HTMLElement, width: number) {
  const clamped = Math.min(
    getMaxImageWidth(),
    Math.max(MIN_IMAGE_WIDTH, Math.round(width)),
  );

  frame.setAttribute('data-smrt-width', String(clamped));
  frame.style.width = `${clamped}px`;
  frame.style.maxWidth = '100%';

  if (getImagePlacement(frame) === 'full') {
    frame.setAttribute('data-smrt-placement', 'block');
  }
}

function getRangeFromPoint(x: number, y: number): Range | null {
  if (typeof document === 'undefined' || !editorElement) {
    return null;
  }

  const doc = editorElement.ownerDocument as Document & {
    caretRangeFromPoint?: (x: number, y: number) => Range | null;
    caretPositionFromPoint?: (
      x: number,
      y: number,
    ) => { offsetNode: Node; offset: number } | null;
  };

  if (typeof doc.caretRangeFromPoint === 'function') {
    const range = doc.caretRangeFromPoint(x, y);
    if (range && editorElement.contains(range.commonAncestorContainer)) {
      return range;
    }
  }

  if (typeof doc.caretPositionFromPoint === 'function') {
    const position = doc.caretPositionFromPoint(x, y);
    if (position && editorElement.contains(position.offsetNode)) {
      const range = doc.createRange();
      range.setStart(position.offsetNode, position.offset);
      range.collapse(true);
      return range;
    }
  }

  return savedRange?.cloneRange() || null;
}

function placementFromPoint(x: number): ContentBodyImagePlacement | null {
  if (!editorElement) {
    return null;
  }

  const rect = editorElement.getBoundingClientRect();
  const relativeX = (x - rect.left) / rect.width;
  if (relativeX < 0.28) {
    return 'left';
  }
  if (relativeX > 0.72) {
    return 'right';
  }
  return null;
}

function refreshSelectedImageChrome() {
  if (selectedImageIndexState < 0) {
    selectedImageBox = null;
    selectedImageAssetId = null;
    selectedImagePlacement = 'block';
    return;
  }

  const image = getSelectedImage();
  if (!image || !rootElement || !editorElement?.contains(image)) {
    selectedImageBox = null;
    selectedImageAssetId = null;
    selectedImagePlacement = 'block';
    return;
  }

  const frame = getImageFrame(image);
  const imageRect = frame.getBoundingClientRect();
  const rootRect = rootElement.getBoundingClientRect();

  selectedImageBox = {
    top: imageRect.top - rootRect.top,
    left: imageRect.left - rootRect.left,
    width: imageRect.width,
    height: imageRect.height,
  };
  selectedImagePlacement = getImagePlacement(frame);
  selectedImageAssetId = image.getAttribute('data-smrt-asset-id');
}

function placeCaretAfterImage(image: HTMLImageElement) {
  if (!editorElement) {
    return;
  }

  const root = getImageLayoutRoot(image);
  const parent = root.parentElement;
  if (!parent || parent !== editorElement) {
    setCaretAfterNode(root);
    return;
  }

  let next = root.nextSibling;
  while (next?.nodeType === TEXT_NODE && !next.textContent?.trim()) {
    next = next.nextSibling;
  }

  if (
    next?.nodeType === ELEMENT_NODE &&
    EDITOR_TEXT_BLOCK_TAGS.has((next as HTMLElement).tagName)
  ) {
    setCaretInsideElement(next as HTMLElement);
    return;
  }

  const trailingBlock = createTrailingTextBlock();
  root.after(trailingBlock);
  setCaretInsideElement(trailingBlock);
}

function selectImageElement(
  image: HTMLImageElement,
  options: { notify?: boolean } = {},
) {
  const images = getEditorImages();
  const index = images.indexOf(image);
  if (index < 0) {
    return;
  }

  for (const candidate of images) {
    candidate.removeAttribute('data-smrt-selected');
  }

  image.setAttribute('data-smrt-selected', 'true');
  selectedImageIndexState = index;
  refreshSelectedImageChrome();
  placeCaretAfterImage(image);

  if (options.notify !== false) {
    onSelectImage?.(index);
  }
}

function clearImageSelection(options: { notify?: boolean } = {}) {
  const hadSelection =
    selectedImageIndexState >= 0 ||
    getEditorImages().some((image) => image.hasAttribute('data-smrt-selected'));

  for (const image of getEditorImages()) {
    image.removeAttribute('data-smrt-selected');
  }
  selectedImageIndexState = -1;
  selectedImageBox = null;
  selectedImageAssetId = null;

  if (hadSelection && options.notify !== false) {
    onSelectImage?.(-1);
  }
}

function clearPendingInputChange() {
  if (inputChangeTimer) {
    clearTimeout(inputChangeTimer);
    inputChangeTimer = null;
  }
}

function scheduleInputChange() {
  clearPendingInputChange();
  inputChangeTimer = setTimeout(() => {
    inputChangeTimer = null;
    emitChange();
  }, INPUT_CHANGE_DEBOUNCE_MS);
}

function emitChange(options: { syncDom?: boolean } = {}) {
  if (!editorElement) {
    return;
  }

  clearPendingInputChange();
  const rawHtml = editorElement.innerHTML;
  const normalizedHtml = normalizeEditorHtml(rawHtml);
  if (options.syncDom && editorElement.innerHTML !== normalizedHtml) {
    editorElement.innerHTML = normalizedHtml;
    editorHtml = normalizedHtml;
  }

  const body = editorHtmlToBody(normalizedHtml, currentFormat);
  lastExternalKey = makeExternalKey(body, currentFormat);
  onChange?.({
    body,
    bodyFormat: currentFormat,
    images: extractBodyImages(body, currentFormat),
  });
  refreshSelectedImageChrome();
}

function runCommand(command: string, value?: string) {
  restoreSelection();
  document.execCommand(command, false, value);
  saveSelection();
  emitChange();
}

function setBodyFormat(nextFormat: ContentBodyFormat) {
  currentFormat = nextFormat;
  emitChange();
}

function insertHtml(html: string) {
  if (!html || !editorElement) {
    return;
  }

  restoreSelection();
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();
  const fragment = range.createContextualFragment(html);
  const lastNode = fragment.lastChild;
  range.insertNode(fragment);

  if (lastNode) {
    range.setStartAfter(lastNode);
    range.collapse(true);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  saveSelection();
  emitChange();
}

function insertImageHtml(html: string) {
  if (!html || !editorElement) {
    return;
  }

  restoreSelection();
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) {
    return;
  }

  const range = selection.getRangeAt(0);
  range.deleteContents();

  const template = document.createElement('template');
  template.innerHTML = html.trim();
  const image = template.content.querySelector('img');
  if (!image) {
    insertHtml(html);
    return;
  }

  const insertedImage = image.cloneNode(true) as HTMLImageElement;
  const trailingBlock = createTrailingTextBlock();
  insertNodesAtEditableRange(range, [insertedImage, trailingBlock]);
  setCaretInsideElement(trailingBlock);
  saveSelection();
  emitChange();
}

export function insertImageAsset(asset: ImageAssetLike | null | undefined) {
  insertImageHtml(imageAssetToHtml(asset));
}

export function focusImage(index: number) {
  if (!editorElement || index < 0) {
    return;
  }

  const images = Array.from(editorElement.querySelectorAll('img'));
  const target = images[index];
  for (const image of images) {
    image.removeAttribute('data-smrt-selected');
  }

  if (!target) {
    return;
  }

  target.setAttribute('data-smrt-selected', 'true');
  selectedImageIndexState = index;
  target.scrollIntoView?.({ block: 'center', inline: 'nearest' });

  placeCaretAfterImage(target);
  refreshSelectedImageChrome();
}

function applyImagePlacement(placement: ContentBodyImagePlacement) {
  const image = getSelectedImage();
  if (!image) {
    return;
  }

  const frame = getImageFrame(image);
  frame.setAttribute('data-smrt-inline-image', 'true');
  frame.setAttribute('data-smrt-placement', placement);

  if (placement === 'full') {
    frame.removeAttribute('data-smrt-width');
    frame.style.width = '100%';
    frame.style.maxWidth = '100%';
  } else if (placement === 'left' || placement === 'right') {
    const wrappedWidth = Math.min(360, Math.round(getMaxImageWidth() * 0.45));
    setImageWidth(frame, Math.min(getImageWidth(frame), wrappedWidth));
  } else if (frame.style.width === '100%') {
    frame.style.removeProperty('width');
  }

  selectImageElement(image, { notify: false });
  emitChange();
}

function resizeSelectedImage(delta: number) {
  const image = getSelectedImage();
  if (!image) {
    return;
  }

  const frame = getImageFrame(image);
  setImageWidth(frame, getImageWidth(frame) + delta);
  selectImageElement(image, { notify: false });
  emitChange();
}

function removeSelectedImage() {
  const image = getSelectedImage();
  if (!image) {
    return;
  }

  const frame = getImageFrame(image);
  frame.remove();
  clearImageSelection();
  emitChange();
}

function useSelectedImageAsThumbnail() {
  if (selectedImageAssetId) {
    onUseImageAsThumbnail?.(selectedImageAssetId);
  }
}

function handleResizePointerMove(event: PointerEvent) {
  if (!resizeState) {
    return;
  }

  const delta = event.clientX - resizeState.startX;
  setImageWidth(resizeState.frame, resizeState.startWidth + delta);
  refreshSelectedImageChrome();
}

function handleResizePointerUp() {
  if (!resizeState) {
    return;
  }

  resizeState.frame.removeAttribute('data-smrt-resizing');
  resizeState = null;
  window.removeEventListener('pointermove', handleResizePointerMove);
  window.removeEventListener('pointerup', handleResizePointerUp);
  emitChange();
}

function startImageResize(event: PointerEvent) {
  event.preventDefault();
  event.stopPropagation();

  const image = getSelectedImage();
  if (!image) {
    return;
  }

  const frame = getImageFrame(image);
  resizeState = {
    frame,
    startX: event.clientX,
    startWidth: getImageWidth(frame),
  };
  frame.setAttribute('data-smrt-resizing', 'true');
  window.addEventListener('pointermove', handleResizePointerMove);
  window.addEventListener('pointerup', handleResizePointerUp);
}

function moveImageToRange(
  imageIndex: number,
  range: Range | null,
  clientX?: number,
) {
  if (!editorElement || !range) {
    return;
  }

  const image = getEditorImages()[imageIndex];
  if (!image) {
    return;
  }

  const frame = getImageFrame(image);
  const layoutRoot = getImageLayoutRoot(image);
  if (layoutRoot.contains(range.commonAncestorContainer)) {
    return;
  }

  const nextPlacement =
    typeof clientX === 'number' ? placementFromPoint(clientX) : null;

  layoutRoot.remove();
  insertNodesAtEditableRange(range, [layoutRoot]);
  range.setStartAfter(layoutRoot);
  range.collapse(true);
  savedRange = range.cloneRange();

  if (nextPlacement) {
    frame.setAttribute('data-smrt-placement', nextPlacement);
  }

  selectImageElement(image);
  emitChange();
}

function handleMovePointerUp(event: PointerEvent) {
  if (!moveState) {
    return;
  }

  moveState.frame.removeAttribute('data-smrt-moving');
  const imageIndex = moveState.imageIndex;
  moveState = null;
  window.removeEventListener('pointerup', handleMovePointerUp);
  moveImageToRange(
    imageIndex,
    getRangeFromPoint(event.clientX, event.clientY),
    event.clientX,
  );
}

function startImageMove(event: PointerEvent) {
  event.preventDefault();
  event.stopPropagation();

  const image = getSelectedImage();
  if (!image || selectedImageIndexState < 0) {
    return;
  }

  const frame = getImageFrame(image);
  frame.setAttribute('data-smrt-moving', 'true');
  moveState = {
    imageIndex: selectedImageIndexState,
    frame,
  };
  window.addEventListener('pointerup', handleMovePointerUp);
}

async function resolveAndInsertImage(selected: ImageLike | File | string) {
  // Dynamic boundary: the consumer-supplied `onResolveImage` callback returns an
  // opaque resolved value (or, without it, the raw ImageLike/File/string). The
  // image helpers read optional fields defensively, so coerce to the structural
  // ImageAssetLike shape rather than widening the public insertImageAsset param.
  const asset = onResolveImage ? await onResolveImage(selected) : selected;
  if (asset) {
    insertImageAsset(asset as ImageAssetLike);
  }
}

function parseDraggedImage(dataTransfer: DataTransfer): ImageLike | null {
  const payload = dataTransfer.getData('application/x-smrt-image');
  if (!payload) {
    return null;
  }

  try {
    return JSON.parse(payload) as ImageLike;
  } catch {
    return null;
  }
}

function handleDragOver(event: DragEvent) {
  event.preventDefault();
  isDragging = true;
  if (event.dataTransfer) {
    event.dataTransfer.dropEffect = movingImageIndex === null ? 'copy' : 'move';
  }
}

function handleDragLeave(event: DragEvent) {
  const relatedTarget = event.relatedTarget as Node | null;
  const currentTarget = event.currentTarget as Node;
  if (relatedTarget && currentTarget.contains(relatedTarget)) {
    return;
  }

  isDragging = false;
}

async function handleDrop(event: DragEvent) {
  event.preventDefault();
  isDragging = false;
  if (!event.dataTransfer) {
    return;
  }

  const dropRange = getRangeFromPoint(event.clientX, event.clientY);
  const bodyImageIndex = event.dataTransfer.getData(
    'application/x-smrt-body-image-index',
  );
  const parsedBodyImageIndex =
    bodyImageIndex === '' ? movingImageIndex : Number(bodyImageIndex);
  if (
    typeof parsedBodyImageIndex === 'number' &&
    Number.isInteger(parsedBodyImageIndex) &&
    parsedBodyImageIndex >= 0
  ) {
    moveImageToRange(parsedBodyImageIndex, dropRange, event.clientX);
    movingImageIndex = null;
    return;
  }

  const draggedImage = parseDraggedImage(event.dataTransfer);
  if (draggedImage) {
    if (dropRange) {
      savedRange = dropRange.cloneRange();
    }
    await resolveAndInsertImage(draggedImage);
    return;
  }

  const imageFiles = Array.from(event.dataTransfer.files).filter((file) =>
    file.type.startsWith('image/'),
  );
  if (imageFiles.length > 0) {
    if (dropRange) {
      savedRange = dropRange.cloneRange();
    }
    for (const file of imageFiles) {
      await resolveAndInsertImage(file);
    }
    return;
  }

  const url =
    event.dataTransfer.getData('text/uri-list') ||
    event.dataTransfer.getData('text/plain');
  if (url && /^https?:\/\//i.test(url.trim())) {
    if (dropRange) {
      savedRange = dropRange.cloneRange();
    }
    await resolveAndInsertImage(url.trim());
  }
}

function handleSurfaceClick(event: MouseEvent) {
  const target = event.target as Element | null;
  const image = target?.closest('img') as HTMLImageElement | null;
  if (image && editorElement?.contains(image)) {
    event.preventDefault();
    selectImageElement(image);
    return;
  }

  clearImageSelection();
  saveSelection();
}

function handleEditorDragStart(event: DragEvent) {
  const target = event.target as Element | null;
  const image =
    (target?.closest('img') as HTMLImageElement | null) ||
    (target
      ?.closest('figure[data-smrt-inline-image]')
      ?.querySelector('img') as HTMLImageElement | null);
  if (!image || !editorElement?.contains(image) || !event.dataTransfer) {
    return;
  }

  selectImageElement(image);
  movingImageIndex = selectedImageIndexState;
  event.dataTransfer.effectAllowed = 'move';
  event.dataTransfer.setData(
    'application/x-smrt-body-image-index',
    String(selectedImageIndexState),
  );
}

function handleEditorDragEnd() {
  movingImageIndex = null;
  isDragging = false;
  refreshSelectedImageChrome();
}
</script>

<div bind:this={rootElement} class="content-body-editor">
  <div class="body-editor-toolbar" aria-label={t(M['content.content_body_editor.toolbar'])}>
    <Button variant="ghost" size="sm" class="editor-toolbar-button" type="button" title={t(M['content.content_body_editor.bold'])} aria-label={t(M['content.content_body_editor.bold'])} onclick={() => runCommand('bold')}>
      <strong>B</strong>
    </Button>
    <Button variant="ghost" size="sm" class="editor-toolbar-button" type="button" title={t(M['content.content_body_editor.italic'])} aria-label={t(M['content.content_body_editor.italic'])} onclick={() => runCommand('italic')}>
      <em>I</em>
    </Button>
    <Button variant="ghost" size="sm" class="editor-toolbar-button" type="button" title={t(M['content.content_body_editor.heading'])} aria-label={t(M['content.content_body_editor.heading'])} onclick={() => runCommand('formatBlock', 'h2')}>
      H2
    </Button>
    <Button variant="ghost" size="sm" class="editor-toolbar-button" type="button" title={t(M['content.content_body_editor.bulleted_list'])} aria-label={t(M['content.content_body_editor.bulleted_list'])} onclick={() => runCommand('insertUnorderedList')}>
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <line x1="9" y1="6" x2="21" y2="6"></line>
        <line x1="9" y1="12" x2="21" y2="12"></line>
        <line x1="9" y1="18" x2="21" y2="18"></line>
        <circle cx="4" cy="6" r="1"></circle>
        <circle cx="4" cy="12" r="1"></circle>
        <circle cx="4" cy="18" r="1"></circle>
      </svg>
    </Button>
    <Button variant="ghost" size="sm" class="editor-toolbar-button" type="button" title={t(M['content.content_body_editor.insert_image'])} aria-label={t(M['content.content_body_editor.insert_image'])} onclick={() => onOpenImageChooser?.()}>
      <svg viewBox="0 0 24 24" width="17" height="17" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
        <rect x="3" y="3" width="18" height="18" rx="2"></rect>
        <circle cx="8.5" cy="8.5" r="1.5"></circle>
        <polyline points="21 15 16 10 5 21"></polyline>
      </svg>
    </Button>

    <label class="format-select">
      <span>{t(M['content.content_body_editor.save_as'])}</span>
      <Select
        value={currentFormat}
        onchange={(event) => setBodyFormat((event.currentTarget as HTMLSelectElement).value as ContentBodyFormat)}
      >
        <option value="html">HTML</option>
        <option value="markdown">Markdown</option>
      </Select>
    </label>
  </div>

  {#if selectedImageBox}
    <div
      class="image-control-popover"
      style={`top: ${Math.max(44, selectedImageBox.top + 8)}px; left: ${selectedImageBox.left + selectedImageBox.width / 2}px;`}
      aria-label={t(M['content.content_body_editor.selected_image_controls'])}
    >
      <Button variant="ghost" size="sm" class="editor-popover-button" type="button" title={t(M['content.content_body_editor.move_image'])} aria-label={t(M['content.content_body_editor.move_image'])} onpointerdown={startImageMove}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M12 2v20"></path>
          <path d="M2 12h20"></path>
          <path d="m5 9-3 3 3 3"></path>
          <path d="m19 9 3 3-3 3"></path>
          <path d="m9 5 3-3 3 3"></path>
          <path d="m9 19 3 3 3-3"></path>
        </svg>
      </Button>
      <span class="image-control-divider"></span>
      <Button
        variant="ghost"
        size="sm"
        class={`editor-popover-button${selectedImagePlacement === 'left' ? ' editor-popover-button--active' : ''}`}
        type="button"
        title={t(M['content.content_body_editor.wrap_text_on_right'])}
        aria-label={t(M['content.content_body_editor.wrap_text_on_right'])}
        aria-pressed={selectedImagePlacement === 'left'}
        onclick={() => applyImagePlacement('left')}
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <rect x="3" y="5" width="8" height="8" rx="1"></rect>
          <path d="M14 6h7"></path>
          <path d="M14 10h7"></path>
          <path d="M3 17h18"></path>
          <path d="M3 21h14"></path>
        </svg>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        class={`editor-popover-button${selectedImagePlacement === 'center' || selectedImagePlacement === 'block' ? ' editor-popover-button--active' : ''}`}
        type="button"
        title={t(M['content.content_body_editor.center_image'])}
        aria-label={t(M['content.content_body_editor.center_image'])}
        aria-pressed={selectedImagePlacement === 'center' || selectedImagePlacement === 'block'}
        onclick={() => applyImagePlacement('center')}
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M4 6h16"></path>
          <rect x="7" y="9" width="10" height="6" rx="1"></rect>
          <path d="M4 18h16"></path>
        </svg>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        class={`editor-popover-button${selectedImagePlacement === 'right' ? ' editor-popover-button--active' : ''}`}
        type="button"
        title={t(M['content.content_body_editor.wrap_text_on_left'])}
        aria-label={t(M['content.content_body_editor.wrap_text_on_left'])}
        aria-pressed={selectedImagePlacement === 'right'}
        onclick={() => applyImagePlacement('right')}
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <rect x="13" y="5" width="8" height="8" rx="1"></rect>
          <path d="M3 6h7"></path>
          <path d="M3 10h7"></path>
          <path d="M3 17h18"></path>
          <path d="M7 21h14"></path>
        </svg>
      </Button>
      <Button
        variant="ghost"
        size="sm"
        class={`editor-popover-button${selectedImagePlacement === 'full' ? ' editor-popover-button--active' : ''}`}
        type="button"
        title={t(M['content.content_body_editor.full_width'])}
        aria-label={t(M['content.content_body_editor.full_width'])}
        aria-pressed={selectedImagePlacement === 'full'}
        onclick={() => applyImagePlacement('full')}
      >
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 5h18"></path>
          <rect x="4" y="8" width="16" height="8" rx="1"></rect>
          <path d="M3 19h18"></path>
        </svg>
      </Button>
      <span class="image-control-divider"></span>
      <Button variant="ghost" size="sm" class="editor-popover-button" type="button" title={t(M['content.content_body_editor.make_smaller'])} aria-label={t(M['content.content_body_editor.make_image_smaller'])} onclick={() => resizeSelectedImage(-IMAGE_WIDTH_STEP)}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M5 12h14"></path>
          <path d="M9 8 5 12l4 4"></path>
          <path d="m15 8 4 4-4 4"></path>
        </svg>
      </Button>
      <Button variant="ghost" size="sm" class="editor-popover-button" type="button" title={t(M['content.content_body_editor.make_larger'])} aria-label={t(M['content.content_body_editor.make_image_larger'])} onclick={() => resizeSelectedImage(IMAGE_WIDTH_STEP)}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
          <path d="M3 12h18"></path>
          <path d="m7 8-4 4 4 4"></path>
          <path d="m17 8 4 4-4 4"></path>
        </svg>
      </Button>
      {#if selectedImageAssetId && onUseImageAsThumbnail}
        <Button variant="ghost" size="sm" class="editor-popover-button" type="button" title={t(M['content.content_body_editor.use_as_primary_image'])} aria-label={t(M['content.content_body_editor.use_as_primary_image'])} onclick={useSelectedImageAsThumbnail}>
          <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round">
            <path d="m12 3 2.8 5.7 6.2.9-4.5 4.4 1.1 6.2L12 17.3 6.4 20.2 7.5 14 3 9.6l6.2-.9L12 3Z"></path>
          </svg>
        </Button>
      {/if}
      <Button variant="ghost" size="sm" class="editor-popover-button" type="button" title={t(M['content.content_body_editor.remove_image'])} aria-label={t(M['content.content_body_editor.remove_image'])} onclick={removeSelectedImage}>
        <svg viewBox="0 0 24 24" width="15" height="15" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M3 6h18"></path>
          <path d="M8 6V4h8v2"></path>
          <path d="M19 6l-1 14H6L5 6"></path>
        </svg>
      </Button>
    </div>

    <!-- raw-primitive-allow: custom press-and-drag image resize handle driven by onpointerdown pointer-capture gesture and absolute positioning; no Button primitive owns this draggable resize grabber -->
    <button
      type="button"
      class="image-resize-handle"
      title={t(M['content.content_body_editor.resize_image'])}
      aria-label={t(M['content.content_body_editor.resize_selected_image'])}
      style={`top: ${selectedImageBox.top + selectedImageBox.height - 12}px; left: ${selectedImageBox.left + selectedImageBox.width - 12}px;`}
      onpointerdown={startImageResize}
    >
      <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round">
        <path d="M8 20h12V8"></path>
        <path d="M12 20l8-8"></path>
      </svg>
    </button>
  {/if}

  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div
    bind:this={editorElement}
    id="content-body-input"
    class="body-editor-surface"
    class:body-editor-surface--dragging={isDragging}
    contenteditable="true"
    role="textbox"
    aria-multiline="true"
    tabindex="0"
    data-placeholder={placeholder}
    oninput={scheduleInputChange}
    onblur={() => {
      isFocused = false;
      saveSelection();
      emitChange({ syncDom: true });
    }}
    onfocus={() => {
      isFocused = true;
      saveSelection();
    }}
    onclick={handleSurfaceClick}
    onkeyup={saveSelection}
    ondragover={handleDragOver}
    ondragleave={handleDragLeave}
    ondragstart={handleEditorDragStart}
    ondragend={handleEditorDragEnd}
    ondrop={(event) => void handleDrop(event)}
  >
    {@html editorHtml}
  </div>
</div>

<style>
  .content-body-editor {
    position: relative;
    display: flex;
    flex-direction: column;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.85rem;
    background: var(--smrt-color-surface);
    overflow: visible;
  }

  .body-editor-toolbar {
    display: flex;
    align-items: center;
    gap: 0.35rem;
    padding: 0.45rem 0.55rem;
    border-bottom: 1px solid var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface-container-low, var(--smrt-color-surface-container));
  }

  .body-editor-toolbar :global(.editor-toolbar-button) {
    width: 2rem;
    height: 2rem;
    display: inline-grid;
    place-items: center;
    border: 1px solid transparent;
    border-radius: 0.45rem;
    background: transparent;
    color: var(--smrt-color-on-surface);
    cursor: pointer;
  }

  .body-editor-toolbar :global(.editor-toolbar-button:hover) {
    border-color: var(--smrt-color-outline-variant);
    background: var(--smrt-color-surface-container);
  }

  .format-select {
    margin-left: auto;
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    font-size: var(--smrt-typography-label-medium-size, 0.78rem);
    color: var(--smrt-color-on-surface-variant);
  }

  .format-select :global(.select) {
    min-height: 2rem;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: 0.45rem;
    background: var(--smrt-color-surface);
    color: var(--smrt-color-on-surface);
    padding: 0 0.5rem;
  }

  .body-editor-surface {
    min-height: 22rem;
    padding: clamp(1rem, 2vw, 1.5rem);
    outline: none;
    color: var(--smrt-color-on-surface);
    font-size: var(--smrt-typography-body-large-size, 1.05rem);
    line-height: var(--smrt-typography-body-large-line-height, 1.65);
    overflow: auto;
    overflow-wrap: anywhere;
  }

  .body-editor-surface::after {
    content: '';
    display: block;
    clear: both;
  }

  .body-editor-surface:empty::before {
    content: attr(data-placeholder);
    color: var(--smrt-color-on-surface-variant);
    pointer-events: none;
  }

  .body-editor-surface--dragging {
    box-shadow: inset 0 0 0 2px var(--smrt-color-primary);
    background: color-mix(in srgb, var(--smrt-color-primary) 6%, var(--smrt-color-surface));
  }

  .body-editor-surface :global(p:first-child),
  .body-editor-surface :global(h1:first-child),
  .body-editor-surface :global(h2:first-child),
  .body-editor-surface :global(h3:first-child) {
    margin-top: 0;
  }

  .body-editor-surface :global(p:last-child) {
    margin-bottom: 0;
  }

  .body-editor-surface :global(p) {
    min-height: 1.65em;
  }

  .body-editor-surface :global(h1),
  .body-editor-surface :global(h2),
  .body-editor-surface :global(h3) {
    line-height: 1.2;
    margin: 1.25em 0 0.5em;
  }

  .body-editor-surface :global(figure[data-smrt-inline-image]) {
    display: block;
    width: min(100%, 32rem);
    max-width: 100%;
    margin: 1.25rem 0;
    clear: none;
  }

  .body-editor-surface :global(figure[data-smrt-inline-image] img) {
    display: block;
    width: 100%;
    max-width: 100%;
  }

  .body-editor-surface :global(figure[data-smrt-placement='left']),
  .body-editor-surface :global(img[data-smrt-placement='left']) {
    float: left;
    width: min(45%, 22rem);
    margin: 0.4rem 1.25rem 0.75rem 0;
  }

  .body-editor-surface :global(figure[data-smrt-placement='right']),
  .body-editor-surface :global(img[data-smrt-placement='right']) {
    float: right;
    width: min(45%, 22rem);
    margin: 0.4rem 0 0.75rem 1.25rem;
  }

  .body-editor-surface :global(figure[data-smrt-placement='center']),
  .body-editor-surface :global(figure[data-smrt-placement='block']),
  .body-editor-surface :global(img[data-smrt-placement='center']),
  .body-editor-surface :global(img[data-smrt-placement='block']) {
    float: none;
    display: block;
    clear: both;
    margin-left: auto;
    margin-right: auto;
  }

  .body-editor-surface :global(figure[data-smrt-placement='full']),
  .body-editor-surface :global(img[data-smrt-placement='full']) {
    float: none;
    width: 100% !important;
    max-width: 100%;
    margin-left: 0;
    margin-right: 0;
    clear: both;
  }

  .body-editor-surface :global(img) {
    display: block;
    max-width: min(100%, 44rem);
    height: auto;
    border-radius: 0.55rem;
  }

  .body-editor-surface :global(img[data-smrt-inline-image]) {
    width: min(100%, 32rem);
    max-width: 100%;
    margin-top: 1.25rem;
    margin-bottom: 1.25rem;
    clear: both;
  }

  .body-editor-surface :global(img[data-smrt-inline-image][data-smrt-placement='left']),
  .body-editor-surface :global(img[data-smrt-inline-image][data-smrt-placement='right']) {
    width: min(45%, 22rem);
    clear: none;
  }

  .body-editor-surface :global(figure[data-smrt-inline-image] img) {
    width: 100%;
    max-width: 100%;
    margin: 0;
  }

  .body-editor-surface :global(img[data-smrt-placement='full']) {
    width: 100%;
    max-width: 100%;
  }

  .body-editor-surface :global(img[data-smrt-selected='true']) {
    outline: 3px solid var(--smrt-color-primary);
    outline-offset: 3px;
  }

  .body-editor-surface :global([data-smrt-moving='true']),
  .body-editor-surface :global([data-smrt-resizing='true']) {
    opacity: 0.78;
  }

  .image-control-popover {
    position: absolute;
    z-index: 20;
    display: inline-flex;
    align-items: center;
    gap: 0.1rem;
    padding: 0.25rem;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-full, 9999px);
    background: color-mix(in srgb, var(--smrt-color-surface) 96%, transparent);
    color: var(--smrt-color-on-surface);
    box-shadow: var(--smrt-elevation-5, 0 0.75rem 1.75rem color-mix(in srgb, var(--smrt-color-shadow) 18%, transparent));
    transform: translateX(-50%);
    backdrop-filter: blur(10px);
  }

  .image-control-popover :global(.editor-popover-button),
  .image-resize-handle {
    display: inline-grid;
    place-items: center;
    border: 0;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }

  .image-control-popover :global(.editor-popover-button) {
    width: 1.85rem;
    height: 1.85rem;
    border-radius: var(--smrt-radius-full, 9999px);
  }

  .image-control-popover :global(.editor-popover-button:hover),
  .image-control-popover :global(.editor-popover-button.editor-popover-button--active) {
    background: var(--smrt-color-surface-container);
    color: var(--smrt-color-primary);
  }

  .image-control-divider {
    width: 1px;
    height: 1.15rem;
    margin: 0 0.15rem;
    background: var(--smrt-color-outline-variant);
  }

  .image-resize-handle {
    position: absolute;
    z-index: 21;
    width: 1.45rem;
    height: 1.45rem;
    border: 1px solid var(--smrt-color-outline-variant);
    border-radius: var(--smrt-radius-full, 9999px);
    background: var(--smrt-color-surface);
    box-shadow: var(--smrt-elevation-4, 0 0.45rem 1rem color-mix(in srgb, var(--smrt-color-shadow) 18%, transparent));
    cursor: nwse-resize;
  }

  .image-resize-handle:hover {
    color: var(--smrt-color-primary);
  }
</style>
