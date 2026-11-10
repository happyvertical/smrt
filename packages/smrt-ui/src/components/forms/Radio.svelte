<script lang="ts">
import type { HTMLInputAttributes } from 'svelte/elements';
import { getRadioGroupContext } from './radio-group-context.js';
export interface Props
  extends Omit<HTMLInputAttributes, 'type' | 'name' | 'checked' | 'value'> {
  /** Value for this radio button option. */
  value: string;
  /** Text label displayed next to the radio button. */
  label: string;
  /** Whether the radio button is disabled. */
  disabled?: boolean;
}
let { value, label, disabled = false, id, onchange, ...rest }: Props = $props();
const instanceId = $props.id();
const group = getRadioGroupContext();
const resolvedId = $derived(id ?? `smrt-radio-${instanceId}`);
$effect(() => group.registerOption({ value, label, disabled }));
function handleChange(event: Event & { currentTarget: HTMLInputElement }) {
  if (event.currentTarget.checked) group.setValue(value);
  onchange?.(event);
}
</script>
<label class="smrt-radio__root" class:smrt-radio__disabled={disabled || group.disabled} data-smrt-hit-target data-smrt-component="Radio">
  <input id={resolvedId} type="radio" name={group.name} {value} disabled={disabled || group.disabled} required={group.required}
    checked={group.value === value} onchange={handleChange} {...rest} />
  <span class="smrt-radio__mark" data-smrt-part="mark" aria-hidden="true"></span><span class="smrt-radio__label" data-smrt-part="label">{label}</span>
</label>
<style>
@layer smrt.reset, smrt.structure, smrt.theme;
@layer smrt.structure {
  /* The visible mark stays 18px; a transparent 44x44 ::before hit area (see Checkbox) makes the
  touch target. Mark and label text sit above every hit area, so neighbours' hit areas never
  steal their clicks. Beside other content (a group's other options, text, a link) it keeps to
  the mark's column and grows vertically only. --smrt-control-hit-size resizes it (0px turns it
  off). */
  .smrt-radio__root {
    --smrt-radio-box: 1.15rem;
    --smrt-radio-hit: max(var(--smrt-control-hit-size, 2.75rem), var(--smrt-radio-box));
    position: relative;
    display: inline-flex;
    align-items: center;
    gap: var(--smrt-spacing-2);
    cursor: pointer;
  }
  .smrt-radio__root::before {
    content: '';
    position: absolute;
    z-index: 0;
    inset-block-start: 50%;
    inset-inline-start: calc(var(--smrt-radio-box) / 2);
    inline-size: var(--smrt-radio-hit);
    block-size: var(--smrt-radio-hit);
    margin-block-start: calc(var(--smrt-radio-hit) / -2);
    margin-inline-start: calc(var(--smrt-radio-hit) / -2);
  }
  .smrt-radio__root:not(:only-child)::before {
    inline-size: var(--smrt-radio-box);
    margin-inline-start: calc(var(--smrt-radio-box) / -2);
  }
  .smrt-radio__root.smrt-radio__disabled {
    cursor: not-allowed;
  }
  input {
    position: absolute;
    width: 1px;
    height: 1px;
    opacity: 0;
  }
  .smrt-radio__mark {
    position: relative;
    z-index: 1;
    width: 1.15rem;
    height: 1.15rem;
    display: grid;
    place-items: center;
  }
  .smrt-radio__label {
    position: relative;
    z-index: 1;
  }
  .smrt-radio__mark::after {
    content: '';
    width: .55rem;
    height: .55rem;
    transform: scale(0);
  }
  .smrt-radio__root {
    min-height: var(--smrt-control-target-min);
    min-width: var(--smrt-control-target-min);
  }
  /* Table cells: grow vertically only, never into a neighbouring cell. */
  :global(:is(td, th)) .smrt-radio__root::before {
    inline-size: var(--smrt-radio-box);
    margin-inline-start: calc(var(--smrt-radio-box) / -2);
  }
}

@layer smrt.theme {
  .smrt-radio__root.smrt-radio__disabled {
    opacity: .5;
  }
  .smrt-radio__mark {
    border: 2px solid var(--smrt-color-outline);
    border-radius: 50%;
  }
  .smrt-radio__mark::after {
    border-radius: 50%;
    background: var(--smrt-color-primary);
    transition: transform var(--smrt-duration-short2);
  }
  input:checked + .smrt-radio__mark {
    border-color: var(--smrt-color-primary);
  }
  input:checked + .smrt-radio__mark::after {
    transform: scale(1);
  }
  input:focus-visible + .smrt-radio__mark {
    outline: var(--smrt-focus-ring-width) solid var(--smrt-focus-ring-color);
    outline-offset: var(--smrt-focus-ring-offset);
  }
  /* Forced colors (#3908): system colours where colour alone carries meaning. */
  @media (forced-colors: active) {
    .smrt-radio__mark {
      border-color: CanvasText;
    }
    .smrt-radio__mark::after {
      background: Highlight;
    }
    input:checked + .smrt-radio__mark {
      border-color: Highlight;
    }
    .smrt-radio__root.smrt-radio__disabled {
      opacity: 1;
      color: GrayText;
    }
    .smrt-radio__root.smrt-radio__disabled .smrt-radio__mark, .smrt-radio__root.smrt-radio__disabled input:checked + .smrt-radio__mark {
      border-color: GrayText;
    }
    .smrt-radio__root.smrt-radio__disabled .smrt-radio__mark::after {
      background: GrayText;
    }
  }
}

</style>
