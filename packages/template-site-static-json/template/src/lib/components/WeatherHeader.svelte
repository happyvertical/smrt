<script lang="ts">
  // Local WeatherHeader shim — was previously imported from
  // `@happyvertical/smrt-svelte` but that package no longer ships the
  // component (it was removed before the 0.24.x baseline this template
  // pins). Inlining a minimal renderer here keeps the scaffold buildable
  // and gives consumers a starting point to customize.
  //
  // The shape of `forecast` follows what the caelus workflow writes into
  // the data layer; if your project pulls a different upstream, update
  // this component to match.
  type Forecast = {
    location?: string;
    summary?: string;
    temperatureC?: number;
    temperatureF?: number;
    iconUrl?: string;
  } | null | undefined;

  let { forecast }: { forecast: Forecast } = $props();
</script>

{#if forecast}
  <div class="weather-header" aria-label="Current weather">
    {#if forecast.iconUrl}
      <img src={forecast.iconUrl} alt="" class="icon" />
    {/if}
    {#if forecast.location}
      <span class="location">{forecast.location}</span>
    {/if}
    {#if forecast.summary}
      <span class="summary">{forecast.summary}</span>
    {/if}
    {#if typeof forecast.temperatureC === 'number'}
      <span class="temp">{forecast.temperatureC.toFixed(0)}°C</span>
    {:else if typeof forecast.temperatureF === 'number'}
      <span class="temp">{forecast.temperatureF.toFixed(0)}°F</span>
    {/if}
  </div>
{/if}

<style>
  .weather-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.25rem 0;
    font-size: 0.875rem;
    color: var(--color-neutral-gray700, #4b5563);
  }
  .icon {
    width: 1.5rem;
    height: 1.5rem;
  }
  .location,
  .summary,
  .temp {
    line-height: 1.2;
  }
</style>
