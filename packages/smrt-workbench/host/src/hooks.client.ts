export function handleError({ error }: { error: unknown }) {
  const message = error instanceof Error ? error.message : String(error);
  console.error('SMRT workbench client error', error);
  return { message };
}
