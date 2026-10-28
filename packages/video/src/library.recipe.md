## Overview

Video is where you plan a video before it is made. A video is built from
sequences, the parts that play one after another, and each sequence is built
from shots, the single clips with the words spoken in them. Characters are the
presenters who appear on screen, each with a picture and a voice, and scenes
are the backgrounds they stand in front of.

You write and arrange everything here. Making the clips and putting the
finished video together is done by a rendering service, so the screens show
where each shot and video stands rather than letting you set that by hand.

## Tasks

### Start a new video

1. Open the list of videos and choose **New**.
2. Give it a **{field:VideoComposition.name}** and a short **{field:VideoComposition.description}**.
3. Set the **{field:VideoComposition.fps}** and the picture size with **{field:VideoComposition.width}** and **{field:VideoComposition.height}**.
4. Save. The **{field:VideoComposition.durationInFrames}** fills in as you add sequences, and **{field:VideoComposition.renderStatus}** shows whether the finished video is still a draft, being rendered, ready or failed.

### Break a video into sequences

1. Open the list of sequences and choose **New**.
2. Give the sequence a **{field:VideoSequence.name}** and pick the **{field:VideoSequence.compositionId}** it belongs to.
3. Set the **{field:VideoSequence.position}** so the sequences play in the order you want.
4. Choose a **{field:VideoSequence.transitionType}** if you want a fade, slide or wipe into the next sequence instead of a straight cut.
5. Save. The **{field:VideoSequence.durationInFrames}** adds up from the shots you put in it.

### Write a shot

1. Open the list of shots and choose **New**.
2. Give the shot a **{field:VideoShot.name}**, then pick the **{field:VideoShot.sequenceId}** it belongs to and its **{field:VideoShot.position}** within it.
3. Type the words to be spoken in **{field:VideoShot.scriptText}**.
4. Pick the **{field:VideoShot.sceneId}** the shot is filmed in.
5. Set the **{field:VideoShot.targetDuration}** you are aiming for. Roughly two to three words fill a second.
6. Save. Once the clip is made, **{field:VideoShot.durationInFrames}** shows its real length and **{field:VideoShot.shotStatus}** shows where it stands.

### Change or remove a shot

1. Open the shot from the list of shots.
2. Edit the **{field:VideoShot.scriptText}** or any other detail and save. Edit a sequence or a video the same way.
3. To take a shot out, remove it. Removing a sequence or a video is done from its own list.

### Add a character

1. Open the list of characters and choose **New**.
2. Give the character a **{field:Character.name}** and describe them in **{field:Character.description}**.
3. Choose the **{field:Character.imageAssetId}** they are built from and the **{field:Character.voiceProfileId}** they speak with.
4. Pick the **{field:Character.defaultSceneId}** they usually appear in.
5. Save. **{field:Character.status}** shows when the character is ready to use in shots.

### Add a scene

1. Open the list of scenes and choose **New**.
2. Give the scene a **{field:Scene.name}** and say what it shows in **{field:Scene.description}**.
3. Choose the **{field:Scene.sourceType}** and pick the **{field:Scene.sourceAssetId}** it is made from.
4. Save. **{field:Scene.status}** shows when the scene is ready to be used in shots.
