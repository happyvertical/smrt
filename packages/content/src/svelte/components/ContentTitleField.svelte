<script lang="ts">
/**
 * ContentTitleField - a content item's title as a headline-style text field.
 *
 * The title wraps like a heading (a one-row textarea that grows with its
 * text) but stays one line of text: Enter never adds a newline, and pasted
 * line breaks become spaces. It is a labelled control (`label`, default
 * "Title"), so it can sit inside the page's `<h1>` (smrt-ui PageHeader's
 * `titleField`): the heading is then named by the title and the field keeps
 * its own label. Inside a heading it takes the heading's type.
 *
 * Give it a `name` (or `id`) so a surrounding agent-operable form registers
 * it like any smrt-ui control. Validation messages belong outside a heading:
 * render the message beside it and point `describedBy` at it.
 */
import { Textarea } from '@happyvertical/smrt-ui/forms';

export interface Props {
  /** Current title text value. */
  value?: string;
  /** Placeholder text shown when the field is empty. */
  placeholder?: string;
  /** Whether the title field must be filled before submission. */
  required?: boolean;
  /** Accessible name of the field. */
  label?: string;
  /** Form field name; also its identity for agent-operable forms. */
  name?: string;
  /** Element id. */
  id?: string;
  /** Marks the field invalid (e.g. an empty required title). */
  invalid?: boolean;
  /** Id(s) of the element(s) describing the field, e.g. its error message. */
  describedBy?: string;
  /** Whether the field is disabled. */
  disabled?: boolean;
  /** Invoked when the user modifies the title text. */
  onChange?: (value: string) => void;
}

let {
  value = '',
  placeholder = 'Title',
  required = false,
  label = 'Title',
  name = undefined,
  id = undefined,
  invalid = false,
  describedBy = undefined,
  disabled = false,
  onChange = undefined,
}: Props = $props();

let field = $state<ReturnType<typeof Textarea> | null>(null);

function fitHeight() {
  const element = field?.getElement();
  if (!element) return;
  element.style.height = 'auto';
  element.style.height = `${element.scrollHeight}px`;
}

$effect(() => {
  void value;
  fitHeight();
});

function handleKeydown(event: KeyboardEvent) {
  // One line of text: Enter neither adds a newline nor submits.
  if (event.key === 'Enter' && !event.isComposing) event.preventDefault();
}

function handleInput(event: Event & { currentTarget: HTMLTextAreaElement }) {
  const element = event.currentTarget;
  const text = element.value.replace(/[\r\n]+/g, ' ');
  if (text !== element.value) {
    const caret = element.selectionStart;
    element.value = text;
    if (caret !== null) element.setSelectionRange(caret, caret);
  }
  fitHeight();
  onChange?.(text);
}
</script>

<svelte:window onresize={fitHeight} />

<span class="content-title-field-shell">
  <Textarea
    bind:this={field}
    class="content-title-field"
    rows={1}
    {id}
    {name}
    {placeholder}
    {required}
    {disabled}
    aria-label={label}
    aria-invalid={invalid ? 'true' : undefined}
    aria-describedby={describedBy}
    value={value || ''}
    onkeydown={handleKeydown}
    oninput={handleInput}
  />
</span>

<style>
  .content-title-field-shell {
    display: block;
  }

  .content-title-field-shell :global(.content-title-field) {
    display: block;
    width: 100%;
    min-height: 0;
    box-sizing: border-box;
    border: 0;
    border-radius: var(--smrt-radius-sm, 4px);
    background: transparent;
    color: var(--smrt-color-on-surface);
    font: inherit;
    font-size: clamp(1.45rem, 1.1rem + 1vw, 2rem);
    font-weight: var(--smrt-typography-weight-bold, 720);
    line-height: 1.12;
    letter-spacing: 0;
    padding: 0.1em 0.2em;
    margin-inline: -0.2em;
    resize: none;
    overflow: hidden;
    field-sizing: content;
    transition: background-color 150ms;
  }

  /* Inside a heading, look like that heading. */
  :global(:is(h1, h2, h3)) > .content-title-field-shell :global(.content-title-field) {
    font: inherit;
    letter-spacing: inherit;
  }

  .content-title-field-shell :global(.content-title-field)::placeholder {
    color: color-mix(in srgb, var(--smrt-color-on-surface-variant) 70%, transparent);
  }

  /* Editable on hover and focus: a quiet field background, then an outline. */
  .content-title-field-shell :global(.content-title-field):hover:not(:disabled) {
    background: var(--smrt-color-surface-container-low, rgb(0 0 0 / 4%));
  }

  .content-title-field-shell :global(.content-title-field):focus {
    outline: 2px solid var(--smrt-color-primary, #005ac1);
    outline-offset: 2px;
    background: var(--smrt-color-surface-container-low, rgb(0 0 0 / 4%));
  }

  .content-title-field-shell :global(.content-title-field[aria-invalid='true']) {
    outline: 2px solid var(--smrt-color-error, #b3261e);
    outline-offset: 2px;
  }
</style>
