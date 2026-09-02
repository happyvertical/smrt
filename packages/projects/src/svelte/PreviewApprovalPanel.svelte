<script lang="ts">
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import type { PreviewApprovalView } from './delivery-types.js';
import { M } from './i18n.js';

export interface Props {
  /** Preview item awaiting approval decision. */
  preview: PreviewApprovalView;
  /** Disables approval buttons during processing. */
  busy?: boolean;
  /** Invoked when the user approves or rejects the preview. */
  ondecide?: (approved: boolean) => void | Promise<void>;
}

let { preview, busy = false, ondecide }: Props = $props();
const { t } = useI18n();
</script>

<section class="preview">
  <div>
    <span>{t(M['projects.preview.label'], { id: preview.previewId })}</span>
    <strong>{preview.status}</strong>
  </div>
  {#if preview.previewUrl}
    <a href={preview.previewUrl} target="_blank" rel="noopener noreferrer">
      {t(M['projects.preview.open'])}
    </a>
  {/if}
  {#if preview.status === 'pending'}
    <footer>
      <Button
        variant="secondary"
        disabled={busy}
        onclick={() => ondecide?.(false)}
      >
        {t(M['projects.preview.reject'])}
      </Button>
      <Button disabled={busy} onclick={() => ondecide?.(true)}>
        {t(M['projects.preview.approve'])}
      </Button>
    </footer>
  {/if}
</section>

<style>
  .preview {
    border-block: 1px solid var(--smrt-color-outline-variant);
    display: grid;
    gap: var(--smrt-spacing-4);
    padding: var(--smrt-spacing-4) 0;
  }
  .preview > div {
    display: flex;
    justify-content: space-between;
  }
  .preview a {
    color: var(--smrt-color-primary);
    font-weight: 600;
  }
  .preview footer {
    display: flex;
    gap: var(--smrt-spacing-3);
    justify-content: flex-end;
  }
</style>
