# 0002 — Server, CLI and command protocol

Status: draft, awaiting review

## Runtime

- One Node process (Node 22 or newer), started with `fmv start`. **Zero npm dependencies** (decided 2026-11-12 during the build): the server and CLI use only Node built-ins, and the UI is plain ES modules served as-is with no build step. Nothing to `npm install`, nothing to bundle.
- Binds to `127.0.0.1:${FMV_PORT}` only.
- Server → browser uses **Server-Sent Events** (`GET /ui/stream`); browser → server uses same-origin `POST /ui/result` and `POST /ui/event`. This replaces the WebSocket in the first draft: there's no dependency, and the origin checks are simpler.
- `fmv start` opens the viewer in the default browser and returns once the server is healthy. `fmv stop` and `fmv status` manage it. There's no PID file: a second start finds the running server by calling `/api/status` with the secret.

## Local HTTP API

All `/api/*` calls from the CLI or `curl` need the header `X-FMV-Secret: <secret>`. The secret is generated at first start and stored in `~/.fusion-manage-live-viewer/secret` (user-only). The CLI reads it automatically.

| Endpoint | Purpose |
|---|---|
| `GET /api/status` | Server, sign-in, viewer-connected and current-model state |
| `POST /api/login`, `POST /api/logout` | Start or clear sign-in |
| `POST /api/fm` | Proxy an FM call: `{method, path, query?, body?, accept?}`. The path must start with `/api/v3/`; host is fixed to `FM_BASE_URL`. |
| `POST /api/fm/download` | Download an attachment to a path the caller names |
| `POST /api/view` | Send a viewer command (see below); waits for the browser's result |
| `POST /api/panel` | Push panel content |
| `GET /api/events?since=<id>&wait=<s>` | Long-poll viewer events (selection, errors, user actions) |
| `GET /api/screenshot` | Capture the current view as PNG; returns a file path |

Every response is JSON: `{ok: true, result}` or `{ok: false, error: {code, message, hint}}`. Error codes are stable and documented (`AUTH_REQUIRED`, `VIEWER_NOT_CONNECTED`, `MODEL_NOT_LOADED`, `NOT_TRANSLATED_YET`, `FM_FORBIDDEN`, `NOT_FOUND`, `INVALID_COMMAND`, `TIMEOUT`, …). `hint` is a plain-language next step Claude can relay to the user.

## CLI (`fmv`)

The CLI is a thin client over the HTTP API, with human-readable output by default and `--json` for Claude.

```
fmv setup [--check]
fmv start | stop | status
fmv login | logout
fmv fm <METHOD> <path> [--data <json>|@file] [--accept <type>]
fmv fm download <ws> <item> <attachment> <outfile>
fmv view load --ws <ws> --item <item> --attachment <att> | --urn <urn>
fmv view fit | reset | isolate | hide | show | ghost | color | clear-color
fmv view section --plane x|y|z [--offset <n>] | section --off
fmv view explode <0..1>
fmv view camera <named-view|--eye x,y,z --target x,y,z>
fmv view select <ids…>
fmv view screenshot [--out <file>]
fmv panel bom|table|markdown|card|log --data <json>|@file [--title <t>]
fmv events [--wait <s>]
```

Part targeting: any viewer command that takes parts accepts `--dbid`, `--name <pattern>` or `--prop <name>=<value>` (for example `--prop "Part Number=100-2231"`). The viewer resolves these with the APS property database and returns the matched count, so Claude knows whether the mapping worked.

## Viewer commands (browser side)

- Typed, schema-validated JSON: `{id, command, args}` → `{id, ok, result|error}`. Unknown commands and bad arguments are rejected before they reach the viewer.
- v1 commands: `load`, `fit`, `reset`, `isolate`, `hide`, `show`, `ghost`, `color`, `clearColor`, `section`, `explode`, `camera`, `select`, `screenshot`, `getSelection`, `getProperties`.
- `load` resolves an FM attachment via `GET …/attachments/{att}` with `Accept: application/vnd.autodesk.plm.attachment.viewable+json`. While the status is `REGISTERING`, it polls and reports progress to the panel and to Claude (`NOT_TRANSLATED_YET` with an ETA hint if it doesn't finish within the command timeout).
- No arbitrary JavaScript. An `eval` command exists only when the server is started with `--unsafe-eval`, and the viewer shows a persistent warning banner while it's enabled.

## Panels

| Panel | Content | Interaction |
|---|---|---|
| BOM tree | FM BOM rows (number, title, quantity, state) | Click a row → isolate the matching parts; emits a selection event |
| Table | Generic columns and rows | Sort, filter, row click → event |
| Markdown | Notes, summaries, step lists | Sanitized; links open in a new tab |
| Record card | One FM item's key fields and state | — |
| Activity log | Every command and FM call (method, path, status, duration), newest first | Shows what Claude did; nothing secret is logged |

Panels dock to the right and bottom, can be resized and collapsed, and follow the Fusion light and dark themes.

## Events

- Browser → server: `selection` (dbIds plus resolved part properties), `panelClick`, `modelLoaded`, `error`.
- Kept in a ring buffer of 500. Claude reads them with `fmv events --wait 30` (long poll). Claude can't be interrupted by a click, so the skill tells it to check events when the user says they've selected something.

## Timeouts

Viewer commands: 15 s by default, `load` 180 s, configurable per call. FM proxy: 60 s. Downloads: no hard timeout, with progress in the activity log.
