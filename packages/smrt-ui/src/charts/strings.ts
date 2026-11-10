import { defineMessages } from '../i18n/registry.js';

export const M = defineMessages({
  'ui.overview.no_data': 'Nothing to show yet.',
  'ui.overview.metric.change_up': 'Up {value} from the previous period',
  'ui.overview.metric.change_down': 'Down {value} from the previous period',
  'ui.overview.chart.summary': 'Chart with {count} values',
  'ui.overview.chart.table': 'Chart data',
  'ui.overview.chart.label_column': 'Label',
  'ui.overview.chart.value_column': 'Value',
  'ui.overview.chart.peak': 'Peak {value} · {label}',
  'ui.overview.chart.latest': 'Latest {value} · {label}',
  'ui.overview.chart.explore':
    'Use the arrow keys to read each value; Home and End jump to the first and last.',
  'ui.overview.chart.point': '{label}: {value}',
});
