/** Read a Node `code` from an unknown thrown value. Internal helper. */
export function errorCode(error: unknown): string | undefined {
  return error &&
    typeof error === 'object' &&
    'code' in error &&
    typeof (error as { code: unknown }).code === 'string'
    ? (error as { code: string }).code
    : undefined;
}
