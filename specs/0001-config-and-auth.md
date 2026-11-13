# 0001 — Config and auth

Status: draft, awaiting review

## Config location

- Directory: `~/.fusion-manage-live-viewer/` (`%USERPROFILE%\.fusion-manage-live-viewer\` on Windows). Created with user-only permissions (`0700`; on Windows, an ACL limited to the current user).
- File: `.env` in that directory. The repo ships `.env.example` only; `.gitignore` covers `.env*` except `.env.example`.
- Override: `FMV_CONFIG_DIR` points at another directory (for CI and tests).
- Profiles (v1.1, but the loader supports them from day one): `.env.<profile>`, selected with `FMV_PROFILE=<profile>` or `fmv --profile <profile>`.

## Variables

| Variable | Required | Default | Notes |
|---|---|---|---|
| `APS_CLIENT_ID` | Yes | — | Client ID of the user's own APS app, type *Desktop, Mobile, Single-Page App* (public client, PKCE). A *Traditional Web App* (confidential) fails with 401 `invalid_credentials`. |
| `FM_TENANT` | Yes | — | Tenant subdomain, for example `mycompany` in `mycompany.autodeskplm360.net`. Validated as `^[a-z0-9-]+$`. |
| `FM_BASE_URL` | No | `https://${FM_TENANT}.autodeskplm360.net` | Override for non-standard hosts. Must be `https://`. |
| `FMV_PORT` | No | `4710` | Fixed port, because the APS callback URL must match exactly. If the port is busy, the server stops with a clear message instead of picking another port. |
| `APS_CALLBACK_URL` | No | `http://localhost:${FMV_PORT}/callback` | Must exactly match a callback URL registered on the APS app. |
| `APS_SCOPES` | No | `data:read data:write data:create data:search` | The same free, non-metered scopes the Supplier Portal uses. FM writes need more than `data:read`. |

There is deliberately no client secret. PKCE public clients don't use one.

## Tenant enablement (one-time, by an FM admin)

FM accepts tokens only from client IDs on its allowed list. An admin adds `APS_CLIENT_ID` under *Allowed client IDs* at `https://{tenant}.autodeskplm360.net/plm/admin/system-configuration/general-settings`. Setup checks this (an FM call returning 401/403 with a valid token) and tells the user exactly what to ask their admin for.

## Writing the config (`fmv setup`)

- Interactive prompts run in the user's terminal, not through Claude. Claude tells the user to run `! fmv setup` so values are typed into the prompt and never enter the conversation.
- Each value is validated as it's entered. The file is written atomically with user-only permissions.
- `fmv setup --check` validates an existing file and prints only pass/fail per variable, never values (the client ID is shown masked: `V78m…oy`).
- Setup prints the APS app checklist: app type, callback URL (computed from the port), and the FM *Allowed client IDs* step.

## Sign-in (`fmv login`)

1. The server creates a PKCE verifier/challenge (S256) and a random `state`.
2. It opens the system browser to `https://developer.api.autodesk.com/authentication/v2/authorize` with `response_type=code`, `client_id`, `redirect_uri`, `scope`, `code_challenge`, `code_challenge_method=S256`, `state`.
3. `/callback` on the local server checks `state`, exchanges the code at `/authentication/v2/token` and stores the result.
4. The browser tab shows "Signed in, you can close this tab" (or the viewer, if it's open).

## Token storage and refresh

- Access token: server memory only.
- Refresh token: memory, plus an optional cache at `~/.fusion-manage-live-viewer/session.json` (user-only permissions) so a server restart doesn't force a new sign-in. `FMV_PERSIST_SESSION=false` turns the cache off.
- Refresh runs silently 5 minutes before expiry and on any 401. If refresh fails, commands return `AUTH_REQUIRED` and the viewer shows a "Sign in again" banner.
- `fmv logout` clears memory and the cache.

## Who gets the token

| Consumer | How |
|---|---|
| Viewer page (APS Viewer `getAccessToken`) | `GET /api/token` on the local server, allowed only from the server's own origin with the page session cookie |
| `fmv fm …` | Injected by the server; never printed |
| Claude's own `curl` to FM | Not by default. `fmv token` exists but requires `FMV_ALLOW_TOKEN_EXPORT=true` in `.env`, and the skill tells Claude to prefer `fmv fm`. |

## Open questions

- Confirm live that a token from the user's own client ID is accepted by the derivative service for FM viewables. It was proven only with the Supplier Portal's client ID; the expectation is yes.
- Whether to support OS keychain storage (Windows Credential Manager, macOS Keychain) instead of `session.json`. Proposal: v1.1.
