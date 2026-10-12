/** Shape of the setup route's `load` data. */
export interface OwnerSetupData {
  /** False (with an empty token) when setup is not offered. */
  available: boolean;
  /** Single-use bootstrap token carried from the setup link. */
  token: string;
  /**
   * State of the setup link (`createOwnerSetupPage` sets it). Omitted by older
   * loads: derived from `available` and `token`.
   */
  link?: 'ready' | 'missing' | 'expired' | 'unavailable';
}

/** Shape of the setup action's failure data (`fail(status, { code, message })`). */
export interface OwnerSetupFormResult {
  code?: string;
  /** Fixed server-provided text; displayed as given. */
  message?: string;
}
