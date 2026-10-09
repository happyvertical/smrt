# Assistant captions

Issue #3644 adds two independent presentational channels to the assistant:
`HeardCaptions` for recognised user speech, and `SpokenCaptions` for speech
that the host has actually started playing. Both are exported from
`@happyvertical/smrt-chat/svelte`.

Each caption component has its own `enabled`, `placement`, `maxLines`, and
speaker-label properties. Changing either toggle does not start or stop
dictation, playback, or a conversation. Pass a localized `speakerLabel` to
set both the visible speaker heading and the accessible region name.

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

## Listening integration acceptance matrix

All rows run as a local demo user in headless Chromium with synthetic speech,
no microphone/provider/network identity. Persistence, SQL dialects, and server
transactions are N/A: the mock application is local memory. The action boundary
uses the dock's existing preview/confirm/apply contract; it is not server auth.

| Invariant | Reachable trigger | Positive case | Failure case | Level / command |
| --- | --- | --- | --- | --- |
| One Dictation feeds heard captions and final turns | Explicit DictationButton gesture then synthetic source result | Interim only updates captions; final sends via the mounted dock controller | Before start/after stop results ignored; pending approval cannot send or replace draft | Browser: listening-mode spec |
| Hidden history preserves action authority/context | Final asks to mark project ready | Real preview opens existing Confirm/Reject controls; Confirm updates visible app exactly once | Reject and voice while pending do not mutate app; hiding history never applies | Browser: listening-mode spec |
| Toggles are presentation only | Keyboard toggle each checkbox | Either caption channel can remain visible independently | Mic state, controller/thread, and action count unchanged | Browser: listening-mode spec |
| Spoken content uses actual playback events | Synthetic adapter start/boundary/end | Only playback prefix then completed utterance appears | Stop/error/dispose and superseded callbacks cannot publish another utterance | Unit: caption-state.test.ts; browser fixture |
| App remains readable and controls reachable | 320px viewport / reduced motion / keyboard | No horizontal overflow, focusable controls, no motion | Stored history/composer absent in listening mode; approval still visible | Browser: listening-mode spec |

This is a new integration rather than a bug fix; base-failure comparison is
N/A. Existing caption component and controller tests cover their own contracts.

## Workbench and realtime hosts

Open `/previews/listening-mode`. It defaults to synthetic speech and playback;
press **Start listening**, **Synthetic interim**, then **Synthetic final**.
The source callbacks pass through one `Dictation`, update HeardCaptions, and
send only the final turn through the mounted dock's public controller. The
project form remains pending until the dock's real **Confirm** button is used;
**Reject** leaves it unchanged. Final speech during a pending approval or an
existing draft only updates heard captions and cannot confirm or replace it.
Toggle **Hide conversation history** to inspect the same retained conversation.
The mock client/registry affect only this local fixture, not a server resource.

For a manual real-voice trial, choose **Real microphone and browser speech**
before the first Start listening gesture. This lazily loads the public
`createSttDictationSource` and `BrowserSynthesisTTSAdapter`, preserving the same
Dictation instance and caption callbacks. Browser speech support/service is
required; no application provider key is required. Reload to change sources.
Automated checks leave this option off and never acquire a real microphone.
Synthetic playback buttons emit playback events; they do not produce audio.

Realtime hosts can use `createSpokenCaptionCallbacks(channel)` directly:
`onStart(playbackId, transcript)` when audio begins, `onBoundary(id, index,
length)` when the transport reports a boundary, then `onEnd(id)` or
`onCancel(id)`. Use a fresh id per playback. Superseded ids are ignored. Feed
only speech transcripts; model tokens and tool traces are not playback events.
Hosts without character boundaries can use start/end without claiming exact
word synchronization. Heard speech uses the same `onInterim`/`onText` callbacks
as Dictation, so no specific recognition backend is required.

`createSpokenCaptionSession` exclusively owns playback on its supplied adapter.
It cancels the previous invocation and waits for its completion promise before
subscribing the next one, since TTS callbacks do not carry utterance ids.
Adapters must settle completion after cancellation; a stalled adapter prevents
replacement playback rather than allowing ambiguous callbacks to caption it.

Run caption tests with `pnpm --filter @happyvertical/smrt-chat exec vitest run
src/svelte/components/assistant/__tests__/caption-state.test.ts
src/svelte/components/assistant/__tests__/captions.test.ts`; run the browser
matrix with `pnpm --filter @happyvertical/smrt-chat test:e2e listening-mode.spec.ts`.
The browser matrix also exercises the real-source opt-in through mocked native
recognition/synthesis APIs, proving lazy construction and one recognizer without
requesting a microphone or contacting a speech service.

The dev route follows the existing `workspace-aliases.js` browser-ai mapping:
smrt-svelte is intentionally not a chat dependency because that would create
`chat → smrt-svelte → content → chat`. These imports remain route-only, as in
the existing root workbench; published caption helpers stay provider-agnostic.

## Caption containment and expiry

Both exported components own their text wrapping, including unbroken URLs and
interim words, in inline and bottom placement. They do not require a wrapping
rule on a host container. `/previews/captions-standalone` intentionally has no
wrapper styles and supplies long final/interim text for the browser regression.

When `ttlMs` is set, each completed line expires independently after that
line's duration. A new final does not postpone an older line, and expiration
never clears the active interim transcript. Repeated identical finals remain
separate utterances with separate ids and deadlines. Bounded-retention eviction,
`clear()`, and `dispose()` cancel their retired deadlines.

| Behavior / trigger | Positive case | Failure regression | Actor / executor / runtime / edge | Level / evidence |
| --- | --- | --- | --- | --- |
| Long URL or unbroken interim in either standalone component | Text fragments and component bounds remain inside 320px for inline/bottom | No host wrapping rule may mask overflow | Local viewer; no data executor or transaction; Chromium; plain transcript string, no wire contract | Four standalone cases in `listening-mode.spec.ts` |
| Staggered completed lines with TTL | Each expires at its own deadline, including duplicate text; newer interim remains | Later final cannot postpone older expiry; timer cannot erase interim | Host caption channel; in-memory timer only, no DB/dialect; JS fake clock; timer callback edge | `caption-state.test.ts` |
| Eviction, clear, dispose, then late callback | Retired timers are cancelled and their callbacks are harmless | Old callback cannot delete a fresh line or its interim | Same channel context; no external identity/persistence | `caption-state.test.ts` |

## Coordinated bottom placement

Use one `CaptionOverlay` for every viewport-bottom caption group. Its children
remain independent components with their own toggles, speaker labels, and styles:

```svelte
<CaptionOverlay label={localizedCaptionsLabel}>
  <HeardCaptions enabled={heardEnabled} lines={heard.lines} interim={heard.interim} placement="bottom" />
  <SpokenCaptions enabled={spokenEnabled} lines={spoken.lines} interim={spoken.interim} placement="bottom" />
</CaptionOverlay>
```

The wrapper owns the bottom anchor. Scoped context lets its descendant bottom
captions participate in normal grid flow, in source/reading order, so changes in
text height and additional speaker instances never require measured offsets.
Keep caption surfaces as direct rendered children of the wrapper. Disabled or
empty surfaces leave no gap; an empty group is hidden and leaves the tab order.
Unmounting the group destroys its scoped context without shared registrations.

The group respects safe-area insets and is bounded to half the viewport height.
When content is taller, localized shared buttons appear to scroll up or down by
one visible page. Tab to a button and press Enter or Space; each direction is
disabled at its boundary. The region itself stays nonfocusable. Controls disappear
when the content fits. A group-owned ResizeObserver tracks layout changes and
disconnects on unmount. It uses the sticky layer, below
FloatingAssistant's overlay layer, so approvals and other required controls
remain clickable. It introduces no animation. Hosts must keep the overlay in a
viewport positioning context (outside transformed or clipped ancestors), and
must use one root for simultaneous captions in a group; separate roots do not
coordinate with one another. Supply a localized `label` for the group.

A single standalone `placement="bottom"` caption internally uses the same
`CaptionOverlay`, including its viewport height bound, keyboard scrolling
buttons, and observer cleanup. Long interim text or multiple wrapped final lines
remain reachable without adding a host wrapper. Independent
`placement="inline"` captions retain normal-flow behavior without requiring the
wrapper. Do not mount several standalone bottom surfaces at the same viewport
anchor: compose them in `CaptionOverlay` instead.

Browser acceptance covers both explicit bottom placements at 320px, growing
interim text, independent toggles, three simultaneous surfaces, unmount/remount,
empty-group hiding, tall keyboard scrolling, reduced motion, and real approval
hit testing above both captions. The no-provider listening fixture now uses this
public composition. Browser TTS initialization cancellation is tracked separately
in #3651; caption callback invalidation alone cannot cancel pending native audio.
