<script lang="ts">
import CalendarView from '../../components/calendar/CalendarView.svelte';
import type {
  CalendarItem,
  CalendarMode,
} from '../../components/calendar/calendar-model.js';
import SegmentedControl from '../../components/forms/SegmentedControl.svelte';

const zone = 'America/Edmonton';
const today = new Date();
const y = today.getUTCFullYear();
const m = today.getUTCMonth() + 1;
const pad = (n: number) => String(n).padStart(2, '0');
const day = (d: number) => `${y}-${pad(m)}-${pad(d)}`;
const at = (d: number, hour: number) =>
  new Date(`${day(d)}T${pad(hour)}:00:00-06:00`);

let mode = $state<CalendarMode>('auto');
let picked = $state('');

const items: CalendarItem[] = [
  {
    id: 'fair',
    title: 'Fall fair',
    start: day(4),
    end: day(7),
    group: 'community',
    label: 'Community',
  },
  {
    id: 'council',
    title: 'Council meeting',
    start: at(9, 19),
    end: at(9, 21),
    group: 'council',
    label: 'Council',
  },
  {
    id: 'game-1',
    title: 'Hawks vs Owls',
    start: at(12, 13),
    group: 'sports',
    label: 'Sports',
  },
  {
    id: 'game-2',
    title: 'Owls vs Crows',
    start: at(12, 15),
    group: 'sports',
    label: 'Sports',
  },
  {
    id: 'game-3',
    title: 'Crows vs Hawks',
    start: at(12, 17),
    group: 'sports',
    label: 'Sports',
  },
  {
    id: 'game-4',
    title: 'Final',
    start: at(12, 19),
    group: 'sports',
    label: 'Sports',
  },
  {
    id: 'deadline',
    title: 'Budget comments close',
    start: day(15),
    tone: 'warning',
  },
  {
    id: 'camp',
    title: 'Hockey camp',
    start: at(18, 9),
    end: at(21, 16),
    group: 'sports',
    label: 'Sports',
  },
];
</script>

<div class="workbench">
  <header>
    <div>
      <p class="eyebrow">Calendar</p>
      <h4>Month grid, all-day bands, and the phone agenda ({zone})</h4>
    </div>
    <SegmentedControl
      label="Mode"
      value={mode}
      interaction={false}
      options={[
        { value: 'auto', label: 'Auto' },
        { value: 'month', label: 'Month' },
        { value: 'agenda', label: 'Agenda' },
      ]}
      onvaluechange={(value) => (mode = value as CalendarMode)}
    />
  </header>
  <CalendarView
    {items}
    {mode}
    timeZone={zone}
    onItemSelect={(item) => (picked = item.title)}
  />
  <p class="picked" aria-live="polite">{picked ? `Selected: ${picked}` : ''}</p>
</div>

<style>
  .workbench {
    display: grid;
    gap: var(--smrt-spacing-4, 1rem);
  }

  header {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: var(--smrt-spacing-3, 0.75rem);
  }

  .eyebrow {
    margin: 0;
    color: var(--smrt-color-on-surface-variant, #44474e);
    font-size: var(--smrt-typography-label-medium-size, 0.75rem);
    text-transform: uppercase;
  }

  h4 {
    margin: 0;
  }


  .picked {
    margin: 0;
    min-height: 1.5rem;
    color: var(--smrt-color-on-surface-variant, #44474e);
  }
</style>
