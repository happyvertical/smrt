import { HttpError } from './http.ts';

/** Never forward a compiler/driver message: it can contain SQL or file paths. */
export function reportFailure(error: unknown): HttpError {
  const message = error instanceof Error ? error.message : '';
  if (/time limit/i.test(message))
    return new HttpError(
      409,
      'This report took too long. Try a smaller period or fewer groups.',
    );
  return new HttpError(
    400,
    'This report could not run. Its fields may have changed. Ask the assistant to update it.',
  );
}
