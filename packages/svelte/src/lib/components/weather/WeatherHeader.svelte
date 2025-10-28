<script lang="ts">
/**
 * Alternative Weather Forecast Component
 * Displays multi-day forecast with slide-down hourly details panel
 */

export interface HourlyForecast {
  time: string; // "9a", "12p", "3p"
  hour: number; // 24-hour format (0-23) for filtering
  icon: string; // Weather emoji
  temperature: number;
  feelsLike: number;
}

export interface DayForecast {
  id: string; // Unique identifier
  dayName: string; // "Mon", "Tue"
  date: string; // "27 Oct"
  icon: string; // Weather emoji
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
  localHour: number; // 0-23 hour in America/Edmonton timezone
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

// State management
let selectedDayIndex = $state<number | null>(null);

// Transform data or use mock data
const dayForecasts: DayForecast[] = $derived(
  forecast && forecast.length > 0
    ? forecast.map((day, index) => {
        const date = getDateFromDayName(day.day, index);
        return {
          id: `day-${index}`,
          dayName: day.day,
          date: formatDate(date, day.day),
          icon: day.icon,
          high: day.high,
          low: day.low,
          hourlyData: transformHourlyData(day.periods, index),
        };
      })
    : getMockData(),
);

// Get date from day name (approximation for current week)
function getDateFromDayName(_dayName: string, offset: number): Date {
  const today = new Date();
  today.setDate(today.getDate() + offset);
  return today;
}

// Format date as "Sat 27 Oct"
function formatDate(date: Date, dayName: string): string {
  const day = date.getDate();
  const month = date.toLocaleDateString('en-US', { month: 'short' });
  return `${dayName} ${day} ${month}`;
}

// Transform periods to hourly data
function transformHourlyData(
  periods: ForecastPeriod[],
  dayIndex: number,
): HourlyForecast[] {
  const now = new Date();
  const currentHour = now.getHours();

  return periods
    .map((period) => {
      // Use the localHour from the period (calculated on server from actual timestamp)
      const hour = period.localHour;
      const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
      const ampm = hour < 12 ? 'a' : 'p';
      const time = `${displayHour}${ampm}`;

      return {
        time,
        hour,
        icon: getHourlyIcon(period.conditions),
        temperature: period.temperature,
        feelsLike: period.temperature - 2,
      };
    })
    .filter((item) => {
      // For current day (index 0), start from current hour
      if (dayIndex === 0) {
        return item.hour >= currentHour;
      }
      // For other days, show full day (12a-11p) - no hours from next day
      return true;
    });
}

// Get icon for hourly forecast
function getHourlyIcon(conditions: string): string {
  const conditionsLower = conditions.toLowerCase();
  if (conditionsLower.includes('sunny') || conditionsLower.includes('clear'))
    return '☀️';
  if (conditionsLower.includes('partly cloudy')) return '⛅';
  if (conditionsLower.includes('cloud')) return '☁️';
  if (conditionsLower.includes('rain')) return '🌧️';
  if (conditionsLower.includes('snow')) return '❄️';
  if (conditionsLower.includes('thunder')) return '⛈️';
  return '🌤️';
}

// Mock data for demonstration
function getMockData(): DayForecast[] {
  const today = new Date();
  const icons = ['☀️', '⛅', '☁️', '🌧️', '⛅', '☀️', '⛈️', '❄️', '🌤️', '☁️'];
  const numDays = 10; // Show 10 days of forecast

  return Array.from({ length: numDays }, (_, index) => {
    const date = new Date(today);
    date.setDate(today.getDate() + index);
    const dayName = date.toLocaleDateString('en-US', { weekday: 'short' });

    // Generate hourly data for each day
    const hourlyData: HourlyForecast[] = [];
    for (let hour = 0; hour < 24; hour += 3) {
      const displayHour = hour === 0 ? 12 : hour > 12 ? hour - 12 : hour;
      const ampm = hour < 12 ? 'a' : 'p';
      hourlyData.push({
        time: `${displayHour}${ampm}`,
        hour,
        icon: icons[Math.floor(Math.random() * icons.length)],
        temperature: Math.round(15 + Math.random() * 10),
        feelsLike: Math.round(13 + Math.random() * 10),
      });
    }

    return {
      id: `day-${index}`,
      dayName,
      date: formatDate(date, dayName),
      icon: icons[index % icons.length],
      high: Math.round(20 + Math.random() * 5),
      low: Math.round(10 + Math.random() * 5),
      hourlyData,
    };
  });
}

// Handle day card click
function handleDayClick(index: number) {
  if (selectedDayIndex === index) {
    // Toggle off if clicking the same day
    selectedDayIndex = null;
  } else {
    // Select new day
    selectedDayIndex = index;
  }
}

// Handle close button click
function handleClose() {
  selectedDayIndex = null;
}

// Get selected day's hourly data
const selectedDayHourly = $derived(
  selectedDayIndex !== null ? dayForecasts[selectedDayIndex].hourlyData : [],
);

// Scroll container reference and state
// biome-ignore lint/style/useConst: Svelte bind:this requires let, not const
let hourlyScrollContainer: HTMLElement | null = $state(null);
let canScrollLeft = $state(false);
let canScrollRight = $state(false);

// Update scroll button visibility
function updateScrollButtons() {
  if (!hourlyScrollContainer) return;

  const { scrollLeft, scrollWidth, clientWidth } = hourlyScrollContainer;

  canScrollLeft = scrollLeft > 5; // 5px threshold
  canScrollRight = scrollLeft < scrollWidth - clientWidth - 5; // 5px threshold
}

// Scroll left
function scrollLeft() {
  if (!hourlyScrollContainer) return;
  hourlyScrollContainer.scrollBy({ left: -300, behavior: 'smooth' });
  setTimeout(updateScrollButtons, 350);
}

// Scroll right
function scrollRight() {
  if (!hourlyScrollContainer) return;
  hourlyScrollContainer.scrollBy({ left: 300, behavior: 'smooth' });
  setTimeout(updateScrollButtons, 350);
}

// Set up scroll listener when container is available or content changes
$effect(() => {
  if (hourlyScrollContainer && selectedDayIndex !== null) {
    // For future days (not today), scroll to 4am by default
    if (selectedDayIndex > 0) {
      setTimeout(() => {
        // Find the hourly item with "4a" time
        const hourlyItems =
          hourlyScrollContainer?.querySelectorAll('.hourly-item');
        if (hourlyItems) {
          for (const item of hourlyItems) {
            const timeElement = item.querySelector('.hourly-time');
            if (timeElement?.textContent === '4a') {
              item.scrollIntoView({
                behavior: 'smooth',
                inline: 'start',
                block: 'nearest',
              });
              break;
            }
          }
        }
        updateScrollButtons();
      }, 100);
    } else {
      // For today, just update buttons
      setTimeout(updateScrollButtons, 50);
    }

    hourlyScrollContainer.addEventListener('scroll', updateScrollButtons);

    return () => {
      hourlyScrollContainer?.removeEventListener('scroll', updateScrollButtons);
    };
  } else {
    // Reset scroll state when panel closes
    canScrollLeft = false;
    canScrollRight = false;
  }
});
</script>

<div class="weather-forecast-alt">
  <!-- Day Cards -->
  <div class="day-cards">
    {#each dayForecasts as day, index}
      <button
        class="day-card"
        class:active={selectedDayIndex === index}
        onclick={() => handleDayClick(index)}
        aria-expanded={selectedDayIndex === index}
        aria-controls="hourly-panel"
      >
        <div class="date">{day.date}</div>
        <div class="icon">{day.icon}</div>
        <div class="temps">
          <span class="high">{day.high}°</span>
          <span class="low">{day.low}°</span>
        </div>
      </button>
    {/each}
  </div>

  <!-- Hourly Details Panel -->
  <div
    class="hourly-panel"
    class:open={selectedDayIndex !== null}
    id="hourly-panel"
    role="region"
    aria-label="Hourly forecast details"
  >
    <div class="hourly-panel-header">
      <h3 class="hourly-title">
        {selectedDayIndex !== null ? `${dayForecasts[selectedDayIndex].dayName} Hourly Forecast` : ''}
      </h3>
      <button class="close-button" onclick={handleClose} aria-label="Close hourly forecast">
        ✕
      </button>
    </div>

    <div class="hourly-scroll-wrapper">
      {#if selectedDayHourly.length > 0 && canScrollLeft}
        <button
          class="scroll-arrow scroll-arrow-left"
          onclick={scrollLeft}
          aria-label="Scroll left"
        >
          ‹
        </button>
      {/if}

      <div class="hourly-scroll" bind:this={hourlyScrollContainer}>
        {#if selectedDayHourly.length > 0}
          {#each selectedDayHourly as hourly}
            <div class="hourly-item">
              <div class="hourly-time">{hourly.time}</div>
              <div class="hourly-icon">{hourly.icon}</div>
              <div class="hourly-temp">{hourly.temperature}°</div>
              <div class="hourly-feels-like">Feels {hourly.feelsLike}°</div>
            </div>
          {/each}
        {:else}
          <div class="no-data-message">
            No hourly data available for this day
          </div>
        {/if}
      </div>

      {#if selectedDayHourly.length > 0 && canScrollRight}
        <button
          class="scroll-arrow scroll-arrow-right"
          onclick={scrollRight}
          aria-label="Scroll right"
        >
          ›
        </button>
      {/if}
    </div>
  </div>
</div>

<style>
  .weather-forecast-alt {
    width: 100%;
  }

  /* Day Cards */
  .day-cards {
    display: flex;
    gap: var(--spacing-xl);
    padding: var(--spacing-lg) 0;
    border-bottom: 1px solid var(--color-neutral-gray300);
    justify-content: flex-start;
    overflow-x: auto;
    scroll-behavior: smooth;
  }

  .day-cards::-webkit-scrollbar {
    height: 6px;
  }

  .day-cards::-webkit-scrollbar-track {
    background: var(--color-neutral-gray200);
    border-radius: var(--border-radius-sm);
  }

  .day-cards::-webkit-scrollbar-thumb {
    background: var(--color-neutral-gray400);
    border-radius: var(--border-radius-sm);
  }

  .day-cards::-webkit-scrollbar-thumb:hover {
    background: var(--color-neutral-gray500);
  }

  .day-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--spacing-xs);
    padding: 0;
    background: none;
    border: none;
    cursor: pointer;
    transition: transform 200ms ease;
    min-width: 60px;
    flex-shrink: 0;
  }

  .day-card:hover {
    transform: scale(1.05);
  }

  .day-card.active {
    opacity: 0.7;
  }

  .date {
    font-size: var(--font-size-sm);
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

  /* Hourly Panel */
  .hourly-panel {
    max-height: 0;
    overflow: hidden;
    opacity: 0;
    transition: max-height 300ms ease, opacity 300ms ease;
    background: var(--color-neutral-gray100);
    border-top: 1px solid var(--color-neutral-gray300);
  }

  .hourly-panel.open {
    max-height: 280px;
    height: 280px;
    opacity: 1;
  }

  .hourly-panel-header {
    display: flex;
    justify-content: space-between;
    align-items: center;
    padding: var(--spacing-md) var(--spacing-lg);
    border-bottom: 1px solid var(--color-neutral-gray300);
  }

  .hourly-title {
    margin: 0;
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-semibold);
    color: var(--color-text-primary);
  }

  .close-button {
    background: none;
    border: none;
    font-size: var(--font-size-xl);
    color: var(--color-text-secondary);
    cursor: pointer;
    padding: var(--spacing-xs);
    line-height: 1;
    transition: color 200ms ease;
  }

  .close-button:hover {
    color: var(--color-text-primary);
  }

  /* Hourly Scroll Wrapper & Arrows */
  .hourly-scroll-wrapper {
    position: relative;
    display: flex;
    align-items: center;
  }

  .scroll-arrow {
    position: absolute;
    top: 50%;
    transform: translateY(-50%);
    z-index: 10;
    background: var(--color-neutral-white);
    border: 1px solid var(--color-neutral-gray300);
    border-radius: 50%;
    width: 36px;
    height: 36px;
    display: flex;
    align-items: center;
    justify-content: center;
    cursor: pointer;
    font-size: 24px;
    color: var(--color-text-primary);
    box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
    transition: all 200ms ease;
  }

  .scroll-arrow:hover {
    background: var(--color-neutral-gray100);
    box-shadow: 0 4px 8px rgba(0, 0, 0, 0.15);
  }

  .scroll-arrow-left {
    left: var(--spacing-md);
  }

  .scroll-arrow-right {
    right: var(--spacing-md);
  }

  /* Hourly Scroll Container */
  .hourly-scroll {
    display: flex;
    gap: var(--spacing-lg);
    padding: var(--spacing-lg);
    overflow-x: auto;
    scroll-behavior: smooth;
    flex: 1;
    /* Hide scrollbar but keep scroll functionality */
    scrollbar-width: none; /* Firefox */
    -ms-overflow-style: none; /* IE and Edge */
  }

  /* Hide scrollbar for Chrome, Safari, and Opera */
  .hourly-scroll::-webkit-scrollbar {
    display: none;
  }

  /* Hourly Items */
  .hourly-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--spacing-xs);
    padding: var(--spacing-md);
    background: var(--color-neutral-white);
    border-radius: var(--border-radius-md);
    min-width: 80px;
    flex-shrink: 0;
  }

  .hourly-time {
    font-size: var(--font-size-sm);
    font-weight: var(--font-weight-semibold);
    color: var(--color-text-primary);
  }

  .hourly-icon {
    font-size: 2rem;
    line-height: 1;
  }

  .hourly-temp {
    font-size: var(--font-size-lg);
    font-weight: var(--font-weight-semibold);
    color: var(--color-text-primary);
  }

  .hourly-feels-like {
    font-size: var(--font-size-xs);
    color: var(--color-text-secondary);
  }

  .no-data-message {
    display: flex;
    align-items: center;
    justify-content: center;
    padding: var(--spacing-xl);
    color: var(--color-text-secondary);
    font-size: var(--font-size-md);
    text-align: center;
    min-height: 180px;
  }

  /* Responsive Design */
  @media (max-width: 768px) {
    .day-cards {
      gap: var(--spacing-md);
      padding: var(--spacing-md) 0;
    }

    .day-card {
      min-width: 50px;
    }

    .icon {
      font-size: 1.5rem;
    }

    .hourly-panel.open {
      max-height: 250px;
      height: 250px;
    }

    .hourly-scroll {
      gap: var(--spacing-md);
      padding: var(--spacing-md);
    }

    .hourly-item {
      min-width: 70px;
      padding: var(--spacing-sm);
    }

    .hourly-icon {
      font-size: 1.5rem;
    }
  }
</style>
