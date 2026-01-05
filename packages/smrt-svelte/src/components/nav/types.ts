/**
 * Navigation component types
 */

export interface FilterOption {
  /** Option value */
  value: string;
  /** Display label */
  label: string;
  /** Optional count badge */
  count?: number;
  /** Disabled state */
  disabled?: boolean;
}

export interface Tab {
  /** Tab identifier */
  id: string;
  /** Display label */
  label: string;
  /** Optional count badge */
  count?: number;
  /** Disabled state */
  disabled?: boolean;
}
