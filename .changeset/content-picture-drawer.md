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
