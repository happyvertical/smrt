<script lang="ts">
import CalendarView from '../src/components/calendar/CalendarView.svelte';
let date = $state('2026-09-29');
let selected = $state('');
</script>
<CalendarView
  mode="auto" autoMode="week" {date} weekStartsOn={1}
  timeZone="America/Edmonton" locale="en-US" now={new Date('2026-09-29T18:00:00Z')}
  items={[{ id: 'closure', title: 'Closure', start: '2026-09-28', end: '2026-09-30' }]}
  onNavigate={(next) => { if (next.date) date = next.date; }}
  onSelectDate={(key) => selected = key}
/>
<output aria-label="Visible week">{date}</output>
<output aria-label="Selected day">{selected}</output>
