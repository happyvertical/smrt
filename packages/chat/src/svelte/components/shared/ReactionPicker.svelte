<script lang="ts">
/**
 * ReactionPicker — chat's emoji reaction selector.
 *
 * A thin adapter over the canonical `@happyvertical/smrt-ui/chat`
 * `ReactionPicker` (no duplicated markup/styles): it supplies chat's emoji
 * palette and routes the group + per-emoji labels through chat's i18n catalog,
 * and preserves the package's `onreact` / `isOpen` vocabulary + the
 * `ModuleUIRegistry` registration.
 */
import { ReactionPicker as UIReactionPicker } from '@happyvertical/smrt-ui/chat';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { M } from '../../i18n.js';

const { t } = useI18n();

export interface Props {
  /** Callback when an emoji is selected */
  onreact: (emoji: string) => void;
  /** Whether the picker is visible */
  isOpen?: boolean;
}

const { onreact, isOpen = false }: Props = $props();

const emojis = [
  '\u{1F44D}',
  '\u{1F44E}',
  '\u{2764}\u{FE0F}',
  '\u{1F602}',
  '\u{1F62E}',
  '\u{1F622}',
  '\u{1F525}',
  '\u{1F389}',
  '\u{1F44F}',
  '\u{1F914}',
  '\u{1F60D}',
  '\u{1F680}',
  '\u{1F440}',
  '\u{2705}',
  '\u{274C}',
  '\u{1F4AF}',
];
</script>

<UIReactionPicker
  {emojis}
  {isOpen}
  label={t(M['chat.reaction_picker.reactions'])}
  emojiLabel={(emoji) => t(M['chat.reaction_picker.react_with'], { emoji })}
  onpick={onreact}
/>
