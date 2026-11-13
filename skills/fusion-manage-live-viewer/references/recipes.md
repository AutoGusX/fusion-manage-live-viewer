# Recipes

Sequences that have been run end to end against a live tenant. IDs below are placeholders: look up the real ones each time.

## Contents
- Show an item with its model, BOM and record card
- Highlight parts by a meaning (state, change, NC)
- Find everything related to an assembly
- Raise a change order for parts in view
- Move a record through its workflow
- "What is this part?"
- Practice runs and cleanup

## Show an item with its model, BOM and record card

```bash
fmv fm find "turbine assembly" --json          # resolve; ask if clearMatch is false
fmv note "Loading TA-1008 Turbine Assembly"
fmv view load --ws 57 --item 1001 --json
fmv fm bom 57 1001 --show
fmv fm item 57 1001 --json                    # fields, state, url for the card
fmv panel card --data @card.json
fmv view camera iso
```

If `load` returns `NOT_FOUND` with an attachment list, the item has no model. Child assemblies often do: check `fmv fm bom` and offer to load one of those.

## Highlight parts by a meaning (state, change, NC)

1. Get the list of items and what they mean (from `fmv fm bom`, `fmv fm related` or `fmv fm affected list`).
2. Group them and write `groups.json`, one group per meaning, with labels the user would recognise (`"NC-000042: Base Sub Assembly"`, `"Working"`).
3. Match parts with the ladder in SKILL.md: try `Part Number`, then name prefixes.

```bash
fmv view isolate --prop "Part Number=A,B,C"    # or --name "A*" per part if the model has no part numbers
fmv view ghost
fmv view color --data @groups.json --json      # read matched/unmatched per group
fmv view fit --prop "Part Number=A,B,C"
fmv screenshot --out check.png                 # Read it: is the result readable?
```

4. Mirror the colours on the BOM rows (`color` on each row) or list them in a table panel, so the panel and the model agree.
5. Tell the user which parts could not be located in the model.

When each group needs name matching, use one group per part with `{"name": "ASY-0005*"}` targets.

## Find everything related to an assembly

```bash
fmv fm workspaces "conform" --json             # find the NC workspace; repeat for "corrective", "problem", "change"
fmv note "Checking the BOM for related change orders and non-conformances"
fmv fm related 57 1002 --scan 98,84 --json     # about 30 s for a few hundred items
```

Then:

- Put the results in a table panel: record, type, state, BOM item.
- Highlight the affected parts (recipe above), one colour per record or per record type.
- In your answer, give counts by type, list each record with its state and the part it concerns, name the workspaces you scanned, and note that archived records were left out (or listed separately).

If the user asks for "change orders and NCRs" and the tenant has several candidate workspaces (Change Orders, Change Requests, Problem Reports, Non Conformances, CAPA), scan the ones that match their words and say which you included.

## Raise a change order for parts in view

```bash
fmv view state --json                          # which parts are in focus
fmv fm bom 57 1001 --json                     # map part numbers to item IDs (ws:item)
fmv fm workspaces "change" --json              # find the change order workspace
fmv fm describe 84 --json                      # required fields and their options
```

Ask the user for anything required that they haven't given (title, template, and so on), offering the options. Then:

```bash
fmv fm create 84 --fields @co.json --dry-run --json     # show the draft, wait for yes
fmv fm create 84 --fields @co.json --json               # → item, title with number, url
fmv fm affected add 84 <co> 57:1011 57:1012 --json    # read added / failed / heldBy
fmv fm affected list 84 <co> --json                     # confirm what FM now shows
fmv fm item 84 <co> --json
fmv panel card --data @co-card.json                     # title, state, key fields, link = url
fmv note "Created CO-000123 with 4 affected items"
```

Give the user the record number, state, affected items and the `url`.

If some rows fail with `heldBy`, the change order still exists. Report which parts were added, which weren't and which record holds them, then ask how to proceed. Don't remove parts from someone else's change order unprompted.

If the user gave every value and said to create it, skip the confirmation question, but still show what was created.

## Move a record through its workflow

```bash
fmv fm transitions 84 5001 --json                       # what is possible from here
fmv fm transition 84 5001 "Submit to CCB" --dry-run     # show from → to, wait for yes
fmv fm transition 84 5001 "Submit to CCB" --json
```

Tell the user the new state. If FM refuses, quote its message; it usually names what is missing (tasks, approvers, a comment).

## "What is this part?"

```bash
fmv view state --json                          # the selected part's name and part number
fmv view selection --json                      # all its model properties
fmv fm find "<part number>" --json             # its FM record
fmv fm item <ws> <item> --json
fmv panel card --data @part-card.json
```

If nothing is selected, ask the user to click the part. If the part has no part number, search FM by its name.

## Practice runs and cleanup

Use a practice record when you need to learn how a workspace behaves before doing the real thing, and only with the user's agreement.

- Title it `ZZZ-TEST-DELETE-ME - <purpose>`. Choose a template or path with no approvers if one exists.
- Before archiving, remove its affected items (`fmv fm affected list`, then `remove`). An archived change keeps holding its items and blocks them from the real change order.
- Archive it (`fmv fm archive`), or cancel it if the workflow archives on cancel, and check `deleted: true` with `fmv fm item`.
- Don't test on real items when a throwaway will do, and don't leave a real item attached to a practice record.
- End by telling the user what you created and that it is archived.

To reset the viewer between topics: `fmv view reset`, `fmv panel clear`.
