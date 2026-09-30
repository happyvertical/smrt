/**
 * Feedback components - User feedback and status indicators
 */

// Swipe-to-dismiss (used by PhoneSheet; phone drawers use it too).
export {
  SWIPE_DISMISS_THRESHOLD,
  type SwipeDirection,
  type SwipeDismissOptions,
  swipeDismiss,
  swipeDismisses,
} from '../../actions/swipe-dismiss.js';
// Note: Component prop types (ConfirmDialogProps, etc.) are available
// via svelte-package build output but cannot be re-exported here because
// tsc --noEmit cannot resolve type exports from .svelte files.
export { default as Alert } from './Alert.svelte';
export { default as ConfirmDialog } from './ConfirmDialog.svelte';
export { default as Drawer, default as Sheet } from './Drawer.svelte';
export { default as LoadingOverlay } from './LoadingOverlay.svelte';
export { default as Meter } from './Meter.svelte';
export { default as Modal } from './Modal.svelte';
export { default as PhoneSheet } from './PhoneSheet.svelte';
export { default as Progress } from './Progress.svelte';
export { default as ProgressBar } from './ProgressBar.svelte';
export { default as Spinner } from './Spinner.svelte';
export { default as ToastViewport } from './ToastViewport.svelte';
export type {
  Toast,
  ToastAction,
  Toaster,
  ToastInput,
  ToastVariant,
} from './toast.js';
export { createToaster, toaster } from './toast.js';
export { default as WorkingStrip } from './WorkingStrip.svelte';
export {
  WORKING_ASSERTIVE_PHASES,
  type WorkingPhase,
  type WorkingStatus,
} from './working-status.js';
