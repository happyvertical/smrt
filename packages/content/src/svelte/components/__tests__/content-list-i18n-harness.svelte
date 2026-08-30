<script lang="ts">
import { createI18nContext, setI18nContext } from '@happyvertical/smrt-ui/i18n';
import type { ContentData } from '../../../mock-smrt-client.js';
import type { ContentListWorkflowBinding } from '../../content-list-workflows.js';
import ContentList from '../ContentList.svelte';

interface Props {
  contents: ContentData[];
  workflows: ContentListWorkflowBinding;
  messages: Record<string, string>;
}

const { contents, workflows, messages }: Props = $props();
// svelte-ignore state_referenced_locally
setI18nContext(createI18nContext({ locale: 'fr', messages }));
</script>

<ContentList
  {contents}
  {workflows}
  onEdit={() => undefined}
  onDelete={() => undefined}
  onAdd={() => undefined}
/>
