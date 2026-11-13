# Fusion Manage commands (`fmv fm …`)

These commands wrap call sequences that were verified against a live tenant. Prefer them to raw API calls: they handle the response shapes, link formats and error cases that are easy to get wrong by hand.

## Contents
- Finding things
- Reading records
- Related records
- Creating and editing
- Workflow transitions
- Affected items on a change
- Archiving
- Error codes

IDs are always `<workspace> <item>` as two arguments, or `<workspace>:<item>` when listing several items.

## Finding things

```bash
fmv fm find "turbine assembly" [--ws 57] [--limit 10]
fmv fm workspaces ["conform"]
```

`find` returns `results` (each with `ws`, `item`, `workspace`, `descriptor`, `number`, `title`, and for the top six `hasModel` and `model`, the first CAD file) and `clearMatch`.

- `clearMatch: true`: an exact number or descriptor match, or the only hit. Use it.
- `clearMatch: false`: show the top three to five to the user and ask. Results from several workspaces are normal: a part number also appears in the titles of change orders that mention it, so read the `workspace` column.
- `count: 0`: try the part number, fewer words, or no `--ws`. Nicknames often aren't in FM at all.

Search has two quirks: it can lag a few minutes behind edits, and it can still list archived records. When that matters, confirm with `fmv fm item`.

`workspaces` lists workspace IDs and names, filtered by text. Workspace names and IDs differ on every tenant, so look them up; don't reuse IDs from another session or from examples.

## Reading records

```bash
fmv fm item 84 5001
fmv fm bom 57 1001 [--depth 3] [--show]
fmv fm attachments 57 1001
fmv fm download 57 1001 301 [outfile] [--force]
```

`item` returns `title`, `state` (workflow state), `lifecycle`, `deleted`, `locked`, `url` (the link to open it in FM; give this to the user) and `fields` keyed by field ID with readable values.

`bom` returns `rows`: `level`, `number`, `title`, `quantity`, `state`, `revision`, `ws`, `item`. Quantity and state come from the BOM view's own columns. `number` is the first part of the item descriptor when that looks like a number; for items whose descriptor has no number (standard hardware, often), `number` is the whole descriptor. `--show` also pushes the BOM to the viewer's BOM panel. Depth defaults to 1; large assemblies at depth 10 can be hundreds of rows, so only go deep when asked.

## Related records

```bash
fmv fm related 57 1002 --scan 98,84 [--depth 10] [--no-revisions]
```

For an item and every item in its BOM, this finds:

- `changes`: change orders and other workflow records that list any of those items as affected.
- `relationships`: records linked on the Relationships tab.
- `references`: records in the `--scan` workspaces whose fields point at any of those items. This is how non-conformances, CAPAs, problem reports and similar records are found, because FM has no reverse lookup for them.

Each entry has `record`, `state`, `workspace`, `url`, `deleted` and `bomItems` (which parts it concerns).

Things to know:

- Without `--scan`, only changes and relationships are checked. Find the right workspaces first (`fmv fm workspaces "conform"`, `"corrective"`, `"problem"`), and tell the user which ones you scanned.
- Older revisions are included by default, because records often point at the revision that was current when they were raised. `revisionsChecked` shows how many item versions were covered.
- It takes about 30 seconds for a few hundred items. Say so before you start.
- A scan reads up to 1,000 records per workspace; `truncated: true` means there were more.
- Report archived records (`deleted: true`) separately or leave them out; don't mix them in unmarked.

## Creating and editing

Always start from what the workspace needs:

```bash
fmv fm describe 84
fmv fm options 84 PRIORITY [--filter "text"]
```

`describe` returns `required` (field IDs), `writableFields` (ID, name, type, section, and the options for required picklists), `derivedFields` and the workspace's `workflowTransitions`.

```bash
fmv fm create 84 --fields @co.json --dry-run
fmv fm create 84 --fields @co.json
fmv fm update 84 5001 --fields '{"priority":"high"}' --dry-run
fmv fm update 84 5001 --fields '{"priority":"high"}'
```

`--fields` is a JSON object of field → value:

```json
{"TITLE": "Review fit of axis spacer", "DESCRIPTION": "Raised in design review.", "Change Template": "No Approvers", "priority": "medium"}
```

- Keys can be the field ID or its display name, in any case. A unique partial name also works (`"reason code"`).
- Picklist values are the option's text. An exact match wins; otherwise a unique partial match is used. No match or several matches is an error that lists the options, so you can ask the user.
- Multiple-selection fields take an array of option texts.
- Leave out system fields (auto numbers, derived fields). `create` fills derived fields that FM demands and lists them in `derivedFilled`.

What happens:

- `--dry-run` returns `wouldCreate` / `wouldChange` with readable values and sends nothing. Show this to the user as the draft.
- `create` returns `item`, `title` (with its new number), `state` and `url`.
- `update` uses PATCH, so fields you don't mention are untouched. It returns each field's `from` and `to` as read back from FM.
- If a required field is missing, nothing is sent: the error is `MISSING_REQUIRED` with a `missing` list, including options. Ask the user for those values; don't fill them with guesses. A template, approver list or owner changes who gets notified.

## Workflow transitions

```bash
fmv fm transitions 84 5001
fmv fm transition 84 5001 "Submit to CCB" [--comment "text"] [--dry-run]
```

`transitions` lists what is available from the record's current state for this user: `name`, `to` (the state it leads to) and whether a `comment` is `REQUIRED`.

`transition` matches by name (exact, then unique partial, then by target state) and returns `from` and `to` as read back from FM.

- Transitions can lock the record, start approvals and email people. Treat every one as a write that needs the user's yes, and prefer `--dry-run` first.
- `COMMENT_REQUIRED`: ask the user for the comment text.
- `TRANSITION_REFUSED`: a rule on the workflow blocked it (for example "Change tasks must be defined first"). Report FM's message as written. The record hasn't changed, and retrying won't help.
- Some transitions have side effects. On some tenants a cancel transition also archives the record. After any transition, trust the `to` state and `fmv fm item`, not assumptions.

## Affected items on a change

```bash
fmv fm affected list 84 5001
fmv fm affected add 84 5001 57:1011 57:1012 [--dry-run]
fmv fm affected remove 84 5001 57:1011
fmv fm affected transitions 84 5001 57:1011
fmv fm affected set 84 5001 57:1011 --transition "Release to Production" [--dry-run]
```

- `add` reports each row. `added` and `failed` are counts; a failed row carries `error`, and when the item is already on another change, `heldBy` names that record, its state and whether it is archived.
- An item can be on only one open change at a time, and an archived change still holds its items. When `heldBy` appears, tell the user which record holds the part and ask before removing it from there. If that record is one you created for practice in this session, removing it is fine.
- `add` refuses archived or missing items and archived change records, because FM would accept them silently and nothing would appear.
- `set` chooses the lifecycle transition the change will apply to that item when it completes (for example moving it to a released revision). The names differ by the item's current state, so run `affected transitions` first. Only set this when the user asks for a release path.

## Archiving

```bash
fmv fm archive 84 5002 [--undo]
```

FM has no hard delete; archiving hides the record and `--undo` restores it. The command checks the record before and after, and returns `alreadyDone: true` when there was nothing to do.

When you create practice or test records, title them `ZZZ-TEST-DELETE-ME - …`, remove any affected items, and archive them before you finish. Tell the user which records you created and that they're archived.

## Error codes

| Code | Meaning | What to do |
|---|---|---|
| `AUTH_REQUIRED` | Not signed in, or the session ended | `fmv login`; the user signs in in the browser |
| `FM_CLIENT_NOT_ALLOWED` | FM refused the token | Usually the APS client ID isn't on the tenant's allowed list; the hint has the admin link. Otherwise `fmv login` |
| `FM_FORBIDDEN` | The user's FM account lacks permission | Tell the user which workspace or record; don't look for a way round |
| `NOT_FOUND` | Wrong workspace, item or attachment ID | Re-find the record with `fmv fm find` |
| `UNKNOWN_FIELD` | No such field in the workspace | Use the suggestion in the hint, or `fmv fm describe` |
| `FIELD_NOT_WRITABLE` | System-managed or not on the details form | Leave it out |
| `INVALID_OPTION` / `AMBIGUOUS_OPTION` | Picklist text matched nothing, or several | Offer the listed options to the user |
| `MISSING_REQUIRED` | Required fields not supplied | Ask the user for each (options are in `missing`) |
| `FM_VALIDATION` | FM rejected the values | The message names the field and the rule; fix and retry once |
| `COMMENT_REQUIRED` | The transition needs a comment | Ask the user for it |
| `TRANSITION_REFUSED` | A workflow rule blocked it | Report the message; don't retry |
| `RECORD_ARCHIVED` | Target record is archived | Restore it or use another record |
| `TIMEOUT` / `FM_NETWORK` | FM didn't answer | Safe to retry reads. For a write, check with `fmv fm item` or `fmv fm find` whether it applied before sending again |
| `INVALID_PATH` | A raw call left the tenant API | Use a path that starts `/api/v3/` |
