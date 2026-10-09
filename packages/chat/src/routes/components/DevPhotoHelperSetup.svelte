<script lang="ts">
import { PhotoCutoutSetup } from '@happyvertical/smrt-images/svelte';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { createDevCharacterPersistenceClient } from '../../dev-character-persistence-client.js';
import type { HelperOffering } from '../../helper-preferences.js';
import { M } from '../../svelte/i18n.messages.js';

interface Props {
  /** Receives the server-authorized offering just saved by this setup. */
  onsaved: (offering: HelperOffering) => void;
  oncancel: () => void;
}
let { onsaved }: Props = $props();
const { t } = useI18n();
const persistence = createDevCharacterPersistenceClient();

async function saveSetup(setup: Parameters<typeof persistence.save>[0]) {
  const saved = await persistence.save(setup);
  const latest = (await persistence.list()).find(
    (entry) => entry.assetId === saved.assetId,
  );
  if (!latest) throw new Error('Saved photo helper is unavailable.');
  onsaved({
    id: `photo:${latest.assetId}`,
    label: latest.name || 'Saved photo helper',
    styleId: 'photo-cutout',
    source: 'saved',
    assetId: latest.assetId,
  });
  return saved;
}
</script>

<section aria-label={t(M['chat.helper.add_style'], { style: 'photo' })}>
  <PhotoCutoutSetup {saveSetup} />
</section>
