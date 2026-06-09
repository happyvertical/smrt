<script lang="ts">
export interface Props {
  value?: string;
  placeholder?: string;
  required?: boolean;
  onChange?: (value: string) => void;
}

let {
  value = '',
  placeholder = 'Title',
  required = false,
  onChange = undefined,
}: Props = $props();
</script>

<input
  class="content-title-field"
  type="text"
  {placeholder}
  {required}
  value={value || ''}
  oninput={(event) => onChange?.(event.currentTarget.value)}
/>

<style>
  .content-title-field {
    width: 100%;
    box-sizing: border-box;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--smrt-color-on-surface);
    font: inherit;
    font-size: var(--smrt-typography-headline-small-size, clamp(1.45rem, 1.1rem + 1vw, 2rem));
    font-weight: var(--smrt-typography-weight-bold, 720);
    line-height: var(--smrt-typography-headline-small-line-height, 1.12);
    letter-spacing: 0;
    padding: 0;
  }

  .content-title-field::placeholder {
    color: color-mix(in srgb, var(--smrt-color-on-surface-variant) 70%, transparent);
  }

  .content-title-field:focus {
    outline: none;
  }

  .content-title-field:focus-visible {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: 0.35rem;
  }
</style>
