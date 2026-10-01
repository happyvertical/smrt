---
'@happyvertical/smrt-content': minor
---

Pictures in the content editor:

- `ContentPictureDrawer`: one plain "Add pictures" drawer. Search, upload,
  drag one or several pictures into the story at the drop position, or pick
  them and press Insert (the keyboard and phone path). It shows and changes
  the main picture.
- Main picture rule: the first picture in the story is the main picture
  unless the person chose one. `resolveBodyMainPicture`, `setBodyMainImage`
  (marks a story picture with `data-smrt-main="true"`, so the choice follows
  the picture when pictures are reordered) and `bodyHasImage`;
  `ContentEditorState.mainPicture` and `syncMainPictureFromBody()`.
- `ContentBodyEditor`: a dragged `application/x-smrt-image` payload may be an
  array (inserted in order); `replaceImage(index, asset)` swaps a picture in
  place; `mainImageAssetId` marks the selected picture's "Use as main picture"
  button as pressed. The button now reads "Use as main picture".
- Markdown bodies keep a stored picture's asset id (and the chosen main
  picture) in the image title — `smrt-image <id>`, `smrt-image <id> main`,
  `smrt-thumbnail:<placement> <id>` — so the main-picture rule, "Use as main
  picture" and picture replacement work for Markdown articles too. Rendering
  turns the markers back into attributes, never a visible title.

- The drawer loads more pictures as its list scrolls, and asks again when a
  load-more request went unanswered; `onSearch` can hand the drawer's search to
  the host (its own picture search); its Done button is a full-size 44px touch
  target.
- A story picture can be moved anywhere in the story: drag it with a drop line
  showing where it will land, or use Move up / Move down (keyboard and phone).
