import type { ControlOption } from './control-interaction.js';

export interface FormError {
  controlId: string;
  message: string;
  label?: string;
}

export interface RangeSliderValue {
  min: number;
  max: number;
}

export interface SegmentedControlOption extends ControlOption {
  icon?: string;
}

/** What `CameraCapture` and `SignaturePad` hand to `onCapture`. */
export interface CaptureResult {
  /** The encoded image (JPEG/PNG/WebP for photos, PNG for signatures). */
  blob: Blob;
  /** The same image as a `data:` URL, convenient for an inline preview. */
  dataUrl: string;
}

/** Rendered states of `CameraCapture`, exposed as its `data-state` attribute. */
export type CameraCaptureState =
  | 'off'
  | 'starting'
  | 'streaming'
  | 'reviewing'
  | 'committed'
  | 'permission-denied'
  | 'no-camera'
  | 'unsupported'
  | 'error'
  | 'fallback';

/** Text overrides for `CameraCapture`; defaults come from the `ui` i18n catalog. */
export interface CameraCaptureLabels {
  region: string;
  preview: string;
  starting: string;
  off: string;
  unsupported: string;
  permissionDenied: string;
  noCamera: string;
  error: string;
  retry: string;
  capture: string;
  retake: string;
  usePhoto: string;
  reviewAlt: string;
  committedAlt: string;
  committed: string;
  choosePhoto: string;
}

/** Rendered states of `SignaturePad`, exposed as its `data-state` attribute. */
export type SignaturePadState = 'empty' | 'signed' | 'committed';

/** Text overrides for `SignaturePad`; defaults come from the `ui` i18n catalog. */
export interface SignaturePadLabels {
  region: string;
  canvasEmpty: string;
  canvasSigned: string;
  hintAny: string;
  hintStylus: string;
  clear: string;
  useSignature: string;
  committed: string;
}

/** A searchable relation target for the RelationInput component */
export interface RelationOption {
  /** Record id; this is the value the form posts. */
  id: string;
  /** Human-readable name shown in the field and the list. */
  label: string;
  /** Secondary text shown under the label in the list. */
  detail?: string;
}
