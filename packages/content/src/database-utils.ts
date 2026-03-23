export function isMissingTableError(
  error: unknown,
  tableName: string,
): boolean {
  const message = String(
    (error as Error)?.message || error || '',
  ).toLowerCase();

  return (
    message.includes(tableName.toLowerCase()) &&
    (message.includes('no such table') ||
      message.includes('does not exist') ||
      message.includes('relation'))
  );
}

export function getQueryRows(result: unknown): Record<string, unknown>[] {
  return Array.isArray(result)
    ? (result as Record<string, unknown>[])
    : Array.isArray((result as { rows?: Record<string, unknown>[] })?.rows)
      ? ((result as { rows: Record<string, unknown>[] }).rows ?? [])
      : [];
}
