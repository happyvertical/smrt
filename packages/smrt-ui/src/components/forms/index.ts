/**
 * Form primitives — subpath `@happyvertical/smrt-ui/forms`.
 *
 * The Provider-FREE base form primitives, relocated here from
 * `@happyvertical/smrt-svelte/forms` (issue #1589 deferred-forms phase) so domain
 * packages can adopt them without pulling in the smrt-svelte Provider or closing
 * a build-graph cycle. smrt-ui is the leaf everyone may depend on.
 *
 * `Form`, `Input`, `Select`, `Textarea`, `Toggle`, `FormGroup` are generic,
 * tokenised, a11y-checked building blocks with no Provider/i18n/spoken-input
 * dependency. The Provider-REQUIRED inputs (`CheckboxInput`, `TextInput`,
 * `MoneyInput`, the rich `Form`, …) stay in `@happyvertical/smrt-svelte/forms`.
 */

export {
  canCaptureDictationAudio,
  createMediaRecorderCapture,
  DICTATION_AUDIO_MIME_TYPES,
  DICTATION_MAX_BYTES,
  DICTATION_MAX_DURATION_MS,
  type DictationAudioCapture,
  type DictationAudioCaptureFactory,
  type DictationAudioCaptureOptions,
  DictationError,
  type DictationRecording,
  pickDictationMimeType,
} from './audio-capture.js';
// Camera and signature capture (smrt#3290).
export { default as CameraCapture } from './CameraCapture.svelte';
export { default as Checkbox } from './Checkbox.svelte';
export { default as Combobox } from './Combobox.svelte';
export { default as CountrySelect } from './CountrySelect.svelte';
export { default as CurrencySelect } from './CurrencySelect.svelte';
export {
  type CameraCaptureErrorKind,
  type CameraFacingMode,
  type CameraSession,
  type CameraSessionDeps,
  type CameraSessionResult,
  classifyGetUserMediaError,
  createCameraSession,
  isCameraApiSupported,
  type MediaDevicesLike,
} from './camera-capture-session.js';
export type {
  CodeSelectOption,
  CountrySelectProps,
  CurrencySelectProps,
  ProvinceSelectProps,
} from './code-select-types.js';
export {
  emitControlChange,
  focusControl,
  highlightControl,
  revealControl,
} from './control-dom.js';
export {
  type ControlBatchResult,
  type ControlCapability,
  type ControlCommand,
  type ControlCommandAction,
  type ControlCommandContext,
  type ControlCommandResult,
  type ControlCommandSource,
  type ControlConstraints,
  type ControlExtensionContext,
  type ControlIdentity,
  type ControlInteractionEvent,
  type ControlInteractionOptions,
  type ControlInteractionPolicy,
  type ControlInteractionRegistry,
  type ControlKind,
  type ControlMetadata,
  type ControlOption,
  type ControlRegistration,
  type ControlRuntimeState,
  type ControlSensitivity,
  type ControlSnapshot,
  type ControlStagedEntry,
  type ControlStagedProvenance,
  type ControlSubject,
  type ControlValueValidationResult,
  createControlInteractionRegistry,
  executeLocalControlBatch,
  executeLocalControlCommand,
} from './control-interaction.js';
export {
  type ControlInteractionContextValue,
  getControlInteractionContext,
  recordControlUserEdit,
  setControlInteractionContext,
  tryGetControlInteractionContext,
} from './control-interaction-context.js';
export {
  type ControlProposalOptions,
  controlProposalInputSchema,
  controlProposalProperties,
  controlProposalSchema,
  controlProposalToolName,
  isControlProposable,
  proposableControls,
  type StageControlProposalsResult,
  stageControlProposals,
} from './control-proposals.js';
export { default as DatePicker } from './DatePicker.svelte';
export { default as DictationButton } from './DictationButton.svelte';
export { default as DictationStatus } from './DictationStatus.svelte';
export {
  classifyDictationError,
  Dictation,
  type DictationErrorKind,
  type DictationLogEvent,
  type DictationOptions,
  type DictationSourceProvider,
  type DictationSpeechResult,
  type DictationSpeechSource,
  type DictationStartOptions,
  type DictationState,
  dictationErrorCode,
} from './dictation.svelte.js';
export {
  createHttpTranscriber,
  type DictationTranscribe,
  type DictationTranscribeOptions,
  type HttpTranscriberOptions,
} from './dictation-transcribe.js';
export { default as ErrorSummary } from './ErrorSummary.svelte';
export { default as FieldLabel } from './FieldLabel.svelte';
export { default as Fieldset } from './Fieldset.svelte';
export { default as FilePicker } from './FilePicker.svelte';
export { default as Form } from './Form.svelte';
export { default as FormActionBar } from './FormActionBar.svelte';
export { default as Field, default as FormGroup } from './FormGroup.svelte';
export {
  type FormGroupContextValue,
  nextFieldId,
  setFormGroupContext,
  tryGetFormGroupContext,
} from './form-group-context.js';
// Form retry (#3291): also published Svelte-free at `@happyvertical/smrt-ui/form-retry`.
export * from './form-retry/index.js';
export {
  canCaptureHandsFree,
  type HandsFreeCapture,
  type HandsFreeCaptureFactory,
  type HandsFreeCaptureOptions,
  type HandsFreeUtterance,
  type HandsFreeVadOptions,
} from './hands-free-capture.js';
export { default as Input } from './Input.svelte';
export { default as InputGroup } from './InputGroup.svelte';
export { insertTextAtCursor } from './insert-text.js';
export { default as Listbox } from './Listbox.svelte';
export {
  createLongPress,
  LONG_PRESS_DEFAULT_DELAY_MS,
  LONG_PRESS_DEFAULT_MOVE_TOLERANCE_PX,
  type LongPressController,
  type LongPressDetail,
  type LongPressOptions,
  longPress,
} from './long-press.js';
export { default as MultiSelect } from './MultiSelect.svelte';
export {
  detectNativeFileFieldStrategy,
  type NativeFileFieldStrategy,
} from './native-file-field.js';
export { default as ProvinceSelect } from './ProvinceSelect.svelte';
export { default as Radio } from './Radio.svelte';
export { default as RadioGroup } from './RadioGroup.svelte';
export { default as RangeSlider } from './RangeSlider.svelte';
export { default as RelationInput } from './RelationInput.svelte';
export {
  playReadyBeep,
  primeReadyBeep,
  type ReadyBeepOptions,
} from './ready-beep.js';
export { default as SearchInput } from './SearchInput.svelte';
export { default as SegmentedControl } from './SegmentedControl.svelte';
export { default as Select } from './Select.svelte';
export { default as SignaturePad } from './SignaturePad.svelte';
export { default as Slider } from './Slider.svelte';
export { default as StagedControlReview } from './StagedControlReview.svelte';
export { default as Switch } from './Switch.svelte';
export {
  isAcceptedPointerType,
  mapPointerToCanvasPoint,
  type SignaturePointerType,
} from './signature-pad-logic.js';
export type { StagedControlReviewLabels } from './staged-control-review.js';
export { default as TagsInput } from './TagsInput.svelte';
export { default as Textarea } from './Textarea.svelte';
export { default as TimePicker } from './TimePicker.svelte';
export { default as Toggle } from './Toggle.svelte';
export { default as ToggleButton } from './ToggleButton.svelte';
export type {
  CameraCaptureLabels,
  CameraCaptureState,
  CaptureResult,
  FormError,
  RangeSliderValue,
  RelationOption,
  SegmentedControlOption,
  SignaturePadLabels,
  SignaturePadState,
} from './types.js';
export {
  type ControlRegistrationDescriptor,
  useControlRegistration,
} from './use-control-registration.svelte.js';
