<script lang="ts">
import {
  type ControlInteractionRegistry,
  Form,
} from '@happyvertical/smrt-ui/forms';
import ContentBodyEditor from '../ContentBodyEditor.svelte';
import ContentMetadataFields from '../ContentMetadataFields.svelte';
import ContentStatusFields from '../ContentStatusFields.svelte';
import ContentTitleField from '../ContentTitleField.svelte';
import type { ContentFieldMode } from '../content-field-mode.js';

let {
  registry,
  mode = 'full',
  onChange,
}: {
  registry: ControlInteractionRegistry;
  mode?: ContentFieldMode;
  onChange?: (change: Record<string, unknown>) => void;
} = $props();
let form = $state<Record<string, unknown>>({
  title: 'Council approves budget',
  status: 'draft',
  body: '<p>The council met.</p>',
  author: 'Pat',
  description: '',
  tags: ['council'],
});
function update(change: Record<string, unknown>) {
  form = { ...form, ...change };
  onChange?.(change);
}
</script>

<Form formId="content-editor" interactionRegistry={registry} aria-label="Edit article">
  <ContentTitleField name="title" value={String(form.title)} onChange={(title) => update({ title })} />
  <ContentStatusFields data={form} {mode} onChange={update} />
  <ContentBodyEditor
    value={String(form.body)}
    format="html"
    onChange={(change) => update({ body: change.body })}
  />
  <ContentMetadataFields data={form} {mode} onChange={update} />
</Form>
