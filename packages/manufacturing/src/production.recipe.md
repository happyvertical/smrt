## Overview

Production is where you plan and follow what you make. A production run says
how many of an assembly you intend to make, using one of its bills of
materials. As batches come off the line they are recorded against it, and the run
keeps count until it is done.

## Tasks

Production runs and their finished batches are created and updated by the
production service, not by hand in the app. Here you follow them.

### Find a run

1. Open the production runs.
2. Check the **{field:ProductionRun.bomId}** it makes from and the **{field:ProductionRun.targetQty}** you want.

### See how a run is going

Open the run and compare **{field:ProductionRun.completedQty}** with
**{field:ProductionRun.targetQty}**. Its **{field:ProductionRun.status}** shows
whether it is planned, under way or finished.

### See what was finished

1. Open the run's finished batches.
2. Each one shows the **{field:ProductionRunCompletion.runId}** it belongs to and **{field:ProductionRunCompletion.qty}**, how many came out.
