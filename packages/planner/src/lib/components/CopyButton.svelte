<script lang="ts">
import type { ButtonVariant } from '@happyvertical/smrt-ui';
import { Button } from '@happyvertical/smrt-ui';

/**
 * A button that puts `text` on the clipboard and says "Copied" for a moment.
 * When the clipboard is not available (no secure context, permission denied,
 * an old browser) it calls `onfail` so the owner can select the text and
 * tell the person to copy it by hand; the status line belongs to the owner.
 */
interface Props {
  /** What to copy; a function is read at click time. */
  text: string | (() => string);
  label: string;
  copiedLabel?: string;
  variant?: ButtonVariant;
  /** How long the button says it copied, in milliseconds. */
  confirmFor?: number;
  oncopied?: () => void;
  onfail?: () => void;
  /** Replaces `navigator.clipboard.writeText` (tests). */
  write?: (text: string) => Promise<void>;
  'aria-describedby'?: string;
}

let {
  text,
  label,
  copiedLabel = 'Copied',
  variant = 'primary',
  confirmFor = 2000,
  oncopied,
  onfail,
  write,
  'aria-describedby': describedBy,
}: Props = $props();

let copied = $state(false);
let timer: ReturnType<typeof setTimeout> | undefined;

async function copy() {
  const value = typeof text === 'function' ? text() : text;
  const writer =
    write ??
    (typeof navigator !== 'undefined' && navigator.clipboard
      ? (t: string) => navigator.clipboard.writeText(t)
      : undefined);
  try {
    if (!writer) throw new Error('no clipboard');
    await writer(value);
  } catch {
    copied = false;
    onfail?.();
    return;
  }
  copied = true;
  oncopied?.();
  clearTimeout(timer);
  timer = setTimeout(() => (copied = false), confirmFor);
}
</script>

<Button {variant} onclick={copy} aria-live="polite" aria-describedby={describedBy}>
  {copied ? copiedLabel : label}
</Button>
