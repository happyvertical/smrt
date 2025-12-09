<script lang="ts">
/**
 * WeatherHeader Component
 * Editorial-style weather forecast with tab navigation
 */

export interface HourlyForecast {
  time: string;
  hour: number;
  icon: string;
  temperature: number;
  feelsLike: number;
}

export interface DayForecast {
  id: string;
  dayName: string;
  date: string;
  icon: string;
  high: number;
  low: number;
  hourlyData: HourlyForecast[];
}

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
}

const { forecast }: Props = $props();

let selectedDayIndex = $state<number | null>(null);

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
    : getMockData(),
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
      };
    })
    .filter((item) => (dayIndex === 0 ? item.hour >= currentHour : true));
}

function getHourlyIcon(conditions: string): string {
  const c = conditions.toLowerCase();
  if (c.includes('sunny') || c.includes('clear')) return '☀️';
  if (c.includes('partly cloudy')) return '⛅';
  if (c.includes('cloud')) return '☁️';
  if (c.includes('rain')) return '🌧️';
  if (c.includes('snow')) return '❄️';
  if (c.includes('thunder')) return '⛈️';
  return '🌤️';
}

function getMockData(): DayForecast[] {
  const today = new Date();
  const icons = ['☀️', '⛅', '☁️', '🌧️', '⛅', '☀️', '⛈️', '❄️', '🌤️', '☁️'];

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
  selectedDayIndex = selectedDayIndex === index ? null : index;
}

function handleCollapse() {
  selectedDayIndex = null;
}

const selectedDay = $derived(
  selectedDayIndex !== null ? dayForecasts[selectedDayIndex] : null,
);

const selectedFullDate = $derived(
  selectedDayIndex !== null
    ? formatFullDate(getDateFromOffset(selectedDayIndex))
    : '',
);

const isFirst = $derived(selectedDayIndex === 0);
const isLast = $derived(selectedDayIndex === dayForecasts.length - 1);

// Drag-to-scroll for hourly grid
// biome-ignore lint/style/useConst: bind:this requires let, not const
let hourlyGridEl = $state<HTMLElement | null>(null);
let isDragging = $state(false);
let startX = $state(0);
let scrollLeft = $state(0);

// Document-level mouseup listener to handle drag release outside the element
$effect(() => {
  function handleDocumentMouseUp() {
    if (isDragging) {
      isDragging = false;
      if (hourlyGridEl) hourlyGridEl.style.cursor = 'grab';
    }
  }
  document.addEventListener('mouseup', handleDocumentMouseUp);
  return () => document.removeEventListener('mouseup', handleDocumentMouseUp);
});

function handleMouseDown(e: MouseEvent) {
  if (!hourlyGridEl) return;
  isDragging = true;
  hourlyGridEl.style.cursor = 'grabbing';
  startX = e.pageX - hourlyGridEl.offsetLeft;
  scrollLeft = hourlyGridEl.scrollLeft;
}

function handleMouseMove(e: MouseEvent) {
  if (!isDragging || !hourlyGridEl) return;
  e.preventDefault();
  const x = e.pageX - hourlyGridEl.offsetLeft;
  const walk = (x - startX) * 1.5;
  hourlyGridEl.scrollLeft = scrollLeft - walk;
}

function handleMouseUp() {
  isDragging = false;
  if (hourlyGridEl) hourlyGridEl.style.cursor = 'grab';
}

function handleMouseLeave() {
  isDragging = false;
  if (hourlyGridEl) hourlyGridEl.style.cursor = 'grab';
}

// Keyboard navigation for accessibility
function handleKeyDown(e: KeyboardEvent) {
  if (!hourlyGridEl) return;
  const scrollAmount = 100;
  if (e.key === 'ArrowLeft') {
    e.preventDefault();
    hourlyGridEl.scrollBy({ left: -scrollAmount, behavior: 'smooth' });
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    hourlyGridEl.scrollBy({ left: scrollAmount, behavior: 'smooth' });
  }
}
</script>

<div class="weather-widget">
  <div class="tabs">
    {#each dayForecasts as day, index}
      <button
        class="tab"
        class:active={selectedDayIndex === index}
        onclick={() => handleTabClick(index)}
        aria-expanded={selectedDayIndex === index}
      >
        <span class="tab-date">{day.date}</span>
        <span class="tab-icon">{day.icon}</span>
        <span class="tab-temps">
          <span class="high">{day.high}°</span>
          <span class="low">{day.low}°</span>
        </span>
      </button>
    {/each}
  </div>

  {#if selectedDay}
    <div class="panel" class:first={isFirst} class:last={isLast}>
      <header class="panel-header">
        <h3 class="panel-title">Hourly Forecast</h3>
        <span class="panel-date">{selectedFullDate}</span>
      </header>

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

      <button class="collapse-btn" onclick={handleCollapse} aria-label="Collapse">
        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
          <path d="M5 12L10 7L15 12" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>
        </svg>
      </button>
    </div>
  {/if}
</div>

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

  /* Tabs Container */
  .tabs {
    display: flex;
    gap: 0;
    overflow: visible;
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
      0 -4px 16px rgba(0, 0, 0, 0.12),
      0 -1px 4px rgba(0, 0, 0, 0.08);
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
    font-weight: 600;
    color: var(--color-ink);
  }

  .low {
    color: var(--color-ink-muted);
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
    margin-top: 2px;
    margin-bottom: 20px;
    animation: panelIn 0.25s ease;
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

  /* Hourly Grid */
  .hourly-grid {
    display: flex;
    gap: 10px;
    padding: 20px 0 56px;
    overflow-x: auto;
    overflow-y: hidden;
    scrollbar-width: none;
    -ms-overflow-style: none;
    -webkit-overflow-scrolling: touch;
    scroll-snap-type: x proximity;
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

  /* Spacers for consistent left/right padding in scroll container */
  .hourly-grid::before,
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
    .tab {
      padding: 10px 12px;
    }

    .tab-icon {
      font-size: 24px;
    }

    .tab-temps {
      font-size: 12px;
    }

    .panel-header {
      flex-direction: column;
      gap: 4px;
      padding: 12px 16px;
    }

    .hourly-grid {
      padding: 12px 0;
    }

    .hourly-grid::before,
    .hourly-grid::after {
      width: 16px;
    }

    .hour-card {
      min-width: 64px;
      padding: 10px 12px;
    }
  }
</style>
