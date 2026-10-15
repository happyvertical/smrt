<script lang="ts">
import { FormActionBar } from '@happyvertical/smrt-ui/forms';
import { useI18n } from '@happyvertical/smrt-ui/i18n';
import { Button } from '@happyvertical/smrt-ui/ui';
import { onMount, untrack } from 'svelte';
import { getRuntimeReportsBrowserClient } from './browser-client.js';
import { M } from './messages.js';
import ReportPicker from './ReportPicker.svelte';
import type { RuntimeReportsClient } from './types.js';

type Options = Record<string, string | number | boolean | null>;
interface Issue {
  key: string;
  code: string;
}
export interface Props {
  initial: Options;
  onsave: (options: Options) => Issue[] | null;
  oncancel: () => void;
}
let { initial, onsave, oncancel }: Props = $props();
const { t } = useI18n();
let client = $state<RuntimeReportsClient | undefined>();
let value = $state(
  untrack(() => ({
    reportId: typeof initial.reportId === 'string' ? initial.reportId : '',
    measure: typeof initial.measure === 'string' ? initial.measure : '',
    dimension: typeof initial.dimension === 'string' ? initial.dimension : '',
  })),
);
let failed = $state(false);
onMount(() => {
  client = getRuntimeReportsBrowserClient();
});
function save() {
  const options: Options = {
    reportId: value.reportId,
    measure: value.measure,
    ...(value.dimension ? { dimension: value.dimension } : {}),
  };
  failed = onsave(options) !== null;
}
</script>

<div data-smrt-component="RuntimeReportWidgetOptions">
  <ReportPicker
    {client}
    reportId={value.reportId}
    measure={value.measure}
    dimension={value.dimension}
    onchange={(next) => (value = next)}
  />
  {#if failed}<p role="alert">{t(M['reports.options_invalid'])}</p>{/if}
  <FormActionBar>
    <Button type="button" variant="ghost" onclick={oncancel}>{t(M['reports.cancel'])}</Button>
    <Button type="button" variant="primary" onclick={save}>{t(M['reports.save'])}</Button>
  </FormActionBar>
</div>
