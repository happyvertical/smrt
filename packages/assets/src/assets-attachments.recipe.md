## Overview

Attachments keep authorized supporting files connected to a record without making a public storage link. The application supplies the authorization and upload endpoint; this recipe records the asset and its relationship.

## Tasks

### Describe an attachment

1. Use a clear {field:Asset.name} so people can identify the file.
2. Add a {field:Asset.description} when the attachment needs context.
3. Check the {field:Asset.mimeType} before offering the file to a viewer.

### Link an attachment to a record

1. Select the {field:AssetAssociation.assetId} to link.
2. Set a {field:AssetAssociation.role} when the record uses more than one file.
3. Adjust {field:AssetAssociation.sortOrder} to control display order.
