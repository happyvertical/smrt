## Overview

Assemblies is where you describe what you make. An assembly is a product built
from parts. Its bill of materials lists those parts and how much of each goes
into one unit, and its steps say which operations, such as cutting or painting,
it passes through and how long each takes.

## Tasks

### Add something you make

1. Open the list of assemblies and choose **New**.
2. Give it a **{field:Assembly.name}** and your own **{field:Assembly.partReference}**, such as a drawing or part number.
3. Note roughly how long one takes in **{field:Assembly.estimatedLabourMinutes}**.
4. Save.

### List what goes into it

1. Open the bills of materials and choose **New**.
2. Pick the **{field:BillOfMaterials.productId}** the list is for.
3. Save, then add a line for each part.
4. For each line pick the **{field:BomLine.componentSkuId}** and set the **{field:BomLine.qtyPerUnit}** that goes into one unit.

### Change how something is made

1. Create a new bill of materials with a higher **{field:BillOfMaterials.version}**.
2. Set its **{field:BillOfMaterials.status}** to active when it is ready to use.
3. The old version stays on file, so past runs still make sense.

### See the kinds of work

Operations are set up by the manufacturing service, not by hand in the app.

1. Open the operations.
2. Read each **{field:Operation.name}** and its short **{field:Operation.code}**.
3. The steps of a bill of materials use these, each with its **{field:RoutingStep.estimatedMinutes}**.
