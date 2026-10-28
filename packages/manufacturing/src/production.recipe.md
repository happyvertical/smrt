## Overview

Production is where you plan and follow what you make. A production run says
how many of an assembly you intend to make, using one of its bills of
materials. As batches come off the line you record them, and the run keeps
count until it is done.

## Tasks

### Plan a run

1. Open the production runs and choose **New**.
2. Pick the **{field:ProductionRun.bomId}** to make from.
3. Set **{field:ProductionRun.targetQty}** to how many you want.
4. Save. The run starts as planned.

### Record what was finished

1. Open the production run.
2. Add a finished batch to it and pick the **{field:ProductionRunCompletion.runId}** it belongs to.
3. Enter **{field:ProductionRunCompletion.qty}**, how many came out.
4. Save. The run adds it to what has been made so far.

### See how a run is going

Open the run and compare **{field:ProductionRun.completedQty}** with
**{field:ProductionRun.targetQty}**. Its **{field:ProductionRun.status}** shows
whether it is planned, under way or finished.
