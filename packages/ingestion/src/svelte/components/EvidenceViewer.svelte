<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { EvidenceView } from '../../review-dto.js';
import { M } from '../i18n.js';
import { evidenceUrl } from '../view-utils.js';
export interface Props {
  evidence: EvidenceView[];
}
let { evidence }: Props = $props();
const { t } = useI18n();
</script>
<section data-testid="evidence-viewer" aria-label={t(M['ingestion.evidence'])}>
<h2>{t(M['ingestion.evidence'])}</h2>
{#each evidence as view (view.evidence.id)}
{@const url = evidenceUrl(view.viewUrl)}
<article id={`evidence-${view.evidence.id}`}>
<h3>{view.label}</h3>
{#if url}
{#if view.evidence.mediaType.startsWith('image/')}<img src={url} alt={view.label} />
{:else if view.evidence.mediaType === 'application/pdf'}<iframe src={url} title={view.label}></iframe>
{:else if view.evidence.mediaType.startsWith('audio/')}<audio controls src={url} aria-label={view.label}></audio>{/if}
<Button href={url} target="_blank" rel="noopener noreferrer">{t(M['ingestion.original'])}</Button>
{:else}<p>{t(M['ingestion.noOriginal'])}</p>{/if}
{#if view.text !== undefined}<pre>{view.text}</pre>{/if}
</article>
{/each}
</section>
<style>
section,article{min-width:0}article{margin-block:1rem}img,iframe,audio{display:block;max-width:100%;width:100%;margin-block:.5rem}img{object-fit:contain;max-height:32rem}iframe{height:32rem;border:1px solid var(--smrt-color-outline-variant,#ccc)}pre{white-space:pre-wrap;overflow-wrap:anywhere}
</style>
