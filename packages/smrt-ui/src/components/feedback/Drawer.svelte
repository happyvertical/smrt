<script lang="ts">
import type { Snippet } from 'svelte';
import Modal from './Modal.svelte';

export interface Props {
  /** Whether the drawer is open (bindable). */
  open?: boolean;
  /** Title displayed in the drawer header. */
  title?: string;
  /** Side of screen where drawer slides from (start or end). */
  side?: 'start' | 'end';
  /** Drawer width size: sm, md, lg, or xl. */
  size?: 'sm' | 'md' | 'lg' | 'xl';
  /** Whether a close button appears in the header. */
  showClose?: boolean;
  /** Whether clicking the backdrop closes the drawer. */
  closeOnBackdrop?: boolean;
  /** Main content rendered inside the drawer body. */
  children?: Snippet;
  /** Optional custom snippet for the drawer header. */
  header?: Snippet;
  /** Optional custom snippet for the drawer footer. */
  footer?: Snippet;
  /** Callback when the drawer is closed. */
  onclose?: () => void;
  /** Accessibility label for the drawer dialog. */
  ariaLabel?: string;
}

let {
  open = $bindable(false),
  title,
  side = 'end',
  size = 'md',
  showClose = true,
  closeOnBackdrop = true,
  children,
  header,
  footer,
  onclose,
  ariaLabel,
}: Props = $props();
</script>

<Modal bind:open {title} {size} placement={side} {showClose} {closeOnBackdrop} onClose={onclose} {header} {footer} {children} {ariaLabel} />
