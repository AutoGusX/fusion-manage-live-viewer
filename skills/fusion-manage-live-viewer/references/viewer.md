# Viewer and panel commands

All commands act on the browser tab that connected most recently. Results include a `summary`; part commands also include `matched` and, for property matches, `unmatched`.

## Contents
- Loading a model
- Choosing parts
- View commands
- Reading the view
- Panels
- Events from the user

## Loading a model

```bash
fmv view load --ws 57 --item 1001                  # first CAD attachment on the item
fmv view load --ws 57 --item 1001 --attachment 301
```

The viewer shows Fusion Manage's own derivative of the attachment: nothing is uploaded and nothing is charged.

| Result | Meaning | What to do |
|---|---|---|
| `{parts: n, source: {...}}` | Loaded | Carry on. `parts` is the number of leaf parts. |
| `NOT_FOUND` with `attachments` | The item has no CAD file | Show the list; ask which file, or which other item has the model. |
| `NOT_TRANSLATED_YET` | FM is still preparing the file (large models take minutes) | Tell the user, wait, run the same command again. |
| `NOT_VIEWABLE` | A document (PDF, Office), not a model | Offer `fmv fm download` instead. |
| `VIEWER_NOT_CONNECTED` | The tab is closed | `fmv open`, then retry. |

Loading replaces the current model and clears colours and sections. Panels keep their content, so refresh or clear them (`fmv panel clear`) when the subject changes.

## Choosing parts

Every part command takes exactly one of:

| Flag | Matches |
|---|---|
| `--prop "Part Number=100-2231,100-2232"` | Exact property value, case-insensitive. Use `Name=…` for exact node names. |
| `--name "Bolt*"` | Node name. With `*` or `?` it must match the whole name; without, it is a contains-match. No `[abc]` classes. |
| `--dbid 12,15` | Viewer IDs from earlier results. |
| `--all` | Everything. |
| `--targets @t.json` | The same as JSON: `{"prop":{"name":"Part Number","values":["A"]}}`, `{"name":"Bolt*"}`, `{"dbids":[1,2]}`. |

A match on an assembly node covers its children. `matched: 0` comes with a hint; follow the matching ladder in SKILL.md rather than retrying variations blindly.

## View commands

```bash
fmv view isolate <parts>            # show only these; the rest is ghosted if ghosting is on
fmv view hide <parts>
fmv view show <parts> | --all
fmv view ghost [--off]              # ghosting on: hidden parts stay as faint outlines
fmv view fit [<parts>]              # zoom to parts, or to everything
fmv view select <parts>             # highlight; with no parts, clears the selection
fmv view color --color "#e8a33d" <parts> [--label "In change"]
fmv view color --data @groups.json  # several colours at once, with a legend
fmv view clear-color
fmv view section x|y|z [--offset -1..1] [--flip]   # offset is a fraction of the model's size; 0 = middle
fmv view section off
fmv view explode 0..1               # 0.2 to 0.4 separates parts without losing the shape
fmv view camera home|front|back|left|right|top|bottom|iso
fmv view camera --eye x,y,z --target x,y,z
fmv view reset                      # show all, clear colours, section, explode and selection, fit
```

`groups.json` for colouring:

```json
{"groups": [
  {"color": "#b3261e", "label": "Open NC", "targets": {"prop": {"name": "Part Number", "values": ["ASY-0005"]}}},
  {"color": "#2c7a3a", "label": "Released", "targets": {"name": "MCH-*"}}
]}
```

Labels appear in the on-screen legend with their match counts, so write them as the user would say them (a record number, a state), not as internal shorthand.

Good defaults when the user says "make it clearer": isolate the parts of interest with ghosting on, colour them by meaning with a legend, explode about 0.3 if they overlap, `camera iso`, then `fit` to them. A section through the middle of a small part usually hides it; take a screenshot and check before leaving it on.

## Reading the view

```bash
fmv view state                      # isolated, hidden, selected (with names and part numbers), colours, explode, section, focus
fmv view selection                  # selected parts with all their properties
fmv view props <parts> [--properties "Material,Mass"] [--limit n]
fmv view property-names             # which properties this model has, with example values
fmv screenshot [--out file.png] [--force]
```

`state.focus` is `selected`, `isolated` or `null`. Use it to resolve "this part". After any change you're unsure about, take a screenshot and Read it: you can see the result the same way the user does.

## Panels

```bash
fmv fm bom 57 1001 --show [--depth 2] [--title "…"]     # reads the FM BOM and shows it; rows click through to parts
fmv panel bom --data @bom.json --title "…"               # your own rows
fmv panel table --title "Open changes" --data @table.json
fmv panel markdown --title "Summary" --file notes.md     # or --text "## Heading\n- point"
fmv panel card --data @card.json
fmv panel clear [bom|table|markdown|card]
fmv note "Created CO-000123"                             # one line in the Activity panel
```

Shapes:

`bom.json` (`color` is optional and shows a swatch on the row):

```json
{"matchProperty": "Part Number", "rows": [{"level": 0, "number": "GB-100", "title": "Gearbox", "quantity": 1, "state": "Released", "color": "#2c7a3a"}]}
```

`table.json` (rows may be arrays in column order, or objects keyed by column):

```json
{"columns": ["Record", "State", "Item"], "rows": [["NC-000042", "Under Review", "ASY-0005"]]}
```

`card.json` (`link` must be http(s); use the `url` returned by `fmv fm item` or `create`):

```json
{"title": "CO-000123 - Review fit", "subtitle": "Change Orders", "state": "Preparation", "fields": [{"label": "Priority", "value": "2 / Medium"}], "link": "https://…"}
```

A pushed panel takes focus; add `--no-focus` to update one quietly. Clicking a BOM row isolates the matching parts (by `matchProperty`, else by name) and emits a `panelClick` event. Keep panels truthful: when you colour parts in the model, give the BOM rows the same colours, and clear stale panels when the topic changes.

Notes render a safe subset of markdown: headings, lists, bold, italic, code, tables and http(s) links.

## Events from the user

```bash
fmv events --since <last id> --wait 30 --json
```

Returns `selection`, `panelClick` and `modelLoaded` events and a `last` ID to pass next time. A click does not interrupt you: when the user says "I've picked it" or "this one", read `fmv view state` or `fmv events`.
