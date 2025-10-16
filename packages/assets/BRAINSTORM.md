@have/assets

@have/smrt based, just like content, product
asset storage for agents and sites
uses @have/files package for *everything* so all the same possible backends
should be able to scan existing directory
suitable to catalog external and internal assets



schema

table: assets
  id:
  name:
  slug:
  source:
  mime_type:
  description:
  parentId:
    - for derivative assets, such as a resized image - this would point to the original asset
  tags:
    - array of tags associated with the asset

table: assets_tags
