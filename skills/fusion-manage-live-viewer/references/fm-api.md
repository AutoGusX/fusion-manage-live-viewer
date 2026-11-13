# Raw Fusion Manage API calls

Use raw calls only when no `fmv fm` command covers the job (grids, BOM edits, milestones, relationships, classifications, reports, users, and so on).

```bash
fmv fm GET /api/v3/workspaces/57/items/1001/views/10 --json
fmv fm POST <path> --data @body.json [--accept <media type>] [--query key=value]
```

The result is `{status, headers, contentType, body}`. Exit code 2 means FM answered 400 or more; the body is FM's own message. Paths must start with `/api/v3/` (or `/api/v2/`); the tenant and token are added for you.

## Contents
- Before you call something new
- Rules that hold across the API
- Response shapes that surprise
- Reading errors
- Endpoints verified live

## Before you call something new

Don't guess endpoints or payloads. FM's API is inconsistent between areas, its error messages rarely say what was wrong with a payload, and a wrong write can still partly apply. In one session, eight guessed payloads for one call all failed, and the documentation had the answer in one line.

1. Read the documentation first: **https://autogusx.github.io/fusion-manage-plm-docs/** (an `llms.txt` index is at the site root). It marks what was confirmed on a live tenant and where Autodesk's own examples are wrong. Fetch the page for the area you need.
2. Look at how an existing record does it: `GET` a record that already has the thing (a grid row, a relationship, a BOM line) and copy its shape.
3. Try reads freely. For a write, try it once on a practice record (`ZZZ-TEST-DELETE-ME`, with the user's agreement), and if it fails twice, stop and tell the user what you tried and what FM said.

## Rules that hold across the API

- **Never `PUT` an item.** PUT replaces the whole record and clears every field you leave out. Use `fmv fm update`, or PATCH.
- **Create uses workspace-scoped links; PATCH uses the item's own links.**
  Create: `/api/v3/workspaces/{ws}/sections/{s}` and `/api/v3/workspaces/{ws}/views/{v}/fields/{F}`.
  PATCH: `/api/v3/workspaces/{ws}/items/{id}/views/{v}/sections/{s}` and `…/items/{id}/views/{v}/fields/{F}`.
  Each field is exactly `{"__self__": "<link>", "value": …}`.
- **Picklist values are link objects**: `{"link": "/api/v3/lookups/<LOOKUP>/options/<n>"}` or an item link; multi-select is an array of them.
- **Bulk array bodies need absolute URLs** (`https://{tenant}.autodeskplm360.net/api/v3/…`), plus the matching bulk `Accept`. Relative paths give `GEN_INVALID_INPUT_SCHEMA "Incorrect payload"` or "Value of URI null". This applies to affected items and grid rows.
- **Bulk results are per row.** A 200 can contain `"result": "FAILED"` rows with an `errorMessage`. Read every row.
- **Default `Accept` is `application/json`.** Some lists need a bulk media type to return full data: attachments (`application/vnd.autodesk.plm.attachments.bulk+json`), BOM (`application/vnd.autodesk.plm.bom.bulk+json`), affected items (`application/vnd.autodesk.plm.affected.items.bulk+json`). Bulk types are for `Accept` only, never `Content-Type`.
- **No hard delete.** `PATCH …/items/{id}?deleted=true` archives and `?deleted=false` restores. `DELETE` on an item is 405.
- **Don't hard-code IDs.** Workspace, view, section and field IDs differ per tenant. `GET /api/v3/workspaces/{ws}/views` lists views with their numbers and titles; `fmv fm describe` lists fields.
- **Lists are paged** with `offset` and `limit` (100 is a safe page) and return `totalCount`; a short page is the end.
- **Two kinds of transition.** Workflow transitions (v3, JSON, `content-location` header, success is 303) move a record between workflow states: use `fmv fm transition`. Lifecycle transitions (release state and revision) are applied through a change's affected items: use `fmv fm affected set`.

## Response shapes that surprise

| Call | What comes back |
|---|---|
| Any list or search with no results | `204` and an empty body, not an empty array |
| Create | `201`, empty body; the new record's link is in the `Location` header |
| PATCH, PUT, DELETE, archive | `204`, empty body: re-read the record to confirm |
| Workflow transition | `303` on success |
| `GET …/items/{id}/views/2` | A bare array of the changes that list this item |
| `GET …/items/{id}/views/11` | `{affectedItems: […]}` on a change record |
| `GET …/items/{id}/views/10` | A bare array of relationships |
| `views/2` on a change, `views/11` on a plain item | `403`. It means "this tab doesn't apply here", not a permissions problem; treat as empty |
| `GET /api/v3/lookups/{id}` | `{items: [{link, title}]}` |
| `GET …/attachments/{id}` with default Accept | Only `fileUrl` and thumbnails; names and versions come from the list |
| Required picklist fields | Marked by a `dropDownSelection` validator, not `required` |

## Reading errors

FM uses several error shapes; check for each:

- `{statusCode, errors: ["NOT_FOUND"], message}`: the common v3 shape. `message` is the useful part.
- An array of `{message, code, arguments, field}`: field validation on create and update. Replace `{0}` in `message` with `arguments[0]`. `error.derived.invalidDerivedFieldValue` means a derived field must be sent with the value FM computed (given in `arguments`).
- `{errorCode, message, errorClass}` with "Unknown error" or "Incorrect payload": the payload shape is wrong. Check link scoping and absolute URLs before anything else.
- An HTML page: a v1 endpoint rejected the request.

What statuses usually mean here:

| Status | Usual cause |
|---|---|
| 400 | Payload shape, a missing required field, or a business rule (the message says which) |
| 401 | Session expired, or the client ID isn't allowed on the tenant |
| 403 | Missing permission, or a tab that doesn't apply to this record type |
| 404 | Wrong ID, wrong path, or the record's state no longer allows the action |
| 405 | That verb isn't supported there (for example DELETE on an item) |
| 409 | The record moved on; re-read it |
| 415 | A bulk media type was sent as `Content-Type` |

Retry rules: reads may be retried. A write that failed with a 4xx should not be repeated unchanged. A write that timed out or returned 5xx may have applied, so re-read the record before sending it again; creating twice makes duplicates.

## Endpoints verified live

| Purpose | Call |
|---|---|
| Workspaces | `GET /api/v3/workspaces?limit=500` |
| Items in a workspace | `GET /api/v3/workspaces/{ws}/items?offset=&limit=` |
| Search | `GET /api/v3/search-results?query=&limit=&offset=&revision=1` (`AND (workspaceId={ws})` scopes it) |
| Item | `GET /api/v3/workspaces/{ws}/items/{id}` |
| Item revisions | `GET /api/v3/workspaces/{ws}/items/{id}/versions` |
| Workspace fields (with validators) | `GET /api/v3/workspaces/{ws}/fields` |
| Sections | `GET /api/v3/workspaces/{ws}/sections`, `…/sections/{s}` |
| Views (tabs) | `GET /api/v3/workspaces/{ws}/views` |
| BOM | `GET …/items/{id}/bom?depth=n` with the BOM bulk Accept; columns from `…/views/5/viewdef/{n}/fields` |
| Where used | `GET …/items/{id}/where-used?depth=n` |
| Attachments | `GET …/items/{id}/attachments?asc=name` with the attachments bulk Accept |
| Viewable for the 3D viewer | `GET …/attachments/{att}` with `Accept: application/vnd.autodesk.plm.attachment.viewable+json` |
| Workflow transitions available | `GET …/items/{id}/workflows/1/transitions` |
| Workflow history | `GET …/items/{id}/workflows/1/history` |
| Change log | `GET …/items/{id}/logs?offset=&limit=` |
