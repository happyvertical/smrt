/**
 * Forms-component message catalog (i18n, Sweep S13 #1418).
 *
 * English code defaults for user-facing strings in
 * `src/components/forms/*.svelte`, registered via `defineMessages`. Keys follow
 * the `ui` namespace (`ui.<component>.<descriptor>`) for smrt-svelte primitives.
 */
import { defineMessages } from './registry.js';

export const M = defineMessages({
  // AddressInput
  'ui.address_input.street_placeholder': '123 Main Street',
  'ui.address_input.city_placeholder': 'City',
  'ui.address_input.postal_code_placeholder': 'A1A 1A1',

  // DateRangeInput
  'ui.date_range_input.mic_aria_label': 'Hold to speak date range',
  'ui.date_range_input.parsing': 'Parsing dates...',
  'ui.date_range_input.end_after_start': 'End date must be after start date',

  // DateTimeInput
  'ui.date_time_input.mic_aria_label': 'Hold to speak',
  'ui.date_time_input.parsing': 'Parsing date...',

  // FileUpload
  'ui.file_upload.remove_file': 'Remove {name}',

  // Form
  'ui.form.extracting': 'Extracting form fields…',
  'ui.form.listening_status': 'Listening. Say "done" to finish.',
  'ui.form.listening_button': 'Listening... (say "done" to finish)',
  'ui.form.speak_all_fields': 'Speak all fields',
  'ui.form.you_said': 'You said:',

  // FormMicButton
  'ui.form_mic_button.tooltip':
    'Speak to fill all fields. Click again to stop.',

  // MeasurementInput
  'ui.measurement_input.value_at_least': 'Value must be at least {min} {unit}',
  'ui.measurement_input.value_at_most': 'Value must be at most {max} {unit}',

  // MoneyInput — the currency symbol lives in the {min}/{max} var (passed by the
  // component) so a translation can place it per locale, and the template has no `${…}`.
  'ui.money_input.value_at_least': 'Value must be at least {min}',
  'ui.money_input.value_at_most': 'Value must be at most {max}',

  // NumberInput
  'ui.number_input.value_at_least': 'Value must be at least {min}',
  'ui.number_input.value_at_most': 'Value must be at most {max}',

  // PhoneInput
  'ui.phone_input.mic_aria_label': 'Hold to speak',
  'ui.phone_input.downloading_model':
    'Downloading Whisper model... {progress}%',
  'ui.phone_input.invalid': 'Invalid phone number',

  // SearchInput
  'ui.search_input.clear_aria_label': 'Clear search',

  // TextInput
  'ui.text_input.mic_aria_label': 'Hold to speak',
  'ui.text_input.downloading_model': 'Downloading Whisper model... {progress}%',
  'ui.text_input.invalid_email': 'Invalid email address',

  // TextareaInput
  'ui.textarea_input.mic_aria_label': 'Hold to speak',
  'ui.textarea_input.downloading_model':
    'Downloading Whisper model... {progress}%',
});
