<script lang="ts">
import { Chart } from '@happyvertical/smrt-ui/charts';
import type { WidgetComponentProps } from '../types.js';
import type { ChartWidgetData } from './data.js';

let { options, data, title, locale }: WidgetComponentProps<ChartWidgetData> =
  $props();
</script>

<div data-smrt-component="ChartWidget">
  <Chart data={data ?? null} style={String(options.style ?? 'bar')} {title} {locale} />
</div>
