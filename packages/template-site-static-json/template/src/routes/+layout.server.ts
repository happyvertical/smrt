// Enable prerendering for static site generation
export const prerender = true;

// Use trailing slashes for clean URLs
export const trailingSlash = 'always';

import type { LayoutServerLoad } from './$types';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { initSiteConfig } from '../site.config';

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

function getWeatherIcon(conditions: string): string {
  const conditionsLower = conditions.toLowerCase();

  if (conditionsLower.includes('sunny') || conditionsLower.includes('clear')) return '☀️';
  if (conditionsLower.includes('partly cloudy') || conditionsLower.includes('a few clouds')) return '⛅';
  if (conditionsLower.includes('cloud')) return '☁️';
  if (conditionsLower.includes('rain') || conditionsLower.includes('shower')) return '🌧️';
  if (conditionsLower.includes('snow')) return '❄️';
  if (conditionsLower.includes('thunder') || conditionsLower.includes('storm')) return '⛈️';
  if (conditionsLower.includes('fog')) return '🌫️';

  return '🌤️';
}

interface WeatherForecastData {
  id?: string;
  name: string;
  issued_at: string;
  conditions: string;
  temperature?: string | number;
  temperature_high?: string | number;
  temperature_low?: string | number;
  wind_speed?: string | number;
  wind_direction?: string | number;
  humidity?: string | number;
  precipitation_probability?: string | number;
}

export const load: LayoutServerLoad = async () => {
  // Load site config
  const siteConfig = await initSiteConfig();

  // Load weather data
  let weather: ForecastDay[] | null = null;

  try {
    const eventsPath = join(process.cwd(), 'data', 'events.json');
    const eventsRaw = await readFile(eventsPath, 'utf-8');
    const allEvents = JSON.parse(eventsRaw);

    const allForecasts: WeatherForecastData[] = allEvents
      .filter((e: any) => e._meta_type === 'WeatherForecast')
      .map((e: any) => {
        const meta = typeof e._meta_data === 'string' ? JSON.parse(e._meta_data) : e._meta_data;
        return {
          id: e.id,
          name: e.name,
          issued_at: meta?.issuedAt || e.created_at,
          conditions: meta?.conditions || '',
          temperature: meta?.temperature,
          temperature_high: meta?.temperatureHigh,
          temperature_low: meta?.temperatureLow,
          wind_speed: meta?.windSpeed,
          wind_direction: meta?.windDirection,
          humidity: meta?.humidity,
          precipitation_probability: meta?.precipProbability,
        };
      });

    allForecasts.sort((a, b) => new Date(a.issued_at).getTime() - new Date(b.issued_at).getTime());

    if (allForecasts.length > 0) {
      const hourlyForecastsRaw = allForecasts.filter((f) => f.name.includes('(') && f.name.includes(')'));

      const dailyForecasts = new Map<
        string,
        {
          high: number;
          low: number;
          conditions: string;
          date: Date;
          dayName: string;
          periods: ForecastPeriod[];
          temps: number[];
        }
      >();

      const now = new Date();
      const timezone = siteConfig.location.timezone || 'America/Edmonton';
      const todayInTimezone = new Date(now.toLocaleString('en-US', { timeZone: timezone }));

      for (const forecast of hourlyForecastsRaw) {
        const timeMatch = forecast.name.match(/\((\d+):(\d+)\)/);
        if (!timeMatch) continue;

        const hour = parseInt(timeMatch[1]!);
        const localHour = hour;

        const fullDayName = forecast.name.split(' ')[0]!;
        const dayName = fullDayName.substring(0, 3);

        const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
        const forecastDayOfWeek = dayNames.indexOf(fullDayName);

        if (forecastDayOfWeek === -1) continue;

        const todayDayOfWeek = todayInTimezone.getDay();
        let daysFromToday = forecastDayOfWeek - todayDayOfWeek;
        if (daysFromToday < 0) daysFromToday += 7;

        const forecastDate = new Date(todayInTimezone);
        forecastDate.setDate(todayInTimezone.getDate() + daysFromToday);

        const dateKey = forecastDate.toLocaleDateString('en-CA', { timeZone: timezone });
        const temp = Math.round(Number(forecast.temperature) || 0);

        const period: ForecastPeriod = {
          name: forecast.name,
          conditions: forecast.conditions,
          temperature: temp,
          windSpeed: Math.round(Number(forecast.wind_speed) || 0),
          windDirection: Math.round(Number(forecast.wind_direction) || 0),
          humidity: Math.round(Number(forecast.humidity) || 0),
          precipProbability: Math.round(Number(forecast.precipitation_probability) || 0),
          localHour,
        };

        if (!dailyForecasts.has(dateKey)) {
          dailyForecasts.set(dateKey, {
            high: temp,
            low: temp,
            conditions: forecast.conditions,
            date: forecastDate,
            dayName,
            periods: [],
            temps: [],
          });
        }

        const day = dailyForecasts.get(dateKey)!;
        day.periods.push(period);
        day.temps.push(temp);
        day.high = Math.max(day.high, temp);
        day.low = Math.min(day.low, temp);
        if (localHour >= 12 && localHour <= 17) {
          day.conditions = forecast.conditions;
        }
      }

      for (const [_, dayData] of dailyForecasts.entries()) {
        dayData.periods.sort((a, b) => a.localHour - b.localHour);
      }

      weather = Array.from(dailyForecasts.values())
        .sort((a, b) => a.date.getTime() - b.date.getTime())
        .slice(0, 10)
        .map(({ high, low, conditions, dayName, periods }) => ({
          day: dayName,
          icon: getWeatherIcon(conditions),
          high,
          low,
          periods,
        }));
    }
  } catch (error) {
    console.error('Failed to load weather:', error);
  }

  return {
    siteConfig,
    weather,
  };
};
