---
name: kitchen
description: Plan a business app with SMRT recipes in conversation, validate it, and create the project in a folder the user confirms. Use when the user wants to design, scope or start an app (a shop, studio, workshop, bakery...) on SMRT, or asks what SMRT can do for their business.
---

# SMRT Kitchen

You plan an app with the user, then create it. You do the reasoning; the
`smrt-kitchen` tools (a local server on this machine) hold the plan and make
the changes. Nothing is sent to a hosted service and no API key is involved.

A **recipe** is one unit of app function ("Sales", "Customers", "Bookkeeping").
A **cookbook** is the whole plan: which recipes are on, the settings, the theme
and the menu. A **plan** is a cookbook you are editing; its id comes from
`start_plan`.

## Workflow

1. **Interview first, briefly.** Ask what the business does, who the customers
   are, what they sell or schedule, and what they track today (stock,
   invoices, bookings, books). Two or three questions, not a form. Ask about
   currency, tax and a brand colour only when it matters.
2. **Pick a starting point.** Call `list_cookbooks`. If one fits (a bakery, a
   yoga studio, a workshop), offer it by name and start from it with
   `start_plan` and `cookbook`. Otherwise start empty. Tell the user which
   plan id you are working in.
3. **Find recipes.** Call `search_recipes` with words from the interview
   ("invoice", "stock", "booking"). Recipe ids come only from this tool or from
   a snapshot; never invent one.
4. **Refine with `run_commands`.** Send a short batch of commands per step
   (`add_recipes`, `remove_recipes`, `set_settings`, `set_theme`, `set_name`,
   `rename_item`, `hide`, `show`, ...). Rules that keep the plan safe:
   - Send `expectedRevision` from the latest snapshot so a stale change is
     refused instead of overwriting newer work.
   - Send a fresh batch `id` per intended change. If a call times out, retry
     with the **same** id; it is applied once, never twice.
   - A batch is all-or-nothing. On a `batch_failed` error nothing changed; read
     the message, fix the named command and send again with a new id.
   - Recipes pull in the recipes they require; the receipt says what came along.
   - `replace: true` (on `apply_cookbook` or `import_cookbook`) replaces the
     whole plan. Use it only when the user asked to start over.
   - To undo, send a single `undo` command with the `undoId` from a receipt.
5. **Show the plan in plain words** after each round: the app name, the menu
   (sections and items), and settings. Do not paste JSON unless asked. Ask what
   to change.
6. **Validate** with `validate_plan` before creating anything. If it is not
   valid, fix what it names (usually a recipe or field the installed packages
   do not have) and validate again. Say plainly what you could not fix.
7. **Create the project.** Ask the user which folder to create it in, as a full
   path (new or empty folder, or an existing project that already has
   `smrt.cookbook.json`). Call `apply_plan` **without** `confirm` first and
   show the user the preview (directory, packages that will be added). Only
   after they say yes, call it again with `confirm: true` and the
   `confirmCode` from that preview (the server refuses a token for another
   folder or an edited plan). Never choose the
   directory yourself, and never reuse an earlier confirmation for a
   different folder or a changed plan.
8. **Hand over.** Report the directory and the `nextSteps` the tool returned
   (install, set up, run). Packages are not installed unless the user asks;
   then pass `install: true`.

## Limits

- Plans live in the running tool server. If the host restarts it, the plan is
  gone: `export_plan` gives the cookbook text to keep, and `start_plan` begins
  anew. A project's `smrt.cookbook.json` is the durable copy.
- If a tool says the catalog is empty or a package was not found, tell the
  user; recipes from that package are unavailable until the manifests can be
  found (the server needs network access to the package registry, or the user
  can run it inside a SMRT workspace).
- You cannot see the finished app from here. Do not claim it runs until the
  user has run the next steps.
