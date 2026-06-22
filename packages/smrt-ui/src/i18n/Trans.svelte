<script lang="ts">
/**
 * `<Trans>` — the component form of `$t` (S13 #1418), for translating strings in
 * element bodies. Equal first-class partner to `useI18n().t` for attributes.
 *
 * @example
 * ```svelte
 * <p><Trans key="ui.pagination.range" vars={{ count, total }} /></p>
 * ```
 *
 * Phase 1 renders plain interpolated text. Rich interpolation (links, nested
 * components inside placeholders) is a planned extension via snippet values —
 * see the i18n ADR.
 */
import type { LanguageVariables } from './render.js';
import { useI18n } from './use-i18n.js';

interface Props {
  /** Message key, e.g. `ui.data_table.empty`. */
  key: string;
  /** Variables substituted into `{var}` placeholders. */
  vars?: LanguageVariables;
}

const { key, vars }: Props = $props();
const i18n = useI18n();
</script>

{i18n.t(key, vars)}
