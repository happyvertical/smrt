# Assistant captions

Issue #3644 adds two independent presentational channels to the assistant:
`HeardCaptions` for recognised user speech, and `SpokenCaptions` for speech
that the host has actually started playing. Both are exported from
`@happyvertical/smrt-chat/svelte`.

Each caption component has its own `enabled`, `placement`, `maxLines`, and
speaker-label properties. Changing either toggle does not start or stop
dictation, playback, or a conversation.

## Host wiring

Create one host-owned `Dictation` and pass `createHeardCaptionCallbacks()` as
its `onText` and `onInterim` handlers alongside the host's draft callbacks.
This observes the existing recogniser; the caption code never owns a source or
requests microphone access. Start Dictation from a user gesture only.

Create `createSpokenCaptionSession(adapter, spokenChannel)` around the actual
TTS adapter and call its `speak()` where the host plays audio. Do not feed it
model streaming text or persisted assistant messages: a visible spoken caption
must follow `TTSAdapter.onStart` and its boundary/end callbacks. A host with no
playback produces no spoken captions.

Completed lines are bounded and may be TTL-cleared. Interim text is replaced in
place. Captions accept only plain text, normalize control characters, and use
Svelte text interpolation, so chat tool calls, system messages, and raw HTML
are not a possible caption source or rendering path.

## Test design

| Behavior / invariant | Trigger | Positive and failure evidence | Test level / command |
| --- | --- | --- | --- |
| Heard speech is interim-replaceable and bounded | Existing Dictation callback | interim is replaced; final text retains only configured count; control text normalizes | Unit: `caption-state.test.ts` |
| Captions never acquire a microphone | Host supplies callbacks to its one Dictation | helper has no source/start/stop API; a source is owned by host | Contract inspection + unit helper test |
| Spoken text follows playback only | Host calls caption session `speak()` | boundary reveals played prefix; end before start creates no line; stop/error clear staging | Unit: `caption-state.test.ts` |
| Controls stay independent and accessible | Rendered components | disabled channel renders nothing; heard interim avoids duplicate live announcement; spoken live announcement is opt-in; text renders escaped | Component: `captions.test.ts` |
| No external browser, provider, or audio device is needed | Synthetic TTS callbacks | all source and playback events are synthetic | `pnpm --filter @happyvertical/smrt-chat test` |

There is no persistence, tenancy, SQL dialect, retryable mutation, or external
wire contract in this presentation-only feature; those test-design fields are
N/A.
