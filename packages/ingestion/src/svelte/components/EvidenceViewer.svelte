<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { EvidenceView } from '../../review-dto.js';
import { M } from '../i18n.js';
import { evidenceUrl } from '../view-utils.js';
export interface Props {
  evidence: EvidenceView[];
  /**
   * Highest observed page per evidence id. A PDF with more than one observed
   * page gets inline page navigation (the same-origin URL plus `#page=n`).
   */
  pages?: Record<string, number>;
  /** `stack` lists every part; `pager` shows one part at a time with navigation. */
  layout?: 'stack' | 'pager';
  /** Bindable: the part the pager shows, by evidence id. */
  chosen?: string;
  /** Bindable: page per evidence id; absent until the reviewer navigates. */
  page?: Record<string, number>;
}
let {
  evidence,
  pages = {},
  layout = 'stack',
  // Bindable so a parent can keep them while this viewer remounts on reload.
  chosen = $bindable(),
  page = $bindable({}),
}: Props = $props();
const { t } = useI18n();
const inline = (view: EvidenceView) =>
  view.evidence.mediaType.startsWith('image/') ||
  view.evidence.mediaType === 'application/pdf' ||
  view.evidence.mediaType.startsWith('audio/');
// The pager opens on the first part that renders inline (the uploaded file,
// not its capture record); the reviewer can step to every other part.
const shown = $derived.by(() => {
  if (layout !== 'pager') return evidence;
  const current =
    evidence.find((view) => view.evidence.id === chosen) ??
    evidence.find((view) => inline(view) && evidenceUrl(view.viewUrl)) ??
    evidence[0];
  return current ? [current] : [];
});
const position = $derived(shown.length === 1 ? evidence.indexOf(shown[0]) : -1);
function step(offset: number) {
  const next = evidence[position + offset];
  if (next) chosen = next.evidence.id;
}
function pageUrl(url: string, id: string) {
  const current = page[id];
  return current === undefined ? url : `${url.split('#')[0]}#page=${current}`;
}
function turn(id: string, offset: number) {
  const count = pages[id] ?? 1;
  page = {
    ...page,
    [id]: Math.min(count, Math.max(1, (page[id] ?? 1) + offset)),
  };
}
</script>
<section data-testid="evidence-viewer" aria-label={t(M['ingestion.evidence'])} data-smrt-component="EvidenceViewer">
<h2>{t(M['ingestion.evidence'])}</h2>
{#if layout === 'pager' && evidence.length > 1 && position >= 0}
<div class="pager" data-testid="evidence-pager"><Button disabled={position <= 0} onclick={() => step(-1)}>{t(M['ingestion.previousOriginal'])}</Button><p role="status">{t(M['ingestion.originalOf'], { index: position + 1, count: evidence.length })}</p><Button disabled={position >= evidence.length - 1} onclick={() => step(1)}>{t(M['ingestion.nextOriginal'])}</Button></div>
{/if}
{#each shown as view (view.evidence.id)}
{@const url = evidenceUrl(view.viewUrl)}
{@const count = pages[view.evidence.id] ?? 0}
<article id={`evidence-${view.evidence.id}`}>
<h3>{view.label}</h3>
{#if url}
{#if view.evidence.mediaType.startsWith('image/')}<img src={url} alt={view.label} />
{:else if view.evidence.mediaType === 'application/pdf'}
{@const src = pageUrl(url, view.evidence.id)}
{#if count > 1}{@const current = page[view.evidence.id] ?? 1}<div class="pager" data-testid="page-pager"><Button disabled={current <= 1} onclick={() => turn(view.evidence.id, -1)}>{t(M['ingestion.previousPage'])}</Button><p role="status">{t(M['ingestion.pageOf'], { page: current, count })}</p><Button disabled={current >= count} onclick={() => turn(view.evidence.id, 1)}>{t(M['ingestion.nextPage'])}</Button></div>{/if}
<!-- A fragment-only change does not reliably move an embedded PDF viewer; a new frame does. -->
{#key src}<iframe {src} title={view.label}></iframe>{/key}
{:else if view.evidence.mediaType.startsWith('audio/')}<audio controls src={url} aria-label={view.label}></audio>{/if}
<Button href={url} target="_blank" rel="noopener noreferrer">{t(M['ingestion.original'])}</Button>
{:else}<p>{t(M['ingestion.noOriginal'])}</p>{/if}
{#if view.text !== undefined}<pre>{view.text}</pre>{/if}
</article>
{/each}
</section>
<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.theme {
section,article{min-width:0}article{margin-block:1rem}img,iframe,audio{display:block;max-width:100%;width:100%;margin-block:.5rem}img{object-fit:contain;max-height:32rem}iframe{height:32rem;border:var(--smrt-hairline)}pre{white-space:pre-wrap;overflow-wrap:anywhere}.pager{display:flex;flex-wrap:wrap;align-items:center;gap:.5rem}.pager p{margin:0}
}
</style>
