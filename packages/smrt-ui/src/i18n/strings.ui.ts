/**
 * smrt-svelte `ui`-namespace message catalog (i18n, Sweep S13 #1418).
 *
 * English code defaults for the `ui`, `feedback`, `layout`, `memberships`,
 * `module`, and `calendar` component primitives. Registered through
 * `defineMessages` (see `./registry.ts`); keys follow `<package>.<component>.<descriptor>`
 * with the `ui` namespace for smrt-svelte primitives.
 */

import { defineMessages } from './registry.js';

export const M = defineMessages({
  // calendar/Calendar.svelte
  'ui.calendar.previous_month': 'Previous month',
  'ui.calendar.next_month': 'Next month',
  'ui.calendar.select_month': 'Select month',
  'ui.calendar.select_year': 'Select year',

  // calendar/CalendarView.svelte
  'ui.calendar.previous_week': 'Previous week',
  'ui.calendar.next_week': 'Next week',
  'ui.calendar.nothing_week': 'Nothing scheduled this week',
  'ui.calendar.today': 'Today',
  'ui.calendar.more': '+{count} more',
  'ui.calendar.more_short': '+{count}',
  'ui.calendar.all_day': 'All day',
  'ui.calendar.until': 'Until {date}',
  'ui.calendar.items_one': '1 item',
  'ui.calendar.items_other': '{count} items',
  'ui.calendar.nothing_day': 'Nothing scheduled',
  'ui.calendar.nothing_month': 'Nothing scheduled this month',
  'ui.calendar.days_in': 'Days in {month}',
  'ui.calendar.close_day': 'Close {date}',

  // calendar/DayView.svelte
  'ui.day_view.back_to_calendar': 'Back to Calendar',
  'ui.day_view.no_events': 'No events scheduled for this day',

  // feedback/Modal.svelte
  'ui.modal.close': 'Close modal',

  // feedback/PhoneSheet.svelte
  'ui.phone_sheet.close': 'Close {title}',

  // feedback/WorkingStrip.svelte
  'ui.working_strip.working': 'Working…',
  'ui.working_strip.done': 'Done',
  'ui.working_strip.open': 'Open',
  'ui.working_strip.stop': 'Stop',
  'ui.working_strip.paused': 'Paused',
  'ui.working_strip.waiting': 'Waiting for you',
  'ui.working_strip.failed': "Couldn't finish",
  'ui.working_strip.cancelled': 'Stopped',
  'ui.working_strip.pause': 'Pause',
  'ui.working_strip.resume': 'Continue',
  'ui.working_strip.review': 'Review',
  'ui.working_strip.dismiss': 'Close',

  // forms/FormActionBar.svelte
  'ui.form_action_bar.label': 'Form actions',

  // forms/DictationButton.svelte, forms/DictationStatus.svelte
  'ui.dictation.start': 'Speak instead of typing',
  'ui.dictation.start_hint':
    'Speak instead of typing. You can also press and hold the text box.',
  'ui.dictation.start_hands_free':
    'Speak instead of typing, hands-free. It writes each sentence down when you pause.',
  'ui.dictation.stop': 'Stop listening',
  'ui.dictation.listening_hands_free':
    'Listening. Just talk; I write it down when you pause. Tap the microphone when you are done.',
  'ui.dictation.listening_short': 'Listening',
  'ui.dictation.hearing': 'Hearing you…',
  'ui.dictation.sending': 'Sending…',
  'ui.dictation.paused_speaking': 'Paused while the assistant speaks',
  'ui.dictation.starting': 'Getting the microphone ready…',
  'ui.dictation.listening': 'Listening. Tap the microphone when you are done.',
  'ui.dictation.unsupported':
    "Speech recognition isn't available in this browser. Brave blocks it; try Chrome, Edge or Safari, or type instead.",
  'ui.dictation.denied':
    'The microphone is blocked. Allow it for this site in your browser settings, then try again.',
  'ui.dictation.no_speech': "Didn't hear anything. Tap the mic and try again.",
  'ui.dictation.microphone':
    "Couldn't use the microphone. Check that one is connected and no other app is using it, then try again.",
  'ui.dictation.interrupted':
    'Listening stopped straight away. This browser may not support speaking into text; try Chrome, Edge or Safari, or type instead.',
  'ui.dictation.failed': 'Listening stopped. Tap the microphone to try again.',
  'ui.dictation.transcribing': 'Writing it down…',
  'ui.dictation.too_long':
    'That was too long to write down. Try a shorter message, or type instead.',
  'ui.dictation.not_transcribed':
    "Couldn't write that down. Tap the microphone to try again, or type instead.",
  'ui.dictation.unavailable':
    "Speaking isn't set up here yet. Please type instead.",
  'ui.dictation.model_missing':
    "The speech model isn't downloaded yet. Download it first, or type instead.",
  'ui.dictation.forbidden': "You can't use speaking here. Please type instead.",

  // feedback/ProgressBar.svelte
  'ui.progress_bar.label': 'Progress',
  'ui.progress_bar.over_by': 'Over by {amount}',

  // layout/Footer.svelte
  'ui.footer.all_rights_reserved': 'All rights reserved.',

  // layout/Masthead.svelte
  'ui.masthead.home': 'Home',
  'ui.masthead.primary_nav': 'Primary',
  'ui.masthead.mobile_nav': 'Mobile',

  // memberships/MembershipCard.svelte
  'ui.membership_card.change_role': 'Change Role',

  // memberships/MembershipList.svelte
  'ui.membership_list.loading': 'Loading memberships...',

  // module/ModulePanel.svelte
  'ui.module_panel.component_not_registered': 'Component not registered',
  'ui.module_panel.register_hint':
    "Import the module's Svelte package to register components.",

  // ui/Pagination.svelte
  'ui.pagination.first_page': 'First page',
  'ui.pagination.previous_page': 'Previous page',
  'ui.pagination.page_current': 'Page {page}, current',
  'ui.pagination.go_to_page': 'Go to page {page}',
  'ui.pagination.next_page': 'Next page',
  'ui.pagination.last_page': 'Last page ({totalPages})',

  // chat/ReactionPicker.svelte
  'ui.reaction_picker.label': 'Add reaction',
  'ui.reaction_picker.react_with': 'React with {emoji}',

  // forms/CameraCapture.svelte
  'ui.camera_capture.region': 'Camera',
  'ui.camera_capture.preview': 'Live camera preview',
  'ui.camera_capture.starting': 'Starting camera…',
  'ui.camera_capture.off': 'The camera is off.',
  'ui.camera_capture.unsupported':
    'This browser cannot use the camera. Open this page over HTTPS in a current browser.',
  'ui.camera_capture.permission_denied':
    'Camera access was denied. Allow camera access for this site, then try again.',
  'ui.camera_capture.no_camera': 'No camera was found on this device.',
  'ui.camera_capture.error': 'Could not access the camera.',
  'ui.camera_capture.retry': 'Try again',
  'ui.camera_capture.capture': 'Take photo',
  'ui.camera_capture.retake': 'Retake',
  'ui.camera_capture.use_photo': 'Use photo',
  'ui.camera_capture.review_alt': 'Captured photo, not yet used',
  'ui.camera_capture.committed_alt': 'Attached photo',
  'ui.camera_capture.committed': 'Photo attached.',
  'ui.camera_capture.choose_photo': 'Take or choose a photo',

  // forms/SignaturePad.svelte
  'ui.signature_pad.region': 'Signature',
  'ui.signature_pad.canvas_empty': 'Signature area, not yet signed',
  'ui.signature_pad.canvas_signed': 'Signature area, signed',
  'ui.signature_pad.hint_any': 'Sign with a stylus, your finger, or the mouse.',
  'ui.signature_pad.hint_stylus': 'Sign with the stylus.',
  'ui.signature_pad.clear': 'Clear',
  'ui.signature_pad.use_signature': 'Use signature',
  'ui.signature_pad.committed': 'Signature attached.',

  // forms/StagedControlReview.svelte
  'ui.staged_control_review.region': 'Review proposed changes',
  'ui.staged_control_review.heading': 'Proposed changes',
  'ui.staged_control_review.description':
    'Review changes before they update the form.',
  'ui.staged_control_review.proposed_by': 'Proposed by',
  'ui.staged_control_review.staged_at': 'staged',
  'ui.staged_control_review.before': 'Current',
  'ui.staged_control_review.after': 'Proposed',
  'ui.staged_control_review.redacted': 'Hidden for privacy',
  'ui.staged_control_review.stale':
    'The field changed after this proposal was staged.',
  'ui.staged_control_review.invalid': 'This proposal is not valid.',
  'ui.staged_control_review.apply': 'Apply',
  'ui.staged_control_review.discard': 'Discard',
  'ui.staged_control_review.apply_all': 'Apply valid changes',
  'ui.staged_control_review.discard_all': 'Discard valid changes',
  'ui.staged_control_review.edit': 'Edit proposed value for',
  'ui.staged_control_review.applied_status': 'Applied proposed change.',
  'ui.staged_control_review.discarded_status': 'Discarded proposed change.',
  'ui.staged_control_review.batch_status':
    'Processed {completed} of {total} proposed changes.',
});
