<script lang="ts">
import { Chart, type ChartData } from '@happyvertical/smrt-ui/charts';

export interface Props {
  options: Record<string, string | number | boolean | null>;
  data?: ChartData;
  title: string;
  locale: string;
}
let { options, data, title, locale }: Props = $props();
</script>

<div data-smrt-component="RuntimeReportChartWidget">
  <Chart
    data={data ?? null}
    style={typeof options.style === 'string' ? options.style : 'bar'}
    {title}
    {locale}
  />
</div>
