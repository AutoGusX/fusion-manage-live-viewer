# 0000 — Overview

Status: draft, awaiting review
Date: 2026-11-12

## Goal

A production-grade, open-source local viewer that Claude Code drives while it works in Fusion Manage (FM). A user tells Claude Code to install it from the public repo, signs in once, then asks Claude to work in FM. Claude loads the relevant models into the viewer and drives it (highlight, isolate, color, section, explode, camera, screenshots). It also pushes tables, BOMs and notes into side panels, so the user gets feedback outside the CLI.

## Non-goals (v1)

- No MCP server. Claude Code drives everything through a CLI (`fmv`) and plain localhost HTTP from its Bash tool.
- No hosted service. Everything runs on the user's machine against their own APS app and FM tenant.
- Not a general FM client UI. The viewer shows what Claude pushes to it; it does not browse FM on its own.
- No raw-CAD rendering of local files. Models come from FM's own derivatives (see below). A glTF/STEP/STL local fallback is a later option.
- No model editing or markup authoring.

## Users

- **Primary:** a technical seller, consultant or FM admin running Claude Code on their own machine (Windows, macOS or Linux), demonstrating or doing real PLM work.
- **Installer:** Claude Code itself, following `INSTALL.md` and the bundled skill.

## Architecture

```
Claude Code (Bash)
   │  fmv … / curl http://127.0.0.1:PORT/api/…  (per-install secret)
   ▼
fmv local server (Node, single process)
   ├─ serves the prebuilt viewer UI
   ├─ APS 3-legged PKCE sign-in; holds and refreshes the token
   ├─ FM client: authenticated calls to {tenant}.autodeskplm360.net/api/v3
   ├─ command relay → browser over WebSocket
   └─ event queue ← browser (selection, screenshots, errors)
   ▼
Browser tab (viewer UI)
   ├─ APS Viewer (token fetched from the local server)
   └─ panels: BOM tree, table, markdown, record card, activity log
```

## Key decisions

| Decision | Choice | Why |
|---|---|---|
| Claude ↔ viewer channel | CLI plus localhost HTTP, no MCP | User requirement; nothing to register; works with any agent that has a shell |
| Local server | Yes, one Node process | A web page cannot receive commands from a terminal; the server also owns auth |
| Model source | FM attachment *viewable* endpoint → FM's own derivative URN | No download, no OSS bucket, no Model Derivative credits, every format FM translates (verified pattern from the Supplier Portal) |
| Auth | Bring your own APS client ID (PKCE, no secret), one sign-in shared by viewer and FM calls | No shared quota or accounts; no secret to leak |
| Config | `~/.fusion-manage-live-viewer/.env` | Survives upgrades, can't be committed, outside Claude's readable paths |
| Token handling | Server-held; Claude never sees it by default | Keeps tokens out of transcripts and shell history |
| Distribution | Public GitHub repo with a prebuilt UI in each release; `INSTALL.md` written for Claude to follow | Avoids `npm install` of front-end dependencies on locked-down machines |

## Specs

- [0001 — Config and auth](0001-config-and-auth.md)
- [0002 — Server, CLI and command protocol](0002-server-and-command-protocol.md)
- [0003 — Install flow, security and release](0003-install-security-release.md)

## Success criteria for v1

1. On a clean machine, Claude Code installs and starts the viewer from the repo in under 5 minutes, with the user only creating an APS app, entering values in a prompt and signing in.
2. Claude can load an FM attachment by workspace/item/attachment ID and the model renders.
3. Claude can isolate, color, section, explode and screenshot by part number from an FM BOM.
4. Claude can push a BOM, a table and a markdown note to panels, and read back the user's selection.
5. No token, secret or `.env` value appears in Claude's transcript during the whole flow.
6. It works on Windows 11, macOS and Ubuntu, in current Chrome, Edge and Firefox.
