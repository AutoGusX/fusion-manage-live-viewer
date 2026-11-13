---
name: fusion-manage-live-viewer
description: Work in Autodesk Fusion Manage (FM / Fusion PLM / PLM360) and drive the Fusion Manage live viewer, a local 3D viewer with BOM, table, notes and record panels, through the `fmv` CLI. Use this whenever the user wants to see, open, load, isolate, highlight, colour, section, explode or screenshot a model or part; asks about items, BOMs, change orders, non-conformances, revisions, workflows or attachments in Fusion Manage; wants to create or edit a PLM record, add affected items, or move a record through its workflow; refers to "this part", "what I have selected" or "the viewer"; or mentions fmv, a tenant, a workspace or a part number, even if they never say "Fusion Manage" or "viewer".
---

# Fusion Manage live viewer

`fmv` is a CLI for a small local server that holds the user's Autodesk sign-in, calls Fusion Manage (FM) for you, and drives a browser tab showing a 3D viewer plus panels (BOM, Table, Notes, Record, Activity). You run it from the shell; the user watches the tab.

The commands do the hard parts: they resolve picklist text, find required fields, read bulk results row by row and explain FM's errors. Your job is to choose the right command, work out what the user means, and report honestly. Most mistakes in this domain come from guessing: guessing which item the user meant, guessing an endpoint, or guessing that a call worked. The rules below exist to stop each of those.

## Running fmv

- If `fmv` is not on the PATH, run it as `node <plugin root>/bin/fmv.js`. The plugin root is two folders above this skill's own folder (`skills/fusion-manage-live-viewer/` → `../../bin/fmv.js`), and is also in `CLAUDE_PLUGIN_ROOT` when that is set. Node 22 or newer is required; if `node` isn't found, tell the user rather than installing it.
- First use on a machine: `fmv setup --check`. If the config is missing, the user must supply their own APS client ID and Fusion Manage tenant by running `! fmv setup` (see [troubleshooting.md](references/troubleshooting.md)). Nothing is preconfigured, and you should never suggest someone else's client ID or tenant.
- Add `--json` to anything you will parse. Errors come back as `{ok:false, error:{code, message, hint}}`; the `hint` is the next step, so read it before trying anything else.
- For JSON arguments longer than a line, write a file in the working folder and pass `--data @file.json` or `--fields @file.json`. On Windows, don't use `/tmp`: the shell and Node resolve it to different folders.
- Start of any session: `fmv status`. Then fix what it shows, yourself:
  - Server not running: `fmv start`.
  - Not signed in: run `fmv login --no-wait`. It opens the Autodesk sign-in page in the user's browser, or prints a link when it can't; pass that link on. Tell the user to finish signing in and to say when they have, then confirm with `fmv status` before carrying on. Only the sign-in itself is the user's job; don't ask them to run the command.
  - Tab closed: `fmv open`.

## Ground rules

1. **Look things up; never invent them.** Workspace, item and attachment IDs come from `fmv fm find`, `fmv fm workspaces` and `fmv fm bom`. Part names come from the BOM or the model. Don't coin your own labels for parts ("the shaft group") in panels or legends, because the user will later ask for them by that name and nothing will match.
2. **One clear match, or ask.** `fmv fm find` says `clearMatch: true` only for an exact number or a single hit. Otherwise, when what the user wants is to *see* something, prefer the candidate that has a 3D model (`hasModel`), load it, and say plainly that you chose it and why. When the choice is about a record that will change, don't load or write anything: ask. Either way, describe candidates the way a person would recognise them (workspace, what kind of record, whether it has a model, its state), and recommend one so the answer can be a yes. See [interpreting-requests.md](references/interpreting-requests.md).
3. **Name parts by number and title, every time.** Whenever you list or highlight parts (in a reply, a legend or a panel), give the part number with the title, for example `TA-1035 Turbine Axis Spacer`. Legends and labels describe what the part is or why it is shown (`NC-000042`, `Released`), never a sentence of your own.
4. **Writes to FM follow draft, confirm, write, verify.** Creating, editing, transitioning, archiving and changing affected items alter the user's company records and can notify other people. Show what you intend with `--dry-run`, wait for a clear yes, run it, then report what FM now shows. The one exception is when the user's message already gives the exact values and tells you to do it; then skip the question but still report the result. "Add a note", "flag this" and "mark it" mean the viewer unless the user names FM.
5. **Believe FM's answer, not the status code.** A bulk call can return 200 with failed rows, and a workflow can archive a record by itself. The commands read results for you; report what they say, including partial failures.
6. **Never retry a refused write.** A 400 on a transition or create is a business rule, and repeating it cannot help. Tell the user what FM said.
7. **Stay out of `~/.fusion-manage-live-viewer/`.** It holds the config, API secret and session. The CLI reads it; you never need to. Setup values are typed by the user with `! fmv setup`.
8. **Say what you could not check.** If a model has no fit data, a search may lag, or a scan was limited to some workspaces, say so in one line. A confident wrong answer about engineering data costs more than a caveat.
9. **Narrate with `fmv note "…"`** at each meaningful step, so the Activity panel tells the story as you work.

## What the user says → what to run

| The user wants | Command |
|---|---|
| Find an item, change order, NC or any record by name or number | `fmv fm find "<text>" [--ws <id>]` |
| Know which workspace holds something | `fmv fm workspaces "<part of the name>"` |
| Read a record's fields and state | `fmv fm item <ws> <item>` |
| See a model | `fmv view load --ws <ws> --item <item>` |
| See the BOM beside the model | `fmv fm bom <ws> <item> --show` (add `--depth n` for sub-levels) |
| "This part", "what I selected", "what's isolated" | `fmv view state`, then act on `focus` |
| Isolate, hide, colour, section, explode, camera | `fmv view …` (see [viewer.md](references/viewer.md)) |
| See the view yourself | `fmv screenshot --out name.png`, then Read the PNG |
| Change orders, NCs and other records tied to an item and its children | `fmv fm related <ws> <item> --scan <ws,ws>` |
| What a workspace needs before creating a record | `fmv fm describe <ws>` |
| Create a record | `fmv fm create <ws> --fields @f.json --dry-run`, then without `--dry-run` |
| Edit fields | `fmv fm update <ws> <item> --fields @f.json --dry-run`, then for real |
| Move a record through its workflow | `fmv fm transitions <ws> <item>`, then `fmv fm transition <ws> <item> "<name>"` |
| Put items on a change order | `fmv fm affected add <ws> <record> <itemWs>:<item> …` |
| Archive or restore a record | `fmv fm archive <ws> <item> [--undo]` |
| Files on an item | `fmv fm attachments <ws> <item>`, `fmv fm download …` |
| Show a table, notes or a record card | `fmv panel table|markdown|card …` |
| Anything the commands above don't cover | Raw `fmv fm GET|POST|PATCH <path>`, after reading [fm-api.md](references/fm-api.md) |

## Working out what the user means

Engineers talk about parts loosely ("the shaft", "the desktop printer", "that bracket"), and the viewer makes "this" and "it" natural. Resolve the reference before acting:

- **A product or assembly name:** `fmv fm find`. If the name isn't in any descriptor (a nickname), say so and list the closest hits.
- **A part within the loaded model:** check the BOM (`fmv fm bom`) and the model (`fmv view props --name "*word*"`). If one part matches, use it and say which you chose. If none or several match, list the real candidates by number and title.
- **"This", "the selected one", "what I isolated":** `fmv view state`. It reports what is selected, isolated, hidden and coloured. If `focus` is null, nothing identifies the part, so ask.
- **A kind of record ("NCRs", "ECOs", "deviations"):** tenants name workspaces differently. Run `fmv fm workspaces "<word>"` and confirm the workspace before scanning or creating.

Know what the viewer can and can't answer. It shows a tessellated model with properties: it can isolate, colour, section, explode, measure bounding boxes and read part properties. It has no tolerances, fits, GD&T, mating constraints or exact geometry, so it cannot tell the user whether a tolerance should change, and any interference check is approximate. Offer what is possible, and say plainly what needs the CAD model or drawing.

More examples, including how to phrase the clarifying question, are in [interpreting-requests.md](references/interpreting-requests.md). Read it when a request is ambiguous or names something you can't find.

## Matching FM items to parts in the model

The BOM gives item numbers; the model gives nodes with names and properties. They don't always line up, so go down this ladder and stop at the first step that matches:

1. `--prop "Part Number=A,B,C"`: exact, the best case. The result lists `unmatched` values.
2. `--name "A*"`: node names usually start with the number (`ASY-0005 - Base Assembly:1`). Wildcards are `*` and `?` only.
3. `fmv view property-names`: see what properties this model carries, and try the one that holds the number.
4. Tell the user those parts can't be located in this model, and name them. Don't colour a near miss.

Report matched and unmatched counts whenever you colour or isolate from a list.

## Reference files

- [viewer.md](references/viewer.md): every viewer and panel command, with JSON shapes. Read before your first viewer command in a session.
- [fm-commands.md](references/fm-commands.md): every `fmv fm` command, its output and its error codes. Read before creating, editing or transitioning records.
- [recipes.md](references/recipes.md): proven sequences for common jobs (show an item, change impact, raise a change order, related records, clean up test records).
- [interpreting-requests.md](references/interpreting-requests.md): ambiguous requests and capability limits.
- [fm-api.md](references/fm-api.md): rules for raw FM API calls when no command covers the job, and where the API documentation lives.
- [troubleshooting.md](references/troubleshooting.md): sign-in, the browser tab, translation waits, Windows shell quirks.
