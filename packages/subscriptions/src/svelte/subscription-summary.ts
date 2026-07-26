export function formatPeriodDate(
  value: string,
  locale = 'en-US',
  timeZone = 'UTC',
): string | null {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;

  try {
    return new Intl.DateTimeFormat(locale, {
      dateStyle: 'medium',
      timeZone,
    }).format(date);
  } catch {
    return null;
  }
}
