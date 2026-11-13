# 0003 — Install flow, security and release

Status: draft, awaiting review

## Install flow (driven by Claude Code)

The user says: "Install the Fusion Manage live viewer from github.com/AutoGusX/fusion-manage-live-viewer."

`INSTALL.md` is written for Claude to follow, step by step:

1. Check that Node 22 or newer is available (`node --version`). If not, tell the user how to install it. Don't install it silently.
2. `git clone` the repo. Because there are zero dependencies and no build step (decided 2026-11-12), the clone is the install: no release zip, no `npm ci`.
3. Put `fmv` on the PATH with `npm link` (with the user's OK), or call `node <folder>/bin/fmv.js`.
4. Ask the user to run `! fmv setup` themselves, then walk them through the printed APS app checklist.
5. Run `fmv start`, then `fmv login`. The user signs in through the browser.
6. Run `fmv status` and a smoke test (`fmv fm GET /api/v3/workspaces` and an empty viewer render).
7. Copy the bundled skill to `~/.claude/skills/fusion-manage-live-viewer/` so future sessions know the commands, and confirm with the user before writing there.

Upgrade: `git pull`, then `fmv stop` and `fmv start`. `.env`, `secret` and `session.json` live in the config directory and are untouched.

## Bundled skill (`skills/fusion-manage-live-viewer/SKILL.md`)

Teaches Claude:
- the command vocabulary and the `--json` output shapes;
- the standard flows (load an item's model, map an FM BOM to parts by property, color by lifecycle state, section and screenshot, show a summary panel);
- the rules: prefer `fmv fm` over raw `curl`, never read files in the config directory, check `fmv events` when the user says they've picked something, and relay `hint` text on errors.

## Security model

Threat: other software or web pages on the same machine, and accidental leaks into transcripts or git.

| Control | Detail |
|---|---|
| Loopback only | Bind `127.0.0.1`; refuse any other `Host` header (DNS rebinding) |
| API secret | `X-FMV-Secret` on every `/api/*` call; constant-time compare |
| Origin checks | WebSocket and browser endpoints accept only the server's own origin; CORS is closed |
| Page session | The viewer page gets an HttpOnly, SameSite=Strict cookie at load; `/api/token` needs it |
| FM proxy scope | Fixed host; path must match `^/api/v3/`; no redirects to other hosts |
| Download paths | Resolved and written only under the current working directory or a path the user passes explicitly; no overwrite without `--force` |
| Typed commands | Schema-validated; `eval` only behind `--unsafe-eval` |
| No secrets in logs | Activity log and server log redact `Authorization`, tokens, codes and the API secret |
| Config privacy | User-only permissions; the skill and a suggested `permissions.deny` rule stop Claude reading `~/.fusion-manage-live-viewer/**` |
| Content safety | Markdown and FM HTML sanitized before rendering; panel links get `rel="noopener noreferrer"` |
| Dependencies | Minimal; pinned; `npm audit` and secret scanning in CI |

A `/security-review` pass is a release gate for v1.

## Repo and release

- Public GitHub repo `AutoGusX/fusion-manage-live-viewer`. It stays private until the public-release approval and the history secret scan are done.
- License: MIT (to confirm as part of the public-release approval).
- Semver; `CHANGELOG.md`; GitHub Releases carry the prebuilt zip and a SHA-256 checksum that `INSTALL.md` tells Claude to verify.
- CI on Windows, macOS and Ubuntu: unit tests, Playwright end-to-end tests against a stub FM and a stubbed viewer, lint, type check, build, audit.
- The APS Viewer version is pinned in the UI and bumped deliberately.

## Testing

- Unit: config loader and validation, PKCE, token refresh, API secret and origin checks, the FM proxy path guard, command schemas.
- Integration: server plus a stub FM (fetch-level), CLI end to end with `--json`.
- End to end: Playwright drives the real UI with a fixture model (an SVF from the APS sample set served locally) to cover viewer commands and panels.
- Live: a manual checklist against a real tenant (sign-in, viewable load, BOM-to-parts mapping, screenshot) before each minor release.
