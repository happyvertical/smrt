---
'@happyvertical/smrt-content': minor
---

"Change this picture" in `ContentBodyEditor`. With the new
`onRequestImageChange` callback, the selected picture's toolbar gets a Change
button, a selected or hovered picture shows a 44px change badge, and pressing
and holding a picture (about half a second without moving; moving is still a
drag) asks with `listen: true` so the host can open its request box already
listening. The context menu is held back only during a press on a picture.
