<script lang="ts">
import type { Snippet } from 'svelte';
import { M } from '../../i18n/strings.ui.js';
import { useI18n } from '../../i18n/use-i18n.js';
import Container from './Container.svelte';

const { t } = useI18n();

export interface Props {
  /** Links or content displayed in the footer. */
  children?: Snippet;
}

const { children }: Props = $props();

const currentYear = new Date().getFullYear();
</script>

<footer class="smrt-footer__root" data-smrt-component="Footer">
  <Container>
    <div class="smrt-footer__content" data-smrt-part="content">
      <p class="smrt-footer__copyright" data-smrt-part="meta">&copy; {currentYear} {t(M['ui.footer.all_rights_reserved'])}</p>

      {#if children}
        <div class="smrt-footer__links" data-smrt-part="list">
          {@render children()}
        </div>
      {/if}
    </div>
  </Container>
</footer>

<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  .smrt-footer__root {
    padding: var(--smrt-spacing-8) 0;
    margin-top: var(--smrt-spacing-12);
  }
  .smrt-footer__content {
    display: flex;
    flex-direction: column;
    gap: var(--smrt-spacing-4);
    align-items: center;
  }
  .smrt-footer__copyright {
    margin: 0;
  }
  .smrt-footer__links :global(a) {
    margin: 0 var(--smrt-spacing-2);
  }
}

@layer smrt.theme {
  .smrt-footer__root {
    background: var(--smrt-color-surface-container-low);
    border-top: var(--smrt-hairline);
    text-align: center;
    color: var(--smrt-color-on-surface-variant);
  }
  .smrt-footer__copyright {
    font-size: var(--smrt-typography-body-medium-size);
  }
  .smrt-footer__links :global(a) {
    color: var(--smrt-color-primary);
    text-decoration: none;
  }
  .smrt-footer__links :global(a:hover) {
    text-decoration: underline;
  }
}

</style>
