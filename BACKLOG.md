# Backlog

## Now: v0.1 live verification (2026-11-12)

- [x] Callback registered; `fmv login` signed in (2026-11-12)
- [x] `fmv fm GET /api/v3/workspaces` → 200, 127 workspaces
- [x] `fmv view load` renders real FM assemblies (Assembled Printer, Turbine Assembly .iam.dwf) with the user's own client ID — spec 0001 open question closed
- [x] Every viewer command driven once against the Turbine Assembly (isolate/hide/show/ghost/color+legend/section/explode/camera/select/selection/props/property-names/screenshot)
- [x] Panels with real FM data: BOM from the live FM BOM (row click isolates by Part Number), card, notes, activity
- [ ] Maintainer: look over the staged demo in the tab (BOM wrap + legend position changed after the last screenshot)

Fixed during live verification: Git Bash rewrote `/api/v3/…` arguments into Windows paths (CLI now undoes it); `enumNodeChildren` stops on a truthy callback return, which truncated the part tree to 1–2 nodes; legend moved off the viewer toolbar; long BOM numbers wrap.

## Built (v0.1.0, 2026-11-12)

- [x] Config loader, `fmv setup` (interactive + flags) and `setup --check` with masked values (spec 0001)
- [x] PKCE sign-in via the loopback `/callback`, single-use state, rotating refresh token, optional session cache, `logout` with revoke
- [x] Local server: loopback only, Host check, per-install API secret, page cookie + Origin checks, CSP, redacted logs
- [x] FM proxy `fmv fm` with a path guard (tenant host, `/api/v3` or `/api/v2` only), 401 → refresh → retry, "client not allowed" hint
- [x] `fmv fm attachments`, `fmv fm download` (pre-signed S3, no auth, no overwrite without `--force`)
- [x] `fmv view load` from an FM attachment via the viewable endpoint (picks the first CAD file, polls while FM translates)
- [x] Viewer commands: fit, reset, isolate, hide, show, ghost, color (groups + legend), clear-color, section, explode, camera, select, selection, props, property-names, screenshot
- [x] Part targeting by property (exact, case-insensitive, reports unmatched), name (wildcards) or dbId
- [x] Panels: BOM (row click isolates by `matchProperty`), table (sort/filter), safe markdown, record card, activity log; Fusion light/dark theme; resizable dock
- [x] Events: selection, panelClick, modelLoaded; `fmv events --wait`
- [x] `--unsafe-eval` escape hatch (off by default; CSP relaxed only then; banner shown)
- [x] `skills/…/SKILL.md`, `INSTALL.md`, README
- [x] 28 tests (unit + integration against stub APS/FM with a simulated browser tab)

## Next

- [ ] Playwright end-to-end tests of the real UI with a stubbed `Autodesk.Viewing` (panels, command dispatch, legend)
- [ ] CI on Windows/macOS/Ubuntu (`npm test`)
- [ ] Pin the APS Viewer version (currently `7.*`) once a known-good version is confirmed live
- [ ] `/security-review` pass (release gate for v1)
- [ ] Public-release approval, history secret scan, license confirmation (currently UNLICENSED), then create the GitHub repo and flip it public

## Ideas (not committed)

- Profiles for multiple tenants (`.env.<profile>`, loader ready)
- OS keychain for the refresh token
- Local-file fallback for glTF/STEP/STL
- Read-only markups overlay (FM markups API is known)
- Multiple models side by side (compare revisions)

## Decisions log

- 2026-11-12: No MCP; Claude drives via the `fmv` CLI and localhost HTTP. One local Node server owns auth, the FM proxy and the viewer relay.
- 2026-11-12: Bring your own APS client ID (PKCE, no secret). Config in `~/.fusion-manage-live-viewer/.env`, never in the repo.
- 2026-11-12: Models come from FM's attachment viewable endpoint (FM's own derivatives), not downloads plus Model Derivative.
- 2026-11-12: Fixed default port 4710 because the APS callback URL must match exactly.
- 2026-11-12 (build): Zero npm dependencies and no UI build step; SSE + POST instead of WebSocket; install = `git clone`. Node 22+.
- 2026-11-12 (build): Default scopes `data:read data:write data:create data:search` so Claude can write to FM.

## 2026-11-13: plugin packaging and public release

- [x] High-level `fmv fm` operations, `fmv view state`, restructured skill with references (see the decisions log)
- [x] Packaged as a Claude Code plugin (`.claude-plugin/`, `skills/fusion-manage-live-viewer/`)
- [x] Example IDs in docs and tests made generic; tenant-specific eval cases kept out of the repo
- [x] MIT license, copyright Autodesk, Inc. (2026-11-13)
- [ ] Generic eval cases that run against any tenant
- [ ] Trigger test for the skill description (the automated loop gave no signal on Claude Code 2.1.323)
