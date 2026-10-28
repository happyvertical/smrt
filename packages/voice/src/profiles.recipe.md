## Overview

Voice is where you set up the voices your app can speak in and keep the speech
it has read aloud. A voice is either described in your own words, such as "a
warm, unhurried narrator", or copied from a recorded clip of a real person. The
speech service prepares the voice and shows where it stands, from waiting to
ready. Once a voice is ready, the app can read any text aloud in it, and each
recording it makes is kept here with the text it came from.

## Tasks

### Create a voice

1. Open the list of voices and choose **New**.
2. Give the voice a **{field:VoiceProfile.name}** your team will recognise.
3. Pick the **{field:VoiceProfile.language}** it speaks and, if you like, the **{field:VoiceProfile.gender}** it should sound like.
4. Do one of the following, not both: write what you want to hear in **{field:VoiceProfile.designPrompt}**, or pick a recorded clip in **{field:VoiceProfile.sampleAssetId}** to copy a real voice.
5. Save. The **{field:VoiceProfile.status}** shows whether the speech service is still preparing the voice, has it ready, or could not make it. You do not set it yourself.

### Add a sample clip

A clip can only be used to copy a voice when it runs at least three seconds and
its quality is not low. One clear speaker with no background noise works best.

1. Open the list of samples and choose **New**.
2. Pick the **{field:VoiceSample.voiceProfileId}** the clip is for and the **{field:VoiceSample.assetId}** holding the recording.
3. Enter the **{field:VoiceSample.duration}** and, if you know it, the **{field:VoiceSample.quality}** of the recording.
4. Write out **{field:VoiceSample.transcription}** so the words can be matched to the sound.
5. Tick **{field:VoiceSample.isPrimary}** on the clip that best represents the voice.
6. Save. To take a clip out, open it and remove it.

### Find a recording the app has made

Recordings are made by the speech service whenever the app reads text aloud in
one of your voices. The sound itself always comes from the service; here you
find, listen to and tidy up what it has made.

1. Open the list of generated speech.
2. Look at the **{field:VoiceOutput.name}** and the **{field:VoiceOutput.voiceProfileId}** to find the one you want.
3. Open it to read the **{field:VoiceOutput.sourceText}** and play the **{field:VoiceOutput.audioAssetId}**; the **{field:VoiceOutput.duration}** tells you how long it runs.
4. To clear out a recording you no longer need, open it and remove it.
