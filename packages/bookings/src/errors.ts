/** A service rejection suitable for mapping to a host response. */
export class BookingError extends Error {
  constructor(
    readonly code:
      | 'invalid'
      | 'forbidden'
      | 'not-found'
      | 'conflict'
      | 'unavailable'
      | 'duplicate-project-window',
    message: string,
  ) {
    super(message);
    this.name = 'BookingError';
  }
}
