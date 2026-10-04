<script lang="ts">
/**
 * Icon - SVG icon component
 *
 * Displays SVG icons from presets or custom paths.
 *
 * Accessibility:
 * - Use aria-label for informative icons
 * - Uses aria-hidden="true" by default (decorative)
 */

import { resolveIconPath } from './icons.svelte.js';

/** Props for Icon component */
export interface Props {
  /** Preset icon name */
  name?: string;
  /** Custom SVG path */
  path?: string;
  /** Icon size (number for pixels, string for CSS value) */
  size?: string | number;
  /** Icon color */
  color?: string;
  /** SVG viewBox */
  viewBox?: string;
  /** Accessible label (makes icon informative) */
  'aria-label'?: string;
}

const {
  name,
  path,
  size = 24,
  color = 'currentColor',
  viewBox = '0 0 24 24',
  'aria-label': ariaLabel,
}: Props = $props();

const isInformative = $derived(!!ariaLabel);

const finalPath = $derived(path ?? (name ? resolveIconPath(name) : ''));
const pxSize = $derived(typeof size === 'number' ? `${size}px` : size);
</script>

<svg
  xmlns="http://www.w3.org/2000/svg"
  width={pxSize}
  height={pxSize}
  {viewBox}
  fill={color}
  aria-hidden={!isInformative}
  aria-label={ariaLabel}
  role={isInformative ? 'img' : undefined}
>
  <path d={finalPath} />
</svg>

<style>
  svg {
    display: inline-block;
    flex-shrink: 0;
    vertical-align: middle;
  }
</style>
