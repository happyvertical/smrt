<script lang="ts">
/** The workspace name in a shell header: a plain link to its home page. */
interface Props {
  /** Workspace name. */
  title: string;
  /** Its home page. */
  href: string;
}

let { title, href }: Props = $props();
</script>

<a class="smrt-shell-title" {href} data-testid="shell-title">{title}</a>

<style>
  .smrt-shell-title {
    display: inline-flex;
    align-items: center;
    min-inline-size: 0;
    max-inline-size: 100%;
    min-block-size: 2.75rem;
    padding: 0 var(--smrt-spacing-2);
    overflow: hidden;
    border-radius: var(--smrt-radius-md);
    color: var(--smrt-color-on-surface);
    font: var(--smrt-typography-title-medium-font);
    text-decoration: none;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .smrt-shell-title:hover {
    background: var(--smrt-color-surface-container-high);
  }

  .smrt-shell-title:focus-visible {
    outline: 2px solid var(--smrt-color-primary);
    outline-offset: 2px;
  }
</style>
