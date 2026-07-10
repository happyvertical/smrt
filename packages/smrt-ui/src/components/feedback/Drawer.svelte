<script lang="ts">
import type { Snippet } from 'svelte';
import Modal from './Modal.svelte';

export interface Props {
  open?: boolean;
  title?: string;
  side?: 'start' | 'end';
  size?: 'sm' | 'md' | 'lg' | 'xl';
  showClose?: boolean;
  closeOnBackdrop?: boolean;
  children?: Snippet;
  header?: Snippet;
  footer?: Snippet;
  onclose?: () => void;
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
