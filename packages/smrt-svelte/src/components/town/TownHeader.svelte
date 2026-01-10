<script lang="ts">
/**
 * TownHeader Component
 * Editorial-style weather forecast with tab navigation and event indicators
 */

import { slide } from 'svelte/transition';
import type {
  DayEvent,
  DayEventDetail,
  DayEventsData,
  DayForecast,
  HourlyForecast,
} from '../../types-generic';

interface ForecastPeriod {
  name: string;
  conditions: string;
  temperature: number;
  windSpeed: number;
  windDirection: number;
  humidity: number;
  precipProbability: number;
  localHour: number;
}

interface ForecastDay {
  day: string;
  icon: string;
  high: number;
  low: number;
  periods: ForecastPeriod[];
}

interface Props {
  forecast?: ForecastDay[] | null;
  events?: DayEvent[] | null;
  detailedEvents?: DayEventsData[] | null;
  /** Callback when a day tab is selected */
  onDaySelect?: (dayIndex: number, dayName: string) => void;
  /** Callback when view is toggled between graph and hourly */
  onViewToggle?: (viewType: 'graph' | 'hourly') => void;
  /** Callback when panel is collapsed */
  onCollapse?: (dayIndex: number) => void;
}

const {
  forecast,
  events,
  detailedEvents,
  onDaySelect,
  onViewToggle,
  onCollapse,
}: Props = $props();

let selectedDayIndex = $state<number | null>(null);
// biome-ignore lint/style/useConst: $state requires let for reassignment
let weatherViewTab = $state<'hourly' | 'graph'>('graph');

// Event icon mapping
function getEventIcon(type: DayEvent['type']): string {
  switch (type) {
    case 'game':
      return '\u{1F3D2}'; // hockey stick and puck
    case 'meeting':
      return '\u{1F3DB}'; // classical building
    case 'event':
      return '\u{1F4C5}'; // calendar
    default:
      return '\u{1F4C5}';
  }
}

// Get events for a specific date
function getEventsForDate(dateOffset: number): DayEvent[] {
  if (!events || events.length === 0) return [];

  const targetDate = getDateFromOffset(dateOffset);
  const targetDateStr = formatISODate(targetDate);

  return events.filter((e) => e.date === targetDateStr);
}

function formatISODate(date: Date): string {
  return date.toISOString().split('T')[0];
}

const dayForecasts: DayForecast[] = $derived(
  forecast && forecast.length > 0
    ? forecast.map((day, index) => {
        const date = getDateFromOffset(index);
        return {
          id: `day-${index}`,
          dayName: day.day,
          date: formatShortDate(date),
          icon: day.icon,
          high: day.high,
          low: day.low,
          hourlyData: transformHourlyData(day.periods, index),
        };
      })
    : [],
);

function getDateFromOffset(offset: number): Date {
  const today = new Date();
  today.setDate(today.getDate() + offset);
  return today;
}

function formatShortDate(date: Date): string {
  const day = date.getDate();
  const month = date.toLocaleDateString('en-US', { month: 'short' });
  return `${month} ${day}`;
}

function formatFullDate(date: Date): string {
  return date.toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  });
}

function transformHourlyData(
  periods: ForecastPeriod[],
  dayIndex: number,
): HourlyForecast[] {
  const now = new Date();
  const currentHour = now.getHours();

  return periods
    .map((period) => {
      const hour = period.localHour;
      return {
        time: `${hour.toString().padStart(2, '0')}:00`,
        hour,
        icon: getHourlyIcon(period.conditions),
        temperature: period.temperature,
        feelsLike: period.temperature - 2,
        windSpeed: period.windSpeed,
        windDirection: period.windDirection,
        precipProbability: period.precipProbability,
      };
    })
    .filter((item) => (dayIndex === 0 ? item.hour >= currentHour : true));
}

function getWindDirection(degrees: number): string {
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return directions[Math.round(degrees / 45) % 8] || 'N';
}

function getHourlyIcon(conditions: string): string {
  const c = conditions.toLowerCase();
  if (c.includes('sunny') || c.includes('clear')) return '\u2600\uFE0F';
  if (c.includes('partly cloudy')) return '\u26C5';
  if (c.includes('cloud')) return '\u2601\uFE0F';
  if (c.includes('rain')) return '\u{1F327}\uFE0F';
  if (c.includes('snow')) return '\u2744\uFE0F';
  if (c.includes('thunder')) return '\u26C8\uFE0F';
  return '\u{1F324}\uFE0F';
}

function getMockData(): DayForecast[] {
  const today = new Date();
  const icons = [
    '\u2600\uFE0F',
    '\u26C5',
    '\u2601\uFE0F',
    '\u{1F327}\uFE0F',
    '\u26C5',
    '\u2600\uFE0F',
    '\u26C8\uFE0F',
    '\u2744\uFE0F',
    '\u{1F324}\uFE0F',
    '\u2601\uFE0F',
  ];

  return Array.from({ length: 10 }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() + index);
    const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });

    const hourlyData: HourlyForecast[] = [];
    for (let hour = 0; hour < 24; hour += 3) {
      hourlyData.push({
        time: `${hour.toString().padStart(2, '0')}:00`,
        hour,
        icon: icons[Math.floor(Math.random() * icons.length)],
        temperature: Math.round(15 + Math.random() * 10),
        feelsLike: Math.round(13 + Math.random() * 10),
      });
    }

    return {
      id: `day-${index}`,
      dayName,
      date: formatShortDate(date),
      icon: icons[index % icons.length],
      high: Math.round(20 + Math.random() * 5),
      low: Math.round(10 + Math.random() * 5),
      hourlyData,
    };
  });
}

function handleTabClick(index: number) {
  const wasSelected = selectedDayIndex === index;
  selectedDayIndex = wasSelected ? null : index;

  // Fire callback when selecting a day (not when deselecting)
  if (!wasSelected && onDaySelect) {
    const day = dayForecasts[index];
    onDaySelect(index, day?.dayName || '');
  }
}

function handleCollapse() {
  const previousIndex = selectedDayIndex;
  selectedDayIndex = null;

  // Fire callback with the day that was collapsed
  if (previousIndex !== null && onCollapse) {
    onCollapse(previousIndex);
  }
}

const selectedDay = $derived(
  selectedDayIndex !== null ? dayForecasts[selectedDayIndex] : null,
);

const selectedFullDate = $derived(
  selectedDayIndex !== null
    ? formatFullDate(getDateFromOffset(selectedDayIndex))
    : '',
);

// Get detailed events for the selected day
const selectedDayEvents = $derived.by(() => {
  if (selectedDayIndex === null || !detailedEvents)
    return [] as DayEventDetail[];

  const targetDate = getDateFromOffset(selectedDayIndex);
  const targetDateStr = formatISODate(targetDate);

  const dayData = detailedEvents.find((d) => d.date === targetDateStr);
  return dayData?.events || [];
});

// Helper to get event URL
function getEventUrl(event: DayEventDetail): string {
  if (event.type === 'game') {
    return `/sports/hockey/games/${event.slug}/`;
  }
  if (event.type === 'meeting' && event.councilSlug) {
    return `/meetings/${event.councilSlug}/${event.slug}/`;
  }
  return '#';
}

// Handle event click with collapse and fade animation
function handleEventClick(event: MouseEvent, eventData: DayEventDetail) {
  event.preventDefault();
  const url = getEventUrl(eventData);
  if (url === '#') return;

  // Collapse the panel
  selectedDayIndex = null;

  // Dispatch event for parent to handle content fade
  if (typeof window !== 'undefined') {
    window.dispatchEvent(
      new CustomEvent('townheader:navigate', { detail: { url } }),
    );
  }

  // Wait for animations, then navigate
  setTimeout(() => {
    window.location.href = url;
  }, 300);
}

// Helper to get event icon (for panel display)
function getDetailedEventIcon(type: DayEventDetail['type']): string {
  switch (type) {
    case 'game':
      return '\u{1F3D2}'; // hockey stick and puck
    case 'meeting':
      return '\u{1F3DB}'; // classical building
    case 'event':
      return '\u{1F4C5}'; // calendar
    default:
      return '\u{1F4C5}';
  }
}

const isFirst = $derived(selectedDayIndex === 0);
const isLast = $derived(selectedDayIndex === dayForecasts.length - 1);

// Extended hourly data combining current day with prev/next day previews
const extendedHourlyData = $derived.by((): ExtendedHourlyItem[] => {
  if (selectedDayIndex === null) return [];

  const currentDay = dayForecasts[selectedDayIndex];
  if (!currentDay) return [];

  const result: ExtendedHourlyItem[] = [];

  // Previous day preview (noon-midnight, 12 hours) - only if not first day
  if (selectedDayIndex > 0) {
    const prevDay = dayForecasts[selectedDayIndex - 1];
    if (prevDay) {
      const eveningHours = prevDay.hourlyData.filter((h) => h.hour >= 12);
      for (const h of eveningHours) {
        result.push({
          type: 'hour',
          hour: h.hour,
          icon: h.icon,
          temperature: h.temperature,
          windSpeed: h.windSpeed,
          windDirection: h.windDirection,
          precipProbability: h.precipProbability,
          dayOffset: -1,
        });
      }
      // Add midnight separator after prev day data
      if (eveningHours.length > 0) {
        result.push({ type: 'separator', label: 'midnight' });
      }
    }
  }

  // Current day (full data)
  for (const h of currentDay.hourlyData) {
    result.push({
      type: 'hour',
      hour: h.hour,
      icon: h.icon,
      temperature: h.temperature,
      windSpeed: h.windSpeed,
      windDirection: h.windDirection,
      precipProbability: h.precipProbability,
      dayOffset: 0,
    });
  }

  // Next day preview (midnight-noon) - only if not last day
  // Extend to noon (12 hours) to ensure enough scroll room on desktop
  if (selectedDayIndex < dayForecasts.length - 1) {
    const nextDay = dayForecasts[selectedDayIndex + 1];
    if (nextDay) {
      const morningHours = nextDay.hourlyData.filter((h) => h.hour < 12);
      // Add midnight separator before next day data
      if (morningHours.length > 0) {
        result.push({ type: 'separator', label: 'midnight' });
        for (const h of morningHours) {
          result.push({
            type: 'hour',
            hour: h.hour,
            icon: h.icon,
            temperature: h.temperature,
            windSpeed: h.windSpeed,
            windDirection: h.windDirection,
            precipProbability: h.precipProbability,
            dayOffset: 1,
          });
        }
      }
    }
  }

  return result;
});

// Chart data for temperature graph view
interface ChartPoint {
  x: number;
  y: number;
  temp: number;
  label: string;
  icon: string;
  wind: string;
  pop: number;
  dayOffset: number; // -1 = prev day preview, 0 = current, 1 = next day preview
}

interface ChartSeparator {
  x: number;
  label: string;
}

// Extended hourly data item (can be hour or separator)
interface ExtendedHourlyItem {
  type: 'hour' | 'separator';
  hour?: number;
  icon?: string;
  temperature?: number;
  windSpeed?: number;
  windDirection?: number;
  precipProbability?: number;
  dayOffset?: number; // -1, 0, or 1
  label?: string; // for separator
}

function getTemperatureChartPath(extendedData: ExtendedHourlyItem[]): {
  path: string;
  points: ChartPoint[];
  separators: ChartSeparator[];
  width: number;
  minTemp: number;
  maxTemp: number;
  prevMidnightX: number | null;
  nextMidnightX: number | null;
  currentDayStartX: number;
} {
  if (extendedData.length === 0)
    return {
      path: '',
      points: [],
      separators: [],
      width: 600,
      minTemp: 0,
      maxTemp: 30,
      prevMidnightX: null,
      nextMidnightX: null,
      currentDayStartX: 0,
    };

  // Get only hour items for temperature calculations
  const hourItems = extendedData.filter((item) => item.type === 'hour');
  const temps = hourItems.map((h) => h.temperature!);
  const dataMin = Math.min(...temps);
  const dataMax = Math.max(...temps);

  // Fixed 30-degree range, centered on the data's midpoint
  const dataMid = (dataMin + dataMax) / 2;
  const fixedRange = 30;
  const minTemp = Math.round(dataMid - fixedRange / 2);
  const maxTemp = minTemp + fixedRange;

  // Fixed width per item for horizontal scrolling
  const pointSpacing = 50;
  const separatorSpacing = 30; // Separators take less space
  const paddingX = 30;

  // Calculate total width
  let totalWidth = paddingX * 2;
  for (let i = 0; i < extendedData.length; i++) {
    if (i > 0) {
      totalWidth +=
        extendedData[i].type === 'separator' ? separatorSpacing : pointSpacing;
    }
  }

  const height = 160;
  const chartTop = 50;
  const chartBottom = 110;

  const points: ChartPoint[] = [];
  const separators: ChartSeparator[] = [];
  let prevMidnightX: number | null = null;
  let nextMidnightX: number | null = null;
  let currentDayStartX = paddingX;

  let currentX = paddingX;
  let isFirstCurrentDayPoint = true;

  for (let i = 0; i < extendedData.length; i++) {
    const item = extendedData[i];

    if (item.type === 'separator') {
      // Track separator positions for scroll detection
      separators.push({ x: currentX, label: item.label || 'midnight' });

      // Determine if this is prev or next midnight
      const prevItem = extendedData[i - 1];
      if (prevItem && prevItem.dayOffset === -1) {
        prevMidnightX = currentX;
      } else if (prevItem && prevItem.dayOffset === 0) {
        nextMidnightX = currentX;
      }

      currentX += separatorSpacing;
    } else {
      // Hour item
      const hour = item;
      const normalizedTemp = (maxTemp - hour.temperature!) / fixedRange;
      const y = chartTop + normalizedTemp * (chartBottom - chartTop);

      // Track where current day starts
      if (hour.dayOffset === 0 && isFirstCurrentDayPoint) {
        currentDayStartX = currentX;
        isFirstCurrentDayPoint = false;
      }

      // Format time label
      const hourNum = hour.hour!;
      const displayHour =
        hourNum === 0 ? 12 : hourNum > 12 ? hourNum - 12 : hourNum;
      const ampm = hourNum < 12 ? 'a' : 'p';
      const label = `${displayHour}${ampm}`;

      // Format wind
      const windDir = getWindDirection(hour.windDirection ?? 0);
      const wind = `${hour.windSpeed ?? 0} ${windDir}`;

      points.push({
        x: currentX,
        y,
        temp: hour.temperature!,
        label,
        icon: hour.icon || '',
        wind,
        pop: hour.precipProbability ?? 0,
        dayOffset: hour.dayOffset ?? 0,
      });

      if (i < extendedData.length - 1) {
        currentX += pointSpacing;
      }
    }
  }

  // Build path from points only (skip separators in the line)
  const path = points
    .map((point, i) => `${i === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ');

  return {
    path,
    points,
    separators,
    width: currentX + paddingX,
    minTemp,
    maxTemp,
    prevMidnightX,
    nextMidnightX,
    currentDayStartX,
  };
}

const chartData = $derived(
  selectedDay
    ? getTemperatureChartPath(extendedHourlyData)
    : {
        path: '',
        points: [],
        separators: [],
        width: 600,
        prevMidnightX: null,
        nextMidnightX: null,
        currentDayStartX: 0,
      },
);

// Drag-to-scroll state (shared between tabs, hourly grid, and chart)
// biome-ignore lint/style/useConst: bind:this requires let, not const
let tabsEl = $state<HTMLElement | null>(null);
// biome-ignore lint/style/useConst: bind:this requires let, not const
let hourlyGridEl = $state<HTMLElement | null>(null);
// biome-ignore lint/style/useConst: bind:this requires let, not const
let chartScrollEl = $state<HTMLElement | null>(null);
let activeScrollEl = $state<HTMLElement | null>(null);
let isDragging = $state(false);
let startX = $state(0);
let scrollLeft = $state(0);

// Document-level mouseup listener to handle drag release outside the element
$effect(() => {
  function handleDocumentMouseUp() {
    if (isDragging && activeScrollEl) {
      isDragging = false;
      activeScrollEl.style.cursor = 'grab';
      activeScrollEl = null;
    }
  }
  document.addEventListener('mouseup', handleDocumentMouseUp);
  return () => document.removeEventListener('mouseup', handleDocumentMouseUp);
});

// Generic scroll handlers that work with any scrollable element
function handleScrollMouseDown(e: MouseEvent, el: HTMLElement | null) {
  if (!el) return;
  isDragging = true;
  activeScrollEl = el;
  el.style.cursor = 'grabbing';
  startX = e.pageX - el.offsetLeft;
  scrollLeft = el.scrollLeft;
}

function handleScrollMouseMove(e: MouseEvent, el: HTMLElement | null) {
  if (!isDragging || !el || activeScrollEl !== el) return;
  e.preventDefault();
  const x = e.pageX - el.offsetLeft;
  const walk = (x - startX) * 1.5;
  el.scrollLeft = scrollLeft - walk;
}

function handleScrollMouseUp(el: HTMLElement | null) {
  if (!el || activeScrollEl !== el) return;
  isDragging = false;
  el.style.cursor = 'grab';
  activeScrollEl = null;
}

function handleScrollMouseLeave(el: HTMLElement | null) {
  if (!el || activeScrollEl !== el) return;
  isDragging = false;
  el.style.cursor = 'grab';
  activeScrollEl = null;
}

function handleScrollKeyDown(e: KeyboardEvent, el: HTMLElement | null) {
  if (!el) return;
  const scrollAmount = 100;
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    el.scrollBy({ left: -scrollAmount, behavior: 'smooth' });
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    el.scrollBy({ left: scrollAmount, behavior: 'smooth' });
  }
}

// Legacy handlers for hourly grid (for backwards compatibility)
function handleMouseDown(e: MouseEvent) {
  handleScrollMouseDown(e, hourlyGridEl);
}

function handleMouseMove(e: MouseEvent) {
  handleScrollMouseMove(e, hourlyGridEl);
}

function handleMouseUp() {
  handleScrollMouseUp(hourlyGridEl);
}

function handleMouseLeave() {
  handleScrollMouseLeave(hourlyGridEl);
}

function handleKeyDown(e: KeyboardEvent) {
  handleScrollKeyDown(e, hourlyGridEl);
}

// Tabs scroll handlers
function handleTabsMouseDown(e: MouseEvent) {
  handleScrollMouseDown(e, tabsEl);
}

function handleTabsMouseMove(e: MouseEvent) {
  handleScrollMouseMove(e, tabsEl);
}

function handleTabsMouseUp() {
  handleScrollMouseUp(tabsEl);
}

function handleTabsMouseLeave() {
  handleScrollMouseLeave(tabsEl);
}

function handleTabsKeyDown(e: KeyboardEvent) {
  handleScrollKeyDown(e, tabsEl);
}

// Chart scroll handlers
function handleChartMouseDown(e: MouseEvent) {
  handleScrollMouseDown(e, chartScrollEl);
}

function handleChartMouseMove(e: MouseEvent) {
  handleScrollMouseMove(e, chartScrollEl);
}

function handleChartMouseUp() {
  handleScrollMouseUp(chartScrollEl);
}

function handleChartMouseLeave() {
  handleScrollMouseLeave(chartScrollEl);
}

function handleChartKeyDown(e: KeyboardEvent) {
  handleScrollKeyDown(e, chartScrollEl);
}

// Chart scroll position tracking for day switching
let scrollDebounceTimer: ReturnType<typeof setTimeout> | null = null;
let isScrollSwitching = $state(false); // Prevents recursive updates

function handleChartScroll() {
  if (isScrollSwitching || selectedDayIndex === null || !chartScrollEl) return;

  if (scrollDebounceTimer) clearTimeout(scrollDebounceTimer);

  scrollDebounceTimer = setTimeout(() => {
    if (!chartScrollEl || selectedDayIndex === null) return;

    const viewportCenter =
      chartScrollEl.scrollLeft + chartScrollEl.offsetWidth / 2;
    const { prevMidnightX, nextMidnightX } = chartData;

    // Scrolled into previous day territory?
    if (
      prevMidnightX !== null &&
      viewportCenter < prevMidnightX &&
      selectedDayIndex > 0
    ) {
      isScrollSwitching = true;
      const prevDay = dayForecasts[selectedDayIndex - 1];
      if (prevDay) {
        selectedDayIndex = selectedDayIndex - 1;
        // After switching, scroll to show end of the new current day
        // We need to wait for the chart to re-render
        requestAnimationFrame(() => {
          if (chartScrollEl) {
            // Scroll to show current day data (near the next midnight separator)
            const newChartData = getTemperatureChartPath(extendedHourlyData);
            if (newChartData.nextMidnightX !== null) {
              chartScrollEl.scrollLeft =
                newChartData.nextMidnightX - chartScrollEl.offsetWidth / 2;
            }
          }
          isScrollSwitching = false;
        });
      } else {
        isScrollSwitching = false;
      }
      return;
    }

    // Scrolled into next day territory?
    if (
      nextMidnightX !== null &&
      viewportCenter > nextMidnightX &&
      selectedDayIndex < dayForecasts.length - 1
    ) {
      isScrollSwitching = true;
      const nextDay = dayForecasts[selectedDayIndex + 1];
      if (nextDay) {
        selectedDayIndex = selectedDayIndex + 1;
        // After switching, scroll to show start of the new current day
        requestAnimationFrame(() => {
          if (chartScrollEl) {
            // Scroll to show current day data (near the prev midnight separator)
            const newChartData = getTemperatureChartPath(extendedHourlyData);
            if (newChartData.prevMidnightX !== null) {
              chartScrollEl.scrollLeft =
                newChartData.prevMidnightX - chartScrollEl.offsetWidth / 2 + 50;
            } else {
              chartScrollEl.scrollLeft = 0;
            }
          }
          isScrollSwitching = false;
        });
      } else {
        isScrollSwitching = false;
      }
      return;
    }
  }, 150); // 150ms debounce
}

// Scroll chart to current day start when day is selected via tab
$effect(() => {
  if (selectedDayIndex !== null && chartScrollEl && !isScrollSwitching) {
    // Use a small delay to ensure chart has rendered
    requestAnimationFrame(() => {
      if (chartScrollEl && chartData.currentDayStartX) {
        chartScrollEl.scrollLeft = Math.max(0, chartData.currentDayStartX - 30);
      }
    });
  }
});
</script>

{#if dayForecasts.length > 0}
<div class="weather-widget">
  <div
    class="tabs-wrapper"
    bind:this={tabsEl}
    onmousedown={handleTabsMouseDown}
    onmousemove={handleTabsMouseMove}
    onmouseup={handleTabsMouseUp}
    onmouseleave={handleTabsMouseLeave}
    onkeydown={handleTabsKeyDown}
    tabindex="0"
  >
    <div
      class="tabs"
      role="tablist"
      aria-label="Daily forecast, use arrow keys to scroll"
    >
      {#each dayForecasts as day, index}
        {@const dayEvents = getEventsForDate(index).filter(e => e.type !== 'event')}
        <button
          class="tab"
          class:active={selectedDayIndex === index}
          onclick={() => handleTabClick(index)}
          aria-expanded={selectedDayIndex === index}
          role="tab"
        >
          <span class="tab-header">
            <span class="tab-date">{day.date}</span>
            {#if dayEvents.length > 0}
              <span class="tab-events">
                {#each dayEvents as event}
                  <span class="event-icon" title="{event.count} {event.type}(s)">{getEventIcon(event.type)}</span>
                {/each}
              </span>
            {/if}
          </span>
          <span class="tab-icon">{day.icon}</span>
          <span class="tab-temps">
            <span class="high">{day.high}°</span>
            <span class="low">{day.low}°</span>
          </span>
        </button>
      {/each}
    </div>
  </div>

  {#if selectedDay}
    <div class="panel" class:first={isFirst} class:last={isLast}>
      <div class="panel-content">
        <!-- Weather Column -->
        <div class="weather-column">
          <header class="panel-header">
            <div class="panel-tabs">
              <button
                class="panel-tab"
                class:active={weatherViewTab === 'graph'}
                onclick={() => {
                  if (weatherViewTab !== 'graph') {
                    weatherViewTab = 'graph';
                    onViewToggle?.('graph');
                  }
                }}
              >
                Graph
              </button>
              <button
                class="panel-tab"
                class:active={weatherViewTab === 'hourly'}
                onclick={() => {
                  if (weatherViewTab !== 'hourly') {
                    weatherViewTab = 'hourly';
                    onViewToggle?.('hourly');
                  }
                }}
              >
                Hourly
              </button>
            </div>
            <span class="panel-date">{selectedFullDate}</span>
          </header>

          {#if weatherViewTab === 'hourly'}
            <div
              class="hourly-grid"
              bind:this={hourlyGridEl}
              onmousedown={handleMouseDown}
              onmousemove={handleMouseMove}
              onmouseup={handleMouseUp}
              onmouseleave={handleMouseLeave}
              onkeydown={handleKeyDown}
              role="list"
              tabindex="0"
              aria-label="Hourly forecast, use arrow keys to scroll"
            >
              {#each selectedDay.hourlyData as hour}
                <div class="hour-card" role="listitem">
                  <span class="hour-time">{hour.time}</span>
                  <span class="hour-icon">{hour.icon}</span>
                  <span class="hour-temp">{hour.temperature}°</span>
                  <span class="hour-feels">Feels {hour.feelsLike}°</span>
                </div>
              {/each}
            </div>
          {:else}
            <div
              class="temperature-chart-scroll"
              bind:this={chartScrollEl}
              onmousedown={handleChartMouseDown}
              onmousemove={handleChartMouseMove}
              onmouseup={handleChartMouseUp}
              onmouseleave={handleChartMouseLeave}
              onkeydown={handleChartKeyDown}
              onscroll={handleChartScroll}
              role="region"
              tabindex="0"
              aria-label="Temperature chart, drag to scroll"
            >
              <svg
                viewBox="0 0 {chartData.width} 160"
                class="chart-svg"
                width={chartData.width}
                height="160"
                aria-label="Temperature graph"
              >
                <!-- Midnight separators -->
                {#each chartData.separators as separator}
                  <line
                    x1={separator.x}
                    y1="10"
                    x2={separator.x}
                    y2="150"
                    stroke="var(--color-ink-muted)"
                    stroke-width="1"
                    stroke-dasharray="4,4"
                    opacity="0.5"
                  />
                  <text
                    x={separator.x}
                    y="158"
                    text-anchor="middle"
                    class="chart-separator-label"
                  >
                    {separator.label}
                  </text>
                {/each}
                <!-- Temperature line -->
                <path
                  d={chartData.path}
                  fill="none"
                  stroke="var(--color-accent)"
                  stroke-width="2.5"
                  stroke-linecap="round"
                  stroke-linejoin="round"
                />
                <!-- Data points and labels -->
                {#each chartData.points as point, i}
                  <g opacity={point.dayOffset === 0 ? 1 : 0.5}>
                    <!-- Weather icon -->
                    <text
                      x={point.x}
                      y="18"
                      text-anchor="middle"
                      class="chart-icon"
                    >
                      {point.icon}
                    </text>
                    <!-- Temperature label -->
                    <text
                      x={point.x}
                      y="36"
                      text-anchor="middle"
                      class="chart-temp-label"
                    >
                      {point.temp}°
                    </text>
                    <!-- Data point circle -->
                    <circle
                      cx={point.x}
                      cy={point.y}
                      r="4"
                      fill="var(--color-accent)"
                    />
                    <!-- Time label -->
                    <text
                      x={point.x}
                      y="125"
                      text-anchor="middle"
                      class="chart-time-label"
                    >
                      {point.label}
                    </text>
                    <!-- Wind info -->
                    <text
                      x={point.x}
                      y="138"
                      text-anchor="middle"
                      class="chart-wind-label"
                    >
                      {point.wind}
                    </text>
                    <!-- POP (only show if > 0) -->
                    {#if point.pop > 0}
                      <text
                        x={point.x}
                        y="151"
                        text-anchor="middle"
                        class="chart-pop-label"
                      >
                        {point.pop}%
                      </text>
                    {/if}
                  </g>
                {/each}
              </svg>
            </div>
          {/if}
        </div>

        <!-- Events Column -->
        {#if selectedDayEvents.length > 0}
          <div class="events-column" transition:slide={{ duration: 200 }}>
            <div class="events-list">
              {#each selectedDayEvents as event}
                <a href={getEventUrl(event)} class="event-card" onclick={(e) => handleEventClick(e, event)}>
                  <span class="event-card-icon">{getDetailedEventIcon(event.type)}</span>
                  <div class="event-details">
                    <span class="event-name">{event.name}</span>
                    <span class="event-meta">
                      {event.startTime}
                      {#if event.venue}<span class="event-venue"> · {event.venue}</span>{/if}
                    </span>
                  </div>
                  <span class="event-arrow">→</span>
                </a>
              {/each}
            </div>
          </div>
        {/if}
      </div>

      <button class="collapse-btn" onclick={handleCollapse} aria-label="Collapse">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M5 12L10 7L15 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
  {/if}
</div>
{/if}

<style>
  .weather-widget {
    --widget-radius: 12px;
    --widget-shadow: 0 4px 20px rgba(0, 0, 0, 0.12);
    --tab-shadow: 0 -4px 12px rgba(0, 0, 0, 0.15);
    --widget-border: rgba(0, 0, 0, 0.08);
    --color-warm-white: #faf9f7;
    --color-warm-gray: #f0efed;
    --color-ink: #2c2c2c;
    --color-ink-light: #6b6b6b;
    --color-ink-muted: #9a9a9a;
    --color-accent: #c9a962;

    display: flex;
    flex-direction: column;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    padding: 16px 16px 0 16px;
  }

  /* Reset link styles within widget */
  .weather-widget a,
  .weather-widget button,
  .weather-widget button * {
    text-decoration: none !important;
    border-bottom: none !important;
  }

  .weather-widget .tab,
  .weather-widget .tab * {
    text-decoration: none !important;
    border-bottom: none !important;
  }

  /* Tabs Wrapper - handles scrolling with padding for shadow */
  .tabs-wrapper {
    overflow-x: auto;
    overflow-y: visible;
    scrollbar-width: none;
    -ms-overflow-style: none;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior-x: contain;
    /* Padding for shadow, negative margin to compensate layout */
    padding: 12px 12px 0 12px;
    margin: -12px -12px 0 -12px;
  }

  .tabs-wrapper::-webkit-scrollbar {
    display: none;
  }

  /* Tabs Container - flex layout only, no overflow */
  .tabs {
    display: flex;
    gap: 0;
    scroll-snap-type: x proximity;
    cursor: grab;
    user-select: none;
  }

  .tabs:active {
    cursor: grabbing;
  }

  .tabs::-webkit-scrollbar {
    display: none;
  }

  /* Individual Tab */
  .tab {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 16px 20px;
    background: transparent;
    border: none;
    outline: none;
    border-radius: var(--widget-radius) var(--widget-radius) 0 0;
    cursor: pointer;
    transition: all 0.2s ease;
    scroll-snap-align: start;
  }

  .tab:focus,
  .tab:focus-visible {
    outline: none;
  }

  .tab:hover:not(.active) {
    background: var(--color-warm-gray);
  }

  .tab.active {
    position: relative;
    background: var(--color-warm-white);
    z-index: 10;
    border-radius: var(--widget-radius) var(--widget-radius) 0 0;
    box-shadow:
      0 -2px 8px rgba(0, 0, 0, 0.1),
      0 -1px 3px rgba(0, 0, 0, 0.06);
  }

  /* Connector element to hide seam between tab and panel */
  .tab.active::after {
    content: '';
    position: absolute;
    bottom: -7px;
    left: 0;
    right: 0;
    height: 9px;
    background: var(--color-warm-white);
    z-index: 11;
  }

  .tab-header {
    display: inline-flex;
    align-items: center;
    gap: 4px;
  }

  .tab-date {
    font-size: 12px;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--color-ink-muted);
  }

  .tab.active .tab-date {
    color: var(--color-ink-light);
  }

  .tab-icon {
    font-size: 36px;
    line-height: 1;
  }

  .tab-temps {
    display: flex;
    gap: 10px;
    font-size: 15px;
  }

  .high {
    color: rgba(120, 50, 48, 0.85);
  }

  .low {
    color: rgba(48, 72, 110, 0.85);
  }

  /* Event indicators */
  .tab-events {
    display: flex;
    gap: 2px;
    font-size: 12px;
  }

  .event-icon {
    cursor: default;
  }

  /* Panel */
  .panel {
    background: var(--color-warm-white);
    border-radius: var(--widget-radius);
    box-shadow:
      0 4px 20px rgba(0, 0, 0, 0.1),
      0 1px 4px rgba(0, 0, 0, 0.06);
    position: relative;
    z-index: 1;
    margin-top: -1px;
    margin-bottom: 20px;
    animation: panelIn 0.25s ease;
  }

  /* Panel Content Layout */
  .panel-content {
    display: flex;
    flex-direction: column;
  }

  .weather-column {
    flex: 1;
    min-width: 0;
  }

  .events-column {
    border-top: 1px solid var(--widget-border);
  }

  /* Cover bar at top of panel to hide shadow bleed */
  .panel::before {
    content: '';
    position: absolute;
    top: 0;
    left: var(--widget-radius);
    right: var(--widget-radius);
    height: 4px;
    background: var(--color-warm-white);
    z-index: 2;
  }

  @keyframes panelIn {
    from {
      opacity: 0;
      transform: translateY(-8px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .panel.first {
    border-top-left-radius: 0;
  }

  .panel.last {
    border-top-right-radius: 0;
  }

  /* Panel Header */
  .panel-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    padding: 20px 24px;
    border-bottom: 1px solid var(--widget-border);
  }

  .panel-title {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--color-ink);
    letter-spacing: -0.01em;
  }

  .panel-date {
    font-size: 15px;
    color: var(--color-ink-light);
    font-style: italic;
  }

  /* Panel Tabs */
  .panel-tabs {
    display: flex;
    gap: 16px;
  }

  .panel-tab {
    background: none;
    border: none;
    padding: 0;
    font-size: 16px;
    font-weight: 600;
    color: var(--color-ink-muted);
    cursor: pointer;
    transition: color 0.15s ease;
  }

  .panel-tab:hover {
    color: var(--color-ink-light);
  }

  .panel-tab.active {
    color: var(--color-ink);
  }

  /* Temperature Chart - Scrollable */
  .temperature-chart-scroll {
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    -ms-overflow-style: none;
    -webkit-overflow-scrolling: touch;
    overscroll-behavior-x: contain;
    padding: 10px 0 20px;
    cursor: grab;
    user-select: none;
  }

  .temperature-chart-scroll:active {
    cursor: grabbing;
  }

  .temperature-chart-scroll::-webkit-scrollbar {
    display: none;
  }

  .chart-svg {
    display: block;
  }

  .chart-icon {
    font-size: 16px;
  }

  .chart-temp-label {
    font-size: 11px;
    font-weight: 600;
    fill: var(--color-ink);
  }

  .chart-time-label {
    font-size: 10px;
    font-weight: 600;
    fill: var(--color-ink);
  }

  .chart-wind-label {
    font-size: 9px;
    fill: var(--color-ink-muted);
  }

  .chart-pop-label {
    font-size: 9px;
    fill: #5b8fd4;
    font-weight: 600;
  }

  .chart-separator-label {
    font-size: 8px;
    fill: var(--color-ink-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  /* Hourly Grid */
  .hourly-grid {
    display: flex;
    gap: 10px;
    padding: 20px 0 56px;
    padding-left: 14px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    -ms-overflow-style: none;
    -webkit-overflow-scrolling: touch;
    scroll-snap-type: x proximity;
    scroll-padding-left: 14px;
    overscroll-behavior-x: contain;
    cursor: grab;
    user-select: none;
  }

  .hourly-grid:active {
    cursor: grabbing;
  }

  .hourly-grid::-webkit-scrollbar {
    display: none;
  }

  /* Right spacer for scroll container */
  .hourly-grid::after {
    content: '';
    flex-shrink: 0;
    width: 24px;
  }

  .hour-card {
    flex-shrink: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    padding: 16px 18px;
    background: var(--color-warm-gray);
    border-radius: 10px;
    min-width: 85px;
    scroll-snap-align: start;
  }

  .hour-time {
    font-size: 14px;
    font-weight: 600;
    color: var(--color-ink);
  }

  .hour-icon {
    font-size: 32px;
    line-height: 1;
  }

  .hour-temp {
    font-size: 20px;
    font-weight: 600;
    color: var(--color-ink);
  }

  .hour-feels {
    font-size: 11px;
    color: var(--color-ink-muted);
  }

  /* Events Section */
  .events-list {
    display: grid;
    grid-template-columns: repeat(3, 1fr);
    gap: 10px;
    padding: 20px 24px 56px;
  }

  .event-card {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    background: var(--color-warm-gray);
    border-radius: 10px;
    text-decoration: none;
    color: inherit;
    transition: all 0.15s ease;
  }

  .event-card:hover {
    background: #e8e7e5;
    transform: translateX(2px);
  }

  .event-card-icon {
    font-size: 20px;
    flex-shrink: 0;
  }

  .event-details {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }

  .event-name {
    font-size: 14px;
    font-weight: 600;
    color: var(--color-ink);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .event-meta {
    font-size: 12px;
    color: var(--color-ink-muted);
  }

  .event-venue {
    color: var(--color-ink-light);
  }

  .event-arrow {
    font-size: 14px;
    color: var(--color-ink-muted);
    flex-shrink: 0;
    transition: transform 0.15s ease;
  }

  .event-card:hover .event-arrow {
    transform: translateX(2px);
    color: var(--color-ink-light);
  }

  /* Collapse Button */
  .collapse-btn {
    position: absolute;
    bottom: 16px;
    right: 20px;
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    background: var(--color-warm-gray);
    border: none;
    border-radius: 50%;
    color: var(--color-ink-light);
    cursor: pointer;
    transition: all 0.2s ease;
  }

  .collapse-btn:hover {
    background: var(--color-ink);
    color: var(--color-warm-white);
  }

  /* Responsive */
  @media (max-width: 640px) {
    .weather-widget {
      padding: 0;
      /* Break out of Container padding */
      margin-left: calc(-1 * var(--spacing-md, 16px));
      margin-right: calc(-1 * var(--spacing-md, 16px));
    }

    .tabs-wrapper {
      padding: 8px 0 0 8px;
      margin-top: -8px;
    }

    .tab {
      padding: 10px 12px;
    }

    .tab-icon {
      font-size: 24px;
    }

    .tab-temps {
      font-size: 12px;
    }

    .tab-events {
      font-size: 12px;
    }

    .panel {
      border-radius: 0;
      margin-left: 0;
      margin-right: 0;
    }

    .panel-header {
      flex-direction: column;
      gap: 4px;
      padding: 12px 12px;
    }

    .hourly-grid {
      flex-direction: column;
      overflow-x: visible;
      padding: 12px 12px 48px;
      gap: 8px;
    }

    .hourly-grid::after {
      display: none;
    }

    .hour-card {
      flex-direction: row;
      justify-content: space-between;
      min-width: unset;
      width: 100%;
      padding: 10px 14px;
    }

    .hour-time {
      order: 1;
      min-width: 50px;
    }

    .hour-icon {
      order: 2;
    }

    .hour-temp {
      order: 3;
      min-width: 45px;
      text-align: right;
    }

    .hour-feels {
      order: 4;
      min-width: 70px;
      text-align: right;
    }

    /* Chart on mobile */
    .temperature-chart-scroll {
      padding: 8px 0 16px;
    }

    /* Events on mobile */
    .events-list {
      grid-template-columns: 1fr;
      padding: 12px 12px 48px;
    }

    .event-card {
      padding: 10px 12px;
    }

    .event-name {
      font-size: 13px;
    }

    .event-meta {
      font-size: 11px;
    }
  }
</style>
