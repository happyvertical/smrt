<script lang="ts" module>
/** One picture the drawer offers (from the host's picture library). */
export interface ContentPicture {
  /** Stable id; passed back to the host on insert/drag/main. */
  id: string;
  /** Plain name shown under the picture and used by search. */
  title: string;
  /**
   * Same-origin preview URL for the `<img>`. Never a signed/tokened
   * provider URL: the host serves previews through its own route.
   */
  previewUrl: string | null;
  width?: number | null;
  height?: number | null;
  /** Extra words search matches (alt text, tags). */
  keywords?: string;
}

/** The MIME type a dragged picture (or a JSON array of them) travels as. */
export const CONTENT_PICTURE_DRAG_TYPE = 'application/x-smrt-image';

/** The drag payload ContentBodyEditor turns into inserted pictures. */
export function pictureDragPayload(pictures: ContentPicture[]): string {
  return JSON.stringify(
    pictures.map((picture) => ({
      id: picture.id,
      name: picture.title,
      sourceUri: picture.previewUrl,
      width: picture.width ?? null,
      height: picture.height ?? null,
    })),
  );
}

/** Pictures whose title or keywords contain every word of `query`. */
export function filterPictures(
  pictures: ContentPicture[],
  query: string,
): ContentPicture[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return pictures;
  return pictures.filter((picture) => {
    const haystack = `${picture.title} ${picture.keywords ?? ''}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
</script>

<script lang="ts">
/**
 * ContentPictureDrawer — the one "Add pictures" drawer for a content editor.
 *
 * Shows the host's picture library as a plain grid with one search box and an
 * upload button. A picture is dragged into the story (drop position), or
 * tapped to pick it (several at once) and inserted at the cursor with Insert —
 * the keyboard and phone path. It also shows and changes the main picture:
 * the first picture in the story, unless the person chose one.
 *
 * It holds no data of its own: the host loads pictures, uploads files, and
 * resolves an inserted picture into its stored asset.
 */
import { Input } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { ContentMainPictureMode } from '../../body-format';
import { M } from '../i18n.editor.js';

const { t } = useI18n();

export interface Props {
  /** The library's pictures (loaded by the host). */
  pictures?: ContentPicture[];
  /** Pictures are loading. */
  loading?: boolean;
  /** A plain-language load or upload problem, or null. */
  error?: string | null;
  /**
   * More pictures can be loaded with `onLoadMore`: the drawer asks for them
   * as the list scrolls near its end, or as keyboard focus nears the end.
   */
  hasMore?: boolean;
  /** An upload is in progress. */
  uploading?: boolean;
  /** Asset ids of pictures already in the story. */
  inStoryIds?: string[];
  /** Id of the current main picture. */
  mainPictureId?: string | null;
  /** How the main picture was decided (see `resolveBodyMainPicture`). */
  mainPictureMode?: ContentMainPictureMode;
  /** The search text (when the host searches; see `onSearch`). */
  query?: string;
  /**
   * The host searches its library for this text (it should wait for typing
   * to pause and start its paging again). Without it the drawer filters the
   * pictures it was given.
   */
  onSearch?: (query: string) => void;
  /** Insert these pictures at the cursor, in order. */
  onInsert?: (pictures: ContentPicture[]) => void;
  /** Upload these files (then insert them). */
  onUpload?: (files: File[]) => void;
  onLoadMore?: () => void;
  /** Make this picture the main picture. */
  onUseAsMain?: (picture: ContentPicture) => void;
  /** Clear the choice: the first picture in the story is the main picture. */
  onClearMainChoice?: () => void;
  onClose?: () => void;
}

let {
  pictures = [],
  loading = false,
  error = null,
  hasMore = false,
  uploading = false,
  inStoryIds = [],
  mainPictureId = null,
  mainPictureMode = 'none',
  query: hostQuery = '',
  onSearch,
  onInsert,
  onUpload,
  onLoadMore,
  onUseAsMain,
  onClearMainChoice,
  onClose,
}: Props = $props();

// svelte-ignore state_referenced_locally
let query = $state(hostQuery);
let selectedIds = $state<string[]>([]);
let fileInput = $state<HTMLInputElement | null>(null);
let brokenPreviews = $state<Record<string, true>>({});
let gridElement = $state<HTMLElement | null>(null);
let moreSentinel = $state<HTMLElement | null>(null);
/** Screen-reader news about loading more ("12 more pictures"). */
let moreStatus = $state('');
let countBeforeMore: number | null = null;
let moreRequestedAt = 0;
/** A host that never answered a request may be asked again after this long. */
const MORE_RETRY_MS = 1500;

/** How close to the end (in tiles) keyboard focus asks for more. */
const MORE_FOCUS_TILES = 6;
/** How far below the visible list (px) scrolling asks for more. */
const MORE_SCROLL_MARGIN = 240;

function requestMore() {
  // One request at a time: wait for the host to answer (a new page, or
  // its loading flag going back off) before asking again.
  if (!hasMore || loading || !onLoadMore) return;
  if (countBeforeMore !== null && Date.now() - moreRequestedAt < MORE_RETRY_MS) {
    return;
  }
  countBeforeMore = pictures.length;
  moreRequestedAt = Date.now();
  moreStatus = t(M['content.content_picture_drawer.loading_more']);
  onLoadMore();
}

function sentinelNearView(): boolean {
  if (!gridElement || !moreSentinel) return false;
  const grid = gridElement.getBoundingClientRect();
  const sentinel = moreSentinel.getBoundingClientRect();
  return sentinel.top <= grid.bottom + MORE_SCROLL_MARGIN;
}

// Scrolling near the end of the list loads more.
$effect(() => {
  const root = gridElement;
  const target = moreSentinel;
  if (!root || !target || typeof IntersectionObserver === 'undefined') return;
  const observer = new IntersectionObserver(
    (entries) => {
      if (entries.some((entry) => entry.isIntersecting)) requestMore();
    },
    { root, rootMargin: `0px 0px ${MORE_SCROLL_MARGIN}px 0px` },
  );
  observer.observe(target);
  return () => observer.disconnect();
});

// After a page arrives: say how many came, and keep going while the list
// is still too short to scroll (the observer only fires on a change).
let wasLoading = false;
$effect(() => {
  const count = pictures.length;
  if (loading) {
    wasLoading = true;
    return;
  }
  const answered = wasLoading || count !== countBeforeMore;
  wasLoading = false;
  if (countBeforeMore !== null && answered) {
    const added = count - countBeforeMore;
    countBeforeMore = null;
    moreStatus =
      added > 0
        ? t(M['content.content_picture_drawer.more_loaded'], { count: added })
        : '';
  }
  if (hasMore && sentinelNearView()) queueMicrotask(requestMore);
});

// Keyboard and screen-reader users: focus near the end loads more.
function handleGridFocus(event: FocusEvent) {
  const tile = (event.target as Element | null)?.closest('.drawer-picture');
  if (!tile || !gridElement) return;
  const tiles = Array.from(gridElement.querySelectorAll('.drawer-picture'));
  if (tiles.indexOf(tile) >= tiles.length - MORE_FOCUS_TILES) requestMore();
}

// A searching host already sent only the matches.
const visible = $derived(onSearch ? pictures : filterPictures(pictures, query));
const inStory = $derived(new Set(inStoryIds));
const selected = $derived(
  selectedIds
    .map((id) => pictures.find((picture) => picture.id === id))
    .filter((picture): picture is ContentPicture => Boolean(picture)),
);

function toggle(picture: ContentPicture) {
  selectedIds = selectedIds.includes(picture.id)
    ? selectedIds.filter((id) => id !== picture.id)
    : [...selectedIds, picture.id];
}

function insertSelected() {
  if (selected.length === 0) return;
  onInsert?.(selected);
  selectedIds = [];
}

function useSelectedAsMain() {
  const [picture] = selected;
  if (!picture) return;
  onUseAsMain?.(picture);
  selectedIds = [];
}

function handleDragStart(event: DragEvent, picture: ContentPicture) {
  if (!event.dataTransfer) return;
  // Dragging a picked picture drags every picked one, in pick order.
  const dragged = selectedIds.includes(picture.id) ? selected : [picture];
  event.dataTransfer.effectAllowed = 'copy';
  event.dataTransfer.setData(
    CONTENT_PICTURE_DRAG_TYPE,
    pictureDragPayload(dragged),
  );
}

function handleFiles(event: Event & { currentTarget: HTMLInputElement }) {
  const files = Array.from(event.currentTarget.files ?? []).filter((file) =>
    file.type.startsWith('image/'),
  );
  event.currentTarget.value = '';
  if (files.length > 0) onUpload?.(files);
}
</script>

<div class="content-picture-drawer">
  <header class="drawer-header">
    <h2>{t(M['content.content_picture_drawer.title'])}</h2>
    {#if onClose}
      <Button type="button" variant="secondary" size="sm" class="drawer-done" onclick={onClose}>
        {t(M['content.content_picture_drawer.close'])}
      </Button>
    {/if}
  </header>

  <p class="drawer-hint">{t(M['content.content_picture_drawer.hint'])}</p>

  {#if mainPictureMode === 'chosen'}
    <p class="drawer-main">
      <span>{t(M['content.content_picture_drawer.main_chosen'])}</span>
      {#if onClearMainChoice}
        <Button type="button" variant="ghost" size="sm" onclick={onClearMainChoice}>
          {t(M['content.content_picture_drawer.main_reset'])}
        </Button>
      {/if}
    </p>
  {:else if mainPictureMode === 'automatic'}
    <p class="drawer-main">{t(M['content.content_picture_drawer.main_automatic'])}</p>
  {/if}

  <div class="drawer-tools">
    <Input
      type="search"
      bind:value={query}
      oninput={() => onSearch?.(query)}
      placeholder={t(M['content.content_picture_drawer.search'])}
      aria-label={t(M['content.content_picture_drawer.search'])}
    />
    {#if onUpload}
      <Button
        type="button"
        variant="secondary"
        disabled={uploading}
        onclick={() => fileInput?.click()}
      >
        {uploading
          ? t(M['content.content_picture_drawer.uploading'])
          : t(M['content.content_picture_drawer.upload'])}
      </Button>
      <!-- raw-primitive-allow: hidden file input opened by the Upload button (needs the DOM element for .click()) -->
      <input
        bind:this={fileInput}
        class="drawer-file-input"
        type="file"
        accept="image/*"
        multiple
        tabindex="-1"
        aria-hidden="true"
        onchange={handleFiles}
      />
    {/if}
  </div>

  {#if error}
    <p class="drawer-error" role="alert">{error}</p>
  {/if}

  {#if visible.length > 0}
    <ul class="drawer-grid" bind:this={gridElement} onfocusin={handleGridFocus}>
      {#each visible as picture (picture.id)}
        {@const isSelected = selectedIds.includes(picture.id)}
        {@const isMain = mainPictureId === picture.id}
        <li
          class="drawer-picture"
          class:selected={isSelected}
          class:main={isMain}
          draggable="true"
          ondragstart={(event) => handleDragStart(event, picture)}
        >
          <!-- raw-primitive-allow: a large picture tile that toggles selection (aria-pressed) and wraps an image; Button would impose its own padding and label layout -->
          <button
            type="button"
            class="drawer-picture-pick"
            aria-pressed={isSelected}
            aria-label={t(M['content.content_picture_drawer.select'], { name: picture.title })}
            onclick={() => toggle(picture)}
          >
            {#if picture.previewUrl && !brokenPreviews[picture.id]}
              <img
                src={picture.previewUrl}
                alt=""
                loading="lazy"
                decoding="async"
                draggable="false"
                onerror={() => (brokenPreviews = { ...brokenPreviews, [picture.id]: true })}
              />
            {:else}
              <span class="drawer-picture-missing">
                {t(M['content.content_picture_drawer.no_preview'])}
              </span>
            {/if}
            {#if isSelected}
              <span class="drawer-picture-check" aria-hidden="true">
                {selectedIds.indexOf(picture.id) + 1}
              </span>
            {/if}
          </button>
          <span class="drawer-picture-title">{picture.title}</span>
          <span class="drawer-picture-tags">
            {#if isMain}
              <span class="tag tag-main">{t(M['content.content_picture_drawer.main'])}</span>
            {:else if inStory.has(picture.id)}
              <span class="tag">{t(M['content.content_picture_drawer.in_story'])}</span>
            {/if}
          </span>
        </li>
      {/each}
      {#if hasMore && onLoadMore}
        <li class="drawer-more" aria-hidden="true" bind:this={moreSentinel}>
          {#if loading}{t(M['content.content_picture_drawer.loading_more'])}{/if}
        </li>
      {/if}
    </ul>
  {:else if loading}
    <p class="drawer-hint">{t(M['content.content_picture_drawer.loading'])}</p>
  {:else if pictures.length > 0 || (onSearch && query.trim())}
    <p class="drawer-hint">{t(M['content.content_picture_drawer.no_match'])}</p>
  {:else}
    <p class="drawer-hint">{t(M['content.content_picture_drawer.empty'])}</p>
  {/if}

  <p class="drawer-status" role="status" aria-live="polite">{moreStatus}</p>

  {#if selected.length > 0 && (onInsert || onUseAsMain)}
    <div class="drawer-actions">
      {#if onInsert}
        <Button type="button" variant="primary" onclick={insertSelected}>
          {selected.length === 1
            ? t(M['content.content_picture_drawer.insert'])
            : t(M['content.content_picture_drawer.insert_count'], { count: selected.length })}
        </Button>
      {/if}
      {#if selected.length === 1 && onUseAsMain && selected[0].id !== mainPictureId}
        <Button type="button" variant="secondary" onclick={useSelectedAsMain}>
          {t(M['content.content_picture_drawer.use_as_main'])}
        </Button>
      {/if}
      <Button type="button" variant="ghost" onclick={() => (selectedIds = [])}>
        {t(M['content.content_picture_drawer.clear_selection'])}
      </Button>
    </div>
  {/if}
</div>

<style>
  .content-picture-drawer {
    display: grid;
    gap: 0.75rem;
  }

  .drawer-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .drawer-header h2 {
    margin: 0;
    font-size: 1rem;
    color: var(--smrt-color-on-surface);
  }

  .content-picture-drawer :global(.drawer-done) {
    min-height: 2.75rem;
  }

  .drawer-hint,
  .drawer-main {
    margin: 0;
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.85rem;
  }

  .drawer-main {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .drawer-tools {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .drawer-tools :global(input) {
    flex: 1 1 12rem;
    min-height: 2.75rem;
  }

  .drawer-file-input {
    display: none;
  }

  .drawer-error {
    margin: 0;
    color: var(--smrt-color-error);
    font-size: 0.85rem;
  }

  .drawer-grid {
    /* Scrolls on its own so the story stays in reach for dragging. */
    max-height: min(22rem, 45vh);
    overflow-y: auto;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(7rem, 1fr));
    gap: 0.6rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .drawer-more {
    grid-column: 1 / -1;
    min-height: 1.5rem;
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.8rem;
    text-align: center;
  }

  .drawer-status {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip: rect(0 0 0 0);
    white-space: nowrap;
  }

  .drawer-picture {
    display: grid;
    gap: 0.25rem;
    align-content: start;
    min-width: 0;
    cursor: grab;
  }

  .drawer-picture-pick {
    position: relative;
    display: grid;
    place-items: center;
    aspect-ratio: 4 / 3;
    width: 100%;
    padding: 0;
    overflow: hidden;
    border: 2px solid var(--smrt-color-outline-variant);
    border-radius: 0.5rem;
    background: var(--smrt-color-surface-container-low);
    color: var(--smrt-color-on-surface-variant);
    cursor: pointer;
  }

  .drawer-picture.selected .drawer-picture-pick {
    border-color: var(--smrt-color-primary);
  }

  .drawer-picture.main .drawer-picture-pick {
    box-shadow: 0 0 0 2px color-mix(in srgb, var(--smrt-color-primary) 30%, transparent);
  }

  .drawer-picture-pick img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    pointer-events: none;
  }

  .drawer-picture-check {
    position: absolute;
    top: 0.35rem;
    right: 0.35rem;
    display: grid;
    place-items: center;
    min-width: 1.5rem;
    height: 1.5rem;
    border-radius: 999px;
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
    font-size: 0.8rem;
    font-weight: 700;
  }

  .drawer-picture-missing {
    padding: 0.25rem;
    font-size: 0.75rem;
    text-align: center;
  }

  .drawer-picture-title {
    overflow: hidden;
    color: var(--smrt-color-on-surface);
    font-size: 0.8rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .drawer-picture-tags {
    min-height: 0;
  }

  .tag {
    display: inline-block;
    padding: 0.05rem 0.4rem;
    border-radius: 999px;
    background: var(--smrt-color-surface-container-high);
    color: var(--smrt-color-on-surface-variant);
    font-size: 0.72rem;
  }

  .tag-main {
    background: var(--smrt-color-primary);
    color: var(--smrt-color-on-primary);
  }

  .drawer-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    padding: 0.5rem 0;
    background: var(--smrt-color-surface);
  }

  .drawer-actions :global(button) {
    min-height: 2.75rem;
  }
</style>
