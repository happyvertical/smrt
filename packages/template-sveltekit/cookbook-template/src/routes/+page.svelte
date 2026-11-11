<script lang="ts">
import { defineMessages, useI18n } from '@happyvertical/smrt-ui/i18n';
import { EmptyState } from '@happyvertical/smrt-ui/layout';

const M = defineMessages({
  'cookbook.fresh.title': 'What would you like to build?',
  'cookbook.fresh.description':
    'Tell your assistant about your work to add your first lists, or choose a template in Settings.',
});
const { t } = useI18n();
</script>
<EmptyState title={t(M['cookbook.fresh.title'])} description={t(M['cookbook.fresh.description'])} />
