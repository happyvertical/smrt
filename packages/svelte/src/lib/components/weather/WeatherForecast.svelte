<script lang="ts">
export interface ForecastPeriod {
  name: string;
  conditions: string;
  temperature: number;
  windSpeed: number;
  windDirection: number;
  humidity: number;
  precipProbability: number;
}

export interface ForecastDay {
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

// Find today's index by matching the current day name
const today = new Date().toLocaleDateString('en-US', { weekday: 'short' });
const todayIndex = forecast?.findIndex((f) => f.day === today) ?? 0;

let expandedDay = $state<number | null>(todayIndex >= 0 ? todayIndex : 0);
let _activeTab = $state<'day' | 'night' | 'chart'>('day');

function _toggleDay(index: number) {
  if (expandedDay === index) {
    expandedDay = null;
  } else {
    expandedDay = index;
    _activeTab = 'day'; // Reset to day tab when opening a new day
  }
}

function _getDayPeriod(periods: ForecastPeriod[]): ForecastPeriod | null {
  return (
    periods.find((p) => !p.name.toLowerCase().includes('night')) ||
    periods[0] ||
    null
  );
}

function _getNightPeriod(periods: ForecastPeriod[]): ForecastPeriod | null {
  return periods.find((p) => p.name.toLowerCase().includes('night')) || null;
}

function _getWindDirection(degrees: number): string {
  const directions = ['N', 'NE', 'E', 'SE', 'S', 'SW', 'W', 'NW'];
  return directions[Math.round(degrees / 45) % 8];
}

function _getTemperatureChartPath(periods: ForecastPeriod[]): {
  path: string;
  points: { x: number; y: number; temp: number; label: string }[];
  minTemp: number;
  maxTemp: number;
} {
  if (periods.length === 0)
    return { path: '', points: [], minTemp: 0, maxTemp: 0 };

  const temps = periods.map((p) => p.temperature).filter((t) => t !== 0);
  if (temps.length === 0)
    return { path: '', points: [], minTemp: 0, maxTemp: 0 };

  const minTemp = Math.min(...temps);
  const maxTemp = Math.max(...temps);
  const range = maxTemp - minTemp || 10;

  const width = 250;
  const height = 60;
  const padding = 15;

  const points = periods.map((period, i) => {
    const x =
      padding + (i / Math.max(periods.length - 1, 1)) * (width - padding * 2);
    const y =
      padding +
      ((maxTemp - period.temperature) / range) * (height - padding * 2);

    // Extract time from period name (e.g., "Early morning (00:00)" -> "12a")
    const timeMatch = period.name.match(/\((\d+):(\d+)\)/);
    let label = '';
    if (timeMatch) {
      const hour = parseInt(timeMatch[1], 10);
      const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
      const ampm = hour < 12 ? 'a' : 'p';
      label = `${displayHour}${ampm}`;
    } else {
      label = period.name.replace(' for Bentley', '').split(' ')[0];
    }

    return {
      x,
      y: period.temperature === 0 ? height / 2 : y,
      temp: period.temperature,
      label,
    };
  });

  const path = points
    .map((point, i) => `${i === 0 ? 'M' : 'L'} ${point.x} ${point.y}`)
    .join(' ');

  return { path, points, minTemp, maxTemp };
}
</script>

<div class="weather-forecast">
  {#if forecast}
    {#each forecast as day, index}
      <div class="forecast-day" class:expanded={expandedDay === index}>
        <button
          class="day-summary"
          onclick={() => toggleDay(index)}
          aria-expanded={expandedDay === index}
        >
          <div class="day-name">{day.day}</div>
          <div class="icon">{day.icon}</div>
          <div class="temps">
            <span class="high">{day.high}°</span>
            <span class="low">{day.low}°</span>
          </div>
        </button>

        {#if expandedDay === index}
          {@const chartData = getTemperatureChartPath(day.periods)}
          {@const dayPeriod = getDayPeriod(day.periods)}
          {@const nightPeriod = getNightPeriod(day.periods)}
          <div class="day-details">
            <!-- Fixed tabs -->
            <div class="tabs">
              <button
                class="tab"
                class:active={activeTab === 'day'}
                onclick={() => activeTab = 'day'}
              >
                Day
              </button>
              {#if nightPeriod}
                <button
                  class="tab"
                  class:active={activeTab === 'night'}
                  onclick={() => activeTab = 'night'}
                >
                  Night
                </button>
              {/if}
              <button
                class="tab"
                class:active={activeTab === 'chart'}
                onclick={() => activeTab = 'chart'}
              >
                Chart
              </button>
            </div>

            <div class="tab-content">
              <!-- Day tab content -->
              {#if activeTab === 'day' && dayPeriod}
                <div class="period-detail">
                  <div class="period-detail-conditions">{dayPeriod.conditions}</div>
                  <div class="period-detail-stats-inline">
                    {#if dayPeriod.temperature}
                      <span>{dayPeriod.temperature}°C</span>
                    {/if}
                    {#if dayPeriod.windSpeed}
                      <span>{dayPeriod.windSpeed} km/h {getWindDirection(dayPeriod.windDirection)}</span>
                    {/if}
                    {#if dayPeriod.humidity}
                      <span>{dayPeriod.humidity}% humidity</span>
                    {/if}
                  </div>
                </div>
              {/if}

              <!-- Night tab content -->
              {#if activeTab === 'night' && nightPeriod}
                <div class="period-detail">
                  <div class="period-detail-conditions">{nightPeriod.conditions}</div>
                  <div class="period-detail-stats-inline">
                    {#if nightPeriod.temperature}
                      <span>{nightPeriod.temperature}°C</span>
                    {/if}
                    {#if nightPeriod.windSpeed}
                      <span>{nightPeriod.windSpeed} km/h {getWindDirection(nightPeriod.windDirection)}</span>
                    {/if}
                    {#if nightPeriod.humidity}
                      <span>{nightPeriod.humidity}% humidity</span>
                    {/if}
                  </div>
                </div>
              {/if}

              <!-- Chart tab content -->
              {#if activeTab === 'chart'}
                <div class="temperature-chart">
                  <svg viewBox="0 0 250 60" class="chart-svg">
                    <!-- Temperature line -->
                    <path
                      d={chartData.path}
                      fill="none"
                      stroke="var(--color-primary, #2563eb)"
                      stroke-width="2"
                      stroke-linecap="round"
                      stroke-linejoin="round"
                    />
                    <!-- Data points -->
                    {#each chartData.points as point}
                      <circle
                        cx={point.x}
                        cy={point.y}
                        r="3"
                        fill="var(--color-primary, #2563eb)"
                      />
                      <!-- Temperature labels -->
                      {#if point.temp !== 0}
                        <text
                          x={point.x}
                          y={point.y - 8}
                          text-anchor="middle"
                          class="temp-label"
                        >
                          {point.temp}°
                        </text>
                      {/if}
                      <!-- Period labels -->
                      <text
                        x={point.x}
                        y="56"
                        text-anchor="middle"
                        class="period-label"
                      >
                        {point.label}
                      </text>
                    {/each}
                  </svg>
                </div>
              {/if}
            </div>
          </div>
        {/if}
      </div>
    {/each}
  {/if}
</div>

<style>
  .weather-forecast {
    display: flex;
    gap: var(--spacing-xl);
    padding: var(--spacing-lg) 0;
    border-bottom: 1px solid var(--color-neutral-gray300);
    justify-content: flex-end;
    overflow-x: auto;
  }

  .forecast-day {
    display: flex;
    flex-direction: row;
    align-items: center;
    min-width: 60px;
    transition: all 0.3s ease;
    gap: var(--spacing-md);
  }

  .forecast-day.expanded {
    min-width: 500px;
  }

  .day-summary {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--spacing-xs);
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    transition: transform 0.2s ease;
    flex-shrink: 0;
  }

  .day-summary:hover {
    transform: scale(1.05);
  }

  .day-name {
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
    color: var(--color-text-secondary);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .icon {
    font-size: 2rem;
    line-height: 1;
  }

  .temps {
    display: flex;
    gap: var(--spacing-sm);
    font-size: var(--font-size-sm);
  }

  .high {
    color: var(--color-text-primary);
    font-weight: var(--font-weight-semibold);
  }

  .low {
    color: var(--color-text-secondary);
  }

  .day-details {
    display: flex;
    flex-direction: column;
    padding: var(--spacing-xs);
    background: var(--color-neutral-gray100);
    border-radius: var(--border-radius-md);
    overflow: hidden;
    animation: slideIn 0.3s ease;
    flex: 1;
    align-self: center;
    max-height: 120px;
    min-width: 150px;
  }

  .temperature-chart {
    padding: var(--spacing-xs);
    background: var(--color-neutral-white);
    border-radius: var(--border-radius-sm);
    width: 250px;
    flex-shrink: 0;
  }

  .chart-svg {
    width: 100%;
    height: auto;
  }

  .temp-label {
    font-size: 12px;
    font-weight: var(--font-weight-semibold);
    fill: var(--color-neutral-gray400, #9ca3af);
  }

  .temp-label.active {
    fill: var(--color-text-primary);
  }

  .period-label {
    font-size: 10px;
    fill: var(--color-neutral-gray400, #9ca3af);
  }

  .period-label.active {
    fill: var(--color-text-secondary);
    font-weight: var(--font-weight-semibold);
  }

  .tabs {
    display: flex;
    gap: var(--spacing-sm);
    margin-bottom: var(--spacing-sm);
  }

  .tab {
    background: none;
    border: none;
    padding: 0;
    cursor: pointer;
    font-size: var(--font-size-xs);
    font-weight: var(--font-weight-normal);
    color: var(--color-text-secondary);
    text-decoration: none;
    transition: color 0.2s ease;
  }

  .tab:hover {
    color: var(--color-text-primary);
    text-decoration: underline;
  }

  .tab.active {
    color: var(--color-text-primary);
    font-weight: var(--font-weight-semibold);
    text-decoration: underline;
  }

  .tab-content {
    max-height: 160px;
    overflow-y: auto;
  }

  @keyframes slideIn {
    from {
      opacity: 0;
      max-width: 0;
      padding-left: 0;
      padding-right: 0;
    }
    to {
      opacity: 1;
      max-width: 500px;
      padding-left: var(--spacing-sm);
      padding-right: var(--spacing-sm);
    }
  }

  .stat {
    display: flex;
    justify-content: space-between;
    gap: var(--spacing-sm);
  }

  .stat .label {
    color: var(--color-text-secondary);
  }

  .stat .value {
    color: var(--color-text-primary);
    font-weight: var(--font-weight-medium);
  }

  .period-detail {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xs);
    padding: var(--spacing-sm);
    background: var(--color-neutral-white);
    border-radius: var(--border-radius-sm);
  }

  .period-detail-name {
    font-size: var(--font-size-md);
    font-weight: var(--font-weight-semibold);
    color: var(--color-text-primary);
  }

  .period-detail-conditions {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
    line-height: 1.5;
  }

  .period-detail-stats {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-xs);
    font-size: var(--font-size-sm);
    margin-top: var(--spacing-xs);
  }

  .period-detail-stats-inline {
    display: flex;
    gap: var(--spacing-md);
    font-size: var(--font-size-sm);
    color: var(--color-text-primary);
  }

  .period-detail-stats-inline span {
    white-space: nowrap;
  }

  @media (max-width: 768px) {
    .weather-forecast {
      gap: var(--spacing-md);
      justify-content: flex-start;
      padding: var(--spacing-md) var(--spacing-sm);
    }

    .forecast-day {
      min-width: 50px;
    }

    .forecast-day.expanded {
      min-width: 300px;
    }

    .icon {
      font-size: 1.5rem;
    }

    .day-details {
      padding: var(--spacing-sm);
    }
  }
</style>
